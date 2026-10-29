import crypto from 'crypto';
import {
  ENROLLMENT_STATUS,
  EXECUTION_STATE,
  EXECUTION_REASONS,
  EXCLUSION_REASONS,
} from '@grovastra/shared';
import {
  CampaignModel,
  CampaignVersionModel,
  CampaignEnrollmentModel,
  CampaignExecutionModel,
  SrcOrderModel,
} from '../../db/models';
import { mockOrderSource } from '../../adapters/order-source';
import { enrollEventDelayOccurrence } from '../_shared/eventDelay/enrollerBase';
import { isQualifyingOrder } from '../_shared/orderTrigger/qualifying';
import {
  WELCOME_NEW_CUSTOMER_ID,
  WELCOME_NEW_CUSTOMER_ALIAS,
} from './definition';
import { clock } from '../../services/clock';
import { logger } from '../../logger';

export interface WelcomeOrderCompletedResult {
  enrolled: number;
  excluded: number;
  stopped: number;
  outcome?: string;
}

/**
 * Handles order events (completed, updated) for Welcome campaigns (Spec p5, p14, F19b v2).
 *
 * Rules:
 * 1. Anonymous bill (!customerId): returns { outcome: 'NO_CUSTOMER_IDENTITY' }.
 * 2. Anchor = customer's EARLIEST qualifying order over their full history (OrderSource).
 * 3. Scope = PER_CUSTOMER (default) | PER_CUSTOMER_PER_BRANCH.
 * 4. Once rule: prior enrollment with execution accepted/sent/delivered/read/unknown/failed blocks resend.
 * 5. Minimum first order amount: anchor net >= minFirstOrderNetPaise, else FIRST_ORDER_BELOW_MINIMUM.
 * 6. Window / FUTURE_ONLY: anchor before activation with all steps elapsed -> existing customer (no enrollment record).
 */
export async function handleWelcomeOrderCompletedTrigger(
  tenantId: string,
  order: any,
  occurredAt: Date
): Promise<WelcomeOrderCompletedResult> {
  const customerId = order.customerId;
  if (!customerId) {
    return { enrolled: 0, excluded: 0, stopped: 0, outcome: 'NO_CUSTOMER_IDENTITY' };
  }

  const now = clock.now();

  // Find all ACTIVE Welcome campaigns for this tenant
  const activeCampaigns = await CampaignModel.find({
    tenantId,
    status: 'ACTIVE',
    presetId: {
      $in: [
        WELCOME_NEW_CUSTOMER_ID,
        WELCOME_NEW_CUSTOMER_ALIAS,
        'welcome_new_customer',
      ],
    },
  }).lean();

  if (activeCampaigns.length === 0) {
    return { enrolled: 0, excluded: 0, stopped: 0 };
  }

  let enrolledCount = 0;
  let excludedCount = 0;

  for (const campaign of activeCampaigns) {
    // Check campaign deadline (endAt)
    if (campaign.endAt) {
      const endAtTime = new Date(campaign.endAt).getTime();
      const orderCompletedAt = order.completedAt ? new Date(order.completedAt).getTime() : now.getTime();
      if (now.getTime() >= endAtTime || orderCompletedAt >= endAtTime) {
        continue;
      }
    }

    // Resolve active published version
    const version: any =
      (await CampaignVersionModel.findOne({
        tenantId,
        campaignId: campaign.campaignId,
        isPublished: true,
        version: campaign.draftVersion,
      }).lean()) ||
      (campaign.activeVersionId
        ? await CampaignVersionModel.findById(campaign.activeVersionId).lean()
        : null);

    if (!version) continue;

    // Branch scoping
    if (
      campaign.enabledBranches &&
      campaign.enabledBranches.length > 0 &&
      order.branchId &&
      !campaign.enabledBranches.includes(order.branchId)
    ) {
      continue;
    }

    const scope = version.scope || campaign.scope || 'PER_CUSTOMER';

    // Fetch full order history from OrderSource
    const allOrders = await mockOrderSource.listOrdersForCustomer(tenantId, customerId);

    // Filter qualifying orders according to scope
    let scopedOrders = allOrders;
    if (scope === 'PER_CUSTOMER_PER_BRANCH' && order.branchId) {
      scopedOrders = allOrders.filter((o: any) => o.branchId === order.branchId);
    }

    const qualifyingOrders = scopedOrders.filter((o: any) => isQualifyingOrder(o));
    if (qualifyingOrders.length === 0) {
      continue;
    }

    // Sort by completedAt ascending, tie-breaker orderId ascending
    qualifyingOrders.sort((a: any, b: any) => {
      const timeA = new Date(a.completedAt || a.createdAt || 0).getTime();
      const timeB = new Date(b.completedAt || b.createdAt || 0).getTime();
      if (timeA !== timeB) return timeA - timeB;
      return (a.orderId || '').localeCompare(b.orderId || '');
    });

    // Anchor is the EARLIEST qualifying order
    const anchorOrder = qualifyingOrders[0];
    const anchorOrderId = anchorOrder.orderId;
    const occurrenceId = `welcome:${anchorOrderId}`;

    // 4. ONCE RULE: Check prior enrollments of THIS campaign (same scope)
    const priorQuery: any = {
      tenantId,
      campaignId: campaign.campaignId,
      customerId,
    };
    if (scope === 'PER_CUSTOMER_PER_BRANCH' && anchorOrder.branchId) {
      priorQuery.branchId = anchorOrder.branchId;
    }

    const priorEnrollments = await CampaignEnrollmentModel.find(priorQuery).lean();
    if (priorEnrollments.length > 0) {
      const priorEnrollmentIds = priorEnrollments.map((e) => e.enrollmentId);
      const priorExecution = await CampaignExecutionModel.findOne({
        tenantId,
        enrollmentId: { $in: priorEnrollmentIds },
        state: {
          $in: [
            EXECUTION_STATE.PROVIDER_ACCEPTED,
            EXECUTION_STATE.SENT,
            EXECUTION_STATE.DELIVERED,
            EXECUTION_STATE.READ,
            EXECUTION_STATE.OUTCOME_UNKNOWN,
            EXECUTION_STATE.FAILED,
          ],
        },
      });

      if (priorExecution) {
        // Customer was already welcomed (or terminal failed) -> Do NOT re-enroll
        continue;
      }
    }

    // Check startAt (orders completed before startAt are never welcomed)
    const startAt = version.startAt || campaign.startAt;
    const anchorCompletedAt = new Date(anchorOrder.completedAt || anchorOrder.createdAt || now);
    if (startAt && anchorCompletedAt.getTime() < new Date(startAt).getTime()) {
      continue;
    }

    // Lookback cutoff: orders older than max possible delay + deferral + lateness window
    // belong to existing customers and are not enrolled into welcome campaigns (Spec p5, p14).
    const steps = version.steps || [];
    let maxDelayHours = 1;
    let maxDeferralHours = 24;
    let maxLatenessHours = 3;

    for (const step of steps) {
      const delay = (step as any).delay;
      if (delay) {
        const delayH =
          delay.unit === 'DAYS'
            ? delay.value * 24
            : delay.unit === 'MINUTES'
            ? delay.value / 60
            : delay.value;
        if (delayH > maxDelayHours) maxDelayHours = delayH;
      }
      if ((step as any).maxDeferralHours && (step as any).maxDeferralHours > maxDeferralHours) {
        maxDeferralHours = (step as any).maxDeferralHours;
      }
      if (step.maxLatenessMinutes) {
        const latenessH = step.maxLatenessMinutes / 60;
        if (latenessH > maxLatenessHours) maxLatenessHours = latenessH;
      }
    }

    const lookbackHours = maxDelayHours + maxDeferralHours + maxLatenessHours + 24;
    const cutoffDate = new Date(now.getTime() - lookbackHours * 3600 * 1000);

    if (anchorCompletedAt.getTime() < cutoffDate.getTime()) {
      // Existing customer whose first qualifying purchase was long before the lookback window
      continue;
    }

    // Enroll into event delay occurrence
    const res = await enrollEventDelayOccurrence(
      tenantId,
      campaign.campaignId,
      customerId,
      occurrenceId,
      anchorOrder,
      version
    );

    if (res.enrolled) {
      enrolledCount++;
    } else if (res.excluded) {
      excludedCount++;
    }
  }

  return { enrolled: enrolledCount, excluded: excludedCount, stopped: 0 };
}

/**
 * Handles order refund/cancel events for Welcome campaigns (Spec p5, p14, p20).
 *
 * If the anchor stops qualifying before the send (full refund/cancel):
 * - Cancel unsent steps with FIRST_ORDER_NO_LONGER_QUALIFIES.
 * - If another order then becomes the earliest qualifying order, that is a DIFFERENT occurrence.
 * - A refund AFTER welcome was accepted never triggers a second welcome and never recalls anything.
 */
export async function handleWelcomeOrderRefundOrCancelTrigger(
  tenantId: string,
  order: any,
  occurredAt: Date
): Promise<{ cancelledExecutions: number; reEnrolled: number }> {
  const customerId = order.customerId;
  if (!customerId) {
    return { cancelledExecutions: 0, reEnrolled: 0 };
  }

  let cancelledExecutions = 0;
  let reEnrolled = 0;

  // Find active enrollments for this customer where anchorOrderId matches this order
  const activeEnrollments = await CampaignEnrollmentModel.find({
    tenantId,
    customerId,
    status: ENROLLMENT_STATUS.ACTIVE,
    occurrenceId: { $regex: '^welcome:' },
    $or: [
      { anchorOrderId: order.orderId },
      { occurrenceId: `welcome:${order.orderId}` },
    ],
  });

  for (const enr of activeEnrollments) {
    // Check if the order still qualifies
    if (!isQualifyingOrder(order)) {
      // Cancel unsubmitted/unsent executions
      const execResult = await CampaignExecutionModel.updateMany(
        {
          tenantId,
          enrollmentId: enr.enrollmentId,
          state: {
            $in: [
              EXECUTION_STATE.SCHEDULED,
              EXECUTION_STATE.DEFERRED,
              EXECUTION_STATE.EVALUATING,
            ],
          },
        },
        {
          $set: {
            state: EXECUTION_STATE.CANCELLED,
            skipReason: EXECUTION_REASONS.FIRST_ORDER_NO_LONGER_QUALIFIES,
            failedAt: occurredAt,
          },
        }
      );

      cancelledExecutions += execResult.modifiedCount || 0;

      // Cancel enrollment
      enr.status = ENROLLMENT_STATUS.CANCELLED;
      enr.stopReason = EXECUTION_REASONS.FIRST_ORDER_NO_LONGER_QUALIFIES;
      enr.stoppedAt = occurredAt;
      await enr.save();

      // Check if another order now becomes the earliest qualifying order
      const allOrders = await mockOrderSource.listOrdersForCustomer(tenantId, customerId);
      const scope = enr.scope || 'PER_CUSTOMER';
      let scopedOrders = allOrders;
      if (scope === 'PER_CUSTOMER_PER_BRANCH' && enr.branchId) {
        scopedOrders = allOrders.filter((o: any) => o.branchId === enr.branchId);
      }

      const qualifyingOrders = scopedOrders.filter((o: any) => isQualifyingOrder(o));
      if (qualifyingOrders.length > 0) {
        qualifyingOrders.sort((a: any, b: any) => {
          const timeA = new Date(a.completedAt || a.createdAt || 0).getTime();
          const timeB = new Date(b.completedAt || b.createdAt || 0).getTime();
          if (timeA !== timeB) return timeA - timeB;
          return (a.orderId || '').localeCompare(b.orderId || '');
        });

        const newAnchor = qualifyingOrders[0];
        const newOccurrenceId = `welcome:${newAnchor.orderId}`;

        // Verify this customer has not had an accepted/delivered execution
        const priorExec = await CampaignExecutionModel.findOne({
          tenantId,
          customerId,
          campaignId: enr.campaignId,
          state: {
            $in: [
              EXECUTION_STATE.PROVIDER_ACCEPTED,
              EXECUTION_STATE.SENT,
              EXECUTION_STATE.DELIVERED,
              EXECUTION_STATE.READ,
              EXECUTION_STATE.OUTCOME_UNKNOWN,
            ],
          },
        });

        if (!priorExec) {
          // Re-enroll with new anchor order
          const enrollRes = await enrollEventDelayOccurrence(
            tenantId,
            enr.campaignId,
            customerId,
            newOccurrenceId,
            newAnchor
          );
          if (enrollRes.enrolled) {
            reEnrolled++;
          }
        }
      }
    }
  }

  return { cancelledExecutions, reEnrolled };
}

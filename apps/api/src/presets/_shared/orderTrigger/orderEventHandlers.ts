import crypto from 'crypto';
import {
  ENROLLMENT_STATUS,
  EXECUTION_STATE,
  EXECUTION_REASONS,
  SourceOrder,
} from '@grovastra/shared';
import {
  CampaignModel,
  CampaignVersionModel,
  CampaignEnrollmentModel,
  CampaignExecutionModel,
  CampaignGoalEventModel,
  CampaignCustomerFactModel,
  SrcOrderModel,
} from '../../../db/models';
import { customerFactsService } from '../../../services/customer-facts';
import { enrollEventDelayOccurrence } from '../eventDelay/enrollerBase';
import { isQualifyingOrder } from './qualifying';
import { FIRST_TO_SECOND_PURCHASE_ID, FIRST_TO_SECOND_PURCHASE_ALIAS } from '../../firstToSecondPurchase/definition';
import { clock } from '../../../services/clock';
import { logger } from '../../../logger';

export interface OrderCompletedResult {
  enrolled: number;
  stopped: number;
  goalsRecorded: number;
}

/**
 * Handles order.completed domain events for FIRST_TO_SECOND_PURCHASE campaigns (Spec p5, p14, p20).
 *
 * 1. Recomputes customer facts (qualifyingOrderCount, firstQualifyingOrderId, maxQualifyingOrderCountSeen).
 * 2. If qualifyingOrderCount >= 2:
 *    - STOPS any active first-to-second-purchase enrollments with SKIPPED_GOAL_REACHED.
 *    - Records durable campaignGoalEvents record { source: 'SECOND_QUALIFYING_ORDER', recordedBy: 'SYSTEM', orderRef: order.orderId }.
 * 3. If qualifyingOrderCount === 1 and maxQualifyingOrderCountSeen <= 1:
 *    - ENROLLS customer into active FIRST_TO_SECOND_PURCHASE campaigns under occurrence repeat:{orderId}.
 */
export async function handleOrderCompletedTrigger(
  tenantId: string,
  order: any,
  occurredAt: Date
): Promise<OrderCompletedResult> {
  const customerId = order.customerId;
  if (!customerId) {
    return { enrolled: 0, stopped: 0, goalsRecorded: 0 };
  }

  // 1. Recompute customer facts
  const facts = await customerFactsService.recomputeCustomerFacts(tenantId, customerId);

  let enrolled = 0;
  let stopped = 0;
  let goalsRecorded = 0;

  const activeCampaigns = await CampaignModel.find({
    tenantId,
    status: 'ACTIVE',
    presetId: { $in: [FIRST_TO_SECOND_PURCHASE_ID, FIRST_TO_SECOND_PURCHASE_ALIAS, 'second_purchase', 'first_to_second_purchase'] },
  }).lean();

  if (activeCampaigns.length === 0) {
    return { enrolled: 0, stopped: 0, goalsRecorded: 0 };
  }

  // STOP RULE: Count >= 2 qualifying orders -> Goal reached
  if (facts.qualifyingOrderCount >= 2) {
    const activeEnrollments = await CampaignEnrollmentModel.find({
      tenantId,
      customerId,
      status: ENROLLMENT_STATUS.ACTIVE,
      occurrenceId: { $regex: '^repeat:' },
    });

    for (const enr of activeEnrollments) {
      // Record goal event
      const goalEventId = `cge_${crypto.randomUUID().slice(0, 12)}`;
      await CampaignGoalEventModel.create({
        goalEventId,
        tenantId,
        enrollmentId: enr.enrollmentId,
        occurrence: enr.occurrenceId,
        customerId: enr.customerId,
        campaignId: enr.campaignId,
        source: 'SECOND_QUALIFYING_ORDER',
        orderRef: order.orderId,
        cause: `Second qualifying order ${order.orderNumber || order.orderId} completed`,
        recordedBy: 'SYSTEM',
        at: occurredAt,
      });
      goalsRecorded++;

      // Update enrollment
      enr.status = ENROLLMENT_STATUS.CANCELLED;
      enr.stopReason = EXECUTION_REASONS.SKIPPED_GOAL_REACHED;
      enr.stoppedAt = occurredAt;
      enr.goalReachedAt = occurredAt;
      enr.goalEventId = goalEventId;
      enr.goalOrderRef = order.orderId;
      enr.goalSource = 'SECOND_QUALIFYING_ORDER';
      await enr.save();

      // Skip unsent executions (Spec p20: Accepted/unknown executions are never touched)
      const res = await CampaignExecutionModel.updateMany(
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
            state: EXECUTION_STATE.SKIPPED,
            skipReason: EXECUTION_REASONS.SKIPPED_GOAL_REACHED,
          },
        }
      );
      stopped += res.modifiedCount;
    }

    return { enrolled, stopped, goalsRecorded };
  }

  // ENROLL RULE: Exactly 1 qualifying order and customer has never seen >= 2
  if (facts.qualifyingOrderCount === 1 && (facts.maxQualifyingOrderCountSeen ?? 1) <= 1) {
    for (const campaign of activeCampaigns) {
      const occurrenceId = `repeat:${facts.firstQualifyingOrderId}`;
      const res = await enrollEventDelayOccurrence(
        tenantId,
        campaign.campaignId,
        customerId,
        occurrenceId,
        {
          orderId: facts.firstQualifyingOrderId,
          orderNumber: facts.firstQualifyingOrderNumber || facts.firstQualifyingOrderId,
          netPaise: facts.firstQualifyingNetPaise,
          completedAt: facts.firstQualifyingAt || occurredAt,
          occurredAt: facts.firstQualifyingAt || occurredAt,
          entityVersion: facts.orderSourceVersion || 1,
        }
      );

      if (res.enrolled) {
        enrolled++;
      }
    }
  }

  return { enrolled, stopped, goalsRecorded };
}

/**
 * Handles order.cancelled and order.refunded domain events for FIRST_TO_SECOND_PURCHASE campaigns.
 *
 * 1. Recomputes customer facts.
 * 2. If the anchor order of an active enrollment is no longer qualifying:
 *    - CANCELS unsent executions with FIRST_ORDER_NO_LONGER_QUALIFIES.
 *    - Updates enrollment status to CANCELLED.
 * 3. If a different order becomes the only qualifying order, customer can enroll with a new occurrence repeat:{newOrderId}.
 */
export async function handleOrderRefundOrCancelTrigger(
  tenantId: string,
  order: any,
  occurredAt: Date
): Promise<{ cancelledEnrollments: number; cancelledExecutions: number }> {
  const customerId = order.customerId;
  if (!customerId) {
    return { cancelledEnrollments: 0, cancelledExecutions: 0 };
  }

  // Recompute customer facts
  const facts = await customerFactsService.recomputeCustomerFacts(tenantId, customerId);

  let cancelledEnrollments = 0;
  let cancelledExecutions = 0;

  const activeEnrollments = await CampaignEnrollmentModel.find({
    tenantId,
    customerId,
    status: ENROLLMENT_STATUS.ACTIVE,
    occurrenceId: { $regex: '^repeat:' },
  });

  for (const enr of activeEnrollments) {
    const anchorOrderId = enr.firstOrderId || (enr.occurrenceId.startsWith('repeat:') ? enr.occurrenceId.substring(7) : null);
    if (!anchorOrderId) continue;

    const anchorOrder = await SrcOrderModel.findOne({ tenantId, orderId: anchorOrderId });
    if (!anchorOrder || !isQualifyingOrder(anchorOrder)) {
      // Anchor order stopped qualifying!
      enr.status = ENROLLMENT_STATUS.CANCELLED;
      enr.stopReason = EXECUTION_REASONS.FIRST_ORDER_NO_LONGER_QUALIFIES;
      enr.stoppedAt = occurredAt;
      await enr.save();
      cancelledEnrollments++;

      const res = await CampaignExecutionModel.updateMany(
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
          },
        }
      );
      cancelledExecutions += res.modifiedCount;
    }
  }

  // If facts now show a single qualifying order, check if a new occurrence can enroll
  if (facts.qualifyingOrderCount === 1 && (facts.maxQualifyingOrderCountSeen ?? 1) <= 1) {
    const activeCampaigns = await CampaignModel.find({
      tenantId,
      status: 'ACTIVE',
      presetId: { $in: [FIRST_TO_SECOND_PURCHASE_ID, FIRST_TO_SECOND_PURCHASE_ALIAS, 'second_purchase', 'first_to_second_purchase'] },
    }).lean();

    for (const campaign of activeCampaigns) {
      const occurrenceId = `repeat:${facts.firstQualifyingOrderId}`;
      await enrollEventDelayOccurrence(
        tenantId,
        campaign.campaignId,
        customerId,
        occurrenceId,
        {
          orderId: facts.firstQualifyingOrderId,
          orderNumber: facts.firstQualifyingOrderNumber || facts.firstQualifyingOrderId,
          netPaise: facts.firstQualifyingNetPaise,
          completedAt: facts.firstQualifyingAt || occurredAt,
          occurredAt: facts.firstQualifyingAt || occurredAt,
          entityVersion: facts.orderSourceVersion || 1,
        }
      );
    }
  }

  return { cancelledEnrollments, cancelledExecutions };
}

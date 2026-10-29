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
  SrcOrderModel,
} from '../../db/models';
import { mockProductSource } from '../../adapters/product-source';
import { isQualifyingOrder } from '../_shared/orderTrigger/qualifying';
import { enrollCompleteOutfitOccurrence } from './enroller';
import {
  COMPLETE_THE_OUTFIT_ID,
  COMPLETE_THE_OUTFIT_ALIAS,
  DEFAULT_OUTFIT_PAIRING,
} from './definition';
import { logger } from '../../logger';

export interface OutfitOrderCompletedResult {
  enrolled: number;
  goalsRecorded: number;
  stoppedExecutions: number;
}

export async function handleOutfitOrderCompleted(
  tenantId: string,
  order: SourceOrder | any,
  occurredAt: Date
): Promise<OutfitOrderCompletedResult> {
  const customerId = order.customerId;
  if (!customerId) {
    return { enrolled: 0, goalsRecorded: 0, stoppedExecutions: 0 };
  }

  let enrolled = 0;
  let goalsRecorded = 0;
  let stoppedExecutions = 0;

  // 1. Goal Check: Did this order satisfy the goal of any active outfit enrollment?
  // Stop rule (Part 1 item 8b):
  // COMPLEMENT_OR_TAGGED = a qualifying order by the same customer completed AFTER the anchor order
  // with a non-returned line in ANY category of complementMap[anchor category], OR an order tagged outfit:{orderId}
  const activeEnrollments = await CampaignEnrollmentModel.find({
    tenantId,
    customerId,
    status: ENROLLMENT_STATUS.ACTIVE,
    occurrenceId: { $regex: '^outfit:' },
  });

  const orderCompletedAt = order.completedAt ? new Date(order.completedAt) : occurredAt;
  const isQualifying = isQualifyingOrder(order);

  for (const enr of activeEnrollments) {
    const anchorOrderId = enr.anchorOrderId || (enr.occurrenceId.startsWith('outfit:') ? enr.occurrenceId.substring(7) : null);
    // An anchor order itself cannot be its own goal completion
    if (order.orderId === anchorOrderId) {
      continue;
    }

    const anchorCompletedAt = enr.anchorAt ? new Date(enr.anchorAt) : new Date(enr.createdAt);
    // Must be completed AFTER the anchor order
    if (orderCompletedAt.getTime() <= anchorCompletedAt.getTime()) {
      continue;
    }

    let isGoalMatch = false;

    // Check tagged: outfitRef == outfit:{anchorOrderId} or {anchorOrderId}
    const taggedOutfitRef = (order as any).outfitRef || (order as any).occasionRef;
    if (taggedOutfitRef && (taggedOutfitRef === `outfit:${anchorOrderId}` || taggedOutfitRef === anchorOrderId)) {
      isGoalMatch = true;
    }

    // Check complement line if goalMode is COMPLEMENT_OR_TAGGED
    const goalMode = enr.goalMode || 'COMPLEMENT_OR_TAGGED';
    if (!isGoalMatch && goalMode === 'COMPLEMENT_OR_TAGGED' && isQualifying) {
      // Find anchor category
      let anchorCategory = 'saree';
      if (enr.anchorProductId) {
        const anchorProd = await mockProductSource.getProduct(tenantId, enr.anchorProductId);
        if (anchorProd?.category) {
          anchorCategory = anchorProd.category.toLowerCase();
        }
      }

      // Load pairing complementMap from version
      const version: any = await CampaignVersionModel.findOne({
        tenantId,
        campaignId: enr.campaignId,
        version: enr.campaignVersion,
      }).lean();

      const pairing = version?.pairing || DEFAULT_OUTFIT_PAIRING;
      const complementCategories = (pairing.complementMap?.[anchorCategory] || []).map((c: string) => c.toLowerCase());

      if (complementCategories.length > 0) {
        for (const line of order.lines || []) {
          const qty = line.qty ?? line.quantity ?? 1;
          const returnedQty = line.returnedQty ?? 0;
          if (returnedQty >= qty || !line.productId) {
            continue;
          }

          const prod = await mockProductSource.getProduct(tenantId, line.productId);
          if (prod?.category && complementCategories.includes(prod.category.toLowerCase())) {
            isGoalMatch = true;
            break;
          }
        }
      }
    }

    if (isGoalMatch) {
      const goalEventId = `cge_${crypto.randomUUID().slice(0, 12)}`;
      await CampaignGoalEventModel.create({
        goalEventId,
        tenantId,
        enrollmentId: enr.enrollmentId,
        occurrence: enr.occurrenceId,
        customerId: enr.customerId,
        campaignId: enr.campaignId,
        source: 'OUTFIT_COMPLEMENT_PURCHASED',
        orderRef: order.orderId,
        cause: `Customer purchased complement item in order ${order.orderNumber || order.orderId}`,
        recordedBy: 'SYSTEM',
        at: orderCompletedAt,
      });
      goalsRecorded++;

      enr.status = ENROLLMENT_STATUS.CANCELLED;
      enr.stopReason = EXECUTION_REASONS.SKIPPED_GOAL_REACHED;
      enr.stoppedAt = orderCompletedAt;
      enr.goalReachedAt = orderCompletedAt;
      enr.goalEventId = goalEventId;
      enr.goalOrderRef = order.orderId;
      enr.goalSource = 'OUTFIT_COMPLEMENT_PURCHASED';
      await enr.save();

      // Cancel unsent stopOnGoal executions immediately
      const stopRes = await CampaignExecutionModel.updateMany(
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
      stoppedExecutions += stopRes.modifiedCount;
    }
  }

  // 2. Enrollment Check: Does this order qualify to enroll in active Complete the Outfit campaigns?
  const activeOutfitCampaigns = await CampaignModel.find({
    tenantId,
    status: 'ACTIVE',
    presetId: { $in: [COMPLETE_THE_OUTFIT_ID, COMPLETE_THE_OUTFIT_ALIAS] },
  }).lean();

  for (const campaign of activeOutfitCampaigns) {
    const res = await enrollCompleteOutfitOccurrence(
      tenantId,
      campaign.campaignId,
      customerId,
      order
    );
    if (res.enrolled) {
      enrolled++;
    }
  }

  return { enrolled, goalsRecorded, stoppedExecutions };
}

export async function handleOutfitOrderRefundOrCancel(
  tenantId: string,
  order: SourceOrder | any,
  occurredAt: Date
): Promise<{ cancelledEnrollments: number; cancelledExecutions: number }> {
  let cancelledEnrollments = 0;
  let cancelledExecutions = 0;

  // Find active enrollments anchored to this order for complete_the_outfit
  const activeEnrollments = await CampaignEnrollmentModel.find({
    tenantId,
    anchorOrderId: order.orderId,
    status: ENROLLMENT_STATUS.ACTIVE,
    occurrenceId: { $regex: '^outfit:' },
  });

  if (activeEnrollments.length === 0) {
    return { cancelledEnrollments: 0, cancelledExecutions: 0 };
  }

  // Check 1: Does the order still qualify?
  const stillQualifying = isQualifyingOrder(order);

  for (const enr of activeEnrollments) {
    if (!stillQualifying) {
      // Anchor order no longer qualifies -> cancel unsent steps
      enr.status = ENROLLMENT_STATUS.CANCELLED;
      enr.stopReason = EXECUTION_REASONS.ANCHOR_ORDER_NO_LONGER_QUALIFIES;
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
            skipReason: EXECUTION_REASONS.ANCHOR_ORDER_NO_LONGER_QUALIFIES,
          },
        }
      );
      cancelledExecutions += res.modifiedCount;
      continue;
    }

    // Check 2: Check anchor lines in the order
    const version: any = await CampaignVersionModel.findOne({
      tenantId,
      campaignId: enr.campaignId,
      version: enr.campaignVersion,
    }).lean();

    const pairing = version?.pairing || DEFAULT_OUTFIT_PAIRING;
    const anchorCategories = (pairing.anchorCategories || ['saree']).map((c: string) => c.toLowerCase());

    let hasAnyNonReturnedAnchorLine = false;

    for (const line of order.lines || []) {
      const qty = line.qty ?? line.quantity ?? 1;
      const returnedQty = line.returnedQty ?? 0;
      if (returnedQty >= qty || !line.productId) {
        continue;
      }

      const prod = await mockProductSource.getProduct(tenantId, line.productId);
      if (prod?.category && anchorCategories.includes(prod.category.toLowerCase())) {
        hasAnyNonReturnedAnchorLine = true;
        break;
      }
    }

    if (!hasAnyNonReturnedAnchorLine) {
      // Every anchor line is fully returned -> ANCHOR_LINES_RETURNED
      enr.status = ENROLLMENT_STATUS.CANCELLED;
      enr.stopReason = EXECUTION_REASONS.ANCHOR_LINES_RETURNED;
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
            skipReason: EXECUTION_REASONS.ANCHOR_LINES_RETURNED,
          },
        }
      );
      cancelledExecutions += res.modifiedCount;
    }
  }

  return { cancelledEnrollments, cancelledExecutions };
}

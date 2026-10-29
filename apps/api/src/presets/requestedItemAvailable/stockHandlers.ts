/**
 * stockHandlers.ts — F25 Requested Item Available
 *
 * Handles:
 *   stock.published  → fan-out: for each item where sellableQtyAfter > 0, find OPEN
 *                       requests for that product and enroll eligible customers.
 *   request.saved    → upsert request into src_requests; no immediate enrollment.
 *   request.fulfilled / request.cancelled → stop active enrollments.
 *   order.completed  → goal match (customer bought requested item).
 */

import {
  ENROLLMENT_STATUS,
  EXECUTION_STATE,
} from '@grovastra/shared';
import {
  CampaignEnrollmentModel,
  CampaignExecutionModel,
  CampaignVersionModel,
  SrcRequestModel,
} from '../../db/models';
import { ICampaignEventInbox } from '../../db/models/campaign-event-inbox.model';
import { mockRequestSource } from '../../adapters/request-source';
import { mockProductSource } from '../../adapters/product-source';
import { enrollRequestedItemAvailableOccurrence } from './enroller';
import { clock } from '../../services/clock';
import { logger } from '../../logger';
import { campaignActivityService } from '../../services/campaign-activity.service';
import { isQualifyingOrder } from '../_shared/orderTrigger/qualifying';

// ---------------------------------------------------------------------------
// stock.published handler
// ---------------------------------------------------------------------------
export async function handleStockPublished(
  eventDoc: ICampaignEventInbox
): Promise<Record<string, unknown>> {
  const { tenantId, data, occurredAt } = eventDoc;
  const stockPublishedAt = occurredAt || clock.now();

  const items: Array<{ productId: string; variantId?: string | null; sellableQtyBefore?: number; sellableQtyAfter?: number }> =
    (data as any)?.items || [];

  let totalEnrolled = 0;
  let totalSkipped = 0;
  const outcomes: string[] = [];

  for (const item of items) {
    const { productId, variantId, sellableQtyAfter } = item;

    // Only process items that just became available (sellableQtyAfter > 0)
    if (!sellableQtyAfter || sellableQtyAfter <= 0) {
      totalSkipped++;
      continue;
    }

    // Find all OPEN requests for this product (and variant if specified)
    const openRequests = await mockRequestSource.listOpenByProductId(tenantId, productId, variantId);

    for (const req of openRequests) {
      try {
        const result = await enrollRequestedItemAvailableOccurrence(
          tenantId,
          req,
          stockPublishedAt
        );
        if (result.enrolled) {
          totalEnrolled++;
          outcomes.push(`ENROLLED:${req.requestId}`);
        } else {
          outcomes.push(`SKIPPED:${req.requestId}:${result.outcome || result.message}`);
        }
      } catch (err: any) {
        logger.error(
          { err: err.message, tenantId, productId, requestId: req.requestId },
          'Error enrolling request for stock.published'
        );
        outcomes.push(`ERROR:${req.requestId}:${err.message}`);
      }
    }
  }

  return {
    handler: 'stock.published',
    tenantId,
    itemsProcessed: items.length,
    itemsSkipped: totalSkipped,
    totalEnrolled,
    outcomes,
  };
}

// ---------------------------------------------------------------------------
// request.saved handler
// ---------------------------------------------------------------------------
export async function handleRequestSaved(
  eventDoc: ICampaignEventInbox
): Promise<Record<string, unknown>> {
  const { tenantId, entityId: requestId, entityVersion, customerId, data, occurredAt } = eventDoc;
  const now = occurredAt || clock.now();

  // Upsert the request document in src_requests
  // (src_requests is a READ-ONLY production collection; in dev/test, we manage it via seed/mock)
  // For event-driven sync: if the document doesn't exist, create it; if it does and version is newer, update.
  const existing = await SrcRequestModel.findOne({ tenantId, requestId });

  if (!existing) {
    try {
      await (SrcRequestModel as any).collection.insertOne({
        requestId,
        tenantId,
        customerId: customerId || (data as any)?.customerId || null,
        branchId: (data as any)?.branchId || null,
        status: (data as any)?.status || 'OPEN',
        source: (data as any)?.source || 'CUSTOMER_DECLARED',
        declaredByCustomer: (data as any)?.declaredByCustomer !== undefined
          ? Boolean((data as any).declaredByCustomer)
          : true,
        itemRef: (data as any)?.itemRef || { productId: 'unknown', variantId: null },
        conditions: (data as any)?.conditions || null,
        createdAt: (data as any)?.createdAt ? new Date((data as any).createdAt) : now,
        updatedAt: now,
        expiresAt: (data as any)?.expiresAt ? new Date((data as any).expiresAt) : null,
        entityVersion: entityVersion || 1,
      });
    } catch (err: any) {
      if (err.code !== 11000) throw err;
      // Concurrent duplicate — ignore
    }
  } else if (entityVersion > existing.entityVersion) {
    existing.status = (data as any)?.status || existing.status;
    existing.updatedAt = now;
    existing.entityVersion = entityVersion;
    await existing.save();
  }

  return {
    handler: 'request.saved',
    tenantId,
    requestId,
    outcome: 'UPSERTED',
  };
}

// ---------------------------------------------------------------------------
// request.fulfilled / request.cancelled handler
// ---------------------------------------------------------------------------
export async function handleRequestFulfilledOrCancelled(
  eventDoc: ICampaignEventInbox
): Promise<Record<string, unknown>> {
  const { tenantId, entityId: requestId, entityVersion, data, occurredAt } = eventDoc;
  const now = occurredAt || clock.now();

  // 1. Update request status in src_requests
  const existing = await SrcRequestModel.findOne({ tenantId, requestId });
  const newStatus = eventDoc.type === 'request.fulfilled' ? 'FULFILLED' : 'CANCELLED';

  if (existing && entityVersion >= existing.entityVersion) {
    existing.status = newStatus;
    existing.updatedAt = now;
    existing.entityVersion = entityVersion;
    await existing.save();
  }

  // 2. Cancel all active enrollments whose occurrenceId starts with `request:{requestId}:`
  const activeEnrollments = await CampaignEnrollmentModel.find({
    tenantId,
    occurrenceId: { $regex: `^request:${requestId}:` },
    status: ENROLLMENT_STATUS.ACTIVE,
  });

  let cancelledCount = 0;
  for (const enrollment of activeEnrollments) {
    enrollment.status = ENROLLMENT_STATUS.CANCELLED;
    await enrollment.save();

    await CampaignExecutionModel.updateMany(
      {
        tenantId,
        enrollmentId: enrollment.enrollmentId,
        state: {
          $in: [EXECUTION_STATE.SCHEDULED, EXECUTION_STATE.DEFERRED, EXECUTION_STATE.EVALUATING],
        },
      },
      {
        $set: {
          state: EXECUTION_STATE.CANCELLED,
          skipReason: `Request ${requestId} ${newStatus.toLowerCase()}`,
        },
      }
    );
    cancelledCount++;
  }

  return {
    handler: eventDoc.type,
    tenantId,
    requestId,
    newStatus,
    cancelledEnrollments: cancelledCount,
  };
}

// ---------------------------------------------------------------------------
// order.completed goal match for requestedItemAvailable
// ---------------------------------------------------------------------------
export async function handleOrderCompletedForRequestGoal(
  tenantId: string,
  customerId: string,
  order: any,
  occurredAt: Date
): Promise<{ goalMatches: string[] }> {
  const goalMatches: string[] = [];

  if (!customerId) return { goalMatches };

  // Find all active requestedItemAvailable enrollments for this customer
  const activeEnrollments = await CampaignEnrollmentModel.find({
    tenantId,
    customerId,
    occurrenceId: { $regex: '^request:' },
    status: ENROLLMENT_STATUS.ACTIVE,
  });

  if (activeEnrollments.length === 0) return { goalMatches };

  for (const enrollment of activeEnrollments) {
    let isMatch = false;
    let goalSource = 'REQUEST_PURCHASE';

    // Check if requestRef in order data matches this enrollment's requestId
    const requestRef = (order as any)?.requestRef || (order as any)?.data?.requestRef;
    const enrolledRequestId = enrollment.requestId || enrollment.occurrenceId?.split(':')[1];

    if (requestRef && (
      requestRef === `request:${enrolledRequestId}` ||
      requestRef === enrolledRequestId
    )) {
      isMatch = true;
    }

    // Also check if the ordered item matches the requestedItemRef
    if (!isMatch && enrollment.itemRef?.productId && isQualifyingOrder(order)) {
      const enquiredProductId = enrollment.itemRef.productId;
      const enquiredVariantId = enrollment.itemRef.variantId;
      const orderLines = order.lines || [];

      const itemBought = orderLines.some((line: any) => {
        if (line.productId !== enquiredProductId && line.itemRef !== enquiredProductId) {
          return false;
        }
        if (enquiredVariantId) {
          return line.variantId === enquiredVariantId;
        }
        return true;
      });

      if (itemBought) {
        isMatch = true;
      }
    }

    if (isMatch && !enrollment.goalReachedAt) {
      await campaignActivityService.markGoal({
        tenantId,
        enrollmentId: enrollment.enrollmentId,
        userId: 'SYSTEM_EVENT_CONSUMER',
        source: goalSource,
        orderRef: order.orderId,
        cause: `Order ${order.orderId} completed — requested item purchased`,
        at: order.completedAt || occurredAt,
      });

      // Cancel stop-on-goal steps
      const pinnedVersion = (await CampaignVersionModel.findOne({
        tenantId,
        campaignId: enrollment.campaignId,
        version: enrollment.campaignVersion,
      }).lean()) as any;

      const stopStepIds = (pinnedVersion?.steps || [])
        .filter((s: any) => s.stopOnGoal)
        .map((s: any) => s.stepId);

      if (stopStepIds.length > 0) {
        await CampaignExecutionModel.updateMany(
          {
            tenantId,
            enrollmentId: enrollment.enrollmentId,
            stepId: { $in: stopStepIds },
            deliveryIntentId: null,
            state: EXECUTION_STATE.SCHEDULED,
          },
          {
            $set: {
              state: EXECUTION_STATE.CANCELLED,
              skipReason: 'Goal reached — requested item purchased',
            },
          }
        );
      }

      goalMatches.push(enrollment.enrollmentId);
    }
  }

  return { goalMatches };
}

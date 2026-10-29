/**
 * Matching Collection — Event Handlers (F26 Part 1)
 *
 * Handles three event types:
 *   1. collection.published  → upsert src_collections → fan-out to enrolled customers
 *   2. collection.withdrawn  → mark collection WITHDRAWN → cancel all active enrollments
 *   3. order.completed       → check if any purchased item is in an active collection enrollment
 *
 * "collection.published" event data schema:
 *   {
 *     releaseId: string,
 *     title?: string,
 *     description?: string,
 *     previewImageUrl?: string,
 *     branchId?: string,
 *     items: [{ productId, variantId?, name, category?, colourFamily?, weave?, sellableQtyAfter?, pricePaise? }],
 *     publishedAt: ISO-8601 string
 *   }
 *
 * "collection.withdrawn" event data schema:
 *   { releaseId: string, withdrawnAt?: ISO-8601 string }
 */

import {
  ENROLLMENT_STATUS,
  EXECUTION_STATE,
} from '@grovastra/shared';
import {
  CampaignEnrollmentModel,
  CampaignExecutionModel,
  CampaignVersionModel,
  SrcProductModel,
  ICampaignEventInbox,
} from '../../db/models';
import {
  SrcCollectionModel,
  ISrcCollection,
} from '../../db/models/src-collection.model';
import { fanoutCollectionPublished } from './fanout';
import { campaignActivityService } from '../../services/campaign-activity.service';
import { clock } from '../../services/clock';
import { logger } from '../../logger';

// ─────────────────────────────────────────────────────────────────────────────
// collection.published
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Handles a `collection.published` event.
 *
 * 1. Upsert the collection document in src_collections (idempotent by releaseId + entityVersion)
 * 2. Validate: must have at least one item with sellableQtyAfter > 0
 * 3. Fan-out to all active matching_collection campaigns
 */
export async function handleCollectionPublished(
  eventDoc: ICampaignEventInbox
): Promise<Record<string, unknown>> {
  const { tenantId, entityId: releaseId, entityVersion, data, occurredAt } = eventDoc;
  const now = occurredAt || clock.now();

  const payload = data as any;
  const rawItems: any[] = Array.isArray(payload?.items) ? payload.items : [];

  // Enrich items with catalogue data if fields are missing
  const sellableItems: any[] = [];
  const categoriesSet = new Set<string>();

  for (const it of rawItems) {
    let name = it.name;
    let category = it.category ? it.category.trim().toLowerCase() : null;
    let colourFamily = it.colourFamily ? it.colourFamily.trim().toLowerCase() : null;
    let weave = it.weave ? it.weave.trim().toLowerCase() : null;
    let size: string | null = it.size ? it.size.trim().toLowerCase() : null;
    let pricePaise = typeof it.pricePaise === 'number' ? it.pricePaise : null;
    let sellableQtyAfter = typeof it.sellableQtyAfter === 'number' ? it.sellableQtyAfter : null;

    if (!name || !category || !colourFamily || !weave || !size || pricePaise === null || sellableQtyAfter === null) {
      const product = (await SrcProductModel.findOne({ tenantId, productId: it.productId }).lean()) as any;
      if (product) {
        if (!name) name = product.name;
        if (!category && product.category) category = product.category.trim().toLowerCase();
        if (!colourFamily && product.colourFamily) colourFamily = product.colourFamily.trim().toLowerCase();
        if (!weave && product.weave) weave = product.weave.trim().toLowerCase();
        if (pricePaise === null && typeof product.pricePaise === 'number') pricePaise = product.pricePaise;

        // Enrich size from variant attributes (use the variant with the most sellableQty)
        if (!size && Array.isArray(product.variants) && product.variants.length > 0) {
          let bestVariant: any = null;
          let bestQty = -1;
          for (const v of product.variants) {
            const vSize = v.attributes?.size || v.size || null;
            const vQty = v.sellableQty ?? 0;
            if (vSize && vQty >= bestQty) {
              bestQty = vQty;
              bestVariant = v;
            }
          }
          if (bestVariant) {
            const rawSize = bestVariant.attributes?.size || bestVariant.size;
            if (rawSize && typeof rawSize === 'string' && rawSize.trim()) {
              size = rawSize.trim().toLowerCase();
            }
          }
        }

        if (sellableQtyAfter === null) {
          const variantQtySum = (product.variants || []).reduce(
            (sum: number, v: any) => sum + (v.sellableQty || 0),
            0
          );
          sellableQtyAfter = variantQtySum > 0 ? variantQtySum : product.status === 'ACTIVE' ? 1 : 0;
        }
      }
    }

    if (sellableQtyAfter === null) {
      sellableQtyAfter = 1;
    }

    if (sellableQtyAfter > 0) {
      if (category) {
        categoriesSet.add(category);
      }
      sellableItems.push({
        productId: it.productId,
        variantId: it.variantId || (Array.isArray(it.variantIds) ? it.variantIds[0] : null) || null,
        name: name || it.productId,
        category,
        colourFamily,
        weave,
        size,
        sellableQtyAfter,
        pricePaise: pricePaise ?? 0,
      });
    }
  }

  if (sellableItems.length === 0) {
    logger.info(
      { tenantId, releaseId },
      '[F26] collection.published skipped — no items with sellableQtyAfter > 0'
    );
    return {
      handler: 'collection.published',
      tenantId,
      releaseId,
      outcome: 'SKIPPED_NO_SELLABLE_ITEMS',
    };
  }

  const publishedAt = payload?.publishedAt
    ? new Date(payload.publishedAt)
    : new Date(now);

  const collectionTitle = payload?.title || payload?.name || null;

  // Upsert src_collections (idempotent — same releaseId replaces if entityVersion is newer)
  const existingCollection = await SrcCollectionModel.findOne({ tenantId, releaseId });

  let collection: ISrcCollection;

  if (!existingCollection) {
    try {
      collection = await SrcCollectionModel.create({
        tenantId,
        releaseId,
        title: collectionTitle,
        description: payload?.description || null,
        previewImageUrl: payload?.previewImageUrl || null,
        branchId: payload?.branchId || null,
        status: 'ACTIVE',
        categories: Array.from(categoriesSet),
        items: sellableItems,
        publishedAt,
        entityVersion: entityVersion || 1,
        source: 'MOCK',
      });
    } catch (err: any) {
      if (err.code === 11000) {
        // Concurrent duplicate — reload
        collection = (await SrcCollectionModel.findOne({ tenantId, releaseId })) as ISrcCollection;
      } else {
        throw err;
      }
    }
  } else if (entityVersion >= existingCollection.entityVersion) {
    existingCollection.title = collectionTitle || existingCollection.title;
    existingCollection.description = payload?.description || existingCollection.description;
    existingCollection.previewImageUrl = payload?.previewImageUrl || existingCollection.previewImageUrl;
    existingCollection.branchId = payload?.branchId || existingCollection.branchId;
    existingCollection.status = 'ACTIVE';
    existingCollection.categories = Array.from(categoriesSet);
    existingCollection.items = sellableItems;
    existingCollection.publishedAt = publishedAt;
    existingCollection.entityVersion = entityVersion;
    await existingCollection.save();
    collection = existingCollection;
  } else {
    // Stale version — idempotent noop
    logger.info(
      { tenantId, releaseId, incoming: entityVersion, stored: existingCollection.entityVersion },
      '[F26] collection.published ignored — stale entityVersion'
    );
    return {
      handler: 'collection.published',
      tenantId,
      releaseId,
      outcome: 'STALE_VERSION',
    };
  }

  // Fan-out to all active campaigns
  const fanoutResult = await fanoutCollectionPublished(tenantId, collection, now);

  return {
    handler: 'collection.published',
    tenantId,
    releaseId,
    sellableItemCount: sellableItems.length,
    fanout: {
      campaignsProcessed: fanoutResult.campaignsProcessed,
      totalEnrolled: fanoutResult.totalEnrolled,
      totalExcluded: fanoutResult.totalExcluded,
      totalSkipped: fanoutResult.totalSkipped,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// collection.withdrawn
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Handles a `collection.withdrawn` event.
 *
 * 1. Mark the collection WITHDRAWN in src_collections
 * 2. Cancel all active enrollments for this release
 * 3. Cancel all pending/deferred executions in those enrollments
 */
export async function handleCollectionWithdrawn(
  eventDoc: ICampaignEventInbox
): Promise<Record<string, unknown>> {
  const { tenantId, entityId: releaseId, entityVersion, data, occurredAt } = eventDoc;
  const now = occurredAt || clock.now();

  const payload = data as any;
  const withdrawnAt = payload?.withdrawnAt ? new Date(payload.withdrawnAt) : now;

  // Update collection status
  const collection = await SrcCollectionModel.findOne({ tenantId, releaseId });
  if (collection && entityVersion >= collection.entityVersion) {
    collection.status = 'WITHDRAWN';
    collection.withdrawnAt = withdrawnAt;
    collection.entityVersion = entityVersion;
    await collection.save();
  }

  // Find all active enrollments for this release
  const activeEnrollments = await CampaignEnrollmentModel.find({
    tenantId,
    occurrenceId: { $regex: `^collection:${releaseId}:` },
    status: ENROLLMENT_STATUS.ACTIVE,
  });

  let cancelledCount = 0;
  for (const enrollment of activeEnrollments) {
    enrollment.status = ENROLLMENT_STATUS.CANCELLED;
    enrollment.stopReason = 'COLLECTION_WITHDRAWN';
    enrollment.stoppedAt = withdrawnAt;
    await enrollment.save();

    await CampaignExecutionModel.updateMany(
      {
        tenantId,
        enrollmentId: enrollment.enrollmentId,
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
          skipReason: `Collection ${releaseId} withdrawn`,
        },
      }
    );
    cancelledCount++;
  }

  logger.info(
    { tenantId, releaseId, cancelledCount },
    '[F26] collection.withdrawn processed'
  );

  return {
    handler: 'collection.withdrawn',
    tenantId,
    releaseId,
    cancelledEnrollments: cancelledCount,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// order.completed goal match for matchingCollection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Handles `order.completed` events to check goal achievement for
 * active matching_collection enrollments.
 *
 * If the order contains any item that was in the enrolled release, the
 * enrollment is marked GOAL_REACHED and pending follow-up steps are cancelled.
 */
export async function handleOrderCompletedForCollectionGoal(
  tenantId: string,
  customerId: string,
  order: any,
  occurredAt: Date
): Promise<{ goalMatches: string[] }> {
  const goalMatches: string[] = [];

  if (!customerId) return { goalMatches };

  // Find all active matching_collection enrollments for this customer
  const activeEnrollments = await CampaignEnrollmentModel.find({
    tenantId,
    customerId,
    occurrenceId: { $regex: '^collection:' },
    status: ENROLLMENT_STATUS.ACTIVE,
  });

  if (activeEnrollments.length === 0) return { goalMatches };

  const orderLines: any[] = order.lines || [];
  const orderedProductIds = new Set<string>(
    orderLines.map((l: any) => l.productId || l.itemRef).filter(Boolean)
  );

  for (const enrollment of activeEnrollments) {
    if (enrollment.goalReachedAt) continue;

    const releaseId = (enrollment as any).releaseId || enrollment.occurrenceId?.split(':')[1];
    if (!releaseId) continue;

    const orderCollectionRef: string | null = order.collectionRef || null;
    let isGoalMatch = false;

    if (orderCollectionRef && (orderCollectionRef === `collection:${releaseId}` || orderCollectionRef === releaseId)) {
      isGoalMatch = true;
    } else {
      // Load collection to check if any ordered item was in it
      const collection = (await SrcCollectionModel.findOne({ tenantId, releaseId }).lean()) as any;
      if (collection) {
        const collectionProductIds = new Set<string>(
          (collection.items || []).map((it: any) => it.productId)
        );
        isGoalMatch = Array.from(orderedProductIds).some((pid) => collectionProductIds.has(pid));
      }
    }

    if (!isGoalMatch) continue;

    // Mark goal reached
    await campaignActivityService.markGoal({
      tenantId,
      enrollmentId: enrollment.enrollmentId,
      userId: 'SYSTEM_EVENT_CONSUMER',
      source: 'COLLECTION_PURCHASE',
      orderRef: order.orderId,
      cause: `Order ${order.orderId} completed — collection item purchased`,
      at: order.completedAt || occurredAt,
    });

    // Cancel stop-on-goal steps
    const pinnedVersion = await CampaignVersionModel.findOne({
      tenantId,
      campaignId: enrollment.campaignId,
      version: enrollment.campaignVersion,
    }).lean();

    const stopStepIds = ((pinnedVersion as any)?.steps || [])
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
            skipReason: 'Goal reached — collection item purchased',
          },
        }
      );
    }

    goalMatches.push(enrollment.enrollmentId);
  }

  return { goalMatches };
}

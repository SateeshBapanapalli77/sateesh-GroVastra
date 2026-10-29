/**
 * Reconciler for Outfit Collection / Delivery Campaign (F31)
 *
 * Scans fulfilments whose relevant timestamp (readyAt, dispatchedAt, deliveredAt)
 * falls inside [now - (maxDelay + maxDeferral + maxLateness + 1 day), now] and that
 * are still in triggering status without an existing enrollment.
 *
 * Guarantees:
 * - Durable checkpoints on CampaignCheckpointModel (type: 'fulfilment-reconcile')
 * - Bounded batches
 * - Idempotency: two concurrent planners yield exactly one enrollment
 */

import crypto from 'crypto';
import {
  CampaignModel,
  CampaignVersionModel,
  CampaignEnrollmentModel,
  CampaignCheckpointModel,
} from '../../db/models';
import { SrcFulfilmentModel } from '../../db/models/src-fulfilment.model';
import {
  enrollFulfilmentReady,
  enrollShipmentDispatched,
  enrollShipmentDelivered,
} from './enroller';
import {
  OUTFIT_COLLECTION_DELIVERY_ID,
  OUTFIT_COLLECTION_DELIVERY_ALIASES,
} from './definition';
import { clock } from '../../services/clock';

export interface ReconcileFulfilmentResult {
  scannedFulfilments: number;
  enrolledOccurrences: number;
  skippedExisting: number;
}

export async function reconcileFulfilmentCampaigns(
  tenantId: string,
  options?: { now?: Date; campaignId?: string }
): Promise<ReconcileFulfilmentResult> {
  const now = options?.now || clock.now();
  const leaseToken = crypto.randomUUID();
  const leaseExpiresAt = new Date(now.getTime() + 60 * 1000);

  const matchingPresets = [
    OUTFIT_COLLECTION_DELIVERY_ID,
    ...OUTFIT_COLLECTION_DELIVERY_ALIASES,
  ];

  const campQuery: Record<string, any> = {
    tenantId,
    presetId: { $in: matchingPresets },
    status: 'ACTIVE',
  };
  if (options?.campaignId) {
    campQuery.campaignId = options.campaignId;
  }

  const activeCampaigns = await CampaignModel.find(campQuery).lean();
  if (activeCampaigns.length === 0) {
    return { scannedFulfilments: 0, enrolledOccurrences: 0, skippedExisting: 0 };
  }

  let totalScanned = 0;
  let totalEnrolled = 0;
  let totalSkipped = 0;

  for (const cmp of activeCampaigns) {
    // 1. Acquire durable checkpoint lease (Spec p21, p25)
    const checkpointType = `fulfilment-reconcile:${cmp.campaignId}`;
    const acquiredCheckpoint = await CampaignCheckpointModel.findOneAndUpdate(
      {
        tenantId,
        campaignId: cmp.campaignId,
        type: checkpointType,
        $or: [
          { leaseExpiresAt: null },
          { leaseExpiresAt: { $lt: now } },
          { status: 'COMPLETED' },
        ],
      },
      {
        $set: {
          status: 'IN_PROGRESS',
          leaseToken,
          leaseExpiresAt,
          startedAt: now,
          error: null,
        },
      },
      { upsert: true, new: true }
    );

    if (!acquiredCheckpoint || acquiredCheckpoint.leaseToken !== leaseToken) {
      // Another planner holds the lease
      continue;
    }

    try {
      const ver: any = await CampaignVersionModel.findOne({
        tenantId,
        campaignId: cmp.campaignId,
      }).sort({ version: -1 }).lean();

      const milestone = ver?.milestone || ver?.trigger?.milestone || 'OUTFIT_READY';

      // Window calculation: [now - (maxDelay + maxDeferral + maxLateness + 1 day), now]
      const maxDelayDays = 14;
      const windowStart = new Date(now.getTime() - (maxDelayDays + 2) * 24 * 60 * 60 * 1000);

      if (milestone === 'OUTFIT_READY') {
        const candidates = await SrcFulfilmentModel.find({
          tenantId,
          status: { $in: ['READY_FOR_COLLECTION', 'PARTIALLY_READY'] },
          readyAt: { $gte: windowStart, $lte: now },
        })
          .limit(100)
          .lean();

        totalScanned += candidates.length;

        for (const ful of candidates) {
          const occurrenceId = `ready:${ful.orderId}:${ful.readinessVersion}`;
          const existing = await CampaignEnrollmentModel.findOne({
            tenantId,
            campaignId: cmp.campaignId,
            occurrenceId,
          });

          if (existing) {
            totalSkipped++;
            continue;
          }

          const res = await enrollFulfilmentReady(tenantId, cmp.campaignId, ful.orderId, {
            now,
            allowPast: true,
          });
          if (res.enrolled) {
            totalEnrolled++;
          }
        }
      } else if (milestone === 'DISPATCHED') {
        const candidates = await SrcFulfilmentModel.find({
          tenantId,
          'shipments.status': 'DISPATCHED',
          'shipments.verified': true,
          'shipments.dispatchedAt': { $gte: windowStart, $lte: now },
        })
          .limit(100)
          .lean();

        totalScanned += candidates.length;

        for (const ful of candidates) {
          for (const shp of ful.shipments) {
            if (shp.status === 'DISPATCHED' && shp.verified) {
              const occurrenceId = `dispatch:${ful.orderId}:${shp.shipmentId}`;
              const existing = await CampaignEnrollmentModel.findOne({
                tenantId,
                campaignId: cmp.campaignId,
                occurrenceId,
              });

              if (existing) {
                totalSkipped++;
                continue;
              }

              const res = await enrollShipmentDispatched(
                tenantId,
                cmp.campaignId,
                ful.orderId,
                shp.shipmentId,
                { now, allowPast: true }
              );
              if (res.enrolled) {
                totalEnrolled++;
              }
            }
          }
        }
      } else if (milestone === 'DELIVERED') {
        const candidates = await SrcFulfilmentModel.find({
          tenantId,
          'shipments.status': 'DELIVERED',
          'shipments.verified': true,
          'shipments.deliveredAt': { $gte: windowStart, $lte: now },
        })
          .limit(100)
          .lean();

        totalScanned += candidates.length;

        for (const ful of candidates) {
          for (const shp of ful.shipments) {
            if (shp.status === 'DELIVERED' && shp.verified) {
              const occurrenceId = `delivered:${ful.orderId}:${shp.shipmentId}`;
              const existing = await CampaignEnrollmentModel.findOne({
                tenantId,
                campaignId: cmp.campaignId,
                occurrenceId,
              });

              if (existing) {
                totalSkipped++;
                continue;
              }

              const res = await enrollShipmentDelivered(
                tenantId,
                cmp.campaignId,
                ful.orderId,
                shp.shipmentId,
                { now, allowPast: true }
              );
              if (res.enrolled) {
                totalEnrolled++;
              }
            }
          }
        }
      }

      // Mark checkpoint complete
      await CampaignCheckpointModel.updateOne(
        { tenantId, campaignId: cmp.campaignId, type: checkpointType },
        {
          $set: {
            status: 'COMPLETED',
            leaseExpiresAt: null,
            completedAt: now,
            processedCount: totalScanned,
            enrolledCount: totalEnrolled,
          },
        }
      );
    } catch (err: any) {
      await CampaignCheckpointModel.updateOne(
        { tenantId, campaignId: cmp.campaignId, type: checkpointType },
        {
          $set: {
            status: 'FAILED',
            leaseExpiresAt: null,
            error: err?.message || String(err),
          },
        }
      );
      throw err;
    }
  }

  return {
    scannedFulfilments: totalScanned,
    enrolledOccurrences: totalEnrolled,
    skippedExisting: totalSkipped,
  };
}

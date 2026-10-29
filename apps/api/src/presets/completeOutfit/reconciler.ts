import crypto from 'crypto';
import {
  CampaignModel,
  CampaignVersionModel,
  CampaignCheckpointModel,
  SrcOrderModel,
} from '../../db/models';
import { enrollCompleteOutfitOccurrence } from './enroller';
import { isQualifyingOrder } from '../_shared/orderTrigger/qualifying';
import { clock } from '../../services/clock';
import { logger } from '../../logger';

export interface ReconcileOutfitOptions {
  campaignId?: string;
  batchSize?: number;
  nowOverride?: Date;
  resumeFromCheckpoint?: boolean;
}

export interface ReconcileOutfitResult {
  campaignId: string;
  scannedCount: number;
  enrolledCount: number;
  excludedCount: number;
  checkpointId?: string;
  status: 'COMPLETED' | 'IN_PROGRESS' | 'FAILED';
  durationMs: number;
}

/**
 * Bounded, checkpointed reconciliation scanner for Complete the Outfit campaigns.
 * Scans qualifying orders with completedAt in [now - (maxDelay + maxDeferral + maxLateness + 1 day), now].
 * Checkpoint key: outfit-reconcile:{campaignId}.
 */
export async function reconcileCompleteOutfitCampaign(
  tenantId: string,
  campaignId: string,
  options: ReconcileOutfitOptions = {}
): Promise<ReconcileOutfitResult> {
  const startTime = Date.now();
  const now = options.nowOverride || clock.now();
  const batchSize = Math.min(Math.max(1, options.batchSize || 50), 100);

  // 1. Locate Campaign & Active Published Version
  const campaign: any = await CampaignModel.findOne({ tenantId, campaignId }).lean();
  if (!campaign || campaign.status !== 'ACTIVE') {
    return {
      campaignId,
      scannedCount: 0,
      enrolledCount: 0,
      excludedCount: 0,
      status: 'COMPLETED',
      durationMs: Date.now() - startTime,
    };
  }

  const version: any =
    (await CampaignVersionModel.findOne({
      tenantId,
      campaignId,
      isPublished: true,
      version: campaign.draftVersion,
    }).lean()) ||
    (await CampaignVersionModel.findById(campaign.activeVersionId).lean());

  if (!version) {
    return {
      campaignId,
      scannedCount: 0,
      enrolledCount: 0,
      excludedCount: 0,
      status: 'FAILED',
      durationMs: Date.now() - startTime,
    };
  }

  // 2. Compute lookback window: now - (maxDelay + maxDeferral + maxLateness + 1 day)
  const steps = version.steps || [];
  let maxDelayHours = 5 * 24; // Default 5 days
  let maxDeferralHours = 24;
  let maxLatenessHours = 24;

  for (const step of steps) {
    const delay = (step as any).delay;
    if (delay) {
      const delayH = delay.unit === 'DAYS' ? delay.value * 24 : delay.value;
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

  // 3. Checkpoint Lease & State
  const checkpointType = `outfit-reconcile:${campaignId}`;
  const leaseToken = crypto.randomUUID();
  const leaseExpiresAt = new Date(now.getTime() + 5 * 60 * 1000); // 5 min lease

  let checkpoint = await CampaignCheckpointModel.findOne({
    tenantId,
    campaignId,
    type: checkpointType,
  });

  if (!checkpoint) {
    checkpoint = await CampaignCheckpointModel.create({
      tenantId,
      campaignId,
      type: checkpointType,
      status: 'IN_PROGRESS',
      leaseToken,
      leaseExpiresAt,
      lastOrderId: null,
      processedCount: 0,
      enrolledCount: 0,
      startedAt: now,
    });
  } else {
    // Check if another lease is active
    if (
      checkpoint.status === 'IN_PROGRESS' &&
      checkpoint.leaseExpiresAt &&
      checkpoint.leaseExpiresAt.getTime() > now.getTime() &&
      options.resumeFromCheckpoint !== true
    ) {
      logger.warn(
        { tenantId, campaignId, leaseToken: checkpoint.leaseToken },
        'Outfit reconciler checkpoint already locked by another runner'
      );
      return {
        campaignId,
        scannedCount: 0,
        enrolledCount: 0,
        excludedCount: 0,
        checkpointId: checkpoint.id,
        status: 'IN_PROGRESS',
        durationMs: Date.now() - startTime,
      };
    }

    checkpoint.leaseToken = leaseToken;
    checkpoint.leaseExpiresAt = leaseExpiresAt;
    checkpoint.status = 'IN_PROGRESS';
    checkpoint.startedAt = now;
    await checkpoint.save();
  }

  // 4. Query Qualifying Orders within the window
  const query: Record<string, unknown> = {
    tenantId,
    status: 'COMPLETED',
    paid: true,
    netPaise: { $gt: 0 },
    completedAt: { $gte: cutoffDate, $lte: now },
  };

  if (options.resumeFromCheckpoint && (checkpoint as any).lastOrderId) {
    query.orderId = { $gt: (checkpoint as any).lastOrderId };
  }

  const orders = await SrcOrderModel.find(query)
    .sort({ orderId: 1 })
    .limit(batchSize)
    .lean<any[]>();

  let scannedCount = 0;
  let enrolledCount = 0;
  let excludedCount = 0;
  let lastOrderId: string | null = null;

  for (const order of orders) {
    scannedCount++;
    lastOrderId = order.orderId;

    if (isQualifyingOrder(order)) {
      const res = await enrollCompleteOutfitOccurrence(
        tenantId,
        campaignId,
        order.customerId,
        order,
        version
      );

      if (res.enrolled) enrolledCount++;
      if (res.excluded) excludedCount++;
    }
  }

  // 5. Update Checkpoint State
  checkpoint.processedCount = (checkpoint.processedCount || 0) + scannedCount;
  checkpoint.enrolledCount = (checkpoint.enrolledCount || 0) + enrolledCount;
  (checkpoint as any).lastOrderId = lastOrderId;
  checkpoint.status = orders.length < batchSize ? 'COMPLETED' : 'IN_PROGRESS';
  checkpoint.completedAt = orders.length < batchSize ? now : undefined;
  checkpoint.leaseToken = null;
  checkpoint.leaseExpiresAt = null;
  await checkpoint.save();

  logger.info(
    {
      tenantId,
      campaignId,
      scannedCount,
      enrolledCount,
      excludedCount,
      checkpointStatus: checkpoint.status,
    },
    'Complete the Outfit reconciliation sweep finished'
  );

  return {
    campaignId,
    scannedCount,
    enrolledCount,
    excludedCount,
    checkpointId: checkpoint.id,
    status: checkpoint.status as any,
    durationMs: Date.now() - startTime,
  };
}

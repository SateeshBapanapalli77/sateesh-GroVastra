import crypto from 'crypto';
import {
  CampaignModel,
  CampaignVersionModel,
  CampaignCheckpointModel,
  CampaignCustomerFactModel,
  SrcOrderModel,
  ICampaignVersion,
} from '../../../db/models';
import { enrollEventDelayOccurrence } from './enrollerBase';
import { clock } from '../../../services/clock';
import { logger } from '../../../logger';

export interface ReconcileEventDelayOptions {
  campaignId?: string;
  batchSize?: number;
  nowOverride?: Date;
  resumeFromCheckpoint?: boolean;
}

export interface ReconcileEventDelayResult {
  campaignId: string;
  scannedCount: number;
  enrolledCount: number;
  excludedCount: number;
  checkpointId?: string;
  status: 'COMPLETED' | 'IN_PROGRESS' | 'FAILED';
  durationMs: number;
}

/**
 * Bounded, checkpointed reconciliation scanner for EVENT_DELAY campaigns.
 * Scans campaignCustomerFacts where qualifyingOrderCount == 1 within the eligibility lookback window.
 * Checkpoint key: event-delay-reconcile:{campaignId}.
 */
export async function reconcileEventDelayCampaign(
  tenantId: string,
  campaignId: string,
  options: ReconcileEventDelayOptions = {}
): Promise<ReconcileEventDelayResult> {
  const startTime = Date.now();
  const now = options.nowOverride || clock.now();
  const batchSize = Math.min(Math.max(1, options.batchSize || 50), 100);

  // 1. Locate Campaign & Active Version
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
  let maxDelayHours = 1;
  let maxDeferralHours = 24;
  let maxLatenessHours = 3;

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
  const checkpointType = `event-delay-reconcile:${campaignId}`;
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
      lastCustomerId: null,
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
        'Event delay reconciler checkpoint already locked by another runner'
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

  // 4. Query Facts Cursor
  const isRepeatPurchase =
    campaign.presetId === 'FIRST_TO_SECOND_PURCHASE' ||
    campaign.presetId === 'first_to_second_purchase' ||
    campaign.presetId === 'first-repeat' ||
    campaign.presetId === 'second_purchase';

  const query: Record<string, unknown> = {
    tenantId,
    qualifyingOrderCount: 1,
    firstQualifyingAt: { $gte: cutoffDate, $lte: now },
    maxQualifyingOrderCountSeen: { $lte: 1 },
  };

  if (options.resumeFromCheckpoint && checkpoint.lastCustomerId) {
    query.customerId = { $gt: checkpoint.lastCustomerId };
  }

  const facts = await CampaignCustomerFactModel.find(query)
    .sort({ customerId: 1 })
    .limit(batchSize)
    .lean();

  let scannedCount = 0;
  let enrolledCount = 0;
  let excludedCount = 0;
  let lastCustomerId: string | null = null;

  for (const fact of facts) {
    if (!fact.customerId) continue;
    scannedCount++;
    lastCustomerId = fact.customerId;

    if (fact.firstQualifyingOrderId) {
      const order = await SrcOrderModel.findOne({ tenantId, orderId: fact.firstQualifyingOrderId });
      if (order) {
        const occurrenceId = isRepeatPurchase ? `repeat:${order.orderId}` : `welcome:${order.orderId}`;
        const res = await enrollEventDelayOccurrence(
          tenantId,
          campaignId,
          fact.customerId,
          occurrenceId,
          {
            orderId: order.orderId,
            orderNumber: order.orderNumber || order.orderId,
            netPaise: order.netPaise,
            completedAt: order.completedAt,
            occurredAt: order.completedAt,
            entityVersion: order.entityVersion,
          },
          version
        );

        if (res.enrolled) enrolledCount++;
        if (res.excluded) excludedCount++;
      }
    }
  }

  // 5. Update Checkpoint State
  checkpoint.processedCount = (checkpoint.processedCount || 0) + scannedCount;
  checkpoint.enrolledCount = (checkpoint.enrolledCount || 0) + enrolledCount;
  checkpoint.lastCustomerId = lastCustomerId;
  checkpoint.status = facts.length < batchSize ? 'COMPLETED' : 'IN_PROGRESS';
  checkpoint.completedAt = facts.length < batchSize ? now : undefined;
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
    'Event delay reconciliation sweep finished'
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

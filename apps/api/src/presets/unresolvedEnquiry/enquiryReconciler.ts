import crypto from 'crypto';
import {
  CampaignModel,
  CampaignVersionModel,
  CampaignCheckpointModel,
  ICampaignVersion,
} from '../../db/models';
import { mockEnquirySource } from '../../adapters/enquiry-source';
import { enrollEnquiryOccurrence } from './enquiryEnroller';
import { clock } from '../../services/clock';
import { logger } from '../../logger';

export interface ReconcileEnquiryOptions {
  campaignId?: string;
  batchSize?: number;
  nowOverride?: Date;
  resumeFromCheckpoint?: boolean;
}

export interface ReconcileEnquiryResult {
  campaignId: string;
  scannedCount: number;
  enrolledCount: number;
  excludedCount: number;
  checkpointId?: string;
  status: 'COMPLETED' | 'IN_PROGRESS' | 'FAILED';
  durationMs: number;
}

/**
 * Bounded, checkpointed reconciliation scanner for ENQUIRY_EVENT_DELAY campaigns.
 * Scans open enquiries where lastCustomerInteractionAt is within [now - (maxDelay + maxDeferral + maxLateness + 1 day), now].
 * Checkpoint key: enquiry-reconcile:{campaignId}.
 */
export async function reconcileEnquiryCampaign(
  tenantId: string,
  campaignId: string,
  options: ReconcileEnquiryOptions = {}
): Promise<ReconcileEnquiryResult> {
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
  let maxDelayHours = 24;
  let maxDeferralHours = 24;
  let maxLatenessHours = 12;

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
  const checkpointType = `enquiry-reconcile:${campaignId}`;
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
        'Enquiry reconciler checkpoint already locked by another runner'
      );
      return {
        campaignId,
        scannedCount: 0,
        enrolledCount: 0,
        excludedCount: 0,
        status: 'IN_PROGRESS',
        durationMs: Date.now() - startTime,
      };
    }

    // Acquire lease
    checkpoint.leaseToken = leaseToken;
    checkpoint.leaseExpiresAt = leaseExpiresAt;
    checkpoint.status = 'IN_PROGRESS';
    if (!options.resumeFromCheckpoint) {
      checkpoint.lastCustomerId = null;
      checkpoint.processedCount = 0;
      checkpoint.enrolledCount = 0;
    }
    checkpoint.startedAt = now;
    await checkpoint.save();
  }

  // 4. Scan open enquiries in batches using cursor
  let scannedCount = 0;
  let enrolledCount = 0;
  let excludedCount = 0;
  let currentCursor: string | null = checkpoint.lastCustomerId || null;

  try {
    let hasMore = true;
    while (hasMore) {
      const page = await mockEnquirySource.listOpenByInteractionRange(
        tenantId,
        cutoffDate,
        now,
        currentCursor,
        batchSize
      );

      const enquiries = page.enquiries;
      if (enquiries.length === 0) {
        hasMore = false;
        break;
      }

      for (const enquiry of enquiries) {
        scannedCount++;
        const enrollResult = await enrollEnquiryOccurrence(
          tenantId,
          enquiry,
          campaignId,
          version
        );

        if (enrollResult.enrolled) {
          enrolledCount++;
        } else if (enrollResult.excluded) {
          excludedCount++;
        }
      }

      currentCursor = page.nextCursor;
      if (!currentCursor) {
        hasMore = false;
      } else {
        // Update checkpoint progress
        checkpoint.lastCustomerId = currentCursor;
        checkpoint.processedCount = (checkpoint.processedCount || 0) + enquiries.length;
        checkpoint.enrolledCount = (checkpoint.enrolledCount || 0) + enrolledCount;
        checkpoint.leaseExpiresAt = new Date(Date.now() + 5 * 60 * 1000);
        await checkpoint.save();
      }
    }

    // 5. Complete Checkpoint
    checkpoint.status = 'COMPLETED';
    checkpoint.completedAt = new Date();
    checkpoint.leaseToken = null;
    checkpoint.leaseExpiresAt = null;
    await checkpoint.save();

    return {
      campaignId,
      scannedCount,
      enrolledCount,
      excludedCount,
      checkpointId: checkpoint._id.toString(),
      status: 'COMPLETED',
      durationMs: Date.now() - startTime,
    };
  } catch (err: any) {
    logger.error({ err: err.message, campaignId }, 'Enquiry reconciler error');
    checkpoint.status = 'FAILED';
    checkpoint.error = err.message;
    checkpoint.leaseToken = null;
    checkpoint.leaseExpiresAt = null;
    await checkpoint.save();

    return {
      campaignId,
      scannedCount,
      enrolledCount,
      excludedCount,
      status: 'FAILED',
      durationMs: Date.now() - startTime,
    };
  }
}

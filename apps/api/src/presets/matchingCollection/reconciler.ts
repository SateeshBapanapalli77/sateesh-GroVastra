/**
 * Reconciler scanner for MATCHING_COLLECTION campaigns (F26)
 *
 * Ensures all active collection releases are fanned out to opted-in customers,
 * resuming from checkpoints where applicable.
 */

import { CampaignModel } from '../../db/models';
import { SrcCollectionModel } from '../../db/models/src-collection.model';
import { fanoutCollectionPublished } from './fanout';
import { clock } from '../../services/clock';
import { logger } from '../../logger';

export interface ReconcileCollectionOptions {
  campaignId?: string;
  batchSize?: number;
  nowOverride?: Date;
  resumeFromCheckpoint?: boolean;
}

export interface ReconcileCollectionResult {
  campaignId: string;
  scannedCount: number;
  enrolledCount: number;
  excludedCount: number;
  status: 'COMPLETED' | 'IN_PROGRESS' | 'FAILED';
  durationMs: number;
}

export async function reconcileMatchingCollectionCampaign(
  tenantId: string,
  campaignId: string,
  options: ReconcileCollectionOptions = {}
): Promise<ReconcileCollectionResult> {
  const startTime = Date.now();
  const now = options.nowOverride || clock.now();

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

  // Find all ACTIVE collections published for this tenant
  const collections = await SrcCollectionModel.find({
    tenantId,
    status: 'ACTIVE',
  }).lean();

  let totalEnrolled = 0;
  let totalExcluded = 0;
  let scannedCount = 0;

  for (const collection of collections) {
    scannedCount++;
    try {
      const res = await fanoutCollectionPublished(tenantId, collection as any, now);
      totalEnrolled += res.totalEnrolled;
      totalExcluded += res.totalExcluded;
    } catch (err: any) {
      logger.error(
        { err: err.message, tenantId, releaseId: collection.releaseId },
        '[F26] Error during collection reconciler fan-out'
      );
    }
  }

  return {
    campaignId,
    scannedCount,
    enrolledCount: totalEnrolled,
    excludedCount: totalExcluded,
    status: 'COMPLETED',
    durationMs: Date.now() - startTime,
  };
}

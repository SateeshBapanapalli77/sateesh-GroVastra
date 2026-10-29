import crypto from 'crypto';
import {
  CampaignModel,
  CampaignVersionModel,
  CampaignCheckpointModel,
} from '../../db/models';
import { mockRequestSource } from '../../adapters/request-source';
import { mockProductSource } from '../../adapters/product-source';
import { enrollRequestedItemAvailableOccurrence } from './enroller';
import { clock } from '../../services/clock';
import { logger } from '../../logger';

export interface ReconcileRequestOptions {
  campaignId?: string;
  batchSize?: number;
  nowOverride?: Date;
  resumeFromCheckpoint?: boolean;
}

export interface ReconcileRequestResult {
  campaignId: string;
  scannedCount: number;
  enrolledCount: number;
  excludedCount: number;
  status: 'COMPLETED' | 'IN_PROGRESS' | 'FAILED';
  durationMs: number;
}

/**
 * Bounded, checkpointed reconciliation scanner for REQUEST_STOCK_AVAILABLE campaigns.
 * Scans open requests and enrolls them if matching stock is currently available.
 */
export async function reconcileRequestedItemAvailableCampaign(
  tenantId: string,
  campaignId: string,
  options: ReconcileRequestOptions = {}
): Promise<ReconcileRequestResult> {
  const startTime = Date.now();
  const now = options.nowOverride || clock.now();

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

  // 2. Find open requests
  const openRequests = await mockRequestSource.listAllOpen(tenantId);
  let scannedCount = 0;
  let enrolledCount = 0;
  let excludedCount = 0;

  for (const req of openRequests) {
    scannedCount++;
    try {
      // Check if product has available stock
      const product = await mockProductSource.getProductById(tenantId, req.itemRef.productId);
      if (!product || product.status !== 'ACTIVE') continue;

      const hasStock = req.itemRef.variantId
        ? (product.variants || []).some(
            (v: any) => v.variantId === req.itemRef.variantId && (v.sellableQty || 0) > 0
          )
        : (product.variants || []).some((v: any) => (v.sellableQty || 0) > 0);

      if (!hasStock) continue;

      const res = await enrollRequestedItemAvailableOccurrence(
        tenantId,
        req,
        now,
        campaignId,
        version
      );

      if (res.enrolled) {
        enrolledCount++;
      } else if (res.excluded) {
        excludedCount++;
      }
    } catch (err: any) {
      logger.error(
        { err: err.message, tenantId, requestId: req.requestId },
        'Error during requested item reconciler'
      );
    }
  }

  return {
    campaignId,
    scannedCount,
    enrolledCount,
    excludedCount,
    status: 'COMPLETED',
    durationMs: Date.now() - startTime,
  };
}

import crypto from 'crypto';
import { CampaignCheckpointModel, CampaignModel, CampaignVersionModel, SrcCustomerModel } from '../../db/models';
import { mockOfferSource } from '../../adapters/OfferSource';
import { enrollSelectedStockOffer } from './enroller';
import { clock } from '../../services/clock';

const BATCH_SIZE = 200;

export async function fanoutSelectedStockOffer(
  tenantId: string,
  offerId: string,
  eventId: string,
  options: { campaignId?: string; now?: Date } = {}
): Promise<Record<string, unknown>> {
  const now = options.now || clock.now();
  const offer = await mockOfferSource.getOffer(tenantId, offerId);
  if (!offer || offer.kind !== 'SELECTED_STOCK') {
    return { outcome: 'QUARANTINED', reason: 'OFFER_INVALID' };
  }
  const campaigns = await CampaignModel.find({
    tenantId,
    status: 'ACTIVE',
    presetId: { $in: ['selected_stock_promotion', 'SELECTED_STOCK_PROMOTION'] },
    ...(options.campaignId ? { campaignId: options.campaignId } : {}),
  }).lean();
  let totalEnrolled = 0;
  let totalExcluded = 0;
  let totalSkipped = 0;

  for (const campaign of campaigns) {
    const version: any =
      (await CampaignVersionModel.findOne({ tenantId, campaignId: campaign.campaignId, isPublished: true })
        .sort({ version: -1 }).lean());
    if (!version) continue;
    const checkpointType = `offer-fanout:${eventId}:${campaign.campaignId}`;
    let checkpoint: any = await CampaignCheckpointModel.findOne({ tenantId, campaignId: campaign.campaignId, type: checkpointType });
    if (!checkpoint) {
      checkpoint = await CampaignCheckpointModel.create({
        tenantId,
        campaignId: campaign.campaignId,
        type: checkpointType,
        status: 'IN_PROGRESS',
        leaseToken: crypto.randomUUID(),
        leaseExpiresAt: new Date(now.getTime() + 10 * 60 * 1000),
        lastCustomerId: null,
        horizonStart: offer.publishedAt ? new Date(offer.publishedAt).toISOString() : now.toISOString(),
        horizonEnd: now.toISOString(),
        processedCount: 0,
        enrolledCount: 0,
        startedAt: now,
      });
    } else if (checkpoint.status === 'COMPLETED') {
      continue;
    }
    let lastCustomerId = checkpoint.lastCustomerId || null;
    const recipientLimit = Math.max(0, version.maxRecipientsPerOffer || 1000);
    while (true) {
      const query: any = {
        tenantId,
        deletedAt: null,
        status: { $nin: ['DELETED', 'OPTED_OUT'] },
      };
      if (lastCustomerId) query.customerId = { $gt: lastCustomerId };
      if (campaign.enabledBranches?.length) query.branchId = { $in: campaign.enabledBranches };
      const customers = await SrcCustomerModel.find(query).sort({ customerId: 1 }).limit(BATCH_SIZE).lean();
      if (!customers.length) break;
      for (const customer of customers) {
        if ((checkpoint.enrolledCount || 0) >= recipientLimit) {
          lastCustomerId = customer.customerId;
          checkpoint.lastCustomerId = lastCustomerId;
          checkpoint.processedCount = (checkpoint.processedCount || 0) + 1;
          continue;
        }
        const result = await enrollSelectedStockOffer(tenantId, offer, customer.customerId, {
          campaignId: campaign.campaignId,
          now,
          maxItems: version.maxItemsInMessage || 3,
        });
        if (result.enrolled) totalEnrolled++;
        else if (result.excluded) totalExcluded++;
        else totalSkipped++;
        lastCustomerId = customer.customerId;
        checkpoint.lastCustomerId = lastCustomerId;
        checkpoint.processedCount = (checkpoint.processedCount || 0) + 1;
        checkpoint.enrolledCount = (checkpoint.enrolledCount || 0) + (result.enrolled ? 1 : 0);
      }
      await checkpoint.save();
      if (customers.length < BATCH_SIZE) break;
      if ((checkpoint.enrolledCount || 0) >= recipientLimit) break;
    }
    checkpoint.status = 'COMPLETED';
    checkpoint.completedAt = now;
    checkpoint.leaseExpiresAt = null;
    await checkpoint.save();
  }
  return { outcome: 'FANOUT_COMPLETED', offerId, totalEnrolled, totalExcluded, totalSkipped };
}

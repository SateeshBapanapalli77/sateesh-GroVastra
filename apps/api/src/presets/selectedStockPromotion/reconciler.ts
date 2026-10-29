import { CampaignModel, CampaignVersionModel } from '../../db/models';
import { mockOfferSource } from '../../adapters/OfferSource';
import { fanoutSelectedStockOffer } from './fanout';
import { clock } from '../../services/clock';

export async function reconcileSelectedStockCampaign(
  tenantId: string,
  campaignId: string,
  now = clock.now()
): Promise<{ campaignId: string; offersSeen: number; fanouts: number }> {
  const campaign: any = await CampaignModel.findOne({ tenantId, campaignId, status: 'ACTIVE' }).lean();
  if (!campaign) return { campaignId, offersSeen: 0, fanouts: 0 };
  const version: any = await CampaignVersionModel.findOne({
    tenantId,
    campaignId,
    isPublished: true,
  }).sort({ version: -1 }).lean();
  if (!version) return { campaignId, offersSeen: 0, fanouts: 0 };
  const maxDelay = Math.max(
    ...(version.steps || []).map((step: any) => {
      const delay = step.delay || { unit: 'HOURS', value: 1 };
      return delay.unit === 'DAYS' ? delay.value * 24 : delay.unit === 'MINUTES' ? delay.value / 60 : delay.value;
    }),
    1
  );
  const from = new Date(now.getTime() - (maxDelay + 24 + 24) * 60 * 60 * 1000);
  const page = await mockOfferSource.listActiveByPublishedRange(tenantId, from, now, null, 1000);
  let fanouts = 0;
  for (const offer of page.offers) {
    await fanoutSelectedStockOffer(tenantId, offer.offerId, `reconcile:${campaignId}:${offer.offerId}`, { campaignId, now });
    fanouts++;
  }
  return { campaignId, offersSeen: page.offers.length, fanouts };
}

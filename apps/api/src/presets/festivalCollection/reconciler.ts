import crypto from 'crypto';
import { CampaignModel, SrcSeasonModel } from '../../db/models';
import { fanoutFestivalSeason } from './fanout';
import { clock } from '../../services/clock';

export async function reconcileFestivalCampaigns(
  tenantId: string,
  options: { campaignId?: string; now?: Date } = {}
): Promise<{ campaignsChecked: number; seasonsReconciled: number; totalEnrolled: number }> {
  const now = options.now || clock.now();
  const campaigns = await CampaignModel.find({
    tenantId,
    status: 'ACTIVE',
    presetId: { $in: ['festival_collection', 'FESTIVAL_COLLECTION', 'festival'] },
    ...(options.campaignId ? { campaignId: options.campaignId } : {}),
  }).lean();

  if (!campaigns.length) {
    return { campaignsChecked: 0, seasonsReconciled: 0, totalEnrolled: 0 };
  }

  // Find active festival seasons that have not ended
  const activeSeasons = await SrcSeasonModel.find({
    tenantId,
    status: 'ACTIVE',
    festivalDate: { $gte: now },
  }).lean();

  let seasonsReconciled = 0;
  let totalEnrolled = 0;

  for (const season of activeSeasons) {
    const eventId = `evt_rec_season_${crypto.randomUUID().slice(0, 8)}`;
    for (const campaign of campaigns) {
      const result = await fanoutFestivalSeason(tenantId, season.seasonId, eventId, {
        campaignId: campaign.campaignId,
        now,
      });
      seasonsReconciled++;
      totalEnrolled += typeof result.totalEnrolled === 'number' ? result.totalEnrolled : 0;
    }
  }

  return { campaignsChecked: campaigns.length, seasonsReconciled, totalEnrolled };
}

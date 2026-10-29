import crypto from 'crypto';
import { CampaignModel, SrcEventModel } from '../../db/models';
import { fanoutStoreEvent } from './fanout';
import { clock } from '../../services/clock';
import { EXHIBITION_TRUNK_SHOW_ALIASES } from './definition';

export async function reconcileExhibitionCampaigns(
  tenantId: string,
  options: { campaignId?: string; now?: Date } = {}
): Promise<{ campaignsChecked: number; eventsReconciled: number; totalEnrolled: number }> {
  const now = options.now || clock.now();
  const campaigns = await CampaignModel.find({
    tenantId,
    status: 'ACTIVE',
    presetId: { $in: EXHIBITION_TRUNK_SHOW_ALIASES as any },
    ...(options.campaignId ? { campaignId: options.campaignId } : {}),
  }).lean();

  if (!campaigns.length) {
    return { campaignsChecked: 0, eventsReconciled: 0, totalEnrolled: 0 };
  }

  // Find upcoming active events
  const upcomingEvents = await SrcEventModel.find({
    tenantId,
    status: { $in: ['ACTIVE', 'FULL'] },
    endDate: { $gte: now },
  }).lean();

  let eventsReconciled = 0;
  let totalEnrolled = 0;

  for (const event of upcomingEvents) {
    const eventId = `evt_rec_event_${crypto.randomUUID().slice(0, 8)}`;
    for (const campaign of campaigns) {
      const result = await fanoutStoreEvent(tenantId, event.eventId, eventId, {
        campaignId: campaign.campaignId,
        now,
      });
      eventsReconciled++;
      totalEnrolled += typeof result.totalEnrolled === 'number' ? result.totalEnrolled : 0;
    }
  }

  return { campaignsChecked: campaigns.length, eventsReconciled, totalEnrolled };
}

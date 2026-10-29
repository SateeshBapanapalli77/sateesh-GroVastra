import crypto from 'crypto';
import {
  CampaignEnrollmentModel,
  CampaignExecutionModel,
  CampaignGoalEventModel,
} from '../../db/models';
import { mockOfferSource } from '../../adapters/OfferSource';
import { clock } from '../../services/clock';

export async function handleOrderCompletedForSelectedStockGoal(
  tenantId: string,
  customerId: string,
  order: any,
  occurredAt: Date
): Promise<{ goalMatches: string[] }> {
  if (!customerId || order?.status !== 'COMPLETED' || order?.paid === false) return { goalMatches: [] };
  const enrollments = await CampaignEnrollmentModel.find({
    tenantId,
    customerId,
    status: 'ACTIVE',
    occurrenceId: { $regex: '^stockoffer:' },
  });
  const goalMatches: string[] = [];
  for (const enrollment of enrollments) {
    const offerId = enrollment.occurrenceId.split(':')[1];
    const offer = await mockOfferSource.getOffer(tenantId, offerId);
    if (!offer) continue;
    const completedAt = new Date(order.completedAt || occurredAt);
    const anchorAt = new Date(enrollment.anchorAt || 0);
    if (completedAt <= anchorAt || completedAt > new Date(offer.validUntil)) continue;
    const tagged = order.offerRef === `stockoffer:${offerId}` || order.offerRef === offerId ||
      (Array.isArray(order.tags) && order.tags.includes(`stockoffer:${offerId}`));
    const mode = enrollment.goalMode || 'OFFER_ITEM_OR_TAGGED';
    const lineMatch = mode !== 'TAGGED_ONLY' && (order.lines || []).some((line: any) => {
      if ((line.returnedQty || 0) >= (line.qty || line.quantity || 1)) return false;
      return (offer.items || []).some((item: any) =>
        item.productId === (line.productId || line.itemRef) &&
        (!item.variantIds?.length || item.variantIds.includes(line.variantId))
      );
    });
    if (!tagged && !lineMatch) continue;
    const source = tagged ? 'OFFER_TAGGED_ORDER' : 'OFFER_ITEM_PURCHASED';
    const goalEventId = `goal_${crypto.randomUUID().slice(0, 12)}`;
    await CampaignGoalEventModel.create({
      goalEventId,
      tenantId,
      enrollmentId: enrollment.enrollmentId,
      occurrence: enrollment.occurrenceId,
      customerId,
      campaignId: enrollment.campaignId,
      source,
      orderRef: order.orderId || order._id?.toString(),
      cause: source,
      recordedBy: 'system',
      at: completedAt,
    });
    enrollment.status = 'COMPLETED';
    enrollment.goalReachedAt = completedAt;
    enrollment.goalEventId = goalEventId;
    enrollment.goalOrderRef = order.orderId || null;
    enrollment.goalSource = source;
    await enrollment.save();
    await CampaignExecutionModel.updateMany(
      {
        tenantId,
        enrollmentId: enrollment.enrollmentId,
        state: { $in: ['SCHEDULED', 'DEFERRED', 'EVALUATING'] },
      },
      { $set: { state: 'SKIPPED', skipReason: 'SKIPPED_GOAL_REACHED' } }
    );
    goalMatches.push(enrollment.enrollmentId);
  }
  return { goalMatches };
}

import { ICampaignEventInbox, CampaignEnrollmentModel, CampaignExecutionModel } from '../../db/models';
import { mockOfferSource } from '../../adapters/OfferSource';
import { mockProductSource } from '../../adapters/product-source';
import { validateSelectedStockOffer } from './offerValidation';
import { clock } from '../../services/clock';
import { fanoutSelectedStockOffer } from './fanout';

/**
 * Offer events are hints. The authoritative offer is always re-read from the
 * source adapter before validation or downstream processing.
 */
export async function handleSelectedStockOfferEvent(
  eventDoc: ICampaignEventInbox
): Promise<Record<string, unknown>> {
  const { tenantId, entityId: offerId, type } = eventDoc;
  const offer = await mockOfferSource.getOffer(tenantId, offerId);

  if (!offer || offer.kind !== 'SELECTED_STOCK') {
    return {
      handler: type,
      offerId,
      outcome: 'QUARANTINED',
      reason: 'OFFER_INVALID',
      reasonText: 'Offer was not found or is not SELECTED_STOCK',
    };
  }

  const products = await Promise.all(
    (offer.items || []).map(async (item) => {
      const product = await mockProductSource.getProduct(tenantId, item.productId);
      return { productId: item.productId, pricePaise: product?.pricePaise };
    })
  );
  const result = validateSelectedStockOffer(
    {
      ...offer,
      validFrom: new Date(offer.validFrom),
      validUntil: new Date(offer.validUntil),
      publishedAt: offer.publishedAt ? new Date(offer.publishedAt) : null,
    },
    products,
    clock.now()
  );
  if (!result.valid) {
    return {
      handler: type,
      offerId,
      outcome: 'QUARANTINED',
      reason: 'OFFER_INVALID',
      reasonText: result.reason,
    };
  }

  if (type === 'offer.published') {
    return fanoutSelectedStockOffer(tenantId, offerId, eventDoc.eventId);
  }

  if (type === 'offer.withdrawn' || offer.status === 'WITHDRAWN' || offer.status === 'EXPIRED' ||
      (type === 'offer.updated' && new Date(offer.validUntil).getTime() <= clock.now().getTime())) {
    const reason = offer.status === 'EXPIRED' || new Date(offer.validUntil).getTime() <= clock.now().getTime()
      ? 'OFFER_ENDED'
      : 'OFFER_WITHDRAWN';
    const enrollments = await CampaignEnrollmentModel.find({
      tenantId,
      occurrenceId: `stockoffer:${offerId}`,
      status: 'ACTIVE',
    }).select({ enrollmentId: 1 }).lean();
    const enrollmentIds = enrollments.map((entry) => entry.enrollmentId);
    if (enrollmentIds.length) {
      await CampaignExecutionModel.updateMany(
        {
          tenantId,
          enrollmentId: { $in: enrollmentIds },
          state: { $in: ['SCHEDULED', 'DEFERRED', 'EVALUATING'] },
        },
        { $set: { state: 'CANCELLED', skipReason: reason } }
      );
      await CampaignEnrollmentModel.updateMany(
        { tenantId, enrollmentId: { $in: enrollmentIds }, status: 'ACTIVE' },
        { $set: { status: 'CANCELLED', stopReason: reason, stoppedAt: clock.now() } }
      );
    }
    return { handler: type, offerId, outcome: 'CANCELLED', reason, cancelled: enrollmentIds.length };
  }

  if (type === 'offer.updated' && offer.status === 'PAUSED') {
    const enrollments = await CampaignEnrollmentModel.find({
      tenantId,
      occurrenceId: `stockoffer:${offerId}`,
      status: 'ACTIVE',
    }).select({ enrollmentId: 1 }).lean();
    const enrollmentIds = enrollments.map((entry) => entry.enrollmentId);
    if (enrollmentIds.length) {
      await CampaignExecutionModel.updateMany(
        { tenantId, enrollmentId: { $in: enrollmentIds }, state: { $in: ['SCHEDULED', 'DEFERRED'] } },
        { $set: { state: 'SKIPPED', skipReason: 'OFFER_PAUSED' } }
      );
    }
    return { handler: type, offerId, outcome: 'PAUSED', skipped: enrollmentIds.length };
  }

  return {
    handler: type,
    offerId,
    outcome: type === 'offer.withdrawn' ? 'WITHDRAWN' : 'VALIDATED',
    entityVersion: offer.version,
  };
}

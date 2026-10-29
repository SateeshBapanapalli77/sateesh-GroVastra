import crypto from 'crypto';
import {
  ENROLLMENT_STATUS,
  EXECUTION_REASONS,
  EXECUTION_STATE,
  EXCLUSION_REASONS,
  isDestinationVerified,
} from '@grovastra/shared';
import {
  CampaignEnrollmentModel,
  CampaignExecutionModel,
  CampaignModel,
  CampaignVersionModel,
} from '../../db/models';
import { mockCustomerSource } from '../../adapters/customer-source';
import { mockProductSource } from '../../adapters/product-source';
import { campaignSettingsService } from '../../services/campaign-settings.service';
import { contactGateService } from '../../services/contact-gate/contact-gate.service';
import { clock } from '../../services/clock';
import { computeDueTimes } from '../_shared/eventDelay/delayTiming';
import { matchSelectedStock } from './matching';

export async function enrollSelectedStockOffer(
  tenantId: string,
  offer: any,
  customerId: string,
  options: { campaignId?: string; now?: Date; maxItems?: number } = {}
): Promise<{ enrolled: boolean; excluded: boolean; reason?: string; enrollmentId?: string }> {
  const now = options.now || clock.now();
  const campaigns = await CampaignModel.find({
    tenantId,
    status: 'ACTIVE',
    ...(options.campaignId ? { campaignId: options.campaignId } : {}),
    presetId: { $in: ['selected_stock_promotion', 'SELECTED_STOCK_PROMOTION'] },
  }).lean();
  const customer = await mockCustomerSource.getCustomerById(tenantId, customerId);
  if (!customer) return { enrolled: false, excluded: true, reason: EXCLUSION_REASONS.NO_CUSTOMER_RECORD };

  let enrolledId: string | undefined;
  for (const campaign of campaigns) {
    const version: any =
      (await CampaignVersionModel.findOne({
        tenantId,
        campaignId: campaign.campaignId,
        isPublished: true,
        version: campaign.draftVersion,
      }).lean()) ||
      (await CampaignVersionModel.findById(campaign.activeVersionId).lean());
    if (!version || version.trigger?.type !== 'OFFER_PUBLICATION') continue;
    if (campaign.endAt && now >= new Date(campaign.endAt)) continue;
    if (offer.branchIds?.length && customer.branchId && !offer.branchIds.includes(customer.branchId)) continue;
    if (campaign.enabledBranches?.length && !campaign.enabledBranches.includes(customer.branchId)) continue;

    const occurrenceId = `stockoffer:${offer.offerId}`;
    const existing = await CampaignEnrollmentModel.findOne({
      tenantId,
      campaignId: campaign.campaignId,
      customerId,
      occurrenceId,
    });
    if (existing) continue;

    const exclude = async (reason: string, explanation: string) => {
      await CampaignEnrollmentModel.create({
        enrollmentId: `enr_${crypto.randomUUID().slice(0, 12)}`,
        enrollmentKey: `${tenantId}:${campaign.campaignId}:${customerId}:${occurrenceId}`,
        tenantId,
        campaignId: campaign.campaignId,
        campaignVersionId: version._id?.toString() || `ver_${campaign.campaignId}_${version.version}`,
        campaignVersion: version.version,
        customerId,
        occurrenceId,
        sourceRef: { type: 'SRC_OFFERS', id: offer.offerId, version: offer.version || 1 },
        occasionLocalDate: 'EXCLUDED',
        anchorAt: new Date(Math.max(new Date(offer.publishedAt || now).getTime(), new Date(offer.validFrom).getTime())),
        destinationHash: customer.destination?.destinationHash || null,
        status: ENROLLMENT_STATUS.EXCLUDED,
        exclusionReason: reason,
        matchExplanation: explanation,
        planRevision: 1,
      });
    };

    if (customer.status === 'DELETED' || customer.deletedAt) {
      await exclude(EXCLUSION_REASONS.CUSTOMER_DELETED, 'Customer is deleted');
      continue;
    }
    if (!customer.destination?.destinationHash || !customer.destination.encryptedPhone) {
      await exclude(EXCLUSION_REASONS.INVALID_DESTINATION, 'Destination is missing');
      continue;
    }
    const settings = await campaignSettingsService.getSettings(tenantId);
    if (!isDestinationVerified(customer.destination, settings.minDestinationVerification || 'CONFIRMED_BY_STAFF')) {
      await exclude(EXCLUSION_REASONS.DESTINATION_NOT_VERIFIED, 'Destination is not verified');
      continue;
    }
    const gate = await contactGateService.getGate(tenantId, customer.destination.destinationHash);
    if (contactGateService.isHealthUndeliverable(gate, customer.destination.verifiedAt)) {
      await exclude(EXCLUSION_REASONS.DESTINATION_UNDELIVERABLE, 'Destination is undeliverable');
      continue;
    }
    if (customer.consent?.channelSuppressed) {
      await exclude(EXCLUSION_REASONS.CHANNEL_SUPPRESSED, 'Channel is suppressed');
      continue;
    }
    if (customer.consent?.marketingOptIn === false || customer.status === 'OPTED_OUT') {
      await exclude(EXCLUSION_REASONS.NO_MARKETING_CONSENT, 'Marketing consent is absent');
      continue;
    }

    const products = await Promise.all((offer.items || []).map(async (item: any) => mockProductSource.getProduct(tenantId, item.productId)));
    const match = matchSelectedStock(
      { customerId, preferences: customer.preferences },
      products.filter(Boolean).map((product: any) => product),
      offer,
      {
        mode: version.matchMode || 'STRICT',
        audienceMode: version.audience?.mode || 'PREFERENCE_MATCH',
        maxItems: options.maxItems || version.maxItemsInMessage || 3,
      }
    );
    if (!match.matched) {
      await exclude('NO_MATCHING_ITEM', match.excluded.map((item) => item.reason).join(', ') || 'No eligible item matched');
      continue;
    }

    const anchorAt = new Date(Math.max(new Date(offer.publishedAt || now).getTime(), new Date(offer.validFrom).getTime()));
    const enrollmentId = `enr_${crypto.randomUUID().slice(0, 12)}`;
    const enrollmentKey = `${tenantId}:${campaign.campaignId}:${customerId}:${occurrenceId}`;
    const executionDocs: any[] = [];
    for (const step of version.steps || []) {
      const timing = computeDueTimes(
        anchorAt,
        (step as any).delay || { unit: 'HOURS', value: 1 },
        {
          allowedSendingHours: settings.allowedSendingHours || { start: '10:00', end: '19:00' },
          blackoutDates: settings.blackoutDates || [],
          holidays: settings.holidays || [],
          timezone: version.timezone || settings.timezone || 'Asia/Kolkata',
        },
        {
          outsideHoursPolicy: step.outsideHoursPolicy || 'DEFER_NEXT_DAY',
          maxDeferralHours: step.maxDeferralHours ?? 24,
          maxLatenessMinutes: step.maxLatenessMinutes ?? 720,
        },
        {
          campaignEndAt: campaign.endAt ? new Date(campaign.endAt) : null,
          offerValidUntil: new Date(offer.validUntil),
          now,
        }
      );
      let state: any = EXECUTION_STATE.SCHEDULED;
      let skipReason: string | null = null;
      if (timing.shouldSkip || timing.adjustedDueAt >= new Date(offer.validUntil)) {
        state = EXECUTION_STATE.SKIPPED;
        skipReason = EXECUTION_REASONS.OFFER_ENDED;
      } else if (timing.isElapsed || timing.adjustedDueAt <= now) {
        state = EXECUTION_STATE.SKIPPED;
        skipReason = EXECUTION_REASONS.SKIPPED_ELAPSED;
      } else if (timing.isDeferred) {
        state = EXECUTION_STATE.DEFERRED;
      }
      executionDocs.push({
        executionId: `exec_${crypto.randomUUID().slice(0, 12)}`,
        executionKey: `${enrollmentKey}:${step.stepId}`,
        tenantId,
        campaignId: campaign.campaignId,
        enrollmentId,
        customerId,
        stepId: step.stepId,
        stepName: step.stepName,
        templateRef: step.templateRef || null,
        dueAt: timing.adjustedDueAt,
        originalDueAt: timing.rawDueAt,
        rawDueAt: timing.rawDueAt,
        adjustedDueAt: timing.adjustedDueAt,
        expiresAt: timing.expiresAt,
        localDate: timing.adjustedLocalDate,
        localTime: timing.adjustedLocalTime,
        timezone: timing.timezone,
        planRevision: 1,
        state,
        skipReason,
        deferralReason: timing.deferralReason || null,
        prerequisite: step.prerequisite || 'NONE',
        attemptCount: 0,
        offerRef: { offerId: offer.offerId, version: offer.version || 1 },
        selectionSnapshot: {
          offerId: offer.offerId,
          offerVersion: offer.version || 1,
          items: match.items,
          matchReasons: match.matchReasons,
        },
      });
    }
    await CampaignEnrollmentModel.create({
      enrollmentId,
      enrollmentKey,
      tenantId,
      campaignId: campaign.campaignId,
      campaignVersionId: version._id?.toString() || `ver_${campaign.campaignId}_${version.version}`,
      campaignVersion: version.version,
      customerId,
      occurrenceId,
      sourceRef: { type: 'SRC_OFFERS', id: offer.offerId, version: offer.version || 1 },
      occasionLocalDate: anchorAt.toISOString().slice(0, 10),
      anchorAt,
      destinationHash: customer.destination.destinationHash,
      status: ENROLLMENT_STATUS.ACTIVE,
      planRevision: 1,
      goalMode: version.goalMode || 'OFFER_ITEM_OR_TAGGED',
      matchExplanation: match.matchReasons.join(', '),
      matchSnapshot: match,
    });
    if (executionDocs.length) await CampaignExecutionModel.insertMany(executionDocs);
    enrolledId = enrollmentId;
  }
  return enrolledId ? { enrolled: true, excluded: false, enrollmentId: enrolledId } : { enrolled: false, excluded: false };
}

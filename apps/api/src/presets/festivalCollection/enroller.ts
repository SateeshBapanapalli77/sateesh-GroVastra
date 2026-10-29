import crypto from 'crypto';
import {
  ENROLLMENT_STATUS,
  EXECUTION_REASONS,
  EXECUTION_STATE,
  EXCLUSION_REASONS,
  isDestinationVerified,
} from '@grovastra/shared';
import { DateTime } from 'luxon';
import {
  CampaignEnrollmentModel,
  CampaignExecutionModel,
  CampaignModel,
  CampaignVersionModel,
  SrcCollectionModel,
} from '../../db/models';
import { mockCustomerSource } from '../../adapters/customer-source';
import { campaignSettingsService } from '../../services/campaign-settings.service';
import { contactGateService } from '../../services/contact-gate/contact-gate.service';
import { clock } from '../../services/clock';
import { matchFestivalCollection } from './matching';
import { SourceSeason } from '../../adapters/season-source';

export async function enrollFestivalCustomer(
  tenantId: string,
  season: SourceSeason,
  customerId: string,
  options: { campaignId?: string; now?: Date; maxItems?: number } = {}
): Promise<{ enrolled: boolean; excluded: boolean; reason?: string; enrollmentId?: string }> {
  const now = options.now || clock.now();
  const campaigns = await CampaignModel.find({
    tenantId,
    status: 'ACTIVE',
    ...(options.campaignId ? { campaignId: options.campaignId } : {}),
    presetId: { $in: ['festival_collection', 'FESTIVAL_COLLECTION', 'festival'] },
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

    if (!version) continue;
    if (campaign.endAt && now >= new Date(campaign.endAt)) continue;
    if (season.branchIds?.length && customer.branchId && !season.branchIds.includes(customer.branchId)) continue;
    if (campaign.enabledBranches?.length && !campaign.enabledBranches.includes(customer.branchId)) continue;

    const occurrenceId = `festival:${season.seasonId}`;
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
        sourceRef: { type: 'SRC_SEASONS', id: season.seasonId, version: season.entityVersion || 1 },
        occasionLocalDate: 'EXCLUDED',
        anchorAt: new Date(season.festivalDate),
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

    // Resolve collection items
    const relId = season.releaseId || season.collectionId;
    let collectionItems: any[] = season.collection?.items || [];
    if (!collectionItems.length && relId) {
      const colDoc: any = await SrcCollectionModel.findOne({ tenantId, releaseId: relId }).lean();
      if (colDoc && colDoc.status !== 'WITHDRAWN') {
        collectionItems = colDoc.items || [];
      }
    }

    const match = matchFestivalCollection(
      { customerId, firstName: customer.firstName, preferences: customer.preferences },
      collectionItems,
      {
        mode: version.matchMode || 'STRICT',
        audienceMode: version.audience?.mode || 'ALL_ELIGIBLE',
        maxItems: options.maxItems || version.maxItemsInMessage || 3,
      }
    );

    if (!match.matched) {
      await exclude('NO_MATCHING_ITEM', match.matchReasons[0] || 'No eligible festival item matched');
      continue;
    }

    const festivalDate = new Date(season.festivalDate);
    const validUntil = season.validUntil ? new Date(season.validUntil) : festivalDate;
    const tz = version.timezone || settings.timezone || 'Asia/Kolkata';
    const festivalDt = DateTime.fromJSDate(festivalDate).setZone(tz);

    const enrollmentId = `enr_${crypto.randomUUID().slice(0, 12)}`;
    const enrollmentKey = `${tenantId}:${campaign.campaignId}:${customerId}:${occurrenceId}`;
    const executionDocs: any[] = [];

    for (const step of version.steps || []) {
      const offsetDays = typeof step.offsetDays === 'number' ? step.offsetDays : -21;
      const [sendH, sendM] = (step.localTime || '10:00').split(':').map(Number);

      // Target send instant in timezone
      const stepTargetDt = festivalDt.plus({ days: offsetDays }).set({
        hour: sendH,
        minute: sendM,
        second: 0,
        millisecond: 0,
      });

      const rawDueAt = stepTargetDt.toJSDate();
      let adjustedDueAt = rawDueAt;
      let state: any = EXECUTION_STATE.SCHEDULED;
      let skipReason: string | null = null;

      // If scheduled due time is at or past the festival event date or validUntil, it has ended!
      if (adjustedDueAt >= validUntil || adjustedDueAt >= festivalDate) {
        state = EXECUTION_STATE.SKIPPED;
        skipReason = 'FESTIVAL_ENDED';
      } else if (adjustedDueAt <= now) {
        // Future-only rule
        state = EXECUTION_STATE.SKIPPED;
        skipReason = EXECUTION_REASONS.SKIPPED_ELAPSED;
      }

      // Expires at the end of the festival date in timezone
      const expiresAt = festivalDt.endOf('day').toJSDate();

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
        dueAt: adjustedDueAt,
        originalDueAt: rawDueAt,
        rawDueAt,
        adjustedDueAt,
        expiresAt,
        localDate: stepTargetDt.toISODate() || '',
        localTime: step.localTime || '10:00',
        timezone: tz,
        planRevision: 1,
        state,
        skipReason,
        prerequisite: step.prerequisite || 'NONE',
        attemptCount: 0,
        selectionSnapshot: {
          seasonId: season.seasonId,
          seasonName: season.name,
          festivalDate: festivalDate.toISOString(),
          releaseId: relId,
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
      sourceRef: { type: 'SRC_SEASONS', id: season.seasonId, version: season.entityVersion || 1 },
      occasionLocalDate: festivalDt.toISODate() || '',
      anchorAt: festivalDate,
      destinationHash: customer.destination.destinationHash,
      status: ENROLLMENT_STATUS.ACTIVE,
      planRevision: 1,
      goalMode: version.goalMode || 'COLLECTION_ITEM_OR_TAGGED',
      matchExplanation: match.matchReasons.join(', '),
      matchSnapshot: match,
    });

    if (executionDocs.length) {
      await CampaignExecutionModel.insertMany(executionDocs);
    }
    enrolledId = enrollmentId;
  }

  return enrolledId ? { enrolled: true, excluded: false, enrollmentId: enrolledId } : { enrolled: false, excluded: false };
}

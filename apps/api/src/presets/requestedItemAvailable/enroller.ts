import crypto from 'crypto';
import {
  ENROLLMENT_STATUS,
  EXECUTION_STATE,
  EXECUTION_REASONS,
  EXCLUSION_REASONS,
  isDestinationVerified,
} from '@grovastra/shared';
import {
  CampaignModel,
  CampaignVersionModel,
  CampaignEnrollmentModel,
  CampaignExecutionModel,
  ICampaignVersion,
} from '../../db/models';
import { mockCustomerSource } from '../../adapters/customer-source';
import { campaignSettingsService } from '../../services/campaign-settings.service';
import { contactGateService } from '../../services/contact-gate/contact-gate.service';
import { computeDueTimes } from '../_shared/eventDelay/delayTiming';
import { clock } from '../../services/clock';
import { logger } from '../../logger';
import { SourceRequest } from '../../adapters/request-source';

export interface RequestEnrollmentResult {
  enrolled: boolean;
  excluded: boolean;
  exclusionReason?: string;
  enrollmentId?: string;
  executionIds?: string[];
  alreadyProcessed?: boolean;
  message: string;
  outcome?: string;
}

/**
 * Enrolls a customer into the Requested Item Available campaign when stock becomes
 * available for an item they previously requested.
 *
 * occurrenceId is `request:{requestId}:{productId}:{variantId|any}` so the same
 * stock.published event cannot enroll the same request twice.
 */
export async function enrollRequestedItemAvailableOccurrence(
  tenantId: string,
  request: SourceRequest,
  stockPublishedAt: Date,
  campaignId?: string,
  activeVersionOverride?: ICampaignVersion
): Promise<RequestEnrollmentResult> {
  const now = clock.now();

  // 1. Customer identity check
  if (!request.customerId || typeof request.customerId !== 'string' || !request.customerId.trim()) {
    return {
      enrolled: false,
      excluded: true,
      exclusionReason: EXCLUSION_REASONS.NO_CUSTOMER_IDENTITY,
      outcome: 'NO_CUSTOMER_IDENTITY',
      message: 'No customer identity on request',
    };
  }

  // 2. Request must be OPEN (not already fulfilled/cancelled)
  if (request.status !== 'OPEN') {
    return {
      enrolled: false,
      excluded: false,
      outcome: 'REQUEST_NOT_OPEN',
      message: `Request status is '${request.status}', not OPEN — skipping enrollment`,
    };
  }

  const customerId = request.customerId.trim();
  const variantLabel = request.itemRef.variantId || 'any';

  // 3. Locate active campaigns with trigger REQUEST_STOCK_AVAILABLE
  const campaignQuery: any = {
    tenantId,
    status: 'ACTIVE',
  };
  if (campaignId) {
    campaignQuery.campaignId = campaignId;
  }

  const campaigns = await CampaignModel.find(campaignQuery).lean();
  if (campaigns.length === 0) {
    return {
      enrolled: false,
      excluded: false,
      message: 'No active campaigns found',
      outcome: 'NO_ACTIVE_CAMPAIGN',
    };
  }

  let totalEnrolled = 0;
  let lastEnrollmentId: string | undefined;
  const createdExecutionIds: string[] = [];

  for (const campaign of campaigns) {
    // Check campaign endAt
    if (campaign.endAt && now.getTime() >= new Date(campaign.endAt).getTime()) {
      continue;
    }

    const version: any =
      activeVersionOverride ||
      (await CampaignVersionModel.findOne({
        tenantId,
        campaignId: campaign.campaignId,
        isPublished: true,
        version: campaign.draftVersion,
      }).lean()) ||
      (await CampaignVersionModel.findById(campaign.activeVersionId).lean());

    if (!version) continue;

    // Trigger type must be REQUEST_STOCK_AVAILABLE
    if (version.trigger?.type !== 'REQUEST_STOCK_AVAILABLE') {
      continue;
    }

    // Branch scope check
    if (
      campaign.enabledBranches &&
      campaign.enabledBranches.length > 0 &&
      request.branchId &&
      !campaign.enabledBranches.includes(request.branchId)
    ) {
      continue;
    }

    // occurrenceId: one enrollment per (request × stock event type)
    const occurrenceId = `request:${request.requestId}:${request.itemRef.productId}:${variantLabel}`;
    const enrollmentKey = `${tenantId}:${campaign.campaignId}:${customerId}:${occurrenceId}`;

    // Deduplication check
    const existingEnrollment = await CampaignEnrollmentModel.findOne({
      tenantId,
      campaignId: campaign.campaignId,
      customerId,
      occurrenceId,
    });

    if (existingEnrollment) {
      continue;
    }

    // Load customer
    const customer = await mockCustomerSource.getCustomerById(tenantId, customerId);
    if (!customer) {
      logger.warn({ tenantId, customerId, requestId: request.requestId }, 'Customer not found for request enrollment');
      continue;
    }

    // Mandatory shared gates
    if (customer.status === 'DELETED' || customer.deletedAt != null) {
      await recordExcludedRequestEnrollment({
        tenantId, campaignId: campaign.campaignId, version, customerId,
        occurrenceId, enrollmentKey, request, stockPublishedAt,
        exclusionReason: EXCLUSION_REASONS.CUSTOMER_DELETED,
        explanation: 'Customer record is deleted',
      });
      continue;
    }

    if (!customer.destination?.encryptedPhone || !customer.destination.destinationHash) {
      await recordExcludedRequestEnrollment({
        tenantId, campaignId: campaign.campaignId, version, customerId,
        occurrenceId, enrollmentKey, request, stockPublishedAt,
        exclusionReason: EXCLUSION_REASONS.INVALID_DESTINATION,
        explanation: 'Customer missing phone destination',
      });
      continue;
    }

    const settings = await campaignSettingsService.getSettings(tenantId);
    const minVerification = settings?.minDestinationVerification || 'CONFIRMED_BY_STAFF';

    if (!isDestinationVerified(customer.destination, minVerification)) {
      await recordExcludedRequestEnrollment({
        tenantId, campaignId: campaign.campaignId, version, customerId,
        occurrenceId, enrollmentKey, request, stockPublishedAt,
        exclusionReason: EXCLUSION_REASONS.DESTINATION_NOT_VERIFIED,
        explanation: `Destination verification level does not meet required '${minVerification}'`,
      });
      continue;
    }

    const destGate = await contactGateService.getGate(tenantId, customer.destination.destinationHash);
    if (contactGateService.isHealthUndeliverable(destGate, customer.destination.verifiedAt)) {
      await recordExcludedRequestEnrollment({
        tenantId, campaignId: campaign.campaignId, version, customerId,
        occurrenceId, enrollmentKey, request, stockPublishedAt,
        exclusionReason: EXCLUSION_REASONS.DESTINATION_UNDELIVERABLE,
        explanation: 'Destination is marked UNDELIVERABLE',
      });
      continue;
    }

    if (customer.consent?.channelSuppressed === true) {
      await recordExcludedRequestEnrollment({
        tenantId, campaignId: campaign.campaignId, version, customerId,
        occurrenceId, enrollmentKey, request, stockPublishedAt,
        exclusionReason: EXCLUSION_REASONS.CHANNEL_SUPPRESSED,
        explanation: 'Customer destination is channel suppressed',
      });
      continue;
    }

    if (customer.consent?.marketingOptIn === false || customer.status === 'OPTED_OUT') {
      await recordExcludedRequestEnrollment({
        tenantId, campaignId: campaign.campaignId, version, customerId,
        occurrenceId, enrollmentKey, request, stockPublishedAt,
        exclusionReason: EXCLUSION_REASONS.NO_MARKETING_CONSENT,
        explanation: 'Customer has not recorded marketing opt-in',
      });
      continue;
    }

    // Stock availability window check
    const windowDays = version.stockAvailabilityWindowDays ?? 14;
    const windowMs = windowDays * 24 * 60 * 60 * 1000;
    const requestCreatedAt = new Date(request.createdAt);
    const windowExpiry = new Date(requestCreatedAt.getTime() + windowMs);

    if (stockPublishedAt.getTime() > windowExpiry.getTime()) {
      await recordExcludedRequestEnrollment({
        tenantId, campaignId: campaign.campaignId, version, customerId,
        occurrenceId, enrollmentKey, request, stockPublishedAt,
        exclusionReason: EXCLUSION_REASONS.ENQUIRY_TOO_OLD, // reuses same semantics
        explanation: `Request is older than ${windowDays} days; window expired ${windowExpiry.toISOString()}`,
      });
      continue;
    }

    // Compute execution timing
    const anchorAt = stockPublishedAt;
    const steps = version.steps || [];
    const executionIds: string[] = [];
    const executionDocs: any[] = [];

    for (let idx = 0; idx < steps.length; idx++) {
      const step = steps[idx];
      const delaySpec = (step as any).delay || { unit: 'HOURS', value: 1 };

      const timing = computeDueTimes(
        anchorAt,
        delaySpec,
        {
          allowedSendingHours: settings?.allowedSendingHours || { start: '10:00', end: '19:00' },
          blackoutDates: settings?.blackoutDates || [],
          holidays: settings?.holidays || [],
          timezone: version.timezone || settings?.timezone || 'Asia/Kolkata',
        },
        {
          outsideHoursPolicy: (step as any).outsideHoursPolicy || 'DEFER_NEXT_DAY',
          maxDeferralHours: (step as any).maxDeferralHours ?? 24,
          maxLatenessMinutes: step.maxLatenessMinutes ?? 1440,
        },
        {
          campaignEndAt: campaign.endAt ? new Date(campaign.endAt) : null,
          now,
          maxLatenessMinutes: step.maxLatenessMinutes ?? 1440,
        }
      );

      const executionId = `exec_${crypto.randomUUID().slice(0, 12)}`;
      executionIds.push(executionId);

      let stepState: any = EXECUTION_STATE.SCHEDULED;
      let skipReason: string | null = null;

      if (timing.isElapsed || timing.adjustedDueAt.getTime() <= now.getTime()) {
        stepState = EXECUTION_STATE.SKIPPED;
        skipReason = EXECUTION_REASONS.SKIPPED_ELAPSED;
      } else if (timing.isDeferred) {
        stepState = EXECUTION_STATE.DEFERRED;
      }

      executionDocs.push({
        executionId,
        executionKey: `${enrollmentKey.replace(':', '_')}:${step.stepId}`,
        tenantId,
        campaignId: campaign.campaignId,
        enrollmentId: `enr_${crypto.randomUUID().slice(0, 12)}`, // placeholder — overwritten below
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
        state: stepState,
        skipReason,
        deferralReason: timing.deferralReason || null,
        prerequisite: step.prerequisite || 'NONE',
        attemptCount: 0,
      });
    }

    // Assign real enrollment ID and link executions
    const enrollmentId = `enr_${crypto.randomUUID().slice(0, 12)}`;
    lastEnrollmentId = enrollmentId;
    for (const doc of executionDocs) {
      doc.enrollmentId = enrollmentId;
      createdExecutionIds.push(doc.executionId);
    }

    // Create enrollment
    await CampaignEnrollmentModel.create({
      enrollmentId,
      enrollmentKey,
      tenantId,
      campaignId: campaign.campaignId,
      campaignVersionId:
        version._id?.toString() ||
        version.campaignVersionId ||
        `ver_${campaign.campaignId}_${version.version}`,
      campaignVersion: version.version,
      customerId,
      occurrenceId,
      sourceRef: {
        type: 'SRC_REQUESTS',
        id: request.requestId,
        version: request.entityVersion || 1,
      },
      occasionLocalDate: stockPublishedAt.toISOString().split('T')[0],
      anchorAt,
      requestId: request.requestId,
      itemRef: request.itemRef,
      itemName: null, // resolved at dispatch via bindingSources
      goalMode: version.trigger?.goalMode || 'ITEM_OR_TAGGED',
      status: ENROLLMENT_STATUS.ACTIVE,
      destinationHash: customer.destination.destinationHash,
      planRevision: 1,
      matchExplanation: `Requested item ${request.itemRef.productId} is back in stock`,
    });

    if (executionDocs.length > 0) {
      await CampaignExecutionModel.insertMany(executionDocs);
    }

    totalEnrolled++;
  }

  return {
    enrolled: totalEnrolled > 0,
    excluded: false,
    enrollmentId: lastEnrollmentId,
    executionIds: createdExecutionIds,
    message:
      totalEnrolled > 0
        ? `Enrolled into ${totalEnrolled} campaign(s) for requested item available`
        : 'No campaigns enrolled',
    outcome: totalEnrolled > 0 ? 'ENROLLED' : 'NO_CAMPAIGN_MATCHED',
  };
}

async function recordExcludedRequestEnrollment(params: {
  tenantId: string;
  campaignId: string;
  version: any;
  customerId: string;
  occurrenceId: string;
  enrollmentKey: string;
  request: SourceRequest;
  stockPublishedAt: Date;
  exclusionReason: string;
  explanation: string;
}): Promise<void> {
  const {
    tenantId,
    campaignId,
    version,
    customerId,
    occurrenceId,
    enrollmentKey,
    request,
    stockPublishedAt,
    exclusionReason,
    explanation,
  } = params;

  try {
    const enrollmentId = `enr_${crypto.randomUUID().slice(0, 12)}`;
    await CampaignEnrollmentModel.create({
      enrollmentId,
      enrollmentKey,
      tenantId,
      campaignId,
      campaignVersionId:
        version._id?.toString() || `ver_${campaignId}_${version.version}`,
      campaignVersion: version.version,
      customerId,
      occurrenceId,
      sourceRef: {
        type: 'SRC_REQUESTS',
        id: request.requestId,
        version: request.entityVersion || 1,
      },
      occasionLocalDate: 'EXCLUDED',
      anchorAt: stockPublishedAt,
      requestId: request.requestId,
      itemRef: request.itemRef,
      destinationHash: null,
      matchExplanation: explanation,
      status: ENROLLMENT_STATUS.EXCLUDED,
      exclusionReason,
      planRevision: 1,
    });
  } catch (err: any) {
    if (err.code !== 11000) {
      logger.error(
        { err, tenantId, campaignId, occurrenceId },
        'Failed to record excluded request enrollment'
      );
    }
  }
}

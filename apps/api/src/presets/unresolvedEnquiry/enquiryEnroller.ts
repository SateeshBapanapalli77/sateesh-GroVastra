import crypto from 'crypto';
import {
  ENROLLMENT_STATUS,
  EXECUTION_STATE,
  EXECUTION_REASONS,
  EXCLUSION_REASONS,
  SourceCustomer,
  SourceEnquiry,
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
import { evaluateCustomerForCampaign } from '../../services/audience';
import { computeDueTimes } from '../_shared/eventDelay/delayTiming';
import { DateTime } from 'luxon';
import { clock } from '../../services/clock';
import { logger } from '../../logger';

export interface EnquiryEnrollmentResult {
  enrolled: boolean;
  excluded: boolean;
  exclusionReason?: string;
  enrollmentId?: string;
  executionIds?: string[];
  alreadyProcessed?: boolean;
  message: string;
  outcome?: string;
}

export async function enrollEnquiryOccurrence(
  tenantId: string,
  enquiry: SourceEnquiry,
  campaignId?: string,
  activeVersionOverride?: ICampaignVersion
): Promise<EnquiryEnrollmentResult> {
  const now = clock.now();

  // 1. Check customerId
  if (!enquiry.customerId || typeof enquiry.customerId !== 'string' || !enquiry.customerId.trim()) {
    return {
      enrolled: false,
      excluded: true,
      exclusionReason: 'NO_CUSTOMER_RECORD',
      outcome: 'NO_CUSTOMER_RECORD',
      message: 'No customer record on enquiry',
    };
  }

  const customerId = enquiry.customerId.trim();

  // 2. Locate active campaigns with trigger ENQUIRY_EVENT_DELAY
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

    // Trigger type must be ENQUIRY_EVENT_DELAY
    if (version.trigger?.type !== 'ENQUIRY_EVENT_DELAY') {
      continue;
    }

    // Branch scope check
    if (
      campaign.enabledBranches &&
      campaign.enabledBranches.length > 0 &&
      enquiry.branchId &&
      !campaign.enabledBranches.includes(enquiry.branchId)
    ) {
      continue;
    }

    const occurrenceId = `enquiry:${enquiry.enquiryId}`;
    const enrollmentKey = `${tenantId}:${campaign.campaignId}:${customerId}:${occurrenceId}`;

    // Deduplication check: check live enrollment
    const existingEnrollment = await CampaignEnrollmentModel.findOne({
      tenantId,
      campaignId: campaign.campaignId,
      customerId,
      occurrenceId,
    });

    if (existingEnrollment) {
      return {
        enrolled: false,
        excluded: false,
        alreadyProcessed: true,
        enrollmentId: existingEnrollment.enrollmentId,
        message: 'Occurrence already enrolled',
        outcome: 'DUPLICATE',
      };
    }

    // Load customer
    const customer = await mockCustomerSource.getCustomerById(tenantId, customerId);
    if (!customer) {
      return {
        enrolled: false,
        excluded: true,
        exclusionReason: 'NO_CUSTOMER_RECORD',
        outcome: 'NO_CUSTOMER_RECORD',
        message: 'Customer record not found',
      };
    }

    // Mandatory Shared Platform Gates (Spec p10, Hard Rule 7)
    if (customer.status === 'DELETED' || customer.deletedAt != null) {
      return {
        enrolled: false,
        excluded: true,
        exclusionReason: EXCLUSION_REASONS.CUSTOMER_DELETED,
        outcome: 'CUSTOMER_DELETED',
        message: 'Customer is deleted',
      };
    }

    if (!customer.destination?.encryptedPhone || !customer.destination.destinationHash) {
      return {
        enrolled: false,
        excluded: true,
        exclusionReason: EXCLUSION_REASONS.INVALID_DESTINATION,
        outcome: 'INVALID_DESTINATION',
        message: 'Customer missing destination phone',
      };
    }

    const settings = await campaignSettingsService.getSettings(tenantId);
    const minVerification = settings?.minDestinationVerification || 'CONFIRMED_BY_STAFF';

    if (!isDestinationVerified(customer.destination, minVerification)) {
      return {
        enrolled: false,
        excluded: true,
        exclusionReason: EXCLUSION_REASONS.DESTINATION_NOT_VERIFIED,
        outcome: 'DESTINATION_NOT_VERIFIED',
        message: 'Destination not verified',
      };
    }

    const destGate = await contactGateService.getGate(tenantId, customer.destination.destinationHash);
    if (contactGateService.isHealthUndeliverable(destGate, customer.destination.verifiedAt)) {
      return {
        enrolled: false,
        excluded: true,
        exclusionReason: EXCLUSION_REASONS.DESTINATION_UNDELIVERABLE,
        outcome: 'DESTINATION_UNDELIVERABLE',
        message: 'Destination marked undeliverable',
      };
    }

    if (customer.consent?.channelSuppressed === true) {
      return {
        enrolled: false,
        excluded: true,
        exclusionReason: EXCLUSION_REASONS.CHANNEL_SUPPRESSED,
        outcome: 'CHANNEL_SUPPRESSED',
        message: 'Destination channel suppressed',
      };
    }

    if (customer.consent?.marketingOptIn === false || customer.status === 'OPTED_OUT') {
      return {
        enrolled: false,
        excluded: true,
        exclusionReason: EXCLUSION_REASONS.NO_MARKETING_CONSENT,
        outcome: 'NO_MARKETING_CONSENT',
        message: 'No marketing consent',
      };
    }

    // Evaluate Audience Rules
    const evalResult = evaluateCustomerForCampaign({
      customer,
      campaign: {
        trigger: version.trigger,
        enabledBranches: campaign.enabledBranches,
        audience: version.audience,
        purpose: version.purpose,
      },
      enquiry: {
        channel: enquiry.channel,
        hasItem: Boolean(enquiry.itemRef?.productId),
        itemRef: enquiry.itemRef,
      },
    });

    if (!evalResult.eligible) {
      return {
        enrolled: false,
        excluded: true,
        exclusionReason: evalResult.primaryReason,
        outcome: evalResult.primaryReason,
        message: evalResult.details || 'Customer excluded by audience rules',
      };
    }

    // Require item check
    if (version.trigger?.requireItem === true && !enquiry.itemRef?.productId) {
      return {
        enrolled: false,
        excluded: true,
        exclusionReason: 'ITEM_REQUIRED_MISSING',
        outcome: 'ITEM_REQUIRED_MISSING',
        message: 'Campaign requires enquiry to have an itemRef',
      };
    }

    // Timing & Steps Calculation
    const usefulForDays = version.trigger?.usefulForDays ?? 14;
    const maxUsefulAt = new Date(enquiry.createdAt.getTime() + usefulForDays * 24 * 60 * 60 * 1000);
    const anchorAt = enquiry.lastCustomerInteractionAt;

    const enrollmentId = `enr_${crypto.randomUUID()}`;
    lastEnrollmentId = enrollmentId;

    const executionsToCreate: any[] = [];
    const steps = version.steps || [];

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const delay = (step as any).delay || { unit: 'HOURS', value: (step.offsetDays || 1) * 24 };

      const timingResult = computeDueTimes({
        anchorAt,
        delay,
        settings: {
          timezone: version.timezone || settings?.timezone || 'Asia/Kolkata',
          allowedSendingHours: settings?.allowedSendingHours || { start: '10:00', end: '19:00' },
          blackoutDates: settings?.blackoutDates || [],
          holidays: settings?.holidays || [],
        },
        outsideHoursPolicy: (step as any).outsideHoursPolicy || 'DEFER_NEXT_DAY',
        maxDeferralHours: (step as any).maxDeferralHours ?? 24,
        maxLatenessMinutes: step.maxLatenessMinutes ?? 720,
        now,
        campaignEndAt: campaign.endAt ? new Date(campaign.endAt) : undefined,
      });

      const expiresAt = new Date(
        Math.min(timingResult.expiresAt.getTime(), maxUsefulAt.getTime())
      );

      let state: any = EXECUTION_STATE.SCHEDULED;
      let skipReason: string | null = null;
      let usefulUntilReason: string | null = null;

      if (timingResult.adjustedDueAt.getTime() > maxUsefulAt.getTime()) {
        state = EXECUTION_STATE.SKIPPED;
        skipReason = EXECUTION_REASONS.ENQUIRY_TOO_OLD;
        usefulUntilReason = `Enquiry expired after ${usefulForDays} days`;
      } else if (timingResult.shouldSkip || timingResult.skipReason) {
        state = EXECUTION_STATE.SKIPPED;
        skipReason = timingResult.skipReason || EXECUTION_REASONS.OUTSIDE_SENDING_HOURS;
      } else if (timingResult.adjustedDueAt.getTime() <= now.getTime()) {
        // FUTURE_ONLY policy: elapsed steps skipped
        state = EXECUTION_STATE.SKIPPED;
        skipReason = 'Elapsed step prior to evaluation instant';
      } else if (enquiry.staffTakeover === true) {
        state = EXECUTION_STATE.SKIPPED;
        skipReason = EXECUTION_REASONS.STAFF_TAKEOVER;
      }

      const executionId = `exe_${crypto.randomUUID()}`;
      createdExecutionIds.push(executionId);

      executionsToCreate.push({
        executionId,
        executionKey: `${enrollmentId}:${step.stepId}`,
        tenantId,
        campaignId: campaign.campaignId,
        enrollmentId,
        stepId: step.stepId,
        stepName: step.stepName,
        dueAt: timingResult.adjustedDueAt,
        originalDueAt: timingResult.rawDueAt,
        rawDueAt: timingResult.rawDueAt,
        adjustedDueAt: timingResult.adjustedDueAt,
        expiresAt,
        latestUsefulAt: maxUsefulAt,
        usefulUntilReason,
        delaySpec: delay,
        deferralReason: timingResult.deferralReason || null,
        localDate: timingResult.adjustedLocalDate,
        localTime: timingResult.adjustedLocalTime,
        timezone: timingResult.timezone,
        planRevision: 1,
        state,
        skipReason,
        prerequisite: step.prerequisite || 'NONE',
        templateRef: step.templateRef || null,
        deliveryIntentId: null,
      });
    }

    // Create Enrollment Document
    const enrollment = await CampaignEnrollmentModel.create({
      enrollmentId,
      enrollmentKey,
      tenantId,
      campaignId: campaign.campaignId,
      campaignVersion: version.version,
      campaignVersionId: version._id,
      customerId,
      occurrenceId,
      sourceRef: {
        type: 'SRC_ENQUIRIES',
        id: enquiry.enquiryId,
        version: enquiry.entityVersion || 1,
      },
      occasionLocalDate: DateTime.fromJSDate(anchorAt, { zone: version.timezone || 'Asia/Kolkata' }).toISODate()!,
      status: ENROLLMENT_STATUS.ACTIVE,
      replyHoldAt: enquiry.staffTakeover ? now : null,
      holdReason: enquiry.staffTakeover ? 'STAFF_TAKEOVER' : null,
      enquiryId: enquiry.enquiryId,
      itemRef: enquiry.itemRef || null,
      usefulForDays,
      goalMode: version.trigger?.goalMode || 'ITEM_OR_TAGGED',
      anchorAt,
      planRevision: 1,
      anchorHistory: [],
      matchExplanation: evalResult.explanation || `Open enquiry ${enquiry.enquiryId} follow-up`,
      destinationHash: customer.destination?.destinationHash,
    });

    if (executionsToCreate.length > 0) {
      await CampaignExecutionModel.insertMany(executionsToCreate);
    }

    totalEnrolled++;
  }

  return {
    enrolled: totalEnrolled > 0,
    excluded: false,
    enrollmentId: lastEnrollmentId,
    executionIds: createdExecutionIds,
    message: totalEnrolled > 0 ? `Enrolled into ${totalEnrolled} campaign(s)` : 'No campaigns enrolled',
    outcome: totalEnrolled > 0 ? 'ENROLLED' : 'NO_CAMPAIGN_MATCHED',
  };
}

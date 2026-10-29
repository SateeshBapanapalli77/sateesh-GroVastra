import crypto from 'crypto';
import { DateTime } from 'luxon';
import {
  ENROLLMENT_STATUS,
  EXECUTION_STATE,
  EXECUTION_REASONS,
  EXCLUSION_REASONS,
  SourceCustomer,
  isDestinationVerified,
} from '@grovastra/shared';
import {
  CampaignModel,
  CampaignVersionModel,
  CampaignEnrollmentModel,
  CampaignExecutionModel,
  CampaignCustomerFactModel,
  SrcCustomerModel,
  ICampaignVersion,
  ICampaignEnrollment,
} from '../../../db/models';
import { mockCustomerSource } from '../../../adapters/customer-source';
import { mockOfferSource } from '../../../adapters/OfferSource';
import { mockCreditSource } from '../../../adapters/CreditSource';
import { campaignSettingsService } from '../../../services/campaign-settings.service';
import { contactGateService } from '../../../services/contact-gate/contact-gate.service';
import { computeDueTimes } from './delayTiming';
import { clock } from '../../../services/clock';
import { logger } from '../../../logger';

export interface EventDelayEnrollmentResult {
  enrolled: boolean;
  excluded: boolean;
  exclusionReason?: string;
  enrollmentId?: string;
  executionIds?: string[];
  message: string;
}

/**
 * Base enroller for EVENT_DELAY triggers (F19 Welcome, F20 FirstToSecondPurchase & CashbackConfirmation).
 * Evaluates mandatory gates, once-per-customer rule, applies delayTiming,
 * and creates enrollment + executions.
 */
export async function enrollEventDelayOccurrence(
  tenantId: string,
  campaignId: string,
  customerId: string,
  occurrenceId: string, // e.g. "repeat:ord_001", "cashbackconfirm:crd_001"
  anchorData: any, // order or credit
  activeVersionOverride?: ICampaignVersion
): Promise<EventDelayEnrollmentResult> {
  if (!customerId || typeof customerId !== 'string' || !customerId.trim()) {
    return {
      enrolled: false,
      excluded: true,
      exclusionReason: EXCLUSION_REASONS.NO_CUSTOMER_IDENTITY,
      message: 'Excluded: customer identity is missing',
    };
  }

  const now = clock.now();

  // 1. Load Campaign & Active Published Version
  const campaign: any = await CampaignModel.findOne({ tenantId, campaignId }).lean();
  if (!campaign || campaign.status !== 'ACTIVE') {
    return {
      enrolled: false,
      excluded: false,
      message: `Campaign '${campaignId}' is not active`,
    };
  }

  if (campaign.endAt) {
    const endAtTime = new Date(campaign.endAt).getTime();
    const anchorTime = anchorData?.anchorAt ? new Date(anchorData.anchorAt).getTime() : now.getTime();
    if (now.getTime() >= endAtTime || anchorTime >= endAtTime) {
      return {
        enrolled: false,
        excluded: false,
        message: `Campaign '${campaignId}' reached its endAt deadline`,
      };
    }
  }

  const version: any =
    activeVersionOverride ||
    (await CampaignVersionModel.findOne({
      tenantId,
      campaignId,
      isPublished: true,
      version: campaign.draftVersion,
    }).lean()) ||
    (await CampaignVersionModel.findById(campaign.activeVersionId).lean());

  if (!version) {
    return {
      enrolled: false,
      excluded: false,
      message: `No active published version found for campaign '${campaignId}'`,
    };
  }

  const enrollmentKey = `${tenantId}:${campaignId}:${customerId}:${occurrenceId}`;

  // 2. Check if this exact occurrence is already enrolled or excluded
  const existingEnrollment = await CampaignEnrollmentModel.findOne({
    tenantId,
    campaignId,
    customerId,
    occurrenceId,
  });

  if (existingEnrollment) {
    return {
      enrolled: false,
      excluded: false,
      alreadyProcessed: true,
      exclusionReason: existingEnrollment.exclusionReason || undefined,
      enrollmentId: existingEnrollment.enrollmentId,
      message: 'Occurrence already processed',
    } as any;
  }

  // 3. Load Customer & Mandatory Platform Gates (Spec p10, Rule 6)
  const customer = await mockCustomerSource.getCustomerById(tenantId, customerId);

  if (!customer) {
    // Record EXCLUDED enrollment for owner visibility (Spec p29)
    await recordExcludedEnrollment(
      tenantId,
      campaignId,
      version,
      customerId,
      occurrenceId,
      enrollmentKey,
      anchorData,
      EXCLUSION_REASONS.NO_CUSTOMER_RECORD,
      'No customer record found in directory'
    );
    return {
      enrolled: false,
      excluded: true,
      exclusionReason: EXCLUSION_REASONS.NO_CUSTOMER_RECORD,
      message: 'Excluded: customer record does not exist',
    };
  }

  if (customer.status === 'DELETED' || customer.deletedAt != null) {
    await recordExcludedEnrollment(
      tenantId,
      campaignId,
      version,
      customerId,
      occurrenceId,
      enrollmentKey,
      anchorData,
      EXCLUSION_REASONS.CUSTOMER_DELETED,
      'Customer record is deleted'
    );
    return {
      enrolled: false,
      excluded: true,
      exclusionReason: EXCLUSION_REASONS.CUSTOMER_DELETED,
      message: 'Excluded: customer is deleted',
    };
  }

  if (!customer.destination?.encryptedPhone || !customer.destination.destinationHash) {
    await recordExcludedEnrollment(
      tenantId,
      campaignId,
      version,
      customerId,
      occurrenceId,
      enrollmentKey,
      anchorData,
      EXCLUSION_REASONS.INVALID_DESTINATION,
      'Customer missing phone destination'
    );
    return {
      enrolled: false,
      excluded: true,
      exclusionReason: EXCLUSION_REASONS.INVALID_DESTINATION,
      message: 'Excluded: invalid destination',
    };
  }

  // 5. Load tenant campaign settings early for destination checks & timing
  const settings = await campaignSettingsService.getSettings(tenantId);
  const minVerification = settings?.minDestinationVerification || 'CONFIRMED_BY_STAFF';

  // Destination Verification Level Gate (Spec p10, p20, F19b v2)
  if (!isDestinationVerified(customer.destination, minVerification)) {
    await recordExcludedEnrollment(
      tenantId,
      campaignId,
      version,
      customerId,
      occurrenceId,
      enrollmentKey,
      anchorData,
      EXCLUSION_REASONS.DESTINATION_NOT_VERIFIED,
      `Destination verification level (${customer.destination?.verificationLevel || 'UNVERIFIED'}) does not meet required '${minVerification}'`
    );
    return {
      enrolled: false,
      excluded: true,
      exclusionReason: EXCLUSION_REASONS.DESTINATION_NOT_VERIFIED,
      message: 'Excluded: destination not verified',
    };
  }

  // Destination Health Gate (Spec p20, F19b v2)
  const destGate = await contactGateService.getGate(tenantId, customer.destination.destinationHash);
  if (contactGateService.isHealthUndeliverable(destGate, customer.destination.verifiedAt)) {
    await recordExcludedEnrollment(
      tenantId,
      campaignId,
      version,
      customerId,
      occurrenceId,
      enrollmentKey,
      anchorData,
      EXCLUSION_REASONS.DESTINATION_UNDELIVERABLE,
      `Destination is marked UNDELIVERABLE (${destGate?.health?.reason || 'Not on WhatsApp'})`
    );
    return {
      enrolled: false,
      excluded: true,
      exclusionReason: EXCLUSION_REASONS.DESTINATION_UNDELIVERABLE,
      message: 'Excluded: destination undeliverable',
    };
  }

  if (customer.consent?.channelSuppressed === true) {
    await recordExcludedEnrollment(
      tenantId,
      campaignId,
      version,
      customerId,
      occurrenceId,
      enrollmentKey,
      anchorData,
      EXCLUSION_REASONS.CHANNEL_SUPPRESSED,
      'Customer destination is channel suppressed'
    );
    return {
      enrolled: false,
      excluded: true,
      exclusionReason: EXCLUSION_REASONS.CHANNEL_SUPPRESSED,
      message: 'Excluded: channel suppressed',
    };
  }

  if (customer.consent?.marketingOptIn === false || customer.status === 'OPTED_OUT') {
    await recordExcludedEnrollment(
      tenantId,
      campaignId,
      version,
      customerId,
      occurrenceId,
      enrollmentKey,
      anchorData,
      EXCLUSION_REASONS.NO_MARKETING_CONSENT,
      'Customer has not recorded marketing opt-in'
    );
    return {
      enrolled: false,
      excluded: true,
      exclusionReason: EXCLUSION_REASONS.NO_MARKETING_CONSENT,
      message: 'Excluded: no marketing consent',
    };
  }

  // Branch Scope Check
  if (
    campaign.enabledBranches &&
    campaign.enabledBranches.length > 0 &&
    anchorData.branchId &&
    !campaign.enabledBranches.includes(anchorData.branchId)
  ) {
    await recordExcludedEnrollment(
      tenantId,
      campaignId,
      version,
      customerId,
      occurrenceId,
      enrollmentKey,
      anchorData,
      EXCLUSION_REASONS.BRANCH_NOT_ENABLED,
      `Branch '${anchorData.branchId}' not in campaign enabledBranches`
    );
    return {
      enrolled: false,
      excluded: true,
      exclusionReason: EXCLUSION_REASONS.BRANCH_NOT_ENABLED,
      message: 'Excluded: branch not enabled for campaign',
    };
  }

  // Part A specific checks: repeat customer exclusions
  const isRepeatPurchase = occurrenceId.startsWith('repeat:');
  if (isRepeatPurchase) {
    const facts: any = await CampaignCustomerFactModel.findOne({ tenantId, customerId }).lean();
    if (facts && (facts.maxQualifyingOrderCountSeen ?? 0) >= 2) {
      await recordExcludedEnrollment(
        tenantId,
        campaignId,
        version,
        customerId,
        occurrenceId,
        enrollmentKey,
        anchorData,
        EXCLUSION_REASONS.ALREADY_REPEAT_CUSTOMER,
        'Customer already completed 2 or more qualifying purchases previously'
      );
      return {
        enrolled: false,
        excluded: true,
        exclusionReason: EXCLUSION_REASONS.ALREADY_REPEAT_CUSTOMER,
        message: 'Excluded: ALREADY_REPEAT_CUSTOMER',
      };
    }
    if (facts && facts.qualifyingOrderCount > 1) {
      await recordExcludedEnrollment(
        tenantId,
        campaignId,
        version,
        customerId,
        occurrenceId,
        enrollmentKey,
        anchorData,
        EXCLUSION_REASONS.MULTIPLE_QUALIFYING_ORDERS,
        'Customer has multiple qualifying orders'
      );
      return {
        enrolled: false,
        excluded: true,
        exclusionReason: EXCLUSION_REASONS.MULTIPLE_QUALIFYING_ORDERS,
        message: 'Excluded: MULTIPLE_QUALIFYING_ORDERS',
      };
    }
  }

  // Minimum first order amount check (Spec p14, F19b v2)
  if (version.minFirstOrderNetPaise && version.minFirstOrderNetPaise > 0 && anchorData?.orderId) {
    const net =
      anchorData.netPaise !== undefined
        ? anchorData.netPaise
        : (anchorData.grossPaise || 0) - (anchorData.refundedPaise || 0);
    if (net < version.minFirstOrderNetPaise) {
      await recordExcludedEnrollment(
        tenantId,
        campaignId,
        version,
        customerId,
        occurrenceId,
        enrollmentKey,
        anchorData,
        EXCLUSION_REASONS.FIRST_ORDER_BELOW_MINIMUM,
        `First order net amount (${net}) is below campaign minimum (${version.minFirstOrderNetPaise})`
      );
      return {
        enrolled: false,
        excluded: true,
        exclusionReason: EXCLUSION_REASONS.FIRST_ORDER_BELOW_MINIMUM,
        message: 'Excluded: FIRST_ORDER_BELOW_MINIMUM',
      };
    }
  }

  // 4. Once-per-customer rule (Rule 2, Spec p20 logic)
  // "if an earlier enrollment of THIS campaign for the customer has an execution that is
  // accepted/unknown/delivered/read, a new occurrence is EXCLUDED with ALREADY_WELCOMED / ALREADY_NUDGED / ALREADY_CONFIRMED.
  // Earlier occurrences with only cancelled or skipped executions do not block."
  const campaignScope = version.scope || campaign.scope || 'PER_CUSTOMER';
  const priorQuery: any = {
    tenantId,
    campaignId,
    customerId,
  };
  if (campaignScope === 'PER_CUSTOMER_PER_BRANCH' && anchorData?.branchId) {
    priorQuery.branchId = anchorData.branchId;
  }

  const priorEnrollments = await CampaignEnrollmentModel.find(priorQuery).lean();

  if (priorEnrollments.length > 0) {
    const priorEnrollmentIds = priorEnrollments.map((e) => e.enrollmentId);
    const qualifyingPriorExecutions = await CampaignExecutionModel.findOne({
      tenantId,
      enrollmentId: { $in: priorEnrollmentIds },
      state: {
        $in: [
          EXECUTION_STATE.PROVIDER_ACCEPTED,
          EXECUTION_STATE.SENT,
          EXECUTION_STATE.DELIVERED,
          EXECUTION_STATE.READ,
          EXECUTION_STATE.OUTCOME_UNKNOWN,
          EXECUTION_STATE.FAILED,
        ],
      },
    });

    if (qualifyingPriorExecutions) {
      const exclusionReason = isRepeatPurchase
        ? EXCLUSION_REASONS.ALREADY_NUDGED
        : occurrenceId.startsWith('cashbackconfirm:')
        ? EXCLUSION_REASONS.ALREADY_CONFIRMED
        : EXCLUSION_REASONS.ALREADY_WELCOMED;

      const explanation = isRepeatPurchase
        ? 'Customer was already nudged in an earlier occurrence'
        : occurrenceId.startsWith('cashbackconfirm:')
        ? 'Cashback confirmation was already sent in an earlier occurrence'
        : 'Customer was already welcomed in an earlier occurrence';

      await recordExcludedEnrollment(
        tenantId,
        campaignId,
        version,
        customerId,
        occurrenceId,
        enrollmentKey,
        anchorData,
        exclusionReason,
        explanation
      );
      return {
        enrolled: false,
        excluded: true,
        exclusionReason,
        message: `Excluded: ${exclusionReason}`,
      };
    }
  }

  // 5. Build enrollment ID and explanation
  const enrollmentId = `enr_${crypto.randomUUID().slice(0, 12)}`;

  let explanation = '';
  let anchorAt = now;
  let sourceRef: any = { type: 'SRC_CUSTOMERS', id: customerId, version: 1 };
  let firstOrderId: string | null = null;
  let firstOrderNumber: string | null = null;
  let firstOrderNetPaise: number | null = null;
  let creditId: string | null = null;
  let creditSnapshot: any = null;

  if (isRepeatPurchase) {
    firstOrderId = anchorData.orderId;
    firstOrderNumber = anchorData.orderNumber || anchorData.orderId;
    firstOrderNetPaise = anchorData.netPaise;
    anchorAt = new Date(anchorData.completedAt || anchorData.occurredAt || now);
    sourceRef = {
      type: 'SRC_ORDERS',
      id: anchorData.orderId,
      version: anchorData.entityVersion || 1,
    };
    explanation = `first qualifying order ${firstOrderNumber}; opted in`;
  } else if (occurrenceId.startsWith('cashbackconfirm:') || occurrenceId.startsWith('credit:')) {
    creditId = anchorData.creditId;
    creditSnapshot = {
      unit: anchorData.unit,
      amount: anchorData.amount,
      expiresAt: anchorData.expiresAt,
      version: anchorData.entityVersion || 1,
    };
    anchorAt = new Date(anchorData.issuedAt || anchorData.occurredAt || now);
    sourceRef = {
      type: 'SRC_CREDITS',
      id: anchorData.creditId,
      version: anchorData.entityVersion || 1,
    };
    explanation = `reward credit ${creditId} issued; opted in`;
  } else {
    firstOrderId = anchorData.orderId;
    firstOrderNumber = anchorData.orderNumber || anchorData.orderId;
    firstOrderNetPaise = anchorData.netPaise;
    anchorAt = new Date(anchorData.completedAt || anchorData.occurredAt || now);
    sourceRef = {
      type: 'SRC_ORDERS',
      id: anchorData.orderId,
      version: anchorData.entityVersion || 1,
    };
    explanation = `first qualifying order ${firstOrderNumber}; opted in`;
  }

  // 6. Create ACTIVE Enrollment
  await CampaignEnrollmentModel.create({
    enrollmentId,
    enrollmentKey,
    tenantId,
    campaignId,
    campaignVersionId: version.id || (version as any)._id?.toString() || 'v1',
    campaignVersion: version.version,
    customerId,
    occurrenceId,
    sourceRef,
    occasionLocalDate:
      anchorData?.localDate ||
      DateTime.fromJSDate(anchorAt, { zone: version.timezone || 'Asia/Kolkata' }).toISODate()!,
    planRevision: 1,
    status: ENROLLMENT_STATUS.ACTIVE,
    matchExplanation: explanation,
    anchorAt,
    firstOrderId,
    firstOrderNumber,
    firstOrderNetPaise,
    anchorOrderId: firstOrderId || null,
    scope: campaignScope,
    branchId: anchorData.branchId || null,
    creditId,
    creditSnapshot,
    destinationHash: customer.destination?.destinationHash || null,
  });

  // 7. Generate Step Executions using delayTiming
  const executionIds: string[] = [];
  const steps = version.steps || [];

  for (const step of steps) {
    const delay = (step as any).delay || { unit: 'HOURS', value: 1 };
    const outsideHoursPolicy = (step as any).outsideHoursPolicy || 'DEFER_NEXT_DAY';
    const maxDeferralHours = (step as any).maxDeferralHours ?? 24;
    const maxLatenessMinutes = step.maxLatenessMinutes ?? 180;

    // Fetch offer validity if offerRef is present
    let offerValidUntil: Date | undefined;
    if ((step as any).offerRef?.offerId) {
      const offer = await mockOfferSource.getOfferById(tenantId, (step as any).offerRef.offerId);
      if (offer?.validUntil) {
        offerValidUntil = new Date(offer.validUntil);
      }
    }

    // Fetch credit validity / expiry if creditRef is present
    let creditExpiresAt: Date | undefined;
    if ((step as any).creditRef) {
      const creditRef = (step as any).creditRef;
      if (creditRef.creditId) {
        const cr = await mockCreditSource.getCredit(tenantId, creditRef.creditId);
        if (cr?.expiresAt) creditExpiresAt = new Date(cr.expiresAt);
      } else if (firstOrderId) {
        const crs = await mockCreditSource.listCreditsForCustomer(tenantId, customerId);
        const cr = crs.find((c) => c.sourceOrderId === firstOrderId || c.reason === 'FIRST_ORDER_REWARD');
        if (cr?.expiresAt) creditExpiresAt = new Date(cr.expiresAt);
      }
    } else if (anchorData.expiresAt) {
      creditExpiresAt = new Date(anchorData.expiresAt);
    }

    const timing = computeDueTimes(
      anchorAt,
      delay,
      settings,
      {
        outsideHoursPolicy,
        maxDeferralHours,
        maxLatenessMinutes,
      },
      {
        campaignEndAt: campaign.endAt ? new Date(campaign.endAt) : null,
        offerValidUntil,
        creditExpiresAt,
        now,
      }
    );

    // Initial state determination
    let initialState: any = EXECUTION_STATE.SCHEDULED;
    let initialSkipReason: string | null = null;
    let initialDeferralReason: string | null = null;

    if (timing.skipReason) {
      initialState = EXECUTION_STATE.SKIPPED;
      initialSkipReason = timing.skipReason;
    } else if (timing.isOutsideHours && outsideHoursPolicy === 'DEFER_NEXT_DAY') {
      initialState = EXECUTION_STATE.DEFERRED;
      initialDeferralReason = timing.deferralReason || 'OUTSIDE_SENDING_HOURS';
    }

    const executionId = `exec_${crypto.randomUUID().slice(0, 12)}`;
    const executionKey = `${enrollmentId}:${step.stepId}`;
    const relativeToAnchorHours =
      delay.unit === 'MINUTES' ? delay.value / 60 : delay.unit === 'DAYS' ? delay.value * 24 : delay.value;

    await CampaignExecutionModel.create({
      executionId,
      executionKey,
      tenantId,
      campaignId,
      enrollmentId,
      stepId: step.stepId,
      stepName: step.stepName || 'Campaign Step',
      dueAt: timing.adjustedDueAt,
      originalDueAt: timing.rawDueAt,
      rawDueAt: timing.rawDueAt,
      adjustedDueAt: timing.adjustedDueAt,
      expiresAt: timing.expiresAt,
      delaySpec: delay,
      deferralReason: initialDeferralReason,
      offerRef: (step as any).offerRef || null,
      creditRef: (step as any).creditRef || null,
      orderRef: firstOrderId || null,
      relativeToAnchorHours,
      localDate: timing.adjustedLocalDate,
      localTime: timing.adjustedLocalTime,
      timezone: timing.timezone,
      planRevision: 1,
      state: initialState,
      skipReason: initialSkipReason,
      prerequisite: step.prerequisite || 'NONE',
      templateRef: step.templateRef || null,
    });

    executionIds.push(executionId);
  }

  logger.info(
    {
      tenantId,
      campaignId,
      customerId,
      occurrenceId,
      enrollmentId,
      executionCount: executionIds.length,
    },
    'Successfully enrolled customer for event delay campaign'
  );

  return {
    enrolled: true,
    excluded: false,
    enrollmentId,
    executionIds,
    message: 'Enrolled successfully',
  };
}

async function recordExcludedEnrollment(
  tenantId: string,
  campaignId: string,
  version: ICampaignVersion,
  customerId: string,
  occurrenceId: string,
  enrollmentKey: string,
  anchorData: any,
  exclusionReason: string,
  explanation: string
): Promise<void> {
  const enrollmentId = `enr_${crypto.randomUUID().slice(0, 12)}`;
  let sourceRef: any = { type: 'SRC_CUSTOMERS', id: customerId, version: 1 };
  let firstOrderId: string | null = null;
  let firstOrderNumber: string | null = null;
  let firstOrderNetPaise: number | null = null;
  let creditId: string | null = null;
  let anchorAt = clock.now();

  if (occurrenceId.startsWith('repeat:') || anchorData?.orderId) {
    firstOrderId = anchorData.orderId;
    firstOrderNumber = anchorData.orderNumber || anchorData.orderId;
    firstOrderNetPaise = anchorData.netPaise;
    anchorAt = new Date(anchorData.completedAt || anchorData.occurredAt || anchorAt);
    sourceRef = {
      type: 'SRC_ORDERS',
      id: anchorData.orderId,
      version: anchorData.entityVersion || 1,
    };
  } else if (occurrenceId.startsWith('cashbackconfirm:') || anchorData?.creditId) {
    creditId = anchorData.creditId;
    anchorAt = new Date(anchorData.issuedAt || anchorData.occurredAt || anchorAt);
    sourceRef = {
      type: 'SRC_CREDITS',
      id: anchorData.creditId,
      version: anchorData.entityVersion || 1,
    };
  }

  await CampaignEnrollmentModel.create({
    enrollmentId,
    enrollmentKey,
    tenantId,
    campaignId,
    campaignVersionId: version.id || (version as any)._id?.toString() || 'v1',
    campaignVersion: version.version,
    customerId,
    occurrenceId,
    sourceRef,
    occasionLocalDate:
      anchorData?.localDate ||
      DateTime.fromJSDate(anchorAt, { zone: version.timezone || 'Asia/Kolkata' }).toISODate()!,
    planRevision: 1,
    status: (ENROLLMENT_STATUS as any).EXCLUDED,
    exclusionReason,
    matchExplanation: explanation,
    anchorAt,
    firstOrderId,
    firstOrderNumber,
    firstOrderNetPaise,
    creditId,
  });
}

export interface EventDelayCandidateEvaluation {
  eligible: boolean;
  reason?: string;
  explanation?: string;
}

export async function evaluateCandidateForEventDelay(
  tenantId: string,
  customer: any,
  facts: any,
  campaignVersion: any,
  settings: any,
  anchorData?: any
): Promise<EventDelayCandidateEvaluation> {
  if (!customer) {
    return { eligible: false, reason: EXCLUSION_REASONS.NO_CUSTOMER_RECORD, explanation: 'No customer record found' };
  }
  if (customer.status === 'DELETED' || customer.deletedAt != null) {
    return { eligible: false, reason: EXCLUSION_REASONS.CUSTOMER_DELETED, explanation: 'Customer record is deleted' };
  }
  if (customer.consent?.marketingOptIn !== true) {
    return { eligible: false, reason: EXCLUSION_REASONS.NO_MARKETING_CONSENT, explanation: 'Customer has not granted marketing consent' };
  }
  if (customer.consent?.channelSuppressed === true) {
    return { eligible: false, reason: EXCLUSION_REASONS.CHANNEL_SUPPRESSED, explanation: 'Customer destination is channel suppressed' };
  }


  const presetId = campaignVersion?.presetId || '';
  const isRepeatPurchase =
    presetId === 'FIRST_TO_SECOND_PURCHASE' ||
    presetId === 'first_to_second_purchase' ||
    presetId === 'second_purchase' ||
    presetId === 'first-repeat' ||
    campaignVersion?.trigger?.anchor === 'FIRST_QUALIFYING_ORDER';

  if (isRepeatPurchase) {
    if (!facts || facts.qualifyingOrderCount === 0) {
      return { eligible: false, reason: 'NO_QUALIFYING_ORDER', explanation: 'No qualifying order recorded' };
    }
    if ((facts.maxQualifyingOrderCountSeen ?? 0) >= 2 || facts.qualifyingOrderCount >= 2) {
      return { eligible: false, reason: EXCLUSION_REASONS.ALREADY_REPEAT_CUSTOMER, explanation: 'Customer has previously completed 2 or more qualifying orders' };
    }
  }

  if (campaignVersion?.campaignId) {
    const existing = await CampaignEnrollmentModel.findOne({
      tenantId,
      campaignId: campaignVersion.campaignId,
      customerId: customer.customerId,
      status: { $in: [ENROLLMENT_STATUS.COMPLETED, ENROLLMENT_STATUS.ACTIVE] },
    });
    if (existing) {
      const exclusionReason = isRepeatPurchase ? EXCLUSION_REASONS.ALREADY_NUDGED : EXCLUSION_REASONS.ALREADY_WELCOMED;
      return { eligible: false, reason: exclusionReason, explanation: `Customer has already been processed previously (${exclusionReason})` };
    }
  }

  const branchId = anchorData?.branchId || customer?.branchId;
  if (branchId && campaignVersion?.enabledBranches && campaignVersion.enabledBranches.length > 0) {
    if (!campaignVersion.enabledBranches.includes(branchId)) {
      return { eligible: false, reason: EXCLUSION_REASONS.BRANCH_NOT_ENABLED, explanation: 'Branch is not enabled for this campaign' };
    }
  }

  if (customer.destination?.destinationHash && campaignVersion?.campaignId) {
    const activeDestHolding = await CampaignEnrollmentModel.findOne({
      tenantId,
      campaignId: campaignVersion.campaignId,
      destinationHash: customer.destination.destinationHash,
      status: ENROLLMENT_STATUS.ACTIVE,
      customerId: { $ne: customer.customerId },
    });
    if (activeDestHolding) {
      return { eligible: false, reason: EXCLUSION_REASONS.DUPLICATE_DESTINATION, explanation: 'Another customer with this phone number is currently active in this campaign' };
    }
  }

  if (customer.destination) {
    const minVerification = settings?.minDestinationVerification || 'CONFIRMED_BY_STAFF';
    if (!isDestinationVerified(customer.destination, minVerification)) {
      return {
        eligible: false,
        reason: EXCLUSION_REASONS.DESTINATION_NOT_VERIFIED,
        explanation: `Destination verification level does not meet required '${minVerification}'`,
      };
    }

    if (customer.destination.destinationHash) {
      const destGate = await contactGateService.getGate(tenantId, customer.destination.destinationHash);
      if (contactGateService.isHealthUndeliverable(destGate, customer.destination.verifiedAt)) {
        return {
          eligible: false,
          reason: EXCLUSION_REASONS.DESTINATION_UNDELIVERABLE,
          explanation: 'Destination is marked UNDELIVERABLE',
        };
      }
    }
  }

  if (campaignVersion?.minFirstOrderNetPaise && campaignVersion.minFirstOrderNetPaise > 0) {
    const netPaise = anchorData?.netPaise ?? anchorData?.order?.netPaise ?? 0;
    if (netPaise < campaignVersion.minFirstOrderNetPaise) {
      return {
        eligible: false,
        reason: EXCLUSION_REASONS.FIRST_ORDER_BELOW_MINIMUM,
        explanation: `First order net amount (${netPaise}) is below campaign minimum (${campaignVersion.minFirstOrderNetPaise})`,
      };
    }
  }

  return { eligible: true };
}

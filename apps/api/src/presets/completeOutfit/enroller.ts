import crypto from 'crypto';
import {
  ENROLLMENT_STATUS,
  EXECUTION_STATE,
  ExecutionState,
  EXECUTION_REASONS,
  EXCLUSION_REASONS,
  SourceCustomer,
  SourceOrder,
  OrderLine,
  SourceProduct,
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
import { mockProductSource } from '../../adapters/product-source';
import { campaignSettingsService } from '../../services/campaign-settings.service';
import { contactGateService } from '../../services/contact-gate/contact-gate.service';
import { computeDueTimes } from '../_shared/eventDelay/delayTiming';
import { isQualifyingOrder } from '../_shared/orderTrigger/qualifying';
import { DEFAULT_OUTFIT_PAIRING } from './definition';
import { clock } from '../../services/clock';
import { logger } from '../../logger';

export interface OutfitEnrollmentResult {
  enrolled: boolean;
  excluded: boolean;
  exclusionReason?: string;
  enrollmentId?: string;
  executionIds?: string[];
  message: string;
}

export async function enrollCompleteOutfitOccurrence(
  tenantId: string,
  campaignId: string,
  customerId: string | null | undefined,
  order: SourceOrder | any,
  activeVersionOverride?: ICampaignVersion
): Promise<OutfitEnrollmentResult> {
  // 1. Customer identity check (Hard Rule 7, Spec p10, p24)
  if (!customerId || typeof customerId !== 'string' || !customerId.trim()) {
    return {
      enrolled: false,
      excluded: true,
      exclusionReason: EXCLUSION_REASONS.NO_CUSTOMER_IDENTITY,
      message: 'Excluded: customer identity is missing',
    };
  }

  // 2. Qualifying order check (Spec p14: paid, completed, positive net amount)
  if (!isQualifyingOrder(order)) {
    return {
      enrolled: false,
      excluded: false,
      message: `Order '${order.orderId}' does not qualify`,
    };
  }

  const now = clock.now();

  // 3. Load Campaign & Active Published Version
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
    const orderCompletedTime = order.completedAt ? new Date(order.completedAt).getTime() : now.getTime();
    if (now.getTime() >= endAtTime || orderCompletedTime >= endAtTime) {
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

  const occurrenceId = `outfit:${order.orderId}`;
  const enrollmentKey = `${tenantId}:${campaignId}:${customerId}:${occurrenceId}`;

  // 4. Check if this exact occurrence is already enrolled or excluded
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
      exclusionReason: existingEnrollment.exclusionReason || undefined,
      enrollmentId: existingEnrollment.enrollmentId,
      message: 'Occurrence already processed',
    };
  }

  // 5. Anchor line discovery & primary anchor selection (Part 1 item 5)
  const pairing = version.pairing || DEFAULT_OUTFIT_PAIRING;
  const anchorCategories = (pairing.anchorCategories || ['saree']).map((c: string) => c.toLowerCase());

  interface EligibleAnchor {
    line: OrderLine;
    product: SourceProduct;
    lineNetPaise: number;
  }

  const eligibleAnchors: EligibleAnchor[] = [];

  for (const line of order.lines || []) {
    const qty = line.qty ?? line.quantity ?? 1;
    const returnedQty = line.returnedQty ?? 0;
    if (returnedQty >= qty) {
      // Line is fully returned
      continue;
    }
    if (!line.productId) {
      continue;
    }

    const prod = await mockProductSource.getProduct(tenantId, line.productId);
    if (!prod || !prod.category) {
      continue;
    }

    if (anchorCategories.includes(prod.category.toLowerCase())) {
      const netPaise =
        line.lineNetPaise !== undefined
          ? line.lineNetPaise
          : (line.pricePaise || 0) * (qty - returnedQty);
      eligibleAnchors.push({
        line,
        product: prod,
        lineNetPaise: netPaise,
      });
    }
  }

  if (eligibleAnchors.length === 0) {
    await recordExcludedOutfitEnrollment({
      tenantId,
      campaignId,
      version,
      customerId,
      occurrenceId,
      enrollmentKey,
      order,
      exclusionReason: EXCLUSION_REASONS.NO_ANCHOR_LINE,
      explanation: 'Order has no non-returned line in configured anchor categories',
    });
    return {
      enrolled: false,
      excluded: true,
      exclusionReason: EXCLUSION_REASONS.NO_ANCHOR_LINE,
      message: 'Excluded: order has no eligible anchor line',
    };
  }

  // Primary anchor line = highest lineNetPaise, tie: lowest lineId
  eligibleAnchors.sort((a, b) => {
    if (b.lineNetPaise !== a.lineNetPaise) {
      return b.lineNetPaise - a.lineNetPaise;
    }
    return a.line.lineId.localeCompare(b.line.lineId);
  });

  const primaryAnchor = eligibleAnchors[0];

  // 6. Load Customer & Mandatory Platform Gates (Spec p10, Rule 6)
  const customer = await mockCustomerSource.getCustomerById(tenantId, customerId);

  if (!customer) {
    await recordExcludedOutfitEnrollment({
      tenantId,
      campaignId,
      version,
      customerId,
      occurrenceId,
      enrollmentKey,
      order,
      exclusionReason: EXCLUSION_REASONS.NO_CUSTOMER_RECORD,
      explanation: 'No customer record found in directory',
    });
    return {
      enrolled: false,
      excluded: true,
      exclusionReason: EXCLUSION_REASONS.NO_CUSTOMER_RECORD,
      message: 'Excluded: customer record does not exist',
    };
  }

  if (customer.status === 'DELETED' || customer.deletedAt != null) {
    await recordExcludedOutfitEnrollment({
      tenantId,
      campaignId,
      version,
      customerId,
      occurrenceId,
      enrollmentKey,
      order,
      exclusionReason: EXCLUSION_REASONS.CUSTOMER_DELETED,
      explanation: 'Customer record is deleted',
    });
    return {
      enrolled: false,
      excluded: true,
      exclusionReason: EXCLUSION_REASONS.CUSTOMER_DELETED,
      message: 'Excluded: customer is deleted',
    };
  }

  if (!customer.destination?.encryptedPhone || !customer.destination.destinationHash) {
    await recordExcludedOutfitEnrollment({
      tenantId,
      campaignId,
      version,
      customerId,
      occurrenceId,
      enrollmentKey,
      order,
      exclusionReason: EXCLUSION_REASONS.INVALID_DESTINATION,
      explanation: 'Customer missing phone destination',
    });
    return {
      enrolled: false,
      excluded: true,
      exclusionReason: EXCLUSION_REASONS.INVALID_DESTINATION,
      message: 'Excluded: invalid destination',
    };
  }

  const settings = await campaignSettingsService.getSettings(tenantId);
  const minVerification = settings?.minDestinationVerification || 'CONFIRMED_BY_STAFF';

  if (!isDestinationVerified(customer.destination, minVerification)) {
    await recordExcludedOutfitEnrollment({
      tenantId,
      campaignId,
      version,
      customerId,
      occurrenceId,
      enrollmentKey,
      order,
      exclusionReason: EXCLUSION_REASONS.DESTINATION_NOT_VERIFIED,
      explanation: `Destination verification level (${customer.destination?.verificationLevel || 'UNVERIFIED'}) does not meet required '${minVerification}'`,
    });
    return {
      enrolled: false,
      excluded: true,
      exclusionReason: EXCLUSION_REASONS.DESTINATION_NOT_VERIFIED,
      message: 'Excluded: destination not verified',
    };
  }

  const destGate = await contactGateService.getGate(tenantId, customer.destination.destinationHash);
  if (contactGateService.isHealthUndeliverable(destGate, customer.destination.verifiedAt)) {
    await recordExcludedOutfitEnrollment({
      tenantId,
      campaignId,
      version,
      customerId,
      occurrenceId,
      enrollmentKey,
      order,
      exclusionReason: EXCLUSION_REASONS.DESTINATION_UNDELIVERABLE,
      explanation: `Destination is marked UNDELIVERABLE (${destGate?.health?.reason || 'Not on WhatsApp'})`,
    });
    return {
      enrolled: false,
      excluded: true,
      exclusionReason: EXCLUSION_REASONS.DESTINATION_UNDELIVERABLE,
      message: 'Excluded: destination undeliverable',
    };
  }

  if (customer.consent?.channelSuppressed === true) {
    await recordExcludedOutfitEnrollment({
      tenantId,
      campaignId,
      version,
      customerId,
      occurrenceId,
      enrollmentKey,
      order,
      exclusionReason: EXCLUSION_REASONS.CHANNEL_SUPPRESSED,
      explanation: 'Customer destination is channel suppressed',
    });
    return {
      enrolled: false,
      excluded: true,
      exclusionReason: EXCLUSION_REASONS.CHANNEL_SUPPRESSED,
      message: 'Excluded: channel suppressed',
    };
  }

  if (customer.consent?.marketingOptIn === false || customer.status === 'OPTED_OUT') {
    await recordExcludedOutfitEnrollment({
      tenantId,
      campaignId,
      version,
      customerId,
      occurrenceId,
      enrollmentKey,
      order,
      exclusionReason: EXCLUSION_REASONS.NO_MARKETING_CONSENT,
      explanation: 'Customer has not recorded marketing opt-in',
    });
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
    order.branchId &&
    !campaign.enabledBranches.includes(order.branchId)
  ) {
    await recordExcludedOutfitEnrollment({
      tenantId,
      campaignId,
      version,
      customerId,
      occurrenceId,
      enrollmentKey,
      order,
      exclusionReason: EXCLUSION_REASONS.BRANCH_NOT_ENABLED,
      explanation: `Branch '${order.branchId}' not in campaign enabledBranches`,
    });
    return {
      enrolled: false,
      excluded: true,
      exclusionReason: EXCLUSION_REASONS.BRANCH_NOT_ENABLED,
      message: 'Excluded: branch not enabled for campaign',
    };
  }

  // 7. Spacing Rule (Part 1 item 5):
  // If an earlier enrollment of THIS campaign for the customer has an execution
  // accepted/unknown/delivered/read within minDaysBetweenEnrollments of this order's completedAt -> EXCLUDED RECENTLY_SUGGESTED
  const minDays = version.minDaysBetweenEnrollments ?? 30;
  if (minDays > 0) {
    const orderCompletedTime = order.completedAt ? new Date(order.completedAt).getTime() : now.getTime();
    const spacingWindowMs = minDays * 24 * 60 * 60 * 1000;

    const priorEnrollments = await CampaignEnrollmentModel.find({
      tenantId,
      campaignId,
      customerId,
      occurrenceId: { $ne: occurrenceId },
    }).lean();

    if (priorEnrollments.length > 0) {
      const priorEnrollmentIds = priorEnrollments.map((e) => e.enrollmentId);
      const priorExecutions = await CampaignExecutionModel.find({
        tenantId,
        enrollmentId: { $in: priorEnrollmentIds },
        state: {
          $in: [
            EXECUTION_STATE.PROVIDER_ACCEPTED,
            EXECUTION_STATE.SENT,
            EXECUTION_STATE.DELIVERED,
            EXECUTION_STATE.READ,
            EXECUTION_STATE.OUTCOME_UNKNOWN,
          ],
        },
      }).lean();

      for (const exec of priorExecutions) {
        const execTime = (exec.sentAt || exec.deliveredAt || exec.readAt || exec.dueAt || exec.createdAt)
          ? new Date(exec.sentAt || exec.deliveredAt || exec.readAt || exec.dueAt || exec.createdAt).getTime()
          : 0;

        // Was there an accepted/delivered/read message within minDays?
        if (execTime > 0 && Math.abs(orderCompletedTime - execTime) < spacingWindowMs) {
          await recordExcludedOutfitEnrollment({
            tenantId,
            campaignId,
            version,
            customerId,
            occurrenceId,
            enrollmentKey,
            order,
            exclusionReason: EXCLUSION_REASONS.RECENTLY_SUGGESTED,
            explanation: `Customer received outfit suggestion within ${minDays} days of order completion`,
          });
          return {
            enrolled: false,
            excluded: true,
            exclusionReason: EXCLUSION_REASONS.RECENTLY_SUGGESTED,
            message: 'Excluded: RECENTLY_SUGGESTED',
          };
        }
      }
    }
  }

  // 8. Audience Rules Evaluation
  if (version.audience?.mode === 'FILTERED' && Array.isArray(version.audience?.rules)) {
    const rules = version.audience.rules;
    for (const rule of rules) {
      if (rule.field === 'anchor.netPaise') {
        const op = rule.operator;
        const val = Number(rule.value);
        const anchorNet = primaryAnchor.lineNetPaise;
        let pass = true;
        if (op === 'gte') pass = anchorNet >= val;
        else if (op === 'gt') pass = anchorNet > val;
        else if (op === 'lte') pass = anchorNet <= val;
        else if (op === 'lt') pass = anchorNet < val;
        else if (op === 'eq') pass = anchorNet === val;

        if (!pass) {
          await recordExcludedOutfitEnrollment({
            tenantId,
            campaignId,
            version,
            customerId,
            occurrenceId,
            enrollmentKey,
            order,
            exclusionReason: EXCLUSION_REASONS.EXCLUDED_AUDIENCE_FILTER,
            explanation: `Anchor line net paise (${anchorNet}) does not satisfy audience rule ${op} ${val}`,
          });
          return {
            enrolled: false,
            excluded: true,
            exclusionReason: EXCLUSION_REASONS.EXCLUDED_AUDIENCE_FILTER,
            message: 'Excluded: audience filter',
          };
        }
      } else if (rule.field === 'anchor.category') {
        const op = rule.operator;
        const anchorCat = primaryAnchor.product.category?.toLowerCase() || '';
        let pass = true;
        if (op === 'in' && Array.isArray(rule.value)) {
          pass = rule.value.map((v: string) => v.toLowerCase()).includes(anchorCat);
        } else if (op === 'eq') {
          pass = anchorCat === String(rule.value).toLowerCase();
        }

        if (!pass) {
          await recordExcludedOutfitEnrollment({
            tenantId,
            campaignId,
            version,
            customerId,
            occurrenceId,
            enrollmentKey,
            order,
            exclusionReason: EXCLUSION_REASONS.EXCLUDED_AUDIENCE_FILTER,
            explanation: `Anchor category (${anchorCat}) does not satisfy audience rule`,
          });
          return {
            enrolled: false,
            excluded: true,
            exclusionReason: EXCLUSION_REASONS.EXCLUDED_AUDIENCE_FILTER,
            message: 'Excluded: audience filter',
          };
        }
      }
    }
  }

  // 9. Create Enrollment & Executions
  const enrollmentId = `enr_${crypto.randomUUID().slice(0, 12)}`;
  const anchorAt = order.completedAt ? new Date(order.completedAt) : now;
  const matchExplanation = `Complete the outfit suggestion for ${primaryAnchor.product.name}`;

  const steps = version.steps || [];
  const executionIds: string[] = [];
  const executionDocs: any[] = [];

  let previousAccepted = true;

  for (let idx = 0; idx < steps.length; idx++) {
    const step = steps[idx];
    const delaySpec = (step as any).delay || { unit: 'DAYS', value: 5 };

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

    // FUTURE_ONLY policy: if rawDueAt or adjustedDueAt is in the past relative to evaluation instant
    let stepState: ExecutionState = EXECUTION_STATE.SCHEDULED;
    let skipReason: string | null = null;

    if (timing.isElapsed || timing.adjustedDueAt.getTime() <= now.getTime()) {
      stepState = EXECUTION_STATE.SKIPPED;
      skipReason = EXECUTION_REASONS.SKIPPED_ELAPSED;
    } else if (step.prerequisite === 'PREVIOUS_ACCEPTED' && !previousAccepted) {
      stepState = EXECUTION_STATE.SKIPPED;
      skipReason = EXECUTION_REASONS.PREREQUISITE_NOT_MET;
    } else if (timing.isDeferred) {
      stepState = EXECUTION_STATE.DEFERRED;
    }

    if (stepState !== EXECUTION_STATE.SKIPPED) {
      previousAccepted = false; // Next prerequisite step will wait for this one to be accepted
    }

    executionDocs.push({
      executionId,
      executionKey: `${enrollmentId}:${step.stepId}`,
      tenantId,
      campaignId,
      enrollmentId,
      customerId,
      stepId: step.stepId,
      stepName: step.stepName,
      templateRef: step.templateRef,
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

  // Create enrollment record
  await CampaignEnrollmentModel.create({
    enrollmentId,
    enrollmentKey,
    tenantId,
    campaignId,
    campaignVersionId: version._id?.toString() || version.campaignVersionId || `ver_${campaignId}_${version.version}`,
    campaignVersion: version.version,
    customerId,
    occurrenceId,
    sourceRef: {
      type: 'SRC_ORDERS',
      id: order.orderId,
      version: order.entityVersion || 1,
    },
    occasionLocalDate: primaryAnchor.line.lineId,
    anchorAt,
    anchorOrderId: order.orderId,
    anchorLineId: primaryAnchor.line.lineId,
    anchorProductId: primaryAnchor.product.productId,
    anchorItemName: primaryAnchor.product.name,
    destinationHash: customer.destination.destinationHash,
    matchExplanation,
    goalMode: version.goalMode || 'COMPLEMENT_OR_TAGGED',
    status: ENROLLMENT_STATUS.ACTIVE,
    planRevision: 1,
  });

  if (executionDocs.length > 0) {
    await CampaignExecutionModel.insertMany(executionDocs);
  }

  return {
    enrolled: true,
    excluded: false,
    enrollmentId,
    executionIds,
    message: 'Enrolled successfully in Complete the Outfit campaign',
  };
}

async function recordExcludedOutfitEnrollment(params: {
  tenantId: string;
  campaignId: string;
  version: any;
  customerId: string;
  occurrenceId: string;
  enrollmentKey: string;
  order: any;
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
    order,
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
      campaignVersionId: version._id?.toString() || `ver_${campaignId}_${version.version}`,
      campaignVersion: version.version,
      customerId,
      occurrenceId,
      sourceRef: {
        type: 'SRC_ORDERS',
        id: order.orderId,
        version: order.entityVersion || 1,
      },
      occasionLocalDate: 'EXCLUDED',
      anchorAt: order.completedAt ? new Date(order.completedAt) : clock.now(),
      anchorOrderId: order.orderId,
      destinationHash: null,
      matchExplanation: explanation,
      status: ENROLLMENT_STATUS.EXCLUDED,
      exclusionReason,
      planRevision: 1,
    });
  } catch (err: any) {
    // If already exists with unique key, ignore duplicate
    if (err.code !== 11000) {
      logger.error({ err, tenantId, campaignId, occurrenceId }, 'Failed to record excluded outfit enrollment');
    }
  }
}

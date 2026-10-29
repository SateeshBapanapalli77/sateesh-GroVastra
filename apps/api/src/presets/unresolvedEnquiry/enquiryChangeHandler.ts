import mongoose from 'mongoose';
import {
  ENROLLMENT_STATUS,
  EXECUTION_STATE,
  EXECUTION_REASONS,
  SourceEnquiry,
} from '@grovastra/shared';
import {
  CampaignModel,
  CampaignVersionModel,
  CampaignEnrollmentModel,
  CampaignExecutionModel,
  CampaignDeliveryIntentModel,
} from '../../db/models';
import { campaignSettingsService } from '../../services/campaign-settings.service';
import { computeDueTimes } from '../_shared/eventDelay/delayTiming';
import { clock } from '../../services/clock';
import { logger } from '../../logger';

export interface EnquiryChangeResult {
  outcome: 'REPLANNED' | 'HELD' | 'CANCELLED' | 'IGNORED' | 'NO_OP';
  replannedCount?: number;
  heldCount?: number;
  cancelledCount?: number;
  reason?: string;
}

export async function handleEnquirySavedOrUpdated(
  tenantIdOrArgs: string | { tenantId: string; enquiry: SourceEnquiry },
  enquiryArg?: SourceEnquiry
): Promise<EnquiryChangeResult> {
  const tenantId = typeof tenantIdOrArgs === 'string' ? tenantIdOrArgs : tenantIdOrArgs.tenantId;
  const enquiry = typeof tenantIdOrArgs === 'string' ? enquiryArg! : tenantIdOrArgs.enquiry;
  const now = clock.now();
  const occurrenceId = `enquiry:${enquiry.enquiryId}`;

  // Find all active enrollments for this enquiry
  const enrollments = await CampaignEnrollmentModel.find({
    tenantId,
    occurrenceId,
    status: { $in: [ENROLLMENT_STATUS.ACTIVE, ENROLLMENT_STATUS.PAUSED] },
  });

  if (enrollments.length === 0) {
    return { outcome: 'NO_OP', reason: 'No active enrollments found for enquiry' };
  }

  // Check terminal statuses: RESOLVED, CLOSED, CANCELLED, DELETED
  const terminalStatuses = ['RESOLVED', 'CLOSED', 'CANCELLED', 'DELETED'];
  if (terminalStatuses.includes(enquiry.status)) {
    return handleEnquiryResolvedOrDeleted(tenantId, enquiry.enquiryId, enquiry.status);
  }

  let replannedCount = 0;
  let heldCount = 0;
  const settings = await campaignSettingsService.getSettings(tenantId);

  for (const enr of enrollments) {
    const campaign = (await CampaignModel.findOne({ tenantId, campaignId: enr.campaignId }).lean()) as any;
    if (!campaign || campaign.status !== 'ACTIVE') continue;

    const pinnedVersion = (await CampaignVersionModel.findOne({
      tenantId,
      campaignId: enr.campaignId,
      version: enr.campaignVersion,
    }).lean()) as any;
    if (!pinnedVersion) continue;

    // 1. Staff takeover check: false -> true sets hold; true -> false does NOT lift it
    if (enquiry.staffTakeover && enr.holdReason !== 'STAFF_TAKEOVER') {
      enr.replyHoldAt = now;
      enr.holdReason = 'STAFF_TAKEOVER';
      await enr.save();

      await CampaignExecutionModel.updateMany(
        {
          tenantId,
          enrollmentId: enr.enrollmentId,
          deliveryIntentId: null,
          state: { $in: [EXECUTION_STATE.SCHEDULED, EXECUTION_STATE.DEFERRED] },
        },
        {
          $set: {
            state: EXECUTION_STATE.SKIPPED,
            skipReason: EXECUTION_REASONS.STAFF_TAKEOVER,
          },
        }
      );
      heldCount++;
      continue;
    }

    // 2. Customer activity check: lastCustomerInteractionAt vs stored anchorAt
    const oldAnchor = enr.anchorAt ? new Date(enr.anchorAt) : new Date(enquiry.createdAt);
    const newAnchor = new Date(enquiry.lastCustomerInteractionAt);

    const anchorMoved = newAnchor.getTime() > oldAnchor.getTime();

    if (!anchorMoved) {
      // Record edit that did not change lastCustomerInteractionAt (notes, topic, status unchanged)
      // Changes NOTHING except stored version snapshot
      continue;
    }

    // Anchor moved! Check whether ANY step has already been accepted/delivered/read/outcome_unknown
    const allExecutions = await CampaignExecutionModel.find({
      tenantId,
      enrollmentId: enr.enrollmentId,
    });

    const hasSentOrAccepted = allExecutions.some((exe) =>
      [
        EXECUTION_STATE.PROVIDER_ACCEPTED,
        EXECUTION_STATE.SENT,
        EXECUTION_STATE.DELIVERED,
        EXECUTION_STATE.READ,
        EXECUTION_STATE.OUTCOME_UNKNOWN,
      ].includes(exe.state as any)
    );

    if (hasSentOrAccepted) {
      // Customer activity AFTER our nudge: set CUSTOMER_INTERACTION hold!
      // Remaining steps skipped while held; explicit resolve-hold lifts it
      enr.replyHoldAt = now;
      enr.holdReason = 'CUSTOMER_INTERACTION';
      await enr.save();

      await CampaignExecutionModel.updateMany(
        {
          tenantId,
          enrollmentId: enr.enrollmentId,
          deliveryIntentId: null,
          state: { $in: [EXECUTION_STATE.SCHEDULED, EXECUTION_STATE.DEFERRED] },
        },
        {
          $set: {
            state: EXECUTION_STATE.SKIPPED,
            skipReason: EXECUTION_REASONS.CUSTOMER_INTERACTION,
          },
        }
      );
      heldCount++;
      continue;
    }

    // NO execution was sent/accepted -> SAME occurrence, recompute all unsent executions
    const oldVersion = enr.planRevision || 1;
    const newVersion = oldVersion + 1;

    enr.anchorAt = newAnchor;
    enr.planRevision = newVersion;
    enr.anchorHistory = enr.anchorHistory || [];
    enr.anchorHistory.push({
      at: now,
      oldAnchor,
      newAnchor,
      oldVersion,
      newVersion,
    });
    await enr.save();

    const usefulForDays = enr.usefulForDays || pinnedVersion.trigger?.usefulForDays || 14;
    const maxUsefulAt = new Date(enquiry.createdAt.getTime() + usefulForDays * 24 * 60 * 60 * 1000);

    for (const exe of allExecutions) {
      if (exe.deliveryIntentId !== null) {
        // Frozen intent whose planned time changed becomes BLOCKED_STALE_INTENT
        const terminalStates = [
          EXECUTION_STATE.SENT,
          EXECUTION_STATE.DELIVERED,
          EXECUTION_STATE.READ,
          EXECUTION_STATE.PROVIDER_ACCEPTED,
        ];
        if (!terminalStates.includes(exe.state as any)) {
          await CampaignDeliveryIntentModel.updateOne(
            { tenantId, deliveryIntentId: exe.deliveryIntentId },
            { $set: { state: 'BLOCKED', failureReason: EXECUTION_REASONS.BLOCKED_STALE_INTENT } }
          );
          exe.state = EXECUTION_STATE.BLOCKED;
          exe.skipReason = EXECUTION_REASONS.BLOCKED_STALE_INTENT;
          await exe.save();
        }
      } else {
        // Unsent execution: recompute timing from the new anchor
        // Steps skipped for opt-out, goal, hold, cancellation or gates are never revived!
        const nonRevivableReasons = [
          EXECUTION_REASONS.MARKETING_OPT_OUT,
          EXECUTION_REASONS.CHANNEL_SUPPRESSED,
          EXECUTION_REASONS.CUSTOMER_DELETED,
          EXECUTION_REASONS.SKIPPED_GOAL_REACHED,
          EXECUTION_REASONS.STAFF_TAKEOVER,
          EXECUTION_REASONS.CUSTOMER_INTERACTION,
          EXECUTION_REASONS.ENQUIRY_RESOLVED,
          EXECUTION_REASONS.ENQUIRY_CLOSED,
          EXECUTION_REASONS.ENQUIRY_CANCELLED,
          EXECUTION_REASONS.ENQUIRY_DELETED,
        ];
        if (exe.skipReason && nonRevivableReasons.includes(exe.skipReason as any)) {
          continue;
        }

        const step = (pinnedVersion.steps || []).find((s: any) => s.stepId === exe.stepId);
        if (!step) continue;

        const delay = step.delay || { unit: 'HOURS', value: (step.offsetDays || 1) * 24 };
        const timingResult = computeDueTimes({
          anchorAt: newAnchor,
          delay,
          settings: {
            timezone: pinnedVersion.timezone || settings?.timezone || 'Asia/Kolkata',
            allowedSendingHours: settings?.allowedSendingHours || { start: '10:00', end: '19:00' },
            blackoutDates: settings?.blackoutDates || [],
            holidays: settings?.holidays || [],
          },
          outsideHoursPolicy: step.outsideHoursPolicy || 'DEFER_NEXT_DAY',
          maxDeferralHours: step.maxDeferralHours ?? 24,
          maxLatenessMinutes: step.maxLatenessMinutes ?? 720,
          now,
          campaignEndAt: campaign?.endAt ? new Date(campaign.endAt) : undefined,
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
          state = EXECUTION_STATE.SKIPPED;
          skipReason = EXECUTION_REASONS.SKIPPED_ELAPSED;
        }

        exe.planRevision = newVersion;
        exe.dueAt = timingResult.adjustedDueAt;
        exe.originalDueAt = timingResult.rawDueAt;
        exe.rawDueAt = timingResult.rawDueAt;
        exe.adjustedDueAt = timingResult.adjustedDueAt;
        exe.expiresAt = expiresAt;
        exe.latestUsefulAt = maxUsefulAt;
        exe.usefulUntilReason = usefulUntilReason;
        exe.deferralReason = timingResult.deferralReason || null;
        exe.localDate = timingResult.adjustedLocalDate;
        exe.localTime = timingResult.adjustedLocalTime;
        exe.timezone = timingResult.timezone;
        exe.state = state as any;
        exe.skipReason = skipReason;
        await exe.save();
      }
    }

    replannedCount++;
  }

  if (heldCount > 0) return { outcome: 'HELD', heldCount };
  if (replannedCount > 0) return { outcome: 'REPLANNED', replannedCount };
  return { outcome: 'NO_OP' };
}

export async function handleEnquiryResolvedOrDeleted(
  paramsOrTenantId: string | { tenantId: string; enquiryId: string; status: string },
  enquiryIdArg?: string,
  statusArg?: string
): Promise<EnquiryChangeResult> {
  let tenantId: string;
  let enquiryId: string;
  let status: string;
  if (typeof paramsOrTenantId === 'object') {
    tenantId = paramsOrTenantId.tenantId;
    enquiryId = paramsOrTenantId.enquiryId;
    status = paramsOrTenantId.status;
  } else {
    tenantId = paramsOrTenantId;
    enquiryId = enquiryIdArg!;
    status = statusArg!;
  }
  const occurrenceId = `enquiry:${enquiryId}`;

  let skipReason: string = EXECUTION_REASONS.ENQUIRY_RESOLVED;
  if (status === 'CLOSED') skipReason = EXECUTION_REASONS.ENQUIRY_CLOSED;
  else if (status === 'CANCELLED') skipReason = EXECUTION_REASONS.ENQUIRY_CANCELLED;
  else if (status === 'DELETED') skipReason = EXECUTION_REASONS.ENQUIRY_DELETED;

  const enrollments = await CampaignEnrollmentModel.find({
    tenantId,
    occurrenceId,
    status: { $in: [ENROLLMENT_STATUS.ACTIVE, ENROLLMENT_STATUS.PAUSED] },
  });

  let cancelledCount = 0;

  for (const enr of enrollments) {
    // Cancel unsent steps only (deliveryIntentId: null)
    await CampaignExecutionModel.updateMany(
      {
        tenantId,
        enrollmentId: enr.enrollmentId,
        deliveryIntentId: null,
        state: {
          $in: [
            EXECUTION_STATE.SCHEDULED,
            EXECUTION_STATE.DEFERRED,
            EXECUTION_STATE.EVALUATING,
            EXECUTION_STATE.SKIPPED,
          ],
        },
      },
      {
        $set: {
          state: EXECUTION_STATE.CANCELLED,
          skipReason,
        },
      }
    );

    enr.status = ENROLLMENT_STATUS.CANCELLED;
    enr.stopReason = skipReason;
    await enr.save();
    cancelledCount++;
  }

  return { outcome: 'CANCELLED', cancelledCount, reason: skipReason };
}

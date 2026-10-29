import crypto from 'crypto';
import { DateTime } from 'luxon';
import {
  LeapDayPolicy,
  SourceCustomer,
  SourceCustomerEvent,
  CAMPAIGN_STATUS,
  CHECKPOINT_STATUS,
  ENROLLMENT_STATUS,
  EXECUTION_STATE,
  isValidISODate,
} from '@grovastra/shared';
import {
  CampaignModel,
  CampaignVersionModel,
  CampaignEnrollmentModel,
  CampaignExecutionModel,
  CampaignCheckpointModel,
  ICampaignVersion,
} from '../../db/models';
import { mockCustomerSource, mockOccasionSource } from '../../adapters';
import { campaignSettingsService } from '../campaign-settings.service';
import { evaluateCustomerForCampaign } from '../audience';
import {
  resolveStepDueAt,
  computeStepExpiresAt,
  fitIntoAllowedHours,
  isLeapYear,
  nextLeapYearAtOrAfter,
  getOccurrenceId,
  calculateLatestUsefulAt,
  formatInsufficientLeadTimeReason,
} from '../datetime';
import { clock } from '../clock';
import { logger } from '../../logger';
import { inactivityEvaluatorService } from '../inactivity-evaluator';
import { reconcileEventDelayCampaign } from '../../presets/_shared/eventDelay/reconcilerBase';
import { reconcileEnquiryCampaign } from '../../presets/unresolvedEnquiry/enquiryReconciler';
import { reconcileCompleteOutfitCampaign } from '../../presets/completeOutfit/reconciler';
import {
  COMPLETE_THE_OUTFIT_ID,
  COMPLETE_THE_OUTFIT_ALIAS,
} from '../../presets/completeOutfit/definition';
import { reconcileRequestedItemAvailableCampaign } from '../../presets/requestedItemAvailable/reconciler';
import {
  REQUESTED_ITEM_AVAILABLE_ID,
  REQUESTED_ITEM_AVAILABLE_ALIAS,
} from '../../presets/requestedItemAvailable/definition';
import { reconcileMatchingCollectionCampaign } from '../../presets/matchingCollection/reconciler';
import {
  MATCHING_COLLECTION_ID,
  MATCHING_COLLECTION_ALIAS,
} from '../../presets/matchingCollection/definition';
import { retentionService } from '../retention/retention.service';
import { NotFoundError } from '../../errors/app-error';

export interface PlanCampaignOptions {
  force?: boolean;
  batchSize?: number;
  nowOverride?: Date;
  resumeFromCheckpoint?: boolean;
}

export interface PlanCampaignResult {
  planned: boolean;
  skipped?: boolean;
  reason?: string;
  campaignId: string;
  horizonStart?: string;
  horizonEnd?: string;
  processedCount?: number;
  enrolledCount?: number;
  createdEnrollmentsCount?: number;
  createdExecutionsCount?: number;
}

export function resolveOccasionDateForYear(
  monthDay: { month: number; day: number },
  year: number,
  leapDayPolicy: LeapDayPolicy = 'FEB_28'
): string {
  const isLeap = isLeapYear(year);
  if (monthDay.month === 2 && monthDay.day === 29) {
    if (isLeap) return `${year}-02-29`;
    if (leapDayPolicy === 'FEB_28') return `${year}-02-28`;
    if (leapDayPolicy === 'MAR_01') return `${year}-03-01`;
    if (leapDayPolicy === 'LEAP_ONLY') {
      const nextLeap = nextLeapYearAtOrAfter(year);
      return `${nextLeap}-02-29`;
    }
  }
  const mm = String(monthDay.month).padStart(2, '0');
  const dd = String(monthDay.day).padStart(2, '0');
  return `${year}-${mm}-${dd}`;
}

export class PlannerService {
  /**
   * Plans upcoming occurrences and steps for a specific campaign.
   * Conforms to Spec p17, p18, p21-25, p33:
   * - Checkpoint with distributed lease prevents concurrent race conditions.
   * - Discovers occasions from (today - largest positive offset) to (today + largest lead + 30 days).
   * - Upserts enrollments and executions idempotently in bounded cursor batches.
   * - Existing enrollments load their PINNED version (never add steps from newer versions).
   * - FUTURE_ONLY: elapsed steps are marked SKIPPED with reason.
   */
  async planCampaign(
    tenantId: string,
    campaignId: string,
    options: PlanCampaignOptions = {}
  ): Promise<PlanCampaignResult> {
    const effectiveNow = options.nowOverride || clock.now();

    // 1. Locate Campaign
    const campaign = await CampaignModel.findOne({ tenantId, campaignId });
    if (!campaign) {
      throw new NotFoundError(`Campaign '${campaignId}' not found for tenant '${tenantId}'`);
    }

    if (campaign.status !== CAMPAIGN_STATUS.ACTIVE) {
      return {
        planned: false,
        campaignId,
        reason: `Campaign status is '${campaign.status}'. Only ACTIVE campaigns can be planned.`,
      };
    }

    if (campaign.endAt && effectiveNow.getTime() >= new Date(campaign.endAt).getTime()) {
      return {
        planned: false,
        campaignId,
        reason: `Campaign reached configured deadline (endAt: ${new Date(campaign.endAt).toISOString()}). No new enrollments will be created.`,
      };
    }

    // 2. Locate Active Published Version
    const activeVersion = (await CampaignVersionModel.findOne({
      tenantId,
      campaignId,
      version: campaign.draftVersion,
      isPublished: true,
    }).lean()) as ICampaignVersion | null;

    if (!activeVersion) {
      // Fallback to activeVersionId if draft has moved to N+1
      const fallbackVersion = (await CampaignVersionModel.findById(
        campaign.activeVersionId
      ).lean()) as ICampaignVersion | null;
      if (!fallbackVersion) {
        return {
          planned: false,
          campaignId,
          reason: `No active published version found for campaign '${campaignId}'`,
        };
      }
    }

    const currentPublishedVersion = (activeVersion ||
      (await CampaignVersionModel.findById(campaign.activeVersionId).lean())) as ICampaignVersion;

    if (!currentPublishedVersion) {
      return {
        planned: false,
        campaignId,
        reason: 'Unable to locate active published campaign version snapshot',
      };
    }

    // Win-back / Inactivity Evaluation Path (Spec p14, p17)
    if (
      campaign.presetId === 'win_back' ||
      currentPublishedVersion.trigger?.type === 'INACTIVITY_THRESHOLD'
    ) {
      const evalResult = await inactivityEvaluatorService.evaluateCampaign(
        tenantId,
        campaignId,
        options
      );
      return {
        planned: evalResult.evaluated,
        skipped: evalResult.skipped,
        reason: evalResult.reason,
        campaignId,
        processedCount: evalResult.processedCount,
        enrolledCount: evalResult.enrolledCount,
        createdEnrollmentsCount: evalResult.createdEnrollmentIds.length,
        createdExecutionsCount: evalResult.createdExecutionIds.length,
      };
    }

    // Enquiry evaluation path
    if (
      campaign.presetId === 'unresolved_enquiry' ||
      campaign.presetId === 'enquiry' ||
      currentPublishedVersion.trigger?.type === 'ENQUIRY_EVENT_DELAY' ||
      (currentPublishedVersion.trigger?.type === 'EVENT_DELAY' &&
        (currentPublishedVersion.trigger as any).anchor === 'ENQUIRY_LAST_INTERACTION')
    ) {
      const recResult = await reconcileEnquiryCampaign(
        tenantId,
        campaignId,
        options
      );
      return {
        planned: recResult.enrolledCount > 0 || recResult.scannedCount > 0,
        skipped: recResult.scannedCount === 0 && recResult.enrolledCount === 0,
        reason: recResult.status,
        campaignId,
        processedCount: recResult.scannedCount,
        enrolledCount: recResult.enrolledCount,
        createdEnrollmentsCount: recResult.enrolledCount,
        createdExecutionsCount: recResult.enrolledCount,
      };
    }

    // Complete the Outfit evaluation path (Spec p14, F24)
    if (
      campaign.presetId === COMPLETE_THE_OUTFIT_ID ||
      campaign.presetId === COMPLETE_THE_OUTFIT_ALIAS ||
      currentPublishedVersion.trigger?.type === 'ORDER_EVENT_DELAY' ||
      (currentPublishedVersion.trigger?.type === 'EVENT_DELAY' &&
        (currentPublishedVersion.trigger as any).anchor === 'ORDER_COMPLETED_AT')
    ) {
      const recResult = await reconcileCompleteOutfitCampaign(
        tenantId,
        campaignId,
        options
      );
      return {
        planned: recResult.status === 'COMPLETED' || recResult.enrolledCount > 0,
        skipped: recResult.scannedCount === 0 && recResult.enrolledCount === 0,
        reason: recResult.status,
        campaignId,
        processedCount: recResult.scannedCount,
        enrolledCount: recResult.enrolledCount,
        createdEnrollmentsCount: recResult.enrolledCount,
        createdExecutionsCount: recResult.enrolledCount,
      };
    }

    // Requested Item Available evaluation path (F25)
    if (
      campaign.presetId === REQUESTED_ITEM_AVAILABLE_ID ||
      campaign.presetId === REQUESTED_ITEM_AVAILABLE_ALIAS ||
      currentPublishedVersion.trigger?.type === 'REQUEST_STOCK_AVAILABLE'
    ) {
      const recResult = await reconcileRequestedItemAvailableCampaign(
        tenantId,
        campaignId,
        options
      );
      return {
        planned: recResult.status === 'COMPLETED' || recResult.enrolledCount > 0,
        skipped: recResult.scannedCount === 0 && recResult.enrolledCount === 0,
        reason: recResult.status,
        campaignId,
        processedCount: recResult.scannedCount,
        enrolledCount: recResult.enrolledCount,
        createdEnrollmentsCount: recResult.enrolledCount,
        createdExecutionsCount: recResult.enrolledCount,
      };
    }

    // Matching Collection evaluation path (F26)
    if (
      campaign.presetId === MATCHING_COLLECTION_ID ||
      campaign.presetId === MATCHING_COLLECTION_ALIAS ||
      (currentPublishedVersion.trigger as any)?.type === 'COLLECTION_PUBLICATION'
    ) {
      const recResult = await reconcileMatchingCollectionCampaign(
        tenantId,
        campaignId,
        options
      );
      return {
        planned: recResult.status === 'COMPLETED' || recResult.enrolledCount > 0,
        skipped: recResult.scannedCount === 0 && recResult.enrolledCount === 0,
        reason: recResult.status,
        campaignId,
        processedCount: recResult.scannedCount,
        enrolledCount: recResult.enrolledCount,
        createdEnrollmentsCount: recResult.enrolledCount,
        createdExecutionsCount: recResult.enrolledCount,
      };
    }

    // Welcome / EVENT_DELAY evaluation path
    if (currentPublishedVersion.trigger?.type === 'EVENT_DELAY') {
      const recResult = await reconcileEventDelayCampaign(
        tenantId,
        campaignId,
        options
      );
      return {
        planned: recResult.status === 'COMPLETED' || recResult.enrolledCount > 0,
        skipped: recResult.scannedCount === 0 && recResult.enrolledCount === 0,
        reason: recResult.status,
        campaignId,
        processedCount: recResult.scannedCount,
        enrolledCount: recResult.enrolledCount,
        createdEnrollmentsCount: recResult.enrolledCount,
        createdExecutionsCount: recResult.enrolledCount,
      };
    }

    // 3. Distributed Lease & Checkpoint Handling (Spec p17, p21, p25)
    let checkpoint = await CampaignCheckpointModel.findOne({
      tenantId,
      campaignId,
      type: 'CALENDAR_PLANNER',
    });

    if (
      checkpoint &&
      checkpoint.leaseExpiresAt &&
      checkpoint.leaseExpiresAt.getTime() > effectiveNow.getTime() &&
      !options.force
    ) {
      return {
        planned: false,
        skipped: true,
        campaignId,
        reason: 'CONCURRENT_PLANNER_RUNNING: Active lease held by another worker',
      };
    }

    const leaseToken = crypto.randomUUID();
    const leaseExpiresAt = new Date(effectiveNow.getTime() + 5 * 60 * 1000); // 5 minute lease

    // 4. Calculate Planning Horizon Window (Spec p17)
    // "Discover occasion dates from today minus the largest positive step offset through
    // today plus the largest lead time plus 30 days."
    const steps = currentPublishedVersion.steps || [];
    const maxPositiveOffset = Math.max(
      0,
      ...steps.map((s) => s.offsetDays ?? 0).filter((d) => d > 0)
    );
    const maxLeadDays = Math.max(
      0,
      ...steps.map((s) => -(s.offsetDays ?? 0)).filter((d) => d > 0)
    );

    const nowDt = DateTime.fromJSDate(effectiveNow, {
      zone: currentPublishedVersion.timezone || 'Asia/Kolkata',
    });
    const horizonStartDt = nowDt.minus({ days: maxPositiveOffset }).startOf('day');
    const horizonEndDt = nowDt.plus({ days: maxLeadDays + 30 }).endOf('day');

    const horizonStartDate = horizonStartDt.toISODate()!;
    const horizonEndDate = horizonEndDt.toISODate()!;

    // Resumption logic: if checkpoint is IN_PROGRESS and has lastCustomerId, resume unless force
    let afterCustomerId = '';
    let processedCount = 0;
    let enrolledCount = 0;

    if (
      options.resumeFromCheckpoint !== false &&
      checkpoint &&
      checkpoint.status === CHECKPOINT_STATUS.IN_PROGRESS &&
      checkpoint.lastCustomerId
    ) {
      afterCustomerId = checkpoint.lastCustomerId;
      processedCount = checkpoint.processedCount || 0;
      enrolledCount = checkpoint.enrolledCount || 0;
    }

    checkpoint = await CampaignCheckpointModel.findOneAndUpdate(
      { tenantId, campaignId, type: 'CALENDAR_PLANNER' },
      {
        $set: {
          status: CHECKPOINT_STATUS.IN_PROGRESS,
          leaseToken,
          leaseExpiresAt,
          horizonStart: horizonStartDate,
          horizonEnd: horizonEndDate,
          startedAt: effectiveNow,
          error: null,
        },
      },
      { upsert: true, new: true }
    );

    // 5. Load Tenant Campaign Settings
    const settings = await campaignSettingsService.getSettings(tenantId);

    const batchSize = Math.min(options.batchSize || 50, 200);
    const createdEnrollmentIds: string[] = [];
    const createdExecutionIds: string[] = [];

    try {
      // 6. Bounded Cursor Batches (Spec p17)
      let hasMore = true;

      while (hasMore) {
        const { customers } = await mockCustomerSource.listCustomers(
          tenantId,
          {
            afterCustomerId: afterCustomerId || '',
            includeDeleted: false,
          },
          { limit: batchSize }
        );

        if (customers.length === 0) {
          hasMore = false;
          break;
        }

        for (const customer of customers) {
          processedCount++;

          // A. Discover candidate occasions within the horizon window
          const candidateOccasions: Array<{
            occurrenceId: string;
            occasionLocalDate: string;
            year: number;
            sourceRef: { type: string; id: string; version: number };
            occasionRecord?: any;
          }> = [];

          if (currentPublishedVersion.trigger.field === 'customer.birthday') {
            if (customer.birthday && customer.birthday.month && customer.birthday.day) {
              const startY = horizonStartDt.year;
              const endY = horizonEndDt.year;
              for (let y = startY; y <= endY; y++) {
                const occDate = resolveOccasionDateForYear(
                  customer.birthday,
                  y,
                  currentPublishedVersion.trigger.leapDayPolicy
                );
                if (occDate >= horizonStartDate && occDate <= horizonEndDate) {
                  candidateOccasions.push({
                    occurrenceId: getOccurrenceId('birthday', y),
                    occasionLocalDate: occDate,
                    year: y,
                    sourceRef: {
                      type: 'CUSTOMER_DATE',
                      id: customer.customerId,
                      version: customer.version || 1,
                    },
                  });
                }
              }
            }
          } else if (currentPublishedVersion.trigger.field === 'customer.event') {
            const events = await mockCustomerSource.getCustomerEvents(tenantId, customer.customerId);
            const anniversaryEvents = events.filter(
              (e) => e.type === 'anniversary' && !e.deletedAt && e.month && e.day
            );

            for (const ev of anniversaryEvents) {
              const startY = horizonStartDt.year;
              const endY = horizonEndDt.year;
              for (let y = startY; y <= endY; y++) {
                const occDate = resolveOccasionDateForYear(
                  { month: ev.month, day: ev.day },
                  y,
                  currentPublishedVersion.trigger.leapDayPolicy
                );
                if (occDate >= horizonStartDate && occDate <= horizonEndDate) {
                  candidateOccasions.push({
                    occurrenceId: getOccurrenceId('anniversary', y, ev.eventId),
                    occasionLocalDate: occDate,
                    year: y,
                    sourceRef: {
                      type: 'CUSTOMER_EVENT',
                      id: ev.eventId,
                      version: ev.version || 1,
                    },
                  });
                }
              }
            }
          } else if (currentPublishedVersion.trigger?.type === 'CUSTOMER_EVENT_DATE') {
            const occasions = await mockOccasionSource.listForCustomer(tenantId, customer.customerId);
            const targetKind = currentPublishedVersion.trigger.occasionKind;
            const todayInTz = DateTime.fromJSDate(effectiveNow, {
              zone: currentPublishedVersion.timezone || 'Asia/Kolkata',
            }).toISODate()!;

            const validOccasions = occasions.filter((occ) => {
              if (occ.deletedAt || occ.status !== 'ACTIVE') return false;
              if (targetKind && occ.kind !== targetKind) return false;
              if (!occ.declaredByCustomer) return false;
              if (!occ.eventDateKey || !isValidISODate(occ.eventDateKey)) return false;
              if (occ.eventDateKey < todayInTz) return false;
              if (occ.eventDateKey < horizonStartDate || occ.eventDateKey > horizonEndDate) return false;
              return true;
            });

            for (const occ of validOccasions) {
              const kindLower = occ.kind.toLowerCase();
              candidateOccasions.push({
                occurrenceId: getOccurrenceId(kindLower, undefined, occ.eventId),
                occasionLocalDate: occ.eventDateKey!,
                year: occ.eventDate?.year || parseInt(occ.eventDateKey!.split('-')[0], 10),
                sourceRef: {
                  type: 'SRC_CUSTOMER_EVENT',
                  id: occ.eventId,
                  version: occ.entityVersion || occ.version || 1,
                },
                occasionRecord: occ,
              });
            }
          }

          if (candidateOccasions.length === 0) {
            continue;
          }

          for (const occ of candidateOccasions) {
            // Compute days until occasion
            const [occY, occM, occD] = occ.occasionLocalDate.split('-').map(Number);
            const occInstant = new Date(Date.UTC(occY, occM - 1, occD));
            const nowMidnightUtc = new Date(
              Date.UTC(
                effectiveNow.getUTCFullYear(),
                effectiveNow.getUTCMonth(),
                effectiveNow.getUTCDate()
              )
            );
            const daysUntilOccasion = Math.round(
              (occInstant.getTime() - nowMidnightUtc.getTime()) / (24 * 60 * 60 * 1000)
            );

            // Evaluate Mandatory Gates & Audience Rules
            const evalResult = evaluateCustomerForCampaign({
              customer,
              campaign: {
                trigger: currentPublishedVersion.trigger,
                enabledBranches: currentPublishedVersion.enabledBranches,
                audience: currentPublishedVersion.audience,
                purpose: currentPublishedVersion.purpose,
              },
              occasionLocalDate: occ.occasionLocalDate,
              daysUntilOccasion,
              occasion: occ.occasionRecord
                ? {
                    kind: occ.occasionRecord.kind,
                    budgetPaise: occ.occasionRecord.budgetPaise,
                    categories: occ.occasionRecord.categories,
                  }
                : undefined,
            });

            if (!evalResult.eligible) {
              continue;
            }

            // B. Idempotent Enrollment Upsert (Hard Rule 5 & 6, Spec p18, p25, QA Matrix B18)
            // enrollmentKey = tenantId + campaignId + customerId + occurrenceId
            const enrollmentKey = `${tenantId}:${campaignId}:${customer.customerId}:${occ.occurrenceId}`;

            // Spec p18, p25, QA Matrix B18: Check both live records AND retained logical-key tombstones
            const isTombstoned = await retentionService.isEnrollmentTombstoned(tenantId, enrollmentKey);
            if (isTombstoned) {
              // Historical occurrence already completed and pruned; tombstone protects against duplicate step
              continue;
            }

            let enrollment = await CampaignEnrollmentModel.findOne({
              tenantId,
              campaignId,
              customerId: customer.customerId,
              occurrenceId: occ.occurrenceId,
            });

            let versionForSteps: ICampaignVersion;

            if (enrollment) {
              // Spec p17, Hard Rule 6:
              // "For an existing enrollment, load its pinned campaignVersionId before upserting its stable steps.
              // Never add steps from the newest active version to an older enrollment."
              const pinnedVersion = (await CampaignVersionModel.findOne({
                tenantId,
                campaignId,
                version: enrollment.campaignVersion,
              }).lean()) as ICampaignVersion | null;

              versionForSteps = pinnedVersion || currentPublishedVersion;
            } else {
              // Create new enrollment
              const enrollmentId = `enr_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
              try {
                enrollment = await CampaignEnrollmentModel.create({
                  enrollmentId,
                  enrollmentKey,
                  tenantId,
                  campaignId,
                  campaignVersionId: currentPublishedVersion._id.toString(),
                  campaignVersion: currentPublishedVersion.version,
                  customerId: customer.customerId,
                  occurrenceId: occ.occurrenceId,
                  sourceRef: occ.sourceRef,
                  occasionLocalDate: occ.occasionLocalDate,
                  planRevision: 1,
                  status: ENROLLMENT_STATUS.ACTIVE,
                  replyHoldAt: null,
                  goalReachedAt: null,
                  matchExplanation: evalResult.explanation || 'all eligible',
                  correctionGroupId: null,
                  eventId: occ.occasionRecord ? occ.occasionRecord.eventId : null,
                  occasionKind: occ.occasionRecord ? occ.occasionRecord.kind : null,
                  eventDateSnapshot: occ.occasionRecord ? occ.occasionLocalDate : null,
                  dateHistory: [],
                });
                enrolledCount++;
                createdEnrollmentIds.push(enrollmentId);
              } catch (err: any) {
                // If duplicate key error (E11000) from concurrent planner (B01), safely retrieve existing
                if (err.code === 11000 || err.message?.includes('duplicate key')) {
                  enrollment = await CampaignEnrollmentModel.findOne({
                    tenantId,
                    campaignId,
                    customerId: customer.customerId,
                    occurrenceId: occ.occurrenceId,
                  });
                } else {
                  throw err;
                }
              }

              if (!enrollment) continue;

              const pinned = (await CampaignVersionModel.findOne({
                tenantId,
                campaignId,
                version: enrollment.campaignVersion,
              }).lean()) as ICampaignVersion | null;

              versionForSteps = pinned || currentPublishedVersion;
            }

            // C. Plan Stable Steps for this Enrollment (Spec p17, p23, p25)
            // executionKey = enrollmentId + stableStepId
            for (const step of versionForSteps.steps || []) {
              const executionKey = `${enrollment.enrollmentId}:${step.stepId}`;

              const [existingExe, isExeTombstoned] = await Promise.all([
                CampaignExecutionModel.findOne({
                  tenantId,
                  enrollmentId: enrollment.enrollmentId,
                  stepId: step.stepId,
                }),
                retentionService.isExecutionTombstoned(tenantId, executionKey),
              ]);

              if (existingExe || isExeTombstoned) {
                // Re-running planner changes nothing for existing or retained execution
                continue;
              }

              // Compute step schedule
              const stepDue = resolveStepDueAt({
                occasionLocalDate: occ.occasionLocalDate,
                offsetDays: step.offsetDays ?? 0,
                localTime: step.localTime || '10:00',
                timezone: versionForSteps.timezone || 'Asia/Kolkata',
              });

              const expiresAt = computeStepExpiresAt({
                dueAt: stepDue.dueAt,
                maxLatenessMinutes: step.maxLatenessMinutes,
                campaignEndAt: campaign.endAt,
              });

              const fitResult = fitIntoAllowedHours(
                stepDue.dueAt,
                {
                  timezone: settings.timezone,
                  allowedSendingHours: settings.allowedSendingHours,
                  blackoutDates: settings.blackoutDates,
                  holidays: settings.holidays,
                },
                expiresAt
              );

              // Compute latestUsefulAt if CUSTOMER_EVENT_DATE
              let latestUsefulAt: Date | null = null;
              let usefulUntilReason: string | null = null;

              if (currentPublishedVersion.trigger?.type === 'CUSTOMER_EVENT_DATE') {
                const leadDays =
                  currentPublishedVersion.trigger.fulfillmentLeadDays ??
                  (currentPublishedVersion.trigger.occasionKind === 'WEDDING' ? 21 : 2);
                const endHours = settings.allowedSendingHours?.end || '19:00';
                const tz = versionForSteps.timezone || settings.timezone || 'Asia/Kolkata';
                const usefulResult = calculateLatestUsefulAt({
                  eventDateKey: occ.occasionLocalDate,
                  fulfillmentLeadDays: leadDays,
                  allowedSendingHoursEnd: endHours,
                  timezone: tz,
                });
                latestUsefulAt = usefulResult.latestUsefulAt;
                usefulUntilReason = formatInsufficientLeadTimeReason(leadDays, daysUntilOccasion);
              }

              // Determine initial state (FUTURE_ONLY rule: elapsed steps skipped with reason)
              let state: string = EXECUTION_STATE.SCHEDULED;
              let skipReason: string | null = null;

              if (campaign.endAt && fitResult.dueAt.getTime() > new Date(campaign.endAt).getTime()) {
                state = EXECUTION_STATE.EXPIRED;
                skipReason = 'Step due after campaign deadline (endAt)';
              } else if (fitResult.status === 'SKIP') {
                state = EXECUTION_STATE.SKIPPED;
                skipReason = fitResult.reason || 'SKIPPED_EXPIRY';
              } else if (
                latestUsefulAt &&
                (fitResult.dueAt.getTime() > latestUsefulAt.getTime() ||
                  effectiveNow.getTime() > latestUsefulAt.getTime())
              ) {
                state = EXECUTION_STATE.SKIPPED;
                skipReason = 'INSUFFICIENT_LEAD_TIME';
              } else if (fitResult.dueAt.getTime() < effectiveNow.getTime()) {
                state = EXECUTION_STATE.SKIPPED;
                skipReason = 'Elapsed step prior to evaluation instant';
              } else {
                state = EXECUTION_STATE.SCHEDULED;
                skipReason = null;
              }

              const executionId = `exe_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;

              try {
                await CampaignExecutionModel.create({
                  executionId,
                  executionKey,
                  tenantId,
                  campaignId,
                  enrollmentId: enrollment.enrollmentId,
                  stepId: step.stepId,
                  stepName: step.stepName || step.stepId,
                  dueAt: fitResult.dueAt,
                  originalDueAt: stepDue.dueAt,
                  adjustedDueAt: fitResult.dueAt,
                  expiresAt,
                  latestUsefulAt,
                  usefulUntilReason,
                  localDate: stepDue.localDate,
                  localTime: stepDue.localTime,
                  timezone: versionForSteps.timezone || 'Asia/Kolkata',
                  planRevision: 1,
                  state,
                  skipReason,
                  prerequisite: step.prerequisite,
                  templateRef: step.templateRef
                    ? {
                        id: step.templateRef.id,
                        revision: step.templateRef.revision,
                        language: step.templateRef.language,
                      }
                    : null,
                  deliveryIntentId: null,
                });
                createdExecutionIds.push(executionId);
              } catch (err: any) {
                // If duplicate key error from concurrent worker, safely ignore
                if (err.code !== 11000 && !err.message?.includes('duplicate key')) {
                  throw err;
                }
              }
            }
          }
        }

        // Bounded cursor progress update
        afterCustomerId = customers[customers.length - 1].customerId;
        await CampaignCheckpointModel.updateOne(
          { tenantId, campaignId, type: 'CALENDAR_PLANNER' },
          {
            $set: {
              lastCustomerId: afterCustomerId,
              processedCount,
              enrolledCount,
              leaseExpiresAt: new Date(effectiveNow.getTime() + 5 * 60 * 1000), // extend lease
            },
          }
        );

        if (customers.length < batchSize) {
          hasMore = false;
        }
      }

      // 7. Reconciliation Phase (Spec p20, p30, A09)
      // Check active enrollments to cancel pending steps if source occasion was removed
      await this.reconcileActiveEnrollments(tenantId, campaignId);

      // 8. Complete Checkpoint
      await CampaignCheckpointModel.updateOne(
        { tenantId, campaignId, type: 'CALENDAR_PLANNER' },
        {
          $set: {
            status: CHECKPOINT_STATUS.COMPLETED,
            lastCustomerId: null,
            leaseToken: null,
            leaseExpiresAt: null,
            completedAt: effectiveNow,
            processedCount,
            enrolledCount,
          },
        }
      );

      return {
        planned: true,
        campaignId,
        horizonStart: horizonStartDate,
        horizonEnd: horizonEndDate,
        processedCount,
        enrolledCount,
        createdEnrollmentsCount: createdEnrollmentIds.length,
        createdExecutionsCount: createdExecutionIds.length,
      };
    } catch (error: any) {
      await CampaignCheckpointModel.updateOne(
        { tenantId, campaignId, type: 'CALENDAR_PLANNER' },
        {
          $set: {
            status: CHECKPOINT_STATUS.FAILED,
            leaseToken: null,
            leaseExpiresAt: null,
            error: error?.message || 'Unknown planner error',
          },
        }
      );
      throw error;
    }
  }

  /**
   * Reconciles active enrollments:
   * - A09: If an anniversary event was removed/deleted, cancel pending steps and mark enrollment CANCELLED.
   * - If a customer was deleted, cancel pending steps.
   */
  async reconcileActiveEnrollments(tenantId: string, campaignId: string): Promise<number> {
    let cancelledCount = 0;
    const activeEnrollments = await CampaignEnrollmentModel.find({
      tenantId,
      campaignId,
      status: ENROLLMENT_STATUS.ACTIVE,
    });

    for (const enr of activeEnrollments) {
      if (enr.occurrenceId.startsWith('anniversary:')) {
        const parts = enr.occurrenceId.split(':');
        const eventId = parts[1];

        // Fetch customer and events
        const [customer, events] = await Promise.all([
          mockCustomerSource.getCustomerById(tenantId, enr.customerId),
          mockCustomerSource.getCustomerEvents(tenantId, enr.customerId),
        ]);

        const eventExists = events.some((e) => e.eventId === eventId && !e.deletedAt);
        const customerValid = customer && !customer.deletedAt && customer.status === 'ACTIVE';

        if (!eventExists || !customerValid) {
          // Cancel pending steps
          await CampaignExecutionModel.updateMany(
            {
              tenantId,
              enrollmentId: enr.enrollmentId,
              state: EXECUTION_STATE.SCHEDULED,
            },
            {
              $set: {
                state: EXECUTION_STATE.CANCELLED,
                skipReason: 'OCCASION_EVENT_REMOVED',
              },
            }
          );

          await CampaignEnrollmentModel.updateOne(
            { tenantId, enrollmentId: enr.enrollmentId },
            { $set: { status: ENROLLMENT_STATUS.CANCELLED } }
          );

          cancelledCount++;
        }
      } else if (enr.occurrenceId.startsWith('gift:') || enr.occurrenceId.startsWith('wedding:')) {
        const eventId = enr.eventId || enr.occurrenceId.split(':')[1];
        const [customer, occasion] = await Promise.all([
          mockCustomerSource.getCustomerById(tenantId, enr.customerId),
          mockOccasionSource.getOccasion(tenantId, eventId),
        ]);

        const customerValid = customer && !customer.deletedAt && customer.status === 'ACTIVE';
        const occasionExists = occasion && !occasion.deletedAt;

        if (!customerValid) {
          await CampaignExecutionModel.updateMany(
            {
              tenantId,
              enrollmentId: enr.enrollmentId,
              state: EXECUTION_STATE.SCHEDULED,
            },
            {
              $set: {
                state: EXECUTION_STATE.CANCELLED,
                skipReason: 'CUSTOMER_DELETED',
              },
            }
          );
          await CampaignEnrollmentModel.updateOne(
            { tenantId, enrollmentId: enr.enrollmentId },
            { $set: { status: ENROLLMENT_STATUS.CANCELLED } }
          );
          cancelledCount++;
        } else if (!occasionExists) {
          await CampaignExecutionModel.updateMany(
            {
              tenantId,
              enrollmentId: enr.enrollmentId,
              state: EXECUTION_STATE.SCHEDULED,
            },
            {
              $set: {
                state: EXECUTION_STATE.CANCELLED,
                skipReason: 'OCCASION_DELETED',
              },
            }
          );
          await CampaignEnrollmentModel.updateOne(
            { tenantId, enrollmentId: enr.enrollmentId },
            { $set: { status: ENROLLMENT_STATUS.CANCELLED } }
          );
          cancelledCount++;
        } else if (occasion.status === 'CANCELLED') {
          await CampaignExecutionModel.updateMany(
            {
              tenantId,
              enrollmentId: enr.enrollmentId,
              state: EXECUTION_STATE.SCHEDULED,
            },
            {
              $set: {
                state: EXECUTION_STATE.CANCELLED,
                skipReason: 'OCCASION_CANCELLED',
              },
            }
          );
          await CampaignEnrollmentModel.updateOne(
            { tenantId, enrollmentId: enr.enrollmentId },
            { $set: { status: ENROLLMENT_STATUS.CANCELLED } }
          );
          cancelledCount++;
        } else if (occasion.status === 'COMPLETED') {
          await CampaignExecutionModel.updateMany(
            {
              tenantId,
              enrollmentId: enr.enrollmentId,
              state: EXECUTION_STATE.SCHEDULED,
            },
            {
              $set: {
                state: EXECUTION_STATE.CANCELLED,
                skipReason: 'OCCASION_COMPLETED',
              },
            }
          );
          await CampaignEnrollmentModel.updateOne(
            { tenantId, enrollmentId: enr.enrollmentId },
            { $set: { status: ENROLLMENT_STATUS.COMPLETED } }
          );
          cancelledCount++;
        }
      }
    }

    return cancelledCount;
  }

  /**
   * Runs the planner cycle across all active campaigns for a tenant or across all tenants.
   */
  async runPlannerCycle(tenantId?: string): Promise<PlanCampaignResult[]> {
    const query: Record<string, any> = { status: CAMPAIGN_STATUS.ACTIVE };
    if (tenantId) {
      query.tenantId = tenantId;
    }

    const campaigns = await CampaignModel.find(query).lean();
    const results: PlanCampaignResult[] = [];

    for (const cmp of campaigns) {
      try {
        const res = await this.planCampaign(cmp.tenantId, cmp.campaignId);
        results.push(res);
      } catch (err) {
        logger.error({ err, campaignId: cmp.campaignId, tenantId: cmp.tenantId }, 'Error planning campaign');
      }
    }

    return results;
  }
}

export const plannerService = new PlannerService();

let plannerIntervalTimer: NodeJS.Timeout | null = null;

/**
 * Starts periodic background loop (default 15 minutes).
 */
export function startPlannerLoop(intervalMs?: number) {
  if (plannerIntervalTimer) return;
  const interval =
    intervalMs ||
    Number(process.env.PLANNER_INTERVAL_MS) ||
    (Number(process.env.PLANNER_INTERVAL_MINUTES) || 15) * 60 * 1000;

  plannerIntervalTimer = setInterval(async () => {
    try {
      await plannerService.runPlannerCycle();
    } catch (err) {
      logger.error({ err }, 'Error in scheduled periodic planner cycle');
    }
  }, interval);
}

export function stopPlannerLoop() {
  if (plannerIntervalTimer) {
    clearInterval(plannerIntervalTimer);
    plannerIntervalTimer = null;
  }
}

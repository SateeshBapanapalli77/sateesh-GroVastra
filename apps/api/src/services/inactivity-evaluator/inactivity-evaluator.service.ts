import crypto from 'crypto';
import { DateTime } from 'luxon';
import {
  CAMPAIGN_STATUS,
  CHECKPOINT_STATUS,
  ENROLLMENT_STATUS,
  EXECUTION_STATE,
} from '@grovastra/shared';
import {
  CampaignModel,
  CampaignVersionModel,
  CampaignEnrollmentModel,
  CampaignExecutionModel,
  CampaignCheckpointModel,
  CampaignCustomerFactModel,
  SrcCustomerModel,
  ICampaignVersion,
} from '../../db/models';
import { campaignSettingsService } from '../campaign-settings.service';
import { evaluateCustomerForCampaign } from '../audience';
import { customerFactsService } from '../customer-facts';
import {
  resolveStepDueAt,
  computeStepExpiresAt,
  fitIntoAllowedHours,
} from '../datetime';
import { clock } from '../clock';
import { logger } from '../../logger';
import { retentionService } from '../retention/retention.service';

export interface InactivityEvaluatorOptions {
  campaignId?: string;
  nowOverride?: Date;
  force?: boolean;
  batchSize?: number;
}

export interface InactivityEvaluationResult {
  campaignId: string;
  evaluated: boolean;
  skipped?: boolean;
  reason?: string;
  processedCount: number;
  enrolledCount: number;
  createdEnrollmentIds: string[];
  createdExecutionIds: string[];
}

export class InactivityEvaluatorService {
  /**
   * Evaluates due inactivity occurrences for a campaign or all active win-back campaigns
   * adhering strictly to Spec p14, p17, p18, p21-25:
   * - Scans indexed nextEvaluationAt on campaignCustomerFacts
   * - Uses durable checkpoints with distributed lease to prevent concurrent race conditions
   * - Occurrence = winback:lastQualifyingOrderId:ruleId
   * - Enrolls the occurrence ONCE (repeated scans reuse that occurrence, never duplicate)
   * - FUTURE_ONLY: elapsed steps are marked SKIPPED with reason
   */
  async evaluateCampaign(
    tenantId: string,
    campaignId: string,
    options: InactivityEvaluatorOptions = {}
  ): Promise<InactivityEvaluationResult> {
    const effectiveNow = options.nowOverride || clock.now();

    // 1. Locate Campaign
    const campaign = await CampaignModel.findOne({ tenantId, campaignId });
    if (!campaign) {
      return {
        campaignId,
        evaluated: false,
        reason: `Campaign '${campaignId}' not found for tenant '${tenantId}'`,
        processedCount: 0,
        enrolledCount: 0,
        createdEnrollmentIds: [],
        createdExecutionIds: [],
      };
    }

    if (campaign.status !== CAMPAIGN_STATUS.ACTIVE) {
      return {
        campaignId,
        evaluated: false,
        reason: `Campaign status is '${campaign.status}'. Only ACTIVE campaigns can be evaluated.`,
        processedCount: 0,
        enrolledCount: 0,
        createdEnrollmentIds: [],
        createdExecutionIds: [],
      };
    }

    if (campaign.endAt && effectiveNow.getTime() >= new Date(campaign.endAt).getTime()) {
      return {
        campaignId,
        evaluated: false,
        reason: `Campaign reached configured deadline (endAt). No new enrollments will be created.`,
        processedCount: 0,
        enrolledCount: 0,
        createdEnrollmentIds: [],
        createdExecutionIds: [],
      };
    }

    // 2. Locate Active Published Version
    let currentPublishedVersion: ICampaignVersion | null = null;
    if (campaign.activeVersionId) {
      currentPublishedVersion = (await CampaignVersionModel.findById(
        campaign.activeVersionId
      ).lean()) as ICampaignVersion | null;
    }
    if (!currentPublishedVersion) {
      currentPublishedVersion = (await CampaignVersionModel.findOne({
        tenantId,
        campaignId,
        isPublished: true,
      })
        .sort({ version: -1 })
        .lean()) as ICampaignVersion | null;
    }

    if (!currentPublishedVersion) {
      return {
        campaignId,
        evaluated: false,
        reason: `No active published version found for campaign '${campaignId}'`,
        processedCount: 0,
        enrolledCount: 0,
        createdEnrollmentIds: [],
        createdExecutionIds: [],
      };
    }

    // 3. Distributed Lease & Checkpoint (Spec p17, p21, p25)
    let checkpoint = await CampaignCheckpointModel.findOne({
      tenantId,
      campaignId,
      type: 'INACTIVITY_EVALUATOR',
    });

    if (
      checkpoint &&
      checkpoint.leaseExpiresAt &&
      checkpoint.leaseExpiresAt.getTime() > effectiveNow.getTime() &&
      !options.force
    ) {
      return {
        campaignId,
        evaluated: false,
        skipped: true,
        reason: 'CONCURRENT_INACTIVITY_EVALUATOR_RUNNING: Active lease held by another worker',
        processedCount: 0,
        enrolledCount: 0,
        createdEnrollmentIds: [],
        createdExecutionIds: [],
      };
    }

    const leaseToken = crypto.randomUUID();
    const leaseExpiresAt = new Date(effectiveNow.getTime() + 5 * 60 * 1000); // 5 min lease

    checkpoint = await CampaignCheckpointModel.findOneAndUpdate(
      { tenantId, campaignId, type: 'INACTIVITY_EVALUATOR' },
      {
        $set: {
          status: CHECKPOINT_STATUS.IN_PROGRESS,
          leaseToken,
          leaseExpiresAt,
          startedAt: effectiveNow,
          error: null,
        },
      },
      { upsert: true, new: true }
    );

    const settings = await campaignSettingsService.getSettings(tenantId);
    const thresholdDays = (currentPublishedVersion.trigger as any)?.thresholdDays || 90;
    const ruleId = (currentPublishedVersion.trigger as any)?.ruleId || 'default';
    const targetCategory = (currentPublishedVersion.trigger as any)?.category;

    const createdEnrollmentIds: string[] = [];
    const createdExecutionIds: string[] = [];
    let processedCount = 0;
    let enrolledCount = 0;

    try {
      // 4. Scan indexed nextEvaluationAt on campaignCustomerFacts (Spec p17, p21)
      const maxLastPurchaseAt = new Date(effectiveNow.getTime() - thresholdDays * 24 * 60 * 60 * 1000);
      const dueFacts = await CampaignCustomerFactModel.find({
        tenantId,
        lastQualifyingOrderId: { $ne: null },
        $or: [
          { nextEvaluationAt: { $lte: effectiveNow } },
          { lastQualifyingPurchaseAt: { $lte: maxLastPurchaseAt } },
        ],
      })
        .sort({ nextEvaluationAt: 1 })
        .limit(options.batchSize || 100)
        .lean();

      for (const fact of dueFacts) {
        processedCount++;

        if (!fact.lastQualifyingOrderId || !fact.lastQualifyingPurchaseAt) {
          continue;
        }

        // Category filtering if category data exists and rule specifies a category
        let purchaseDateToCompare = fact.lastQualifyingPurchaseAt;
        if (targetCategory && targetCategory !== 'all') {
          const catData = fact.categoryPurchases?.[targetCategory];
          if (!catData) {
            continue;
          }
          purchaseDateToCompare = catData.lastQualifyingPurchaseAt;
        }

        // Verify threshold elapsed
        const lastPurchaseTime = new Date(purchaseDateToCompare).getTime();
        const daysInactive = (effectiveNow.getTime() - lastPurchaseTime) / (24 * 60 * 60 * 1000);
        if (daysInactive < thresholdDays) {
          continue;
        }

        // Fetch customer profile
        const customer: any = await SrcCustomerModel.findOne({ tenantId, customerId: fact.customerId }).lean();
        if (!customer) {
          continue;
        }

        // Inactivity campaign steps start from evaluation date
        const occasionLocalDate = DateTime.fromJSDate(effectiveNow, {
          zone: currentPublishedVersion.timezone || 'Asia/Kolkata',
        }).toISODate()!;

        // Evaluate mandatory gates & audience rules (Spec p10)
        const evalResult = evaluateCustomerForCampaign({
          customer: customer as any,
          campaign: {
            trigger: currentPublishedVersion.trigger,
            enabledBranches: currentPublishedVersion.enabledBranches,
            audience: currentPublishedVersion.audience,
            purpose: currentPublishedVersion.purpose,
          },
          occasionLocalDate,
          daysUntilOccasion: 0,
        });

        if (!evalResult.eligible) {
          continue;
        }

        // 5. Occurrence ID & Dedupe (Spec p14, p18, p25)
        // Occurrence = winback:lastQualifyingOrderId:ruleId
        // Repeated daily scans reuse that occurrence; enrolls the occurrence ONCE.
        const occurrenceId = `winback:${fact.lastQualifyingOrderId}:${ruleId}`;
        const enrollmentKey = `${tenantId}:${campaignId}:${customer.customerId}:${occurrenceId}`;

        // Check if already enrolled for this occurrence (Spec p14, QA Matrix B17, B18)
        const isTombstoned = await retentionService.isEnrollmentTombstoned(tenantId, enrollmentKey);
        if (isTombstoned) {
          // Occurrence already completed, pruned and tombstoned! Never re-enroll (B18)
          continue;
        }

        let enrollment = await CampaignEnrollmentModel.findOne({
          tenantId,
          campaignId,
          customerId: customer.customerId,
          occurrenceId,
        });

        if (enrollment) {
          // Occurrence already enrolled once! Never re-enroll completed/active occurrence (B17)
          continue;
        }

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
            occurrenceId,
            sourceRef: {
              type: 'ORDER',
              id: fact.lastQualifyingOrderId,
              version: fact.authoritativeSourceVersions?.orderVersion || 1,
            },
            occasionLocalDate,
            planRevision: 1,
            status: ENROLLMENT_STATUS.ACTIVE,
            replyHoldAt: null,
            goalReachedAt: null,
            matchExplanation:
              evalResult.explanation || `Customer inactive past ${thresholdDays} days threshold`,
            correctionGroupId: null,
          });
          enrolledCount++;
          createdEnrollmentIds.push(enrollmentId);
        } catch (err: any) {
          if (err.code === 11000 || err.message?.includes('duplicate key')) {
            // Already enrolled by a concurrent process
            continue;
          }
          throw err;
        }

        // 6. Plan Stable Steps for this Enrollment (Spec p17, p23, p25)
        for (const step of currentPublishedVersion.steps || []) {
          const executionKey = `${enrollment.enrollmentId}:${step.stepId}`;

          const existingExe = await CampaignExecutionModel.findOne({
            tenantId,
            enrollmentId: enrollment.enrollmentId,
            stepId: step.stepId,
          });

          if (existingExe) {
            continue;
          }

          const stepDue = resolveStepDueAt({
            occasionLocalDate,
            offsetDays: step.offsetDays ?? 0,
            localTime: step.localTime || '10:00',
            timezone: currentPublishedVersion.timezone || 'Asia/Kolkata',
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

          // FUTURE_ONLY rule: elapsed steps skipped with reason
          let state: string = EXECUTION_STATE.SCHEDULED;
          let skipReason: string | null = null;

          if (campaign.endAt && fitResult.dueAt.getTime() > new Date(campaign.endAt).getTime()) {
            state = EXECUTION_STATE.EXPIRED;
            skipReason = 'Step due after campaign deadline (endAt)';
          } else if (fitResult.status === 'SKIP') {
            state = EXECUTION_STATE.SKIPPED;
            skipReason = fitResult.reason || 'SKIPPED_EXPIRY';
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
              expiresAt,
              localDate: stepDue.localDate,
              localTime: stepDue.localTime,
              timezone: currentPublishedVersion.timezone || 'Asia/Kolkata',
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
            if (err.code !== 11000 && !err.message?.includes('duplicate key')) {
              throw err;
            }
          }
        }
      }

      // 7. Complete Checkpoint
      await CampaignCheckpointModel.findOneAndUpdate(
        { tenantId, campaignId, type: 'INACTIVITY_EVALUATOR' },
        {
          $set: {
            status: CHECKPOINT_STATUS.COMPLETED,
            leaseToken: null,
            leaseExpiresAt: null,
            completedAt: effectiveNow,
            processedCount,
            enrolledCount,
          },
        }
      );
    } catch (err: any) {
      await CampaignCheckpointModel.findOneAndUpdate(
        { tenantId, campaignId, type: 'INACTIVITY_EVALUATOR' },
        {
          $set: {
            status: CHECKPOINT_STATUS.FAILED,
            leaseToken: null,
            leaseExpiresAt: null,
            error: err.message,
          },
        }
      );
      throw err;
    }

    return {
      campaignId,
      evaluated: true,
      processedCount,
      enrolledCount,
      createdEnrollmentIds,
      createdExecutionIds,
    };
  }

  /**
   * Evaluates due inactivity across all active win-back campaigns for a tenant
   * or all tenants.
   */
  async evaluateAllDue(
    tenantId?: string,
    options: InactivityEvaluatorOptions = {}
  ): Promise<InactivityEvaluationResult[]> {
    const query: Record<string, any> = {
      status: CAMPAIGN_STATUS.ACTIVE,
      $or: [{ presetId: 'win_back' }, { 'trigger.type': 'INACTIVITY_THRESHOLD' }],
    };
    if (tenantId) {
      query.tenantId = tenantId;
    }

    const campaigns = await CampaignModel.find(query);
    const results: InactivityEvaluationResult[] = [];

    for (const campaign of campaigns) {
      const res = await this.evaluateCampaign(campaign.tenantId, campaign.campaignId, options);
      results.push(res);
    }

    return results;
  }
}

export const inactivityEvaluatorService = new InactivityEvaluatorService();

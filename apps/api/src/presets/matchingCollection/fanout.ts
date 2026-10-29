/**
 * Matching Collection Fan-out Enroller — F26 Part 1
 *
 * When a collection.published event is received:
 *   1. Find all ACTIVE matching_collection campaigns for this tenant
 *   2. For each campaign, iterate ALL opted-in customers with a cursor
 *      (batched, checkpointed for durability — same pattern as F25 stock fan-out)
 *   3. Score each customer's preference affinity against the collection items
 *   4. Enroll eligible customers with ACTIVE status; record EXCLUDED for ineligible
 *   5. Skip customers who are already enrolled for this release
 *
 * Enrollment key: collection:{releaseId}:{customerId}
 * occurrenceId:   collection:{releaseId}:{customerId}
 * sourceRef:      { type: 'SRC_COLLECTIONS', id: releaseId, version: entityVersion }
 *
 * The entire fan-out is designed to be restartable: the campaign checkpoint stores
 * the last processed customerId (cursor), and the enrollmentKey unique index prevents
 * double-enrollment.
 */

import crypto from 'crypto';
import {
  ENROLLMENT_STATUS,
  EXECUTION_STATE,
  EXECUTION_REASONS,
  normalizePreferences,
} from '@grovastra/shared';
import {
  CampaignModel,
  CampaignVersionModel,
  CampaignEnrollmentModel,
  CampaignExecutionModel,
  CampaignCheckpointModel,
  SrcCustomerModel,
  ICampaignVersion,
} from '../../db/models';
import { ISrcCollection } from '../../db/models/src-collection.model';
import { contactGateService } from '../../services/contact-gate/contact-gate.service';
import { campaignSettingsService } from '../../services/campaign-settings.service';
import { clock } from '../../services/clock';
import { logger } from '../../logger';
import { computeDueTimes } from '../_shared/eventDelay/delayTiming';
import { EXCLUSION_REASONS, isDestinationVerified } from '@grovastra/shared';
import { scoreAffinityForCollection, evaluateAffinityEligibility } from './matching';
import { MATCHING_COLLECTION_ID, MATCHING_COLLECTION_ALIAS } from './definition';

export interface FanoutResult {
  releaseId: string;
  campaignsProcessed: number;
  totalEnrolled: number;
  totalExcluded: number;
  totalSkipped: number;
  checkpointIds: string[];
  durationMs: number;
}

export interface FanoutBatchResult {
  campaignId: string;
  enrolled: number;
  excluded: number;
  skipped: number;
  checkpointId?: string;
  status: 'COMPLETED' | 'IN_PROGRESS' | 'FAILED';
  durationMs: number;
}

const BATCH_SIZE = 50;
const CHECKPOINT_TYPE_PREFIX = 'collection-fanout';

/**
 * Main entry point called by the collection.published event handler.
 * Finds all active matching_collection campaigns for the tenant and fans out.
 */
export async function fanoutCollectionPublished(
  tenantId: string,
  collection: ISrcCollection,
  nowOverride?: Date
): Promise<FanoutResult> {
  const start = Date.now();
  const now = nowOverride ?? clock.now();

  // Find all ACTIVE matching_collection campaigns
  const campaigns = await CampaignModel.find({
    tenantId,
    status: 'ACTIVE',
    presetId: { $in: [MATCHING_COLLECTION_ID, MATCHING_COLLECTION_ALIAS] },
  }).lean();

  const results: FanoutBatchResult[] = [];
  for (const campaign of campaigns) {
    const result = await fanoutCollectionToCampaign(tenantId, collection, campaign, now);
    results.push(result);
  }

  return {
    releaseId: collection.releaseId,
    campaignsProcessed: campaigns.length,
    totalEnrolled: results.reduce((a, r) => a + r.enrolled, 0),
    totalExcluded: results.reduce((a, r) => a + r.excluded, 0),
    totalSkipped: results.reduce((a, r) => a + r.skipped, 0),
    checkpointIds: results.map((r) => r.checkpointId ?? '').filter(Boolean),
    durationMs: Date.now() - start,
  };
}

/**
 * Fan-out a single collection release to a single campaign.
 * Uses a cursor scan with checkpointing for durability.
 */
async function fanoutCollectionToCampaign(
  tenantId: string,
  collection: ISrcCollection,
  campaign: any,
  now: Date
): Promise<FanoutBatchResult> {
  const start = Date.now();
  const campaignId = campaign.campaignId as string;

  // Load active campaign version
  const version: ICampaignVersion | null = (await CampaignVersionModel.findOne({
    tenantId,
    campaignId,
    isPublished: true,
  })
    .sort({ version: -1 })
    .lean()) as any;

  if (!version) {
    logger.warn({ tenantId, campaignId }, '[F26] No published version found; skipping fan-out');
    return {
      campaignId,
      enrolled: 0,
      excluded: 0,
      skipped: 0,
      status: 'FAILED',
      durationMs: Date.now() - start,
    };
  }

  const settings = await campaignSettingsService.getSettings(tenantId);
  const minAffinityScore: number = (version as any).minAffinityScore ?? 0.0;

  // Checkpoint key: one per (campaignId, releaseId) pair
  const checkpointType = `${CHECKPOINT_TYPE_PREFIX}:${campaign.campaignId}:${collection.releaseId}`;
  const leaseToken = crypto.randomUUID();
  const leaseExpiresAt = new Date(now.getTime() + 10 * 60 * 1000); // 10 min

  let checkpoint = await CampaignCheckpointModel.findOne({ tenantId, campaignId, type: checkpointType });

  if (!checkpoint) {
    checkpoint = await CampaignCheckpointModel.create({
      tenantId,
      campaignId,
      type: checkpointType,
      status: 'IN_PROGRESS',
      leaseToken,
      leaseExpiresAt,
      lastCustomerId: null,
      horizonStart: collection.publishedAt.toISOString(),
      horizonEnd: now.toISOString(),
      processedCount: 0,
      enrolledCount: 0,
      startedAt: now,
    });
  } else if (
    checkpoint.status === 'IN_PROGRESS' &&
    checkpoint.leaseExpiresAt &&
    checkpoint.leaseExpiresAt.getTime() > Math.max(now.getTime(), clock.now().getTime(), Date.now())
  ) {
    // Another runner is active — skip
    logger.warn({ tenantId, campaignId, checkpointType }, '[F26] Fan-out checkpoint locked');
    return {
      campaignId,
      enrolled: 0,
      excluded: 0,
      skipped: 0,
      checkpointId: checkpoint.id,
      status: 'IN_PROGRESS',
      durationMs: Date.now() - start,
    };
  } else {
    checkpoint.leaseToken = leaseToken;
    checkpoint.leaseExpiresAt = leaseExpiresAt;
    checkpoint.status = 'IN_PROGRESS';
    checkpoint.startedAt = now;
    await checkpoint.save();
  }

  let totalEnrolled = 0;
  let totalExcluded = 0;
  let totalSkipped = 0;
  let lastCustomerId: string | null = checkpoint.lastCustomerId ?? null;
  let isComplete = false;

  // Cursor loop: process customers in batches until cursor exhausted
  while (true) {
    const query: Record<string, unknown> = {
      tenantId,
      deletedAt: null,
      status: { $nin: ['DELETED', 'OPTED_OUT'] },
      'consent.marketingOptIn': true,
      'consent.channelSuppressed': { $ne: true },
    };

    // Branch filter: if campaign has enabledBranches, restrict
    const enabledBranches = (campaign as any).enabledBranches || (version as any).enabledBranches;
    if (enabledBranches && enabledBranches.length > 0) {
      query.branchId = { $in: enabledBranches };
    }

    // Collection branch filter
    if (collection.branchId) {
      query.branchId = collection.branchId;
    }

    // Cursor: only process customers after the last checkpoint
    if (lastCustomerId) {
      query.customerId = { $gt: lastCustomerId };
    }

    const customers = await SrcCustomerModel.find(query)
      .sort({ customerId: 1 })
      .limit(BATCH_SIZE)
      .lean();

    if (customers.length === 0) {
      isComplete = true;
      break;
    }

    for (const customer of customers) {
      const customerId = customer.customerId as string;
      const enrollmentKey = `collection:${collection.releaseId}:${customerId}`;
      const occurrenceId = enrollmentKey;

      // Idempotency: skip if already enrolled (any status) for this release
      const existing = await CampaignEnrollmentModel.findOne({
        tenantId,
        campaignId,
        customerId,
        occurrenceId,
      });

      if (existing) {
        totalSkipped++;
        lastCustomerId = customerId;
        continue;
      }

      // Destination verification gate
      if (!customer.destination?.destinationHash) {
        await recordExcludedCollectionEnrollment({
          tenantId,
          campaignId,
          version,
          customerId,
          occurrenceId,
          enrollmentKey,
          collection,
          now,
          exclusionReason: EXCLUSION_REASONS.DESTINATION_NOT_VERIFIED,
          explanation: 'No verified destination (no destinationHash)',
        });
        totalExcluded++;
        lastCustomerId = customerId;
        continue;
      }

      const minVerification = settings?.minDestinationVerification || 'CONFIRMED_BY_STAFF';
      if (!isDestinationVerified(customer.destination as any, minVerification)) {
        await recordExcludedCollectionEnrollment({
          tenantId,
          campaignId,
          version,
          customerId,
          occurrenceId,
          enrollmentKey,
          collection,
          now,
          destinationHash: customer.destination.destinationHash,
          exclusionReason: EXCLUSION_REASONS.DESTINATION_NOT_VERIFIED,
          explanation: `Destination verification level does not meet '${minVerification}'`,
        });
        totalExcluded++;
        lastCustomerId = customerId;
        continue;
      }

      // Contact gate: undeliverable check
      const destGate = await contactGateService.getGate(tenantId, customer.destination.destinationHash);
      if (contactGateService.isHealthUndeliverable(destGate, customer.destination.verifiedAt)) {
        await recordExcludedCollectionEnrollment({
          tenantId,
          campaignId,
          version,
          customerId,
          occurrenceId,
          enrollmentKey,
          collection,
          now,
          destinationHash: customer.destination.destinationHash,
          exclusionReason: EXCLUSION_REASONS.DESTINATION_UNDELIVERABLE,
          explanation: 'Destination is marked UNDELIVERABLE',
        });
        totalExcluded++;
        lastCustomerId = customerId;
        continue;
      }

      // Preference affinity scoring
      const normalizedPrefs = normalizePreferences(customer.preferences as any);
      const affinityResult = scoreAffinityForCollection(
        normalizedPrefs,
        collection.items as any,
        minAffinityScore
      );

      const eligibility = evaluateAffinityEligibility(affinityResult, minAffinityScore);
      if (!eligibility.eligible) {
        await recordExcludedCollectionEnrollment({
          tenantId,
          campaignId,
          version,
          customerId,
          occurrenceId,
          enrollmentKey,
          collection,
          now,
          destinationHash: customer.destination.destinationHash,
          exclusionReason: 'NO_PREFERENCE_MATCH',
          explanation: eligibility.explanation,
        });
        totalExcluded++;
        lastCustomerId = customerId;
        continue;
      }

      // Build executions from steps
      const steps = (version as any).steps || [];
      const anchorAt = collection.publishedAt;
      const executionDocs: any[] = [];
      const executionIds: string[] = [];

      for (let idx = 0; idx < steps.length; idx++) {
        const step = steps[idx];
        const delay = step.delay || { unit: 'HOURS', value: 2 };

        const timing = computeDueTimes(
          anchorAt,
          delay,
          {
            allowedSendingHours: settings?.allowedSendingHours || { start: '10:00', end: '19:00' },
            blackoutDates: settings?.blackoutDates || [],
            holidays: settings?.holidays || [],
            timezone: (version as any).timezone || settings?.timezone || 'Asia/Kolkata',
          },
          {
            outsideHoursPolicy: step.outsideHoursPolicy || 'DEFER_NEXT_DAY',
            maxDeferralHours: step.maxDeferralHours ?? 24,
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

        let stepState: string = EXECUTION_STATE.SCHEDULED;
        let skipReason: string | null = null;

        if (timing.isElapsed || timing.adjustedDueAt.getTime() <= now.getTime()) {
          stepState = EXECUTION_STATE.SKIPPED;
          skipReason = EXECUTION_REASONS.SKIPPED_ELAPSED;
        } else if (timing.isDeferred) {
          stepState = EXECUTION_STATE.DEFERRED;
        }

        executionDocs.push({
          executionId,
          executionKey: `${enrollmentKey.replace(/:/g, '_')}:${step.stepId}`,
          tenantId,
          campaignId,
          enrollmentId: 'placeholder', // overwritten below
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

      // Create enrollment
      const enrollmentId = `enr_${crypto.randomUUID().slice(0, 12)}`;
      for (const doc of executionDocs) {
        doc.enrollmentId = enrollmentId;
      }

      const campaignVersionId =
        (version as any)._id?.toString() ||
        (version as any).campaignVersionId ||
        `ver_${campaignId}_${(version as any).version}`;

      try {
        await CampaignEnrollmentModel.create({
          enrollmentId,
          enrollmentKey,
          tenantId,
          campaignId,
          campaignVersionId,
          campaignVersion: (version as any).version,
          customerId,
          occurrenceId,
          sourceRef: {
            type: 'SRC_COLLECTIONS',
            id: collection.releaseId,
            version: collection.entityVersion,
          },
          occasionLocalDate: anchorAt.toISOString().split('T')[0],
          anchorAt,
          status: ENROLLMENT_STATUS.ACTIVE,
          destinationHash: customer.destination.destinationHash,
          planRevision: 1,
          matchExplanation: affinityResult.explanation,
          // F26-specific context stored in enrollment
          releaseId: collection.releaseId,
          affinityScore: affinityResult.score,
          matchSnapshot: {
            releaseId: collection.releaseId,
            title: collection.title || null,
            bestMatchItem: affinityResult.bestMatchItem
              ? {
                  productId: affinityResult.bestMatchItem.productId,
                  name: affinityResult.bestMatchItem.name,
                  category: affinityResult.bestMatchItem.category,
                }
              : null,
            normalizedPrefs: {
              weaves: normalizedPrefs.weaves,
              colourFamilies: normalizedPrefs.colourFamilies,
              sizes: normalizedPrefs.sizes,
              categories: normalizedPrefs.categories,
              source: normalizedPrefs.source,
            },
          },
        });

        if (executionDocs.length > 0) {
          await CampaignExecutionModel.insertMany(executionDocs);
        }
        totalEnrolled++;
      } catch (err: any) {
        if (err.code === 11000) {
          // Duplicate key: already enrolled concurrently — treat as skip
          totalSkipped++;
        } else {
          logger.error(
            { err: err.message, tenantId, campaignId, customerId, releaseId: collection.releaseId },
            '[F26] Error enrolling customer for matching_collection'
          );
        }
      }

      lastCustomerId = customerId;
    }

    // Update checkpoint after each batch
    checkpoint.processedCount = (checkpoint.processedCount || 0) + customers.length;
    checkpoint.enrolledCount = (checkpoint.enrolledCount || 0) + totalEnrolled;
    checkpoint.lastCustomerId = lastCustomerId;
    await checkpoint.save();

    if (customers.length < BATCH_SIZE) {
      isComplete = true;
      break;
    }
  }

  // Finalise checkpoint
  checkpoint.status = isComplete ? 'COMPLETED' : 'IN_PROGRESS';
  checkpoint.completedAt = isComplete ? now : undefined;
  checkpoint.leaseToken = null;
  checkpoint.leaseExpiresAt = null;
  await checkpoint.save();

  logger.info(
    {
      tenantId,
      campaignId,
      releaseId: collection.releaseId,
      totalEnrolled,
      totalExcluded,
      totalSkipped,
      checkpointStatus: checkpoint.status,
    },
    '[F26] Collection fan-out complete'
  );

  return {
    campaignId,
    enrolled: totalEnrolled,
    excluded: totalExcluded,
    skipped: totalSkipped,
    checkpointId: checkpoint.id,
    status: checkpoint.status as any,
    durationMs: Date.now() - start,
  };
}

/**
 * Records an excluded enrollment document (idempotent; ignores duplicate key errors).
 */
async function recordExcludedCollectionEnrollment(params: {
  tenantId: string;
  campaignId: string;
  version: ICampaignVersion;
  customerId: string;
  occurrenceId: string;
  enrollmentKey: string;
  collection: ISrcCollection;
  now: Date;
  destinationHash?: string | null;
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
    collection,
    now,
    destinationHash,
    exclusionReason,
    explanation,
  } = params;

  try {
    const enrollmentId = `enr_${crypto.randomUUID().slice(0, 12)}`;
    const campaignVersionId =
      (version as any)._id?.toString() ||
      (version as any).campaignVersionId ||
      `ver_${campaignId}_${(version as any).version}`;

    await CampaignEnrollmentModel.create({
      enrollmentId,
      enrollmentKey,
      tenantId,
      campaignId,
      campaignVersionId,
      campaignVersion: (version as any).version,
      customerId,
      occurrenceId,
      sourceRef: {
        type: 'SRC_COLLECTIONS',
        id: collection.releaseId,
        version: collection.entityVersion,
      },
      occasionLocalDate: 'EXCLUDED',
      anchorAt: collection.publishedAt,
      destinationHash: destinationHash || null,
      matchExplanation: explanation,
      status: ENROLLMENT_STATUS.EXCLUDED,
      exclusionReason,
      planRevision: 1,
      releaseId: collection.releaseId,
    });
  } catch (err: any) {
    if (err.code !== 11000) {
      logger.error(
        { err, tenantId, campaignId, occurrenceId },
        '[F26] Failed to record excluded collection enrollment'
      );
    }
  }
}

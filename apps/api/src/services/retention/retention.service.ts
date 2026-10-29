import mongoose from 'mongoose';
import {
  CampaignEnrollmentModel,
  CampaignExecutionModel,
  CampaignTombstoneModel,
} from '../../db/models';
import { logger } from '../../logger/logger';
import { PruneCampaignDataInput } from '@grovastra/shared';

export interface PruneResult {
  tenantId: string;
  campaignId?: string;
  cutoffDate: Date;
  prunedEnrollmentsCount: number;
  prunedExecutionsCount: number;
  tombstonesCreatedCount: number;
  durationMs: number;
}

export class RetentionService {
  /**
   * Prunes completed or cancelled campaign enrollments and executions older than the cutoff threshold,
   * preserving unique logical-key tombstones (Spec p18, p25, QA Matrix B18).
   *
   * Crucial Spec Rules:
   * 1. Tombstone creation and detail removal MUST be atomic (in a single Mongo transaction).
   * 2. Re-enrollment must check both live and retained keys.
   * 3. Annual replay protection lasts for the campaign lifetime.
   */
  async pruneCampaignData(
    tenantId: string,
    options: PruneCampaignDataInput = { cutoffDays: 90, retentionReason: 'DATA_RETENTION_PRUNING' }
  ): Promise<PruneResult> {
    const startedAt = Date.now();
    const cutoffDays = options.cutoffDays || 90;
    const cutoffDate = new Date(Date.now() - cutoffDays * 86400000);
    const retentionReason = options.retentionReason || 'DATA_RETENTION_PRUNING';

    const query: Record<string, any> = {
      tenantId,
      status: { $in: ['COMPLETED', 'CANCELLED'] },
      updatedAt: { $lte: cutoffDate },
    };

    if (options.campaignId) {
      query.campaignId = options.campaignId;
    }

    // Find candidates to prune
    const candidates = await CampaignEnrollmentModel.find(query).limit(500).lean();

    if (candidates.length === 0) {
      return {
        tenantId,
        campaignId: options.campaignId,
        cutoffDate,
        prunedEnrollmentsCount: 0,
        prunedExecutionsCount: 0,
        tombstonesCreatedCount: 0,
        durationMs: Date.now() - startedAt,
      };
    }

    let prunedEnrollmentsCount = 0;
    let prunedExecutionsCount = 0;
    let tombstonesCreatedCount = 0;

    // Process in atomic transactions
    const session = await mongoose.startSession();

    try {
      await session.withTransaction(async () => {
        const candidateEnrollmentIds = candidates.map((c) => c.enrollmentId);

        // Fetch all executions belonging to these enrollments
        const executions = await CampaignExecutionModel.find({
          tenantId,
          enrollmentId: { $in: candidateEnrollmentIds },
        }).lean();

        const tombstonesToInsert: any[] = [];

        // 1. Enrollment tombstones
        for (const enr of candidates) {
          tombstonesToInsert.push({
            tenantId,
            type: 'ENROLLMENT',
            key: enr.enrollmentKey,
            campaignId: enr.campaignId,
            customerId: enr.customerId,
            occurrenceId: enr.occurrenceId,
            tombstonedAt: new Date(),
            originalId: enr.enrollmentId,
            retentionReason,
            metadata: {
              status: enr.status,
              occasionLocalDate: enr.occasionLocalDate,
              campaignVersion: enr.campaignVersion,
              replyAttribution: enr.replyAttribution,
              goalReachedAt: enr.goalReachedAt,
            },
          });
        }

        // 2. Execution tombstones
        for (const exe of executions) {
          tombstonesToInsert.push({
            tenantId,
            type: 'EXECUTION',
            key: exe.executionKey,
            campaignId: exe.campaignId,
            customerId: candidates.find((c) => c.enrollmentId === exe.enrollmentId)?.customerId || 'unknown',
            stepId: exe.stepId,
            tombstonedAt: new Date(),
            originalId: exe.executionId,
            retentionReason,
            metadata: {
              state: exe.state,
              dueAt: exe.dueAt,
              skipReason: exe.skipReason,
              providerMessageId: exe.providerMessageId,
            },
          });
        }

        // Atomic: Insert tombstones FIRST
        if (tombstonesToInsert.length > 0) {
          try {
            await CampaignTombstoneModel.insertMany(tombstonesToInsert, {
              session,
              ordered: false,
            });
          } catch (err: any) {
            // Ignore duplicate key if already tombstoned
            if (err.code !== 11000 && !err.message?.includes('duplicate key')) {
              throw err;
            }
          }
        }

        // Atomic: Delete detailed records in the same transaction
        await CampaignExecutionModel.deleteMany(
          {
            tenantId,
            enrollmentId: { $in: candidateEnrollmentIds },
          },
          { session }
        );

        await CampaignEnrollmentModel.deleteMany(
          {
            tenantId,
            enrollmentId: { $in: candidateEnrollmentIds },
          },
          { session }
        );

        prunedEnrollmentsCount = candidates.length;
        prunedExecutionsCount = executions.length;
        tombstonesCreatedCount = tombstonesToInsert.length;
      });
    } finally {
      await session.endSession();
    }

    logger.info(
      {
        tenantId,
        prunedEnrollmentsCount,
        prunedExecutionsCount,
        tombstonesCreatedCount,
      },
      'Retention pruning completed atomically with tombstones'
    );

    return {
      tenantId,
      campaignId: options.campaignId,
      cutoffDate,
      prunedEnrollmentsCount,
      prunedExecutionsCount,
      tombstonesCreatedCount,
      durationMs: Date.now() - startedAt,
    };
  }

  /**
   * Checks whether an enrollment logical key is retained/tombstoned (Spec p18, p25, QA Matrix B18).
   */
  async isEnrollmentTombstoned(
    tenantId: string,
    enrollmentKey: string
  ): Promise<boolean> {
    const exists = await CampaignTombstoneModel.exists({
      tenantId,
      type: 'ENROLLMENT',
      key: enrollmentKey,
    });
    return Boolean(exists);
  }

  /**
   * Checks whether a step execution logical key is retained/tombstoned (Spec p18, p25, QA Matrix B18).
   */
  async isExecutionTombstoned(
    tenantId: string,
    executionKey: string
  ): Promise<boolean> {
    const exists = await CampaignTombstoneModel.exists({
      tenantId,
      type: 'EXECUTION',
      key: executionKey,
    });
    return Boolean(exists);
  }
}

export const retentionService = new RetentionService();

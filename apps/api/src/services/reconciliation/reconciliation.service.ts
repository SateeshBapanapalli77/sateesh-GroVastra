import crypto from 'crypto';
import {
  CampaignCheckpointModel,
  CampaignExecutionModel,
  CampaignDeliveryIntentModel,
  CampaignEventInboxModel,
  TenantModel,
} from '../../db/models';
import { clock } from '../clock';
import { logger } from '../../logger/logger';
import { sweepStaleDispatching } from '../../adapters/whatsapp-delivery';
import { eventConsumerService } from '../event-consumer';
import { ReconciliationResult } from '@grovastra/shared';

export class ReconciliationService {
  /**
   * Nightly reconciliation job (Spec p18, p25, p34):
   * Bounded and checkpointed sweeps for:
   * 1. Stalled leases (planner checkpoints and worker claims)
   * 2. Orphaned intents and swept dispatching executions (C07)
   * 3. Expired steps (missed dueAt or expiresAt)
   * 4. Missed domain events (pending in inbox > 10m)
   */
  async runNightlyReconciliation(targetTenantId?: string): Promise<ReconciliationResult[]> {
    const tenants = targetTenantId
      ? [{ tenantId: targetTenantId }]
      : await TenantModel.find({ status: 'active' }).select('tenantId').lean();

    const results: ReconciliationResult[] = [];

    for (const t of tenants) {
      const res = await this.reconcileTenant(t.tenantId);
      results.push(res);
    }

    return results;
  }

  async reconcileTenant(tenantId: string): Promise<ReconciliationResult> {
    const startedAt = clock.now();
    const details: string[] = [];
    const checkpointId = `rec_${crypto.randomUUID().slice(0, 12)}`;

    // 1. Acquire distributed lease on reconciliation checkpoint (Spec p25, p34)
    const leaseToken = crypto.randomUUID();
    const leaseExpiresAt = new Date(startedAt.getTime() + 5 * 60 * 1000); // 5 min lease

    await CampaignCheckpointModel.findOneAndUpdate(
      {
        tenantId,
        campaignId: 'system',
        type: 'RECONCILIATION',
        $or: [
          { status: { $ne: 'IN_PROGRESS' } },
          { leaseExpiresAt: { $lt: startedAt } },
          { leaseExpiresAt: null },
        ],
      },
      {
        $set: {
          status: 'IN_PROGRESS',
          leaseToken,
          leaseExpiresAt,
          startedAt,
          error: null,
        },
      },
      { upsert: true, new: true }
    );

    let stalledLeasesReleased = 0;
    let orphanedIntentsCleaned = 0;
    let expiredStepsMarked = 0;
    let missedEventsProcessed = 0;
    let totalScanned = 0;

    try {
      // 2. STALLED LEASES
      // A. Checkpoints with expired leases
      const stalledCheckpoints = await CampaignCheckpointModel.find({
        tenantId,
        type: { $ne: 'RECONCILIATION' },
        status: 'IN_PROGRESS',
        leaseExpiresAt: { $lt: startedAt },
      });

      for (const cp of stalledCheckpoints) {
        await CampaignCheckpointModel.updateOne(
          { _id: cp._id, status: 'IN_PROGRESS' },
          {
            $set: {
              status: 'IDLE',
              leaseToken: null,
              leaseExpiresAt: null,
              error: 'Recovered by nightly reconciliation from stalled lease',
            },
          }
        );
        stalledLeasesReleased++;
        details.push(`Released stalled checkpoint lease for ${cp.type} (${cp.campaignId})`);
      }

      // B. Worker EVALUATING leases that expired
      const staleEvaluatingExecutions = await CampaignExecutionModel.find({
        tenantId,
        state: 'EVALUATING',
        'lease.until': { $lt: startedAt },
      });

      for (const ex of staleEvaluatingExecutions) {
        await CampaignExecutionModel.updateOne(
          { tenantId, executionId: ex.executionId, state: 'EVALUATING' },
          {
            $set: {
              state: 'SCHEDULED',
              'lease.token': null,
              'lease.until': null,
            },
          }
        );
        stalledLeasesReleased++;
        details.push(`Reset stalled EVALUATING execution ${ex.executionId} back to SCHEDULED`);
      }

      // 3. ORPHANED INTENTS & STALE DISPATCHING
      // A. Sweep stale dispatching > 60s into OUTCOME_UNKNOWN (C07)
      const sweptCount = await sweepStaleDispatching(60000);
      if (sweptCount > 0) {
        orphanedIntentsCleaned += sweptCount;
        details.push(`Swept ${sweptCount} stale DISPATCHING executions into OUTCOME_UNKNOWN`);
      }

      // B. Orphaned delivery intents where execution is terminal/unknown
      const staleIntents = await CampaignDeliveryIntentModel.find({
        tenantId,
        state: { $in: ['PREPARED_DRY', 'PENDING_SUBMISSION'] },
        createdAt: { $lt: new Date(startedAt.getTime() - 15 * 60 * 1000) },
      });

      for (const di of staleIntents) {
        await CampaignDeliveryIntentModel.updateOne(
          { tenantId, deliveryIntentId: di.deliveryIntentId },
          {
            $set: {
              state: 'FAILED',
              lastErrorCategory: 'ORPHANED_INTENT_RECONCILED',
            },
          }
        );
        orphanedIntentsCleaned++;
        details.push(`Marked orphaned delivery intent ${di.deliveryIntentId} as FAILED`);
      }

      // 4. EXPIRED STEPS (Missed steps beyond lateness window)
      const expiredExecutions = await CampaignExecutionModel.find({
        tenantId,
        state: { $in: ['SCHEDULED', 'DEFERRED'] },
        expiresAt: { $lt: startedAt },
      });

      for (const ex of expiredExecutions) {
        await CampaignExecutionModel.updateOne(
          { tenantId, executionId: ex.executionId, state: { $in: ['SCHEDULED', 'DEFERRED'] } },
          {
            $set: {
              state: 'EXPIRED',
              skipReason: 'RECONCILIATION_STEP_EXPIRED',
            },
          }
        );
        expiredStepsMarked++;
        details.push(`Marked expired execution ${ex.executionId} as EXPIRED`);
      }

      // 5. MISSED DOMAIN EVENTS
      const pendingEventsCount = await CampaignEventInboxModel.countDocuments({
        tenantId,
        status: 'PENDING',
        createdAt: { $lt: new Date(startedAt.getTime() - 10 * 60 * 1000) },
      });

      if (pendingEventsCount > 0) {
        const batchRes = await eventConsumerService.processPendingEvents({
          tenantId,
          limit: 50,
        });
        missedEventsProcessed += batchRes.processedCount;
        details.push(`Processed ${batchRes.processedCount} backlogged events`);
      }

      totalScanned =
        stalledLeasesReleased +
        orphanedIntentsCleaned +
        expiredStepsMarked +
        missedEventsProcessed;

      // 6. Complete checkpoint
      const completedAt = clock.now();
      const durationMs = completedAt.getTime() - startedAt.getTime();

      await CampaignCheckpointModel.updateOne(
        { tenantId, campaignId: 'system', type: 'RECONCILIATION' },
        {
          $set: {
            status: 'COMPLETED',
            leaseToken: null,
            leaseExpiresAt: null,
            completedAt,
            processedCount: totalScanned,
          },
        }
      );

      logger.info(
        {
          tenantId,
          stalledLeasesReleased,
          orphanedIntentsCleaned,
          expiredStepsMarked,
          missedEventsProcessed,
          durationMs,
        },
        'Reconciliation job completed successfully'
      );

      return {
        checkpointId,
        tenantId,
        startedAt: startedAt.toISOString(),
        completedAt: completedAt.toISOString(),
        durationMs,
        status: 'COMPLETED',
        counts: {
          stalledLeasesReleased,
          orphanedIntentsCleaned,
          expiredStepsMarked,
          missedEventsProcessed,
          totalScanned,
        },
        details,
      };
    } catch (err: any) {
      logger.error({ tenantId, err }, 'Reconciliation job failed');
      await CampaignCheckpointModel.updateOne(
        { tenantId, campaignId: 'system', type: 'RECONCILIATION' },
        {
          $set: {
            status: 'FAILED',
            leaseToken: null,
            leaseExpiresAt: null,
            error: err.message,
          },
        }
      );

      return {
        checkpointId,
        tenantId,
        startedAt: startedAt.toISOString(),
        completedAt: clock.now().toISOString(),
        durationMs: Date.now() - startedAt.getTime(),
        status: 'FAILED',
        counts: {
          stalledLeasesReleased,
          orphanedIntentsCleaned,
          expiredStepsMarked,
          missedEventsProcessed,
          totalScanned,
        },
        details: [...details, `Error: ${err.message}`],
      };
    }
  }
}

export const reconciliationService = new ReconciliationService();

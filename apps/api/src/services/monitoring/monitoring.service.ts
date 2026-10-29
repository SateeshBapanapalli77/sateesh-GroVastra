import {
  CampaignModel,
  CampaignVersionModel,
  CampaignExecutionModel,
  CampaignEventInboxModel,
  CampaignCheckpointModel,
  CampaignContactGateModel,
} from '../../db/models';
import { clock } from '../clock';
import { EXECUTION_STATE, OperationalMetrics } from '@grovastra/shared';

export class MonitoringService {
  /**
   * Computes operational safeguards metrics per Spec p34:
   * - Planner lag
   * - Due-step age
   * - Skipped reasons
   * - Event backlog
   * - OUTCOME_UNKNOWN count
   * - Template blocks
   * - Stalled checkpoint alerts
   * - Tenant-fair processing indicators
   */
  async getOperationalMetrics(tenantId: string): Promise<OperationalMetrics> {
    const now = clock.now();
    const nowMs = now.getTime();

    // 1. Planner Lag (Spec p34)
    const activeCampaigns = await CampaignModel.find({
      tenantId,
      status: 'ACTIVE',
    })
      .select('campaignId name nextEvaluationAt activeVersionId')
      .lean();

    const activeCampaignIds = activeCampaigns.map((c) => c.campaignId);
    const versions = await CampaignVersionModel.find({
      tenantId,
      campaignId: { $in: activeCampaignIds },
      isPublished: true,
    })
      .select('campaignId nextEvaluationAt')
      .lean();

    const versionMap = new Map<string, any>();
    for (const v of versions) {
      versionMap.set(v.campaignId, v);
    }

    let maxLagMs = 0;
    let overdueCampaignsCount = 0;
    const campaignLags: Array<{
      campaignId: string;
      campaignName: string;
      nextEvaluationAt: string;
      lagMs: number;
    }> = [];

    for (const c of activeCampaigns) {
      const evalAt = (c as any).nextEvaluationAt || versionMap.get(c.campaignId)?.nextEvaluationAt;
      if (evalAt) {
        const evalTime = new Date(evalAt).getTime();
        const lag = Math.max(0, nowMs - evalTime);
        if (lag > 0) overdueCampaignsCount++;
        if (lag > maxLagMs) maxLagMs = lag;
        campaignLags.push({
          campaignId: c.campaignId,
          campaignName: c.name,
          nextEvaluationAt: new Date(evalAt).toISOString(),
          lagMs: lag,
        });
      }
    }

    // 2. Due-Step Age (Spec p34)
    const dueExecutions = await CampaignExecutionModel.find({
      tenantId,
      state: { $in: [EXECUTION_STATE.SCHEDULED, EXECUTION_STATE.DEFERRED] },
      dueAt: { $lte: now },
    })
      .select('dueAt state')
      .lean();

    let maxAgeMs = 0;
    let totalAgeMs = 0;
    for (const ex of dueExecutions) {
      const age = Math.max(0, nowMs - new Date(ex.dueAt).getTime());
      if (age > maxAgeMs) maxAgeMs = age;
      totalAgeMs += age;
    }
    const avgAgeMs = dueExecutions.length > 0 ? Math.round(totalAgeMs / dueExecutions.length) : 0;

    // 3. Skipped Reasons (Spec p28, p34)
    const skippedRecords = await CampaignExecutionModel.aggregate([
      {
        $match: {
          tenantId,
          state: {
            $in: [
              EXECUTION_STATE.SKIPPED,
              EXECUTION_STATE.CANCELLED,
              EXECUTION_STATE.EXPIRED,
              EXECUTION_STATE.BLOCKED,
            ],
          },
        },
      },
      {
        $group: {
          _id: { $ifNull: ['$skipReason', 'UNSPECIFIED_REASON'] },
          count: { $sum: 1 },
        },
      },
      { $sort: { count: -1 } },
    ]);

    const totalSkipped = skippedRecords.reduce((sum, r) => sum + r.count, 0);
    const skippedReasons = skippedRecords.map((r) => ({
      reason: r._id,
      count: r.count,
      percentage: totalSkipped > 0 ? Number(((r.count / totalSkipped) * 100).toFixed(1)) : 0,
    }));

    // 4. Event Backlog (Spec p34)
    const [pendingEvents, quarantinedCount] = await Promise.all([
      CampaignEventInboxModel.find({ tenantId, status: 'PENDING' })
        .sort({ occurredAt: 1 })
        .select('occurredAt createdAt')
        .lean(),
      CampaignEventInboxModel.countDocuments({ tenantId, status: 'QUARANTINED' }),
    ]);

    const oldestPendingAgeMs =
      pendingEvents.length > 0
        ? Math.max(0, nowMs - new Date(pendingEvents[0].createdAt || pendingEvents[0].occurredAt).getTime())
        : 0;

    // 5. Unknown Send Outcomes (Spec p27, p34, C06, C07)
    const outcomeUnknownCount = await CampaignExecutionModel.countDocuments({
      tenantId,
      state: EXECUTION_STATE.OUTCOME_UNKNOWN,
    });

    // 6. Template Blocks (Spec p27, p34, C02, C19)
    const blockedExecutions = await CampaignExecutionModel.find({
      tenantId,
      state: EXECUTION_STATE.BLOCKED,
    })
      .select('campaignId skipReason')
      .lean();

    const affectedCampaigns = Array.from(new Set(blockedExecutions.map((x) => x.campaignId)));

    // 7. Stalled Checkpoints (Spec p34)
    const checkpoints = await CampaignCheckpointModel.find({
      tenantId,
      status: 'IN_PROGRESS',
    }).lean();

    const stalledCheckpoints: Array<{
      campaignId: string;
      type: string;
      status: string;
      stalledDurationMs: number;
      leaseExpiresAt: string | null;
    }> = [];

    for (const cp of checkpoints) {
      const leaseExpiry = cp.leaseExpiresAt ? new Date(cp.leaseExpiresAt).getTime() : 0;
      const started = cp.startedAt ? new Date(cp.startedAt).getTime() : nowMs;
      if (leaseExpiry < nowMs || nowMs - started > 15 * 60 * 1000) {
        stalledCheckpoints.push({
          campaignId: cp.campaignId,
          type: cp.type,
          status: cp.status,
          stalledDurationMs: nowMs - started,
          leaseExpiresAt: cp.leaseExpiresAt ? new Date(cp.leaseExpiresAt).toISOString() : null,
        });
      }
    }

    // 8. Tenant Fair Processing (Spec p18, p34)
    const contactGate = await CampaignContactGateModel.find({ tenantId }).lean();
    let activeReservations = 0;
    let rolling24hContacts = 0;
    const oneDayAgo = nowMs - 24 * 60 * 60 * 1000;

    for (const cg of contactGate) {
      for (const entry of (cg as any).ledger || []) {
        if (entry.status === 'RESERVED') activeReservations++;
        if (new Date(entry.reservedAt).getTime() >= oneDayAgo && entry.status === 'ACCEPTED') {
          rolling24hContacts++;
        }
      }
    }

    // 9. Health Status & Actionable Alerts
    const alerts: Array<{
      severity: 'INFO' | 'WARNING' | 'CRITICAL';
      component: string;
      message: string;
    }> = [];

    if (stalledCheckpoints.length > 0) {
      alerts.push({
        severity: 'CRITICAL',
        component: 'Checkpoints',
        message: `${stalledCheckpoints.length} stalled checkpoint lease(s) detected. Run nightly reconciliation to auto-recover.`,
      });
    }

    if (outcomeUnknownCount > 0) {
      alerts.push({
        severity: 'WARNING',
        component: 'Delivery Worker',
        message: `${outcomeUnknownCount} execution(s) in OUTCOME_UNKNOWN state. Verify provider status before manual resolution.`,
      });
    }

    if (blockedExecutions.length > 0) {
      alerts.push({
        severity: 'WARNING',
        component: 'Templates',
        message: `${blockedExecutions.length} step(s) blocked across ${affectedCampaigns.length} campaign(s) due to template status or category mismatch.`,
      });
    }

    if (maxLagMs > 15 * 60 * 1000) {
      alerts.push({
        severity: 'WARNING',
        component: 'Calendar Planner',
        message: `High planner lag detected: ${this.formatDuration(maxLagMs)} overdue across active campaigns.`,
      });
    }

    if (pendingEvents.length > 100 || oldestPendingAgeMs > 30 * 60 * 1000) {
      alerts.push({
        severity: 'WARNING',
        component: 'Event Consumer',
        message: `Event backlog elevated: ${pendingEvents.length} pending events (oldest: ${this.formatDuration(oldestPendingAgeMs)} old).`,
      });
    }

    let healthStatus: 'HEALTHY' | 'DEGRADED' | 'CRITICAL' = 'HEALTHY';
    if (alerts.some((a) => a.severity === 'CRITICAL')) {
      healthStatus = 'CRITICAL';
    } else if (alerts.some((a) => a.severity === 'WARNING')) {
      healthStatus = 'DEGRADED';
    }

    return {
      tenantId,
      generatedAt: now.toISOString(),
      plannerLag: {
        maxLagMs,
        maxLagFormatted: this.formatDuration(maxLagMs),
        overdueCampaignsCount,
        campaigns: campaignLags,
      },
      dueStepAge: {
        maxAgeMs,
        maxAgeFormatted: this.formatDuration(maxAgeMs),
        avgAgeMs,
        dueStepCount: dueExecutions.length,
      },
      skippedReasons,
      eventBacklog: {
        pendingCount: pendingEvents.length,
        oldestPendingAgeMs,
        quarantinedCount,
      },
      outcomeUnknownCount,
      templateBlocks: {
        blockedExecutionsCount: blockedExecutions.length,
        affectedCampaigns,
      },
      stalledCheckpoints,
      tenantFairProcessing: {
        activeReservations,
        rolling24hContacts,
        fairShareIndex: Math.min(100, Math.round(100 - activeReservations * 5)),
      },
      healthStatus,
      alerts,
    };
  }

  private formatDuration(ms: number): string {
    if (ms <= 0) return '0s';
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const remSec = seconds % 60;
    if (minutes < 60) return `${minutes}m ${remSec}s`;
    const hours = Math.floor(minutes / 60);
    const remMin = minutes % 60;
    return `${hours}h ${remMin}m`;
  }
}

export const monitoringService = new MonitoringService();

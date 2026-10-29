import { Router, Request, Response, NextFunction } from 'express';
import { authenticate, requireRole } from '../middleware/auth';
import { monitoringService } from '../services/monitoring';
import { reconciliationService } from '../services/reconciliation';
import { retentionService } from '../services/retention';
import { PruneCampaignDataInputSchema } from '@grovastra/shared';
import { ValidationError } from '../errors/app-error';

export const monitoringRouter = Router();

// Base authentication for all monitoring routes
monitoringRouter.use(authenticate);

/**
 * GET /monitoring/operational-metrics & /api/v1/monitoring/operational-metrics
 * Returns comprehensive operational safeguards metrics per Spec p34:
 * planner lag, due-step age, skipped reasons, event backlog, outcome unknown,
 * template blocks, stalled checkpoints, and tenant-fair processing.
 */
async function getOperationalMetricsHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const tenantId = req.tenantContext!.tenantId;
    const metrics = await monitoringService.getOperationalMetrics(tenantId);
    res.status(200).json(metrics);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /monitoring/system-health & /api/v1/monitoring/system-health
 * Returns concise system health status and actionable alerts for dashboard badges.
 */
async function getSystemHealthHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const tenantId = req.tenantContext!.tenantId;
    const metrics = await monitoringService.getOperationalMetrics(tenantId);
    res.status(200).json({
      tenantId: metrics.tenantId,
      status: metrics.healthStatus,
      alerts: metrics.alerts,
      summary: {
        plannerLagFormatted: metrics.plannerLag.maxLagFormatted,
        overdueCampaigns: metrics.plannerLag.overdueCampaignsCount,
        dueStepAgeFormatted: metrics.dueStepAge.maxAgeFormatted,
        outcomeUnknownCount: metrics.outcomeUnknownCount,
        templateBlocksCount: metrics.templateBlocks.blockedExecutionsCount,
        eventBacklogCount: metrics.eventBacklog.pendingCount,
        stalledCheckpointsCount: metrics.stalledCheckpoints.length,
      },
      generatedAt: metrics.generatedAt,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /monitoring/reconciliation/run & /api/v1/monitoring/reconciliation/run
 * Manually triggers bounded nightly reconciliation job for the authenticated tenant (Spec p18, p34).
 */
async function runReconciliationHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const tenantId = req.tenantContext!.tenantId;
    const result = await reconciliationService.reconcileTenant(tenantId);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

/**
 * POST /monitoring/retention/run & /api/v1/monitoring/retention/run
 * Manually triggers atomic data retention pruning with tombstones (Spec p18, p25, QA Matrix B18).
 */
async function runRetentionPruningHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const tenantId = req.tenantContext!.tenantId;
    const parseResult = PruneCampaignDataInputSchema.safeParse(req.body);
    if (!parseResult.success) {
      throw new ValidationError(
        parseResult.error.errors[0]?.message || 'Invalid retention pruning options',
        parseResult.error.format()
      );
    }

    const result = await retentionService.pruneCampaignData(tenantId, parseResult.data);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

// Mount routes (accessible to owner & admin)
monitoringRouter.get('/monitoring/operational-metrics', requireRole('owner', 'admin'), getOperationalMetricsHandler);
monitoringRouter.get('/api/v1/monitoring/operational-metrics', requireRole('owner', 'admin'), getOperationalMetricsHandler);

monitoringRouter.get('/monitoring/system-health', requireRole('owner', 'admin'), getSystemHealthHandler);
monitoringRouter.get('/api/v1/monitoring/system-health', requireRole('owner', 'admin'), getSystemHealthHandler);

monitoringRouter.post('/monitoring/reconciliation/run', requireRole('owner', 'admin'), runReconciliationHandler);
monitoringRouter.post('/api/v1/monitoring/reconciliation/run', requireRole('owner', 'admin'), runReconciliationHandler);

monitoringRouter.post('/monitoring/retention/run', requireRole('owner', 'admin'), runRetentionPruningHandler);
monitoringRouter.post('/api/v1/monitoring/retention/run', requireRole('owner', 'admin'), runRetentionPruningHandler);

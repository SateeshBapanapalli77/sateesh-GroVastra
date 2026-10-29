import { Router, Request, Response, NextFunction } from 'express';
import { authenticate, requireRole } from '../middleware/auth';
import { idempotencyMiddleware } from '../middleware/idempotency';
import { campaignService } from '../services/campaign.service';
import { dryRunService } from '../services/dry-run.service';
import { campaignActivityService } from '../services/campaign-activity.service';
import { plannerService } from '../services/planner';
import { workerService } from '../services/worker';
import { inactivityEvaluatorService } from '../services/inactivity-evaluator';
import { campaignReportingService } from '../services/campaign-reporting.service';

export const campaignRouter = Router();

// Base authentication for all campaign routes
campaignRouter.use(authenticate);

/**
 * GET /campaign-presets & /api/v1/campaign-presets
 * Accessible to owner, admin, and staff.
 * Returns supported presets, required triggers, and implemented capability flags (spec p5, p26).
 */
function getPresetsHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const presets = campaignService.listPresets();
    res.status(200).json(presets);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /campaigns & /api/v1/campaigns
 * Accessible to owner and admin only (staff receives 403).
 */
async function listCampaignsHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const tenantId = req.tenantContext!.tenantId;
    const campaigns = await campaignService.listCampaigns(tenantId);
    res.status(200).json(campaigns);
  } catch (err) {
    next(err);
  }
}

/**
 * POST /campaigns & /api/v1/campaigns
 * Creates a new campaign draft. Zero sends on create.
 * Accessible to owner and admin only.
 * Protected by idempotency-key middleware.
 */
async function createCampaignHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const tenantId = req.tenantContext!.tenantId;
    const userId = req.tenantContext!.userId;
    const ip = req.ip || req.socket?.remoteAddress;
    const userAgent = req.headers['user-agent'];

    const result = await campaignService.createDraft({
      tenantId,
      userId,
      input: req.body,
      ip,
      userAgent,
    });

    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /campaigns/:id & /api/v1/campaigns/:id
 * Retrieves draft, status, and control gate. Scoped strictly to authenticated tenant.
 * Accessible to owner and admin only.
 */
async function getCampaignHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const tenantId = req.tenantContext!.tenantId;
    const campaignId = req.params.id as string;

    const result = await campaignService.getCampaign(tenantId, campaignId);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

/**
 * PATCH /campaigns/:id/draft & /api/v1/campaigns/:id/draft
 * Updates allowlisted draft fields with expectedVersion check (HTTP 409 on conflict).
 * Accessible to owner and admin only.
 * Protected by idempotency-key middleware.
 */
async function updateDraftHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const tenantId = req.tenantContext!.tenantId;
    const userId = req.tenantContext!.userId;
    const campaignId = req.params.id as string;
    const ip = req.ip || req.socket?.remoteAddress;
    const userAgent = req.headers['user-agent'] as string | undefined;

    const result = await campaignService.updateDraft({
      tenantId,
      userId,
      campaignId,
      input: req.body,
      ip,
      userAgent,
    });

    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

/**
 * POST /campaigns/:id/validate & /api/v1/campaigns/:id/validate
 * Evaluates current draft against the full validation matrix.
 * Returns structured errors/warnings with fieldPath and resolutionOwner.
 * Accessible to owner and admin only.
 */
async function validateCampaignHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const tenantId = req.tenantContext!.tenantId;
    const campaignId = req.params.id as string;

    const report = await campaignService.validateDraft(tenantId, campaignId);
    res.status(200).json(report);
  } catch (err) {
    next(err);
  }
}

// Mount GET /campaign-presets
campaignRouter.get('/campaign-presets', getPresetsHandler);
campaignRouter.get('/api/v1/campaign-presets', getPresetsHandler);

// Mount GET /campaigns (owner/admin)
campaignRouter.get('/campaigns', requireRole('owner', 'admin'), listCampaignsHandler);
campaignRouter.get('/api/v1/campaigns', requireRole('owner', 'admin'), listCampaignsHandler);

// Mount POST /campaigns (owner/admin, idempotency required)
campaignRouter.post(
  '/campaigns',
  requireRole('owner', 'admin'),
  idempotencyMiddleware({ required: true }),
  createCampaignHandler
);
campaignRouter.post(
  '/api/v1/campaigns',
  requireRole('owner', 'admin'),
  idempotencyMiddleware({ required: true }),
  createCampaignHandler
);

// Mount GET /campaigns/overview/upcoming-activity (owner/admin/staff)
campaignRouter.get('/campaigns/overview/upcoming-activity', getUpcomingActivityHandler);
campaignRouter.get('/api/v1/campaigns/overview/upcoming-activity', getUpcomingActivityHandler);

// Mount GET /campaigns/:id (owner/admin)
campaignRouter.get('/campaigns/:id', requireRole('owner', 'admin'), getCampaignHandler);
campaignRouter.get('/api/v1/campaigns/:id', requireRole('owner', 'admin'), getCampaignHandler);

// Mount PATCH /campaigns/:id/draft (owner/admin, idempotency required)
campaignRouter.patch(
  '/campaigns/:id/draft',
  requireRole('owner', 'admin'),
  idempotencyMiddleware({ required: true }),
  updateDraftHandler
);
campaignRouter.patch(
  '/api/v1/campaigns/:id/draft',
  requireRole('owner', 'admin'),
  idempotencyMiddleware({ required: true }),
  updateDraftHandler
);

// Mount POST /campaigns/:id/validate (owner/admin)
campaignRouter.post(
  '/campaigns/:id/validate',
  requireRole('owner', 'admin'),
  validateCampaignHandler
);
campaignRouter.post(
  '/api/v1/campaigns/:id/validate',
  requireRole('owner', 'admin'),
  validateCampaignHandler
);

/**
 * POST /campaigns/:id/dry-runs & /api/v1/campaigns/:id/dry-runs
 * Executes read-only evaluation report. Zero live executions created (Spec p8, p26, C01).
 * Accessible to owner and admin only.
 */
async function executeDryRunHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const tenantId = req.tenantContext!.tenantId;
    const userId = req.tenantContext!.userId;
    const campaignId = req.params.id as string;
    const ip = req.ip || req.socket?.remoteAddress;
    const userAgent = req.headers['user-agent'];

    const result = await dryRunService.executeDryRun({
      tenantId,
      userId,
      campaignId,
      ip,
      userAgent,
    });

    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /campaigns/:id/dry-runs/latest & /api/v1/campaigns/:id/dry-runs/latest
 * Retrieves the latest dry run report with isStale calculation against current draft fingerprint.
 * Accessible to owner and admin only.
 */
async function getLatestDryRunHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const tenantId = req.tenantContext!.tenantId;
    const campaignId = req.params.id as string;

    const result = await dryRunService.getLatestDryRun(tenantId, campaignId);
    if (!result) {
      return res.status(404).json({
        error: {
          code: 'NOT_FOUND',
          message: `No dry run report found for campaign '${campaignId}'`,
        },
      });
    }

    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

// Mount POST /campaigns/:id/dry-runs (owner/admin)
campaignRouter.post(
  '/campaigns/:id/dry-runs',
  requireRole('owner', 'admin'),
  executeDryRunHandler
);
campaignRouter.post(
  '/api/v1/campaigns/:id/dry-runs',
  requireRole('owner', 'admin'),
  executeDryRunHandler
);

// Mount GET /campaigns/:id/dry-runs/latest (owner/admin)
campaignRouter.get(
  '/campaigns/:id/dry-runs/latest',
  requireRole('owner', 'admin'),
  getLatestDryRunHandler
);
campaignRouter.get(
  '/api/v1/campaigns/:id/dry-runs/latest',
  requireRole('owner', 'admin'),
  getLatestDryRunHandler
);

/**
 * POST /campaigns/:id/activate & /api/v1/campaigns/:id/activate
 * Activates a valid reviewed draft in ONE transaction (Spec p9, p20, p25).
 * Freezes immutable version snapshot, sets activeVersionId, returns next evaluation time.
 * Accessible to owner and admin only.
 */
async function activateCampaignHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const tenantId = req.tenantContext!.tenantId;
    const userId = req.tenantContext!.userId;
    const campaignId = req.params.id as string;
    const ip = req.ip || req.socket?.remoteAddress;
    const userAgent = req.headers['user-agent'] as string | undefined;

    const result = await campaignService.activateCampaign({
      tenantId,
      userId,
      campaignId,
      ip,
      userAgent,
    });

    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

/**
 * POST /campaigns/:id/publish-revision & /api/v1/campaigns/:id/publish-revision
 * Publishes a new immutable version revision N+1 for an active campaign (Spec p9, p20, p25, B14).
 * Accessible to owner and admin only.
 */
async function publishRevisionHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const tenantId = req.tenantContext!.tenantId;
    const userId = req.tenantContext!.userId;
    const campaignId = req.params.id as string;
    const expectedVersion = req.body?.expectedVersion;
    const ip = req.ip || req.socket?.remoteAddress;
    const userAgent = req.headers['user-agent'] as string | undefined;

    const result = await campaignService.publishRevision({
      tenantId,
      userId,
      campaignId,
      expectedVersion,
      ip,
      userAgent,
    });

    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /campaigns/:id/versions & /api/v1/campaigns/:id/versions
 * Returns all versions (published snapshots and working drafts) for a campaign.
 * Accessible to owner and admin.
 */
async function listCampaignVersionsHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const tenantId = req.tenantContext!.tenantId;
    const campaignId = req.params.id as string;

    const versions = await campaignService.listCampaignVersions(tenantId, campaignId);
    res.status(200).json(versions);
  } catch (err) {
    next(err);
  }
}

// Mount POST /campaigns/:id/activate (owner/admin, idempotency supported)
campaignRouter.post(
  '/campaigns/:id/activate',
  requireRole('owner', 'admin'),
  idempotencyMiddleware({ required: false }),
  activateCampaignHandler
);
campaignRouter.post(
  '/api/v1/campaigns/:id/activate',
  requireRole('owner', 'admin'),
  idempotencyMiddleware({ required: false }),
  activateCampaignHandler
);

// Mount POST /campaigns/:id/publish-revision (owner/admin, idempotency supported)
campaignRouter.post(
  '/campaigns/:id/publish-revision',
  requireRole('owner', 'admin'),
  idempotencyMiddleware({ required: false }),
  publishRevisionHandler
);
campaignRouter.post(
  '/api/v1/campaigns/:id/publish-revision',
  requireRole('owner', 'admin'),
  idempotencyMiddleware({ required: false }),
  publishRevisionHandler
);

// Mount GET /campaigns/:id/versions (owner/admin)
campaignRouter.get(
  '/campaigns/:id/versions',
  requireRole('owner', 'admin'),
  listCampaignVersionsHandler
);
campaignRouter.get(
  '/api/v1/campaigns/:id/versions',
  requireRole('owner', 'admin'),
  listCampaignVersionsHandler
);

/**
 * GET /campaigns/overview/upcoming-activity & /api/v1/campaigns/overview/upcoming-activity
 * Returns upcoming scheduled campaign activity across active campaigns for boutique overview.
 * Accessible to owner, admin, staff.
 */
async function getUpcomingActivityHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const tenantId = req.tenantContext!.tenantId;
    const limit = req.query.limit ? Number(req.query.limit) : 10;
    const result = await campaignActivityService.getUpcomingActivity(tenantId, limit);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /campaigns/:id/enrollments & /api/v1/campaigns/:id/enrollments
 * Returns paginated enrollments for a campaign with customer info and step summaries.
 * Accessible to owner, admin, staff (Spec p26).
 */
async function listEnrollmentsHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const tenantId = req.tenantContext!.tenantId;
    const campaignId = req.params.id as string;
    const status = req.query.status as string | undefined;
    const search = req.query.search as string | undefined;
    const page = req.query.page ? Number(req.query.page) : 1;
    const limit = req.query.limit ? Number(req.query.limit) : 20;

    const result = await campaignActivityService.listEnrollments({
      tenantId,
      campaignId,
      status,
      search,
      page,
      limit,
    });
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /campaigns/:id/enrollments/:enrollmentId & /api/v1/campaigns/:id/enrollments/:enrollmentId
 * Retrieves detailed enrollment info with customer profile and all execution steps.
 * Accessible to owner, admin, staff (Spec p26).
 */
async function getEnrollmentDetailHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const tenantId = req.tenantContext!.tenantId;
    const campaignId = req.params.id as string;
    const enrollmentId = req.params.enrollmentId as string;

    const result = await campaignActivityService.getEnrollmentDetail(tenantId, campaignId, enrollmentId);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

/**
 * POST /campaigns/:id/plan & /api/v1/campaigns/:id/plan
 * Manually triggers a planner evaluation run for the campaign.
 * Accessible to owner and admin.
 */
async function planCampaignHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const tenantId = req.tenantContext!.tenantId;
    const campaignId = req.params.id as string;
    const force = req.body?.force !== false;

    const result = await plannerService.planCampaign(tenantId, campaignId, { force });
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

// Mount GET /campaigns/:id/enrollments (owner/admin/staff)
campaignRouter.get('/campaigns/:id/enrollments', listEnrollmentsHandler);
campaignRouter.get('/api/v1/campaigns/:id/enrollments', listEnrollmentsHandler);

// Mount GET /campaigns/:id/enrollments/:enrollmentId (owner/admin/staff)
campaignRouter.get('/campaigns/:id/enrollments/:enrollmentId', getEnrollmentDetailHandler);
campaignRouter.get('/api/v1/campaigns/:id/enrollments/:enrollmentId', getEnrollmentDetailHandler);

// Mount POST /campaigns/:id/plan (owner/admin)
campaignRouter.post('/campaigns/:id/plan', requireRole('owner', 'admin'), planCampaignHandler);
campaignRouter.post('/api/v1/campaigns/:id/plan', requireRole('owner', 'admin'), planCampaignHandler);

/**
 * POST /campaigns/:id/evaluate-inactivity & /api/v1/campaigns/:id/evaluate-inactivity
 * Evaluates due win-back inactivity occurrences.
 */
async function evaluateInactivityHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const tenantId = req.tenantContext!.tenantId;
    const campaignId = req.params.id as string;
    const force = req.body?.force !== false;

    const result = await inactivityEvaluatorService.evaluateCampaign(tenantId, campaignId, { force });
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

campaignRouter.post('/campaigns/:id/evaluate-inactivity', requireRole('owner', 'admin'), evaluateInactivityHandler);
campaignRouter.post('/api/v1/campaigns/:id/evaluate-inactivity', requireRole('owner', 'admin'), evaluateInactivityHandler);

/**
 * POST /campaigns/:id/execute-due & /api/v1/campaigns/:id/execute-due
 * Triggers a worker evaluation cycle for due steps in a specific campaign.
 * Accessible to owner and admin.
 */
async function executeDueCampaignStepsHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const tenantId = req.tenantContext!.tenantId;
    const campaignId = req.params.id as string;
    const batchSize = req.body?.batchSize ? Number(req.body.batchSize) : 20;

    const result = await workerService.runWorkerCycle({
      tenantId,
      campaignId,
      batchSize,
    });
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

/**
 * POST /worker/cycle & /api/v1/worker/cycle
 * Triggers a tenant-wide worker evaluation cycle for due executions.
 * Accessible to owner and admin.
 */
async function runWorkerCycleHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const tenantId = req.tenantContext!.tenantId;
    const batchSize = req.body?.batchSize ? Number(req.body.batchSize) : 20;

    const result = await workerService.runWorkerCycle({
      tenantId,
      batchSize,
    });
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

// Mount execute due steps
campaignRouter.post(
  '/campaigns/:id/execute-due',
  requireRole('owner', 'admin'),
  executeDueCampaignStepsHandler
);
campaignRouter.post(
  '/api/v1/campaigns/:id/execute-due',
  requireRole('owner', 'admin'),
  executeDueCampaignStepsHandler
);

// Mount worker cycle
campaignRouter.post('/worker/cycle', requireRole('owner', 'admin'), runWorkerCycleHandler);
campaignRouter.post('/api/v1/worker/cycle', requireRole('owner', 'admin'), runWorkerCycleHandler);

/**
 * GET /campaigns/:id/pause/preview & /campaigns/:id/pause-preview
 * Returns preview of affected counts before pausing.
 */
async function getPausePreviewHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const tenantId = req.tenantContext!.tenantId;
    const campaignId = req.params.id as string;
    const result = await campaignService.getPausePreview(tenantId, campaignId);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

/**
 * POST /campaigns/:id/pause & /api/v1/campaigns/:id/pause
 * Pauses an active campaign. Stops new enrollments and new submissions; increments pauseGeneration.
 * Accessible to owner and admin only.
 */
async function pauseCampaignHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const tenantId = req.tenantContext!.tenantId;
    const userId = req.tenantContext!.userId;
    const campaignId = req.params.id as string;
    const ip = req.ip || req.socket?.remoteAddress;
    const userAgent = req.headers['user-agent'];

    if (req.body?.preview === true || req.query?.preview === 'true') {
      const preview = await campaignService.getPausePreview(tenantId, campaignId);
      res.status(200).json(preview);
      return;
    }

    const result = await campaignService.pauseCampaign({
      tenantId,
      userId,
      campaignId,
      ip,
      userAgent,
    });
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /campaigns/:id/resume/preview & /campaigns/:id/resume-preview
 * Returns preview of affected counts before resuming (future-only, overdue steps).
 */
async function getResumePreviewHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const tenantId = req.tenantContext!.tenantId;
    const campaignId = req.params.id as string;
    const result = await campaignService.getResumePreview(tenantId, campaignId);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

/**
 * POST /campaigns/:id/resume & /api/v1/campaigns/:id/resume
 * Resumes a paused campaign under FUTURE_ONLY policy (no burst of missed steps).
 * Accessible to owner and admin only.
 */
async function resumeCampaignHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const tenantId = req.tenantContext!.tenantId;
    const userId = req.tenantContext!.userId;
    const campaignId = req.params.id as string;
    const policy = req.body?.policy || 'FUTURE_ONLY';
    const ip = req.ip || req.socket?.remoteAddress;
    const userAgent = req.headers['user-agent'];

    if (req.body?.preview === true || req.query?.preview === 'true') {
      const preview = await campaignService.getResumePreview(tenantId, campaignId);
      res.status(200).json(preview);
      return;
    }

    const result = await campaignService.resumeCampaign({
      tenantId,
      userId,
      campaignId,
      policy,
      ip,
      userAgent,
    });
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /campaigns/:id/archive/preview & /campaigns/:id/archive-preview
 * Returns preview of affected counts before archiving.
 */
async function getArchivePreviewHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const tenantId = req.tenantContext!.tenantId;
    const campaignId = req.params.id as string;
    const result = await campaignService.getArchivePreview(tenantId, campaignId);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

/**
 * POST /campaigns/:id/archive & /api/v1/campaigns/:id/archive
 * Archives a campaign: stops new enrollments, cancels unsubmitted work, preserves history.
 * Accessible to owner and admin only.
 */
async function archiveCampaignHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const tenantId = req.tenantContext!.tenantId;
    const userId = req.tenantContext!.userId;
    const campaignId = req.params.id as string;
    const ip = req.ip || req.socket?.remoteAddress;
    const userAgent = req.headers['user-agent'];

    if (req.body?.preview === true || req.query?.preview === 'true') {
      const preview = await campaignService.getArchivePreview(tenantId, campaignId);
      res.status(200).json(preview);
      return;
    }

    const result = await campaignService.archiveCampaign({
      tenantId,
      userId,
      campaignId,
      ip,
      userAgent,
    });
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

// Mount Pause endpoints (owner/admin)
campaignRouter.get('/campaigns/:id/pause/preview', requireRole('owner', 'admin'), getPausePreviewHandler);
campaignRouter.get('/api/v1/campaigns/:id/pause/preview', requireRole('owner', 'admin'), getPausePreviewHandler);
campaignRouter.get('/campaigns/:id/pause-preview', requireRole('owner', 'admin'), getPausePreviewHandler);
campaignRouter.get('/api/v1/campaigns/:id/pause-preview', requireRole('owner', 'admin'), getPausePreviewHandler);
campaignRouter.post(
  '/campaigns/:id/pause',
  requireRole('owner', 'admin'),
  idempotencyMiddleware({ required: false }),
  pauseCampaignHandler
);
campaignRouter.post(
  '/api/v1/campaigns/:id/pause',
  requireRole('owner', 'admin'),
  idempotencyMiddleware({ required: false }),
  pauseCampaignHandler
);

// Mount Resume endpoints (owner/admin)
campaignRouter.get('/campaigns/:id/resume/preview', requireRole('owner', 'admin'), getResumePreviewHandler);
campaignRouter.get('/api/v1/campaigns/:id/resume/preview', requireRole('owner', 'admin'), getResumePreviewHandler);
campaignRouter.get('/campaigns/:id/resume-preview', requireRole('owner', 'admin'), getResumePreviewHandler);
campaignRouter.get('/api/v1/campaigns/:id/resume-preview', requireRole('owner', 'admin'), getResumePreviewHandler);
campaignRouter.post(
  '/campaigns/:id/resume',
  requireRole('owner', 'admin'),
  idempotencyMiddleware({ required: false }),
  resumeCampaignHandler
);
campaignRouter.post(
  '/api/v1/campaigns/:id/resume',
  requireRole('owner', 'admin'),
  idempotencyMiddleware({ required: false }),
  resumeCampaignHandler
);

// Mount Archive endpoints (owner/admin)
campaignRouter.get('/campaigns/:id/archive/preview', requireRole('owner', 'admin'), getArchivePreviewHandler);
campaignRouter.get('/api/v1/campaigns/:id/archive/preview', requireRole('owner', 'admin'), getArchivePreviewHandler);
campaignRouter.get('/campaigns/:id/archive-preview', requireRole('owner', 'admin'), getArchivePreviewHandler);
campaignRouter.get('/api/v1/campaigns/:id/archive-preview', requireRole('owner', 'admin'), getArchivePreviewHandler);
campaignRouter.post(
  '/campaigns/:id/archive',
  requireRole('owner', 'admin'),
  idempotencyMiddleware({ required: false }),
  archiveCampaignHandler
);
campaignRouter.post(
  '/api/v1/campaigns/:id/archive',
  requireRole('owner', 'admin'),
  idempotencyMiddleware({ required: false }),
  archiveCampaignHandler
);

/**
 * GET /campaigns/:id/report & /api/v1/campaigns/:id/report
 * Returns detailed campaign metrics, evidence counts, attribution, and step funnel (Spec p28).
 * Accessible to owner, admin, staff.
 */
async function getCampaignReportHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const tenantId = req.tenantContext!.tenantId;
    const campaignId = req.params.id as string;
    const report = await campaignReportingService.getCampaignReport(tenantId, campaignId);
    res.status(200).json(report);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /campaigns/:id/export/csv & /api/v1/campaigns/:id/export/csv
 * Exports campaign report and recipient activity as CSV with masked phones and no message bodies (Spec p28, Hard Rule 9).
 * Accessible to owner, admin, staff.
 */
async function exportCampaignCsvHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const tenantId = req.tenantContext!.tenantId;
    const campaignId = req.params.id as string;
    const csv = await campaignReportingService.generateCampaignCsvExport(tenantId, campaignId);
    const dateStr = new Date().toISOString().split('T')[0];
    const filename = `campaign_${campaignId}_report_${dateStr}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.status(200).send(csv);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /campaigns/:id/customer-timeline/:customerId & /api/v1/campaigns/:id/customer-timeline/:customerId
 * Returns explainable customer timeline (why selected, occurrence, planned vs actual, template revision, status events, stop reasons).
 * Accessible to owner, admin, staff.
 */
async function getCustomerTimelineHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const tenantId = req.tenantContext!.tenantId;
    const campaignId = req.params.id as string;
    const customerId = req.params.customerId as string;
    const timeline = await campaignReportingService.getCustomerTimeline(tenantId, campaignId, customerId);
    res.status(200).json(timeline);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /campaigns/:id/enrollments/:enrollmentId/timeline & /api/v1/campaigns/:id/enrollments/:enrollmentId/timeline
 */
async function getEnrollmentTimelineHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const tenantId = req.tenantContext!.tenantId;
    const campaignId = req.params.id as string;
    const enrollmentId = req.params.enrollmentId as string;
    const enrollment = await campaignActivityService.getEnrollmentDetail(tenantId, campaignId, enrollmentId);
    const timeline = await campaignReportingService.getCustomerTimeline(
      tenantId,
      campaignId,
      enrollment.enrollment.customerId
    );
    res.status(200).json(timeline);
  } catch (err) {
    next(err);
  }
}

// Mount Reporting routes (owner, admin, staff)
campaignRouter.get('/campaigns/:id/report', requireRole('owner', 'admin', 'staff'), getCampaignReportHandler);
campaignRouter.get('/api/v1/campaigns/:id/report', requireRole('owner', 'admin', 'staff'), getCampaignReportHandler);

// Mount CSV export routes
campaignRouter.get('/campaigns/:id/export/csv', requireRole('owner', 'admin', 'staff'), exportCampaignCsvHandler);
campaignRouter.get('/api/v1/campaigns/:id/export/csv', requireRole('owner', 'admin', 'staff'), exportCampaignCsvHandler);
campaignRouter.get('/campaigns/:id/report/csv', requireRole('owner', 'admin', 'staff'), exportCampaignCsvHandler);
campaignRouter.get('/api/v1/campaigns/:id/report/csv', requireRole('owner', 'admin', 'staff'), exportCampaignCsvHandler);

// Mount Customer timeline routes
campaignRouter.get(
  '/campaigns/:id/customer-timeline/:customerId',
  requireRole('owner', 'admin', 'staff'),
  getCustomerTimelineHandler
);
campaignRouter.get(
  '/api/v1/campaigns/:id/customer-timeline/:customerId',
  requireRole('owner', 'admin', 'staff'),
  getCustomerTimelineHandler
);
campaignRouter.get(
  '/campaigns/:id/enrollments/:enrollmentId/timeline',
  requireRole('owner', 'admin', 'staff'),
  getEnrollmentTimelineHandler
);
campaignRouter.get(
  '/api/v1/campaigns/:id/enrollments/:enrollmentId/timeline',
  requireRole('owner', 'admin', 'staff'),
  getEnrollmentTimelineHandler
);


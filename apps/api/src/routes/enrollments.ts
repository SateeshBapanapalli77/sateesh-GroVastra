import { Router, Request, Response, NextFunction } from 'express';
import { authenticate, requireRole } from '../middleware/auth';
import { campaignActivityService } from '../services/campaign-activity.service';
import { campaignReportingService } from '../services/campaign-reporting.service';
import { ResolveHoldInputSchema, MarkGoalInputSchema } from '@grovastra/shared';
import { ValidationError } from '../errors/app-error';

export const enrollmentRouter = Router();

// Base authentication for all enrollment routes
enrollmentRouter.use(authenticate);

/**
 * POST /enrollments/:id/resolve-hold
 * Accessible to owner, admin, staff (Spec p26).
 * Audited with cause and supporting record. Re-evaluates FUTURE steps only.
 */
async function resolveHoldHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const tenantId = req.tenantContext!.tenantId;
    const userId = req.tenantContext!.userId;
    const enrollmentId = req.params.id as string;
    const ip = req.ip || req.socket?.remoteAddress;
    const userAgent = req.headers['user-agent'] as string | undefined;

    const parseResult = ResolveHoldInputSchema.safeParse(req.body);
    if (!parseResult.success) {
      throw new ValidationError(
        parseResult.error.errors[0]?.message || 'Invalid resolve hold input',
        parseResult.error.format()
      );
    }

    const { cause, reason, note, supportingRecord } = parseResult.data;
    const effectiveCause = cause || reason || note || 'Staff resolved hold';

    const result = await campaignActivityService.resolveHold({
      tenantId,
      enrollmentId,
      userId,
      cause: effectiveCause,
      supportingRecord,
      ip,
      userAgent,
    });

    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

/**
 * POST /enrollments/:id/mark-goal
 * Accessible to owner and admin only (Spec p26, prompt assumption [I]).
 * Audited with cause and supporting record. Delivery alone never creates a goal.
 */
async function markGoalHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const tenantId = req.tenantContext!.tenantId;
    const userId = req.tenantContext!.userId;
    const enrollmentId = req.params.id as string;
    const ip = req.ip || req.socket?.remoteAddress;
    const userAgent = req.headers['user-agent'] as string | undefined;

    const parseResult = MarkGoalInputSchema.safeParse(req.body);
    if (!parseResult.success) {
      throw new ValidationError(
        parseResult.error.errors[0]?.message || 'Invalid mark goal input',
        parseResult.error.format()
      );
    }

    const { cause, reason, orderRef, supportingRecord, at } = parseResult.data;
    const effectiveCause =
      cause || reason || (orderRef ? `Occasion order completed (${orderRef})` : 'Staff marked goal complete');
    const parsedAt = at ? new Date(at) : undefined;

    const result = await campaignActivityService.markGoal({
      tenantId,
      enrollmentId,
      userId,
      cause: effectiveCause,
      orderRef,
      supportingRecord,
      at: parsedAt,
      ip,
      userAgent,
    });

    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /enrollments/:id & /api/v1/enrollments/:id
 * Retrieves full enrollment details and execution steps by enrollmentId.
 */
async function getEnrollmentHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const tenantId = req.tenantContext!.tenantId;
    const enrollmentId = req.params.id as string;
    const campaignId = (req.params.campaignId as string) || '';

    const result = await campaignActivityService.getEnrollmentDetail(tenantId, campaignId, enrollmentId);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------------------
// Route Mountings
// ---------------------------------------------------------------------------

// POST /enrollments/:id/resolve-hold (owner/admin/staff permitted)
enrollmentRouter.post('/enrollments/:id/resolve-hold', requireRole('owner', 'admin', 'staff'), resolveHoldHandler);
enrollmentRouter.post('/api/v1/enrollments/:id/resolve-hold', requireRole('owner', 'admin', 'staff'), resolveHoldHandler);
enrollmentRouter.post(
  '/campaigns/:campaignId/enrollments/:id/resolve-hold',
  requireRole('owner', 'admin', 'staff'),
  resolveHoldHandler
);
enrollmentRouter.post(
  '/api/v1/campaigns/:campaignId/enrollments/:id/resolve-hold',
  requireRole('owner', 'admin', 'staff'),
  resolveHoldHandler
);

// POST /enrollments/:id/mark-goal (owner/admin only)
enrollmentRouter.post('/enrollments/:id/mark-goal', requireRole('owner', 'admin'), markGoalHandler);
enrollmentRouter.post('/api/v1/enrollments/:id/mark-goal', requireRole('owner', 'admin'), markGoalHandler);
enrollmentRouter.post(
  '/campaigns/:campaignId/enrollments/:id/mark-goal',
  requireRole('owner', 'admin'),
  markGoalHandler
);
enrollmentRouter.post(
  '/api/v1/campaigns/:campaignId/enrollments/:id/mark-goal',
  requireRole('owner', 'admin'),
  markGoalHandler
);

// GET /enrollments/:id
enrollmentRouter.get('/enrollments/:id', getEnrollmentHandler);
enrollmentRouter.get('/api/v1/enrollments/:id', getEnrollmentHandler);

/**
 * GET /enrollments/:id/timeline & /api/v1/enrollments/:id/timeline
 * Returns explainable customer timeline for this enrollment.
 */
async function getEnrollmentTimelineHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const tenantId = req.tenantContext!.tenantId;
    const enrollmentId = req.params.id as string;
    const enrollmentDetail = await campaignActivityService.getEnrollmentDetail(tenantId, '', enrollmentId);
    const timeline = await campaignReportingService.getCustomerTimeline(
      tenantId,
      enrollmentDetail.enrollment.campaignId,
      enrollmentDetail.enrollment.customerId
    );
    res.status(200).json(timeline);
  } catch (err) {
    next(err);
  }
}

// Mount enrollment timeline routes (owner, admin, staff)
enrollmentRouter.get('/enrollments/:id/timeline', requireRole('owner', 'admin', 'staff'), getEnrollmentTimelineHandler);
enrollmentRouter.get('/api/v1/enrollments/:id/timeline', requireRole('owner', 'admin', 'staff'), getEnrollmentTimelineHandler);

import { Router, Request, Response, NextFunction } from 'express';
import { authenticate, requireRole } from '../middleware/auth';
import { campaignSettingsService } from '../services/campaign-settings.service';
import { ValidationError } from '../errors/app-error';

export const campaignSettingsRouter = Router();

// Base authentication: all routes require authenticated tenant session
campaignSettingsRouter.use(authenticate);

/**
 * Handler for GET /campaign-settings & /api/v1/campaign-settings
 * Available to owner, admin, and staff roles (spec: staff read, owner/admin write).
 */
async function getCampaignSettingsHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const tenantId = req.tenantContext!.tenantId;
    const settings = await campaignSettingsService.getSettings(tenantId);
    res.status(200).json(settings);
  } catch (err) {
    next(err);
  }
}

/**
 * Handler for PATCH /campaign-settings & /api/v1/campaign-settings
 * Restricted to owner and admin roles (staff forbidden).
 * Enforces expectedVersion (HTTP 409 on conflict), idempotency key, and audit log.
 */
async function updateCampaignSettingsHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const tenantId = req.tenantContext!.tenantId;
    const userId = req.tenantContext!.userId;

    // Idempotency key from header or body
    const rawIdempotencyKey =
      (req.headers['idempotency-key'] as string | undefined) ||
      (req.headers['x-idempotency-key'] as string | undefined) ||
      req.body?.idempotencyKey;

    if (!rawIdempotencyKey || typeof rawIdempotencyKey !== 'string' || !rawIdempotencyKey.trim()) {
      throw new ValidationError(
        'An Idempotency-Key header (or idempotencyKey field) is required for modifying campaign settings'
      );
    }

    const { expectedVersion, ...data } = req.body;

    if (expectedVersion === undefined || expectedVersion === null || typeof expectedVersion !== 'number') {
      throw new ValidationError(
        'expectedVersion must be provided as an integer for optimistic concurrency locking (spec p26, C16)'
      );
    }

    const ip = req.ip || req.socket?.remoteAddress;
    const userAgent = req.headers['user-agent'];

    const updated = await campaignSettingsService.updateSettings({
      tenantId,
      userId,
      expectedVersion,
      idempotencyKey: rawIdempotencyKey.trim(),
      data,
      ip,
      userAgent,
    });

    res.status(200).json(updated);
  } catch (err) {
    next(err);
  }
}

// Mount GET handlers (accessible by owner, admin, staff)
campaignSettingsRouter.get('/campaign-settings', getCampaignSettingsHandler);
campaignSettingsRouter.get('/api/v1/campaign-settings', getCampaignSettingsHandler);

// Mount PATCH handlers (write access restricted to owner, admin)
campaignSettingsRouter.patch(
  '/campaign-settings',
  requireRole('owner', 'admin'),
  updateCampaignSettingsHandler
);
campaignSettingsRouter.patch(
  '/api/v1/campaign-settings',
  requireRole('owner', 'admin'),
  updateCampaignSettingsHandler
);

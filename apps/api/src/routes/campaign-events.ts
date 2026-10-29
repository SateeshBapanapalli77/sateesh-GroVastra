import { Router, Request, Response, NextFunction } from 'express';
import { authenticate, requireRole } from '../middleware/auth';
import { eventConsumerService } from '../services/event-consumer';
import { CampaignEventInboxModel } from '../db/models';
import { EVENT_INBOX_STATUS } from '@grovastra/shared';

export const campaignEventsRouter = Router();

/**
 * Ingestion handler for internal domain events (Spec p20, p24, p25, p26).
 * Persists in campaignEventInbox BEFORE acknowledging.
 * Unknown schema or stale entityVersion -> quarantined.
 */
async function ingestEventHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tenantId = req.tenantContext!.tenantId;
    const producer =
      (req.headers['x-producer-id'] as string) ||
      (req.headers['x-producer-name'] as string) ||
      req.body?.producer ||
      (req.body?.source ? String(req.body.source).replace(/^\//, '') : undefined) ||
      'dev-tools';

    const result = await eventConsumerService.ingestEvent(tenantId, producer, req.body);

    res.status(result.status === EVENT_INBOX_STATUS.QUARANTINED ? 200 : 200).json({
      success: true,
      eventId: result.eventId,
      status: result.status,
      quarantineReason: result.quarantineReason || null,
      message: result.message || 'Event ingested successfully',
      effects: result.effects || {},
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Returns quarantined events for the tenant (Spec p24, p29).
 * Visible for boutique owners.
 */
async function getQuarantinedEventsHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tenantId = req.tenantContext!.tenantId;
    const limit = Math.min(Number(req.query.limit) || 50, 100);
    const skip = Number(req.query.skip) || 0;

    const [events, total] = await Promise.all([
      CampaignEventInboxModel.find({
        tenantId,
        status: EVENT_INBOX_STATUS.QUARANTINED,
      })
        .sort({ occurredAt: -1, createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      CampaignEventInboxModel.countDocuments({
        tenantId,
        status: EVENT_INBOX_STATUS.QUARANTINED,
      }),
    ]);

    res.json({
      events,
      total,
      limit,
      skip,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Returns inbox events for the tenant with optional status filter.
 */
async function getInboxEventsHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tenantId = req.tenantContext!.tenantId;
    const status = req.query.status as string;
    const limit = Math.min(Number(req.query.limit) || 50, 100);
    const skip = Number(req.query.skip) || 0;

    const query: Record<string, unknown> = { tenantId };
    if (status) {
      query.status = status;
    }

    const [events, total] = await Promise.all([
      CampaignEventInboxModel.find(query)
        .sort({ receivedAt: -1, createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      CampaignEventInboxModel.countDocuments(query),
    ]);

    res.json({
      events,
      total,
      limit,
      skip,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Manually trigger pending inbox event processing (Dev/Admin test utility).
 */
async function processPendingEventsHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tenantId = req.tenantContext!.tenantId;
    const result = await eventConsumerService.processPendingEvents({ tenantId });
    res.json({
      success: true,
      ...result,
    });
  } catch (err) {
    next(err);
  }
}

// Ingestion endpoints
campaignEventsRouter.post('/internal/campaign-events', authenticate, ingestEventHandler);
campaignEventsRouter.post('/api/v1/internal/campaign-events', authenticate, ingestEventHandler);
campaignEventsRouter.post('/campaign-events', authenticate, ingestEventHandler);
campaignEventsRouter.post('/api/v1/campaign-events', authenticate, ingestEventHandler);

// Quarantine list endpoints for owners
campaignEventsRouter.get(
  '/internal/campaign-events/quarantine',
  authenticate,
  requireRole('owner', 'admin', 'staff'),
  getQuarantinedEventsHandler
);
campaignEventsRouter.get(
  '/api/v1/internal/campaign-events/quarantine',
  authenticate,
  requireRole('owner', 'admin', 'staff'),
  getQuarantinedEventsHandler
);
campaignEventsRouter.get(
  '/campaign-events/quarantine',
  authenticate,
  requireRole('owner', 'admin', 'staff'),
  getQuarantinedEventsHandler
);

// Inbox listing endpoints
campaignEventsRouter.get(
  '/internal/campaign-events/inbox',
  authenticate,
  requireRole('owner', 'admin', 'staff'),
  getInboxEventsHandler
);
campaignEventsRouter.get(
  '/api/v1/internal/campaign-events/inbox',
  authenticate,
  requireRole('owner', 'admin', 'staff'),
  getInboxEventsHandler
);

// Manual process pending events trigger
campaignEventsRouter.post(
  '/internal/campaign-events/process-pending',
  authenticate,
  requireRole('owner', 'admin'),
  processPendingEventsHandler
);
campaignEventsRouter.post(
  '/api/v1/internal/campaign-events/process-pending',
  authenticate,
  requireRole('owner', 'admin'),
  processPendingEventsHandler
);

import { Router, Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { clock } from '../services/clock';
import { eventConsumerService } from '../services/event-consumer';
import { SrcRequestModel } from '../db/models/src-request.model';

export const mockRequestDevRouter = Router();

// Dev-only guard: 404 in production
mockRequestDevRouter.use((req: Request, res: Response, next: NextFunction) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Dev endpoints not available in production' } });
  }
  next();
});

/**
 * POST /dev/mock-requests
 * Creates a mock src_request document and emits a request.saved event.
 *
 * Body:
 * {
 *   customerId: string
 *   requestId?: string       // auto-generated if omitted
 *   productId: string
 *   variantId?: string | null
 *   status?: 'OPEN' | 'FULFILLED' | 'CANCELLED'
 *   branchId?: string
 *   declaredByCustomer?: boolean
 *   conditions?: { size?, colourFamily?, weave? }
 *   createdAt?: string       // ISO date, defaults to now
 *   expiresAt?: string | null
 * }
 */
mockRequestDevRouter.post(
  ['/dev/mock-requests', '/api/v1/dev/mock-requests'],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = (req as any).tenantContext?.tenantId || req.body?.tenantId || 'shop_a';
      const {
        customerId,
        requestId: customRequestId,
        productId,
        variantId = null,
        status = 'OPEN',
        branchId = 'branch_main',
        declaredByCustomer = true,
        conditions = null,
        createdAt,
        expiresAt = null,
      } = req.body;

      if (!customerId) {
        return res.status(422).json({
          error: 'VALIDATION_ERROR',
          message: 'customerId is required',
        });
      }

      if (!productId) {
        return res.status(422).json({
          error: 'VALIDATION_ERROR',
          message: 'productId is required',
        });
      }

      const requestId = customRequestId || `req_${crypto.randomUUID().slice(0, 10)}`;
      const now = clock.now();
      const parsedCreatedAt = createdAt ? new Date(createdAt) : now;
      const parsedExpiresAt = expiresAt ? new Date(expiresAt) : null;

      // Insert into src_requests
      await (SrcRequestModel as any).collection.insertOne({
        requestId,
        tenantId,
        customerId,
        branchId,
        status,
        source: 'MOCK',
        declaredByCustomer: Boolean(declaredByCustomer),
        itemRef: {
          productId,
          variantId: variantId || null,
        },
        conditions: conditions || null,
        createdAt: parsedCreatedAt,
        updatedAt: now,
        expiresAt: parsedExpiresAt,
        entityVersion: 1,
        seedGroup: null,
      });

      // Emit domain event through consumer path
      const eventPayload = {
        schemaVersion: 1,
        id: `evt_req_saved_${crypto.randomUUID()}`,
        type: 'request.saved',
        source: '/requests',
        time: now.toISOString(),
        datacontenttype: 'application/json',
        data: {
          tenantId,
          requestId,
          customerId,
          branchId,
          status,
          source: 'MOCK',
          declaredByCustomer: Boolean(declaredByCustomer),
          itemRef: { productId, variantId: variantId || null },
          conditions: conditions || null,
          createdAt: parsedCreatedAt.toISOString(),
          expiresAt: parsedExpiresAt?.toISOString() || null,
          entityVersion: 1,
        },
      };

      await eventConsumerService.ingestEvent({
        id: eventPayload.id,
        tenantId,
        producer: 'requests',
        eventType: 'request.saved',
        entityId: requestId,
        entityVersion: 1,
        payload: eventPayload,
        occurredAt: now,
      });

      return res.status(201).json({
        success: true,
        request: {
          requestId,
          tenantId,
          customerId,
          productId,
          variantId,
          status,
          createdAt: parsedCreatedAt,
        },
      });
    } catch (err: any) {
      if (err.code === 11000) {
        return res.status(409).json({
          error: 'CONFLICT',
          message: `Request with that requestId already exists`,
        });
      }
      next(err);
    }
  }
);

/**
 * POST /dev/mock-requests/:requestId/fulfil
 * Marks a request as FULFILLED and emits request.fulfilled event.
 */
mockRequestDevRouter.post(
  ['/dev/mock-requests/:requestId/fulfil', '/api/v1/dev/mock-requests/:requestId/fulfil'],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = (req as any).tenantContext?.tenantId || req.body?.tenantId || 'shop_a';
      const { requestId } = req.params;
      const now = clock.now();

      const existing = await SrcRequestModel.findOne({ tenantId, requestId });
      if (!existing) {
        return res.status(404).json({ error: 'NOT_FOUND', message: `Request '${requestId}' not found` });
      }

      const newVersion = existing.entityVersion + 1;
      existing.status = 'FULFILLED';
      existing.updatedAt = now;
      existing.entityVersion = newVersion;
      await existing.save();

      const eventPayload = {
        schemaVersion: 1,
        id: `evt_req_fulfilled_${crypto.randomUUID()}`,
        type: 'request.fulfilled',
        source: '/requests',
        time: now.toISOString(),
        datacontenttype: 'application/json',
        data: { tenantId, requestId, status: 'FULFILLED', entityVersion: newVersion },
      };

      await eventConsumerService.ingestEvent({
        id: eventPayload.id,
        tenantId,
        producer: 'requests',
        eventType: 'request.fulfilled',
        entityId: requestId,
        entityVersion: newVersion,
        payload: eventPayload,
        occurredAt: now,
      });

      return res.status(200).json({ success: true, requestId, status: 'FULFILLED' });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /dev/mock-requests/:requestId/cancel
 * Marks a request as CANCELLED and emits request.cancelled event.
 */
mockRequestDevRouter.post(
  ['/dev/mock-requests/:requestId/cancel', '/api/v1/dev/mock-requests/:requestId/cancel'],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = (req as any).tenantContext?.tenantId || req.body?.tenantId || 'shop_a';
      const { requestId } = req.params;
      const now = clock.now();

      const existing = await SrcRequestModel.findOne({ tenantId, requestId });
      if (!existing) {
        return res.status(404).json({ error: 'NOT_FOUND', message: `Request '${requestId}' not found` });
      }

      const newVersion = existing.entityVersion + 1;
      existing.status = 'CANCELLED';
      existing.updatedAt = now;
      existing.entityVersion = newVersion;
      await existing.save();

      const eventPayload = {
        schemaVersion: 1,
        id: `evt_req_cancelled_${crypto.randomUUID()}`,
        type: 'request.cancelled',
        source: '/requests',
        time: now.toISOString(),
        datacontenttype: 'application/json',
        data: { tenantId, requestId, status: 'CANCELLED', entityVersion: newVersion },
      };

      await eventConsumerService.ingestEvent({
        id: eventPayload.id,
        tenantId,
        producer: 'requests',
        eventType: 'request.cancelled',
        entityId: requestId,
        entityVersion: newVersion,
        payload: eventPayload,
        occurredAt: now,
      });

      return res.status(200).json({ success: true, requestId, status: 'CANCELLED' });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /dev/mock-stock-published
 * Simulates a stock.published event directly (without going through inventory service).
 * Body: { items: [{ productId, variantId?, sellableQtyBefore?, sellableQtyAfter }] }
 */
mockRequestDevRouter.post(
  ['/dev/mock-stock-published', '/api/v1/dev/mock-stock-published'],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = (req as any).tenantContext?.tenantId || req.body?.tenantId || 'shop_a';
      const { items = [], source = 'MOCK' } = req.body;

      if (!Array.isArray(items) || items.length === 0) {
        return res.status(422).json({
          error: 'VALIDATION_ERROR',
          message: 'items must be a non-empty array',
        });
      }

      const now = clock.now();
      const eventId = `evt_stock_mock_${crypto.randomUUID().slice(0, 10)}`;
      const pubId = `pub_mock_${crypto.randomUUID().slice(0, 8)}`;

      const eventPayload = {
        schemaVersion: 1,
        id: eventId,
        type: 'stock.published',
        source: '/inventory',
        time: now.toISOString(),
        datacontenttype: 'application/json',
        data: { source, items },
      };

      const result = await eventConsumerService.ingestEvent({
        id: eventId,
        tenantId,
        producer: 'inventory',
        eventType: 'stock.published',
        entityId: pubId,
        entityVersion: 1,
        payload: eventPayload,
        occurredAt: now,
      });

      return res.status(200).json({ success: true, eventId, result });
    } catch (err) {
      next(err);
    }
  }
);

import { Router, Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { clock } from '../services/clock';
import { eventConsumerService } from '../services/event-consumer';
import { SrcEnquiryModel, SrcProductModel } from '../db/models';

export const mockEnquiryDevRouter = Router();

// Dev-only guard: 404 in production
mockEnquiryDevRouter.use((req: Request, res: Response, next: NextFunction) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Dev endpoints not available in production' } });
  }
  next();
});

/**
 * POST /dev/mock-enquiries
 * { customerId, itemRef?, channel, createdAt?, lastCustomerInteractionAt?, staffTakeover? }
 */
mockEnquiryDevRouter.post(
  ['/dev/mock-enquiries', '/api/v1/dev/mock-enquiries'],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = (req as any).tenantContext?.tenantId || (req.body && req.body.tenantId) || 'shop_a';
      const {
        customerId,
        itemRef,
        channel = 'IN_STORE',
        createdAt,
        lastCustomerInteractionAt,
        staffTakeover = false,
        enquiryId: customEnquiryId,
      } = req.body;

      const enquiryId = customEnquiryId || `enq_${crypto.randomUUID().slice(0, 10)}`;
      const now = clock.now();
      const parsedCreatedAt = createdAt ? new Date(createdAt) : now;
      const parsedInteractionAt = lastCustomerInteractionAt
        ? new Date(lastCustomerInteractionAt)
        : parsedCreatedAt;

      const enquiry = await (SrcEnquiryModel as any).collection.insertOne({
        enquiryId,
        tenantId,
        customerId: customerId || null,
        branchId: 'branch_main',
        channel,
        status: 'OPEN',
        staffTakeover: Boolean(staffTakeover),
        itemRef: itemRef
          ? {
              productId: itemRef.productId,
              variantId: itemRef.variantId || null,
            }
          : null,
        createdAt: parsedCreatedAt,
        lastCustomerInteractionAt: parsedInteractionAt,
        updatedAt: now,
        entityVersion: 1,
        source: 'MOCK',
      });

      // Emit domain event through consumer path
      const eventPayload = {
        specversion: '1.0',
        id: `evt_enq_saved_${crypto.randomUUID()}`,
        type: 'enquiry.saved',
        source: '/enquiries',
        time: now.toISOString(),
        datacontenttype: 'application/json',
        data: {
          tenantId,
          enquiryId,
          customerId: customerId || null,
          channel,
          status: 'OPEN',
          staffTakeover: Boolean(staffTakeover),
          itemRef: itemRef || null,
          createdAt: parsedCreatedAt.toISOString(),
          lastCustomerInteractionAt: parsedInteractionAt.toISOString(),
          entityVersion: 1,
        },
      };

      await eventConsumerService.ingestEvent({
        id: eventPayload.id,
        tenantId,
        producer: 'enquiries',
        eventType: 'enquiry.saved',
        entityId: enquiryId,
        entityVersion: 1,
        payload: eventPayload,
        occurredAt: now,
      });

      res.status(201).json({
        success: true,
        enquiry: {
          enquiryId,
          tenantId,
          customerId,
          status: 'OPEN',
          lastCustomerInteractionAt: parsedInteractionAt,
          staffTakeover,
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /dev/mock-enquiries/:id/interaction
 * Updates lastCustomerInteractionAt & emits enquiry.saved event
 */
mockEnquiryDevRouter.post(
  ['/dev/mock-enquiries/:id/interaction', '/api/v1/dev/mock-enquiries/:id/interaction'],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = (req as any).tenantContext?.tenantId || 'shop_a';
      const enquiryId = req.params.id;
      const { at } = req.body;
      const interactionAt = at ? new Date(at) : clock.now();

      const existing = await SrcEnquiryModel.findOne({ tenantId, enquiryId });
      if (!existing) {
        return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Enquiry not found' } });
      }

      const nextVersion = existing.entityVersion + 1;
      await (SrcEnquiryModel as any).collection.updateOne(
        { tenantId, enquiryId },
        {
          $set: {
            lastCustomerInteractionAt: interactionAt,
            updatedAt: clock.now(),
            entityVersion: nextVersion,
          },
        }
      );

      const eventPayload = {
        specversion: '1.0',
        id: `evt_enq_interact_${crypto.randomUUID()}`,
        type: 'enquiry.saved',
        source: '/enquiries',
        time: clock.now().toISOString(),
        datacontenttype: 'application/json',
        data: {
          tenantId,
          enquiryId,
          customerId: existing.customerId,
          channel: existing.channel,
          status: existing.status,
          staffTakeover: existing.staffTakeover,
          itemRef: existing.itemRef,
          createdAt: existing.createdAt.toISOString(),
          lastCustomerInteractionAt: interactionAt.toISOString(),
          entityVersion: nextVersion,
        },
      };

      await eventConsumerService.ingestEvent({
        id: eventPayload.id,
        tenantId,
        producer: 'enquiries',
        eventType: 'enquiry.saved',
        entityId: enquiryId,
        entityVersion: nextVersion,
        payload: eventPayload,
        occurredAt: clock.now(),
      });

      res.status(200).json({
        success: true,
        enquiryId,
        lastCustomerInteractionAt: interactionAt,
        entityVersion: nextVersion,
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /dev/mock-enquiries/:id/staff-edit
 * Changes updatedAt & entityVersion only; does NOT change lastCustomerInteractionAt
 */
mockEnquiryDevRouter.post(
  ['/dev/mock-enquiries/:id/staff-edit', '/api/v1/dev/mock-enquiries/:id/staff-edit'],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = (req as any).tenantContext?.tenantId || 'shop_a';
      const enquiryId = req.params.id;

      const existing = await SrcEnquiryModel.findOne({ tenantId, enquiryId });
      if (!existing) {
        return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Enquiry not found' } });
      }

      const nextVersion = existing.entityVersion + 1;
      const now = clock.now();
      await (SrcEnquiryModel as any).collection.updateOne(
        { tenantId, enquiryId },
        {
          $set: {
            updatedAt: now,
            entityVersion: nextVersion,
          },
        }
      );

      const eventPayload = {
        specversion: '1.0',
        id: `evt_enq_staff_edit_${crypto.randomUUID()}`,
        type: 'enquiry.saved',
        source: '/enquiries',
        time: now.toISOString(),
        datacontenttype: 'application/json',
        data: {
          tenantId,
          enquiryId,
          customerId: existing.customerId,
          channel: existing.channel,
          status: existing.status,
          staffTakeover: existing.staffTakeover,
          itemRef: existing.itemRef,
          createdAt: existing.createdAt.toISOString(),
          lastCustomerInteractionAt: existing.lastCustomerInteractionAt.toISOString(), // UNCHANGED
          updatedAt: now.toISOString(),
          entityVersion: nextVersion,
        },
      };

      await eventConsumerService.ingestEvent({
        id: eventPayload.id,
        tenantId,
        producer: 'enquiries',
        eventType: 'enquiry.saved',
        entityId: enquiryId,
        entityVersion: nextVersion,
        payload: eventPayload,
        occurredAt: now,
      });

      res.status(200).json({
        success: true,
        enquiryId,
        message: 'Staff edit applied; lastCustomerInteractionAt unchanged',
        updatedAt: now,
        entityVersion: nextVersion,
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /dev/mock-enquiries/:id/takeover
 * { value: boolean }
 */
mockEnquiryDevRouter.post(
  ['/dev/mock-enquiries/:id/takeover', '/api/v1/dev/mock-enquiries/:id/takeover'],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = (req as any).tenantContext?.tenantId || 'shop_a';
      const enquiryId = req.params.id;
      const { value = true } = req.body;

      const existing = await SrcEnquiryModel.findOne({ tenantId, enquiryId });
      if (!existing) {
        return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Enquiry not found' } });
      }

      const nextVersion = existing.entityVersion + 1;
      const now = clock.now();
      await (SrcEnquiryModel as any).collection.updateOne(
        { tenantId, enquiryId },
        {
          $set: {
            staffTakeover: Boolean(value),
            updatedAt: now,
            entityVersion: nextVersion,
          },
        }
      );

      const eventPayload = {
        specversion: '1.0',
        id: `evt_enq_takeover_${crypto.randomUUID()}`,
        type: 'enquiry.saved',
        source: '/enquiries',
        time: now.toISOString(),
        datacontenttype: 'application/json',
        data: {
          tenantId,
          enquiryId,
          customerId: existing.customerId,
          channel: existing.channel,
          status: existing.status,
          staffTakeover: Boolean(value),
          itemRef: existing.itemRef,
          createdAt: existing.createdAt.toISOString(),
          lastCustomerInteractionAt: existing.lastCustomerInteractionAt.toISOString(),
          entityVersion: nextVersion,
        },
      };

      await eventConsumerService.ingestEvent({
        id: eventPayload.id,
        tenantId,
        producer: 'enquiries',
        eventType: 'enquiry.saved',
        entityId: enquiryId,
        entityVersion: nextVersion,
        payload: eventPayload,
        occurredAt: now,
      });

      res.status(200).json({
        success: true,
        enquiryId,
        staffTakeover: Boolean(value),
        entityVersion: nextVersion,
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /dev/mock-enquiries/:id/resolve
 * { status: 'RESOLVED' | 'CLOSED' | 'CANCELLED' }
 */
mockEnquiryDevRouter.post(
  ['/dev/mock-enquiries/:id/resolve', '/api/v1/dev/mock-enquiries/:id/resolve'],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = (req as any).tenantContext?.tenantId || 'shop_a';
      const enquiryId = req.params.id;
      const { status = 'RESOLVED' } = req.body;

      const existing = await SrcEnquiryModel.findOne({ tenantId, enquiryId });
      if (!existing) {
        return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Enquiry not found' } });
      }

      const nextVersion = existing.entityVersion + 1;
      const now = clock.now();
      await (SrcEnquiryModel as any).collection.updateOne(
        { tenantId, enquiryId },
        {
          $set: {
            status,
            updatedAt: now,
            entityVersion: nextVersion,
          },
        }
      );

      const eventPayload = {
        specversion: '1.0',
        id: `evt_enq_resolved_${crypto.randomUUID()}`,
        type: 'enquiry.resolved',
        source: '/enquiries',
        time: now.toISOString(),
        datacontenttype: 'application/json',
        data: {
          tenantId,
          enquiryId,
          status,
          entityVersion: nextVersion,
        },
      };

      await eventConsumerService.ingestEvent({
        id: eventPayload.id,
        tenantId,
        producer: 'enquiries',
        eventType: 'enquiry.resolved',
        entityId: enquiryId,
        entityVersion: nextVersion,
        payload: eventPayload,
        occurredAt: now,
      });

      res.status(200).json({
        success: true,
        enquiryId,
        status,
        entityVersion: nextVersion,
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /dev/mock-enquiries/:id/delete
 */
mockEnquiryDevRouter.post(
  ['/dev/mock-enquiries/:id/delete', '/api/v1/dev/mock-enquiries/:id/delete'],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = (req as any).tenantContext?.tenantId || 'shop_a';
      const enquiryId = req.params.id;

      const existing = await SrcEnquiryModel.findOne({ tenantId, enquiryId });
      if (!existing) {
        return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Enquiry not found' } });
      }

      const nextVersion = existing.entityVersion + 1;
      const now = clock.now();
      await (SrcEnquiryModel as any).collection.updateOne(
        { tenantId, enquiryId },
        {
          $set: {
            status: 'DELETED',
            updatedAt: now,
            entityVersion: nextVersion,
          },
        }
      );

      const eventPayload = {
        specversion: '1.0',
        id: `evt_enq_deleted_${crypto.randomUUID()}`,
        type: 'enquiry.deleted',
        source: '/enquiries',
        time: now.toISOString(),
        datacontenttype: 'application/json',
        data: {
          tenantId,
          enquiryId,
          entityVersion: nextVersion,
        },
      };

      await eventConsumerService.ingestEvent({
        id: eventPayload.id,
        tenantId,
        producer: 'enquiries',
        eventType: 'enquiry.deleted',
        entityId: enquiryId,
        entityVersion: nextVersion,
        payload: eventPayload,
        occurredAt: now,
      });

      res.status(200).json({
        success: true,
        enquiryId,
        status: 'DELETED',
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /dev/mock-products
 */
mockEnquiryDevRouter.post(
  ['/dev/mock-products', '/api/v1/dev/mock-products'],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = (req as any).tenantContext?.tenantId || 'shop_a';
      const { productId, name, status = 'ACTIVE', variants = [] } = req.body;

      await (SrcProductModel as any).collection.updateOne(
        { tenantId, productId },
        {
          $set: {
            tenantId,
            productId,
            name,
            status,
            variants,
            entityVersion: 1,
          },
        },
        { upsert: true }
      );

      res.status(201).json({
        success: true,
        productId,
        name,
        status,
        variants,
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /dev/mock-products/:productId/variants/:variantId/stock
 * { sellableQty: number }
 */
mockEnquiryDevRouter.post(
  [
    '/dev/mock-products/:productId/variants/:variantId/stock',
    '/api/v1/dev/mock-products/:productId/variants/:variantId/stock',
  ],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = (req as any).tenantContext?.tenantId || 'shop_a';
      const { productId, variantId } = req.params;
      const { sellableQty } = req.body;

      const product = await SrcProductModel.findOne({ tenantId, productId });
      if (!product) {
        return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Product not found' } });
      }

      await (SrcProductModel as any).collection.updateOne(
        { tenantId, productId, 'variants.variantId': variantId },
        {
          $set: {
            'variants.$.sellableQty': Number(sellableQty),
          },
          $inc: { entityVersion: 1 },
        }
      );

      res.status(200).json({
        success: true,
        productId,
        variantId,
        sellableQty: Number(sellableQty),
      });
    } catch (err) {
      next(err);
    }
  }
);

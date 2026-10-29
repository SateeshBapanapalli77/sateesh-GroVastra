import crypto from 'crypto';
import { Router, Request, Response, NextFunction } from 'express';
import { authenticate, requireRole } from '../../middleware/auth';
import {
  CampaignModel,
  CampaignEnrollmentModel,
  CampaignExecutionModel,
  SrcOrderModel,
  CampaignCustomerFactModel,
} from '../../db/models';
import {
  AUTH_COOKIE_NAME,
  ENROLLMENT_STATUS,
  EXECUTION_STATE,
} from '@grovastra/shared';
import { eventConsumerService } from '../../services/event-consumer';
import { customerFactsService } from '../../services/customer-facts';
import { mockLedgerService } from '../../dev/mockLedger/mockLedger.service';
import { reconcileEventDelayCampaign } from '../_shared/eventDelay/reconcilerBase';
import { NotFoundError, ValidationError } from '../../errors/app-error';
import { clock } from '../../services/clock';
import { logger } from '../../logger';

export const firstToSecondPurchaseRouter = Router();

firstToSecondPurchaseRouter.use((req: Request, res: Response, next: NextFunction) => {
  if (req.path.startsWith('/dev/mock-orders')) {
    if (process.env.NODE_ENV === 'production') {
      return res.status(404).json({
        error: {
          code: 'NOT_FOUND',
          message: 'Dev routes are disabled in production',
        },
      });
    }

    if (req.headers.authorization || (req.cookies && req.cookies[AUTH_COOKIE_NAME])) {
      return authenticate(req, res, next);
    }
    const tenantId = (req.headers['x-tenant-id'] as string) || 'shop_a';
    req.tenantContext = {
      tenantId,
      userId: 'dev-user',
      role: 'owner',
      branchIds: [],
      email: 'dev@example.com',
    };
    return next();
  }
  return authenticate(req, res, next);
});

/**
 * GET /campaigns/:id/repeat-purchase/summary (all roles)
 * Observational metrics only. Spec p28: "observational, NOT sales attribution. No revenue claims."
 */
firstToSecondPurchaseRouter.get(
  ['/campaigns/:id/repeat-purchase/summary', '/api/v1/campaigns/:id/repeat-purchase/summary'],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = req.tenantContext!.tenantId;
      const campaignId = req.params.id;

      const campaign = await CampaignModel.findOne({ tenantId, campaignId }).lean();
      if (!campaign) {
        throw new NotFoundError(`Campaign '${campaignId}' not found`);
      }

      const enrollments = await CampaignEnrollmentModel.find({ tenantId, campaignId }).lean();

      let activeEnrollmentsCount = 0;
      let excludedCount = 0;
      const excludedByReason: Record<string, number> = {};
      const activeEnrollmentIds: string[] = [];

      let totalHeldOrReplied = 0;
      let exactCampaignReplies = 0;
      let conservativeHolds = 0;
      let currentlyOnHold = 0;
      let resolvedHolds = 0;

      for (const enr of enrollments) {
        if (enr.status === (ENROLLMENT_STATUS as any).EXCLUDED) {
          excludedCount++;
          const reason = enr.exclusionReason || 'OTHER';
          excludedByReason[reason] = (excludedByReason[reason] || 0) + 1;
        } else {
          activeEnrollmentsCount++;
          activeEnrollmentIds.push(enr.enrollmentId);
        }

        if (enr.replyHoldAt != null) {
          totalHeldOrReplied++;
          if (enr.replyAttribution === 'CAMPAIGN') {
            exactCampaignReplies++;
          } else {
            conservativeHolds++;
          }
          if (enr.holdResolvedAt == null) {
            currentlyOnHold++;
          } else {
            resolvedHolds++;
          }
        }
      }

      const executions = await CampaignExecutionModel.find({
        tenantId,
        campaignId,
        enrollmentId: { $in: activeEnrollmentIds },
      }).lean();

      let scheduled = 0;
      let deferredCount = 0;
      const deferredByReason: Record<string, number> = {};
      let skippedCount = 0;
      const skippedByReason: Record<string, number> = {};

      let accepted = 0;
      let sent = 0;
      let delivered = 0;
      let read = 0;

      for (const ex of executions) {
        if (ex.state === EXECUTION_STATE.SCHEDULED) {
          scheduled++;
        } else if (ex.state === EXECUTION_STATE.DEFERRED) {
          deferredCount++;
          const reason = ex.deferralReason || 'OUTSIDE_SENDING_HOURS';
          deferredByReason[reason] = (deferredByReason[reason] || 0) + 1;
        } else if (ex.state === EXECUTION_STATE.SKIPPED) {
          skippedCount++;
          const reason = ex.skipReason || 'OTHER';
          skippedByReason[reason] = (skippedByReason[reason] || 0) + 1;
        }

        if (
          [
            EXECUTION_STATE.PROVIDER_ACCEPTED,
            EXECUTION_STATE.SENT,
            EXECUTION_STATE.DELIVERED,
            EXECUTION_STATE.READ,
          ].includes(ex.state as any)
        ) {
          accepted++;
        }
        if (
          [EXECUTION_STATE.SENT, EXECUTION_STATE.DELIVERED, EXECUTION_STATE.READ].includes(
            ex.state as any
          )
        ) {
          sent++;
        }
        if ([EXECUTION_STATE.DELIVERED, EXECUTION_STATE.READ].includes(ex.state as any)) {
          delivered++;
        }
        if (ex.state === EXECUTION_STATE.READ) {
          read++;
        }
      }

      res.status(200).json({
        campaignId,
        note: 'observational, NOT sales attribution',
        enrollments: {
          total: enrollments.length,
          active: activeEnrollmentsCount,
          excluded: excludedCount,
          excludedByReason,
        },
        executions: {
          scheduled,
          deferred: deferredCount,
          deferredByReason,
          skipped: skippedCount,
          skippedByReason,
          accepted,
          sent,
          delivered,
          read,
        },
        repliesAndHolds: {
          totalHeldOrReplied,
          exactCampaignReplies,
          conservativeHolds,
          currentlyOnHold,
          resolvedHolds,
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * Dev-only: POST /dev/mock-orders
 * { customerId, netPaise, status?, paid?, completedAt?, simulateLedger? }
 */
firstToSecondPurchaseRouter.post(
  ['/dev/mock-orders', '/api/v1/dev/mock-orders'],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = req.tenantContext!.tenantId;
      const {
        customerId,
        netPaise,
        status,
        paid,
        completedAt,
        simulateLedger,
        orderId: customOrderId,
        lines,
        occasionRef,
        enquiryRef,
        outfitRef,
      } = req.body;

      const orderId = customOrderId || `ord_${crypto.randomUUID().slice(0, 10)}`;
      const orderNumber = `ORD-${Date.now().toString().slice(-6)}`;
      const parsedCompletedAt = completedAt ? new Date(completedAt) : clock.now();
      const amountPaise = Number(netPaise ?? 250000);
      const isPaid = paid !== undefined ? Boolean(paid) : true;
      const orderStatus = status || 'COMPLETED';

      const lineCount = typeof lines === 'number' && lines > 0 ? lines : 1;
      const orderLines = Array.isArray(lines)
        ? lines.map((l: any, idx: number) => {
            const qty = Number(l.qty ?? l.quantity ?? 1);
            const returnedQty = Number(l.returnedQty ?? 0);
            const pricePaise = Number(l.pricePaise || Math.round(amountPaise / lines.length));
            const lineNetPaise =
              l.lineNetPaise !== undefined ? Number(l.lineNetPaise) : pricePaise * (qty - returnedQty);
            return {
              lineId: l.lineId || `line_${idx + 1}`,
              itemRef: l.itemRef || `item_${idx + 1}`,
              productId: l.productId || null,
              variantId: l.variantId || null,
              name: l.name || `Handloom Item ${idx + 1}`,
              quantity: qty,
              qty,
              returnedQty,
              pricePaise,
              lineNetPaise,
            };
          })
        : Array.from({ length: lineCount }, (_, idx) => ({
            lineId: `line_${idx + 1}`,
            itemRef: `item_${idx + 1}`,
            productId: null,
            variantId: null,
            name: `Handloom Item ${idx + 1}`,
            quantity: 1,
            qty: 1,
            returnedQty: 0,
            pricePaise: Math.round(amountPaise / lineCount),
            lineNetPaise: Math.round(amountPaise / lineCount),
          }));

      const order = await SrcOrderModel.create({
        orderId,
        orderNumber,
        tenantId,
        customerId: customerId || null,
        status: orderStatus,
        paid: isPaid,
        netPaise: amountPaise,
        grossPaise: amountPaise,
        refundedPaise: 0,
        occasionRef: occasionRef || null,
        enquiryRef: enquiryRef || null,
        outfitRef: outfitRef || null,
        completedAt: parsedCompletedAt,
        entityVersion: 1,
        lines: orderLines,
      });

      // Ingest order.completed event
      const eventId = `evt_ord_comp_${crypto.randomUUID().slice(0, 10)}`;
      await eventConsumerService.ingestEvent(tenantId, 'orders', {
        schemaVersion: 1,
        producer: 'orders',
        eventId,
        type: 'order.completed',
        entityId: orderId,
        entityVersion: 1,
        customerId: customerId || null,
        occurredAt: parsedCompletedAt,
        data: {
          orderId,
          orderNumber,
          customerId,
          status: orderStatus,
          paid: isPaid,
          netPaise: amountPaise,
          occasionRef: occasionRef || null,
          enquiryRef: enquiryRef || null,
          outfitRef: outfitRef || null,
          lines: orderLines,
          completedAt: parsedCompletedAt.toISOString(),
        },
      });

      // Optional simulateLedger behavior (spec: stand-in for the ledger owner)
      let simulatedReward: any = null;
      if (simulateLedger === true) {
        const facts: any = await CampaignCustomerFactModel.findOne({ tenantId, customerId }).lean();
        if (facts) {
          if (facts.qualifyingOrderCount === 1) {
            // First qualifying order -> FIRST_ORDER_REWARD credit (15000 paise = ₹150, 120 days)
            const expiry = new Date(parsedCompletedAt.getTime() + 120 * 24 * 3600 * 1000);
            simulatedReward = await mockLedgerService.issueCredit({
              tenantId,
              customerId,
              unit: 'PAISE',
              amount: 15000,
              reason: 'FIRST_ORDER_REWARD',
              expiresAt: expiry,
              sourceOrderId: orderId,
              occurredAt: parsedCompletedAt,
            });
          } else if (facts.qualifyingOrderCount === 2) {
            // Second qualifying order -> SECOND_PURCHASE_CASHBACK credit (5000 paise = ₹50, 90 days)
            const expiry = new Date(parsedCompletedAt.getTime() + 90 * 24 * 3600 * 1000);
            simulatedReward = await mockLedgerService.issueCredit({
              tenantId,
              customerId,
              unit: 'PAISE',
              amount: 5000,
              reason: 'SECOND_PURCHASE_CASHBACK',
              expiresAt: expiry,
              sourceOrderId: orderId,
              occurredAt: parsedCompletedAt,
            });
          }
        }
      }

      res.status(201).json({
        success: true,
        order,
        simulatedReward,
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * Dev-only: POST /dev/mock-orders/:orderId/refund
 * { type: FULL|PARTIAL, refundPaise? }
 */
firstToSecondPurchaseRouter.post(
  '/dev/mock-orders/:orderId/refund',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = req.tenantContext!.tenantId;
      const { orderId } = req.params;
      const { type, refundPaise } = req.body;

      const order = await SrcOrderModel.findOne({ tenantId, orderId });
      if (!order) {
        throw new NotFoundError(`Order '${orderId}' not found`);
      }

      const isFull = type === 'FULL' || (!refundPaise && type !== 'PARTIAL');
      let newNetPaise = 0;
      let newRefundedPaise = order.grossPaise || order.netPaise;

      if (!isFull) {
        const refundAmt = Number(refundPaise || 0);
        newRefundedPaise = (order.refundedPaise || 0) + refundAmt;
        const gross = order.grossPaise || order.netPaise;
        newNetPaise = Math.max(0, gross - newRefundedPaise);
      }

      order.refundedPaise = newRefundedPaise;
      order.netPaise = newNetPaise;
      if (isFull || newNetPaise <= 0) {
        order.status = 'REFUNDED';
      }
      order.entityVersion = (order.entityVersion || 1) + 1;
      await order.save();

      const eventId = `evt_ord_ref_${crypto.randomUUID().slice(0, 10)}`;
      await eventConsumerService.ingestEvent(tenantId, 'orders', {
        schemaVersion: 1,
        producer: 'orders',
        eventId,
        type: 'order.refunded',
        entityId: orderId,
        entityVersion: order.entityVersion,
        customerId: order.customerId,
        occurredAt: clock.now(),
        data: {
          orderId,
          type: isFull ? 'FULL' : 'PARTIAL',
          refundedPaise: newRefundedPaise,
          netPaise: newNetPaise,
          status: order.status,
        },
      });

      res.status(200).json({ success: true, order });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * Dev-only: POST /dev/mock-orders/:orderId/cancel
 */
firstToSecondPurchaseRouter.post(
  '/dev/mock-orders/:orderId/cancel',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = req.tenantContext!.tenantId;
      const { orderId } = req.params;

      const order = await SrcOrderModel.findOne({ tenantId, orderId });
      if (!order) {
        throw new NotFoundError(`Order '${orderId}' not found`);
      }

      order.status = 'CANCELLED';
      order.entityVersion = (order.entityVersion || 1) + 1;
      await order.save();

      const eventId = `evt_ord_cnl_${crypto.randomUUID().slice(0, 10)}`;
      await eventConsumerService.ingestEvent(tenantId, 'orders', {
        schemaVersion: 1,
        producer: 'orders',
        eventId,
        type: 'order.cancelled',
        entityId: orderId,
        entityVersion: order.entityVersion,
        customerId: order.customerId,
        occurredAt: clock.now(),
        data: {
          orderId,
          status: 'CANCELLED',
        },
      });

      res.status(200).json({ success: true, order });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * Dev-only: POST /dev/mock-orders/:orderId/attach-customer
 * Attaches a customerId to an anonymous order and emits order.updated
 */
firstToSecondPurchaseRouter.post(
  '/dev/mock-orders/:orderId/attach-customer',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = req.tenantContext!.tenantId;
      const { orderId } = req.params;
      const { customerId } = req.body;

      if (!customerId) {
        throw new ValidationError('customerId is required');
      }

      const order = await SrcOrderModel.findOne({ tenantId, orderId });
      if (!order) {
        throw new NotFoundError(`Order '${orderId}' not found`);
      }

      order.customerId = customerId;
      order.entityVersion = (order.entityVersion || 1) + 1;
      await order.save();

      const eventId = `evt_ord_upd_${crypto.randomUUID().slice(0, 10)}`;
      await eventConsumerService.ingestEvent(tenantId, 'orders', {
        schemaVersion: 1,
        producer: 'orders',
        eventId,
        type: 'order.updated',
        entityId: orderId,
        entityVersion: order.entityVersion,
        customerId,
        occurredAt: order.completedAt || clock.now(),
        data: {
          orderId,
          customerId,
          status: order.status,
          paid: order.paid,
          netPaise: order.netPaise,
        },
      });

      res.status(200).json({ success: true, order });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * Dev-only: POST /dev/mock-orders/:orderId/lines/:lineId/return
 * { qty }
 */
firstToSecondPurchaseRouter.post(
  [
    '/dev/mock-orders/:orderId/lines/:lineId/return',
    '/api/v1/dev/mock-orders/:orderId/lines/:lineId/return',
  ],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = req.tenantContext!.tenantId;
      const { orderId, lineId } = req.params;
      const returnQty = Math.max(1, Number(req.body.qty || 1));

      const order = await SrcOrderModel.findOne({ tenantId, orderId });
      if (!order) {
        throw new NotFoundError(`Order '${orderId}' not found`);
      }

      const line = (order.lines || []).find((l: any) => l.lineId === lineId);
      if (!line) {
        throw new NotFoundError(`Line '${lineId}' not found in order '${orderId}'`);
      }

      const currentQty = line.qty ?? line.quantity ?? 1;
      const currentReturned = line.returnedQty ?? 0;
      const maxReturnable = currentQty - currentReturned;
      const actualReturnQty = Math.min(returnQty, maxReturnable);

      line.returnedQty = currentReturned + actualReturnQty;
      const linePrice = line.pricePaise || 0;
      const refundPaise = linePrice * actualReturnQty;

      line.lineNetPaise = linePrice * (currentQty - line.returnedQty);
      order.refundedPaise = (order.refundedPaise || 0) + refundPaise;
      order.netPaise = Math.max(0, (order.netPaise || 0) - refundPaise);
      order.entityVersion = (order.entityVersion || 1) + 1;
      order.markModified('lines');
      await order.save();

      // Ingest order.refunded event
      const eventId = `evt_ord_ref_line_${crypto.randomUUID().slice(0, 10)}`;
      await eventConsumerService.ingestEvent(tenantId, 'orders', {
        schemaVersion: 1,
        producer: 'orders',
        eventId,
        type: 'order.refunded',
        entityId: orderId,
        entityVersion: order.entityVersion,
        customerId: order.customerId || null,
        occurredAt: clock.now(),
        data: {
          orderId,
          orderNumber: order.orderNumber,
          customerId: order.customerId,
          status: order.netPaise === 0 ? 'REFUNDED' : order.status,
          paid: order.paid,
          netPaise: order.netPaise,
          refundedPaise: order.refundedPaise,
          returnedLineId: lineId,
          returnedQty: actualReturnQty,
          lines: order.lines,
        },
      });

      res.status(200).json({
        ok: true,
        orderId,
        lineId,
        returnedQty: line.returnedQty,
        orderNetPaise: order.netPaise,
        orderRefundedPaise: order.refundedPaise,
      });
    } catch (err) {
      next(err);
    }
  }
);

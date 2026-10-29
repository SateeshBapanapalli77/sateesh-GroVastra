/**
 * REST routes for Outfit Collection / Delivery Campaign (F31)
 *
 * Endpoints:
 * - GET /fulfilments (all roles, read-only, paginated, masked customer data)
 * - POST /campaigns/:id/fulfilment/preview (owner/admin, read-only)
 * - GET /campaigns/:id/fulfilment/summary (all roles)
 * - Dev Endpoints (NODE_ENV != 'production'):
 *   - POST /dev/mock-fulfilments
 *   - POST /dev/mock-fulfilments/:orderId/ready
 *   - POST /dev/mock-fulfilments/:orderId/collect
 *   - POST /dev/mock-fulfilments/:orderId/rework
 *   - POST /dev/mock-fulfilments/:orderId/cancel
 *   - POST /dev/mock-fulfilments/:orderId/return
 *   - POST /dev/mock-fulfilments/:orderId/mode
 *   - POST /dev/mock-fulfilments/:orderId/deliver
 *   - POST /dev/mock-fulfilments/:orderId/shipments
 *   - POST /dev/mock-fulfilments/:orderId/shipments/:shipmentId/event
 *   - POST /dev/mock-fulfilments/:orderId/replay
 */

import { Router, Request, Response } from 'express';
import {
  CampaignModel,
  CampaignVersionModel,
  CampaignEnrollmentModel,
  CampaignExecutionModel,
  CampaignDeliveryIntentModel,
} from '../../db/models';
import { SrcFulfilmentModel } from '../../db/models/src-fulfilment.model';
import { authenticate, requireRole } from '../../middleware/auth';
import { mockFulfilmentSource } from '../../adapters/fulfilment-source';
import { mockCustomerSource } from '../../adapters/customer-source';
import { matchFulfilmentOrder, matchShipmentDispatched, matchShipmentDelivered } from './matching';
import { eventConsumerService } from '../../services/event-consumer/event-consumer.service';
import { campaignSettingsService } from '../../services/campaign-settings.service';
import { contactGateService } from '../../services/contact-gate';
import { resolveForStep } from '../../templates';
import { delayTiming } from '../_shared/eventDelay/delayTiming';
import { clock } from '../../services/clock';

export const outfitCollectionDeliveryRouter = Router();

/**
 * GET /fulfilments?orderId=&status=&mode=&limit=&cursor=
 */
outfitCollectionDeliveryRouter.get(
  '/fulfilments',
  authenticate,
  async (req: Request, res: Response): Promise<void> => {
    const tenantId = req.tenantContext?.tenantId || (req as any).user?.tenantId;
    const { orderId, status, mode, limit = '50', cursor } = req.query;

    const query: Record<string, any> = { tenantId };
    if (orderId) query.orderId = orderId;
    if (status) query.status = status;
    if (mode) query.mode = mode;
    if (cursor) query._id = { $gt: cursor };

    const take = Math.min(Math.max(Number(limit) || 50, 1), 100);
    const records = await SrcFulfilmentModel.find(query)
      .sort({ _id: 1 })
      .limit(take)
      .lean();

    // Mask customer data
    const maskedRecords = await Promise.all(
      records.map(async (rec) => {
        let maskedPhone: string | null = null;
        if (rec.customerId) {
          const cust = await mockCustomerSource.getCustomerById(tenantId, rec.customerId);
          maskedPhone = cust?.destination?.masked || null;
        }
        return {
          ...rec,
          customerPhone: maskedPhone,
        };
      })
    );

    res.json({
      items: maskedRecords,
      count: maskedRecords.length,
      nextCursor: records.length === take ? records[records.length - 1]._id : null,
    });
  }
);

/**
 * POST /campaigns/:id/fulfilment/preview
 * Evaluates candidates with zero writes/provider calls
 */
outfitCollectionDeliveryRouter.post(
  ['/campaigns/:id/fulfilment/preview', '/campaigns/:id/fulfilment-preview', '/campaigns/outfit-collection-delivery/preview', '/fulfilment/preview'],
  authenticate,
  requireRole(['owner', 'admin']),
  async (req: Request, res: Response): Promise<void> => {
    const tenantId = req.tenantContext?.tenantId || (req as any).user?.tenantId;
    const campaignId = req.params.id || (req.body as any)?.campaignId || (req.query as any)?.campaignId;
    const { orderId } = req.body;

    if (!orderId) {
      res.status(400).json({ error: 'orderId is required' });
      return;
    }

    const campaign: any = await CampaignModel.findOne({ tenantId, campaignId }).lean();
    if (!campaign) {
      res.status(404).json({ error: 'Campaign not found' });
      return;
    }

    const versionDoc: any = await CampaignVersionModel.findOne({
      tenantId,
      campaignId,
    }).sort({ version: -1 }).lean();

    const fulfilment = await mockFulfilmentSource.getFulfilment(tenantId, orderId);
    if (!fulfilment) {
      res.status(404).json({ error: `Fulfilment for order '${orderId}' not found` });
      return;
    }

    const now = clock.now();
    const settings = await campaignSettingsService.getSettings(tenantId);
    const timezone = versionDoc?.timezone || settings?.timezone || 'Asia/Kolkata';

    let customer: any = null;
    if (fulfilment.customerId) {
      customer = await mockCustomerSource.getCustomerById(tenantId, fulfilment.customerId);
    }

    if (!customer) {
      res.json({
        fulfilment: {
          orderId: fulfilment.orderId,
          orderNumber: fulfilment.orderNumber,
          status: fulfilment.status,
          mode: fulfilment.mode,
          readinessVersion: fulfilment.readinessVersion,
          entityVersion: fulfilment.entityVersion,
        },
        wouldEnroll: false,
        reason: 'NO_CUSTOMER_RECORD',
        reasonText: 'Order has no associated customer record',
        steps: [],
      });
      return;
    }

    const matchRes = matchFulfilmentOrder(customer, fulfilment, {
      fulfilmentFilter: versionDoc?.fulfilmentFilter || 'PICKUP',
      partialReadyTemplateRef: versionDoc?.partialReadyTemplateRef,
      now,
    });

    if (!matchRes.eligible) {
      res.json({
        fulfilment: {
          orderId: fulfilment.orderId,
          orderNumber: fulfilment.orderNumber,
          status: fulfilment.status,
          mode: fulfilment.mode,
          readinessVersion: fulfilment.readinessVersion,
          entityVersion: fulfilment.entityVersion,
        },
        wouldEnroll: false,
        reason: matchRes.reason,
        reasonText: matchRes.reasonText,
        steps: [],
      });
      return;
    }

    const allSteps: any[] = versionDoc?.steps || [];
    const stepsToPreview = matchRes.isPartial ? [allSteps[0]] : allSteps;
    const anchorAt = fulfilment.readyAt ? new Date(fulfilment.readyAt) : now;
    const usefulForDays = versionDoc?.usefulForDays || 14;
    const usefulUntilLimit = new Date(anchorAt.getTime() + usefulForDays * 24 * 60 * 60 * 1000);

    const previewSteps = [];
    let renderedParameters: any[] = [];

    for (const step of stepsToPreview) {
      const delayMinutes =
        step.delay?.unit === 'DAYS'
          ? (step.delay.value || 0) * 1440
          : (step.offsetDays || 0) * 1440;
      const rawDueAt = new Date(anchorAt.getTime() + delayMinutes * 60 * 1000);

      const timing = delayTiming({
        rawDueAt,
        timezone,
        outsideHoursPolicy: step.outsideHoursPolicy || 'DEFER_NEXT_DAY',
        maxDeferralHours: step.maxDeferralHours || 16,
        allowedSendingHours: settings?.allowedSendingHours || { start: '10:00', end: '19:00' },
      });

      const maxLatenessMinutes = step.maxLatenessMinutes || 360;
      const latenessLimit = new Date(timing.adjustedDueAt.getTime() + maxLatenessMinutes * 60 * 1000);
      const expiresAt = new Date(Math.min(latenessLimit.getTime(), usefulUntilLimit.getTime()));

      previewSteps.push({
        stepId: step.stepId,
        rawDueAt: rawDueAt.toISOString(),
        adjustedDueAt: timing.adjustedDueAt.toISOString(),
        localDate: timing.localDate,
        localTime: timing.localTime,
        expiresAt: expiresAt.toISOString(),
      });

      if (renderedParameters.length === 0 && step.templateRef) {
        try {
          const resRes = await resolveForStep({
            tenantId,
            template: step.templateRef as any,
            step,
            customer,
            campaignVersion: versionDoc,
            timezone,
            serverNow: timing.adjustedDueAt,
            clock,
            overrides: {
              fulfilmentOrderNumber: fulfilment.orderNumber,
            },
          });
          if (resRes.ok) {
            renderedParameters = resRes.canonicalParameters;
          }
        } catch {}
      }
    }

    // Service spacing note
    let spacingNote = 'No service spacing conflicts detected.';
    const gate = await contactGateService.getGate(tenantId, customer.destination.destinationHash);
    const lastService = (gate?.ledger || [])
      .filter((e: any) => e.purpose === 'SERVICE' && e.status !== 'RELEASED')
      .sort((a: any, b: any) => new Date(b.reservedAt).getTime() - new Date(a.reservedAt).getTime())[0];

    if (lastService) {
      const spacingHours = settings.serviceContactSpacingHours ?? 24;
      spacingNote = `Last service contact sent at ${new Date(lastService.reservedAt).toISOString()} (spacing rule: ${spacingHours}h).`;
    }

    res.json({
      fulfilment: {
        orderId: fulfilment.orderId,
        orderNumber: fulfilment.orderNumber,
        status: fulfilment.status,
        mode: fulfilment.mode,
        readinessVersion: fulfilment.readinessVersion,
        entityVersion: fulfilment.entityVersion,
      },
      wouldEnroll: true,
      reason: 'ELIGIBLE',
      steps: previewSteps,
      renderedParameters,
      spacingNote,
    });
  }
);

/**
 * GET /campaigns/:id/fulfilment/summary
 */
outfitCollectionDeliveryRouter.get(
  '/campaigns/:id/fulfilment/summary',
  authenticate,
  async (req: Request, res: Response): Promise<void> => {
    const tenantId = req.tenantContext?.tenantId || (req as any).user?.tenantId;
    const campaignId = req.params.id;

    const campaign: any = await CampaignModel.findOne({ tenantId, campaignId }).lean();
    if (!campaign) {
      res.status(404).json({ error: 'Campaign not found' });
      return;
    }

    const [
      totalFulfilments,
      enrollmentsCount,
      executionsScheduled,
      executionsDeferred,
      executionsSkipped,
      executionsSent,
      executionsDelivered,
      executionsRead,
      executionsBlockedStale,
      replyHoldsCount,
    ] = await Promise.all([
      SrcFulfilmentModel.countDocuments({ tenantId }),
      CampaignEnrollmentModel.countDocuments({ tenantId, campaignId }),
      CampaignExecutionModel.countDocuments({ tenantId, campaignId, state: 'SCHEDULED' }),
      CampaignExecutionModel.countDocuments({ tenantId, campaignId, state: 'DEFERRED' }),
      CampaignExecutionModel.countDocuments({ tenantId, campaignId, state: 'SKIPPED' }),
      CampaignExecutionModel.countDocuments({ tenantId, campaignId, state: { $in: ['SENT', 'PROVIDER_ACCEPTED'] } }),
      CampaignExecutionModel.countDocuments({ tenantId, campaignId, state: 'DELIVERED' }),
      CampaignExecutionModel.countDocuments({ tenantId, campaignId, state: 'READ' }),
      CampaignExecutionModel.countDocuments({ tenantId, campaignId, state: 'BLOCKED', skipReason: 'BLOCKED_STALE_INTENT' }),
      CampaignEnrollmentModel.countDocuments({ tenantId, campaignId, replyHoldAt: { $ne: null } }),
    ]);

    // Breakdown of skipped executions
    const skippedRecords = await CampaignExecutionModel.find({
      tenantId,
      campaignId,
      state: 'SKIPPED',
    }).select('skipReason').lean();

    const skippedByReason: Record<string, number> = {};
    for (const r of skippedRecords) {
      const code = r.skipReason || 'UNKNOWN';
      skippedByReason[code] = (skippedByReason[code] || 0) + 1;
    }

    // Orders collected after notice was sent (observational only, spec p28)
    const noticeExecutions = await CampaignExecutionModel.find({
      tenantId,
      campaignId,
      stepId: 'ready_notice',
      state: { $in: ['SENT', 'PROVIDER_ACCEPTED', 'DELIVERED', 'READ'] },
    }).lean();

    let collectedAfterNoticeCount = 0;
    for (const ex of noticeExecutions) {
      const orderId = ex.selectionSnapshot?.orderId;
      if (orderId) {
        const ful: any = await SrcFulfilmentModel.findOne({ tenantId, orderId }).lean();
        if (ful && ful.status === 'COLLECTED' && ful.collectedAt && ex.sentAt) {
          if (new Date(ful.collectedAt).getTime() > new Date(ex.sentAt).getTime()) {
            collectedAfterNoticeCount++;
          }
        }
      }
    }

    res.json({
      campaignId,
      status: campaign.status,
      milestonesSeen: totalFulfilments,
      enrollments: enrollmentsCount,
      scheduled: executionsScheduled,
      deferred: executionsDeferred,
      skipped: executionsSkipped,
      skippedByReason,
      exclusionsByReason: skippedByReason,
      sent: executionsSent,
      accepted: executionsSent,
      delivered: executionsDelivered,
      read: executionsRead,
      staleBlocks: executionsBlockedStale,
      replyHolds: replyHoldsCount,
      ordersCollectedAfterNotice: {
        count: collectedAfterNoticeCount,
        note: 'Observational only; not sales attribution (spec p28)',
      },
      observationalNote: 'Observational only; not sales attribution (spec p28)',
    });
  }
);

/**
 * =============================================================================
 * DEV ENDPOINTS (Blocked in NODE_ENV === 'production')
 * =============================================================================
 */

function checkDevMode(req: Request, res: Response, next: () => void) {
  if (process.env.NODE_ENV === 'production') {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  next();
}

/**
 * POST /dev/mock-fulfilments
 * Creates NOT_READY mock fulfilment
 */
outfitCollectionDeliveryRouter.post(
  '/dev/mock-fulfilments',
  checkDevMode,
  authenticate,
  async (req: Request, res: Response): Promise<void> => {
    const tenantId = req.tenantContext?.tenantId || (req as any).user?.tenantId || 'shop_a';
    const { customerId, mode = 'PICKUP', orderNumber, orderId } = req.body;

    const ordId = orderId || `ord_f_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const ordNum = orderNumber || `ORD-F-${Date.now().toString().slice(-4)}`;

    const fulfilment = await SrcFulfilmentModel.create({
      tenantId,
      orderId: ordId,
      customerId,
      branchId: 'branch_main',
      orderNumber: ordNum,
      mode,
      status: 'NOT_READY',
      readinessKind: null,
      readinessVersion: 0,
      readyAt: null,
      collectedAt: null,
      entityVersion: 1,
      shipments: [],
      source: 'MOCK',
    });

    res.status(201).json(fulfilment);
  }
);

/**
 * POST /dev/mock-fulfilments/:orderId/ready
 */
outfitCollectionDeliveryRouter.post(
  '/dev/mock-fulfilments/:orderId/ready',
  checkDevMode,
  authenticate,
  async (req: Request, res: Response): Promise<void> => {
    const tenantId = req.tenantContext?.tenantId || (req as any).user?.tenantId || 'shop_a';
    const { orderId } = req.params;
    const { kind = 'FULL', readyAt } = req.body;

    const now = readyAt ? new Date(readyAt) : clock.now();
    const fulfilment = await SrcFulfilmentModel.findOne({ tenantId, orderId });
    if (!fulfilment) {
      res.status(404).json({ error: `Fulfilment '${orderId}' not found` });
      return;
    }

    const newReadinessVersion = fulfilment.readinessVersion + 1;
    const newEntityVersion = fulfilment.entityVersion + 1;
    const newStatus = kind === 'PARTIAL' ? 'PARTIALLY_READY' : 'READY_FOR_COLLECTION';

    fulfilment.status = newStatus;
    fulfilment.readinessKind = kind;
    fulfilment.readinessVersion = newReadinessVersion;
    fulfilment.readyAt = now;
    fulfilment.entityVersion = newEntityVersion;
    await fulfilment.save();

    // Emit fulfilment.updated event
    const eventResult = await eventConsumerService.ingestEvent({
      tenantId,
      producer: 'fulfilment',
      eventId: `evt_ful_${Date.now()}`,
      type: 'fulfilment.updated',
      entityId: orderId,
      entityVersion: newEntityVersion,
      occurredAt: now.toISOString(),
      receivedAt: now.toISOString(),
      customerId: fulfilment.customerId,
      data: {
        orderNumber: fulfilment.orderNumber,
        branchId: fulfilment.branchId,
        mode: fulfilment.mode,
        status: newStatus,
        readinessKind: kind,
        readinessVersion: newReadinessVersion,
        readyAt: now.toISOString(),
      },
    });

    res.json({ fulfilment, eventResult });
  }
);

/**
 * POST /dev/mock-fulfilments/:orderId/collect
 */
outfitCollectionDeliveryRouter.post(
  '/dev/mock-fulfilments/:orderId/collect',
  checkDevMode,
  authenticate,
  async (req: Request, res: Response): Promise<void> => {
    const tenantId = req.tenantContext?.tenantId || (req as any).user?.tenantId || 'shop_a';
    const { orderId } = req.params;

    const now = clock.now();
    const fulfilment = await SrcFulfilmentModel.findOne({ tenantId, orderId });
    if (!fulfilment) {
      res.status(404).json({ error: `Fulfilment '${orderId}' not found` });
      return;
    }

    const newEntityVersion = fulfilment.entityVersion + 1;
    fulfilment.status = 'COLLECTED';
    fulfilment.collectedAt = now;
    fulfilment.entityVersion = newEntityVersion;
    await fulfilment.save();

    const eventResult = await eventConsumerService.ingestEvent({
      tenantId,
      producer: 'fulfilment',
      eventId: `evt_ful_col_${Date.now()}`,
      type: 'fulfilment.updated',
      entityId: orderId,
      entityVersion: newEntityVersion,
      occurredAt: now.toISOString(),
      receivedAt: now.toISOString(),
      customerId: fulfilment.customerId,
      data: {
        orderNumber: fulfilment.orderNumber,
        branchId: fulfilment.branchId,
        mode: fulfilment.mode,
        status: 'COLLECTED',
        readinessKind: fulfilment.readinessKind,
        readinessVersion: fulfilment.readinessVersion,
        readyAt: fulfilment.readyAt?.toISOString(),
        collectedAt: now.toISOString(),
      },
    });

    res.json({ fulfilment, eventResult });
  }
);

/**
 * POST /dev/mock-fulfilments/:orderId/rework
 */
outfitCollectionDeliveryRouter.post(
  '/dev/mock-fulfilments/:orderId/rework',
  checkDevMode,
  authenticate,
  async (req: Request, res: Response): Promise<void> => {
    const tenantId = req.tenantContext?.tenantId || (req as any).user?.tenantId || 'shop_a';
    const { orderId } = req.params;
    const { reason = 'ALTERATION_REQUIRED' } = req.body;

    const now = clock.now();
    const fulfilment = await SrcFulfilmentModel.findOne({ tenantId, orderId });
    if (!fulfilment) {
      res.status(404).json({ error: `Fulfilment '${orderId}' not found` });
      return;
    }

    const newEntityVersion = fulfilment.entityVersion + 1;
    fulfilment.status = 'REWORK';
    fulfilment.entityVersion = newEntityVersion;
    await fulfilment.save();

    const eventResult = await eventConsumerService.ingestEvent({
      tenantId,
      producer: 'fulfilment',
      eventId: `evt_ful_rew_${Date.now()}`,
      type: 'fulfilment.updated',
      entityId: orderId,
      entityVersion: newEntityVersion,
      occurredAt: now.toISOString(),
      receivedAt: now.toISOString(),
      customerId: fulfilment.customerId,
      data: {
        orderNumber: fulfilment.orderNumber,
        branchId: fulfilment.branchId,
        mode: fulfilment.mode,
        status: 'REWORK',
        readinessKind: fulfilment.readinessKind,
        readinessVersion: fulfilment.readinessVersion,
        readyAt: fulfilment.readyAt?.toISOString(),
        reason,
      },
    });

    res.json({ fulfilment, eventResult });
  }
);

/**
 * POST /dev/mock-fulfilments/:orderId/cancel
 */
outfitCollectionDeliveryRouter.post(
  '/dev/mock-fulfilments/:orderId/cancel',
  checkDevMode,
  authenticate,
  async (req: Request, res: Response): Promise<void> => {
    const tenantId = req.tenantContext?.tenantId || (req as any).user?.tenantId || 'shop_a';
    const { orderId } = req.params;

    const now = clock.now();
    const fulfilment = await SrcFulfilmentModel.findOne({ tenantId, orderId });
    if (!fulfilment) {
      res.status(404).json({ error: `Fulfilment '${orderId}' not found` });
      return;
    }

    const newEntityVersion = fulfilment.entityVersion + 1;
    fulfilment.status = 'CANCELLED';
    fulfilment.entityVersion = newEntityVersion;
    await fulfilment.save();

    const eventResult = await eventConsumerService.ingestEvent({
      tenantId,
      producer: 'fulfilment',
      eventId: `evt_ful_can_${Date.now()}`,
      type: 'fulfilment.updated',
      entityId: orderId,
      entityVersion: newEntityVersion,
      occurredAt: now.toISOString(),
      receivedAt: now.toISOString(),
      customerId: fulfilment.customerId,
      data: {
        orderNumber: fulfilment.orderNumber,
        branchId: fulfilment.branchId,
        mode: fulfilment.mode,
        status: 'CANCELLED',
      },
    });

    res.json({ fulfilment, eventResult });
  }
);

/**
 * POST /dev/mock-fulfilments/:orderId/return
 */
outfitCollectionDeliveryRouter.post(
  '/dev/mock-fulfilments/:orderId/return',
  checkDevMode,
  authenticate,
  async (req: Request, res: Response): Promise<void> => {
    const tenantId = req.tenantContext?.tenantId || (req as any).user?.tenantId || 'shop_a';
    const { orderId } = req.params;

    const now = clock.now();
    const fulfilment = await SrcFulfilmentModel.findOne({ tenantId, orderId });
    if (!fulfilment) {
      res.status(404).json({ error: `Fulfilment '${orderId}' not found` });
      return;
    }

    const newEntityVersion = fulfilment.entityVersion + 1;
    fulfilment.status = 'RETURNED';
    fulfilment.entityVersion = newEntityVersion;
    await fulfilment.save();

    const eventResult = await eventConsumerService.ingestEvent({
      tenantId,
      producer: 'fulfilment',
      eventId: `evt_ful_ret_${Date.now()}`,
      type: 'fulfilment.updated',
      entityId: orderId,
      entityVersion: newEntityVersion,
      occurredAt: now.toISOString(),
      receivedAt: now.toISOString(),
      customerId: fulfilment.customerId,
      data: {
        orderNumber: fulfilment.orderNumber,
        branchId: fulfilment.branchId,
        mode: fulfilment.mode,
        status: 'RETURNED',
      },
    });

    res.json({ fulfilment, eventResult });
  }
);

/**
 * POST /dev/mock-fulfilments/:orderId/mode
 */
outfitCollectionDeliveryRouter.post(
  '/dev/mock-fulfilments/:orderId/mode',
  checkDevMode,
  authenticate,
  async (req: Request, res: Response): Promise<void> => {
    const tenantId = req.tenantContext?.tenantId || (req as any).user?.tenantId || 'shop_a';
    const { orderId } = req.params;
    const { mode } = req.body;

    const now = clock.now();
    const fulfilment = await SrcFulfilmentModel.findOne({ tenantId, orderId });
    if (!fulfilment) {
      res.status(404).json({ error: `Fulfilment '${orderId}' not found` });
      return;
    }

    const newEntityVersion = fulfilment.entityVersion + 1;
    fulfilment.mode = mode;
    fulfilment.entityVersion = newEntityVersion;
    await fulfilment.save();

    const eventResult = await eventConsumerService.ingestEvent({
      tenantId,
      producer: 'fulfilment',
      eventId: `evt_ful_mod_${Date.now()}`,
      type: 'fulfilment.updated',
      entityId: orderId,
      entityVersion: newEntityVersion,
      occurredAt: now.toISOString(),
      receivedAt: now.toISOString(),
      customerId: fulfilment.customerId,
      data: {
        orderNumber: fulfilment.orderNumber,
        branchId: fulfilment.branchId,
        mode,
        status: fulfilment.status,
        readinessKind: fulfilment.readinessKind,
        readinessVersion: fulfilment.readinessVersion,
        readyAt: fulfilment.readyAt?.toISOString(),
      },
    });

    res.json({ fulfilment, eventResult });
  }
);

/**
 * POST /dev/mock-fulfilments/:orderId/deliver
 */
outfitCollectionDeliveryRouter.post(
  '/dev/mock-fulfilments/:orderId/deliver',
  checkDevMode,
  authenticate,
  async (req: Request, res: Response): Promise<void> => {
    const tenantId = req.tenantContext?.tenantId || (req as any).user?.tenantId || 'shop_a';
    const { orderId } = req.params;

    const now = clock.now();
    const fulfilment = await SrcFulfilmentModel.findOne({ tenantId, orderId });
    if (!fulfilment) {
      res.status(404).json({ error: `Fulfilment '${orderId}' not found` });
      return;
    }

    const newEntityVersion = fulfilment.entityVersion + 1;
    fulfilment.status = 'DELIVERED';
    fulfilment.entityVersion = newEntityVersion;
    await fulfilment.save();

    const eventResult = await eventConsumerService.ingestEvent({
      tenantId,
      producer: 'fulfilment',
      eventId: `evt_ful_dlv_${Date.now()}`,
      type: 'fulfilment.updated',
      entityId: orderId,
      entityVersion: newEntityVersion,
      occurredAt: now.toISOString(),
      receivedAt: now.toISOString(),
      customerId: fulfilment.customerId,
      data: {
        orderNumber: fulfilment.orderNumber,
        branchId: fulfilment.branchId,
        mode: fulfilment.mode,
        status: 'DELIVERED',
      },
    });

    res.json({ fulfilment, eventResult });
  }
);

/**
 * POST /dev/mock-fulfilments/:orderId/shipments
 */
outfitCollectionDeliveryRouter.post(
  '/dev/mock-fulfilments/:orderId/shipments',
  checkDevMode,
  authenticate,
  async (req: Request, res: Response): Promise<void> => {
    const tenantId = req.tenantContext?.tenantId || (req as any).user?.tenantId || 'shop_a';
    const { orderId } = req.params;
    const { carrier = 'SAMPLE_COURIER', carrierName = 'Sample Courier', trackingRef } = req.body;

    const fulfilment = await SrcFulfilmentModel.findOne({ tenantId, orderId });
    if (!fulfilment) {
      res.status(404).json({ error: `Fulfilment '${orderId}' not found` });
      return;
    }

    const shipmentId = `shp_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const newShipment = {
      shipmentId,
      carrier,
      carrierName,
      trackingRef: trackingRef || null,
      status: 'LABEL_CREATED' as const,
      verified: false,
      lastCourierEventId: null,
      dispatchedAt: null,
      deliveredAt: null,
      entityVersion: 1,
    };

    fulfilment.shipments.push(newShipment as any);
    fulfilment.entityVersion += 1;
    await fulfilment.save();

    res.status(201).json({ shipment: newShipment, fulfilment });
  }
);

/**
 * POST /dev/mock-fulfilments/:orderId/shipments/:shipmentId/event
 */
outfitCollectionDeliveryRouter.post(
  '/dev/mock-fulfilments/:orderId/shipments/:shipmentId/event',
  checkDevMode,
  authenticate,
  async (req: Request, res: Response): Promise<void> => {
    const tenantId = req.tenantContext?.tenantId || (req as any).user?.tenantId || 'shop_a';
    const { orderId, shipmentId } = req.params;
    const { status, verified = true, courierEventId } = req.body;

    const now = clock.now();
    const fulfilment = await SrcFulfilmentModel.findOne({ tenantId, orderId });
    if (!fulfilment) {
      res.status(404).json({ error: `Fulfilment '${orderId}' not found` });
      return;
    }

    const shipment = fulfilment.shipments.find((s: any) => s.shipmentId === shipmentId);
    if (!shipment) {
      res.status(404).json({ error: `Shipment '${shipmentId}' not found` });
      return;
    }

    shipment.status = status;
    shipment.verified = verified;
    if (courierEventId) shipment.lastCourierEventId = courierEventId;
    if (status === 'DISPATCHED' && !shipment.dispatchedAt) shipment.dispatchedAt = now;
    if (status === 'DELIVERED' && !shipment.deliveredAt) shipment.deliveredAt = now;
    shipment.entityVersion += 1;
    fulfilment.entityVersion += 1;
    await fulfilment.save();

    const eventResult = await eventConsumerService.ingestEvent({
      tenantId,
      producer: 'fulfilment',
      eventId: `evt_shp_${Date.now()}`,
      type: 'shipment.updated',
      entityId: shipmentId,
      entityVersion: shipment.entityVersion,
      occurredAt: now.toISOString(),
      receivedAt: now.toISOString(),
      customerId: fulfilment.customerId,
      data: {
        orderId,
        orderNumber: fulfilment.orderNumber,
        branchId: fulfilment.branchId,
        carrier: shipment.carrier,
        carrierName: shipment.carrierName,
        trackingRef: shipment.trackingRef,
        status,
        verified,
        courierEventId,
        dispatchedAt: shipment.dispatchedAt?.toISOString(),
        deliveredAt: shipment.deliveredAt?.toISOString(),
      },
    });

    res.json({ shipment, eventResult });
  }
);

/**
 * POST /dev/mock-fulfilments/:orderId/replay
 * Replays an event with an older entityVersion to verify staleness
 */
outfitCollectionDeliveryRouter.post(
  '/dev/mock-fulfilments/:orderId/replay',
  checkDevMode,
  authenticate,
  async (req: Request, res: Response): Promise<void> => {
    const tenantId = req.tenantContext?.tenantId || (req as any).user?.tenantId || 'shop_a';
    const { orderId } = req.params;
    const { entityVersion = 1, type = 'fulfilment.updated' } = req.body;

    const fulfilment = await SrcFulfilmentModel.findOne({ tenantId, orderId });
    if (!fulfilment) {
      res.status(404).json({ error: `Fulfilment '${orderId}' not found` });
      return;
    }

    const eventResult = await eventConsumerService.ingestEvent({
      tenantId,
      producer: 'fulfilment',
      eventId: `evt_replay_${Date.now()}`,
      type,
      entityId: orderId,
      entityVersion: Number(entityVersion),
      occurredAt: clock.now().toISOString(),
      receivedAt: clock.now().toISOString(),
      customerId: fulfilment.customerId,
      data: {
        orderNumber: fulfilment.orderNumber,
        branchId: fulfilment.branchId,
        mode: fulfilment.mode,
        status: fulfilment.status,
        readinessKind: fulfilment.readinessKind,
        readinessVersion: fulfilment.readinessVersion,
        readyAt: fulfilment.readyAt?.toISOString(),
      },
    });

    res.json({ eventResult });
  }
);

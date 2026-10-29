import crypto from 'crypto';
import { Router, Request, Response, NextFunction } from 'express';
import { AUTH_COOKIE_NAME, ENROLLMENT_STATUS, EXECUTION_STATE, formatPaiseInr } from '@grovastra/shared';
import { authenticate, requireRole } from '../../middleware/auth';
import { CampaignEnrollmentModel, CampaignExecutionModel, CampaignModel, CampaignVersionModel, CampaignCheckpointModel, SrcCustomerModel } from '../../db/models';
import { mockOfferSource } from '../../adapters/OfferSource';
import { mockProductSource } from '../../adapters/product-source';
import { matchSelectedStock } from './matching';
import { eventConsumerService } from '../../services/event-consumer';
import { ValidationError, NotFoundError } from '../../errors/app-error';
import { clock } from '../../services/clock';
import { z } from 'zod';

const offerEventBody = z.object({
  offerId: z.string().trim().min(1),
  entityVersion: z.number().int().positive().optional(),
});

export const selectedStockPromotionRouter = Router();
selectedStockPromotionRouter.use((req: Request, res: Response, next: NextFunction) => {
  if (req.path.startsWith('/dev/') && !req.headers.authorization && !(req.cookies && req.cookies[AUTH_COOKIE_NAME])) {
    req.tenantContext = { tenantId: (req.headers['x-tenant-id'] as string) || 'shop_a', userId: 'dev-user', role: 'owner', branchIds: [], email: 'dev@example.com' };
    return next();
  }
  return authenticate(req, res, next);
});

selectedStockPromotionRouter.post('/campaigns/:id/selected-stock/preview', requireRole('owner', 'admin'), async (req, res, next) => {
  try {
    const tenantId = req.tenantContext!.tenantId;
    const campaign = await CampaignModel.findOne({ tenantId, campaignId: req.params.id }).lean();
    if (!campaign) throw new NotFoundError(`Campaign '${req.params.id}' not found`);
    const offer = await mockOfferSource.getOffer(tenantId, String(req.body.offerId || ''));
    if (!offer || offer.kind !== 'SELECTED_STOCK') throw new ValidationError('A SELECTED_STOCK offerId is required');
    const version: any = await CampaignVersionModel.findOne({ tenantId, campaignId: req.params.id }).sort({ version: -1 }).lean();
    const customers = await SrcCustomerModel.find({ tenantId }).sort({ customerId: 1 }).limit(5001).lean();
    const truncated = customers.length > 5000;
    const rows = customers.slice(0, 5000);
    let matched = 0;
    const excludedByReason: Record<string, number> = {};
    const samples: any[] = [];
    for (const customer of rows) {
      const products = await Promise.all((offer.items || []).map((item) => mockProductSource.getProduct(tenantId, item.productId)));
      const result = matchSelectedStock({ customerId: customer.customerId, preferences: customer.preferences }, products.filter(Boolean) as any, offer as any, {
        mode: version?.matchMode || 'STRICT', audienceMode: version?.audience?.mode || 'PREFERENCE_MATCH', maxItems: version?.maxItemsInMessage || 3,
      });
      if (result.matched) matched++;
      for (const excluded of result.excluded) excludedByReason[excluded.reason] = (excludedByReason[excluded.reason] || 0) + 1;
      const wanted = Array.isArray(req.body.sampleCustomerIds) && req.body.sampleCustomerIds.includes(customer.customerId);
      if (wanted || samples.length < 5) samples.push({ customerRef: customer.destination?.masked || customer.customerId, matched: result.matched, items: result.items, matchReasons: result.matchReasons, rejected: result.excluded });
    }
    return res.json({
      offer: { name: offer.name, status: offer.status, validUntil: offer.validUntil, discountText: offer.discount, valid: true },
      items: offer.items || [], wouldCount: matched, scanned: rows.length, truncated, matched, excludedByReason,
      estimatedRecipients: matched, limit: version?.maxRecipientsPerOffer || 1000, limitReached: matched >= (version?.maxRecipientsPerOffer || 1000),
      samples,
    });
  } catch (error) { next(error); }
});

selectedStockPromotionRouter.get('/campaigns/:id/selected-stock/summary', requireRole('owner', 'admin', 'staff'), async (req, res, next) => {
  try {
    const tenantId = req.tenantContext!.tenantId;
    const campaignId = req.params.id;
    const enrollments = await CampaignEnrollmentModel.find({ tenantId, campaignId, occurrenceId: { $regex: '^stockoffer:' } }).lean();
    const enrollmentIds = enrollments.map((entry) => entry.enrollmentId);
    const executions = await CampaignExecutionModel.find({ tenantId, campaignId, enrollmentId: { $in: enrollmentIds } }).lean();
    const skippedByReason: Record<string, number> = {};
    let scheduled = 0, deferred = 0, skipped = 0, sent = 0, delivered = 0, read = 0;
    for (const execution of executions) {
      if (execution.state === EXECUTION_STATE.SCHEDULED) scheduled++;
      if (execution.state === EXECUTION_STATE.DEFERRED) deferred++;
      if (execution.state === EXECUTION_STATE.SKIPPED) { skipped++; const reason = execution.skipReason || 'OTHER'; skippedByReason[reason] = (skippedByReason[reason] || 0) + 1; }
      if (execution.state === EXECUTION_STATE.SENT || execution.state === EXECUTION_STATE.PROVIDER_ACCEPTED) sent++;
      if (execution.state === EXECUTION_STATE.DELIVERED) delivered++;
      if (execution.state === EXECUTION_STATE.READ) read++;
    }
    return res.json({ offersSeen: new Set(enrollments.map((entry) => entry.occurrenceId)).size, enrollments: enrollments.length, excluded: enrollments.filter((entry) => entry.status === ENROLLMENT_STATUS.EXCLUDED).length, scheduled, deferred, skipped, skippedByReason, sent, delivered, read, staleBlocks: {} });
  } catch (error) { next(error); }
});

selectedStockPromotionRouter.post('/dev/selected-stock/trigger-published', requireRole('owner', 'admin'), async (req, res, next) => {
  try {
    const tenantId = req.tenantContext!.tenantId;
    const parsed = offerEventBody.safeParse(req.body);
    if (!parsed.success) throw new ValidationError('offerId is required');
    const offerId = parsed.data.offerId;
    const eventId = `evt_offer_pub_${crypto.randomUUID().slice(0, 10)}`;
    const result = await eventConsumerService.ingestEvent({ schemaVersion: 1, producer: 'offers', eventId, tenantId, type: 'offer.published', entityId: offerId, entityVersion: parsed.data.entityVersion || 1, occurredAt: clock.now().toISOString(), data: {} });
    return res.json({ ok: true, eventId, offerId, status: result.status, effects: result.effects });
  } catch (error) { next(error); }
});

selectedStockPromotionRouter.post('/dev/selected-stock/trigger-updated', requireRole('owner', 'admin'), async (req, res, next) => {
  try {
    const tenantId = req.tenantContext!.tenantId;
    const parsed = offerEventBody.safeParse(req.body);
    if (!parsed.success) throw new ValidationError('offerId is required');
    const offerId = parsed.data.offerId;
    const eventId = `evt_offer_upd_${crypto.randomUUID().slice(0, 10)}`;
    const result = await eventConsumerService.ingestEvent({ schemaVersion: 1, producer: 'offers', eventId, tenantId, type: 'offer.updated', entityId: offerId, entityVersion: parsed.data.entityVersion || 1, occurredAt: clock.now().toISOString(), data: {} });
    return res.json({ ok: true, eventId, offerId, status: result.status, effects: result.effects });
  } catch (error) { next(error); }
});

selectedStockPromotionRouter.post('/dev/selected-stock/trigger-withdrawn', requireRole('owner', 'admin'), async (req, res, next) => {
  try {
    const parsed = offerEventBody.safeParse(req.body);
    if (!parsed.success) throw new ValidationError('offerId is required');
    const tenantId = req.tenantContext!.tenantId;
    const eventId = `evt_offer_wdr_${crypto.randomUUID().slice(0, 10)}`;
    const result = await eventConsumerService.ingestEvent({
      schemaVersion: 1,
      producer: 'offers',
      eventId,
      tenantId,
      type: 'offer.withdrawn',
      entityId: parsed.data.offerId,
      entityVersion: parsed.data.entityVersion || 1,
      occurredAt: clock.now().toISOString(),
      data: {},
    });
    return res.json({ ok: true, eventId, offerId: parsed.data.offerId, status: result.status, effects: result.effects });
  } catch (error) { next(error); }
});

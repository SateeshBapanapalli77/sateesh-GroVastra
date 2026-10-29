import crypto from 'crypto';
import { Router, Request, Response, NextFunction } from 'express';
import { AUTH_COOKIE_NAME, ENROLLMENT_STATUS, EXECUTION_STATE } from '@grovastra/shared';
import { authenticate, requireRole } from '../../middleware/auth';
import {
  CampaignEnrollmentModel,
  CampaignExecutionModel,
  CampaignModel,
  CampaignVersionModel,
  SrcCustomerModel,
  SrcCollectionModel,
} from '../../db/models';
import { mockSeasonSource } from '../../adapters/season-source';
import { matchFestivalCollection } from './matching';
import { eventConsumerService } from '../../services/event-consumer';
import { ValidationError, NotFoundError } from '../../errors/app-error';
import { clock } from '../../services/clock';
import { z } from 'zod';

const seasonEventBody = z.object({
  seasonId: z.string().trim().min(1),
  type: z.enum(['season.published', 'season.updated', 'season.cancelled', 'season.withdrawn']).optional(),
  entityVersion: z.number().int().positive().optional(),
});

export const festivalCollectionRouter = Router();

festivalCollectionRouter.use((req: Request, res: Response, next: NextFunction) => {
  if (
    (req.path.startsWith('/dev/') || req.path.startsWith('/api/dev/')) &&
    !req.headers.authorization &&
    !(req.cookies && req.cookies[AUTH_COOKIE_NAME])
  ) {
    req.tenantContext = {
      tenantId: (req.headers['x-tenant-id'] as string) || 'shop_a',
      userId: 'dev-user',
      role: 'owner',
      branchIds: [],
      email: 'dev@example.com',
    };
    return next();
  }
  return authenticate(req, res, next);
});

festivalCollectionRouter.post(
  '/campaigns/:id/festival/preview',
  requireRole('owner', 'admin'),
  async (req, res, next) => {
    try {
      const tenantId = req.tenantContext!.tenantId;
      const campaign = await CampaignModel.findOne({ tenantId, campaignId: req.params.id }).lean();
      if (!campaign) throw new NotFoundError(`Campaign '${req.params.id}' not found`);

      const seasonId = String(req.body.seasonId || '');
      const season = await mockSeasonSource.getSeason(tenantId, seasonId);
      if (!season) throw new ValidationError(`Festival season '${seasonId}' is required`);

      const version: any = await CampaignVersionModel.findOne({ tenantId, campaignId: req.params.id })
        .sort({ version: -1 })
        .lean();

      const relId = season.releaseId || season.collectionId;
      let collectionItems: any[] = [];
      if (relId) {
        const colDoc: any = await SrcCollectionModel.findOne({ tenantId, releaseId: relId }).lean();
        if (colDoc) collectionItems = colDoc.items || [];
      }

      const customers = await SrcCustomerModel.find({ tenantId }).sort({ customerId: 1 }).limit(5001).lean();
      const truncated = customers.length > 5000;
      const rows = customers.slice(0, 5000);
      let matched = 0;
      const excludedByReason: Record<string, number> = {};
      const samples: any[] = [];

      for (const customer of rows) {
        const result = matchFestivalCollection(
          { customerId: customer.customerId, firstName: customer.firstName, preferences: customer.preferences },
          collectionItems,
          {
            mode: version?.matchMode || 'STRICT',
            audienceMode: version?.audience?.mode || 'ALL_ELIGIBLE',
            maxItems: version?.maxItemsInMessage || 3,
          }
        );

        if (result.matched) matched++;
        for (const excluded of result.excluded) {
          excludedByReason[excluded.reason] = (excludedByReason[excluded.reason] || 0) + 1;
        }

        const wanted =
          Array.isArray(req.body.sampleCustomerIds) && req.body.sampleCustomerIds.includes(customer.customerId);
        if (wanted || samples.length < 5) {
          samples.push({
            customerRef: customer.destination?.masked || customer.customerId,
            matched: result.matched,
            items: result.items,
            matchReasons: result.matchReasons,
            rejected: result.excluded,
          });
        }
      }

      return res.json({
        season: {
          seasonId: season.seasonId,
          name: season.name,
          festivalDate: season.festivalDate,
          status: season.status,
          validUntil: season.validUntil,
        },
        items: collectionItems,
        wouldCount: matched,
        scanned: rows.length,
        truncated,
        matched,
        excludedByReason,
        estimatedRecipients: matched,
        limit: version?.maxRecipientsPerOffer || 1000,
        samples,
      });
    } catch (error) {
      next(error);
    }
  }
);

festivalCollectionRouter.get(
  '/campaigns/:id/festival/summary',
  requireRole('owner', 'admin', 'staff'),
  async (req, res, next) => {
    try {
      const tenantId = req.tenantContext!.tenantId;
      const campaignId = req.params.id;

      const enrollments = await CampaignEnrollmentModel.find({
        tenantId,
        campaignId,
        occurrenceId: { $regex: '^festival:' },
      }).lean();

      const enrollmentIds = enrollments.map((entry) => entry.enrollmentId);
      const executions = await CampaignExecutionModel.find({
        tenantId,
        campaignId,
        enrollmentId: { $in: enrollmentIds },
      }).lean();

      const skippedByReason: Record<string, number> = {};
      let scheduled = 0,
        deferred = 0,
        skipped = 0,
        sent = 0,
        delivered = 0,
        read = 0;

      for (const execution of executions) {
        if (execution.state === EXECUTION_STATE.SCHEDULED) scheduled++;
        if (execution.state === EXECUTION_STATE.DEFERRED) deferred++;
        if (execution.state === EXECUTION_STATE.SKIPPED) {
          skipped++;
          const reason = execution.skipReason || 'OTHER';
          skippedByReason[reason] = (skippedByReason[reason] || 0) + 1;
        }
        if (execution.state === EXECUTION_STATE.SENT || execution.state === EXECUTION_STATE.PROVIDER_ACCEPTED) sent++;
        if (execution.state === EXECUTION_STATE.DELIVERED) delivered++;
        if (execution.state === EXECUTION_STATE.READ) read++;
      }

      return res.json({
        seasonsSeen: new Set(enrollments.map((entry) => entry.occurrenceId)).size,
        enrollments: enrollments.length,
        excluded: enrollments.filter((entry) => entry.status === ENROLLMENT_STATUS.EXCLUDED).length,
        scheduled,
        deferred,
        skipped,
        skippedByReason,
        sent,
        delivered,
        read,
      });
    } catch (error) {
      next(error);
    }
  }
);

festivalCollectionRouter.post(
  '/dev/festival/trigger-season',
  requireRole('owner', 'admin'),
  async (req, res, next) => {
    try {
      const tenantId = req.tenantContext!.tenantId;
      const parsed = seasonEventBody.safeParse(req.body);
      if (!parsed.success) throw new ValidationError('seasonId is required');

      const seasonId = parsed.data.seasonId;
      const eventType = parsed.data.type || 'season.published';
      const eventId = `evt_season_${crypto.randomUUID().slice(0, 10)}`;

      const result = await eventConsumerService.ingestEvent({
        schemaVersion: 1,
        producer: 'seasons',
        eventId,
        tenantId,
        type: eventType,
        entityId: seasonId,
        entityVersion: parsed.data.entityVersion || 1,
        occurredAt: clock.now().toISOString(),
        data: {},
      });

      return res.json({ ok: true, eventId, seasonId, status: result.status, effects: result.effects });
    } catch (error) {
      next(error);
    }
  }
);

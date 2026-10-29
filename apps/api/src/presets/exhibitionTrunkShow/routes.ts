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
} from '../../db/models';
import { mockEventSource } from '../../adapters/event-source';
import { matchExhibitionEvent } from './matching';
import { eventConsumerService } from '../../services/event-consumer';
import { ValidationError, NotFoundError } from '../../errors/app-error';
import { clock } from '../../services/clock';
import { z } from 'zod';

const storeEventBody = z.object({
  eventId: z.string().trim().min(1),
  type: z.enum(['event.published', 'event.updated', 'event.cancelled', 'rsvp.completed']).optional(),
  entityVersion: z.number().int().positive().optional(),
  customerId: z.string().trim().optional(),
});

export const exhibitionTrunkShowRouter = Router();

exhibitionTrunkShowRouter.use((req: Request, res: Response, next: NextFunction) => {
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

exhibitionTrunkShowRouter.post(
  '/campaigns/:id/exhibition/preview',
  requireRole('owner', 'admin'),
  async (req, res, next) => {
    try {
      const tenantId = req.tenantContext!.tenantId;
      const campaign = await CampaignModel.findOne({ tenantId, campaignId: req.params.id }).lean();
      if (!campaign) throw new NotFoundError(`Campaign '${req.params.id}' not found`);

      const eventId = String(req.body.eventId || '');
      const event = await mockEventSource.getEvent(tenantId, eventId);
      if (!event) throw new ValidationError(`Store event '${eventId}' is required`);

      const version: any = await CampaignVersionModel.findOne({ tenantId, campaignId: req.params.id })
        .sort({ version: -1 })
        .lean();

      const customers = await SrcCustomerModel.find({ tenantId }).sort({ customerId: 1 }).limit(5001).lean();
      const truncated = customers.length > 5000;
      const rows = customers.slice(0, 5000);
      let matched = 0;
      const excludedByReason: Record<string, number> = {};
      const samples: any[] = [];

      for (const customer of rows) {
        const result = matchExhibitionEvent(
          {
            customerId: customer.customerId,
            firstName: customer.firstName,
            city: (customer as any).city,
            branchId: customer.branchId,
            preferences: customer.preferences,
          },
          {
            eventId: event.eventId,
            title: event.title,
            city: event.city,
            targetCities: event.targetCities,
            targetBranches: event.targetBranches,
            capacity: event.capacity,
            registeredCount: event.registeredCount,
            status: event.status,
            categories: event.categories,
          },
          {
            mode: version?.matchMode || 'STRICT',
            audienceMode: version?.audience?.mode || 'ALL_ELIGIBLE',
          }
        );

        if (result.matched) {
          matched++;
        } else if (result.reason) {
          excludedByReason[result.reason] = (excludedByReason[result.reason] || 0) + 1;
        }

        const wanted =
          Array.isArray(req.body.sampleCustomerIds) && req.body.sampleCustomerIds.includes(customer.customerId);
        if (wanted || samples.length < 5) {
          samples.push({
            customerRef: customer.destination?.masked || customer.customerId,
            matched: result.matched,
            reason: result.reason,
            matchReasons: result.matchReasons,
          });
        }
      }

      return res.json({
        event: {
          eventId: event.eventId,
          title: event.title,
          startDate: event.startDate,
          endDate: event.endDate,
          venue: event.venue,
          city: event.city,
          capacity: event.capacity,
          registeredCount: event.registeredCount,
          status: event.status,
        },
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

exhibitionTrunkShowRouter.get(
  '/campaigns/:id/exhibition/summary',
  requireRole('owner', 'admin', 'staff'),
  async (req, res, next) => {
    try {
      const tenantId = req.tenantContext!.tenantId;
      const campaignId = req.params.id;

      const enrollments = await CampaignEnrollmentModel.find({
        tenantId,
        campaignId,
        occurrenceId: { $regex: '^storeevent:' },
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
        eventsSeen: new Set(enrollments.map((entry) => entry.occurrenceId)).size,
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

exhibitionTrunkShowRouter.post(
  '/dev/exhibition/trigger-event',
  requireRole('owner', 'admin'),
  async (req, res, next) => {
    try {
      const tenantId = req.tenantContext!.tenantId;
      const parsed = storeEventBody.safeParse(req.body);
      if (!parsed.success) throw new ValidationError('eventId is required');

      const eventEntityId = parsed.data.eventId;
      const eventType = parsed.data.type || 'event.published';
      const eventId = `evt_event_${crypto.randomUUID().slice(0, 10)}`;

      const result = await eventConsumerService.ingestEvent({
        schemaVersion: 1,
        producer: 'events',
        eventId,
        tenantId,
        type: eventType,
        entityId: eventEntityId,
        entityVersion: parsed.data.entityVersion || 1,
        occurredAt: clock.now().toISOString(),
        data: {
          customerId: parsed.data.customerId,
        },
      });

      return res.json({ ok: true, eventId, storeEventId: eventEntityId, status: result.status, effects: result.effects });
    } catch (error) {
      next(error);
    }
  }
);

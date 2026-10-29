import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { Router, Request, Response, NextFunction } from 'express';
import {
  normalizePhone,
  isSuspiciousPhone,
  WARNING_CODES,
  AUTH_COOKIE_NAME,
} from '@grovastra/shared';
import {
  SrcCustomerModel,
  CampaignEnrollmentModel,
  CampaignExecutionModel,
  SrcCustomerEventModel,
} from '../db/models';
import { authService } from '../services/auth.service';
import { eventConsumerService } from '../services/event-consumer';
import { contactGateService } from '../services/contact-gate/contact-gate.service';
import { webhookService, verifyMetaSignature } from '../services/webhook/webhook.service';
import { destinationHash, encryptPhone, maskPhone } from '../utils/crypto';
import { clock } from '../services/clock';
import { config } from '../config/env';
import { NotFoundError, ValidationError } from '../errors/app-error';

export const devMockCrmRouter = Router();

// Dev-only guard: NODE_ENV != production, 404 otherwise
devMockCrmRouter.use((req: Request, res: Response, next: NextFunction) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(404).json({ error: 'Not Found' });
  }
  next();
});

function resolveTenant(req: Request): string {
  if (req.tenantContext?.tenantId) return req.tenantContext.tenantId;
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    try {
      const payload = authService.verifyToken(authHeader.split(' ')[1]);
      req.tenantContext = payload;
      return payload.tenantId;
    } catch {}
  }
  if (req.cookies && req.cookies[AUTH_COOKIE_NAME]) {
    try {
      const payload = authService.verifyToken(req.cookies[AUTH_COOKIE_NAME]);
      req.tenantContext = payload;
      return payload.tenantId;
    } catch {}
  }
  return (req.headers['x-tenant-id'] as string) || 'shop_a';
}

/**
 * POST /dev/mock-customers & /api/v1/dev/mock-customers
 * Body: { firstName, phone, phoneConfirm, branchId, marketingOptIn, consentSource, confirmedWithCustomer? }
 */
devMockCrmRouter.post(
  ['/dev/mock-customers', '/api/v1/dev/mock-customers'],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = resolveTenant(req);
      const {
        firstName,
        phone,
        phoneConfirm,
        branchId,
        marketingOptIn,
        consentSource,
        confirmedWithCustomer,
      } = req.body;

      // 1. Normalization and double-entry confirmation
      const normPhone = normalizePhone(phone, 'IN', { isStaffEntry: true });
      const normConfirm = normalizePhone(phoneConfirm, 'IN', { isStaffEntry: true });

      if (!normPhone.valid || !normConfirm.valid) {
        return res.status(422).json({
          error: 'PHONE_INVALID',
          reason: 'PHONE_INVALID',
          message: 'Phone number is invalid or cannot be parsed',
        });
      }

      if (normPhone.e164 !== normConfirm.e164) {
        return res.status(422).json({
          error: 'PHONE_CONFIRMATION_MISMATCH',
          reason: 'PHONE_CONFIRMATION_MISMATCH',
          message: 'Phone number does not match confirmation',
        });
      }

      // 2. Opt-in requires consentSource
      if (marketingOptIn === true && !consentSource) {
        return res.status(422).json({
          error: 'CONSENT_SOURCE_REQUIRED',
          message: 'consentSource is required when marketingOptIn is true',
        });
      }

      // 3. Verification level & method
      const isConfirmed = confirmedWithCustomer === true;
      const verificationLevel = isConfirmed ? 'CONFIRMED_BY_STAFF' : 'FORMAT_VALID';
      const verificationMethod = isConfirmed ? 'COUNTER_READBACK' : 'DOUBLE_ENTRY';

      // 4. Duplicate destinationHash check (warning SHARED_DESTINATION)
      const destHash = destinationHash(normPhone.digits);
      const existing = await SrcCustomerModel.findOne({
        tenantId,
        'destination.destinationHash': destHash,
      }).lean();

      const warnings: string[] = [];
      if (normPhone.warnings?.includes('PHONE_SUSPICIOUS') || isSuspiciousPhone(normPhone.digits)) {
        warnings.push(WARNING_CODES.PHONE_SUSPICIOUS);
      }
      if (existing) {
        warnings.push(WARNING_CODES.SHARED_DESTINATION);
      }

      // 5. Create Customer in mock CRM collection
      const customerId = `cust_${crypto.randomUUID().slice(0, 10)}`;
      const customer = await SrcCustomerModel.create({
        tenantId,
        customerId,
        firstName: firstName || 'Valued Customer',
        branchId: branchId || 'branch_main',
        status: 'ACTIVE',
        destination: {
          rawInput: phone,
          e164: normPhone.e164,
          nationalDigits: normPhone.digits.slice(-10),
          encryptedPhone: encryptPhone(normPhone.e164),
          destinationHash: destHash,
          masked: maskPhone(normPhone.e164),
          verified: true,
          verificationLevel,
          verifiedAt: clock.now(),
          verificationMethod,
          version: 1,
        },
        consent: {
          marketingOptIn: Boolean(marketingOptIn),
          consentCapturedAt: clock.now(),
          consentSource: consentSource || 'COUNTER_FORM',
          channelSuppressed: false,
        },
        version: 1,
      });

      return res.status(201).json({
        customer,
        warnings,
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /dev/mock-customers/:id/correct-phone & /api/v1/dev/mock-customers/:id/correct-phone
 * Body: { phone, phoneConfirm, confirmedWithCustomer? }
 */
devMockCrmRouter.post(
  ['/dev/mock-customers/:id/correct-phone', '/api/v1/dev/mock-customers/:id/correct-phone'],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = resolveTenant(req);
      const { id: customerId } = req.params;
      const { phone, phoneConfirm, confirmedWithCustomer } = req.body;

      const normPhone = normalizePhone(phone, 'IN', { isStaffEntry: true });
      const normConfirm = normalizePhone(phoneConfirm, 'IN', { isStaffEntry: true });

      if (!normPhone.valid || !normConfirm.valid) {
        return res.status(422).json({
          error: 'PHONE_INVALID',
          reason: 'PHONE_INVALID',
          message: 'Phone number is invalid or cannot be parsed',
        });
      }

      if (normPhone.e164 !== normConfirm.e164) {
        return res.status(422).json({
          error: 'PHONE_CONFIRMATION_MISMATCH',
          reason: 'PHONE_CONFIRMATION_MISMATCH',
          message: 'Phone number does not match confirmation',
        });
      }

      const customer = await SrcCustomerModel.findOne({ tenantId, customerId });
      if (!customer) {
        throw new NotFoundError(`Customer '${customerId}' not found`);
      }

      const isConfirmed = confirmedWithCustomer === true;
      const verificationLevel = isConfirmed ? 'CONFIRMED_BY_STAFF' : 'FORMAT_VALID';
      const verificationMethod = isConfirmed ? 'COUNTER_READBACK' : 'DOUBLE_ENTRY';
      const newDestHash = destinationHash(normPhone.digits);

      customer.destination = {
        rawInput: phone,
        e164: normPhone.e164,
        nationalDigits: normPhone.digits.slice(-10),
        encryptedPhone: encryptPhone(normPhone.e164),
        destinationHash: newDestHash,
        masked: maskPhone(normPhone.e164),
        verified: true,
        verificationLevel,
        verifiedAt: clock.now(),
        verificationMethod,
        version: (customer.destination?.version || 1) + 1,
      };
      customer.version = (customer.version || 1) + 1;
      await customer.save();

      // Emit customer.updated with updateType: DESTINATION_CHANGED WITHOUT the phone number
      const eventId = `evt_cust_upd_${crypto.randomUUID().slice(0, 10)}`;
      await eventConsumerService.ingestEvent(tenantId, 'crm', {
        schemaVersion: 1,
        producer: 'crm',
        eventId,
        type: 'customer.updated',
        entityId: customer.customerId,
        entityVersion: customer.version,
        customerId: customer.customerId,
        occurredAt: clock.now(),
        data: {
          customerId: customer.customerId,
          updateType: 'DESTINATION_CHANGED',
          destinationVersion: customer.destination.version,
        },
      });

      return res.status(200).json({ success: true, customer });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /dev/mock-customers/:id/mark-wrong-number & /api/v1/dev/mock-customers/:id/mark-wrong-number
 */
devMockCrmRouter.post(
  ['/dev/mock-customers/:id/mark-wrong-number', '/api/v1/dev/mock-customers/:id/mark-wrong-number'],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = resolveTenant(req);
      const { id: customerId } = req.params;

      const customer = await SrcCustomerModel.findOne({ tenantId, customerId });
      if (!customer) {
        throw new NotFoundError(`Customer '${customerId}' not found`);
      }

      customer.destination.verified = false;
      customer.destination.verificationLevel = 'UNVERIFIED';
      customer.version = (customer.version || 1) + 1;
      await customer.save();

      if (customer.destination?.destinationHash) {
        await contactGateService.markUndeliverable(
          tenantId,
          customer.destination.destinationHash,
          'STAFF_MARKED_WRONG_NUMBER',
          'STAFF'
        );
      }

      return res.status(200).json({ success: true, customer });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /dev/mock-customers/:id/opt-out & /api/v1/dev/mock-customers/:id/opt-out
 */
devMockCrmRouter.post(
  ['/dev/mock-customers/:id/opt-out', '/api/v1/dev/mock-customers/:id/opt-out'],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = resolveTenant(req);
      const { id: customerId } = req.params;

      const customer = await SrcCustomerModel.findOne({ tenantId, customerId });
      if (!customer) {
        throw new NotFoundError(`Customer '${customerId}' not found`);
      }

      customer.consent.marketingOptIn = false;
      customer.status = 'OPTED_OUT';
      customer.version = (customer.version || 1) + 1;
      await customer.save();

      const eventId = `evt_pref_optout_${crypto.randomUUID().slice(0, 10)}`;
      await eventConsumerService.ingestEvent(tenantId, 'crm', {
        schemaVersion: 1,
        producer: 'crm',
        eventId,
        type: 'preference.changed',
        entityId: customer.customerId,
        entityVersion: customer.version,
        customerId: customer.customerId,
        occurredAt: clock.now(),
        data: {
          customerId: customer.customerId,
          changeType: 'MARKETING_OPT_OUT',
          marketingOptIn: false,
        },
      });

      return res.status(200).json({ success: true, customer });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /dev/provider-events/replay-fixture & /api/v1/dev/provider-events/replay-fixture
 * Body: { fixture: "failed-undeliverable", overrides?: any }
 */
devMockCrmRouter.post(
  ['/dev/provider-events/replay-fixture', '/api/v1/dev/provider-events/replay-fixture'],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { fixture, overrides } = req.body;
      if (!fixture) {
        throw new ValidationError('fixture name is required');
      }

      const candidates = [
        path.join(process.cwd(), 'docs', 'samples', `${fixture}.json`),
        path.join(process.cwd(), 'docs', 'samples', `webhook-status-${fixture}.json`),
        path.join(process.cwd(), '..', '..', 'docs', 'samples', `${fixture}.json`),
        path.join(process.cwd(), '..', '..', 'docs', 'samples', `webhook-status-${fixture}.json`),
      ];

      let rawContent: string | null = null;
      for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
          rawContent = fs.readFileSync(candidate, 'utf-8');
          break;
        }
      }

      if (!rawContent) {
        throw new NotFoundError(`Fixture '${fixture}' not found in docs/samples`);
      }

      let payload = JSON.parse(rawContent);

      // Apply overrides if provided
      if (overrides?.messageId || overrides?.providerMessageId) {
        const id = overrides.messageId || overrides.providerMessageId;
        payload.entry?.[0]?.changes?.[0]?.value?.statuses?.forEach((s: any) => {
          s.id = id;
        });
      }
      if (overrides?.recipientId) {
        payload.entry?.[0]?.changes?.[0]?.value?.statuses?.forEach((s: any) => {
          s.recipient_id = overrides.recipientId;
        });
      }

      // Replay through real webhook ingestion service
      const result = await webhookService.processWebhookPayload(payload);
      return res.status(200).json({ success: true, fixture, result });
    } catch (err) {
      next(err);
    }
  }
);

function parseEventDate(input: {
  eventDate?: { year: number; month: number; day: number };
  eventDateKey?: string;
  date?: string;
}): {
  eventDate: { year: number; month: number; day: number };
  eventDateKey: string;
} {
  if (input.eventDate && input.eventDate.year && input.eventDate.month && input.eventDate.day) {
    const y = input.eventDate.year;
    const m = String(input.eventDate.month).padStart(2, '0');
    const d = String(input.eventDate.day).padStart(2, '0');
    return {
      eventDate: input.eventDate,
      eventDateKey: `${y}-${m}-${d}`,
    };
  }
  const dateStr = input.eventDateKey || input.date || '';
  const match = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match) {
    const [, y, m, d] = match;
    return {
      eventDate: { year: parseInt(y, 10), month: parseInt(m, 10), day: parseInt(d, 10) },
      eventDateKey: dateStr,
    };
  }
  throw new ValidationError('Valid eventDate or eventDateKey (YYYY-MM-DD) is required');
}

/**
 * POST /dev/mock-occasions & /api/v1/dev/mock-occasions
 */
devMockCrmRouter.post(
  ['/dev/mock-occasions', '/api/v1/dev/mock-occasions'],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = resolveTenant(req);
      const {
        customerId,
        kind,
        eventDate,
        eventDateKey,
        date,
        recipientLabel,
        budgetPaise,
        categories,
        declaredByCustomer,
        eventId: customEventId,
        label,
      } = req.body;

      if (!customerId) throw new ValidationError('customerId is required');
      if (!kind) throw new ValidationError('kind is required (GIFT or WEDDING)');

      const parsedKind = (kind as string).toUpperCase() as 'GIFT' | 'WEDDING';
      const parsedDate = parseEventDate({ eventDate, eventDateKey, date });
      const eventId = customEventId || `evt_occ_${crypto.randomUUID().slice(0, 10)}`;

      const occ = await SrcCustomerEventModel.create({
        tenantId,
        customerId,
        eventId,
        type: parsedKind.toLowerCase(),
        kind: parsedKind,
        eventDate: parsedDate.eventDate,
        eventDateKey: parsedDate.eventDateKey,
        month: parsedDate.eventDate.month,
        day: parsedDate.eventDate.day,
        label: label || `${parsedKind} Occasion`,
        recipientLabel: recipientLabel || null,
        budgetPaise: budgetPaise !== undefined ? budgetPaise : null,
        categories: categories || [],
        status: 'ACTIVE',
        declaredByCustomer: declaredByCustomer !== undefined ? declaredByCustomer : true,
        declaredAt: clock.now(),
        source: 'DEV_TOOL',
        entityVersion: 1,
        version: 1,
        deletedAt: null,
      });

      const domainEventId = `evt_crm_${crypto.randomUUID().slice(0, 10)}`;
      const eventResult = await eventConsumerService.ingestEvent(tenantId, 'crm', {
        schemaVersion: 1,
        producer: 'crm',
        eventId: domainEventId,
        type: 'occasion.saved',
        entityId: eventId,
        entityVersion: 1,
        customerId,
        occurredAt: clock.now(),
        data: {
          eventId,
          customerId,
          kind: parsedKind,
          eventDateKey: parsedDate.eventDateKey,
          recipientLabel,
          budgetPaise,
          categories,
        },
      });

      res.status(201).json({ success: true, occasion: occ, eventResult });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /dev/mock-occasions/:eventId/postpone & /api/v1/dev/mock-occasions/:eventId/postpone
 */
devMockCrmRouter.post(
  ['/dev/mock-occasions/:eventId/postpone', '/api/v1/dev/mock-occasions/:eventId/postpone'],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = resolveTenant(req);
      const { eventId } = req.params;
      const { eventDate, eventDateKey, date, newDate } = req.body;

      const occ = await SrcCustomerEventModel.findOne({ tenantId, eventId });
      if (!occ) throw new NotFoundError(`Occasion '${eventId}' not found`);

      const parsedDate = parseEventDate({ eventDate, eventDateKey: eventDateKey || newDate, date });
      occ.eventDate = parsedDate.eventDate;
      occ.eventDateKey = parsedDate.eventDateKey;
      occ.month = parsedDate.eventDate.month;
      occ.day = parsedDate.eventDate.day;
      occ.entityVersion = (occ.entityVersion || 1) + 1;
      occ.version = (occ.version || 1) + 1;
      await occ.save();

      const domainEventId = `evt_crm_${crypto.randomUUID().slice(0, 10)}`;
      const eventResult = await eventConsumerService.ingestEvent(tenantId, 'crm', {
        schemaVersion: 1,
        producer: 'crm',
        eventId: domainEventId,
        type: 'occasion.saved',
        entityId: eventId,
        entityVersion: occ.entityVersion,
        customerId: occ.customerId,
        occurredAt: clock.now(),
        data: {
          eventId,
          customerId: occ.customerId,
          kind: occ.kind,
          eventDateKey: occ.eventDateKey,
          recipientLabel: occ.recipientLabel,
          budgetPaise: occ.budgetPaise,
          categories: occ.categories,
          updateType: 'POSTPONED',
        },
      });

      res.status(200).json({ success: true, occasion: occ, eventResult });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /dev/mock-occasions/:eventId/cancel & /api/v1/dev/mock-occasions/:eventId/cancel
 */
devMockCrmRouter.post(
  ['/dev/mock-occasions/:eventId/cancel', '/api/v1/dev/mock-occasions/:eventId/cancel'],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = resolveTenant(req);
      const { eventId } = req.params;

      const occ = await SrcCustomerEventModel.findOne({ tenantId, eventId });
      if (!occ) throw new NotFoundError(`Occasion '${eventId}' not found`);

      occ.status = 'CANCELLED';
      occ.entityVersion = (occ.entityVersion || 1) + 1;
      occ.version = (occ.version || 1) + 1;
      await occ.save();

      const domainEventId = `evt_crm_${crypto.randomUUID().slice(0, 10)}`;
      const eventResult = await eventConsumerService.ingestEvent(tenantId, 'crm', {
        schemaVersion: 1,
        producer: 'crm',
        eventId: domainEventId,
        type: 'occasion.cancelled',
        entityId: eventId,
        entityVersion: occ.entityVersion,
        customerId: occ.customerId,
        occurredAt: clock.now(),
        data: {
          eventId,
          customerId: occ.customerId,
          kind: occ.kind,
        },
      });

      res.status(200).json({ success: true, occasion: occ, eventResult });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /dev/mock-occasions/:eventId/delete & /api/v1/dev/mock-occasions/:eventId/delete
 */
devMockCrmRouter.post(
  ['/dev/mock-occasions/:eventId/delete', '/api/v1/dev/mock-occasions/:eventId/delete'],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = resolveTenant(req);
      const { eventId } = req.params;

      const occ = await SrcCustomerEventModel.findOne({ tenantId, eventId });
      if (!occ) throw new NotFoundError(`Occasion '${eventId}' not found`);

      occ.deletedAt = clock.now();
      occ.entityVersion = (occ.entityVersion || 1) + 1;
      occ.version = (occ.version || 1) + 1;
      await occ.save();

      const domainEventId = `evt_crm_${crypto.randomUUID().slice(0, 10)}`;
      const eventResult = await eventConsumerService.ingestEvent(tenantId, 'crm', {
        schemaVersion: 1,
        producer: 'crm',
        eventId: domainEventId,
        type: 'occasion.deleted',
        entityId: eventId,
        entityVersion: occ.entityVersion,
        customerId: occ.customerId,
        occurredAt: clock.now(),
        data: {
          eventId,
          customerId: occ.customerId,
          kind: occ.kind,
        },
      });

      res.status(200).json({ success: true, occasion: occ, eventResult });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /dev/mock-occasions/:eventId/complete & /api/v1/dev/mock-occasions/:eventId/complete
 */
devMockCrmRouter.post(
  ['/dev/mock-occasions/:eventId/complete', '/api/v1/dev/mock-occasions/:eventId/complete'],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = resolveTenant(req);
      const { eventId } = req.params;

      const occ = await SrcCustomerEventModel.findOne({ tenantId, eventId });
      if (!occ) throw new NotFoundError(`Occasion '${eventId}' not found`);

      occ.status = 'COMPLETED';
      occ.entityVersion = (occ.entityVersion || 1) + 1;
      occ.version = (occ.version || 1) + 1;
      await occ.save();

      const domainEventId = `evt_crm_${crypto.randomUUID().slice(0, 10)}`;
      const eventResult = await eventConsumerService.ingestEvent(tenantId, 'crm', {
        schemaVersion: 1,
        producer: 'crm',
        eventId: domainEventId,
        type: 'occasion.completed',
        entityId: eventId,
        entityVersion: occ.entityVersion,
        customerId: occ.customerId,
        occurredAt: clock.now(),
        data: {
          eventId,
          customerId: occ.customerId,
          kind: occ.kind,
        },
      });

      res.status(200).json({ success: true, occasion: occ, eventResult });
    } catch (err) {
      next(err);
    }
  }
);

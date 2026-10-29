import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../src/app';
import { connectToDatabase, disconnectDatabase } from '../src/db/connection';
import { seedDatabase, seedReset } from '../src/db/seed';
import {
  CampaignModel,
  CampaignVersionModel,
  CampaignControlGateModel,
  CampaignEnrollmentModel,
  CampaignExecutionModel,
  CampaignCustomerFactModel,
  SrcCustomerModel,
  SrcOrderModel,
  SrcOfferModel,
} from '../src/db/models';
import { authService } from '../src/services/auth.service';
import { clock } from '../src/services/clock';
import { computeDueTimes } from '../src/presets/_shared/eventDelay/delayTiming';
import { dispatchRecheck } from '../src/presets/_shared/eventDelay/dispatchRecheck';
import { evaluateCandidateForEventDelay } from '../src/presets/_shared/eventDelay/enrollerBase';
import { formatPaiseToRupees } from '../src/presets/welcome/bindings';
import { welcomeNewCustomerEvaluator } from '../src/presets/welcome/evaluator';
import { campaignValidationService } from '../src/services/campaign-validation.service';
import {
  TRIGGER_TYPE,
  EVENT_DELAY_ANCHOR,
  OUTSIDE_HOURS_POLICY,
  DELAY_UNIT,
  ENROLLMENT_STATUS,
  EXECUTION_REASONS,
  EXCLUSION_REASONS,
  OFFER_STATUS,
} from '@grovastra/shared';

describe('Welcome Campaign Preset (WELCOME_NEW_CUSTOMER)', () => {
  const tenantId = 'shop_a';
  let ownerToken: string;
  let adminToken: string;
  let staffToken: string;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.DISPATCH_MODE = 'dry';
    process.env.ALLOW_TEST_CATEGORY_MISMATCH = 'true';

    await connectToDatabase();
    await seedReset(true);
    await seedDatabase('base');

    ownerToken = authService.signToken({
      userId: 'usr_owner_01',
      tenantId,
      role: 'owner',
      branchIds: ['branch_main', 'branch_two'],
      email: 'owner@shop-a.com',
    });

    adminToken = authService.signToken({
      userId: 'usr_admin_01',
      tenantId,
      role: 'admin',
      branchIds: ['branch_main', 'branch_two'],
      email: 'admin@shop-a.com',
    });

    staffToken = authService.signToken({
      userId: 'usr_staff_01',
      tenantId,
      role: 'staff',
      branchIds: ['branch_main'],
      email: 'staff@shop-a.com',
    });
  });

  afterAll(async () => {
    await disconnectDatabase();
  });

  beforeEach(async () => {
    clock.setSystemTime(new Date('2026-10-21T10:00:00.000Z'));
  });

  // ============================================================================
  // V01: Presets catalogue lists Welcome with implemented: true and priority: 45
  // ============================================================================
  it('V01: Presets catalogue lists Welcome with implemented: true and priority: 45', async () => {
    const res = await request(app)
      .get('/campaign-presets')
      .set('Authorization', `Bearer ${staffToken}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);

    const welcomePreset = res.body.find(
      (p: any) => p.id === 'WELCOME_NEW_CUSTOMER' || p.id === 'welcome_new_customer'
    );
    expect(welcomePreset).toBeDefined();
    expect(welcomePreset.name).toBe('Welcome New Customer');
    expect(welcomePreset.implemented).toBe(true);
    expect(welcomePreset.priority ?? welcomePreset.defaults?.priority).toBe(45);
    expect(welcomePreset.triggerType ?? welcomePreset.triggerFamily).toBe('EVENT_DELAY');
    expect(welcomePreset.defaultSteps ?? welcomePreset.defaults?.steps).toBeDefined();
    expect((welcomePreset.defaultSteps ?? welcomePreset.defaults?.steps).length).toBeGreaterThan(0);
  });

  // ============================================================================
  // V02: Create welcome campaign draft from preset defaults
  // ============================================================================
  it('V02: Create welcome campaign draft from preset defaults', async () => {
    const res = await request(app)
      .post('/campaigns')
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('Idempotency-Key', `idemp-v02-create-${Date.now()}`)
      .send({
        presetId: 'WELCOME_NEW_CUSTOMER',
        name: 'My New Customer Welcome Campaign',
      });

    expect(res.status).toBe(201);
    expect(res.body.campaign).toBeDefined();
    expect(res.body.campaign.presetId).toBe('WELCOME_NEW_CUSTOMER');
    expect(res.body.campaign.status).toBe('DRAFT');
    expect(res.body.draft).toBeDefined();
    expect(res.body.draft.trigger.type).toBe('EVENT_DELAY');
    expect(res.body.draft.steps.length).toBeGreaterThanOrEqual(1);
    expect(res.body.draft.steps[0].delay).toEqual({ value: 1, unit: 'HOURS' });
  });

  // ============================================================================
  // V03: Step validation (delay bounds, strictly increasing, maxDeferralHours 0-48)
  // ============================================================================
  it('V03: Step validation (delay bounds, strictly increasing, maxDeferralHours 0-48)', async () => {
    // 0 steps -> error
    const noStepsDraft = {
      presetId: 'WELCOME_NEW_CUSTOMER',
      name: 'No Steps Welcome',
      steps: [],
    };
    const val0 = await campaignValidationService.validateDraft(tenantId, noStepsDraft as any);
    expect(val0.valid).toBe(false);
    expect(val0.errors.some((e) => e.fieldPath === 'steps')).toBe(true);

    // 4 steps -> error (max 3 allowed)
    const fourStepsDraft = {
      presetId: 'WELCOME_NEW_CUSTOMER',
      name: 'Four Steps Welcome',
      steps: [
        { stepId: 's1', delay: { value: 1, unit: 'HOURS' } },
        { stepId: 's2', delay: { value: 2, unit: 'HOURS' } },
        { stepId: 's3', delay: { value: 3, unit: 'HOURS' } },
        { stepId: 's4', delay: { value: 4, unit: 'HOURS' } },
      ],
    };
    const val4 = await campaignValidationService.validateDraft(tenantId, fourStepsDraft as any);
    expect(val4.valid).toBe(false);
    expect(val4.errors.some((e) => e.fieldPath === 'steps')).toBe(true);

    // Decreasing delays (s1: 2 hours, s2: 1 hour) -> error
    const decreasingDraft = {
      presetId: 'WELCOME_NEW_CUSTOMER',
      name: 'Decreasing Delay Welcome',
      steps: [
        { stepId: 's1', delay: { value: 2, unit: 'HOURS' }, templateRef: { id: 'hello_world' } },
        { stepId: 's2', delay: { value: 1, unit: 'HOURS' }, templateRef: { id: 'hello_world' } },
      ],
    };
    const valDec = await welcomeNewCustomerEvaluator.validateConfigAsync(decreasingDraft as any);
    expect(valDec.valid).toBe(false);
    expect(valDec.errors.some((e: any) => e.message.includes('strictly greater than'))).toBe(true);

    // Invalid maxDeferralHours = 72 -> error (max 48)
    const badDeferralDraft = {
      presetId: 'WELCOME_NEW_CUSTOMER',
      name: 'Bad Deferral Welcome',
      steps: [
        {
          stepId: 's1',
          delay: { value: 1, unit: 'HOURS' },
          maxDeferralHours: 72,
          templateRef: { id: 'hello_world' },
        },
      ],
    };
    const valDef = await welcomeNewCustomerEvaluator.validateConfigAsync(badDeferralDraft as any);
    expect(valDef.valid).toBe(false);
    expect(valDef.errors.some((e: any) => e.fieldPath === 'steps[0].maxDeferralHours')).toBe(true);
  });

  // ============================================================================
  // V04: Today/tonight warning banner when outsideHoursPolicy === "DEFER_NEXT_DAY"
  // ============================================================================
  it('V04: Today/tonight warning banner when outsideHoursPolicy === "DEFER_NEXT_DAY"', async () => {
    const draft = {
      presetId: 'WELCOME_NEW_CUSTOMER',
      name: 'Welcome Tonight Warning',
      steps: [
        {
          stepId: 's1',
          delay: { value: 1, unit: 'HOURS' },
          outsideHoursPolicy: 'DEFER_NEXT_DAY',
          templateRef: { id: 'tpl_welcome_with_tonight', revision: 1, language: 'en' },
        },
      ],
    };

    const templatesById = new Map();
    templatesById.set('tpl_welcome_with_tonight', {
      id: 'tpl_welcome_with_tonight',
      bodyText: 'Thank you for shopping! Visit our store tonight for special discount.',
      sendable: true,
      category: 'MARKETING',
    });

    const val = await welcomeNewCustomerEvaluator.validateConfigAsync(draft as any, templatesById);
    expect(val.warnings.some((w: any) => w.message.includes('today') || w.message.includes('tonight'))).toBe(true);
  });

  // ============================================================================
  // V05: offerRef required when template has offer variable or offer.amountRupees binding
  // ============================================================================
  it('V05: offerRef required when template has offer variable or offer.amountRupees binding', async () => {
    const draftWithoutOffer = {
      presetId: 'WELCOME_NEW_CUSTOMER',
      name: 'Welcome Missing Offer',
      steps: [
        {
          stepId: 's1',
          delay: { value: 1, unit: 'HOURS' },
          templateRef: { id: 'tpl_welcome_offer', revision: 1, language: 'en' },
          bindings: {
            '1': { source: 'customer.firstName' },
            '2': { source: 'offer.amountRupees' },
          },
        },
      ],
    };

    const templatesById = new Map();
    templatesById.set('tpl_welcome_offer', {
      id: 'tpl_welcome_offer',
      bodyText: 'Hello {{1}}, get Rs {{2}} off on your next purchase!',
      sendable: true,
      category: 'MARKETING',
    });

    const val = await welcomeNewCustomerEvaluator.validateConfigAsync(draftWithoutOffer as any, templatesById);
    expect(val.valid).toBe(false);
    expect(val.errors.some((e: any) => e.fieldPath.includes('offerRef'))).toBe(true);
  });

  // ============================================================================
  // V11: Once-per-customer rule (ALREADY_WELCOMED terminal state)
  // ============================================================================
  it('V11: Once-per-customer rule (ALREADY_WELCOMED terminal state)', async () => {
    const customerId = 'cus_wel_11_already_welcomed';
    const campaignId = 'cmp_wel_v11';

    // Existing completed enrollment with all required schema fields
    await CampaignEnrollmentModel.create({
      tenantId,
      campaignId,
      campaignVersionId: 'v1',
      campaignVersion: 1,
      enrollmentId: `enr_v11_${Date.now()}`,
      enrollmentKey: `${tenantId}:${campaignId}:${customerId}:welcome:ord_pre_seeded`,
      occurrenceId: 'welcome:ord_pre_seeded',
      sourceRef: {
        type: 'SRC_ORDERS',
        id: 'ord_pre_seeded',
        version: 1,
      },
      occasionLocalDate: '2026-09-01',
      customerId,
      destinationHash: 'hash_already_welcomed',
      status: ENROLLMENT_STATUS.COMPLETED,
      completedAt: new Date('2026-09-01T10:00:00Z'),
      firstOrderId: 'ord_pre_seeded',
    });

    const customer = {
      tenantId,
      customerId,
      firstName: 'Ramesh',
      consent: { marketingOptIn: true, channelSuppressed: false },
      status: 'ACTIVE',
    };
    const facts = {
      orderCount: 1,
      firstCompletedOrder: {
        orderId: 'ord_new',
        orderNumber: 'ORD-NEW',
        completedAt: new Date(),
        netPaise: 50000,
      },
    };
    const campaignVersion = {
      campaignId,
      enabledBranches: ['branch_main'],
      steps: [{ delay: { value: 1, unit: 'HOURS' }, outsideHoursPolicy: 'DEFER_NEXT_DAY', maxDeferralHours: 24 }],
    };

    const res = await evaluateCandidateForEventDelay(
      tenantId,
      customer as any,
      facts as any,
      campaignVersion as any,
      {} as any
    );

    expect(res.eligible).toBe(false);
    expect(res.reason).toBe(EXCLUSION_REASONS.ALREADY_WELCOMED);
  });

  // ============================================================================
  // V12: Timing calculation: rawDueAt = order occurredAt + 1 hour
  // ============================================================================
  it('V12: Timing calculation: rawDueAt = order occurredAt + 1 hour', () => {
    // Order at 11:00 on Oct 21 (Wednesday)
    const anchorAt = new Date('2026-10-21T11:00:00.000Z');
    const delaySpec = { value: 1, unit: DELAY_UNIT.HOURS };
    const settings = {
      timeZone: 'Asia/Kolkata',
      allowedSendingHours: { start: '10:00', end: '19:00' },
      blackoutDates: [],
      holidayCalendar: [],
    };

    const result = computeDueTimes({
      anchorAt,
      delaySpec,
      outsideHoursPolicy: OUTSIDE_HOURS_POLICY.DEFER_NEXT_DAY,
      maxDeferralHours: 24,
      settings: settings as any,
    });

    expect(result.rawDueAt).toEqual(new Date('2026-10-21T12:00:00.000Z'));
    expect(result.adjustedDueAt).toEqual(new Date('2026-10-21T12:00:00.000Z'));
    expect(result.wasDeferred).toBe(false);
  });

  // ============================================================================
  // V13: Timing calculation: evening order at 18:30 deferred to next day 10:00
  // ============================================================================
  it('V13: Timing calculation: evening order at 18:30 deferred to next day 10:00', () => {
    // 18:30 IST = 13:00 UTC. rawDueAt = 19:30 IST (14:00 UTC). Outside window [10:00, 19:00] IST.
    const anchorAt = new Date('2026-10-21T13:00:00.000Z');
    const delaySpec = { value: 1, unit: DELAY_UNIT.HOURS };
    const settings = {
      timeZone: 'Asia/Kolkata',
      allowedSendingHours: { start: '10:00', end: '19:00' },
      blackoutDates: [],
      holidayCalendar: [],
    };

    const result = computeDueTimes({
      anchorAt,
      delaySpec,
      outsideHoursPolicy: OUTSIDE_HOURS_POLICY.DEFER_NEXT_DAY,
      maxDeferralHours: 24,
      settings: settings as any,
    });

    expect(result.rawDueAt).toEqual(new Date('2026-10-21T14:00:00.000Z')); // 19:30 IST
    // Next morning at 10:00 IST = 04:30 UTC
    expect(result.adjustedDueAt).toEqual(new Date('2026-10-22T04:30:00.000Z'));
    expect(result.wasDeferred).toBe(true);
    expect(result.deferralReason).toBe('OUTSIDE_SENDING_HOURS');
  });

  // ============================================================================
  // V14: Timing calculation: night order at 21:00 deferred to next day 10:00
  // ============================================================================
  it('V14: Timing calculation: night order at 21:00 deferred to next day 10:00', () => {
    // 21:00 IST = 15:30 UTC. rawDueAt = 22:00 IST (16:30 UTC).
    const anchorAt = new Date('2026-10-21T15:30:00.000Z');
    const delaySpec = { value: 1, unit: DELAY_UNIT.HOURS };
    const settings = {
      timeZone: 'Asia/Kolkata',
      allowedSendingHours: { start: '10:00', end: '19:00' },
      blackoutDates: [],
      holidayCalendar: [],
    };

    const result = computeDueTimes({
      anchorAt,
      delaySpec,
      outsideHoursPolicy: OUTSIDE_HOURS_POLICY.DEFER_NEXT_DAY,
      maxDeferralHours: 24,
      settings: settings as any,
    });

    expect(result.adjustedDueAt).toEqual(new Date('2026-10-22T04:30:00.000Z'));
    expect(result.wasDeferred).toBe(true);
  });

  // ============================================================================
  // V15: Timing calculation: blackout/holiday deferral exceeding maxDeferralHours skips
  // ============================================================================
  it('V15: Timing calculation: blackout/holiday deferral exceeding maxDeferralHours skips', () => {
    const anchorAt = new Date('2026-10-21T11:00:00.000Z');
    const delaySpec = { value: 1, unit: DELAY_UNIT.HOURS };
    const settings = {
      timeZone: 'Asia/Kolkata',
      allowedSendingHours: { start: '10:00', end: '19:00' },
      blackoutDates: ['2026-10-21', '2026-10-22', '2026-10-23'],
      holidayCalendar: [],
    };

    const result = computeDueTimes({
      anchorAt,
      delaySpec,
      outsideHoursPolicy: OUTSIDE_HOURS_POLICY.DEFER_NEXT_DAY,
      maxDeferralHours: 24, // 24h max deferral, but 3 days of blackout -> exceeds
      settings: settings as any,
    });

    expect(result.shouldSkip).toBe(true);
    expect(result.skipReason).toBe('DEFERRAL_WINDOW_EXCEEDED');
  });

  // ============================================================================
  // V16: Timing calculation: elapsed order > 4h marked SKIPPED_ELAPSED
  // ============================================================================
  it('V16: Timing calculation: elapsed order > 4h marked SKIPPED_ELAPSED', () => {
    // Order occurred at 06:00 UTC, but current time is 12:00 UTC (6 hours later)
    const anchorAt = new Date('2026-10-21T06:00:00.000Z');
    const now = new Date('2026-10-21T12:00:00.000Z');
    const delaySpec = { value: 1, unit: DELAY_UNIT.HOURS };
    const settings = {
      timeZone: 'Asia/Kolkata',
      allowedSendingHours: { start: '10:00', end: '19:00' },
      blackoutDates: [],
      holidayCalendar: [],
    };

    const result = computeDueTimes({
      anchorAt,
      delaySpec,
      outsideHoursPolicy: OUTSIDE_HOURS_POLICY.DEFER_NEXT_DAY,
      maxDeferralHours: 24,
      settings: settings as any,
      now,
    });

    expect(result.isElapsed).toBe(true);
  });

  // ============================================================================
  // V18: Worker live dispatch recheck: invalid/expired offer skips execution with WELCOME_OFFER_NOT_VALID
  // ============================================================================
  it('V18: Worker live dispatch recheck: invalid/expired offer skips execution with WELCOME_OFFER_NOT_VALID', async () => {
    const customerId = 'cus_wel_v18';
    const orderId = `ord_v18_${Date.now()}`;

    // Valid completed order
    await SrcOrderModel.create({
      tenantId,
      orderId,
      customerId,
      branchId: 'branch_main',
      status: 'COMPLETED',
      paid: true,
      netPaise: 50000,
      lines: [],
      completedAt: new Date(),
      entityVersion: 1,
    });

    // Expired offer using valid OFFER_KIND: 'FLAT_AMOUNT_OFF_NEXT_PURCHASE'
    const offerId = `off_expired_${Date.now()}`;
    await SrcOfferModel.create({
      tenantId,
      offerId,
      title: 'Expired Welcome Offer',
      kind: 'FLAT_AMOUNT_OFF_NEXT_PURCHASE',
      amountPaise: 5000,
      status: OFFER_STATUS.EXPIRED,
      validFrom: new Date('2026-01-01T00:00:00Z'),
      validUntil: new Date('2026-06-01T00:00:00Z'),
    });

    const execution = {
      tenantId,
      customerId,
      stepId: 'step_1',
      isEventDelayStep: true,
      eventDelayAnchorAt: new Date(),
      offerRef: { offerId },
    };

    const recheck = await dispatchRecheck(tenantId, execution as any);
    expect(recheck.shouldProceed).toBe(false);
    expect(recheck.action).toBe('SKIP');
    expect(recheck.reason).toBe(EXECUTION_REASONS.WELCOME_OFFER_NOT_VALID);

    await SrcOfferModel.deleteOne({ tenantId, offerId });
  });

  // ============================================================================
  // V19: Binding resolution: offer.amountRupees formats 5000 paise to "50"
  // ============================================================================
  it('V19: Binding resolution: offer.amountRupees formats 5000 paise to "50"', () => {
    expect(formatPaiseToRupees(5000)).toBe('50');
    expect(formatPaiseToRupees(15000)).toBe('150');
    expect(formatPaiseToRupees(100)).toBe('1');
    expect(formatPaiseToRupees(0)).toBe('0');
  });

  // ============================================================================
  // V22: Customer opt-out gate (NO_MARKETING_CONSENT)
  // ============================================================================
  it('V22: Customer opt-out gate (NO_MARKETING_CONSENT)', async () => {
    const customer = {
      tenantId,
      customerId: 'cus_opt_out',
      firstName: 'Deepa',
      consent: { marketingOptIn: false, channelSuppressed: false },
      status: 'ACTIVE',
    };
    const facts = { orderCount: 1, firstCompletedOrder: { orderId: 'ord_1', netPaise: 50000 } };
    const version = {
      enabledBranches: ['branch_main'],
      steps: [{ delay: { value: 1, unit: 'HOURS' }, outsideHoursPolicy: 'DEFER_NEXT_DAY', maxDeferralHours: 24 }],
    };

    const res = await evaluateCandidateForEventDelay(
      tenantId,
      customer as any,
      facts as any,
      version as any,
      {} as any
    );

    expect(res.eligible).toBe(false);
    expect(res.reason).toBe(EXCLUSION_REASONS.NO_MARKETING_CONSENT);
  });

  // ============================================================================
  // V23: Customer suppressed gate (CHANNEL_SUPPRESSED)
  // ============================================================================
  it('V23: Customer suppressed gate (CHANNEL_SUPPRESSED)', async () => {
    const customer = {
      tenantId,
      customerId: 'cus_suppressed',
      firstName: 'Harish',
      consent: { marketingOptIn: true, channelSuppressed: true },
      status: 'ACTIVE',
    };
    const facts = { orderCount: 1, firstCompletedOrder: { orderId: 'ord_1', netPaise: 50000 } };
    const version = {
      enabledBranches: ['branch_main'],
      steps: [{ delay: { value: 1, unit: 'HOURS' }, outsideHoursPolicy: 'DEFER_NEXT_DAY', maxDeferralHours: 24 }],
    };

    const res = await evaluateCandidateForEventDelay(
      tenantId,
      customer as any,
      facts as any,
      version as any,
      {} as any
    );

    expect(res.eligible).toBe(false);
    expect(res.reason).toBe(EXCLUSION_REASONS.CHANNEL_SUPPRESSED);
  });

  // ============================================================================
  // V24: Customer deleted gate (CUSTOMER_DELETED)
  // ============================================================================
  it('V24: Customer deleted gate (CUSTOMER_DELETED)', async () => {
    const customer = {
      tenantId,
      customerId: 'cus_deleted',
      firstName: 'Suresh',
      consent: { marketingOptIn: true, channelSuppressed: false },
      status: 'DELETED',
    };
    const facts = { orderCount: 1, firstCompletedOrder: { orderId: 'ord_1', netPaise: 50000 } };
    const version = {
      enabledBranches: ['branch_main'],
      steps: [{ delay: { value: 1, unit: 'HOURS' }, outsideHoursPolicy: 'DEFER_NEXT_DAY', maxDeferralHours: 24 }],
    };

    const res = await evaluateCandidateForEventDelay(
      tenantId,
      customer as any,
      facts as any,
      version as any,
      {} as any
    );

    expect(res.eligible).toBe(false);
    expect(res.reason).toBe(EXCLUSION_REASONS.CUSTOMER_DELETED);
  });

  // ============================================================================
  // V25: Branch scope gate (BRANCH_NOT_ENABLED)
  // ============================================================================
  it('V25: Branch scope gate (BRANCH_NOT_ENABLED)', async () => {
    const customer = {
      tenantId,
      customerId: 'cus_branch_disabled',
      firstName: 'Meera',
      branchId: 'branch_two',
      consent: { marketingOptIn: true, channelSuppressed: false },
      status: 'ACTIVE',
    };
    const facts = { orderCount: 1, firstCompletedOrder: { orderId: 'ord_1', netPaise: 50000 } };
    const version = {
      enabledBranches: ['branch_main'], // branch_two is disabled
      steps: [{ delay: { value: 1, unit: 'HOURS' }, outsideHoursPolicy: 'DEFER_NEXT_DAY', maxDeferralHours: 24 }],
    };

    const res = await evaluateCandidateForEventDelay(
      tenantId,
      customer as any,
      facts as any,
      version as any,
      {} as any
    );

    expect(res.eligible).toBe(false);
    expect(res.reason).toBe(EXCLUSION_REASONS.BRANCH_NOT_ENABLED);
  });

  // ============================================================================
  // V26: Shared phone destination deduplication
  // ============================================================================
  it('V26: Shared phone destination deduplication', async () => {
    const sharedHash = `hash_shared_${Date.now()}`;
    const campaignId = 'cmp_wel_shared_phone';

    // First customer enrolled
    await CampaignEnrollmentModel.create({
      tenantId,
      campaignId,
      campaignVersionId: 'v1',
      campaignVersion: 1,
      enrollmentId: `enr_shared_1_${Date.now()}`,
      enrollmentKey: `${tenantId}:${campaignId}:cus_wel_first_phone_user:welcome:ord_1`,
      occurrenceId: 'welcome:ord_1',
      sourceRef: {
        type: 'SRC_ORDERS',
        id: 'ord_1',
        version: 1,
      },
      occasionLocalDate: '2026-10-21',
      customerId: 'cus_wel_first_phone_user',
      destinationHash: sharedHash,
      status: ENROLLMENT_STATUS.ACTIVE,
      firstOrderId: 'ord_1',
    });

    const secondCustomer = {
      tenantId,
      customerId: 'cus_wel_second_phone_user',
      firstName: 'Simran',
      destination: { destinationHash: sharedHash, masked: '+91 98*** **999', verified: true, version: 1 },
      consent: { marketingOptIn: true, channelSuppressed: false },
      status: 'ACTIVE',
    };
    const facts = { orderCount: 1, firstCompletedOrder: { orderId: 'ord_2', netPaise: 50000 } };
    const version = {
      campaignId,
      enabledBranches: ['branch_main'],
      steps: [{ delay: { value: 1, unit: 'HOURS' }, outsideHoursPolicy: 'DEFER_NEXT_DAY', maxDeferralHours: 24 }],
    };

    const res = await evaluateCandidateForEventDelay(
      tenantId,
      secondCustomer as any,
      facts as any,
      version as any,
      {} as any
    );

    expect(res.eligible).toBe(false);
    expect(res.reason).toBe(EXCLUSION_REASONS.DUPLICATE_DESTINATION);
  });

  // ============================================================================
  // V27: Welcome campaign summary report endpoint (/welcome/summary)
  // ============================================================================
  it('V27: Welcome campaign summary report endpoint (/welcome/summary)', async () => {
    await seedDatabase('welcome');

    const res = await request(app)
      .get('/campaigns/cmp_wel_order_mode/welcome/summary')
      .set('Authorization', `Bearer ${staffToken}`);

    expect(res.status).toBe(200);
    expect(res.body.campaignId).toBe('cmp_wel_order_mode');
    expect(res.body.enrolled).toBeDefined();
    expect(res.body.delivered).toBeDefined();
    expect(res.body.observationalRepeatPurchases).toBeDefined();
  });

  // ============================================================================
  // V28: Seed scenario welcome populates expected records and facts
  // ============================================================================
  it('V28: Seed scenario welcome populates expected records and facts', async () => {
    await seedDatabase('welcome');

    // Order mode campaign is active
    const campaign = await CampaignModel.findOne({
      tenantId,
      campaignId: 'cmp_wel_order_mode',
    }).lean();
    expect(campaign).toBeDefined();
    expect(campaign?.presetId).toBe('WELCOME_NEW_CUSTOMER');

    // 3 offers seeded
    const offers = await SrcOfferModel.find({ tenantId }).lean();
    expect(offers.length).toBe(3);

    const activeOffer = offers.find((o) => o.offerId === 'off_welcome_50');
    expect(activeOffer).toBeDefined();
    expect(activeOffer?.status).toBe(OFFER_STATUS.ACTIVE);
    expect(activeOffer?.amountPaise).toBe(5000);

    // Customer facts populated with orders
    const facts = await CampaignCustomerFactModel.find({ tenantId }).lean();
    expect(facts.length).toBeGreaterThan(0);
    for (const f of facts) {
      expect(f.orderCount).toBeDefined();
    }
  });

  // ============================================================================
  // V29: Validate rules on welcome campaign draft created from preset defaults
  // ============================================================================
  it('V29: Validate rules on welcome campaign draft created from preset defaults', async () => {
    const createRes = await request(app)
      .post('/campaigns')
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('Idempotency-Key', `idemp-v29-create-${Date.now()}`)
      .send({
        presetId: 'WELCOME_NEW_CUSTOMER',
        name: 'Welcome In-Store Shoppers',
      });

    expect(createRes.status).toBe(201);
    const campaignId = createRes.body.campaign.campaignId;

    const valRes = await request(app)
      .post(`/campaigns/${campaignId}/validate`)
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(valRes.status).toBe(200);
    expect(valRes.body.valid).toBe(true);
    expect(valRes.body.errors).toHaveLength(0);

    const getRes = await request(app)
      .get(`/campaigns/${campaignId}`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.campaign.status).toBe('VALIDATED');
  });

  // ============================================================================
  // V30: Dry run simulation on welcome campaign draft executes cleanly with zero live writes
  // ============================================================================
  it('V30: Dry run simulation on welcome campaign draft executes cleanly with zero live writes', async () => {
    await seedDatabase('welcome');

    const createRes = await request(app)
      .post('/campaigns')
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('Idempotency-Key', `idemp-v30-create-${Date.now()}`)
      .send({
        presetId: 'WELCOME_NEW_CUSTOMER',
        name: 'Welcome Dry Run Simulation',
      });

    expect(createRes.status).toBe(201);
    const campaignId = createRes.body.campaign.campaignId;

    // Count enrollments and executions before dry run
    const enrollmentsBefore = await CampaignEnrollmentModel.countDocuments({ tenantId, campaignId });
    const executionsBefore = await CampaignExecutionModel.countDocuments({ tenantId, campaignId });
    expect(enrollmentsBefore).toBe(0);
    expect(executionsBefore).toBe(0);

    // Execute dry run
    const dryRunRes = await request(app)
      .post(`/campaigns/${campaignId}/dry-runs`)
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(dryRunRes.status).toBe(201);
    expect(dryRunRes.body.dryRunId).toBeDefined();
    expect(dryRunRes.body.counts.scanned).toBeGreaterThan(0);

    // Strict guarantee: zero live enrollments or executions created
    const enrollmentsAfter = await CampaignEnrollmentModel.countDocuments({ tenantId, campaignId });
    const executionsAfter = await CampaignExecutionModel.countDocuments({ tenantId, campaignId });
    expect(enrollmentsAfter).toBe(0);
    expect(executionsAfter).toBe(0);

    // Fetch latest dry run endpoint
    const latestRes = await request(app)
      .get(`/campaigns/${campaignId}/dry-runs/latest`)
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(latestRes.status).toBe(200);
    expect(latestRes.body.dryRunId).toBe(dryRunRes.body.dryRunId);
    expect(latestRes.body.isStale).toBe(false);
  });

  // ============================================================================
  // V31: PATCH /campaigns/:id/draft succeeds when trigger contains null optional fields
  // ============================================================================
  it('V31: PATCH /campaigns/:id/draft succeeds when trigger contains null optional fields', async () => {
    const createRes = await request(app)
      .post('/campaigns')
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('Idempotency-Key', `idemp-v31-create-${Date.now()}`)
      .send({
        presetId: 'WELCOME_NEW_CUSTOMER',
        name: 'Welcome Null Fields Test',
      });

    expect(createRes.status).toBe(201);
    const campaignId = createRes.body.campaign.campaignId;

    const patchRes = await request(app)
      .patch(`/campaigns/${campaignId}/draft`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('Idempotency-Key', `idemp-v31-patch-${Date.now()}`)
      .send({
        expectedVersion: 1,
        trigger: {
          type: 'EVENT_DELAY',
          anchor: 'FIRST_QUALIFYING_ORDER',
          field: null,
          leapDayPolicy: null,
          thresholdDays: null,
          category: null,
          ruleId: null,
        },
      });

    expect(patchRes.status).toBe(200);
    expect(patchRes.body.draft.trigger.type).toBe('EVENT_DELAY');
  });
});

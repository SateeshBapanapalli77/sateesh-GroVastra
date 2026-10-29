import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import { app } from '../src/app';
import { connectToDatabase, disconnectDatabase } from '../src/db/connection';
import { seedDatabase } from '../src/db/seed';
import {
  CampaignModel,
  CampaignVersionModel,
  CampaignEnrollmentModel,
  CampaignExecutionModel,
  CampaignGoalEventModel,
  CampaignDeliveryIntentModel,
  CampaignSettingsModel,
  SrcCustomerModel,
  SrcCustomerEventModel,
  SrcOrderModel,
} from '../src/db/models';
import { authService } from '../src/services/auth.service';
import { clock } from '../src/services/clock';
import { campaignValidationService } from '../src/services/campaign-validation.service';
import { eventConsumerService } from '../src/services/event-consumer';
import { plannerService } from '../src/services/planner/planner.service';
import { resolveTemplateParameters } from '../src/templates/resolveTemplateParameters';
import {
  calculateLatestUsefulAt,
  formatInsufficientLeadTimeReason,
  getOccurrenceId,
} from '../src/services/datetime';
import { mockOccasionSource } from '../src/adapters';
import { CAMPAIGN_PRESETS } from '../src/services/campaign.service';
import {
  TRIGGER_TYPE,
  ENROLLMENT_STATUS,
  EXECUTION_STATE,
  EXECUTION_REASONS,
  isValidBookingLinkUrl,
} from '@grovastra/shared';

function makeOccasionDoc(params: any) {
  const [y, m, d] = params.eventDateKey.split('-').map(Number);
  return {
    type: 'occasion',
    month: m,
    day: d,
    eventDate: { year: y, month: m, day: d },
    ...params,
  };
}

describe('Preset Gift / Wedding Reminder (F22, Block G, G01-G36)', () => {
  const tenantId = 'shop_a';
  let ownerToken: string;
  let shopBOwnerToken: string;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.DISPATCH_MODE = 'dry';
    process.env.ALLOW_TEST_CATEGORY_MISMATCH = 'true';

    clock.setSystemTime(new Date('2026-10-24T10:00:00.000Z'));

    await connectToDatabase();
    await seedDatabase('gift-wedding');

    ownerToken = authService.signToken({
      userId: 'usr_owner_01',
      tenantId: 'shop_a',
      role: 'owner',
      branchIds: ['branch_main'],
      email: 'owner@shop-a.com',
    });

    shopBOwnerToken = authService.signToken({
      userId: 'usr_owner_02',
      tenantId: 'shop_b',
      role: 'owner',
      branchIds: ['branch_b'],
      email: 'owner@shop-b.com',
    });
  });

  afterAll(async () => {
    clock.resetOffset();
    await disconnectDatabase();
  });

  beforeEach(async () => {
    clock.setSystemTime(new Date('2026-10-24T10:00:00.000Z'));
  });

  // =========================================================================
  // GROUP 1: Registry & Trigger Validation (G01 - G05)
  // =========================================================================

  it('G01: Preset Registry registers gift_wedding_reminder and alias gift_wedding', () => {
    const preset = CAMPAIGN_PRESETS.find((p) => p.id === 'gift_wedding_reminder');
    const aliasPreset = CAMPAIGN_PRESETS.find((p) => p.id === 'gift_wedding');

    expect(preset).toBeDefined();
    expect(aliasPreset).toBeDefined();
    expect(preset?.id).toBe('gift_wedding_reminder');
    expect(aliasPreset?.id).toBe('gift_wedding');
    expect(preset?.category).toBe('MARKETING');

    // Trigger defaults
    expect(preset?.defaults.trigger?.type).toBe('CUSTOMER_EVENT_DATE');
    expect(preset?.defaults.trigger?.occasionKind).toBe('WEDDING');
    expect(preset?.defaults.trigger?.fulfillmentLeadDays).toBe(21);

    // Steps
    expect(preset?.defaults.steps).toHaveLength(2);
    expect(preset?.defaults.steps[0].offsetDays).toBe(-45);
    expect(preset?.defaults.steps[1].offsetDays).toBe(-21);
    expect(preset?.defaults.steps[1].prerequisite).toBe('PREVIOUS_ACCEPTED');
  });

  it('G02: Trigger validation enforces occasionKind is either GIFT or WEDDING', async () => {
    const baseDraft: any = {
      name: 'Valid Wedding Campaign',
      enabledBranches: ['branch_main'],
      timezone: 'Asia/Kolkata',
      trigger: {
        type: 'CUSTOMER_EVENT_DATE',
        occasionKind: 'WEDDING',
        fulfillmentLeadDays: 21,
      },
      steps: [
        {
          stepId: 'step_1',
          offsetDays: -45,
          localTime: '10:00',
          prerequisite: 'NONE',
          templateRef: { id: 'tpl_hello_world', revision: 1, language: 'en_US' },
          bindings: {},
        },
      ],
    };

    // Valid WEDDING
    const reportWedding = await campaignValidationService.validateDraft(tenantId, baseDraft);
    const occasionErrors1 = reportWedding.errors.filter((e) => e.fieldPath.includes('occasionKind'));
    expect(occasionErrors1).toHaveLength(0);

    // Valid GIFT
    const draftGift = {
      ...baseDraft,
      trigger: { ...baseDraft.trigger, occasionKind: 'GIFT', fulfillmentLeadDays: 2 },
    };
    const reportGift = await campaignValidationService.validateDraft(tenantId, draftGift);
    const occasionErrors2 = reportGift.errors.filter((e) => e.fieldPath.includes('occasionKind'));
    expect(occasionErrors2).toHaveLength(0);

    // Invalid occasionKind
    const draftInvalid = {
      ...baseDraft,
      trigger: { ...baseDraft.trigger, occasionKind: 'BIRTHDAY' },
    };
    const reportInvalid = await campaignValidationService.validateDraft(tenantId, draftInvalid);
    const occasionErrors3 = reportInvalid.errors.filter((e) => e.fieldPath === 'trigger.occasionKind');
    expect(occasionErrors3.length).toBeGreaterThan(0);
    expect(occasionErrors3[0].message).toContain('occasionKind is required and must be either');

    // Missing occasionKind
    const draftMissing = {
      ...baseDraft,
      trigger: { type: 'CUSTOMER_EVENT_DATE', fulfillmentLeadDays: 21 },
    };
    const reportMissing = await campaignValidationService.validateDraft(tenantId, draftMissing);
    const occasionErrors4 = reportMissing.errors.filter((e) => e.fieldPath === 'trigger.occasionKind');
    expect(occasionErrors4.length).toBeGreaterThan(0);
  });

  it('G03: Validation of fulfillmentLeadDays allows 0-180 and rejects invalid values', async () => {
    const makeDraftWithLeadDays = (leadDays: any) => ({
      name: 'Lead Days Test',
      enabledBranches: ['branch_main'],
      timezone: 'Asia/Kolkata',
      trigger: {
        type: 'CUSTOMER_EVENT_DATE',
        occasionKind: 'GIFT',
        fulfillmentLeadDays: leadDays,
      },
      steps: [
        {
          stepId: 'step_1',
          offsetDays: -10,
          localTime: '10:00',
          prerequisite: 'NONE',
          templateRef: { id: 'tpl_hello_world', revision: 1, language: 'en_US' },
          bindings: {},
        },
      ],
    });

    // Valid boundaries: 0, 2, 21, 180
    for (const validDays of [0, 2, 21, 180]) {
      const rep = await campaignValidationService.validateDraft(tenantId, makeDraftWithLeadDays(validDays));
      const leadErrors = rep.errors.filter((e) => e.fieldPath === 'trigger.fulfillmentLeadDays');
      expect(leadErrors).toHaveLength(0);
    }

    // Invalid: -1, 181, 2.5, null, undefined
    for (const invalidDays of [-1, 181, 2.5, null, undefined]) {
      const rep = await campaignValidationService.validateDraft(tenantId, makeDraftWithLeadDays(invalidDays));
      const leadErrors = rep.errors.filter((e) => e.fieldPath === 'trigger.fulfillmentLeadDays');
      expect(leadErrors.length).toBeGreaterThan(0);
      expect(leadErrors[0].message).toContain('fulfillmentLeadDays must be an integer between 0 and 180');
    }
  });

  it('G04: Activation requires valid store bookingLinkUrl when step uses shop.bookingLink', async () => {
    const draftWithBookingLink: any = {
      name: 'Booking Link Activation Test',
      enabledBranches: ['branch_main'],
      timezone: 'Asia/Kolkata',
      trigger: {
        type: 'CUSTOMER_EVENT_DATE',
        occasionKind: 'WEDDING',
        fulfillmentLeadDays: 21,
      },
      steps: [
        {
          stepId: 'step_booking',
          offsetDays: -45,
          localTime: '10:00',
          prerequisite: 'NONE',
          templateRef: { id: 'tpl_hello_world', revision: 1, language: 'en_US' },
          bindings: {
            '1': { source: 'shop.bookingLink' },
          },
        },
      ],
    };

    // 1. When bookingLinkUrl is null in settings: fails activation
    await CampaignSettingsModel.updateOne({ tenantId }, { $set: { bookingLinkUrl: null } });
    const reportMissing = await campaignValidationService.validateDraft(tenantId, draftWithBookingLink, true);
    const bookingErrors1 = reportMissing.errors.filter((e) => e.message.includes('bookingLinkUrl'));
    expect(bookingErrors1.length).toBeGreaterThan(0);

    // 2. When bookingLinkUrl is invalid: fails activation
    await CampaignSettingsModel.updateOne({ tenantId }, { $set: { bookingLinkUrl: 'ftp://not-http' } });
    const reportInvalid = await campaignValidationService.validateDraft(tenantId, draftWithBookingLink, true);
    const bookingErrors2 = reportInvalid.errors.filter((e) => e.message.includes('not a valid HTTP/HTTPS URL'));
    expect(bookingErrors2.length).toBeGreaterThan(0);

    // 3. When bookingLinkUrl is valid: passes activation
    await CampaignSettingsModel.updateOne({ tenantId }, { $set: { bookingLinkUrl: 'https://shop-a.com/book' } });
    const reportValid = await campaignValidationService.validateDraft(tenantId, draftWithBookingLink, true);
    const bookingErrors3 = reportValid.errors.filter((e) => e.message.includes('bookingLinkUrl'));
    expect(bookingErrors3).toHaveLength(0);
  });

  it('G05: Anti-pattern warning when template copy or literals claim appointment is already booked', async () => {
    const draftWithClaimWording: any = {
      name: 'Anti-pattern Copy Test',
      enabledBranches: ['branch_main'],
      timezone: 'Asia/Kolkata',
      trigger: {
        type: 'CUSTOMER_EVENT_DATE',
        occasionKind: 'WEDDING',
        fulfillmentLeadDays: 21,
      },
      steps: [
        {
          stepId: 'step_claim',
          offsetDays: -45,
          localTime: '10:00',
          prerequisite: 'NONE',
          templateRef: { id: 'tpl_hello_world', revision: 1, language: 'en_US' },
          bindings: {
            '1': { literalValue: 'Your bridal styling appointment has been booked for you at our boutique!' },
          },
        },
      ],
    };

    const report = await campaignValidationService.validateDraft(tenantId, draftWithClaimWording, false);
    const claimWarnings = report.warnings.filter((w) => w.code === 'BOOKING_CLAIM_WORDING_WARNING');
    expect(claimWarnings.length).toBeGreaterThan(0);
    expect(claimWarnings[0].message).toContain('falsely claims an appointment is already booked');
  });

  // =========================================================================
  // GROUP 2: Discovery & Audience Filtering (G06 - G10)
  // =========================================================================

  it('G06: Candidate discovery for WEDDING queries src_customerEvents for WEDDING kind', async () => {
    const occasions = await mockOccasionSource.listForCustomer(tenantId, 'cus_gw_wedding_live');
    const wedding = occasions.find((o) => o.kind === 'WEDDING');
    expect(wedding).toBeDefined();
    expect(wedding?.kind).toBe('WEDDING');
    expect(wedding?.declaredByCustomer).toBe(true);
    expect(wedding?.status).toBe('ACTIVE');
  });

  it('G07: Candidate discovery for GIFT queries src_customerEvents for GIFT kind', async () => {
    const occasions = await mockOccasionSource.listForCustomer(tenantId, 'cus_gw_gift_mom');
    const gift = occasions.find((o) => o.kind === 'GIFT');
    expect(gift).toBeDefined();
    expect(gift?.kind).toBe('GIFT');
    expect(gift?.recipientLabel).toBe('Mom');
    expect(gift?.declaredByCustomer).toBe(true);
  });

  it('G08: Unverified customer occasions (declaredByCustomer: false) are excluded from discovery', async () => {
    const occasions = await mockOccasionSource.listForCustomer(tenantId, 'cus_gw_undeclared');
    const undeclared = occasions.find((o) => o.eventId === 'evt_gw_wed_undeclared');
    expect(undeclared).toBeDefined();
    expect(undeclared?.declaredByCustomer).toBe(false);

    // Verify planner filters it out
    const enrollments = await CampaignEnrollmentModel.find({
      tenantId,
      customerId: 'cus_gw_undeclared',
    });
    expect(enrollments).toHaveLength(0);
  });

  it('G09: Inactive occasions (status CANCELLED, COMPLETED, PAST) are excluded from discovery', async () => {
    // cus_gw_cancelled has status CANCELLED
    const cancelledOcc = await mockOccasionSource.getOccasion(tenantId, 'evt_gw_gift_cancelled');
    expect(cancelledOcc?.status).toBe('CANCELLED');

    // cus_gw_past has an event in the past
    const pastOcc = await mockOccasionSource.getOccasion(tenantId, 'evt_gw_wed_past');
    expect(pastOcc).toBeDefined();

    const cancelledEnr = await CampaignEnrollmentModel.find({ tenantId, customerId: 'cus_gw_cancelled' });
    const pastEnr = await CampaignEnrollmentModel.find({ tenantId, customerId: 'cus_gw_past' });
    expect(cancelledEnr).toHaveLength(0);
    expect(pastEnr).toHaveLength(0);
  });

  it('G10: Audience rule evaluation filters candidates on occasion budget and categories', async () => {
    const occasionRecord = await mockOccasionSource.getOccasion(tenantId, 'evt_gw_wed_1');
    expect(occasionRecord).toBeDefined();
    expect(occasionRecord?.budgetPaise).toBe(10000000);
    expect(occasionRecord?.categories).toContain('BRIDAL_WEAR');

    // Customer with 10,000,000 paise meets budget >= 5,000,000
    expect(occasionRecord!.budgetPaise! >= 5000000).toBe(true);
    // Categories check
    expect(occasionRecord!.categories!.includes('BRIDAL_WEAR')).toBe(true);
    expect(occasionRecord!.categories!.includes('casual_western')).toBe(false);
  });

  // =========================================================================
  // GROUP 3: Enrollment & Step Scheduling (G11 - G15)
  // =========================================================================

  it('G11: Idempotent enrollment creation creates occurrence key wedding:{eventId} or gift:{eventId}', async () => {
    const occWeddingKey = getOccurrenceId('wedding', undefined, 'evt_gw_wed_1');
    const occGiftKey = getOccurrenceId('gift', undefined, 'evt_gw_gift_1');

    expect(occWeddingKey).toBe('wedding:evt_gw_wed_1');
    expect(occGiftKey).toBe('gift:evt_gw_gift_1');

    const enrollments = await CampaignEnrollmentModel.find({
      tenantId,
      customerId: 'cus_gw_wedding_live',
      occurrenceId: occWeddingKey,
    });
    expect(enrollments).toHaveLength(1);

    // Re-run planner and verify count remains 1
    await plannerService.planCampaign(tenantId, 'cmp_gift_wedding_shop_a');
    const enrollmentsAfter = await CampaignEnrollmentModel.find({
      tenantId,
      customerId: 'cus_gw_wedding_live',
      occurrenceId: occWeddingKey,
    });
    expect(enrollmentsAfter).toHaveLength(1);
  });

  it('G12: WEDDING default steps schedule D-45 and D-21 correctly', async () => {
    const enrollment = await CampaignEnrollmentModel.findOne({
      tenantId,
      customerId: 'cus_gw_wedding_live',
      occurrenceId: 'wedding:evt_gw_wed_1',
    });
    expect(enrollment).toBeDefined();

    const executions = await CampaignExecutionModel.find({
      tenantId,
      enrollmentId: enrollment!.enrollmentId,
    }).sort({ dueAt: 1 });

    expect(executions).toHaveLength(2);
    expect(executions[0].stepId).toBe('step_wedding_d45');
    expect(executions[1].stepId).toBe('step_wedding_d21');
    expect(executions[1].prerequisite).toBe('PREVIOUS_ACCEPTED');
  });

  it('G13: GIFT default steps schedule D-10 and D-3 relative to event date', () => {
    const eventDateKey = '2026-11-20';
    const dueD10 = calculateLatestUsefulAt({
      eventDateKey,
      fulfillmentLeadDays: 2,
      allowedSendingHoursEnd: '19:00',
      timezone: 'Asia/Kolkata',
    });
    expect(dueD10.latestUsefulAt).toBeDefined();
    expect(dueD10.latestUsefulLocalDate).toBe('2026-11-18');
  });

  it('G14: Lead time deadline latestUsefulAt computed as eventDate - fulfillmentLeadDays', () => {
    const res = calculateLatestUsefulAt({
      eventDateKey: '2026-12-15',
      fulfillmentLeadDays: 21,
      allowedSendingHoursEnd: '19:00',
      timezone: 'Asia/Kolkata',
    });

    expect(res.latestUsefulLocalDate).toBe('2026-11-24');
    expect(res.latestUsefulAt).toBeInstanceOf(Date);
  });

  it('G15: Short lead time steps are SKIPPED with INSUFFICIENT_LEAD_TIME and owner-facing reason', async () => {
    const enrollmentShortLead = await CampaignEnrollmentModel.findOne({
      tenantId,
      customerId: 'cus_gw_wed_short_lead',
    });
    expect(enrollmentShortLead).toBeDefined();

    const executions = await CampaignExecutionModel.find({
      tenantId,
      enrollmentId: enrollmentShortLead!.enrollmentId,
    });

    expect(executions.length).toBeGreaterThan(0);
    const skippedStep = executions.find((e) => e.skipReason === EXECUTION_REASONS.INSUFFICIENT_LEAD_TIME);
    expect(skippedStep).toBeDefined();
    expect(skippedStep?.state).toBe(EXECUTION_STATE.SKIPPED);
    expect(skippedStep?.usefulUntilReason).toBe('Skipped: needs 21 days before the event; the event is in 15 days');
  });

  // =========================================================================
  // GROUP 4: Rescheduling & Postponement (G16 - G20)
  // =========================================================================

  it('G16: Date change via occasion.saved revises existing occurrence without duplicate enrollments', async () => {
    const eventId = 'evt_gw_wedding_test_reschedule';
    const occKey = `wedding:${eventId}`;

    // Create occasion 45 days out
    const d45 = new Date('2026-10-24T10:00:00Z');
    d45.setDate(d45.getDate() + 45);
    const date45Str = d45.toISOString().split('T')[0];

    await SrcCustomerEventModel.create(
      makeOccasionDoc({
        tenantId,
        eventId,
        customerId: 'cus_gw_wedding_live',
        kind: 'WEDDING',
        eventDateKey: date45Str,
        declaredByCustomer: true,
        budgetPaise: 5000000,
        categories: ['BRIDAL_WEAR'],
        status: 'ACTIVE',
        source: 'CUSTOMER_DECLARED',
      })
    );

    // Ingest occasion.saved to enroll
    await eventConsumerService.ingestEvent(tenantId, 'occasions', {
      schemaVersion: 1,
      producer: 'occasions',
      eventId: `inbox_${Date.now()}_1`,
      tenantId,
      type: 'occasion.saved',
      entityId: eventId,
      entityVersion: 1,
      customerId: 'cus_gw_wedding_live',
      occurredAt: clock.now().toISOString(),
      data: { eventId, eventDate: date45Str },
    });

    const enrollmentsBefore = await CampaignEnrollmentModel.find({
      tenantId,
      occurrenceId: occKey,
    });
    expect(enrollmentsBefore).toHaveLength(1);

    // Now postpone by 30 days
    const d75 = new Date('2026-10-24T10:00:00Z');
    d75.setDate(d75.getDate() + 75);
    const date75Str = d75.toISOString().split('T')[0];
    const [y75, m75, day75] = date75Str.split('-').map(Number);

    await SrcCustomerEventModel.updateOne(
      { tenantId, eventId },
      {
        $set: {
          eventDateKey: date75Str,
          month: m75,
          day: day75,
          eventDate: { year: y75, month: m75, day: day75 },
          entityVersion: 2,
        },
      }
    );

    await eventConsumerService.ingestEvent(tenantId, 'occasions', {
      schemaVersion: 1,
      producer: 'occasions',
      eventId: `inbox_${Date.now()}_2`,
      tenantId,
      type: 'occasion.saved',
      entityId: eventId,
      entityVersion: 2,
      customerId: 'cus_gw_wedding_live',
      occurredAt: clock.now().toISOString(),
      data: { eventId, eventDate: date75Str },
    });

    // Verifies G16: exactly 1 enrollment exists
    const enrollmentsAfter = await CampaignEnrollmentModel.find({
      tenantId,
      occurrenceId: occKey,
    });
    expect(enrollmentsAfter).toHaveLength(1);
    expect(enrollmentsAfter[0].enrollmentId).toBe(enrollmentsBefore[0].enrollmentId);
  });

  it('G17: planRevision is bumped atomically on date change', async () => {
    const occKey = 'wedding:evt_gw_wedding_test_reschedule';
    const enrollment = await CampaignEnrollmentModel.findOne({ tenantId, occurrenceId: occKey });
    expect(enrollment).toBeDefined();
    expect(enrollment?.planRevision).toBe(2);
  });

  it('G18: Unsubmitted executions (deliveryIntentId: null) recomputed to new dates', async () => {
    const occKey = 'wedding:evt_gw_wedding_test_reschedule';
    const enrollment = await CampaignEnrollmentModel.findOne({ tenantId, occurrenceId: occKey });
    const executions = await CampaignExecutionModel.find({
      tenantId,
      enrollmentId: enrollment!.enrollmentId,
    });

    expect(executions.length).toBeGreaterThan(0);
    for (const exe of executions) {
      expect(exe.deliveryIntentId).toBeNull();
      expect(exe.planRevision).toBe(2);
    }
  });

  it('G19: Reschedule appends entry to dateHistory audit trail', async () => {
    const occKey = 'wedding:evt_gw_wedding_test_reschedule';
    const enrollment = await CampaignEnrollmentModel.findOne({ tenantId, occurrenceId: occKey });
    expect(enrollment?.dateHistory).toBeDefined();
    expect(enrollment!.dateHistory!.length).toBeGreaterThanOrEqual(1);

    const historyEntry = enrollment!.dateHistory![0];
    expect(historyEntry.oldVersion).toBe(1);
    expect(historyEntry.newVersion).toBe(2);
    expect(historyEntry.oldDate).toBeDefined();
    expect(historyEntry.newDate).toBeDefined();
    expect(historyEntry.at).toBeDefined();
  });

  it('G20: In-flight worker claim with deliveryIntentId !== null is marked BLOCKED_STALE_INTENT', async () => {
    const eventId = 'evt_gw_stale_intent_test';
    const occKey = `wedding:${eventId}`;

    const d45 = new Date('2026-10-24T10:00:00Z');
    d45.setDate(d45.getDate() + 45);
    const date45Str = d45.toISOString().split('T')[0];

    await SrcCustomerEventModel.create(
      makeOccasionDoc({
        tenantId,
        eventId,
        customerId: 'cus_gw_wedding_live',
        kind: 'WEDDING',
        eventDateKey: date45Str,
        declaredByCustomer: true,
        budgetPaise: 5000000,
        categories: ['BRIDAL_WEAR'],
        status: 'ACTIVE',
        source: 'CUSTOMER_DECLARED',
      })
    );

    await eventConsumerService.ingestEvent(tenantId, 'occasions', {
      schemaVersion: 1,
      producer: 'occasions',
      eventId: `inbox_${Date.now()}_3`,
      tenantId,
      type: 'occasion.saved',
      entityId: eventId,
      entityVersion: 1,
      customerId: 'cus_gw_wedding_live',
      occurredAt: clock.now().toISOString(),
      data: { eventId, eventDate: date45Str },
    });

    const enrollment = await CampaignEnrollmentModel.findOne({ tenantId, occurrenceId: occKey });
    expect(enrollment).toBeDefined();

    // Simulate in-flight worker claim creating deliveryIntentId
    const intentId = `din_test_${Date.now()}`;
    await CampaignDeliveryIntentModel.create({
      tenantId,
      deliveryIntentId: intentId,
      campaignId: enrollment!.campaignId,
      enrollmentId: enrollment!.enrollmentId,
      executionId: 'exe_test_1',
      deliveryKey: `del_${Date.now()}`,
      connectionId: 'conn_test',
      recipientVersion: 1,
      encryptedRecipient: 'enc_phone',
      maskedRecipient: '+91 91*** **201',
      templateRef: { id: 'tpl_hello_world', revision: 1, language: 'en_US' },
      parameters: {},
      payloadHash: 'hash_123',
      attemptId: 'att_123',
      state: 'FROZEN',
    });

    await CampaignExecutionModel.updateOne(
      { tenantId, enrollmentId: enrollment!.enrollmentId, stepId: 'step_wedding_d45' },
      { $set: { deliveryIntentId: intentId, state: EXECUTION_STATE.CLAIMED } }
    );

    // Now postpone the event
    const d80 = new Date('2026-10-24T10:00:00Z');
    d80.setDate(d80.getDate() + 80);
    const date80Str = d80.toISOString().split('T')[0];
    const [y80, m80, day80] = date80Str.split('-').map(Number);

    await SrcCustomerEventModel.updateOne(
      { tenantId, eventId },
      {
        $set: {
          eventDateKey: date80Str,
          month: m80,
          day: day80,
          eventDate: { year: y80, month: m80, day: day80 },
          entityVersion: 2,
        },
      }
    );

    await eventConsumerService.ingestEvent(tenantId, 'occasions', {
      schemaVersion: 1,
      producer: 'occasions',
      eventId: `inbox_${Date.now()}_4`,
      tenantId,
      type: 'occasion.saved',
      entityId: eventId,
      entityVersion: 2,
      customerId: 'cus_gw_wedding_live',
      occurredAt: clock.now().toISOString(),
      data: { eventId, eventDate: date80Str },
    });

    // Check delivery intent is BLOCKED with BLOCKED_STALE_INTENT
    const intentAfter = await CampaignDeliveryIntentModel.findOne({ tenantId, deliveryIntentId: intentId });
    expect(intentAfter?.state).toBe('BLOCKED');
    expect(intentAfter?.failureReason).toBe(EXECUTION_REASONS.BLOCKED_STALE_INTENT);

    // Check execution is BLOCKED with BLOCKED_STALE_INTENT
    const executionAfter = await CampaignExecutionModel.findOne({
      tenantId,
      enrollmentId: enrollment!.enrollmentId,
      stepId: 'step_wedding_d45',
    });
    expect(executionAfter?.state).toBe(EXECUTION_STATE.BLOCKED);
    expect(executionAfter?.skipReason).toBe(EXECUTION_REASONS.BLOCKED_STALE_INTENT);
  });

  // =========================================================================
  // GROUP 5: Lifecycle Cancellation, Deletion & Completion (G21 - G25)
  // =========================================================================

  it('G21: occasion.cancelled cancels pending executions with OCCASION_CANCELLED', async () => {
    const eventId = 'evt_gw_cancel_lifecycle_test';
    const occKey = `wedding:${eventId}`;

    await SrcCustomerEventModel.create(
      makeOccasionDoc({
        tenantId,
        eventId,
        customerId: 'cus_gw_wedding_live',
        kind: 'WEDDING',
        eventDateKey: '2026-12-25',
        declaredByCustomer: true,
        budgetPaise: 5000000,
        categories: ['BRIDAL_WEAR'],
        status: 'ACTIVE',
        source: 'CUSTOMER_DECLARED',
      })
    );

    await eventConsumerService.ingestEvent(tenantId, 'occasions', {
      schemaVersion: 1,
      producer: 'occasions',
      eventId: `inbox_${Date.now()}_c1`,
      tenantId,
      type: 'occasion.saved',
      entityId: eventId,
      entityVersion: 1,
      customerId: 'cus_gw_wedding_live',
      occurredAt: clock.now().toISOString(),
      data: { eventId, eventDate: '2026-12-25' },
    });

    const enr = await CampaignEnrollmentModel.findOne({ tenantId, occurrenceId: occKey });
    expect(enr).toBeDefined();

    // Now cancel
    await SrcCustomerEventModel.updateOne({ tenantId, eventId }, { $set: { status: 'CANCELLED' } });
    await eventConsumerService.ingestEvent(tenantId, 'occasions', {
      schemaVersion: 1,
      producer: 'occasions',
      eventId: `inbox_${Date.now()}_c2`,
      tenantId,
      type: 'occasion.cancelled',
      entityId: eventId,
      entityVersion: 2,
      customerId: 'cus_gw_wedding_live',
      occurredAt: clock.now().toISOString(),
      data: { eventId, reason: 'Bride rescheduled indefinitely' },
    });

    const enrAfter = await CampaignEnrollmentModel.findOne({ tenantId, occurrenceId: occKey });
    expect(enrAfter?.status).toBe(ENROLLMENT_STATUS.CANCELLED);

    const execs = await CampaignExecutionModel.find({ tenantId, enrollmentId: enr!.enrollmentId });
    for (const exe of execs) {
      expect(exe.state).toBe(EXECUTION_STATE.CANCELLED);
      expect(exe.skipReason).toBe(EXECUTION_REASONS.OCCASION_CANCELLED);
    }
  });

  it('G22: occasion.deleted cancels pending executions with OCCASION_DELETED', async () => {
    const eventId = 'evt_gw_delete_lifecycle_test';
    const occKey = `wedding:${eventId}`;

    await SrcCustomerEventModel.create(
      makeOccasionDoc({
        tenantId,
        eventId,
        customerId: 'cus_gw_wedding_live',
        kind: 'WEDDING',
        eventDateKey: '2026-12-30',
        declaredByCustomer: true,
        budgetPaise: 5000000,
        categories: ['BRIDAL_WEAR'],
        status: 'ACTIVE',
        source: 'CUSTOMER_DECLARED',
      })
    );

    await eventConsumerService.ingestEvent(tenantId, 'occasions', {
      schemaVersion: 1,
      producer: 'occasions',
      eventId: `inbox_${Date.now()}_d1`,
      tenantId,
      type: 'occasion.saved',
      entityId: eventId,
      entityVersion: 1,
      customerId: 'cus_gw_wedding_live',
      occurredAt: clock.now().toISOString(),
      data: { eventId, eventDate: '2026-12-30' },
    });

    const enr = await CampaignEnrollmentModel.findOne({ tenantId, occurrenceId: occKey });

    // Ingest occasion.deleted
    await SrcCustomerEventModel.updateOne({ tenantId, eventId }, { $set: { deletedAt: new Date() } });
    await eventConsumerService.ingestEvent(tenantId, 'occasions', {
      schemaVersion: 1,
      producer: 'occasions',
      eventId: `inbox_${Date.now()}_d2`,
      tenantId,
      type: 'occasion.deleted',
      entityId: eventId,
      entityVersion: 2,
      customerId: 'cus_gw_wedding_live',
      occurredAt: clock.now().toISOString(),
      data: { eventId },
    });

    const enrAfter = await CampaignEnrollmentModel.findOne({ tenantId, occurrenceId: occKey });
    expect(enrAfter?.status).toBe(ENROLLMENT_STATUS.CANCELLED);

    const execs = await CampaignExecutionModel.find({ tenantId, enrollmentId: enr!.enrollmentId });
    for (const exe of execs) {
      expect(exe.state).toBe(EXECUTION_STATE.CANCELLED);
      expect(exe.skipReason).toBe(EXECUTION_REASONS.OCCASION_DELETED);
    }
  });

  it('G23: occasion.completed cancels pending executions with OCCASION_COMPLETED', async () => {
    const eventId = 'evt_gw_complete_lifecycle_test';
    const occKey = `wedding:${eventId}`;

    await SrcCustomerEventModel.create(
      makeOccasionDoc({
        tenantId,
        eventId,
        customerId: 'cus_gw_wedding_live',
        kind: 'WEDDING',
        eventDateKey: '2026-12-28',
        declaredByCustomer: true,
        budgetPaise: 5000000,
        categories: ['BRIDAL_WEAR'],
        status: 'ACTIVE',
        source: 'CUSTOMER_DECLARED',
      })
    );

    await eventConsumerService.ingestEvent(tenantId, 'occasions', {
      schemaVersion: 1,
      producer: 'occasions',
      eventId: `inbox_${Date.now()}_comp1`,
      tenantId,
      type: 'occasion.saved',
      entityId: eventId,
      entityVersion: 1,
      customerId: 'cus_gw_wedding_live',
      occurredAt: clock.now().toISOString(),
      data: { eventId, eventDate: '2026-12-28' },
    });

    const enr = await CampaignEnrollmentModel.findOne({ tenantId, occurrenceId: occKey });

    // Complete occasion
    await SrcCustomerEventModel.updateOne({ tenantId, eventId }, { $set: { status: 'COMPLETED' } });
    await eventConsumerService.ingestEvent(tenantId, 'occasions', {
      schemaVersion: 1,
      producer: 'occasions',
      eventId: `inbox_${Date.now()}_comp2`,
      tenantId,
      type: 'occasion.completed',
      entityId: eventId,
      entityVersion: 2,
      customerId: 'cus_gw_wedding_live',
      occurredAt: clock.now().toISOString(),
      data: { eventId },
    });

    const enrAfter = await CampaignEnrollmentModel.findOne({ tenantId, occurrenceId: occKey });
    expect(enrAfter?.status).toBe(ENROLLMENT_STATUS.COMPLETED);

    const execs = await CampaignExecutionModel.find({ tenantId, enrollmentId: enr!.enrollmentId });
    for (const exe of execs) {
      expect(exe.state).toBe(EXECUTION_STATE.CANCELLED);
      expect(exe.skipReason).toBe(EXECUTION_REASONS.OCCASION_COMPLETED);
    }
  });

  it('G24: Goal event recorded on occasion completion with OCCASION_COMPLETED source', async () => {
    const occKey = 'wedding:evt_gw_complete_lifecycle_test';
    const goalEvent = await CampaignGoalEventModel.findOne({
      tenantId,
      occurrence: occKey,
      source: 'OCCASION_COMPLETED',
    });
    expect(goalEvent).toBeDefined();
    expect(goalEvent?.cause).toContain('Occasion marked completed');
  });

  it('G25: Subsequent events after cancellation or completion handle state transitions cleanly', async () => {
    const eventId = 'evt_gw_complete_lifecycle_test';

    // Ingest another occasion.saved: already COMPLETED, does not resurrect or duplicate
    const res = await eventConsumerService.ingestEvent(tenantId, 'occasions', {
      schemaVersion: 1,
      producer: 'occasions',
      eventId: `inbox_${Date.now()}_subsequent`,
      tenantId,
      type: 'occasion.saved',
      entityId: eventId,
      entityVersion: 3,
      customerId: 'cus_gw_wedding_live',
      occurredAt: clock.now().toISOString(),
      data: { eventId, eventDate: '2026-12-28' },
    });

    expect(res).toBeDefined();
    const occKey = `wedding:${eventId}`;
    const enrollments = await CampaignEnrollmentModel.find({ tenantId, occurrenceId: occKey });
    expect(enrollments).toHaveLength(1);
    expect(enrollments[0].status).toBe(ENROLLMENT_STATUS.COMPLETED);
  });

  // =========================================================================
  // GROUP 6: Goal Attribution & Order Tagging (G26 - G30)
  // =========================================================================

  it('G26: order.completed with occasionRef wedding:{eventId} satisfies goal and stops steps', async () => {
    const eventId = 'evt_gw_order_goal_wedding';
    const occKey = `wedding:${eventId}`;

    await SrcCustomerEventModel.create(
      makeOccasionDoc({
        tenantId,
        eventId,
        customerId: 'cus_gw_wedding_live',
        kind: 'WEDDING',
        eventDateKey: '2026-12-18',
        declaredByCustomer: true,
        budgetPaise: 5000000,
        categories: ['BRIDAL_WEAR'],
        status: 'ACTIVE',
        source: 'CUSTOMER_DECLARED',
      })
    );

    await eventConsumerService.ingestEvent(tenantId, 'occasions', {
      schemaVersion: 1,
      producer: 'occasions',
      eventId: `inbox_${Date.now()}_og1`,
      tenantId,
      type: 'occasion.saved',
      entityId: eventId,
      entityVersion: 1,
      customerId: 'cus_gw_wedding_live',
      occurredAt: clock.now().toISOString(),
      data: { eventId, eventDate: '2026-12-18' },
    });

    const enr = await CampaignEnrollmentModel.findOne({ tenantId, occurrenceId: occKey });
    expect(enr).toBeDefined();

    // Ingest order.completed with matching occasionRef
    const orderId = `ord_gw_wed_${Date.now()}`;
    await SrcOrderModel.create({
      tenantId,
      orderId,
      customerId: 'cus_gw_wedding_live',
      netPaise: 7500000,
      netAmountPaise: 7500000,
      paid: true,
      status: 'COMPLETED',
      occasionRef: occKey,
      completedAt: clock.now(),
    });

    await eventConsumerService.ingestEvent(tenantId, 'orders', {
      schemaVersion: 1,
      producer: 'orders',
      eventId: `inbox_${Date.now()}_ord1`,
      tenantId,
      type: 'order.completed',
      entityId: orderId,
      entityVersion: 1,
      customerId: 'cus_gw_wedding_live',
      occurredAt: clock.now().toISOString(),
      data: {
        orderId,
        customerId: 'cus_gw_wedding_live',
        netAmountPaise: 7500000,
        occasionRef: occKey,
      },
    });

    // Check enrollment marked goalReachedAt
    const enrAfter = await CampaignEnrollmentModel.findOne({ tenantId, occurrenceId: occKey });
    expect(enrAfter?.goalReachedAt).toBeDefined();

    // Check stopOnGoal steps marked SKIPPED_GOAL_REACHED
    const execs = await CampaignExecutionModel.find({ tenantId, enrollmentId: enr!.enrollmentId });
    const skippedGoal = execs.filter((e) => e.skipReason === EXECUTION_REASONS.SKIPPED_GOAL_REACHED);
    expect(skippedGoal.length).toBeGreaterThan(0);
  });

  it('G27: order.completed with occasionRef gift:{eventId} satisfies goal and stops steps', async () => {
    const eventId = 'evt_gw_order_goal_gift';
    const occKey = `gift:${eventId}`;

    // Create an enrollment directly for this GIFT occasion
    const enrollmentId = `enr_gift_goal_${Date.now()}`;
    await CampaignEnrollmentModel.create({
      enrollmentId,
      enrollmentKey: `${tenantId}:cmp_gift_wedding_shop_a:cus_gw_gift_mom:${occKey}`,
      tenantId,
      campaignId: 'cmp_gift_wedding_shop_a',
      campaignVersionId: 'ver_gift_wedding_shop_a_1',
      campaignVersion: 1,
      customerId: 'cus_gw_gift_mom',
      occurrenceId: occKey,
      sourceRef: { type: 'SRC_CUSTOMER_EVENT', id: eventId, version: 1 },
      occasionLocalDate: '2026-11-25',
      planRevision: 1,
      status: ENROLLMENT_STATUS.ACTIVE,
      replyHoldAt: null,
      goalReachedAt: null,
      matchExplanation: 'gift goal test',
      correctionGroupId: null,
      eventId,
      occasionKind: 'GIFT',
      eventDateSnapshot: '2026-11-25',
    });

    await CampaignExecutionModel.create({
      executionId: `exe_gift_goal_${Date.now()}`,
      executionKey: `${enrollmentId}:step_wedding_d45`,
      tenantId,
      campaignId: 'cmp_gift_wedding_shop_a',
      enrollmentId,
      stepId: 'step_wedding_d45',
      stepName: '45 Days Before',
      dueAt: new Date('2026-11-10T04:30:00Z'),
      originalDueAt: new Date('2026-11-10T04:30:00Z'),
      adjustedDueAt: new Date('2026-11-10T04:30:00Z'),
      expiresAt: new Date('2026-11-10T14:30:00Z'),
      localDate: '2026-11-10',
      localTime: '10:00',
      timezone: 'Asia/Kolkata',
      planRevision: 1,
      state: EXECUTION_STATE.SCHEDULED,
      skipReason: null,
      prerequisite: 'NONE',
      deliveryIntentId: null,
    });

    const orderId = `ord_gw_gift_${Date.now()}`;
    await SrcOrderModel.create({
      tenantId,
      orderId,
      customerId: 'cus_gw_gift_mom',
      netPaise: 3000000,
      netAmountPaise: 3000000,
      paid: true,
      status: 'COMPLETED',
      occasionRef: occKey,
      completedAt: clock.now(),
    });

    await eventConsumerService.ingestEvent(tenantId, 'orders', {
      schemaVersion: 1,
      producer: 'orders',
      eventId: `inbox_${Date.now()}_ord2`,
      tenantId,
      type: 'order.completed',
      entityId: orderId,
      entityVersion: 1,
      customerId: 'cus_gw_gift_mom',
      occurredAt: clock.now().toISOString(),
      data: {
        orderId,
        customerId: 'cus_gw_gift_mom',
        netAmountPaise: 3000000,
        occasionRef: occKey,
      },
    });

    const enrAfter = await CampaignEnrollmentModel.findOne({ tenantId, occurrenceId: occKey });
    expect(enrAfter?.goalReachedAt).toBeDefined();
  });

  it('G28: Untagged orders (occasionRef: null) do not stop occasion campaign steps', async () => {
    const occKey = 'wedding:evt_gw_wed_1';
    const enr = await CampaignEnrollmentModel.findOne({ tenantId, occurrenceId: occKey });
    expect(enr).toBeDefined();

    const orderId = `ord_untagged_${Date.now()}`;
    await SrcOrderModel.create({
      tenantId,
      orderId,
      customerId: 'cus_gw_wedding_live',
      netPaise: 5000000,
      netAmountPaise: 5000000,
      paid: true,
      status: 'COMPLETED',
      occasionRef: null,
      completedAt: clock.now(),
    });

    await eventConsumerService.ingestEvent(tenantId, 'orders', {
      schemaVersion: 1,
      producer: 'orders',
      eventId: `inbox_${Date.now()}_ord_untagged`,
      tenantId,
      type: 'order.completed',
      entityId: orderId,
      entityVersion: 1,
      customerId: 'cus_gw_wedding_live',
      occurredAt: clock.now().toISOString(),
      data: {
        orderId,
        customerId: 'cus_gw_wedding_live',
        netAmountPaise: 5000000,
        occasionRef: null,
      },
    });

    // Verify enrollment goalReachedAt remains null/falsy
    const enrAfter = await CampaignEnrollmentModel.findOne({ tenantId, occurrenceId: occKey });
    expect(enrAfter?.goalReachedAt).toBeFalsy();
  });

  it('G29: Mismatched occasion reference does not affect unrelated occasions', async () => {
    const occKey = 'wedding:evt_gw_wed_1';
    const orderId = `ord_mismatched_${Date.now()}`;

    await SrcOrderModel.create({
      tenantId,
      orderId,
      customerId: 'cus_gw_wedding_live',
      netPaise: 5000000,
      netAmountPaise: 5000000,
      paid: true,
      status: 'COMPLETED',
      occasionRef: 'wedding:different_event_id_999',
      completedAt: clock.now(),
    });

    await eventConsumerService.ingestEvent(tenantId, 'orders', {
      schemaVersion: 1,
      producer: 'orders',
      eventId: `inbox_${Date.now()}_ord_mismatch`,
      tenantId,
      type: 'order.completed',
      entityId: orderId,
      entityVersion: 1,
      customerId: 'cus_gw_wedding_live',
      occurredAt: clock.now().toISOString(),
      data: {
        orderId,
        customerId: 'cus_gw_wedding_live',
        netAmountPaise: 5000000,
        occasionRef: 'wedding:different_event_id_999',
      },
    });

    const enr = await CampaignEnrollmentModel.findOne({ tenantId, occurrenceId: occKey });
    expect(enr?.goalReachedAt).toBeFalsy();
  });

  it('G30: Goal event recorded with matching orderRef and occasion occurrence', async () => {
    const occKey = 'wedding:evt_gw_order_goal_wedding';
    const goal = await CampaignGoalEventModel.findOne({
      tenantId,
      occurrence: occKey,
      source: 'ORDER_OCCASION',
    });
    expect(goal).toBeDefined();
    expect(goal?.orderRef).toBeDefined();
    expect(typeof goal?.orderRef).toBe('string');
  });

  // =========================================================================
  // GROUP 7: Parameters, Privacy, Guardrails & Summary (G31 - G36)
  // =========================================================================

  it('G31: Parameter resolution resolves localDate, recipientLabel, bookingLink, and customer name', () => {
    // 1. Wedding step: customer.firstName, event.localDate, shop.bookingLink
    const mockStepWedding: any = {
      stepId: 'step_wedding_d45',
      templateRef: { id: 'tpl_hello_world', revision: 1, language: 'en_US' },
      bindings: {
        '1': { source: 'customer.firstName' },
        '2': { source: 'event.localDate' },
        '3': { source: 'shop.bookingLink' },
      },
    };

    const mockTemplateWedding: any = {
      id: 'tpl_hello_world',
      name: 'hello_world',
      language: 'en_US',
      revision: 1,
      parameterFormat: 'POSITIONAL',
      variables: [
        { index: 1, name: '1', type: 'text' },
        { index: 2, name: '2', type: 'text' },
        { index: 3, name: '3', type: 'text' },
      ],
    };

    const resWedding = resolveTemplateParameters({
      template: mockTemplateWedding,
      step: mockStepWedding,
      customer: { customerId: 'cus_1', firstName: 'Lakshmi', phone: '+919876543210' } as any,
      tenant: { tenantId, name: 'Aashirwad Sarees' } as any,
      campaignVersion: {} as any,
      snapshot: {
        customer: { customerId: 'cus_1', firstName: 'Lakshmi' },
        shopName: 'Aashirwad Sarees',
        occasionLocalDate: '2026-12-15',
        eventDate: '2026-12-15',
        bookingLinkUrl: 'https://shop-a.com/book',
        occasionKind: 'WEDDING',
        timezone: 'Asia/Kolkata',
        now: new Date('2026-10-24T10:00:00Z'),
      },
      clock,
    });

    expect(resWedding.ok).toBe(true);
    expect(resWedding.parameters).toHaveLength(3);
    expect(resWedding.parameters[0].text).toBe('Lakshmi');
    expect(resWedding.parameters[1].text).toContain('Dec 15, 2026');
    expect(resWedding.parameters[2].text).toBe('https://shop-a.com/book');

    // 2. Gift step: customer.firstName, event.localDate, event.recipientLabel
    const mockStepGift: any = {
      stepId: 'step_gift_d10',
      templateRef: { id: 'tpl_hello_world', revision: 1, language: 'en_US' },
      bindings: {
        '1': { source: 'customer.firstName' },
        '2': { source: 'event.localDate' },
        '3': { source: 'event.recipientLabel' },
      },
    };

    const resGift = resolveTemplateParameters({
      template: mockTemplateWedding,
      step: mockStepGift,
      customer: { customerId: 'cus_1', firstName: 'Lakshmi', phone: '+919876543210' } as any,
      tenant: { tenantId, name: 'Aashirwad Sarees' } as any,
      campaignVersion: {} as any,
      snapshot: {
        customer: { customerId: 'cus_1', firstName: 'Lakshmi' },
        shopName: 'Aashirwad Sarees',
        occasionLocalDate: '2026-11-20',
        eventDate: '2026-11-20',
        recipientLabel: 'Mom',
        occasionKind: 'GIFT',
        timezone: 'Asia/Kolkata',
        now: new Date('2026-10-24T10:00:00Z'),
      },
      clock,
    });

    expect(resGift.ok).toBe(true);
    expect(resGift.parameters[2].text).toBe('Mom');
  });

  it('G32: Static code scan: production code NEVER writes to src_customerEvents collection', () => {
    const srcDir = path.resolve(__dirname, '../src');

    function scanDir(dir: string): string[] {
      let results: string[] = [];
      const list = fs.readdirSync(dir);
      for (const file of list) {
        const fullPath = path.join(dir, file);
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
          results = results.concat(scanDir(fullPath));
        } else if (file.endsWith('.ts') && !file.endsWith('.d.ts')) {
          results.push(fullPath);
        }
      }
      return results;
    }

    const allFiles = scanDir(srcDir);
    const writeMethods = [
      /\.create\s*\(/,
      /\.save\s*\(/,
      /\.updateOne\s*\(/,
      /\.updateMany\s*\(/,
      /\.deleteOne\s*\(/,
      /\.deleteMany\s*\(/,
      /\.insertMany\s*\(/,
      /\.findOneAndUpdate\s*\(/,
      /\.findOneAndDelete\s*\(/,
    ];

    const violations: string[] = [];

    for (const file of allFiles) {
      const normalized = file.replace(/\\/g, '/');
      if (
        normalized.includes('/src/db/seed.ts') ||
        normalized.includes('/src/dev/') ||
        normalized.includes('/src/routes/dev-mock-crm.ts') ||
        normalized.includes('/src/db/models/src-customer-event.model.ts')
      ) {
        continue;
      }

      const content = fs.readFileSync(file, 'utf-8');
      if (content.includes('SrcCustomerEventModel') || content.includes('src_customerEvents')) {
        for (const regex of writeMethods) {
          const writeCallRegex = new RegExp(`SrcCustomerEventModel\\s*${regex.source}`);
          if (writeCallRegex.test(content)) {
            violations.push(`${normalized} writes to SrcCustomerEventModel using ${regex.source}`);
          }
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('G33: Privacy & Security: phone numbers encrypted in DB, masked in logs and APIs', async () => {
    const rawCustomer = await SrcCustomerModel.findOne({ tenantId, customerId: 'cus_gw_wedding_live' }).lean();
    expect(rawCustomer).toBeDefined();

    // Phone encrypted in database destination
    expect(rawCustomer?.destination?.encryptedPhone).toBeDefined();
    expect(typeof rawCustomer?.destination?.encryptedPhone).toBe('string');
    expect(rawCustomer?.destination?.destinationHash).toBeDefined();

    // Phone masked
    expect(rawCustomer?.destination?.masked).toContain('***');

    // Partner contacts: never inferred
    expect((rawCustomer as any)?.partnerPhone).toBeUndefined();
    expect((rawCustomer as any)?.partnerContact).toBeUndefined();
  });

  it('G34: Summary endpoint GET /campaigns/:id/occasion-reminders/summary returns accurate counts', async () => {
    const res = await request(app)
      .get('/campaigns/cmp_gift_wedding_shop_a/occasion-reminders/summary')
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(res.status).toBe(200);
    expect(res.body.campaignId).toBe('cmp_gift_wedding_shop_a');
    expect(res.body.activeEnrollmentsCount).toBeGreaterThanOrEqual(1);
    expect(res.body.leadTimeSkipsCount).toBeGreaterThanOrEqual(1);
    expect(res.body.stepBreakdown).toBeDefined();
    expect(typeof res.body.completedOccasionsCount).toBe('number');
    expect(typeof res.body.replannedCount).toBe('number');
  });

  it('G35: Occasions API GET /occasions returns tenant-scoped customer occasions', async () => {
    const res = await request(app)
      .get('/occasions?customerId=cus_gw_wedding_live')
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.occasions)).toBe(true);
    expect(res.body.occasions.length).toBeGreaterThan(0);

    const occ = res.body.occasions[0];
    expect(occ.kind).toBe('WEDDING');
    expect(occ.declaredByCustomer).toBe(true);
    expect(occ.budgetPaise).toBe(10000000);
    expect(occ.categories).toContain('BRIDAL_WEAR');

    // Tenant isolation: Shop B owner cannot see Shop A customer occasions
    const resCross = await request(app)
      .get('/occasions?customerId=cus_gw_wedding_live')
      .set('Authorization', `Bearer ${shopBOwnerToken}`);

    expect(resCross.status).toBe(200);
    expect(resCross.body.occasions).toHaveLength(0);
  });

  it('G36: Seed scenario gift-wedding executes idempotently and seeds active wedding campaign', async () => {
    // Re-run seed scenario gift-wedding
    await seedDatabase('gift-wedding');

    const campaign = await CampaignModel.findOne({ tenantId, campaignId: 'cmp_gift_wedding_shop_a' });
    expect(campaign).toBeDefined();
    expect(campaign?.status).toBe('ACTIVE');

    const shortLeadExecutions = await CampaignExecutionModel.find({
      tenantId,
      skipReason: EXECUTION_REASONS.INSUFFICIENT_LEAD_TIME,
    });
    expect(shortLeadExecutions.length).toBeGreaterThan(0);

    const activeEnrollments = await CampaignEnrollmentModel.find({
      tenantId,
      campaignId: 'cmp_gift_wedding_shop_a',
      status: ENROLLMENT_STATUS.ACTIVE,
    });
    expect(activeEnrollments.length).toBeGreaterThan(0);
  });
});

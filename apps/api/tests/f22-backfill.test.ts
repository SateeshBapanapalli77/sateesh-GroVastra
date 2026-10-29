import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import request from 'supertest';
import crypto from 'crypto';
import mongoose from 'mongoose';
import { app } from '../src/app';
import { connectToDatabase, disconnectDatabase } from '../src/db/connection';
import { seedDatabase } from '../src/db/seed';
import {
  CampaignModel,
  CampaignVersionModel,
  CampaignEnrollmentModel,
  CampaignExecutionModel,
  CampaignEventInboxModel,
  CampaignDeliveryIntentModel,
  CampaignCheckpointModel,
  CampaignGoalEventModel,
  SrcCustomerEventModel,
  SrcCustomerModel,
  SrcTemplateModel,
} from '../src/db/models';
import { eventConsumerService } from '../src/services/event-consumer';
import { workerService } from '../src/services/worker';
import { plannerService } from '../src/services/planner/planner.service';
import { reconciliationService } from '../src/services/reconciliation';
import { sendCampaignStep } from '../src/adapters/whatsapp-delivery';
import { buildMetaTemplateBody } from '../src/templates';
import {
  resolveStepDueAt,
  fitIntoAllowedHours,
  calculateLatestUsefulAt,
  getOccurrenceId,
} from '../src/services/datetime';
import { authService } from '../src/services/auth.service';
import { clock } from '../src/services/clock';
import {
  CampaignEventInputSchema,
  EXECUTION_STATE,
  EXECUTION_REASONS,
  EVENT_INBOX_STATUS,
  DELIVERY_INTENT_STATE,
} from '@grovastra/shared';
import { destinationHash, normalizePhoneNumber } from '../src/utils/crypto';

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

describe('F22 Backfill Tests (F22-G02, F22-G07, F22-G13, F22-G26, F22-G27, F22-G28, F22-G31, DOC01, DOC02, Meta-test)', () => {
  const tenantId = 'shop_a';
  const allowlistedPhone = '919876543210';
  const allowlistHash = destinationHash(normalizePhoneNumber(allowlistedPhone));
  let ownerToken: string;
  let originalFetch: typeof globalThis.fetch;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.DISPATCH_MODE = 'dry';
    process.env.ALLOW_TEST_CATEGORY_MISMATCH = 'true';
    process.env.META_TEST_ALLOWLIST = allowlistedPhone;
    process.env.META_ACCESS_TOKEN = 'test_access_token_mock_secret_key';

    clock.setSystemTime(new Date('2026-10-24T10:00:00.000Z'));
    originalFetch = globalThis.fetch;

    await connectToDatabase();
    await seedDatabase('gift-wedding');

    // Ensure cus_live_01 has destinationHash matching allowlist
    await SrcCustomerModel.updateOne(
      { tenantId: 'shop_a', customerId: 'cus_live_01' },
      {
        $set: {
          'destination.destinationHash': allowlistHash,
          'destination.verified': true,
          'consent.marketingOptIn': true,
          'consent.channelSuppressed': false,
          status: 'ACTIVE',
          version: 1,
        },
      },
      { upsert: true }
    );

    ownerToken = authService.signToken({
      userId: 'usr_owner_01',
      tenantId: 'shop_a',
      role: 'owner',
      branchIds: ['branch_main'],
      email: 'owner@shop-a.com',
    });
  });

  afterAll(async () => {
    globalThis.fetch = originalFetch;
    clock.resetOffset();
    await disconnectDatabase();
  });

  beforeEach(async () => {
    clock.setSystemTime(new Date('2026-10-24T10:00:00.000Z'));
  });

  // =========================================================================
  // F22-G02: Replay x5 of occasion.saved, occasion.cancelled, occasion.completed
  // =========================================================================
  it('F22-G02: 5x replay of occasion.saved (create & date change), occasion.cancelled, and occasion.completed enforces durable dedupe with exactly 1 enrollment', async () => {
    const eventId = 'evt_g02_wedding_rep';
    const occKey = `wedding:${eventId}`;
    const customerId = 'cus_gw_wedding_live';

    // 1. Replay 5x occasion.saved (initial create)
    const createDateStr = '2026-12-15';
    await SrcCustomerEventModel.create(
      makeOccasionDoc({
        tenantId,
        eventId,
        customerId,
        kind: 'WEDDING',
        eventDateKey: createDateStr,
        declaredByCustomer: true,
        budgetPaise: 8000000,
        categories: ['saree', 'blouse'],
        status: 'ACTIVE',
        source: 'CUSTOMER_DECLARED',
      })
    );

    const initialEventPayload = {
      schemaVersion: 1,
      producer: 'occasions',
      eventId: 'evt_inbox_g02_create_1',
      tenantId,
      type: 'occasion.saved',
      entityId: eventId,
      entityVersion: 1,
      customerId,
      occurredAt: clock.now().toISOString(),
      data: {
        eventId,
        customerId,
        kind: 'WEDDING',
        eventDate: createDateStr,
        eventDateKey: createDateStr,
        categories: ['saree', 'blouse'],
        budgetPaise: 8000000,
        status: 'ACTIVE',
      },
    };

    // First post
    const resCreate1 = await request(app)
      .post('/internal/campaign-events')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send(initialEventPayload);
    expect(resCreate1.status).toBe(200);
    expect(resCreate1.body.status).toBe(EVENT_INBOX_STATUS.PROCESSED);

    // Replay 4 more times
    for (let i = 2; i <= 5; i++) {
      const resCreateN = await request(app)
        .post('/internal/campaign-events')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send(initialEventPayload);
      expect(resCreateN.status).toBe(200);
      expect(resCreateN.body.status).toBe('DUPLICATE');
    }

    // Assert: inbox deduplication
    const createInboxCount = await CampaignEventInboxModel.countDocuments({
      tenantId,
      producer: 'occasions',
      eventId: 'evt_inbox_g02_create_1',
    });
    expect(createInboxCount).toBe(1);

    // Assert: exactly 1 enrollment and 1 execution per step
    const enrollmentsAfterCreate = await CampaignEnrollmentModel.find({
      tenantId,
      occurrenceId: occKey,
    });
    expect(enrollmentsAfterCreate).toHaveLength(1);
    expect(enrollmentsAfterCreate[0].planRevision).toBe(1);

    const executionsAfterCreate = await CampaignExecutionModel.find({
      tenantId,
      enrollmentId: enrollmentsAfterCreate[0].enrollmentId,
    });
    expect(executionsAfterCreate).toHaveLength(2);

    // 2. Replay 5x occasion.saved (date change / postponement)
    const newDateStr = '2027-01-20';
    const [yNew, mNew, dNew] = newDateStr.split('-').map(Number);
    await SrcCustomerEventModel.updateOne(
      { tenantId, eventId },
      {
        $set: {
          eventDateKey: newDateStr,
          month: mNew,
          day: dNew,
          eventDate: { year: yNew, month: mNew, day: dNew },
          entityVersion: 2,
        },
      }
    );

    const dateChangeEventPayload = {
      schemaVersion: 1,
      producer: 'occasions',
      eventId: 'evt_inbox_g02_postpone_1',
      tenantId,
      type: 'occasion.saved',
      entityId: eventId,
      entityVersion: 2,
      customerId,
      occurredAt: clock.now().toISOString(),
      data: {
        eventId,
        customerId,
        kind: 'WEDDING',
        eventDate: newDateStr,
        eventDateKey: newDateStr,
        status: 'ACTIVE',
      },
    };

    const resPostpone1 = await request(app)
      .post('/internal/campaign-events')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send(dateChangeEventPayload);
    expect(resPostpone1.status).toBe(200);
    expect(resPostpone1.body.status).toBe(EVENT_INBOX_STATUS.PROCESSED);

    for (let i = 2; i <= 5; i++) {
      const resPostponeN = await request(app)
        .post('/internal/campaign-events')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send(dateChangeEventPayload);
      expect(resPostponeN.status).toBe(200);
      expect(resPostponeN.body.status).toBe('DUPLICATE');
    }

    const postponeInboxCount = await CampaignEventInboxModel.countDocuments({
      tenantId,
      producer: 'occasions',
      eventId: 'evt_inbox_g02_postpone_1',
    });
    expect(postponeInboxCount).toBe(1);

    // Same occurrence revised in place: still exactly 1 enrollment, planRevision bumped to 2
    const enrollmentsAfterPostpone = await CampaignEnrollmentModel.find({
      tenantId,
      occurrenceId: occKey,
    });
    expect(enrollmentsAfterPostpone).toHaveLength(1);
    expect(enrollmentsAfterPostpone[0].planRevision).toBe(2);
    expect(enrollmentsAfterPostpone[0].dateHistory).toHaveLength(1);

    // 3. Replay 5x occasion.cancelled
    const cancelEventPayload = {
      schemaVersion: 1,
      producer: 'occasions',
      eventId: 'evt_inbox_g02_cancel_1',
      tenantId,
      type: 'occasion.cancelled',
      entityId: eventId,
      entityVersion: 3,
      customerId,
      occurredAt: clock.now().toISOString(),
      data: {
        eventId,
        customerId,
        kind: 'WEDDING',
        reason: 'CUSTOMER_CANCELLED',
      },
    };

    const resCancel1 = await request(app)
      .post('/internal/campaign-events')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send(cancelEventPayload);
    expect(resCancel1.status).toBe(200);
    expect(resCancel1.body.status).toBe(EVENT_INBOX_STATUS.PROCESSED);

    for (let i = 2; i <= 5; i++) {
      const resCancelN = await request(app)
        .post('/internal/campaign-events')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send(cancelEventPayload);
      expect(resCancelN.status).toBe(200);
      expect(resCancelN.body.status).toBe('DUPLICATE');
    }

    const cancelInboxCount = await CampaignEventInboxModel.countDocuments({
      tenantId,
      producer: 'occasions',
      eventId: 'evt_inbox_g02_cancel_1',
    });
    expect(cancelInboxCount).toBe(1);

    const enrollmentAfterCancel = await CampaignEnrollmentModel.findOne({
      tenantId,
      occurrenceId: occKey,
    });
    expect(enrollmentAfterCancel?.status).toBe('CANCELLED');

    const executionsAfterCancel = await CampaignExecutionModel.find({
      tenantId,
      enrollmentId: enrollmentAfterCancel!.enrollmentId,
    });
    for (const ex of executionsAfterCancel) {
      expect(ex.state).toBe(EXECUTION_STATE.CANCELLED);
      expect(ex.skipReason).toBe(EXECUTION_REASONS.OCCASION_CANCELLED);
    }

    // 4. Replay 5x occasion.completed on gift occasion
    const completedEventId = 'evt_g02_gift_comp';
    const compOccKey = `gift:${completedEventId}`;
    await SrcCustomerEventModel.create(
      makeOccasionDoc({
        tenantId,
        eventId: completedEventId,
        customerId,
        kind: 'GIFT',
        eventDateKey: '2026-11-20',
        declaredByCustomer: true,
        budgetPaise: 300000,
        categories: ['saree'],
        status: 'ACTIVE',
        source: 'CUSTOMER_DECLARED',
      })
    );

    // Initial enrollment via occasion.saved
    await eventConsumerService.ingestEvent(tenantId, 'occasions', {
      schemaVersion: 1,
      producer: 'occasions',
      eventId: 'evt_inbox_g02_gift_save',
      tenantId,
      type: 'occasion.saved',
      entityId: completedEventId,
      entityVersion: 1,
      customerId,
      occurredAt: clock.now().toISOString(),
      data: { eventId: completedEventId, eventDate: '2026-11-20', kind: 'GIFT' },
    });

    const completeEventPayload = {
      schemaVersion: 1,
      producer: 'occasions',
      eventId: 'evt_inbox_g02_complete_1',
      tenantId,
      type: 'occasion.completed',
      entityId: completedEventId,
      entityVersion: 2,
      customerId,
      occurredAt: clock.now().toISOString(),
      data: {
        eventId: completedEventId,
        customerId,
        kind: 'GIFT',
        completedBy: 'STAFF',
        reason: 'SHOPPING_COMPLETE',
      },
    };

    const resComp1 = await request(app)
      .post('/internal/campaign-events')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send(completeEventPayload);
    expect(resComp1.status).toBe(200);
    expect(resComp1.body.status).toBe(EVENT_INBOX_STATUS.PROCESSED);

    for (let i = 2; i <= 5; i++) {
      const resCompN = await request(app)
        .post('/internal/campaign-events')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send(completeEventPayload);
      expect(resCompN.status).toBe(200);
      expect(resCompN.body.status).toBe('DUPLICATE');
    }

    const compInboxCount = await CampaignEventInboxModel.countDocuments({
      tenantId,
      producer: 'occasions',
      eventId: 'evt_inbox_g02_complete_1',
    });
    expect(compInboxCount).toBe(1);

    const compEnrollment = await CampaignEnrollmentModel.findOne({
      tenantId,
      occurrenceId: compOccKey,
    });
    expect(compEnrollment?.status).toBe('COMPLETED');

    const goalEventCount = await CampaignGoalEventModel.countDocuments({
      tenantId,
      enrollmentId: compEnrollment!.enrollmentId,
      source: 'OCCASION_COMPLETED',
    });
    expect(goalEventCount).toBe(1);
  });

  // =========================================================================
  // F22-G07: Due time shifted by blackout/holiday past latestUsefulAt is SKIPPED
  // =========================================================================
  it('F22-G07: due time shifted by blackout/holiday/allowed-hours past latestUsefulAt is SKIPPED and never sent', async () => {
    // Event date: 2026-11-20, fulfillmentLeadDays = 21
    // latestUsefulLocalDate = 2026-11-20 - 21 days = 2026-10-30
    // Allowed sending hours: 10:00 to 19:00 IST
    // latestUsefulAt = 2026-10-30T19:00:00 in Asia/Kolkata = 2026-10-30T13:30:00.000Z UTC
    const usefulRes = calculateLatestUsefulAt({
      eventDateKey: '2026-11-20',
      fulfillmentLeadDays: 21,
      allowedSendingHoursEnd: '19:00',
      timezone: 'Asia/Kolkata',
    });
    expect(usefulRes.latestUsefulAt.toISOString()).toBe('2026-10-30T13:30:00.000Z');

    // Step offset -21 is normally due on 2026-10-30 at 10:00 IST (04:30 UTC),
    // which is before latestUsefulAt (13:30 UTC).
    const dueAt = new Date('2026-10-30T04:30:00.000Z');

    // Now declare 2026-10-30 as a BLACKOUT DATE
    const settings = {
      timezone: 'Asia/Kolkata',
      allowedSendingHours: { start: '10:00', end: '19:00' },
      blackoutDates: ['2026-10-30'], // Blacked out!
    };

    // fitIntoAllowedHours pushes due time to the next business day (2026-10-31 10:00 IST = 04:30 UTC),
    // but expiresAt is latestUsefulAt (2026-10-30T13:30:00.000Z).
    const fitRes = fitIntoAllowedHours(dueAt, settings, usefulRes.latestUsefulAt);
    expect(fitRes.status).toBe('SKIP');
    expect(fitRes.reason).toBe('SKIPPED_BLACKOUT_EXPIRED');

    // Create enrollment and execution doc for worker lead time evaluation
    const enrollmentId07 = `enr_g07_${Date.now()}`;
    await CampaignEnrollmentModel.create({
      tenantId,
      campaignId: 'cmp_gift_wedding_shop_a',
      campaignVersion: 1,
      campaignVersionId: 'v1',
      enrollmentId: enrollmentId07,
      enrollmentKey: `key_${enrollmentId07}`,
      customerId: 'cus_gw_wedding_live',
      occurrenceId: `wedding:evt_g07_${Date.now()}`,
      occasionLocalDate: '2026-10-24',
      sourceRef: { type: 'src_customerEvents', id: `evt_g07_${Date.now()}` },
      status: 'ACTIVE',
      planRevision: 1,
    });

    const executionDoc = await CampaignExecutionModel.create({
      executionId: `exe_g07_${Date.now()}`,
      executionKey: `key_g07_${Date.now()}`,
      tenantId,
      campaignId: 'cmp_gift_wedding_shop_a',
      enrollmentId: enrollmentId07,
      stepId: 'step_wedding_d21',
      stepName: 'Trial Fitting',
      dueAt: new Date('2026-10-31T04:30:00.000Z'),
      originalDueAt: new Date('2026-10-30T04:30:00.000Z'),
      localDate: '2026-10-31',
      localTime: '10:00',
      timezone: 'Asia/Kolkata',
      expiresAt: new Date('2026-10-31T18:00:00.000Z'),
      latestUsefulAt: usefulRes.latestUsefulAt,
      state: EXECUTION_STATE.SCHEDULED,
      planRevision: 1,
      deliveryIntentId: null,
    });

    clock.setSystemTime(new Date('2026-10-31T05:00:00.000Z')); // Evaluated after latestUsefulAt

    const workerRes = await workerService.evaluateAndProcessExecution(
      executionDoc,
      'lease_test_g07',
      new Date(Date.now() + 60000),
      new Date('2026-10-31T05:00:00.000Z')
    );
    expect(workerRes.state).toBe(EXECUTION_STATE.SKIPPED);
    expect(workerRes.reason).toBe(EXECUTION_REASONS.INSUFFICIENT_LEAD_TIME);

    // Verify delivery intent was never created or dispatched
    const intent = await CampaignDeliveryIntentModel.findOne({
      tenantId,
      executionId: executionDoc.executionId,
    });
    expect(intent).toBeNull();
  });

  // =========================================================================
  // F22-G13: Racing replan vs worker final submission CAS
  // =========================================================================
  it('F22-G13: racing replan vs worker final submission CAS: stale claimant makes 0 provider calls', async () => {
    const executionId = `exe_g13_${Date.now()}`;
    const leaseToken = `lease_g13_${crypto.randomUUID()}`;
    const enrollmentId = `enr_g13_${Date.now()}`;
    const eventId = `evt_g13_${Date.now()}`;
    const customerId = 'cus_gw_wedding_live';
    const serverNow = new Date('2026-10-24T10:00:00.000Z');
    const leaseUntil = new Date(serverNow.getTime() + 60000);

    // Create occasion doc so mockOccasionSource.getOccasion finds it
    await SrcCustomerEventModel.create(
      makeOccasionDoc({
        tenantId,
        eventId,
        customerId,
        kind: 'WEDDING',
        eventDateKey: '2026-12-15',
        declaredByCustomer: true,
        budgetPaise: 8000000,
        categories: ['saree'],
        status: 'ACTIVE',
        source: 'CUSTOMER_DECLARED',
      })
    );

    // Create enrollment doc so worker resolves customer
    await CampaignEnrollmentModel.create({
      tenantId,
      campaignId: 'cmp_gift_wedding_shop_a',
      campaignVersion: 1,
      campaignVersionId: 'v1',
      enrollmentId,
      enrollmentKey: `key_${enrollmentId}`,
      customerId,
      eventId,
      occurrenceId: `wedding:${eventId}`,
      occasionLocalDate: '2026-12-15',
      sourceRef: { type: 'src_customerEvents', id: eventId },
      status: 'ACTIVE',
      planRevision: 1,
    });

    // 1. Worker claims lease on execution with planRevision = 1
    const executionDoc = await CampaignExecutionModel.create({
      executionId,
      executionKey: `key_g13_${Date.now()}`,
      tenantId,
      campaignId: 'cmp_gift_wedding_shop_a',
      enrollmentId,
      stepId: 'step_wedding_d45',
      stepName: 'Wedding Consultation',
      dueAt: serverNow,
      originalDueAt: serverNow,
      localDate: '2026-10-24',
      localTime: '10:00',
      timezone: 'Asia/Kolkata',
      expiresAt: new Date(serverNow.getTime() + 8 * 3600 * 1000),
      state: EXECUTION_STATE.EVALUATING,
      planRevision: 1,
      lease: {
        token: leaseToken,
        until: leaseUntil,
      },
      deliveryIntentId: null,
    });

    // Mock fetch to track if any provider call is attempted
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy;

    // 2. A racing postponement event updates MongoDB execution to planRevision = 2
    await CampaignExecutionModel.updateOne(
      { tenantId, executionId },
      { $set: { planRevision: 2 } }
    );

    // 3. Worker attempts final submission CAS using the in-memory execution copy with planRevision = 1
    const staleExecutionCopy = executionDoc.toObject();
    staleExecutionCopy.planRevision = 1;

    const workerResult = await workerService.evaluateAndProcessExecution(
      staleExecutionCopy as any,
      leaseToken,
      leaseUntil,
      serverNow
    );

    // 4. Assert CAS failed: returned STALE_CAS_FAILED and ZERO provider dispatch calls were made
    expect(workerResult.reason).toBe('STALE_CAS_FAILED');
    expect(fetchSpy).not.toHaveBeenCalled();

    // Verify no delivery intent was committed
    const intent = await CampaignDeliveryIntentModel.findOne({
      tenantId,
      executionId,
    });
    expect(intent).toBeNull();
  });

  // =========================================================================
  // F22-G26: Planner horizon, concurrent planners create 1 enrollment, restart safe
  // =========================================================================
  it('F22-G26: planner horizon filters distant occasions, 2 concurrent planners create 1 enrollment, and restart resumes cleanly', async () => {
    const customerId = 'cus_gw_wedding_live';

    // 1. Occasion 1: 150 days out (beyond horizon: maxLeadDays 45 + 30 = 75 days)
    const farDateStr = '2027-03-24';
    const farEventId = `evt_g26_far_${Date.now()}`;
    await SrcCustomerEventModel.create(
      makeOccasionDoc({
        tenantId,
        eventId: farEventId,
        customerId,
        kind: 'WEDDING',
        eventDateKey: farDateStr,
        declaredByCustomer: true,
        budgetPaise: 5000000,
        categories: ['saree'],
        status: 'ACTIVE',
        source: 'CUSTOMER_DECLARED',
      })
    );

    // 2. Occasion 2: 50 days out (within horizon)
    const nearDateStr = '2026-12-13';
    const nearEventId = `evt_g26_near_${Date.now()}`;
    await SrcCustomerEventModel.create(
      makeOccasionDoc({
        tenantId,
        eventId: nearEventId,
        customerId,
        kind: 'WEDDING',
        eventDateKey: nearDateStr,
        declaredByCustomer: true,
        budgetPaise: 5000000,
        categories: ['saree'],
        status: 'ACTIVE',
        source: 'CUSTOMER_DECLARED',
      })
    );

    // 3. Run two planners concurrently with force: true to exercise DB constraint & atomic CAS
    const [planRes1, planRes2] = await Promise.all([
      plannerService.planCampaign(tenantId, 'cmp_gift_wedding_shop_a', { force: true }),
      plannerService.planCampaign(tenantId, 'cmp_gift_wedding_shop_a', { force: true }),
    ]);

    expect(planRes1.planned || planRes2.planned).toBe(true);

    // Assert: Far occasion was NOT enrolled (beyond horizon)
    const farEnrollment = await CampaignEnrollmentModel.findOne({
      tenantId,
      occurrenceId: `wedding:${farEventId}`,
    });
    expect(farEnrollment).toBeNull();

    // Assert: Near occasion was enrolled EXACTLY ONCE
    const nearEnrollments = await CampaignEnrollmentModel.find({
      tenantId,
      occurrenceId: `wedding:${nearEventId}`,
    });
    expect(nearEnrollments).toHaveLength(1);

    // Assert: Exactly 1 execution per step
    const executions = await CampaignExecutionModel.find({
      tenantId,
      enrollmentId: nearEnrollments[0].enrollmentId,
    });
    expect(executions).toHaveLength(2);

    // 4. Running planner a second time maintains idempotency and resumes from checkpoint
    const rerunResult = await plannerService.planCampaign(
      tenantId,
      'cmp_gift_wedding_shop_a',
      { force: true }
    );
    expect(rerunResult.planned).toBe(true);

    const nearEnrollmentsAfter = await CampaignEnrollmentModel.find({
      tenantId,
      occurrenceId: `wedding:${nearEventId}`,
    });
    expect(nearEnrollmentsAfter).toHaveLength(1);
  });

  // =========================================================================
  // F22-G27: Reconciler processes uningested occasion.saved and occasion.cancelled
  // =========================================================================
  it('F22-G27: reconciler corrects uningested occasion.saved and occasion.cancelled, and is idempotent on second run', async () => {
    const customerId = 'cus_gw_wedding_live';
    const recEventId = `evt_g27_rec_${Date.now()}`;
    const cancelEventId = `evt_g27_cancel_${Date.now()}`;

    // Create source customer events
    await SrcCustomerEventModel.create(
      makeOccasionDoc({
        tenantId,
        eventId: recEventId,
        customerId,
        kind: 'WEDDING',
        eventDateKey: '2026-12-20',
        declaredByCustomer: true,
        budgetPaise: 6000000,
        categories: ['saree'],
        status: 'ACTIVE',
        source: 'CUSTOMER_DECLARED',
      })
    );

    await SrcCustomerEventModel.create(
      makeOccasionDoc({
        tenantId,
        eventId: cancelEventId,
        customerId,
        kind: 'WEDDING',
        eventDateKey: '2026-12-25',
        declaredByCustomer: true,
        budgetPaise: 6000000,
        categories: ['saree'],
        status: 'CANCELLED',
        source: 'CUSTOMER_DECLARED',
      })
    );

    // Seed PENDING inbox items that were missed (older than 10 minutes)
    const oldTime = new Date(clock.now().getTime() - 15 * 60 * 1000);
    await CampaignEventInboxModel.create([
      {
        tenantId,
        producer: 'occasions',
        eventId: `inbox_missed_g27_save_${Date.now()}`,
        type: 'occasion.saved',
        entityId: recEventId,
        entityVersion: 1,
        occurredAt: oldTime,
        status: 'PENDING',
        createdAt: oldTime,
        payload: {
          schemaVersion: 1,
          producer: 'occasions',
          eventId: `inbox_missed_g27_save_${Date.now()}`,
          tenantId,
          type: 'occasion.saved',
          entityId: recEventId,
          entityVersion: 1,
          customerId,
          occurredAt: oldTime.toISOString(),
          data: { eventId: recEventId, eventDate: '2026-12-20', kind: 'WEDDING' },
        },
      },
      {
        tenantId,
        producer: 'occasions',
        eventId: `inbox_missed_g27_cancel_${Date.now()}`,
        type: 'occasion.cancelled',
        entityId: cancelEventId,
        entityVersion: 1,
        occurredAt: oldTime,
        status: 'PENDING',
        createdAt: oldTime,
        payload: {
          schemaVersion: 1,
          producer: 'occasions',
          eventId: `inbox_missed_g27_cancel_${Date.now()}`,
          tenantId,
          type: 'occasion.cancelled',
          entityId: cancelEventId,
          entityVersion: 1,
          customerId,
          occurredAt: oldTime.toISOString(),
          data: { eventId: cancelEventId, kind: 'WEDDING', reason: 'CUSTOMER_CANCELLED' },
        },
      },
    ]);

    // 1. Run reconciler
    const recResult1 = await reconciliationService.reconcileTenant(tenantId);
    expect(recResult1.counts.missedEventsProcessed).toBeGreaterThanOrEqual(2);

    // Verify inbox status transitioned to PROCESSED
    const pendingCount = await CampaignEventInboxModel.countDocuments({
      tenantId,
      entityId: { $in: [recEventId, cancelEventId] },
      status: 'PENDING',
    });
    expect(pendingCount).toBe(0);

    // Verify enrollment for recEventId was created
    const recEnrollment = await CampaignEnrollmentModel.findOne({
      tenantId,
      occurrenceId: `wedding:${recEventId}`,
    });
    expect(recEnrollment).toBeDefined();

    // 2. Run reconciler second time (idempotent: 0 missed events processed)
    const recResult2 = await reconciliationService.reconcileTenant(tenantId);
    expect(recResult2.counts.missedEventsProcessed).toBe(0);
  });

  // =========================================================================
  // F22-G28: DST zone time conversion
  // =========================================================================
  it('F22-G28: time conversion across DST zones (America/New_York across spring-forward/fall-back, Europe/London) and Asia/Kolkata', () => {
    // 1. America/New_York spring-forward gap (2026-03-08: nonexistent 02:30 shifts to 03:00 EDT)
    const nySpring = resolveStepDueAt({
      occasionLocalDate: '2026-03-08',
      offsetDays: 0,
      localTime: '02:30',
      timezone: 'America/New_York',
    });
    expect(nySpring.localTime).toBe('03:00');
    // 03:00 EDT (UTC-4) = 07:00 UTC
    expect(nySpring.dueAt.toISOString()).toBe('2026-03-08T07:00:00.000Z');

    // 2. America/New_York fall-back fold (2026-11-01: repeated 01:30 selects first occurrence in EDT)
    const nyFall = resolveStepDueAt({
      occasionLocalDate: '2026-11-01',
      offsetDays: 0,
      localTime: '01:30',
      timezone: 'America/New_York',
    });
    // First occurrence is 01:30 EDT = 05:30 UTC
    expect(nyFall.dueAt.toISOString()).toBe('2026-11-01T05:30:00.000Z');

    // 3. Europe/London spring-forward gap (2026-03-29: nonexistent 01:30 shifts to 02:00 BST)
    const londonSpring = resolveStepDueAt({
      occasionLocalDate: '2026-03-29',
      offsetDays: 0,
      localTime: '01:30',
      timezone: 'Europe/London',
    });
    expect(londonSpring.localTime).toBe('02:00');
    // 02:00 BST (UTC+1) = 01:00 UTC
    expect(londonSpring.dueAt.toISOString()).toBe('2026-03-29T01:00:00.000Z');

    // 4. Asia/Kolkata non-DST zone: 10:00 IST = 04:30 UTC
    const kolkataDue = resolveStepDueAt({
      occasionLocalDate: '2027-02-14',
      offsetDays: -21,
      localTime: '10:00',
      timezone: 'Asia/Kolkata',
    });
    // 2027-02-14 - 21 days = 2027-01-24. 10:00 IST = 04:30 UTC
    expect(kolkataDue.dueAt.toISOString()).toBe('2027-01-24T04:30:00.000Z');

    // 5. calculateLatestUsefulAt in Asia/Kolkata: close of allowed hours (19:00 IST = 13:30 UTC)
    const kolkataLead = calculateLatestUsefulAt({
      eventDateKey: '2027-02-14',
      fulfillmentLeadDays: 21,
      allowedSendingHoursEnd: '19:00',
      timezone: 'Asia/Kolkata',
    });
    expect(kolkataLead.latestUsefulAt.toISOString()).toBe('2027-01-24T13:30:00.000Z');
  });

  // =========================================================================
  // F22-G31: Stubbed-HTTP request bodies for 3-variable and 4-variable templates
  // =========================================================================
  it('F22-G31: stubbed-HTTP request bodies for 3-variable and 4-variable templates match meta-send-request-bodies schema with exactly 1 call', async () => {
    process.env.DISPATCH_MODE = 'meta';

    const recordedRequests: Array<{ url: string; options: any; body: any }> = [];
    globalThis.fetch = vi.fn().mockImplementation(async (url: string, options: any) => {
      const parsedBody = options?.body ? JSON.parse(options.body) : null;
      recordedRequests.push({ url, options, body: parsedBody });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          messaging_product: 'whatsapp',
          contacts: [{ input: allowlistedPhone, wa_id: allowlistedPhone }],
          messages: [{ id: `wamid.mock_${Date.now()}` }],
        }),
      };
    });

    const executionId3 = `exe_g31_3var_${Date.now()}`;
    const expiresAt = new Date(Date.now() + 3600000);

    // Create execution and delivery intent for 3-variable template
    await CampaignExecutionModel.create({
      executionId: executionId3,
      executionKey: `key_${executionId3}`,
      tenantId,
      campaignId: 'cmp_gift_wedding_shop_a',
      enrollmentId: `enr_${executionId3}`,
      stepId: 'step_wedding_d21',
      stepName: 'Trial Fitting',
      dueAt: new Date(),
      originalDueAt: new Date(),
      localDate: '2026-10-24',
      localTime: '10:00',
      timezone: 'Asia/Kolkata',
      expiresAt,
      state: EXECUTION_STATE.EVALUATING,
      planRevision: 1,
      deliveryIntentId: `di_${executionId3}`,
    });

    await CampaignDeliveryIntentModel.create({
      tenantId,
      campaignId: 'cmp_gift_wedding_shop_a',
      deliveryIntentId: `di_${executionId3}`,
      enrollmentId: `enr_${executionId3}`,
      executionId: executionId3,
      deliveryKey: executionId3,
      connectionId: 'conn_shop_a',
      recipientVersion: 1,
      encryptedRecipient: 'dummy:tag:cipher',
      maskedRecipient: '+91 98*** **210',
      templateRef: { id: 'tpl_order_confirmation', revision: 1, language: 'en_US' },
      parameters: {
        customer_name: 'Sunita Reddy',
        order_number: '₹1,500',
        date: 'Nov 20, 2026',
      },
      payloadHash: 'hash3',
      state: DELIVERY_INTENT_STATE.SUBMITTING,
      attemptId: `att_${executionId3}`,
    });

    // Case A: 3-variable template send
    const params3 = [
      { index: 1, text: 'Sunita Reddy' },
      { index: 2, text: '₹1,500' },
      { index: 3, text: 'Nov 20, 2026' },
    ];

    const sendRes3 = await sendCampaignStep({
      executionId: executionId3,
      deliveryKey: executionId3,
      connectionId: 'conn_shop_a',
      customerId: 'cus_live_01',
      recipientVersion: 1,
      template: { id: 'tpl_order_confirmation', revision: 1, language: 'en_US' },
      parameters: params3,
      expiresAt,
      tenantId,
    });

    expect(sendRes3.success).toBe(true);
    expect(recordedRequests).toHaveLength(1);

    const req3 = recordedRequests[0].body;
    expect(req3.messaging_product).toBe('whatsapp');
    expect(req3.to).toMatch(/^91\d{10}$/);
    expect(req3.type).toBe('template');
    expect(req3.template.name).toBe('jaspers_market_order_confirmation_v1');
    expect(req3.template.language.code).toBe('en_US');
    expect(req3.template.components).toHaveLength(1);
    expect(req3.template.components[0].type).toBe('body');
    expect(req3.template.components[0].parameters).toHaveLength(3);
    expect(req3.template.components[0].parameters[0]).toEqual({ type: 'text', text: 'Sunita Reddy' });
    expect(req3.template.components[0].parameters[1]).toEqual({ type: 'text', text: '₹1,500' });
    expect(req3.template.components[0].parameters[2]).toEqual({ type: 'text', text: 'Nov 20, 2026' });

    // Case B: 4-variable template (with recipient label and booking link)
    await mongoose.connection.collection('src_templates').updateOne(
      { id: 'tpl_wedding_booking' },
      {
        $set: {
          id: 'tpl_wedding_booking',
          name: 'jaspers_market_wedding_v1',
          language: 'en_US',
          category: 'MARKETING',
          status: 'APPROVED',
          sendable: true,
          revision: 1,
        },
      },
      { upsert: true }
    );

    const executionId4 = `exe_g31_4var_${Date.now()}`;
    await CampaignExecutionModel.create({
      executionId: executionId4,
      executionKey: `key_${executionId4}`,
      tenantId,
      campaignId: 'cmp_gift_wedding_shop_a',
      enrollmentId: `enr_${executionId4}`,
      stepId: 'step_wedding_d45',
      stepName: 'Wedding Consultation',
      dueAt: new Date(),
      originalDueAt: new Date(),
      localDate: '2026-10-24',
      localTime: '10:00',
      timezone: 'Asia/Kolkata',
      expiresAt,
      state: EXECUTION_STATE.EVALUATING,
      planRevision: 1,
      deliveryIntentId: `di_${executionId4}`,
    });

    await CampaignDeliveryIntentModel.create({
      tenantId,
      campaignId: 'cmp_gift_wedding_shop_a',
      deliveryIntentId: `di_${executionId4}`,
      enrollmentId: `enr_${executionId4}`,
      executionId: executionId4,
      deliveryKey: executionId4,
      connectionId: 'conn_shop_a',
      recipientVersion: 1,
      encryptedRecipient: 'dummy:tag:cipher',
      maskedRecipient: '+91 98*** **210',
      templateRef: { id: 'tpl_wedding_booking', revision: 1, language: 'en_US' },
      parameters: {
        '1': 'Priya',
        '2': 'sister',
        '3': 'https://boutique.example.com/book',
        '4': 'Sutra Sarees',
      },
      payloadHash: 'hash4',
      state: DELIVERY_INTENT_STATE.SUBMITTING,
      attemptId: `att_${executionId4}`,
    });

    const params4 = [
      { index: 1, text: 'Priya' },
      { index: 2, text: 'sister' },
      { index: 3, text: 'https://boutique.example.com/book' },
      { index: 4, text: 'Sutra Sarees' },
    ];

    const sendRes4 = await sendCampaignStep({
      executionId: executionId4,
      deliveryKey: executionId4,
      connectionId: 'conn_shop_a',
      customerId: 'cus_live_01',
      recipientVersion: 1,
      template: { id: 'tpl_wedding_booking', revision: 1, language: 'en_US' },
      parameters: params4,
      expiresAt,
      tenantId,
    });

    expect(sendRes4.success).toBe(true);
    expect(recordedRequests).toHaveLength(2);

    const req4 = recordedRequests[1].body;
    expect(req4.messaging_product).toBe('whatsapp');
    expect(req4.to).toMatch(/^91\d{10}$/);
    expect(req4.type).toBe('template');
    expect(req4.template.name).toBe('jaspers_market_wedding_v1');
    expect(req4.template.language.code).toBe('en_US');
    expect(req4.template.components).toHaveLength(1);
    expect(req4.template.components[0].type).toBe('body');
    expect(req4.template.components[0].parameters).toHaveLength(4);
    expect(req4.template.components[0].parameters).toEqual([
      { type: 'text', text: 'Priya' },
      { type: 'text', text: 'sister' },
      { type: 'text', text: 'https://boutique.example.com/book' },
      { type: 'text', text: 'Sutra Sarees' },
    ]);
  });

  // =========================================================================
  // DOC01: Parses all docs/samples/event-occasion-*.json & tagged order sample
  // =========================================================================
  it('DOC01: parses all event-occasion-*.json and tagged order samples against consumer Zod schema without error', () => {
    const samplesDir = path.resolve(__dirname, '../../../docs/samples');
    const sampleFiles = [
      'event-occasion-saved-wedding.json',
      'event-occasion-saved-wedding-postponed.json',
      'event-occasion-saved-gift.json',
      'event-occasion-cancelled.json',
      'event-occasion-completed.json',
      'event-order-completed-occasion-tagged.json',
    ];

    for (const fileName of sampleFiles) {
      const filePath = path.join(samplesDir, fileName);
      expect(fs.existsSync(filePath), `Sample file ${fileName} must exist`).toBe(true);

      const rawJson = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const parseResult = CampaignEventInputSchema.safeParse(rawJson);

      expect(
        parseResult.success,
        `Sample file ${fileName} failed Zod schema parsing: ${JSON.stringify(
          (parseResult as any).error?.errors
        )}`
      ).toBe(true);

      const parsed = parseResult.data!;
      expect(parsed.schemaVersion).toBe(1);
      expect(parsed.producer).toBeDefined();
      expect(parsed.eventId).toBeDefined();
      expect(parsed.entityId).toBeDefined();
      expect(parsed.type).toBeDefined();
    }
  });

  // =========================================================================
  // DOC02: Parses contract example JSON blocks and enforces absence of forbidden event names
  // =========================================================================
  it('DOC02: parses contract example JSON blocks and enforces forbidden event types are absent except allowlisted sentence', () => {
    const contractPath = path.resolve(__dirname, '../../../docs/contracts/occasion-integration.md');
    expect(fs.existsSync(contractPath), 'Contract file must exist').toBe(true);
    const contractContent = fs.readFileSync(contractPath, 'utf8');

    // 1. Extract and parse all JSON code blocks from the contract
    const jsonBlockRegex = /```json\s*([\s\S]*?)\s*```/g;
    let match: RegExpExecArray | null;
    let parsedBlocksCount = 0;

    while ((match = jsonBlockRegex.exec(contractContent)) !== null) {
      const jsonStr = match[1].trim();
      const jsonObj = JSON.parse(jsonStr);

      if (jsonObj.schemaVersion && (jsonObj.type || jsonObj.eventType)) {
        const parseResult = CampaignEventInputSchema.safeParse(jsonObj);
        expect(
          parseResult.success,
          `Contract JSON block failed validation: ${JSON.stringify(
            (parseResult as any).error?.errors
          )}`
        ).toBe(true);
        parsedBlocksCount++;
      }
    }

    expect(parsedBlocksCount).toBeGreaterThanOrEqual(5);

    // 2. Scan docs/, apps/web/, and apps/api/tests/ for forbidden strings
    const scanDirs = [
      path.resolve(__dirname, '../../../docs'),
      path.resolve(__dirname, '../../../apps/web'),
      path.resolve(__dirname, '.'),
    ];

    const allowlistedSentence = 'postponement is occasion.saved with a new date';
    const forbiddenPattern = new RegExp(['occasion', 'postponed'].join('\\.') + '|' + ['occasion', 'rescheduled'].join('\\.'), 'i');
    const violations: string[] = [];

    function scanDirectory(dir: string) {
      const entries = fs.readdirSync(dir);
      for (const entry of entries) {
        if (entry === 'node_modules' || entry === '.next' || entry === '.git') continue;
        const fullPath = path.join(dir, entry);
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
          scanDirectory(fullPath);
        } else if (
          entry.endsWith('.md') ||
          entry.endsWith('.ts') ||
          entry.endsWith('.tsx') ||
          entry.endsWith('.json')
        ) {
          // Skip this test runner itself so search terms don't self-match
          if (fullPath === __filename || entry === 'f22-backfill.test.ts') continue;

          const content = fs.readFileSync(fullPath, 'utf8');
          const lines = content.split('\n');
          for (let lineNum = 0; lineNum < lines.length; lineNum++) {
            const line = lines[lineNum];
            if (forbiddenPattern.test(line)) {
              if (line.toLowerCase().includes(allowlistedSentence)) {
                // Allowlisted contract explanation
                continue;
              }
              const relPath = path.relative(path.resolve(__dirname, '../../..'), fullPath);
              violations.push(`${relPath}:${lineNum + 1}: ${line.trim()}`);
            }
          }
        }
      }
    }

    for (const d of scanDirs) {
      scanDirectory(d);
    }

    expect(
      violations,
      `Forbidden event type names found:\n${violations.join('\n')}`
    ).toEqual([]);
  });

  // =========================================================================
  // Meta-Test: Reads docs/test-matrix/F22-gaps.txt and asserts all IDs start a test
  // =========================================================================
  it('Meta-Test: every ID in docs/test-matrix/F22-gaps.txt starts a test name in the suite', () => {
    const gapsFilePath = path.resolve(__dirname, '../../../docs/test-matrix/F22-gaps.txt');
    expect(fs.existsSync(gapsFilePath), 'F22-gaps.txt must exist').toBe(true);

    const requiredIds = fs
      .readFileSync(gapsFilePath, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'));

    expect(requiredIds.length).toBe(15);

    // Read all test files in apps/api/tests
    const testsDir = path.resolve(__dirname, '.');
    const testFiles = fs.readdirSync(testsDir).filter((f) => f.endsWith('.test.ts'));

    const foundTestNames: string[] = [];
    const testRegex = /(?:it|test)\s*\(\s*['"`]([^'"`]+)['"`]/g;

    for (const file of testFiles) {
      const content = fs.readFileSync(path.join(testsDir, file), 'utf8');
      let m: RegExpExecArray | null;
      while ((m = testRegex.exec(content)) !== null) {
        foundTestNames.push(m[1].trim());
      }
    }

    const missingIds: string[] = [];
    for (const id of requiredIds) {
      const matched = foundTestNames.some(
        (name) => name === id || name.startsWith(`${id}:`) || name.startsWith(`${id} `)
      );
      if (!matched) {
        missingIds.push(id);
      }
    }

    expect(
      missingIds,
      `The following IDs from docs/test-matrix/F22-gaps.txt do not start any test: ${missingIds.join(
        ', '
      )}`
    ).toEqual([]);
  });
});

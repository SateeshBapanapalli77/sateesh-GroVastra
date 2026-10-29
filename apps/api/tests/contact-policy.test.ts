import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import { app } from '../src/app';
import { connectToDatabase, disconnectDatabase } from '../src/db/connection';
import { seedDatabase } from '../src/db/seed';
import {
  CampaignModel,
  CampaignVersionModel,
  CampaignControlGateModel,
  CampaignEnrollmentModel,
  CampaignExecutionModel,
  CampaignDeliveryIntentModel,
  CampaignContactGateModel,
  SrcCustomerModel,
  SrcCustomerEventModel,
  SrcTemplateModel,
  SrcConnectionModel,
  CampaignSettingsModel,
} from '../src/db/models';
import { contactGateService } from '../src/services/contact-gate';
import { workerService } from '../src/services/worker';
import { plannerService } from '../src/services/planner';
import { clock } from '../src/services/clock';
import { setDispatchPort, resetDispatchPort } from '../src/services/dispatch/dispatch-port';
import {
  EXECUTION_STATE,
  EXECUTION_REASONS,
  DELIVERY_INTENT_STATE,
  PREREQUISITE,
} from '@grovastra/shared';
import { destinationHash, normalizePhoneNumber } from '../src/utils/crypto';

describe('GroVastra WhatsApp Contact Policy, Rolling Gates & Collision Arbitration (Spec p18, p25, p33, QA Matrix B09, B10, C08, C14)', () => {
  let shopAOwnerToken: string;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.ALLOW_TEST_CATEGORY_MISMATCH = 'true';
    process.env.DISPATCH_MODE = 'dry';
    await connectToDatabase();
    await seedDatabase('household-collision');

    const loginRes = await request(app)
      .post('/auth/login')
      .send({ email: 'owner@shop-a.com', password: 'OwnerSecret#2026!' });
    shopAOwnerToken = loginRes.body.token;
  });

  afterAll(async () => {
    resetDispatchPort();
    await disconnectDatabase();
  });

  beforeEach(async () => {
    clock.resetOffset();
    process.env.DISPATCH_MODE = 'dry';
    process.env.ALLOW_TEST_CATEGORY_MISMATCH = 'true';
    resetDispatchPort();

    await CampaignModel.deleteMany({});
    await CampaignVersionModel.deleteMany({});
    await CampaignControlGateModel.deleteMany({});
    await CampaignEnrollmentModel.deleteMany({});
    await CampaignExecutionModel.deleteMany({});
    await CampaignDeliveryIntentModel.deleteMany({});
    await CampaignContactGateModel.deleteMany({});

    // Reset default settings for shop_a (1 per 24h rolling, 3 per 7d rolling)
    await CampaignSettingsModel.findOneAndUpdate(
      { tenantId: 'shop_a' },
      {
        $set: {
          dailyContactCap: 1,
          weeklyContactCap: 3,
          contactCapWindowHours: 24,
          contactCapWindowDays: 7,
          timezone: 'Asia/Kolkata',
          quietHoursStart: '21:00',
          quietHoursEnd: '09:00',
          sendWindowStart: '09:00',
          sendWindowEnd: '21:00',
          priorityAllowlistRanges: {
            birthday: 80,
            anniversary: 50,
          },
        },
      },
      { upsert: true, new: true }
    );
  });

  // Helper to activate a campaign
  async function createAndActivateCampaign(opts: {
    presetId: string;
    name: string;
    priority?: number;
    stepId: string;
    stepName: string;
    offsetDays: number;
    localTime: string;
    templateId: string;
    bindings: Record<string, string>;
    maxLatenessMinutes?: number;
  }) {
    const createRes = await request(app)
      .post('/campaigns')
      .set('Authorization', `Bearer ${shopAOwnerToken}`)
      .set('Idempotency-Key', `cmp-${Date.now()}-${Math.random()}`)
      .send({ presetId: opts.presetId, name: opts.name });
    expect(createRes.status).toBe(201);
    const campaignId = createRes.body.campaign.campaignId;

    const patchRes = await request(app)
      .patch(`/campaigns/${campaignId}/draft`)
      .set('Authorization', `Bearer ${shopAOwnerToken}`)
      .set('Idempotency-Key', `draft-${Date.now()}-${Math.random()}`)
      .send({
        expectedVersion: 1,
        priority: opts.priority ?? (opts.presetId === 'birthday' ? 80 : 50),
        steps: [
          {
            stepId: opts.stepId,
            stepName: opts.stepName,
            offsetDays: opts.offsetDays,
            localTime: opts.localTime,
            prerequisite: PREREQUISITE.NONE,
            templateRef: { id: opts.templateId, revision: 1, language: 'en' },
            bindings: opts.bindings,
            stopOnReply: true,
            stopOnGoal: true,
            maxLatenessMinutes: opts.maxLatenessMinutes ?? 2880, // Default 48h to allow deferral to next window
          },
        ],
      });
    expect(patchRes.status).toBe(200);

    await request(app)
      .post(`/campaigns/${campaignId}/dry-runs`)
      .set('Authorization', `Bearer ${shopAOwnerToken}`);

    const actRes = await request(app)
      .post(`/campaigns/${campaignId}/activate`)
      .set('Authorization', `Bearer ${shopAOwnerToken}`)
      .set('Idempotency-Key', `act-${Date.now()}-${Math.random()}`);
    expect(actRes.status).toBe(200);

    await plannerService.planCampaign('shop_a', campaignId, { force: true });
    return campaignId;
  }

  // ===========================================================================
  // TEST 1: B09 Deterministic Collision Resolution (Birthday 80 vs Anniversary 50)
  // ===========================================================================
  it('B09: Competing marketing steps for same destination resolve deterministically: Birthday (Priority 80) wins and dispatches, Anniversary (Priority 50) is deferred', async () => {
    // Aligns to target date Dec 15 2026. Customer has birthday and anniversary on Jan 5
    // D-14 before Jan 5 is Dec 22 at 10:00 AM
    const targetDate = new Date('2026-12-15T09:00:00Z');
    clock.setOffsetMs(targetDate.getTime() - Date.now());

    // Update customer cus_household_1 to have birthday Jan 5 in SrcCustomerModel
    await SrcCustomerModel.updateOne(
      { tenantId: 'shop_a', customerId: 'cus_household_1' },
      {
        $set: {
          birthday: { month: 1, day: 5 },
          'consent.marketingOptIn': true,
          'consent.channelSuppressed': false,
          status: 'ACTIVE',
        },
      }
    );

    // Seed anniversary Jan 5 in SrcCustomerEventModel (source of truth for customer.event triggers)
    await SrcCustomerEventModel.deleteMany({ tenantId: 'shop_a', customerId: 'cus_household_1' });
    await SrcCustomerEventModel.create({
      tenantId: 'shop_a',
      customerId: 'cus_household_1',
      eventId: 'evt_h1_anniv',
      type: 'anniversary',
      month: 1,
      day: 5,
      label: 'Household Anniversary',
      version: 1,
    });

    // 1. Create Birthday Campaign (Priority 80)
    const birthdayCmpId = await createAndActivateCampaign({
      presetId: 'birthday',
      name: 'High Priority Birthday',
      priority: 80,
      stepId: 'bday_invitation',
      stepName: 'Birthday Invite',
      offsetDays: -14,
      localTime: '10:00',
      templateId: 'tpl_birthday_invite',
      bindings: { name: 'customer.firstName', shop: 'shop.displayName' },
      maxLatenessMinutes: 2880,
    });

    // 2. Create Anniversary Campaign (Priority 50)
    const anniversaryCmpId = await createAndActivateCampaign({
      presetId: 'anniversary',
      name: 'Lower Priority Anniversary',
      priority: 50,
      stepId: 'anniv_invitation',
      stepName: 'Anniversary Invite',
      offsetDays: -14,
      localTime: '10:00',
      templateId: 'tpl_birthday_invite',
      bindings: { name: 'customer.firstName', shop: 'shop.displayName' },
      maxLatenessMinutes: 2880,
    });

    // Find enrollments and executions for cus_household_1
    const bdayEnrollment = await CampaignEnrollmentModel.findOne({
      tenantId: 'shop_a',
      campaignId: birthdayCmpId,
      customerId: 'cus_household_1',
    });
    const annivEnrollment = await CampaignEnrollmentModel.findOne({
      tenantId: 'shop_a',
      campaignId: anniversaryCmpId,
      customerId: 'cus_household_1',
    });

    expect(bdayEnrollment).not.toBeNull();
    expect(annivEnrollment).not.toBeNull();

    const bdayExecution = await CampaignExecutionModel.findOne({
      tenantId: 'shop_a',
      enrollmentId: bdayEnrollment!.enrollmentId,
      stepId: 'bday_invitation',
    });
    const annivExecution = await CampaignExecutionModel.findOne({
      tenantId: 'shop_a',
      enrollmentId: annivEnrollment!.enrollmentId,
      stepId: 'anniv_invitation',
    });

    expect(bdayExecution).not.toBeNull();
    expect(annivExecution).not.toBeNull();
    expect(bdayExecution!.dueAt.toISOString()).toBe(annivExecution!.dueAt.toISOString());

    // Advance clock to when both steps are due
    const dueTime = new Date(bdayExecution!.dueAt.getTime() + 1000);
    clock.setSystemTime(dueTime);

    // Run worker cycle for shop_a
    const cycleRes = await workerService.runWorkerCycle({
      tenantId: 'shop_a',
      batchSize: 10,
    });

    expect(cycleRes.claimedCount).toBeGreaterThanOrEqual(1);

    // Check states:
    // 1. Birthday step (Priority 80) MUST win and be in DISPATCHING
    const updatedBday = await CampaignExecutionModel.findOne({
      tenantId: 'shop_a',
      executionId: bdayExecution!.executionId,
    });
    expect(updatedBday!.state).toBe(EXECUTION_STATE.DISPATCHING);
    expect(updatedBday!.deliveryIntentId).toBeTruthy();

    // 2. Anniversary step (Priority 50) MUST lose and be DEFERRED with the specific collision reason
    const updatedAnniv = await CampaignExecutionModel.findOne({
      tenantId: 'shop_a',
      executionId: annivExecution!.executionId,
    });
    expect(updatedAnniv!.state).toBe(EXECUTION_STATE.DEFERRED);
    expect(updatedAnniv!.skipReason).toBe('Deferred: another campaign contacted this customer');
    expect(updatedAnniv!.originalDueAt).toBeDefined();
    expect(updatedAnniv!.dueAt.getTime()).toBeGreaterThan(bdayExecution!.dueAt.getTime());

    // 3. campaignContactGates must have a single RESERVED/ACCEPTED ledger entry for the destination
    const destHash = (await SrcCustomerModel.findOne({ tenantId: 'shop_a', customerId: 'cus_household_1' }))!.destination.destinationHash;
    const gate = await CampaignContactGateModel.findOne({
      tenantId: 'shop_a',
      destinationHash: destHash,
    });
    expect(gate).not.toBeNull();
    expect(gate!.ledger.length).toBe(1);
    expect(gate!.ledger[0].executionId).toBe(bdayExecution!.executionId);
    expect(gate!.ledger[0].status).toMatch(/RESERVED|ACCEPTED/);
  });

  // ===========================================================================
  // TEST 1B: Collision with short lateness cutoff -> SKIPPED_CONTACT_CAP
  // ===========================================================================
  it('B09 (Lateness edge case): Losing step with short expiry cutoff is marked SKIPPED_CONTACT_CAP when next slot is past expiresAt', async () => {
    const targetDate = new Date('2026-12-15T09:00:00Z');
    clock.setOffsetMs(targetDate.getTime() - Date.now());

    await SrcCustomerModel.updateOne(
      { tenantId: 'shop_a', customerId: 'cus_household_1' },
      {
        $set: {
          birthday: { month: 1, day: 5 },
          'consent.marketingOptIn': true,
          'consent.channelSuppressed': false,
          status: 'ACTIVE',
        },
      }
    );

    await SrcCustomerEventModel.deleteMany({ tenantId: 'shop_a', customerId: 'cus_household_1' });
    await SrcCustomerEventModel.create({
      tenantId: 'shop_a',
      customerId: 'cus_household_1',
      eventId: 'evt_h1_anniv',
      type: 'anniversary',
      month: 1,
      day: 5,
      label: 'Household Anniversary',
      version: 1,
    });

    // Birthday Campaign (Priority 80)
    const birthdayCmpId = await createAndActivateCampaign({
      presetId: 'birthday',
      name: 'High Priority Birthday',
      priority: 80,
      stepId: 'bday_invitation',
      stepName: 'Birthday Invite',
      offsetDays: -14,
      localTime: '10:00',
      templateId: 'tpl_birthday_invite',
      bindings: { name: 'customer.firstName', shop: 'shop.displayName' },
    });

    // Anniversary Campaign (Priority 50) with short lateness (120 minutes)
    const anniversaryCmpId = await createAndActivateCampaign({
      presetId: 'anniversary',
      name: 'Short Cutoff Anniversary',
      priority: 50,
      stepId: 'anniv_invitation',
      stepName: 'Anniversary Invite',
      offsetDays: -14,
      localTime: '10:00',
      templateId: 'tpl_birthday_invite',
      bindings: { name: 'customer.firstName', shop: 'shop.displayName' },
      maxLatenessMinutes: 120, // 2 hour lateness cutoff
    });

    const annivEnrollment = await CampaignEnrollmentModel.findOne({
      tenantId: 'shop_a',
      campaignId: anniversaryCmpId,
      customerId: 'cus_household_1',
    });
    const bdayEnrollment = await CampaignEnrollmentModel.findOne({
      tenantId: 'shop_a',
      campaignId: birthdayCmpId,
      customerId: 'cus_household_1',
    });

    const bdayExecution = await CampaignExecutionModel.findOne({
      tenantId: 'shop_a',
      enrollmentId: bdayEnrollment!.enrollmentId,
    });
    const annivExecution = await CampaignExecutionModel.findOne({
      tenantId: 'shop_a',
      enrollmentId: annivEnrollment!.enrollmentId,
    });

    const dueTime = new Date(bdayExecution!.dueAt.getTime() + 1000);
    clock.setSystemTime(dueTime);

    await workerService.runWorkerCycle({
      tenantId: 'shop_a',
      batchSize: 10,
    });

    const updatedAnniv = await CampaignExecutionModel.findOne({
      tenantId: 'shop_a',
      executionId: annivExecution!.executionId,
    });
    // Next day slot is past 2-hour expiresAt -> correctly marks SKIPPED_CONTACT_CAP
    expect(updatedAnniv!.state).toBe(EXECUTION_STATE.SKIPPED);
    expect(updatedAnniv!.skipReason).toBe(EXECUTION_REASONS.SKIPPED_CONTACT_CAP);
    expect(updatedAnniv!.originalDueAt).toBeDefined();
  });

  // ===========================================================================
  // TEST 2: B10 Destination Cap Across Multiple Customer Records (Shared Phone)
  // ===========================================================================
  it('B10: Two customer records sharing one phone number share the rolling contact cap without merging customer identities', async () => {
    const targetDate = new Date('2026-12-15T09:00:00Z');
    clock.setOffsetMs(targetDate.getTime() - Date.now());

    // Both cus_household_1 (Raj) and cus_household_2 (Anita) share +91 91000 00088
    // Ensure both have birthday Jan 5 so both have steps due Dec 22
    await SrcCustomerModel.updateMany(
      { tenantId: 'shop_a', customerId: { $in: ['cus_household_1', 'cus_household_2'] } },
      {
        $set: {
          birthday: { month: 1, day: 5 },
          'consent.marketingOptIn': true,
          'consent.channelSuppressed': false,
          status: 'ACTIVE',
        },
      }
    );

    const customer1 = await SrcCustomerModel.findOne({ tenantId: 'shop_a', customerId: 'cus_household_1' });
    const customer2 = await SrcCustomerModel.findOne({ tenantId: 'shop_a', customerId: 'cus_household_2' });

    expect(customer1).not.toBeNull();
    expect(customer2).not.toBeNull();
    expect(customer1!.destination.destinationHash).toBe(customer2!.destination.destinationHash);
    expect(customer1!.customerId).not.toBe(customer2!.customerId);

    // Create a Birthday campaign that enrolls both
    const cmpId = await createAndActivateCampaign({
      presetId: 'birthday',
      name: 'Shared Destination Birthday',
      priority: 80,
      stepId: 'bday_step',
      stepName: 'Birthday Step',
      offsetDays: -14,
      localTime: '10:00',
      templateId: 'tpl_birthday_invite',
      bindings: { name: 'customer.firstName', shop: 'shop.displayName' },
      maxLatenessMinutes: 2880,
    });

    const enr1 = await CampaignEnrollmentModel.findOne({
      tenantId: 'shop_a',
      campaignId: cmpId,
      customerId: 'cus_household_1',
    });
    const enr2 = await CampaignEnrollmentModel.findOne({
      tenantId: 'shop_a',
      campaignId: cmpId,
      customerId: 'cus_household_2',
    });

    expect(enr1).not.toBeNull();
    expect(enr2).not.toBeNull();

    const exec1 = await CampaignExecutionModel.findOne({
      tenantId: 'shop_a',
      enrollmentId: enr1!.enrollmentId,
    });
    const exec2 = await CampaignExecutionModel.findOne({
      tenantId: 'shop_a',
      enrollmentId: enr2!.enrollmentId,
    });

    expect(exec1).not.toBeNull();
    expect(exec2).not.toBeNull();

    // Advance to due time (Dec 22 10:00)
    const dueTime = new Date(exec1!.dueAt.getTime() + 1000);
    clock.setSystemTime(dueTime);

    // Claim and process Customer 1 (exec1)
    const claim1 = await CampaignExecutionModel.findOneAndUpdate(
      { tenantId: 'shop_a', executionId: exec1!.executionId },
      {
        $set: {
          state: EXECUTION_STATE.EVALUATING,
          'lease.token': 'test_lease_token_1',
          'lease.until': new Date(dueTime.getTime() + 30000),
        },
      },
      { new: true }
    );
    expect(claim1).not.toBeNull();

    const eval1 = await workerService.evaluateAndProcessExecution(
      claim1!,
      'test_lease_token_1',
      new Date(dueTime.getTime() + 30000),
      dueTime
    );
    expect(eval1.state).toBe(EXECUTION_STATE.DISPATCHING);

    // Customer 1's step dispatched successfully
    const updatedExec1 = await CampaignExecutionModel.findOne({
      tenantId: 'shop_a',
      executionId: exec1!.executionId,
    });
    expect(updatedExec1!.state).toBe(EXECUTION_STATE.DISPATCHING);

    // Verify contact ledger recorded Customer 1's execution
    const gate = await CampaignContactGateModel.findOne({
      tenantId: 'shop_a',
      destinationHash: customer1!.destination.destinationHash,
    });
    expect(gate).not.toBeNull();
    expect(gate!.ledger.length).toBe(1);

    // Now, Customer 2 on the same phone is evaluated 2 hours later (same day)
    const laterSameDay = new Date(dueTime.getTime() + 2 * 3600000);
    clock.setSystemTime(laterSameDay);

    const otherExec = exec2!;
    const claim2 = await CampaignExecutionModel.findOneAndUpdate(
      { tenantId: 'shop_a', executionId: otherExec.executionId },
      {
        $set: {
          state: EXECUTION_STATE.EVALUATING,
          'lease.token': 'test_lease_token_2',
          'lease.until': new Date(laterSameDay.getTime() + 30000),
        },
      },
      { new: true }
    );

    const eval2 = await workerService.evaluateAndProcessExecution(
      claim2!,
      'test_lease_token_2',
      new Date(laterSameDay.getTime() + 30000),
      laterSameDay
    );

    // Customer 2's execution MUST be rejected or deferred by the contact cap (1 per 24h rolling)
    expect([EXECUTION_STATE.DEFERRED, EXECUTION_STATE.SKIPPED]).toContain(eval2.state);

    const updatedExec2 = await CampaignExecutionModel.findOne({
      tenantId: 'shop_a',
      executionId: otherExec.executionId,
    });
    expect([EXECUTION_STATE.DEFERRED, EXECUTION_STATE.SKIPPED]).toContain(updatedExec2!.state);

    // CRITICAL: Customer records were NOT merged (distinct customerId, distinct enrollments)
    expect(enr1!.customerId).not.toBe(enr2!.customerId);
    expect(updatedExec1!.enrollmentId).not.toBe(updatedExec2!.enrollmentId);
  });

  // ===========================================================================
  // TEST 3: C08 Proven Throttle Rejection Releases Reservation; Safe Retry Re-reserves
  // ===========================================================================
  it('C08: Proven Meta throttle releases reservation; retry re-reserves under same key without double counting', async () => {
    const destHash = destinationHash(normalizePhoneNumber('919876543210'));
    const executionId = `exec_c08_throttle_${Date.now()}`;
    const campaignId = 'cmp_c08_test';
    const settings = { dailyContactCap: 1, weeklyContactCap: 3, contactCapWindowHours: 24, contactCapWindowDays: 7 } as any;

    const t0 = new Date('2026-10-21T10:00:00Z');

    // 1. Initial atomic reservation succeeds
    const session1 = await mongoose.startSession();
    session1.startTransaction();
    const gate1 = await contactGateService.reserveContactCapacityAtomic(
      session1,
      'shop_a',
      campaignId,
      destHash,
      executionId,
      'MARKETING',
      t0,
      settings
    );
    await session1.commitTransaction();
    session1.endSession();

    expect(gate1).toBeDefined();

    // Daily cap is now reached (1 / 1)
    const capAfterRes = await contactGateService.checkCapacity('shop_a', destHash, t0, settings);
    expect(capAfterRes.allowed).toBe(false);
    expect(capAfterRes.dailyCount).toBe(1);

    // 2. Meta returns proven 429 throttle -> WhatsApp delivery releases reservation
    await contactGateService.releaseReservation(
      'shop_a',
      destHash,
      executionId,
      'THROTTLED_RETRY'
    );

    // Gate ledger entry is now RELEASED
    const gateAfterRelease = await CampaignContactGateModel.findOne({
      tenantId: 'shop_a',
      destinationHash: destHash,
    });
    const entry = gateAfterRelease!.ledger.find((l) => l.executionId === executionId);
    expect(entry).toBeDefined();
    expect(entry!.status).toBe('RELEASED');
    expect(entry!.releaseReason).toBe('THROTTLED_RETRY');

    // Capacity is restored
    const capAfterRelease = await contactGateService.checkCapacity('shop_a', destHash, t0, settings);
    expect(capAfterRelease.allowed).toBe(true);
    expect(capAfterRelease.dailyCount).toBe(0);

    // 3. Worker retries at retryAt (safe retry re-reserves under same executionId)
    const retryTime = new Date('2026-10-21T10:15:00Z');
    const session2 = await mongoose.startSession();
    session2.startTransaction();
    const gate2 = await contactGateService.reserveContactCapacityAtomic(
      session2,
      'shop_a',
      campaignId,
      destHash,
      executionId,
      'MARKETING',
      retryTime,
      settings
    );
    await session2.commitTransaction();
    session2.endSession();

    expect(gate2).toBeDefined();

    // 4. Verify no double counting: Ledger still only has 1 active entry for this execution
    const gateAfterRetry = await CampaignContactGateModel.findOne({
      tenantId: 'shop_a',
      destinationHash: destHash,
    });
    const activeEntries = gateAfterRetry!.ledger.filter(
      (l) => l.executionId === executionId && l.status === 'RESERVED'
    );
    expect(activeEntries.length).toBe(1);

    const capAfterRetry = await contactGateService.checkCapacity('shop_a', destHash, retryTime, settings);
    expect(capAfterRetry.allowed).toBe(false);
    expect(capAfterRetry.dailyCount).toBe(1);
  });

  // ===========================================================================
  // TEST 4: Concurrent Claims for One Destination (Exact-One Winner via Optimistic Lock)
  // ===========================================================================
  it('Concurrent claims for the same destination: Optimistic versioning guarantees exactly one reservation succeeds', async () => {
    const destHash = destinationHash(normalizePhoneNumber('919777777777'));
    const campaignId = 'cmp_concurrent_test';
    const settings = { dailyContactCap: 1, weeklyContactCap: 3, contactCapWindowHours: 24, contactCapWindowDays: 7 } as any;
    const now = new Date('2026-10-21T12:00:00Z');

    // Initialize contact gate document at version 1
    await CampaignContactGateModel.create({
      tenantId: 'shop_a',
      destinationHash: destHash,
      version: 1,
      ledger: [],
    });

    const execA = 'exec_concurrent_A';
    const execB = 'exec_concurrent_B';

    const runClaimA = async () => {
      const s = await mongoose.startSession();
      try {
        s.startTransaction();
        const gate = await contactGateService.reserveContactCapacityAtomic(
          s,
          'shop_a',
          campaignId,
          destHash,
          execA,
          'MARKETING',
          now,
          settings
        );
        await s.commitTransaction();
        return { success: true, gate };
      } catch (err) {
        await s.abortTransaction();
        return { success: false, reason: (err as any).message };
      } finally {
        s.endSession();
      }
    };

    const runClaimB = async () => {
      const s = await mongoose.startSession();
      try {
        s.startTransaction();
        const gate = await contactGateService.reserveContactCapacityAtomic(
          s,
          'shop_a',
          campaignId,
          destHash,
          execB,
          'MARKETING',
          now,
          settings
        );
        await s.commitTransaction();
        return { success: true, gate };
      } catch (err) {
        await s.abortTransaction();
        return { success: false, reason: (err as any).message };
      } finally {
        s.endSession();
      }
    };

    // Execute concurrently
    const [resA, resB] = await Promise.all([runClaimA(), runClaimB()]);

    // Exactly one must succeed and one must fail
    const successes = [resA.success, resB.success].filter(Boolean);
    expect(successes.length).toBe(1);

    // Gate in MongoDB has version incremented and exactly 1 ledger entry
    const finalGate = await CampaignContactGateModel.findOne({
      tenantId: 'shop_a',
      destinationHash: destHash,
    });
    expect(finalGate!.version).toBe(2);
    expect(finalGate!.ledger.length).toBe(1);
    expect([execA, execB]).toContain(finalGate!.ledger[0].executionId);
  });

  // ===========================================================================
  // TEST 5: Uncertain Submissions Keep Counting (Lease Expiry Alone Never Releases)
  // ===========================================================================
  it('Uncertain submissions keep counting towards rolling cap; lease expiry alone never releases them', async () => {
    const destHash = destinationHash(normalizePhoneNumber('919666666666'));
    const execution1 = 'exec_uncertain_1';
    const execution2 = 'exec_uncertain_2';
    const campaignId = 'cmp_uncertain_test';
    const settings = { dailyContactCap: 1, weeklyContactCap: 3, contactCapWindowHours: 24, contactCapWindowDays: 7 } as any;
    const t0 = new Date('2026-10-21T08:00:00Z');

    // 1. Reserve capacity for execution 1
    const s1 = await mongoose.startSession();
    s1.startTransaction();
    await contactGateService.reserveContactCapacityAtomic(
      s1,
      'shop_a',
      campaignId,
      destHash,
      execution1,
      'MARKETING',
      t0,
      settings
    );
    await s1.commitTransaction();
    s1.endSession();

    // 2. Mark outcome as UNKNOWN (e.g. HTTP timeout or provider ambiguity)
    await contactGateService.markOutcomeUnknown('shop_a', destHash, execution1);

    const gate = await CampaignContactGateModel.findOne({ tenantId: 'shop_a', destinationHash: destHash });
    const entry = gate!.ledger.find((l) => l.executionId === execution1);
    expect(entry!.status).toBe('UNKNOWN');

    // 3. 4 hours later, worker lease has long expired, but submission outcome is still uncertain
    const tLater = new Date('2026-10-21T12:00:00Z');

    // Capacity check for another step due at tLater
    const capCheck = await contactGateService.checkCapacity(
      'shop_a',
      destHash,
      tLater,
      settings,
      execution2,
      'MARKETING'
    );

    // UNKNOWN submission STILL counts towards the rolling 24h cap!
    expect(capCheck.allowed).toBe(false);
    expect(capCheck.dailyCount).toBe(1);
    expect(capCheck.reason).toBe('DAILY_CAP_REACHED');
  });

  // ===========================================================================
  // TEST 6: C14 Purpose Anti-Bypass Rule
  // ===========================================================================
  it('C14: Promotional steps cannot be labelled as service to bypass caps; resolveEffectivePurpose enforces MARKETING', async () => {
    // 1. Promotional template category cannot be bypassed
    const purpose1 = contactGateService.resolveEffectivePurpose('MARKETING', 'birthday', 'SERVICE');
    expect(purpose1).toBe('MARKETING');

    // 2. Promotional preset cannot be bypassed even with UTILITY template
    const purpose2 = contactGateService.resolveEffectivePurpose('UTILITY', 'festival', 'SERVICE');
    expect(purpose2).toBe('MARKETING');

    const purpose3 = contactGateService.resolveEffectivePurpose('UTILITY', 'winback', 'SERVICE');
    expect(purpose3).toBe('MARKETING');

    // 3. Only authentic non-promotional presets with UTILITY template can be SERVICE
    const purpose4 = contactGateService.resolveEffectivePurpose('UTILITY', 'order_status', 'SERVICE');
    expect(purpose4).toBe('SERVICE');

    // 4. In checkCapacity, MARKETING purpose enforces caps
    const destHash = destinationHash(normalizePhoneNumber('919555555555'));
    const settings = { dailyContactCap: 1, weeklyContactCap: 3, contactCapWindowHours: 24, contactCapWindowDays: 7 } as any;
    const now = new Date('2026-10-21T14:00:00Z');

    // Fill capacity with 1 accepted marketing message
    await CampaignContactGateModel.create({
      tenantId: 'shop_a',
      destinationHash: destHash,
      version: 1,
      ledger: [
        {
          executionId: 'exec_prior_marketing',
          campaignId: 'cmp_prior',
          purpose: 'MARKETING',
          reservedAt: new Date(now.getTime() - 3600000), // 1 hour ago
          status: 'ACCEPTED',
          updatedAt: now,
        },
      ],
    });

    // A promotional execution attempting to claim SERVICE is resolved to MARKETING and blocked
    const effectivePurpose = contactGateService.resolveEffectivePurpose('MARKETING', 'clearance', 'SERVICE');
    expect(effectivePurpose).toBe('MARKETING');

    const capCheck = await contactGateService.checkCapacity(
      'shop_a',
      destHash,
      now,
      settings,
      'exec_new_attempt',
      effectivePurpose
    );

    expect(capCheck.allowed).toBe(false);
    expect(capCheck.dailyCount).toBe(1);
  });
});

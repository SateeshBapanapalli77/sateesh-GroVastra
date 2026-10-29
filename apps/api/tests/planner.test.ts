import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import { app } from '../src/app';
import { connectToDatabase, disconnectDatabase } from '../src/db/connection';
import { seedDatabase } from '../src/db/seed';
import {
  CampaignModel,
  CampaignVersionModel,
  CampaignEnrollmentModel,
  CampaignExecutionModel,
  CampaignCheckpointModel,
  SrcCustomerModel,
  SrcCustomerEventModel,
} from '../src/db/models';
import { plannerService, resolveOccasionDateForYear } from '../src/services/planner';
import { clock } from '../src/services/clock';
import {
  ENROLLMENT_STATUS,
  EXECUTION_STATE,
  CHECKPOINT_STATUS,
} from '@grovastra/shared';

describe('GroVastra Calendar Planner Engine (Feature 8, Spec p17, p18, p21-25, p33, QA Matrix A06-A09, B01, B05, B19)', () => {
  let shopAOwnerToken: string;
  let shopAAdminToken: string;
  let shopAStaffToken: string;
  let shopBOwnerToken: string;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.ALLOW_TEST_CATEGORY_MISMATCH = 'true';
    process.env.DISPATCH_MODE = 'dry';
    await connectToDatabase();
    await seedDatabase('base');

    // Auth tokens
    const loginAOwner = await request(app)
      .post('/auth/login')
      .send({ email: 'owner@shop-a.com', password: 'OwnerSecret#2026!' });
    shopAOwnerToken = loginAOwner.body.token;

    const loginAAdmin = await request(app)
      .post('/auth/login')
      .send({ email: 'admin@shop-a.com', password: 'AdminSecret#2026!' });
    shopAAdminToken = loginAAdmin.body.token;

    const loginAStaff = await request(app)
      .post('/auth/login')
      .send({ email: 'staff@shop-a.com', password: 'StaffSecret#2026!' });
    shopAStaffToken = loginAStaff.body.token;

    const loginBOwner = await request(app)
      .post('/auth/login')
      .send({ email: 'owner@shop-b.com', password: 'ShopBSecret#2026!' });
    shopBOwnerToken = loginBOwner.body.token;
  });

  afterAll(async () => {
    await disconnectDatabase();
  });

  beforeEach(() => {
    clock.resetOffset();
    process.env.DISPATCH_MODE = 'dry';
    process.env.ALLOW_TEST_CATEGORY_MISMATCH = 'true';
  });

  // Helper to create, configure, dry-run and activate a campaign
  async function createAndActivateCampaign(params: {
    presetId?: string;
    name?: string;
    steps?: any[];
    leapDayPolicy?: 'FEB_28' | 'MAR_01' | 'LEAP_ONLY';
    token?: string;
  }) {
    const authToken = params.token || shopAOwnerToken;
    const name = params.name || `Planner Campaign ${Date.now()}`;
    const presetId = params.presetId || 'birthday';

    // 1. Create draft
    const createRes = await request(app)
      .post('/campaigns')
      .set('Authorization', `Bearer ${authToken}`)
      .set('Idempotency-Key', `create-${Date.now()}-${Math.random()}`)
      .send({ presetId, name });
    expect(createRes.status).toBe(201);
    const campaignId = createRes.body.campaign.campaignId;

    // 2. Patch draft
    const patchBody: any = {
      expectedVersion: 1,
    };

    if (params.steps) {
      patchBody.steps = params.steps;
    } else {
      patchBody.steps = [
        {
          stepId: 'invitation',
          stepName: 'Occasion Invitation',
          offsetDays: -14,
          localTime: '10:00',
          prerequisite: 'NONE',
          templateRef: {
            id: 'tpl_birthday_invite',
            revision: 1,
            language: 'en',
          },
          bindings: { name: 'customer.firstName', shop: 'shop.displayName' },
          stopOnReply: true,
          stopOnGoal: true,
          maxLatenessMinutes: 120,
        },
        {
          stepId: 'followup',
          stepName: 'Followup Reminder',
          offsetDays: -7,
          localTime: '10:00',
          prerequisite: 'PREVIOUS_ACCEPTED',
          templateRef: {
            id: 'tpl_hello_world',
            revision: 1,
            language: 'en_US',
          },
          bindings: {},
          stopOnReply: true,
          stopOnGoal: true,
          maxLatenessMinutes: 120,
        },
      ];
    }

    if (params.leapDayPolicy) {
      patchBody.trigger = {
        type: 'ANNUAL_DATE',
        field: presetId === 'anniversary' ? 'customer.event' : 'customer.birthday',
        leapDayPolicy: params.leapDayPolicy,
      };
    }

    const patchRes = await request(app)
      .patch(`/campaigns/${campaignId}/draft`)
      .set('Authorization', `Bearer ${authToken}`)
      .set('Idempotency-Key', `patch-${Date.now()}-${Math.random()}`)
      .send(patchBody);
    expect(patchRes.status).toBe(200);

    // 3. Dry run
    const dryRes = await request(app)
      .post(`/campaigns/${campaignId}/dry-runs`)
      .set('Authorization', `Bearer ${authToken}`)
      .send();
    expect(dryRes.status).toBe(201);

    // 4. Activate campaign (which triggers initial calendar planning!)
    const actRes = await request(app)
      .post(`/campaigns/${campaignId}/activate`)
      .set('Authorization', `Bearer ${authToken}`)
      .set('Idempotency-Key', `act-${Date.now()}-${Math.random()}`)
      .send();
    expect(actRes.status).toBe(200);

    return { campaignId, activeVersion: actRes.body.activeVersion };
  }

  // ==========================================================================
  // QA MATRIX A: CAMPAIGN SCHEDULING BEHAVIOUR
  // ==========================================================================

  it('A06: Birthday invitation due D-14 schedules one customer/annual occurrence with selected template', async () => {
    // Set Clock to 15 Dec 2026 (Priya Sharma birthday is Jan 5, D-14 is Dec 22 at 10:00 IST = 04:30 UTC)
    const targetDate = new Date('2026-12-15T09:00:00Z');
    clock.setOffsetMs(targetDate.getTime() - Date.now());

    const { campaignId } = await createAndActivateCampaign({
      name: 'Birthday Campaign A06',
    });

    // Verify enrollment created for Priya Sharma (cus_bday_jan05)
    const enrollment = await CampaignEnrollmentModel.findOne({
      tenantId: 'shop_a',
      campaignId,
      customerId: 'cus_bday_jan05',
    });

    expect(enrollment).not.toBeNull();
    expect(enrollment?.occurrenceId).toBe('birthday:2027');
    expect(enrollment?.occasionLocalDate).toBe('2027-01-05');
    expect(enrollment?.status).toBe(ENROLLMENT_STATUS.ACTIVE);
    expect(enrollment?.matchExplanation).toBeDefined();
    expect(enrollment?.enrollmentKey).toBe(`shop_a:${campaignId}:cus_bday_jan05:birthday:2027`);

    // Verify executions created for stable steps
    const executions = await CampaignExecutionModel.find({
      tenantId: 'shop_a',
      enrollmentId: enrollment?.enrollmentId,
    }).sort({ dueAt: 1 });

    expect(executions.length).toBe(2);

    const inviteStep = executions.find((x) => x.stepId === 'invitation');
    expect(inviteStep).toBeDefined();
    expect(inviteStep?.stepName).toBe('Occasion Invitation');
    expect(inviteStep?.state).toBe(EXECUTION_STATE.SCHEDULED);
    expect(inviteStep?.localDate).toBe('2026-12-22');
    expect(inviteStep?.localTime).toBe('10:00');
    expect(inviteStep?.timezone).toBe('Asia/Kolkata');
    // 10:00 IST = 04:30 UTC
    expect(new Date(inviteStep!.dueAt).toISOString()).toBe('2026-12-22T04:30:00.000Z');
    expect(new Date(inviteStep!.originalDueAt).toISOString()).toBe('2026-12-22T04:30:00.000Z');
    expect(inviteStep?.templateRef?.id).toBe('tpl_birthday_invite');
    expect(inviteStep?.templateRef?.revision).toBe(1);
    expect(inviteStep?.executionKey).toBe(`${enrollment?.enrollmentId}:invitation`);
  });

  it('A07: January birthday invitation evaluated in December uses upcoming birthday year as occurrence', async () => {
    // Clock is in Dec 2026
    const targetDate = new Date('2026-12-15T10:00:00Z');
    clock.setOffsetMs(targetDate.getTime() - Date.now());

    const { campaignId } = await createAndActivateCampaign({
      name: 'A07 January Birthday in December',
    });

    const enrollment = await CampaignEnrollmentModel.findOne({
      tenantId: 'shop_a',
      campaignId,
      customerId: 'cus_bday_jan05',
    });

    expect(enrollment).not.toBeNull();
    // Occurrence year must be 2027, NOT 2026
    expect(enrollment?.occurrenceId).toBe('birthday:2027');
    expect(enrollment?.occasionLocalDate).toBe('2027-01-05');
  });

  it('A08: Feb 29 in non-leap year applies configured FEB_28 / MAR_01 / LEAP_ONLY policy once', () => {
    const leapDay = { month: 2, day: 29 };

    // Non-leap year 2027:
    const feb28Date = resolveOccasionDateForYear(leapDay, 2027, 'FEB_28');
    expect(feb28Date).toBe('2027-02-28');

    const mar01Date = resolveOccasionDateForYear(leapDay, 2027, 'MAR_01');
    expect(mar01Date).toBe('2027-03-01');

    const leapOnlyDate = resolveOccasionDateForYear(leapDay, 2027, 'LEAP_ONLY');
    expect(leapOnlyDate).toBe('2028-02-29'); // Next valid leap year is 2028!

    // Leap year 2028:
    const leapYearDate = resolveOccasionDateForYear(leapDay, 2028, 'FEB_28');
    expect(leapYearDate).toBe('2028-02-29');
  });

  it('A09: Anniversary removed -> All pending steps for that saved occasion stop (reconciliation)', async () => {
    // 1. Create a customer with a specific anniversary event in 20 days
    const evalDate = new Date('2026-11-01T10:00:00Z');
    clock.setOffsetMs(evalDate.getTime() - Date.now());

    const customerId = `cus_anniv_a09_${Date.now()}`;
    const eventId = `evt_anniv_${Date.now()}`;

    await SrcCustomerModel.create({
      tenantId: 'shop_a',
      customerId,
      firstName: 'Ananya Verma',
      destination: {
        encryptedPhone: 'c0c0c0c0',
        destinationHash: `hash_${customerId}`,
        masked: '+91 98*** **999',
        verified: true,
        version: 1,
      },
      status: 'ACTIVE',
      consent: { marketingOptIn: true, channelSuppressed: false },
      branchId: 'branch_main',
      isLive: false,
    });

    await SrcCustomerEventModel.create({
      tenantId: 'shop_a',
      customerId,
      eventId,
      type: 'anniversary',
      month: 11,
      day: 20, // 20 Nov 2026
      label: 'Wedding Anniversary',
      version: 1,
    });

    // 2. Create and activate Anniversary Campaign
    const { campaignId } = await createAndActivateCampaign({
      presetId: 'anniversary',
      name: 'Anniversary Campaign A09',
      steps: [
        {
          stepId: 'anniv_invite',
          stepName: 'Anniversary Special',
          offsetDays: -7,
          localTime: '10:00',
          prerequisite: 'NONE',
          templateRef: { id: 'tpl_hello_world', revision: 1, language: 'en_US' },
          bindings: {},
          stopOnReply: true,
          stopOnGoal: true,
          maxLatenessMinutes: 120,
        },
      ],
    });

    // Verify enrollment created for this anniversary
    const enrollment = await CampaignEnrollmentModel.findOne({
      tenantId: 'shop_a',
      campaignId,
      customerId,
      occurrenceId: `anniversary:${eventId}:2026`,
    });

    expect(enrollment).not.toBeNull();
    expect(enrollment?.status).toBe(ENROLLMENT_STATUS.ACTIVE);

    // Verify execution is SCHEDULED
    const execution = await CampaignExecutionModel.findOne({
      tenantId: 'shop_a',
      enrollmentId: enrollment?.enrollmentId,
      stepId: 'anniv_invite',
    });

    expect(execution).not.toBeNull();
    expect(execution?.state).toBe(EXECUTION_STATE.SCHEDULED);

    // 3. Remove/delete anniversary event from database
    await SrcCustomerEventModel.updateOne(
      { tenantId: 'shop_a', eventId },
      { $set: { deletedAt: new Date() } }
    );

    // 4. Run planner reconciliation
    const cancelledCount = await plannerService.reconcileActiveEnrollments('shop_a', campaignId);
    expect(cancelledCount).toBeGreaterThanOrEqual(1);

    // 5. Assert: pending steps cancelled with reason OCCASION_EVENT_REMOVED, enrollment CANCELLED
    const updatedExecution = await CampaignExecutionModel.findOne({
      tenantId: 'shop_a',
      enrollmentId: enrollment?.enrollmentId,
      stepId: 'anniv_invite',
    });

    expect(updatedExecution?.state).toBe(EXECUTION_STATE.CANCELLED);
    expect(updatedExecution?.skipReason).toBe('OCCASION_EVENT_REMOVED');

    const updatedEnrollment = await CampaignEnrollmentModel.findOne({
      tenantId: 'shop_a',
      enrollmentId: enrollment?.enrollmentId,
    });
    expect(updatedEnrollment?.status).toBe(ENROLLMENT_STATUS.CANCELLED);
  });

  // ==========================================================================
  // QA MATRIX B: CONCURRENCY, CHECKPOINTS & EDGE CASES
  // ==========================================================================

  it('B01: Two planners evaluate same occurrence concurrently -> exactly one enrollment and one execution per step', async () => {
    const targetDate = new Date('2026-12-15T09:00:00Z');
    clock.setOffsetMs(targetDate.getTime() - Date.now());

    const { campaignId } = await createAndActivateCampaign({
      name: 'B01 Concurrency Campaign',
    });

    // Run two planners simultaneously with force: true to bypass distributed lease
    // and exercise database unique constraint & atomic CAS handling
    const [resA, resB] = await Promise.all([
      plannerService.planCampaign('shop_a', campaignId, { force: true }),
      plannerService.planCampaign('shop_a', campaignId, { force: true }),
    ]);

    expect(resA.planned || resB.planned).toBe(true);

    // Assert: exactly 1 enrollment for Priya Sharma
    const priyaEnrollments = await CampaignEnrollmentModel.find({
      tenantId: 'shop_a',
      campaignId,
      customerId: 'cus_bday_jan05',
    });

    expect(priyaEnrollments.length).toBe(1);

    // Assert: exactly 1 execution per step
    const priyaExecutions = await CampaignExecutionModel.find({
      tenantId: 'shop_a',
      enrollmentId: priyaEnrollments[0].enrollmentId,
    });

    expect(priyaExecutions.length).toBe(2);
    const stepIds = priyaExecutions.map((x) => x.stepId).sort();
    expect(stepIds).toEqual(['followup', 'invitation']);
  });

  it('B05: Large historical customer import -> future-only planning, zero catch-up burst', async () => {
    // Current time is 15 Dec 2026
    const evalDate = new Date('2026-12-15T10:00:00Z');
    clock.setOffsetMs(evalDate.getTime() - Date.now());

    // Create 10 historical customers with birthdays 2 days ago (Dec 13)
    const historicalDocs = [];
    for (let i = 1; i <= 10; i++) {
      const cid = `cus_hist_${Date.now()}_${i}`;
      historicalDocs.push({
        tenantId: 'shop_a',
        customerId: cid,
        firstName: `Historical Customer ${i}`,
        destination: {
          encryptedPhone: 'beefbeef',
          destinationHash: `hash_${cid}`,
          masked: `+91 97*** **${String(i).padStart(3, '0')}`,
          verified: true,
          version: 1,
        },
        birthday: { month: 12, day: 13 }, // In the past relative to Dec 15!
        marketingOptIn: true,
        channelSuppressed: false,
        status: 'ACTIVE',
        branchId: 'branch_main',
        isLive: false,
      });
    }

    await SrcCustomerModel.insertMany(historicalDocs);

    try {
      const { campaignId } = await createAndActivateCampaign({
        name: 'B05 Historical Import Campaign',
        steps: [
          {
            stepId: 'invitation',
            stepName: 'Occasion Invitation',
            offsetDays: -14, // 13 Dec - 14d = 29 Nov (elapsed!)
            localTime: '10:00',
            prerequisite: 'NONE',
            templateRef: { id: 'tpl_hello_world', revision: 1, language: 'en_US' },
            bindings: {},
            stopOnReply: true,
            stopOnGoal: true,
            maxLatenessMinutes: 120,
          },
        ],
      });

      // Assert: for all historical customers, the elapsed steps were SKIPPED, NOT SCHEDULED
      for (const h of historicalDocs) {
        const enr = await CampaignEnrollmentModel.findOne({
          tenantId: 'shop_a',
          campaignId,
          customerId: h.customerId,
        });

        if (enr) {
          const exe = await CampaignExecutionModel.findOne({
            tenantId: 'shop_a',
            enrollmentId: enr.enrollmentId,
          });

          expect(exe?.state).toBe(EXECUTION_STATE.SKIPPED);
          expect(exe?.skipReason).toBe('Elapsed step prior to evaluation instant');
        }
      }

      // Zero SCHEDULED messages for these historical customers (no burst)
      const scheduledHistCount = await CampaignExecutionModel.countDocuments({
        tenantId: 'shop_a',
        campaignId,
        customerId: { $in: historicalDocs.map((d) => d.customerId) },
        state: EXECUTION_STATE.SCHEDULED,
      });
      expect(scheduledHistCount).toBe(0);
    } finally {
      await SrcCustomerModel.deleteMany({
        tenantId: 'shop_a',
        customerId: { $in: historicalDocs.map((d) => d.customerId) },
      });
    }
  });

  it('B19: Activate Jan 6 for Jan 5 occasion with D+7 step: Elapsed steps skipped, valid Jan 12 step discovered', async () => {
    // Current time is Jan 6, 2027 10:00 IST = 04:30 UTC
    const evalDate = new Date('2027-01-06T04:30:00Z');
    clock.setOffsetMs(evalDate.getTime() - Date.now());

    // Priya Sharma birthday is Jan 5 (2027-01-05).
    // Campaign has:
    // - invitation: D-14 (Dec 22: elapsed)
    // - followup: D-7 (Dec 29: elapsed)
    // - greeting: D0 (Jan 5: elapsed)
    // - thank_you: D+7 (Jan 12: valid future step!)
    const { campaignId } = await createAndActivateCampaign({
      name: 'B19 Post-Occasion D+7 Campaign',
      steps: [
        {
          stepId: 'invitation',
          stepName: 'Occasion Invitation',
          offsetDays: -14,
          localTime: '10:00',
          prerequisite: 'NONE',
          templateRef: { id: 'tpl_hello_world', revision: 1, language: 'en_US' },
          bindings: {},
          stopOnReply: true,
          stopOnGoal: true,
          maxLatenessMinutes: 120,
        },
        {
          stepId: 'greeting',
          stepName: 'Day of Greeting',
          offsetDays: 0,
          localTime: '10:00',
          prerequisite: 'NONE',
          templateRef: { id: 'tpl_hello_world', revision: 1, language: 'en_US' },
          bindings: {},
          stopOnReply: false,
          stopOnGoal: false,
          maxLatenessMinutes: 120,
        },
        {
          stepId: 'thank_you',
          stepName: 'Post-Occasion Thank You',
          offsetDays: 7, // Jan 5 + 7d = Jan 12 (valid future!)
          localTime: '10:00',
          prerequisite: 'NONE',
          templateRef: { id: 'tpl_hello_world', revision: 1, language: 'en_US' },
          bindings: {},
          stopOnReply: true,
          stopOnGoal: true,
          maxLatenessMinutes: 120,
        },
      ],
    });

    // Verify Priya's enrollment was discovered because horizon window includes (Jan 6 - 7d = Dec 30)
    const enrollment = await CampaignEnrollmentModel.findOne({
      tenantId: 'shop_a',
      campaignId,
      customerId: 'cus_bday_jan05',
    });

    expect(enrollment).not.toBeNull();
    expect(enrollment?.occasionLocalDate).toBe('2027-01-05');

    // Verify executions:
    // - invitation (D-14): SKIPPED
    // - greeting (D0): SKIPPED
    // - thank_you (D+7): SCHEDULED for Jan 12!
    const executions = await CampaignExecutionModel.find({
      tenantId: 'shop_a',
      enrollmentId: enrollment?.enrollmentId,
    });

    const invite = executions.find((x) => x.stepId === 'invitation');
    expect(invite?.state).toBe(EXECUTION_STATE.SKIPPED);
    expect(invite?.skipReason).toBe('Elapsed step prior to evaluation instant');

    const greeting = executions.find((x) => x.stepId === 'greeting');
    expect(greeting?.state).toBe(EXECUTION_STATE.SKIPPED);
    expect(greeting?.skipReason).toBe('Elapsed step prior to evaluation instant');

    const thankYou = executions.find((x) => x.stepId === 'thank_you');
    expect(thankYou?.state).toBe(EXECUTION_STATE.SCHEDULED);
    expect(thankYou?.localDate).toBe('2027-01-12');
    expect(thankYou?.localTime).toBe('10:00');
    // Jan 12 at 10:00 IST = 04:30 UTC
    expect(new Date(thankYou!.dueAt).toISOString()).toBe('2027-01-12T04:30:00.000Z');
  });

  it('Planner restart resumes from durable checkpoint cursor (Spec p17)', async () => {
    const evalDate = new Date('2026-12-15T10:00:00Z');
    clock.setOffsetMs(evalDate.getTime() - Date.now());

    const { campaignId } = await createAndActivateCampaign({
      name: 'Checkpoint Resumption Test',
    });

    // Simulate an interrupted checkpoint at customer 'cus_bday_jan05'
    await CampaignCheckpointModel.updateOne(
      { tenantId: 'shop_a', campaignId, type: 'CALENDAR_PLANNER' },
      {
        $set: {
          status: CHECKPOINT_STATUS.IN_PROGRESS,
          lastCustomerId: 'cus_bday_jan05',
          processedCount: 15,
          enrolledCount: 1,
          leaseToken: null,
          leaseExpiresAt: null,
        },
      }
    );

    // Restart planner
    const result = await plannerService.planCampaign('shop_a', campaignId, {
      resumeFromCheckpoint: true,
      batchSize: 20,
    });

    expect(result.planned).toBe(true);

    // Verify checkpoint completed
    const checkpoint = await CampaignCheckpointModel.findOne({
      tenantId: 'shop_a',
      campaignId,
      type: 'CALENDAR_PLANNER',
    });

    expect(checkpoint?.status).toBe(CHECKPOINT_STATUS.COMPLETED);
    expect(checkpoint?.lastCustomerId).toBeNull();
    expect(checkpoint?.leaseToken).toBeNull();
  });

  it('Re-running the planner changes nothing (idempotency, Spec p18)', async () => {
    const evalDate = new Date('2026-12-15T10:00:00Z');
    clock.setOffsetMs(evalDate.getTime() - Date.now());

    const { campaignId } = await createAndActivateCampaign({
      name: 'Idempotency Test Campaign',
    });

    // Capture counts after first run
    const enrCount1 = await CampaignEnrollmentModel.countDocuments({ tenantId: 'shop_a', campaignId });
    const exeCount1 = await CampaignExecutionModel.countDocuments({ tenantId: 'shop_a', campaignId });

    expect(enrCount1).toBeGreaterThan(0);
    expect(exeCount1).toBeGreaterThan(0);

    // Run planner a second time
    const secondResult = await plannerService.planCampaign('shop_a', campaignId, { force: true });
    expect(secondResult.createdEnrollmentsCount).toBe(0);
    expect(secondResult.createdExecutionsCount).toBe(0);

    // Counts remain exactly identical
    const enrCount2 = await CampaignEnrollmentModel.countDocuments({ tenantId: 'shop_a', campaignId });
    const exeCount2 = await CampaignExecutionModel.countDocuments({ tenantId: 'shop_a', campaignId });

    expect(enrCount2).toBe(enrCount1);
    expect(exeCount2).toBe(exeCount1);
  });

  it('Pinned version immutability: older enrollments retain version N steps when campaign is revised to N+1', async () => {
    const evalDate = new Date('2026-12-15T10:00:00Z');
    clock.setOffsetMs(evalDate.getTime() - Date.now());

    // 1. Activate v1 with 2 steps: invitation (D-14) and followup (D-7)
    const { campaignId, activeVersion } = await createAndActivateCampaign({
      name: 'Version Pinning Test',
      steps: [
        {
          stepId: 'step_1_v1',
          stepName: 'Step 1 v1',
          offsetDays: -14,
          localTime: '10:00',
          prerequisite: 'NONE',
          templateRef: { id: 'tpl_hello_world', revision: 1, language: 'en_US' },
          bindings: {},
          stopOnReply: true,
          stopOnGoal: true,
          maxLatenessMinutes: 120,
        },
        {
          stepId: 'step_2_v1',
          stepName: 'Step 2 v1',
          offsetDays: -7,
          localTime: '10:00',
          prerequisite: 'PREVIOUS_ACCEPTED',
          templateRef: { id: 'tpl_hello_world', revision: 1, language: 'en_US' },
          bindings: {},
          stopOnReply: true,
          stopOnGoal: true,
          maxLatenessMinutes: 120,
        },
      ],
    });

    const vInitial = activeVersion.version;

    const v1Enrollment = await CampaignEnrollmentModel.findOne({
      tenantId: 'shop_a',
      campaignId,
      customerId: 'cus_bday_jan05',
    });

    expect(v1Enrollment).not.toBeNull();
    expect(v1Enrollment?.campaignVersion).toBe(vInitial);

    const v1Executions = await CampaignExecutionModel.find({
      tenantId: 'shop_a',
      enrollmentId: v1Enrollment?.enrollmentId,
    });
    expect(v1Executions.length).toBe(2);

    // 2. Publish revision N+1 (v2) adding a 3rd step
    // Editing active campaign automatically forks draft v2
    await request(app)
      .patch(`/campaigns/${campaignId}/draft`)
      .set('Authorization', `Bearer ${shopAOwnerToken}`)
      .set('Idempotency-Key', `patch-v2-${Date.now()}`)
      .send({
        expectedVersion: vInitial,
        steps: [
          {
            stepId: 'step_1_v1',
            stepName: 'Step 1 v1',
            offsetDays: -14,
            localTime: '10:00',
            prerequisite: 'NONE',
            templateRef: { id: 'tpl_hello_world', revision: 1, language: 'en_US' },
            bindings: {},
            stopOnReply: true,
            stopOnGoal: true,
            maxLatenessMinutes: 120,
          },
          {
            stepId: 'step_2_v1',
            stepName: 'Step 2 v1',
            offsetDays: -7,
            localTime: '10:00',
            prerequisite: 'PREVIOUS_ACCEPTED',
            templateRef: { id: 'tpl_hello_world', revision: 1, language: 'en_US' },
            bindings: {},
            stopOnReply: true,
            stopOnGoal: true,
            maxLatenessMinutes: 120,
          },
          {
            stepId: 'step_3_v2',
            stepName: 'Step 3 v2 (New in revision)',
            offsetDays: 0,
            localTime: '10:00',
            prerequisite: 'NONE',
            templateRef: { id: 'tpl_hello_world', revision: 1, language: 'en_US' },
            bindings: {},
            stopOnReply: false,
            stopOnGoal: false,
            maxLatenessMinutes: 120,
          },
        ],
      });

    // Dry run on draft v2
    await request(app)
      .post(`/campaigns/${campaignId}/dry-runs`)
      .set('Authorization', `Bearer ${shopAOwnerToken}`)
      .send();

    // Publish revision v2
    const pubRes = await request(app)
      .post(`/campaigns/${campaignId}/publish-revision`)
      .set('Authorization', `Bearer ${shopAOwnerToken}`)
      .set('Idempotency-Key', `pub-v2-${Date.now()}`)
      .send({ expectedVersion: vInitial + 1 });

    expect(pubRes.status).toBe(200);

    // 3. Re-run calendar planner
    await plannerService.planCampaign('shop_a', campaignId, { force: true });

    // Assert Hard Rule 6 & Spec p17:
    // Existing enrollment v1 remains pinned to v1, and does NOT have step_3_v2 added!
    const v1EnrollmentAfter = await CampaignEnrollmentModel.findOne({
      tenantId: 'shop_a',
      campaignId,
      customerId: 'cus_bday_jan05',
    });
    expect(v1EnrollmentAfter?.campaignVersion).toBe(vInitial);

    const executionsAfter = await CampaignExecutionModel.find({
      tenantId: 'shop_a',
      enrollmentId: v1Enrollment?.enrollmentId,
    });
    expect(executionsAfter.length).toBe(2);
    expect(executionsAfter.some((x) => x.stepId === 'step_3_v2')).toBe(false);
  });

  // ==========================================================================
  // REST API ENDPOINTS VERIFICATION
  // ==========================================================================

  it('GET /campaigns/:id/enrollments returns paginated enrollments with customer details and step summaries', async () => {
    const evalDate = new Date('2026-12-15T10:00:00Z');
    clock.setOffsetMs(evalDate.getTime() - Date.now());

    const { campaignId } = await createAndActivateCampaign({
      name: 'API Enrollments Test',
    });

    const res = await request(app)
      .get(`/campaigns/${campaignId}/enrollments`)
      .set('Authorization', `Bearer ${shopAOwnerToken}`);

    expect(res.status).toBe(200);
    expect(res.body.enrollments).toBeDefined();
    expect(Array.isArray(res.body.enrollments)).toBe(true);
    expect(res.body.enrollments.length).toBeGreaterThan(0);

    const first = res.body.enrollments[0];
    expect(first.enrollmentId).toBeDefined();
    expect(first.customerId).toBeDefined();
    expect(first.customerName).toBeDefined();
    expect(first.maskedPhone).toBeDefined();
    expect(first.occurrenceId).toBeDefined();
    expect(first.totalSteps).toBeGreaterThanOrEqual(1);
    expect(first.matchExplanation).toBeDefined();
  });

  it('GET /campaigns/:id/enrollments/:enrollmentId returns detailed breakdown with executions and UTC times', async () => {
    const evalDate = new Date('2026-12-15T10:00:00Z');
    clock.setOffsetMs(evalDate.getTime() - Date.now());

    const { campaignId } = await createAndActivateCampaign({
      name: 'API Enrollment Detail Test',
    });

    const enrollment = await CampaignEnrollmentModel.findOne({
      tenantId: 'shop_a',
      campaignId,
      customerId: 'cus_bday_jan05',
    });

    expect(enrollment).not.toBeNull();

    const res = await request(app)
      .get(`/campaigns/${campaignId}/enrollments/${enrollment?.enrollmentId}`)
      .set('Authorization', `Bearer ${shopAStaffToken}`); // Accessible to staff per Spec p26

    expect(res.status).toBe(200);
    expect(res.body.enrollment).toBeDefined();
    expect(res.body.customer).toBeDefined();
    expect(res.body.executions).toBeDefined();
    expect(res.body.executions.length).toBe(2);

    const firstStep = res.body.executions[0];
    expect(firstStep.stepId).toBe('invitation');
    expect(firstStep.dueAt).toBeDefined();
    expect(firstStep.localDate).toBe('2026-12-22');
    expect(firstStep.localTime).toBe('10:00');
    expect(firstStep.state).toBe(EXECUTION_STATE.SCHEDULED);
  });

  it('GET /campaigns/overview/upcoming-activity returns scheduled executions across active campaigns', async () => {
    const evalDate = new Date('2026-12-15T10:00:00Z');
    clock.setOffsetMs(evalDate.getTime() - Date.now());

    await createAndActivateCampaign({
      name: 'Upcoming Activity Overview Test',
    });

    const res = await request(app)
      .get('/campaigns/overview/upcoming-activity')
      .set('Authorization', `Bearer ${shopAStaffToken}`);

    expect(res.status).toBe(200);
    expect(res.body.activities).toBeDefined();
    expect(Array.isArray(res.body.activities)).toBe(true);
    expect(res.body.activities.length).toBeGreaterThan(0);

    const act = res.body.activities[0];
    expect(act.executionId).toBeDefined();
    expect(act.campaignName).toBeDefined();
    expect(act.customerName).toBeDefined();
    expect(act.maskedPhone).toBeDefined();
    expect(act.localDate).toBeDefined();
    expect(act.localTime).toBeDefined();
  });
});

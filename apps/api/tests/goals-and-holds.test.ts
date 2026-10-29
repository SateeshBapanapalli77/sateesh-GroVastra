import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app';
import { connectToDatabase, disconnectDatabase } from '../src/db/connection';
import { seedDatabase } from '../src/db/seed';
import {
  CampaignModel,
  CampaignVersionModel,
  CampaignControlGateModel,
  CampaignEnrollmentModel,
  CampaignExecutionModel,
  CampaignDeliveryIntentModel,
  CampaignGoalEventModel,
  CampaignContactGateModel,
  AuditLogModel,
  SrcCustomerModel,
} from '../src/db/models';
import { authService } from '../src/services/auth.service';
import { clock } from '../src/services/clock';
import { workerService } from '../src/services/worker';
import { plannerService } from '../src/services/planner/planner.service';
import { setDispatchPort, resetDispatchPort } from '../src/services/dispatch/dispatch-port';
import {
  EXECUTION_STATE,
  EXECUTION_REASONS,
  DELIVERY_INTENT_STATE,
  PREREQUISITE,
} from '@grovastra/shared';
import { destinationHash, encryptPhone, maskPhone, normalizePhoneNumber } from '../src/utils/crypto';

describe('GroVastra Goal Events, Hold Resolution, Reason Precedence & p33 Lifecycle (Spec p11, p20, p26, p33, A11, A12)', () => {
  const app = createApp();

  const tenantId = 'shop_a';
  let ownerToken: string;
  let adminToken: string;
  let staffToken: string;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.DISPATCH_MODE = 'dry';
    process.env.ALLOW_TEST_CATEGORY_MISMATCH = 'true';

    await connectToDatabase();
    await seedDatabase('base');

    ownerToken = authService.signToken({
      userId: 'usr_owner_01',
      tenantId,
      role: 'owner',
      branchIds: ['branch_main'],
      email: 'owner@shop-a.com',
    });

    adminToken = authService.signToken({
      userId: 'usr_admin_01',
      tenantId,
      role: 'admin',
      branchIds: ['branch_main'],
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
    resetDispatchPort();
    await disconnectDatabase();
  });

  beforeEach(async () => {
    clock.resetOffset();
    process.env.DISPATCH_MODE = 'dry';
    process.env.ALLOW_TEST_CATEGORY_MISMATCH = 'true';

    // Clear test-specific collections
    await CampaignGoalEventModel.deleteMany({ tenantId });

    // Mock dispatch port to simulate provider acceptance and update execution record
    setDispatchPort({
      dispatch: async (intent) => {
        const wamid = `wamid.MOCK_${Date.now()}_${Math.random().toString(36).substring(7)}`;
        await CampaignExecutionModel.updateOne(
          { tenantId: intent.tenantId, executionId: intent.executionId },
          { $set: { state: EXECUTION_STATE.PROVIDER_ACCEPTED, providerMessageId: wamid } }
        );
        await CampaignDeliveryIntentModel.updateOne(
          { tenantId: intent.tenantId, executionId: intent.executionId },
          { $set: { state: DELIVERY_INTENT_STATE.SUBMITTED, providerMessageId: wamid } }
        );
        return { success: true, mode: 'dry', status: 'ACCEPTED', providerMessageId: wamid };
      },
    });
  });

  // =========================================================================
  // 1. ROLE PERMISSIONS & ENDPOINT CONTRACTS (Spec p26, Assumptions ASM-042)
  // =========================================================================
  describe('Role-Based Access Control for Hold Resolution and Marking Goals', () => {
    const testEnrollmentId = 'enr_role_test_001';
    const testCampaignId = 'cmp_role_test';

    beforeEach(async () => {
      await CampaignEnrollmentModel.deleteMany({ tenantId, enrollmentId: testEnrollmentId });
      await CampaignEnrollmentModel.create({
        tenantId,
        enrollmentId: testEnrollmentId,
        enrollmentKey: `${tenantId}:${testCampaignId}:cus_role_test:birthday:2026`,
        campaignId: testCampaignId,
        campaignVersionId: `${testCampaignId}_v1`,
        campaignVersion: 1,
        customerId: 'cus_role_test',
        occurrenceId: 'birthday:2026',
        sourceRef: { type: 'birthday', id: 'cus_role_test', version: 1 },
        occasionLocalDate: '2026-11-20',
        status: 'ACTIVE',
        replyHoldAt: new Date('2026-11-01T10:00:00Z'),
        replyAttribution: 'CAMPAIGN',
        matchExplanation: 'Upcoming birthday test',
      });
    });

    it('requires authentication for both endpoints (returns 401 Unauthorized)', async () => {
      const resHold = await request(app)
        .post(`/enrollments/${testEnrollmentId}/resolve-hold`)
        .send({ cause: 'Manual resolution' });
      expect(resHold.status).toBe(401);

      const resGoal = await request(app)
        .post(`/enrollments/${testEnrollmentId}/mark-goal`)
        .send({ cause: 'Manual conversion' });
      expect(resGoal.status).toBe(401);
    });

    it('allows owner, admin, and staff to resolve holds (Spec p26)', async () => {
      // Staff can resolve hold
      const staffRes = await request(app)
        .post(`/enrollments/${testEnrollmentId}/resolve-hold`)
        .set('Authorization', `Bearer ${staffToken}`)
        .send({ cause: 'Staff called customer and resolved questions' });

      expect(staffRes.status).toBe(200);
      expect(staffRes.body.enrollment.replyHoldAt).toBeNull();
      expect(staffRes.body.enrollment.holdResolvedBy).toBe('usr_staff_01');
      expect(staffRes.body.enrollment.holdResolutionCause).toBe('Staff called customer and resolved questions');

      // Verify audit log
      const audit = await AuditLogModel.findOne({
        tenantId,
        action: 'ENROLLMENT_HOLD_RESOLVED',
        'metadata.enrollmentId': testEnrollmentId,
      });
      expect(audit).not.toBeNull();
      expect(audit?.userId).toBe('usr_staff_01');
    });

    it('allows owner and admin to mark goals, but strictly FORBIDS staff (403 Forbidden)', async () => {
      // 1. Staff attempt to mark goal -> 403 Forbidden
      const staffRes = await request(app)
        .post(`/enrollments/${testEnrollmentId}/mark-goal`)
        .set('Authorization', `Bearer ${staffToken}`)
        .send({ cause: 'Staff marking goal' });

      expect(staffRes.status).toBe(403);
      expect(staffRes.body.error.code).toBe('FORBIDDEN');

      // 2. Admin can mark goal
      const adminRes = await request(app)
        .post(`/enrollments/${testEnrollmentId}/mark-goal`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          orderRef: 'ord_admin_001',
          cause: 'Admin verified in-store billing',
          supportingRecord: 'INV-8899',
        });

      expect(adminRes.status).toBe(200);
      expect(adminRes.body.enrollment.goalReachedAt).not.toBeNull();
      expect(adminRes.body.enrollment.goalOrderRef).toBe('ord_admin_001');
      expect(adminRes.body.goalEvent.orderRef).toBe('ord_admin_001');

      // Verify durable campaignGoalEvents collection entry
      const goalDoc = await CampaignGoalEventModel.findOne({
        tenantId,
        enrollmentId: testEnrollmentId,
      });
      expect(goalDoc).not.toBeNull();
      expect(goalDoc?.recordedBy).toBe('usr_admin_01');
      expect(goalDoc?.orderRef).toBe('ord_admin_001');
      expect(goalDoc?.supportingRecord).toBe('INV-8899');

      // Verify audit log
      const audit = await AuditLogModel.findOne({
        tenantId,
        action: 'ENROLLMENT_GOAL_MARKED',
        'metadata.enrollmentId': testEnrollmentId,
      });
      expect(audit).not.toBeNull();
      expect(audit?.userId).toBe('usr_admin_01');
    });

    it('rejects resolving hold when enrollment is not on hold (returns 400)', async () => {
      // Clear hold first
      await CampaignEnrollmentModel.updateOne(
        { tenantId, enrollmentId: testEnrollmentId },
        { $set: { replyHoldAt: null } }
      );

      const res = await request(app)
        .post(`/enrollments/${testEnrollmentId}/resolve-hold`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ cause: 'Trying to resolve non-held enrollment' });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/not currently on hold/i);
    });

    it('requires cause to resolve hold (Zod validation)', async () => {
      const res = await request(app)
        .post(`/enrollments/${testEnrollmentId}/resolve-hold`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ cause: '' });

      expect(res.status).toBe(400);
    });
  });

  // =========================================================================
  // 2. A11 & FUTURE-ONLY RE-EVALUATION (Spec p11, p20, QA Matrix A11)
  // =========================================================================
  describe('A11: Hold Resolution & Future-Only Re-evaluation (Missed Steps Never Replay)', () => {
    const holdCampaignId = 'cmp_a11_hold_test';
    const holdEnrollmentId = 'enr_a11_hold_001';
    const step1Id = 'exe_a11_invitation';
    const step2Id = 'exe_a11_followup';
    const step3Id = 'exe_a11_greeting';

    beforeEach(async () => {
      await CampaignEnrollmentModel.deleteMany({ tenantId, campaignId: holdCampaignId });
      await CampaignExecutionModel.deleteMany({ tenantId, campaignId: holdCampaignId });

      await CampaignEnrollmentModel.create({
        tenantId,
        enrollmentId: holdEnrollmentId,
        enrollmentKey: `${tenantId}:${holdCampaignId}:cus_a11:birthday:2026`,
        campaignId: holdCampaignId,
        campaignVersionId: `${holdCampaignId}_v1`,
        campaignVersion: 1,
        customerId: 'cus_a11',
        occurrenceId: 'birthday:2026',
        sourceRef: { type: 'birthday', id: 'cus_a11', version: 1 },
        occasionLocalDate: '2026-11-20',
        status: 'ACTIVE',
        replyHoldAt: new Date('2026-11-02T10:00:00Z'),
        replyAttribution: 'CAMPAIGN',
        matchExplanation: 'Upcoming birthday test',
      });

      // Step 1: Already accepted/sent in past
      await CampaignExecutionModel.create({
        tenantId,
        executionId: step1Id,
        executionKey: `${holdEnrollmentId}:invitation`,
        campaignId: holdCampaignId,
        enrollmentId: holdEnrollmentId,
        stepId: 'invitation',
        stepName: 'Occasion Invitation',
        dueAt: new Date('2026-11-01T04:30:00Z'),
        originalDueAt: new Date('2026-11-01T04:30:00Z'),
        expiresAt: new Date('2026-11-01T06:30:00Z'),
        localDate: '2026-11-01',
        localTime: '10:00',
        timezone: 'Asia/Kolkata',
        state: EXECUTION_STATE.PROVIDER_ACCEPTED,
        providerMessageId: 'wamid.A11_STEP1',
        prerequisite: PREREQUISITE.NONE,
      });

      // Step 2: Scheduled in past (e.g. 2026-11-08) - elapsed while customer was on hold
      await CampaignExecutionModel.create({
        tenantId,
        executionId: step2Id,
        executionKey: `${holdEnrollmentId}:followup`,
        campaignId: holdCampaignId,
        enrollmentId: holdEnrollmentId,
        stepId: 'followup',
        stepName: 'Friendly Reminder',
        dueAt: new Date('2026-11-08T04:30:00Z'),
        originalDueAt: new Date('2026-11-08T04:30:00Z'),
        expiresAt: new Date('2026-11-08T06:30:00Z'),
        localDate: '2026-11-08',
        localTime: '10:00',
        timezone: 'Asia/Kolkata',
        state: EXECUTION_STATE.SCHEDULED,
        prerequisite: PREREQUISITE.NONE,
      });

      // Step 3: Scheduled in future (2026-11-20)
      await CampaignExecutionModel.create({
        tenantId,
        executionId: step3Id,
        executionKey: `${holdEnrollmentId}:greeting`,
        campaignId: holdCampaignId,
        enrollmentId: holdEnrollmentId,
        stepId: 'greeting',
        stepName: 'Birthday Greeting',
        dueAt: new Date('2026-11-20T04:30:00Z'),
        originalDueAt: new Date('2026-11-20T04:30:00Z'),
        expiresAt: new Date('2026-11-20T06:30:00Z'),
        localDate: '2026-11-20',
        localTime: '10:00',
        timezone: 'Asia/Kolkata',
        state: EXECUTION_STATE.SCHEDULED,
        prerequisite: PREREQUISITE.NONE,
      });
    });

    it('resolving hold marks elapsed pending steps as SKIPPED and preserves future steps (Spec p11, p20)', async () => {
      // Set current clock to 2026-11-10 (Step 2 has elapsed, Step 3 is future)
      const now = new Date('2026-11-10T10:00:00Z');
      clock.setSystemTime(now);

      const res = await request(app)
        .post(`/enrollments/${holdEnrollmentId}/resolve-hold`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          cause: 'Customer confirmed they wish to receive birthday wishes',
          supportingRecord: 'Call Note #992',
        });

      expect(res.status).toBe(200);
      expect(res.body.enrollment.replyHoldAt).toBeNull();
      expect(res.body.enrollment.holdResolvedAt).not.toBeNull();
      expect(res.body.enrollment.holdResolutionCause).toBe(
        'Customer confirmed they wish to receive birthday wishes'
      );

      // Step 2 (elapsed): MUST NOT replay! Must be SKIPPED
      const step2 = await CampaignExecutionModel.findOne({ tenantId, executionId: step2Id });
      expect(step2?.state).toBe(EXECUTION_STATE.SKIPPED);
      expect(step2?.skipReason).toMatch(/Elapsed step prior to evaluation instant/i);

      // Step 3 (future): Must remain SCHEDULED
      const step3 = await CampaignExecutionModel.findOne({ tenantId, executionId: step3Id });
      expect(step3?.state).toBe(EXECUTION_STATE.SCHEDULED);
    });
  });

  // =========================================================================
  // 3. A12 & GOAL SEMANTICS (Spec p11, QA Matrix A12)
  // =========================================================================
  describe('A12: Goal Semantics & Stop-on-Goal Rules (Delivery Alone Never Creates a Goal)', () => {
    const goalCampaignId = 'cmp_a12_goal_test';
    const goalEnrollmentId = 'enr_a12_goal_001';
    const step1Id = 'exe_a12_invitation';
    const step2Id = 'exe_a12_followup';
    const step3Id = 'exe_a12_greeting';

    beforeEach(async () => {
      await CampaignModel.deleteMany({ tenantId, campaignId: goalCampaignId });
      await CampaignControlGateModel.deleteMany({ tenantId, campaignId: goalCampaignId });
      await CampaignEnrollmentModel.deleteMany({ tenantId, campaignId: goalCampaignId });
      await CampaignExecutionModel.deleteMany({ tenantId, campaignId: goalCampaignId });
      await CampaignVersionModel.deleteMany({ tenantId, campaignId: goalCampaignId });

      await CampaignModel.create({
        tenantId,
        campaignId: goalCampaignId,
        name: 'A12 Test Campaign',
        presetId: 'birthday',
        status: 'ACTIVE',
        activeVersionId: `${goalCampaignId}_v1`,
        draftVersion: 1,
        pauseGeneration: 0,
        enabledBranches: ['branch_main'],
      });

      await CampaignControlGateModel.create({
        tenantId,
        campaignId: goalCampaignId,
        pauseGeneration: 0,
        version: 1,
      });

      await SrcCustomerModel.updateOne(
        { tenantId, customerId: 'cus_a12' },
        {
          $set: {
            tenantId,
            customerId: 'cus_a12',
            firstName: 'A12Customer',
            status: 'ACTIVE',
            destination: {
              encryptedPhone: encryptPhone('919876543210'),
              destinationHash: destinationHash(normalizePhoneNumber('919876543210')),
              masked: maskPhone('919876543210'),
              verified: true,
              version: 1,
            },
            birthday: { month: 11, day: 20 },
            consent: { marketingOptIn: true, channelSuppressed: false },
            branchId: 'branch_main',
            language: 'en',
            version: 1,
            isLive: false,
          },
        },
        { upsert: true }
      );

      await CampaignVersionModel.create({
        tenantId,
        campaignId: goalCampaignId,
        version: 1,
        name: 'A12 Test Campaign',
        industry: 'BOUTIQUE',
        purpose: 'MARKETING',
        trigger: { type: 'ANNUAL_DATE', field: 'customer.birthday', leapDayPolicy: 'FEB_28' },
        audience: { mode: 'ALL_ELIGIBLE' },
        goal: { type: 'OCCASION_TAGGED_OR_STAFF_COMPLETED' },
        isPublished: true,
        timezone: 'Asia/Kolkata',
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
            stepId: 'followup',
            stepName: 'Sales Followup',
            offsetDays: -7,
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
            stepName: 'Birthday Greeting',
            offsetDays: 0,
            localTime: '10:00',
            prerequisite: 'NONE',
            templateRef: { id: 'tpl_hello_world', revision: 1, language: 'en_US' },
            bindings: {},
            stopOnReply: false,
            stopOnGoal: false, // Greetings do NOT stop on goal! (Spec p11)
            maxLatenessMinutes: 120,
          },
        ],
      });

      await CampaignEnrollmentModel.create({
        tenantId,
        enrollmentId: goalEnrollmentId,
        enrollmentKey: `${tenantId}:${goalCampaignId}:cus_a12:birthday:2026`,
        campaignId: goalCampaignId,
        campaignVersionId: `${goalCampaignId}_v1`,
        campaignVersion: 1,
        customerId: 'cus_a12',
        occurrenceId: 'birthday:2026',
        sourceRef: { type: 'birthday', id: 'cus_a12', version: 1 },
        occasionLocalDate: '2026-11-20',
        status: 'ACTIVE',
        goalReachedAt: null,
        matchExplanation: 'Upcoming birthday test',
      });

      // Step 1: Delivered
      await CampaignExecutionModel.create({
        tenantId,
        executionId: step1Id,
        executionKey: `${goalEnrollmentId}:invitation`,
        campaignId: goalCampaignId,
        enrollmentId: goalEnrollmentId,
        stepId: 'invitation',
        stepName: 'Occasion Invitation',
        dueAt: new Date('2026-11-06T04:30:00Z'),
        originalDueAt: new Date('2026-11-06T04:30:00Z'),
        expiresAt: new Date('2026-11-06T06:30:00Z'),
        localDate: '2026-11-06',
        localTime: '10:00',
        timezone: 'Asia/Kolkata',
        state: EXECUTION_STATE.DELIVERED,
        providerMessageId: 'wamid.A12_INVITE',
        prerequisite: PREREQUISITE.NONE,
      });

      // Step 2: Followup (stopOnGoal: true)
      await CampaignExecutionModel.create({
        tenantId,
        executionId: step2Id,
        executionKey: `${goalEnrollmentId}:followup`,
        campaignId: goalCampaignId,
        enrollmentId: goalEnrollmentId,
        stepId: 'followup',
        stepName: 'Sales Followup',
        dueAt: new Date('2026-11-13T04:30:00Z'),
        originalDueAt: new Date('2026-11-13T04:30:00Z'),
        expiresAt: new Date('2026-11-13T06:30:00Z'),
        localDate: '2026-11-13',
        localTime: '10:00',
        timezone: 'Asia/Kolkata',
        state: EXECUTION_STATE.SCHEDULED,
        prerequisite: PREREQUISITE.NONE,
      });

      // Step 3: Greeting (stopOnGoal: false)
      await CampaignExecutionModel.create({
        tenantId,
        executionId: step3Id,
        executionKey: `${goalEnrollmentId}:greeting`,
        campaignId: goalCampaignId,
        enrollmentId: goalEnrollmentId,
        stepId: 'greeting',
        stepName: 'Birthday Greeting',
        dueAt: new Date('2026-11-20T04:30:00Z'),
        originalDueAt: new Date('2026-11-20T04:30:00Z'),
        expiresAt: new Date('2026-11-20T06:30:00Z'),
        localDate: '2026-11-20',
        localTime: '10:00',
        timezone: 'Asia/Kolkata',
        state: EXECUTION_STATE.SCHEDULED,
        prerequisite: PREREQUISITE.NONE,
      });
    });

    it('A12: delivery alone never creates a goal (Spec p11)', async () => {
      // Step 1 delivery was recorded, but enrollment.goalReachedAt must remain null
      const enrollment = await CampaignEnrollmentModel.findOne({ tenantId, enrollmentId: goalEnrollmentId });
      expect(enrollment?.goalReachedAt).toBeNull();
      const goalEvents = await CampaignGoalEventModel.find({ tenantId, enrollmentId: goalEnrollmentId });
      expect(goalEvents.length).toBe(0);
    });

    it('marking goal skips sales follow-up (stopOnGoal: true) but allows greeting to send (stopOnGoal: false)', async () => {
      // 1. Mark goal via API
      const markRes = await request(app)
        .post(`/enrollments/${goalEnrollmentId}/mark-goal`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          orderRef: 'ord_silk_saree_99',
          cause: 'Customer bought anniversary saree in boutique',
          supportingRecord: 'BILL-4040',
        });

      expect(markRes.status).toBe(200);
      expect(markRes.body.enrollment.goalReachedAt).not.toBeNull();
      expect(markRes.body.enrollment.goalOrderRef).toBe('ord_silk_saree_99');

      // 2. Advance clock to Step 2 due date (2026-11-13 10:00 IST = 04:30 UTC)
      const dueStep2 = new Date('2026-11-13T04:35:00Z');
      clock.setSystemTime(dueStep2);

      await workerService.runWorkerCycle({
        tenantId,
        campaignId: goalCampaignId,
        nowOverride: dueStep2,
      });

      // Step 2 must be SKIPPED with reason SKIPPED_GOAL_REACHED
      const step2 = await CampaignExecutionModel.findOne({ tenantId, executionId: step2Id });
      expect(step2?.state).toBe(EXECUTION_STATE.SKIPPED);
      expect(step2?.skipReason).toBe(EXECUTION_REASONS.SKIPPED_GOAL_REACHED);

      // 3. Advance clock to Step 3 due date (2026-11-20 10:00 IST = 04:30 UTC)
      const dueStep3 = new Date('2026-11-20T04:35:00Z');
      clock.setSystemTime(dueStep3);

      await workerService.runWorkerCycle({
        tenantId,
        campaignId: goalCampaignId,
        nowOverride: dueStep3,
      });

      // Step 3 (greeting, stopOnGoal: false) MUST NOT be skipped by goal reached!
      const step3 = await CampaignExecutionModel.findOne({ tenantId, executionId: step3Id });
      expect(step3?.state).not.toBe(EXECUTION_STATE.SKIPPED);
      expect(step3?.skipReason).toBeNull();
      expect(step3?.state).toBe(EXECUTION_STATE.PROVIDER_ACCEPTED);
    });
  });

  // =========================================================================
  // 4. SPEC P33 WORKED EXAMPLE: LAKSHMI TIMELINE END-TO-END WALKTHROUGH
  // =========================================================================
  describe('Spec p33 Worked Example: Full End-to-End Walkthrough (Lakshmi)', () => {
    const p33CampaignId = 'cmp_p33_lakshmi_birthday';

    beforeEach(async () => {
      // Clean up previous runs
      await CampaignModel.deleteMany({ tenantId, campaignId: p33CampaignId });
      await CampaignControlGateModel.deleteMany({ tenantId, campaignId: p33CampaignId });
      await CampaignVersionModel.deleteMany({ tenantId, campaignId: p33CampaignId });
      await CampaignEnrollmentModel.deleteMany({ tenantId });
      await CampaignExecutionModel.deleteMany({ tenantId });
      await CampaignDeliveryIntentModel.deleteMany({ tenantId });
      await CampaignGoalEventModel.deleteMany({ tenantId });
      await CampaignContactGateModel.deleteMany({ tenantId });
    });

    it('reproduces the complete p33 timeline step by step: invitation -> reply hold -> goal reached -> precedence -> greeting -> completed', async () => {
      // -----------------------------------------------------------------------
      // Step 1: 15 Dec 2026: owner activates
      // Validate settings/templates; publish v1; calendar planner finds 2027 occurrence.
      // Campaign ACTIVE; enrollment birthday:2027; three stable step records.
      // -----------------------------------------------------------------------
      const dec15 = new Date('2026-12-15T10:00:00Z');
      clock.setSystemTime(dec15);

      await CampaignModel.create({
        tenantId,
        campaignId: p33CampaignId,
        name: 'Lakshmi Birthday Campaign v1',
        presetId: 'birthday',
        status: 'ACTIVE',
        activeVersionId: `${p33CampaignId}_v1`,
        draftVersion: 1,
        pauseGeneration: 0,
        enabledBranches: ['branch_main'],
      });

      await CampaignControlGateModel.create({
        tenantId,
        campaignId: p33CampaignId,
        pauseGeneration: 0,
        version: 1,
      });

      await CampaignVersionModel.create({
        tenantId,
        campaignId: p33CampaignId,
        version: 1,
        name: 'Lakshmi Birthday Campaign v1',
        industry: 'BOUTIQUE',
        purpose: 'MARKETING',
        trigger: {
          type: 'ANNUAL_DATE',
          field: 'customer.birthday',
          leapDayPolicy: 'FEB_28',
        },
        audience: { mode: 'ALL_ELIGIBLE' },
        goal: { type: 'OCCASION_TAGGED_OR_STAFF_COMPLETED' },
        isPublished: true,
        timezone: 'Asia/Kolkata',
        steps: [
          {
            stepId: 'invitation',
            stepName: 'Occasion Invitation',
            offsetDays: -14, // 14 days before 5 Jan = 22 Dec 2026
            localTime: '10:00',
            prerequisite: 'NONE',
            templateRef: { id: 'tpl_hello_world', revision: 1, language: 'en_US' },
            bindings: {},
            stopOnReply: true,
            stopOnGoal: true,
            maxLatenessMinutes: 120,
          },
          {
            stepId: 'followup',
            stepName: 'Friendly Reminder',
            offsetDays: -7, // 7 days before 5 Jan = 29 Dec 2026
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
            stepName: 'Birthday Greeting',
            offsetDays: 0, // 0 days before 5 Jan = 5 Jan 2027
            localTime: '10:00',
            prerequisite: 'NONE',
            templateRef: { id: 'tpl_hello_world', revision: 1, language: 'en_US' },
            bindings: {},
            stopOnReply: false,
            stopOnGoal: false, // Greetings do not stop on goal! (Spec p11, p33)
            maxLatenessMinutes: 120,
          },
        ],
      });

      // Run calendar planner to find 2027 occurrence
      const planRes = await plannerService.planCampaign(tenantId, p33CampaignId, {
        nowOverride: dec15,
        force: true,
      });

      expect(planRes.enrolledCount).toBeGreaterThanOrEqual(1);

      // Verify Lakshmi is enrolled under birthday:2027
      const enrollment = await CampaignEnrollmentModel.findOne({
        tenantId,
        campaignId: p33CampaignId,
        customerId: 'cus_lakshmi',
      });
      expect(enrollment).not.toBeNull();
      expect(enrollment?.occurrenceId).toBe('birthday:2027');
      expect(enrollment?.occasionLocalDate).toBe('2027-01-05');
      expect(enrollment?.status).toBe('ACTIVE');

      const enrollmentId = enrollment!.enrollmentId;

      // Verify 3 stable step executions planned
      const steps = await CampaignExecutionModel.find({
        tenantId,
        enrollmentId,
      }).sort({ dueAt: 1 });
      expect(steps.length).toBe(3);
      expect(steps[0].stepId).toBe('invitation');
      expect(steps[1].stepId).toBe('followup');
      expect(steps[2].stepId).toBe('greeting');

      // -----------------------------------------------------------------------
      // Step 2: 22 Dec 2026 10:00 IST (04:30 UTC): Invitation due.
      // Recheck customer, offer, caps and template; bind current fields; submit one message.
      // exe_invitation becomes accepted with provider ID; delivery evidence arrives separately.
      // -----------------------------------------------------------------------
      const dec22 = new Date('2026-12-22T04:35:00Z');
      clock.setSystemTime(dec22);

      const workerRes1 = await workerService.runWorkerCycle({
        tenantId,
        campaignId: p33CampaignId,
        nowOverride: dec22,
      });

      const invitationStep = await CampaignExecutionModel.findOne({
        tenantId,
        enrollmentId,
        stepId: 'invitation',
      });
      expect(workerRes1.dispatchedCount).toBeGreaterThanOrEqual(1);
      expect(invitationStep?.state).toBe(EXECUTION_STATE.PROVIDER_ACCEPTED);
      expect(invitationStep?.providerMessageId).toBeTruthy();

      // -----------------------------------------------------------------------
      // Step 3: 23 Dec: customer replies
      // Record reply and create staff-handling hold; invitation history retained.
      // replyHoldAt set; future follow-up remains scheduled with a hold indicator.
      // -----------------------------------------------------------------------
      const dec23 = new Date('2026-12-23T11:00:00Z');
      clock.setSystemTime(dec23);

      // Simulate customer reply recorded on enrollment
      await CampaignEnrollmentModel.updateOne(
        { tenantId, enrollmentId },
        {
          $set: {
            replyHoldAt: dec23,
            replyAttribution: 'CAMPAIGN',
            replyContextMessageId: invitationStep?.providerMessageId,
          },
        }
      );

      const enrollmentAfterReply = await CampaignEnrollmentModel.findOne({ tenantId, enrollmentId });
      expect(enrollmentAfterReply?.replyHoldAt).toEqual(dec23);
      expect(enrollmentAfterReply?.replyAttribution).toBe('CAMPAIGN');

      // Follow-up remains scheduled with hold indicator
      const followupBeforeGoal = await CampaignExecutionModel.findOne({
        tenantId,
        enrollmentId,
        stepId: 'followup',
      });
      expect(followupBeforeGoal?.state).toBe(EXECUTION_STATE.SCHEDULED);

      // -----------------------------------------------------------------------
      // Step 4: 24 Dec: occasion order completed / staff-marked goal
      // Match explicit birthday occasion reference or staff-marked goal.
      // goalReachedAt with order reference; sales follow-up remains stopped.
      // -----------------------------------------------------------------------
      const dec24 = new Date('2026-12-24T12:00:00Z');
      clock.setSystemTime(dec24);

      const goalRes = await request(app)
        .post(`/enrollments/${enrollmentId}/mark-goal`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          orderRef: 'ord_lakshmi_001',
          cause: 'Explicit birthday occasion order completed in store',
          supportingRecord: 'ord_lakshmi_001',
        });

      expect(goalRes.status).toBe(200);
      expect(goalRes.body.enrollment.goalReachedAt).not.toBeNull();
      expect(goalRes.body.enrollment.goalOrderRef).toBe('ord_lakshmi_001');

      // -----------------------------------------------------------------------
      // Step 5: 29 Dec: follow-up date (10:00 IST = 04:30 UTC)
      // Evaluate current stops; do not send sales reminder.
      // Reason Precedence: SKIPPED_GOAL_REACHED (goal precedes reply hold); reply evidence remains visible.
      // -----------------------------------------------------------------------
      const dec29 = new Date('2026-12-29T04:35:00Z');
      clock.setSystemTime(dec29);

      const workerRes2 = await workerService.runWorkerCycle({
        tenantId,
        campaignId: p33CampaignId,
        nowOverride: dec29,
      });
      expect(workerRes2.skippedCount).toBeGreaterThanOrEqual(1);

      const followupStep = await CampaignExecutionModel.findOne({
        tenantId,
        enrollmentId,
        stepId: 'followup',
      });
      expect(followupStep?.state).toBe(EXECUTION_STATE.SKIPPED);
      // REASON PRECEDENCE CHECK (Spec p33): Goal precedes reply hold!
      expect(followupStep?.skipReason).toBe(EXECUTION_REASONS.SKIPPED_GOAL_REACHED);

      // Reply evidence remains visible on enrollment! (Spec p33)
      const enrollmentAtDec29 = await CampaignEnrollmentModel.findOne({ tenantId, enrollmentId });
      expect(enrollmentAtDec29?.replyHoldAt).not.toBeNull();
      expect(enrollmentAtDec29?.replyAttribution).toBe('CAMPAIGN');
      expect(enrollmentAtDec29?.goalReachedAt).not.toBeNull();
      expect(enrollmentAtDec29?.goalOrderRef).toBe('ord_lakshmi_001');

      // -----------------------------------------------------------------------
      // Step 6: 5 Jan 2027: optional greeting (10:00 IST = 04:30 UTC)
      // If stop flags allow and permission/caps/template remain valid, send greeting.
      // One greeting execution; no second invitation. Enrollment completes after all steps terminal.
      // -----------------------------------------------------------------------
      const jan5 = new Date('2027-01-05T04:35:00Z');
      clock.setSystemTime(jan5);

      const workerRes3 = await workerService.runWorkerCycle({
        tenantId,
        campaignId: p33CampaignId,
        nowOverride: jan5,
      });
      expect(workerRes3.dispatchedCount).toBeGreaterThanOrEqual(1);

      const greetingStep = await CampaignExecutionModel.findOne({
        tenantId,
        enrollmentId,
        stepId: 'greeting',
      });
      expect(greetingStep?.state).toBe(EXECUTION_STATE.PROVIDER_ACCEPTED);
      expect(greetingStep?.providerMessageId).toBeTruthy();

      // Check enrollment lifecycle: All steps are terminal (PROVIDER_ACCEPTED, SKIPPED, PROVIDER_ACCEPTED)
      // Run completion check
      const detailRes = await request(app)
        .get(`/enrollments/${enrollmentId}`)
        .set('Authorization', `Bearer ${ownerToken}`);

      expect(detailRes.status).toBe(200);
      expect(detailRes.body.enrollment.status).toBe('COMPLETED');
      expect(detailRes.body.goalEvents.length).toBeGreaterThanOrEqual(1);
      expect(detailRes.body.goalEvents[0].orderRef).toBe('ord_lakshmi_001');
    });
  });
});

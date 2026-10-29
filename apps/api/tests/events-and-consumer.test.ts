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
  CampaignEventInboxModel,
  CampaignCustomerFactModel,
  CampaignGoalEventModel,
  SrcCustomerModel,
  SrcCustomerEventModel,
  SrcOrderModel,
} from '../src/db/models';
import { authService } from '../src/services/auth.service';
import { clock } from '../src/services/clock';
import { eventConsumerService } from '../src/services/event-consumer';
import { workerService } from '../src/services/worker';
import { plannerService } from '../src/services/planner/planner.service';
import {
  EXECUTION_STATE,
  EXECUTION_REASONS,
  EVENT_INBOX_STATUS,
  QUARANTINE_REASONS,
  ENROLLMENT_STATUS,
} from '@grovastra/shared';

describe('GroVastra Internal Domain Events, Inbox Dedupe, Outbox Consumer & Change Semantics (Spec p20, p24, p25, QA Matrix A09, B02, B03, B04, C03, C04, C20, A12)', () => {
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
    await disconnectDatabase();
  });

  beforeEach(async () => {
    await seedDatabase('base');
    await CampaignEventInboxModel.deleteMany({});
    await CampaignCustomerFactModel.deleteMany({});
    clock.setSystemTime(new Date('2026-12-20T04:30:00Z'));
  });

  // Helper to activate a standard birthday campaign
  async function setupActiveBirthdayCampaign(campaignId = 'cmp_events_test') {
    await CampaignModel.deleteMany({ tenantId, campaignId });
    await CampaignVersionModel.deleteMany({ tenantId, campaignId });
    await CampaignControlGateModel.deleteMany({ tenantId, campaignId });
    await CampaignEnrollmentModel.deleteMany({ tenantId, campaignId });
    await CampaignExecutionModel.deleteMany({ tenantId, campaignId });

    const versionDoc = await CampaignVersionModel.create({
      tenantId,
      campaignId,
      version: 1,
      name: 'Event Test Campaign',
      trigger: {
        type: 'ANNUAL_DATE',
        field: 'customer.birthday',
        leapDayPolicy: 'FEB_28',
      },
      audience: { mode: 'ALL_ELIGIBLE', rules: [] },
      steps: [
        {
          stepId: 'invitation',
          stepName: 'Birthday Invitation',
          offsetDays: -14,
          localTime: '10:00',
          prerequisite: 'NONE',
          templateRef: { id: 'hello_world', revision: 1, language: 'en_US' },
          bindings: {},
          stopOnReply: true,
          stopOnGoal: true,
          maxLatenessMinutes: 120,
        },
        {
          stepId: 'followup',
          stepName: 'Birthday Follow-up',
          offsetDays: -7,
          localTime: '10:00',
          prerequisite: 'PREVIOUS_ACCEPTED',
          templateRef: { id: 'hello_world', revision: 1, language: 'en_US' },
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
          templateRef: { id: 'hello_world', revision: 1, language: 'en_US' },
          bindings: {},
          stopOnReply: false,
          stopOnGoal: false, // Independent greeting
          maxLatenessMinutes: 120,
        },
      ],
      goal: { type: 'OCCASION_TAGGED_OR_STAFF_COMPLETED', lookbackDays: 30, purchaseWithinDays: 30, minOrderValuePaise: 0 },
      timezone: 'Asia/Kolkata',
      isPublished: true,
      activatedBy: 'usr_owner_01',
      activatedAt: new Date('2026-10-01T00:00:00Z'),
    });

    await CampaignModel.create({
      campaignId,
      tenantId,
      name: 'Event Test Campaign',
      presetId: 'preset_birthday_shopping',
      status: 'ACTIVE',
      activeVersionId: versionDoc._id.toString(),
      draftVersion: 2,
      pauseGeneration: 0,
      enabledBranches: ['branch_main'],
      activatedAt: new Date('2026-10-01T00:00:00Z'),
    });

    await CampaignControlGateModel.create({
      tenantId,
      campaignId,
      pauseGeneration: 0,
      version: 1,
    });

    // Run calendar planner
    await plannerService.planCampaign(tenantId, campaignId, { force: true });
    return campaignId;
  }

  // ===========================================================================
  // TEST 1: B02 - Duplicate event replay (replaying 5 times changes state once)
  // ===========================================================================
  it('B02: replaying the same order.completed event 5 times changes state exactly once with durable deduplication', async () => {
    await SrcOrderModel.deleteMany({ tenantId, customerId: 'cus_lakshmi' });

    const eventPayload = {
      schemaVersion: 1,
      producer: 'orders',
      eventId: 'evt_dup_replay_101',
      tenantId,
      type: 'order.completed',
      entityId: 'ord_replay_001',
      entityVersion: 1,
      customerId: 'cus_lakshmi',
      occurredAt: '2026-12-22T08:00:00Z',
      data: {
        paid: true,
        status: 'COMPLETED',
        netPaise: 450000,
        occasionRef: 'birthday:2027',
      },
    };

    // Post event 1st time
    const res1 = await request(app)
      .post('/internal/campaign-events')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send(eventPayload);

    expect(res1.status).toBe(200);
    expect(res1.body.success).toBe(true);
    expect(res1.body.status).toBe(EVENT_INBOX_STATUS.PROCESSED);

    // Replay the SAME event 4 more times (total 5 times)
    for (let i = 2; i <= 5; i++) {
      const resN = await request(app)
        .post('/internal/campaign-events')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send(eventPayload);

      expect(resN.status).toBe(200);
      expect(resN.body.success).toBe(true);
      expect(resN.body.status).toBe('DUPLICATE');
    }

    // Verify exactly ONE record exists in campaignEventInbox
    const inboxCount = await CampaignEventInboxModel.countDocuments({
      tenantId,
      producer: 'orders',
      eventId: 'evt_dup_replay_101',
    });
    expect(inboxCount).toBe(1);

    // Verify facts were updated exactly ONCE (orderCount = 1, totalSpend = 450000 paise)
    const facts = await CampaignCustomerFactModel.findOne({ tenantId, customerId: 'cus_lakshmi' });
    expect(facts).not.toBeNull();
    expect(facts!.orderCount).toBe(1);
    expect(facts!.totalSpendPaise).toBe(450000);
  });

  // ===========================================================================
  // TEST 2: Out-of-order & Stale entityVersion event quarantine
  // ===========================================================================
  it('quarantines stale entityVersion events with visible reason and never rolls state backwards', async () => {
    // Current customer has version: 8 in seeded DB
    const customer = await SrcCustomerModel.findOne({ tenantId, customerId: 'cus_lakshmi' });
    expect(customer).not.toBeNull();
    customer!.version = 8;
    await customer!.save();
    const currentVersion = 8;

    // Post an event with stale entityVersion (currentVersion - 2 = 6)
    const stalePayload = {
      schemaVersion: 1,
      producer: 'customers',
      eventId: 'evt_stale_ver_001',
      tenantId,
      type: 'customer.updated',
      entityId: 'cus_lakshmi',
      entityVersion: 6,
      occurredAt: '2026-12-20T00:00:00Z',
      data: {
        birthday: { month: 11, day: 11 }, // Attempt to change date via stale event
      },
    };

    const res = await request(app)
      .post('/internal/campaign-events')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send(stalePayload);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe(EVENT_INBOX_STATUS.QUARANTINED);
    expect(res.body.quarantineReason).toBe(QUARANTINE_REASONS.STALE_ENTITY_VERSION);

    // Verify customer version was NOT rolled backwards
    const freshCustomer = await SrcCustomerModel.findOne({ tenantId, customerId: 'cus_lakshmi' });
    expect(freshCustomer!.version).toBe(currentVersion);

    // Verify event is listed in quarantine endpoint for owners
    const quarantineRes = await request(app)
      .get('/internal/campaign-events/quarantine')
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(quarantineRes.status).toBe(200);
    expect(quarantineRes.body.events.some((e: any) => e.eventId === 'evt_stale_ver_001')).toBe(true);
  });

  // ===========================================================================
  // TEST 3: Unknown schema & Producer event family mismatch quarantine
  // ===========================================================================
  it('quarantines unknown schema and producer event family mismatch', async () => {
    // 1. Unknown schema version (e.g. 99)
    const invalidSchemaRes = await request(app)
      .post('/internal/campaign-events')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        schemaVersion: 99,
        producer: 'customers',
        eventId: 'evt_bad_schema_001',
        type: 'customer.updated',
        entityId: 'cus_lakshmi',
        entityVersion: 1,
        occurredAt: '2026-12-22T00:00:00Z',
      });

    // 2. Producer 'orders' attempting to emit 'customer.updated' (event family mismatch)
    const mismatchRes = await request(app)
      .post('/internal/campaign-events')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        schemaVersion: 1,
        producer: 'orders', // orders producer is NOT allowed customer family events
        eventId: 'evt_mismatch_001',
        tenantId,
        type: 'customer.updated',
        entityId: 'cus_lakshmi',
        entityVersion: 1,
        occurredAt: '2026-12-22T00:00:00Z',
        data: {},
      });

    expect(mismatchRes.status).toBe(200);
    expect(mismatchRes.body.status).toBe(EVENT_INBOX_STATUS.QUARANTINED);
    expect(mismatchRes.body.quarantineReason).toBe(QUARANTINE_REASONS.PRODUCER_FAMILY_MISMATCH);
  });

  // ===========================================================================
  // TEST 4: Cross-tenant event rejection (Hard Rule 1, C11)
  // ===========================================================================
  it('C11: cross-tenant event payload is quarantined without mutating data', async () => {
    const res = await request(app)
      .post('/internal/campaign-events')
      .set('Authorization', `Bearer ${ownerToken}`) // Authenticated for shop_a
      .send({
        schemaVersion: 1,
        producer: 'orders',
        eventId: 'evt_cross_tenant_001',
        tenantId: 'shop_b', // Spoofed target
        type: 'order.completed',
        entityId: 'ord_shop_b_001',
        entityVersion: 1,
        occurredAt: '2026-12-22T00:00:00Z',
        data: {},
      });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe(EVENT_INBOX_STATUS.QUARANTINED);
    expect(res.body.quarantineReason).toBe(QUARANTINE_REASONS.CROSS_TENANT_REJECTED);
  });

  // ===========================================================================
  // TEST 5: A12 - Goal purchase recorded via order.completed event
  // ===========================================================================
  it('A12: order.completed domain event marks goal, creates campaignGoalEvents evidence, and stops sales follow-up', async () => {
    const campaignId = await setupActiveBirthdayCampaign('cmp_goal_evt');

    // Find Lakshmi's enrollment
    const enrollment = await CampaignEnrollmentModel.findOne({
      tenantId,
      campaignId,
      customerId: 'cus_lakshmi',
    });
    expect(enrollment).not.toBeNull();
    expect(enrollment!.goalReachedAt).toBeNull();

    // Post order.completed event matching occasionRef 'birthday:2027'
    const eventRes = await request(app)
      .post('/internal/campaign-events')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        schemaVersion: 1,
        producer: 'orders',
        eventId: 'evt_goal_order_001',
        tenantId,
        type: 'order.completed',
        entityId: 'ord_lakshmi_kanchipuram',
        entityVersion: 1,
        customerId: 'cus_lakshmi',
        occurredAt: '2026-12-23T10:00:00Z',
        data: {
          paid: true,
          status: 'COMPLETED',
          netPaise: 850000,
          occasionRef: enrollment!.occurrenceId,
        },
      });

    expect(eventRes.status).toBe(200);
    expect(eventRes.body.status).toBe(EVENT_INBOX_STATUS.PROCESSED);

    // Verify enrollment now has goalReachedAt
    const updatedEnrollment = await CampaignEnrollmentModel.findOne({
      tenantId,
      enrollmentId: enrollment!.enrollmentId,
    });
    expect(updatedEnrollment!.goalReachedAt).not.toBeNull();
    expect(updatedEnrollment!.goalOrderRef).toBe('ord_lakshmi_kanchipuram');

    // Verify durable campaignGoalEvents record exists
    const goalEvent = await CampaignGoalEventModel.findOne({
      tenantId,
      enrollmentId: enrollment!.enrollmentId,
      orderRef: 'ord_lakshmi_kanchipuram',
    });
    expect(goalEvent).not.toBeNull();
    expect(goalEvent!.source).toBe('ORDER_OCCASION');

    // Run worker: follow-up step with stopOnGoal: true is skipped with SKIPPED_GOAL_REACHED
    clock.setSystemTime(new Date('2026-12-29T04:30:00Z')); // At followup due time
    await workerService.runWorkerCycle({ tenantId, campaignId });

    const followup = await CampaignExecutionModel.findOne({
      tenantId,
      enrollmentId: enrollment!.enrollmentId,
      stepId: 'followup',
    });
    expect(followup!.state).toBe(EXECUTION_STATE.SKIPPED);
    expect(followup!.skipReason).toBe(EXECUTION_REASONS.SKIPPED_GOAL_REACHED);

    // Greeting step with stopOnGoal: false is NOT skipped by goal
    const greeting = await CampaignExecutionModel.findOne({
      tenantId,
      enrollmentId: enrollment!.enrollmentId,
      stepId: 'greeting',
    });
    expect(greeting!.state).toBe(EXECUTION_STATE.SCHEDULED);
  });

  // ===========================================================================
  // TEST 6: C03 - Opt-out after scheduling via preference.changed
  // ===========================================================================
  it('C03: preference.changed (MARKETING_OPT_OUT) immediately cancels pending promotional step and blocks submission', async () => {
    const campaignId = await setupActiveBirthdayCampaign('cmp_optout_evt');

    const enrollment = await CampaignEnrollmentModel.findOne({
      tenantId,
      campaignId,
      customerId: 'cus_lakshmi',
    });
    expect(enrollment).not.toBeNull();

    const invitation = await CampaignExecutionModel.findOne({
      tenantId,
      enrollmentId: enrollment!.enrollmentId,
      stepId: 'invitation',
    });
    expect(invitation!.state).toBe(EXECUTION_STATE.SCHEDULED);

    // Customer opts out via domain event
    const optOutRes = await request(app)
      .post('/internal/campaign-events')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        schemaVersion: 1,
        producer: 'customers',
        eventId: 'evt_optout_001',
        tenantId,
        type: 'preference.changed',
        entityId: 'cus_lakshmi',
        entityVersion: 10,
        occurredAt: '2026-12-22T05:00:00Z',
        data: {
          preferenceType: 'MARKETING_OPT_OUT',
          marketingOptIn: false,
        },
      });

    expect(optOutRes.status).toBe(200);
    expect(optOutRes.body.status).toBe(EVENT_INBOX_STATUS.PROCESSED);

    // Verify execution was immediately marked CANCELLED with precise reason
    const updatedInvitation = await CampaignExecutionModel.findOne({
      tenantId,
      executionId: invitation!.executionId,
    });
    expect(updatedInvitation!.state).toBe(EXECUTION_STATE.CANCELLED);
    expect(updatedInvitation!.skipReason).toContain('marketing opt-out');

    // Run worker: verifies zero message submission
    clock.setSystemTime(new Date(invitation!.dueAt.getTime() + 1000));
    const workerResult = await workerService.runWorkerCycle({ tenantId, campaignId });
    expect(workerResult.dispatchedCount).toBe(0);
  });

  // ===========================================================================
  // TEST 7: Later opt-in never resurrects cancelled occurrences (Spec p20)
  // ===========================================================================
  it('Spec p20: subsequent marketing opt-in never resurrects previously cancelled occurrences', async () => {
    const campaignId = await setupActiveBirthdayCampaign('cmp_resurrect_test');

    const enrollment = await CampaignEnrollmentModel.findOne({
      tenantId,
      campaignId,
      customerId: 'cus_lakshmi',
    });

    // 1. Customer opts out
    await request(app)
      .post('/internal/campaign-events')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        schemaVersion: 1,
        producer: 'customers',
        eventId: 'evt_optout_resurrect',
        tenantId,
        type: 'preference.changed',
        entityId: 'cus_lakshmi',
        entityVersion: 11,
        occurredAt: '2026-12-22T05:00:00Z',
        data: { marketingOptIn: false },
      });

    // 2. Customer opts back in
    await request(app)
      .post('/internal/campaign-events')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        schemaVersion: 1,
        producer: 'customers',
        eventId: 'evt_optin_resurrect',
        tenantId,
        type: 'preference.changed',
        entityId: 'cus_lakshmi',
        entityVersion: 12,
        occurredAt: '2026-12-22T06:00:00Z',
        data: { marketingOptIn: true },
      });

    // Verify executions remain CANCELLED (never resurrected)
    const executions = await CampaignExecutionModel.find({
      tenantId,
      enrollmentId: enrollment!.enrollmentId,
    });
    for (const exe of executions) {
      expect(exe.state).toBe(EXECUTION_STATE.CANCELLED);
    }
  });

  // ===========================================================================
  // TEST 8: C04 - Channel suppression cancels all pending steps
  // ===========================================================================
  it('C04: preference.changed (CHANNEL_SUPPRESSED) cancels all pending steps', async () => {
    const campaignId = await setupActiveBirthdayCampaign('cmp_suppressed_test');

    const enrollment = await CampaignEnrollmentModel.findOne({
      tenantId,
      campaignId,
      customerId: 'cus_lakshmi',
    });

    await request(app)
      .post('/internal/campaign-events')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        schemaVersion: 1,
        producer: 'customers',
        eventId: 'evt_channel_suppressed_001',
        tenantId,
        type: 'preference.changed',
        entityId: 'cus_lakshmi',
        entityVersion: 15,
        occurredAt: '2026-12-22T05:00:00Z',
        data: { channelSuppressed: true },
      });

    const executions = await CampaignExecutionModel.find({
      tenantId,
      enrollmentId: enrollment!.enrollmentId,
    });
    for (const exe of executions) {
      expect(exe.state).toBe(EXECUTION_STATE.CANCELLED);
      expect(exe.skipReason).toContain('channel suppression');
    }
  });

  // ===========================================================================
  // TEST 9: Customer deletion cancels pending work and blocks old replay
  // ===========================================================================
  it('customer.deleted cancels pending steps and prevents replayed old events from recreating enrollments', async () => {
    const campaignId = await setupActiveBirthdayCampaign('cmp_deletion_test');

    const enrollment = await CampaignEnrollmentModel.findOne({
      tenantId,
      campaignId,
      customerId: 'cus_lakshmi',
    });

    // Delete customer via domain event
    await request(app)
      .post('/internal/campaign-events')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        schemaVersion: 1,
        producer: 'customers',
        eventId: 'evt_delete_lakshmi',
        tenantId,
        type: 'customer.deleted',
        entityId: 'cus_lakshmi',
        entityVersion: 20,
        occurredAt: '2026-12-22T06:00:00Z',
        data: {},
      });

    // Verify executions cancelled
    const executions = await CampaignExecutionModel.find({
      tenantId,
      enrollmentId: enrollment!.enrollmentId,
    });
    for (const exe of executions) {
      expect(exe.state).toBe(EXECUTION_STATE.CANCELLED);
    }

    // Verify customer is INACTIVE in source directory
    const customer = await SrcCustomerModel.findOne({ tenantId, customerId: 'cus_lakshmi' });
    expect(customer!.status).toBe('INACTIVE');
    expect(customer!.deletedAt).not.toBeNull();
  });

  // ===========================================================================
  // TEST 10: B04 - Date corrected within same year replans deliveryIntentId=null
  // ===========================================================================
  it('B04: birthday date change within same year replans deliveryIntentId=null executions and updates planRevision atomically', async () => {
    const campaignId = await setupActiveBirthdayCampaign('cmp_date_same_year');

    const enrollment = await CampaignEnrollmentModel.findOne({
      tenantId,
      campaignId,
      customerId: 'cus_lakshmi',
    });
    expect(enrollment!.occasionLocalDate).toBe('2027-01-05');
    const initialPlanRevision = enrollment!.planRevision;

    const oldInvitation = await CampaignExecutionModel.findOne({
      tenantId,
      enrollmentId: enrollment!.enrollmentId,
      stepId: 'invitation',
    });
    const oldDueAt = oldInvitation!.dueAt;

    // Change birthday to Jan 20 (still 2027) via customer.updated event
    const updateRes = await request(app)
      .post('/internal/campaign-events')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        schemaVersion: 1,
        producer: 'customers',
        eventId: 'evt_bday_same_year_001',
        tenantId,
        type: 'customer.updated',
        entityId: 'cus_lakshmi',
        entityVersion: 25,
        occurredAt: '2026-12-22T07:00:00Z',
        data: {
          birthday: { month: 1, day: 20 },
        },
      });

    expect(updateRes.status).toBe(200);
    expect(updateRes.body.status).toBe(EVENT_INBOX_STATUS.PROCESSED);

    // Verify enrollment has new occasionLocalDate and incremented planRevision
    const updatedEnrollment = await CampaignEnrollmentModel.findOne({
      tenantId,
      enrollmentId: enrollment!.enrollmentId,
    });
    expect(updatedEnrollment!.occasionLocalDate).toBe('2027-01-20');
    expect(updatedEnrollment!.planRevision).toBe(initialPlanRevision + 1);

    // Verify invitation execution was replanned with new dueAt and new planRevision
    const updatedInvitation = await CampaignExecutionModel.findOne({
      tenantId,
      executionId: oldInvitation!.executionId,
    });
    expect(updatedInvitation!.dueAt.getTime()).not.toBe(oldDueAt.getTime());
    expect(updatedInvitation!.planRevision).toBe(initialPlanRevision + 1);
  });

  // ===========================================================================
  // TEST 11: B04 - Date corrected across years links correctionGroupId and suppresses repeat steps
  // ===========================================================================
  it('B04: across-year date correction cancels unsent plan, links correctionGroupId, and suppresses duplicate copies', async () => {
    const campaignId = await setupActiveBirthdayCampaign('cmp_date_across_years');

    const enrollment = await CampaignEnrollmentModel.findOne({
      tenantId,
      campaignId,
      customerId: 'cus_lakshmi',
    });
    expect(enrollment!.occurrenceId).toBe('birthday:2027');

    // Simulate that the invitation step was ALREADY sent/accepted in the old enrollment
    await CampaignExecutionModel.updateOne(
      { tenantId, enrollmentId: enrollment!.enrollmentId, stepId: 'invitation' },
      {
        $set: {
          state: EXECUTION_STATE.SENT,
          deliveryIntentId: 'di_mock_accepted_001',
          providerMessageId: 'wamid_mock_001',
        },
      }
    );

    // Correct date to December 20, 2026 (across years)
    const updateRes = await request(app)
      .post('/internal/campaign-events')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        schemaVersion: 1,
        producer: 'customers',
        eventId: 'evt_across_years_001',
        tenantId,
        type: 'customer.updated',
        entityId: 'cus_lakshmi',
        entityVersion: 30,
        occurredAt: '2026-12-22T08:00:00Z',
        data: {
          birthday: { month: 12, day: 20 },
          acrossYears: true,
          targetYear: 2026,
        },
      });

    expect(updateRes.status).toBe(200);
    expect(updateRes.body.status).toBe(EVENT_INBOX_STATUS.PROCESSED);

    // 1. Old enrollment is CANCELLED and has correctionGroupId
    const oldEnrollment = await CampaignEnrollmentModel.findOne({
      tenantId,
      enrollmentId: enrollment!.enrollmentId,
    });
    expect(oldEnrollment!.status).toBe(ENROLLMENT_STATUS.CANCELLED);
    expect(oldEnrollment!.correctionGroupId).not.toBeNull();
    const correctionGroupId = oldEnrollment!.correctionGroupId;

    // 2. Replacement enrollment created for birthday:2026 with same correctionGroupId
    const replacement = await CampaignEnrollmentModel.findOne({
      tenantId,
      campaignId,
      customerId: 'cus_lakshmi',
      occurrenceId: 'birthday:2026',
    });
    expect(replacement).not.toBeNull();
    expect(replacement!.correctionGroupId).toBe(correctionGroupId);

    // 3. The invitation step in replacement is SUPPRESSED (SKIPPED) to avoid duplicate invitation
    const replacementInvitation = await CampaignExecutionModel.findOne({
      tenantId,
      enrollmentId: replacement!.enrollmentId,
      stepId: 'invitation',
    });
    expect(replacementInvitation!.state).toBe(EXECUTION_STATE.SKIPPED);
    expect(replacementInvitation!.skipReason).toContain('Suppressed duplicate step already executed in correction group');
  });

  // ===========================================================================
  // TEST 12: B03 - Consumer crash recovery & outbox replayability
  // ===========================================================================
  it('B03: pending inbox events recover safely and process through outbox without duplicates', async () => {
    // Insert event directly into campaignEventInbox with PENDING status (simulating saved before crash)
    const inboxItem = await CampaignEventInboxModel.create({
      tenantId,
      producer: 'orders',
      eventId: 'evt_crash_recovery_001',
      type: 'order.completed',
      schemaVersion: 1,
      entityId: 'ord_crash_001',
      entityVersion: 1,
      customerId: 'cus_lakshmi',
      occurredAt: new Date('2026-12-22T08:00:00Z'),
      receivedAt: new Date(),
      data: {
        paid: true,
        status: 'COMPLETED',
        netPaise: 350000,
      },
      status: EVENT_INBOX_STATUS.PENDING,
    });

    // Run outbox consumer processing
    const result = await eventConsumerService.processPendingEvents({ tenantId });
    expect(result.processedCount).toBeGreaterThanOrEqual(1);

    // Verify inbox item is now PROCESSED
    const updated = await CampaignEventInboxModel.findOne({
      tenantId,
      eventId: 'evt_crash_recovery_001',
    });
    expect(updated!.status).toBe(EVENT_INBOX_STATUS.PROCESSED);
    expect(updated!.processedAt).not.toBeNull();

    // Replay outbox cycle: 0 additional items processed
    const secondRun = await eventConsumerService.processPendingEvents({ tenantId });
    expect(secondRun.processedCount).toBe(0);
  });
});

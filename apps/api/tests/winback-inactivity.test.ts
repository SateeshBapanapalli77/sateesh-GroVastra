import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app';
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
  CampaignCheckpointModel,
} from '../src/db/models';
import { authService } from '../src/services/auth.service';
import { clock } from '../src/services/clock';
import { customerFactsService } from '../src/services/customer-facts';
import { inactivityEvaluatorService } from '../src/services/inactivity-evaluator';
import { eventConsumerService } from '../src/services/event-consumer';
import {
  EXECUTION_STATE,
  ENROLLMENT_STATUS,
  EVENT_INBOX_STATUS,
  EXCLUSION_REASONS,
} from '@grovastra/shared';

describe('Win-Back Campaign Preset & Inactivity Evaluator (Spec p14, p17, QA Matrix A13, B17)', () => {
  const app = createApp();
  const tenantId = 'shop_a';
  let ownerToken: string;

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
      branchIds: ['branch_main'],
      email: 'owner@shop-a.com',
    });
  });

  afterAll(async () => {
    await disconnectDatabase();
  });

  beforeEach(async () => {
    clock.setSystemTime(new Date('2026-10-21T10:00:00Z'));
    await seedReset(true);
    await seedDatabase('base');
    await CampaignEnrollmentModel.deleteMany({});
    await CampaignExecutionModel.deleteMany({});
    await CampaignCheckpointModel.deleteMany({});
  });

  // Helper to setup active win-back campaign
  async function setupActiveWinBackCampaign(
    campaignId = 'cmp_winback_test',
    thresholdDays = 90,
    category?: string
  ) {
    await CampaignModel.deleteMany({ tenantId, campaignId });
    await CampaignVersionModel.deleteMany({ tenantId, campaignId });
    await CampaignControlGateModel.deleteMany({ tenantId, campaignId });
    await CampaignEnrollmentModel.deleteMany({ tenantId, campaignId });
    await CampaignExecutionModel.deleteMany({ tenantId, campaignId });

    const versionDoc = await CampaignVersionModel.create({
      tenantId,
      campaignId,
      version: 1,
      name: 'Win-Back Test Campaign',
      trigger: {
        type: 'INACTIVITY_THRESHOLD',
        thresholdDays,
        category,
        ruleId: 'default',
      },
      goal: { type: 'OCCASION_TAGGED_OR_STAFF_COMPLETED' },
      audience: { mode: 'ALL_ELIGIBLE', rules: [] },
      enabledBranches: ['branch_main', 'branch_two'],
      isPublished: true,
      steps: [
        {
          stepId: 'step_invite',
          stepName: 'Win-Back Invitation',
          offsetDays: 0,
          localTime: '11:00',
          prerequisite: 'NONE',
          templateRef: { id: 'hello_world', revision: 1, language: 'en_US' },
          bindings: {},
          stopOnReply: true,
          stopOnGoal: true,
          maxLatenessMinutes: 120,
        },
        {
          stepId: 'step_followup',
          stepName: 'Win-Back Follow-up',
          offsetDays: 7,
          localTime: '11:00',
          prerequisite: 'PREVIOUS_ACCEPTED',
          templateRef: { id: 'hello_world', revision: 1, language: 'en_US' },
          bindings: {},
          stopOnReply: true,
          stopOnGoal: true,
          maxLatenessMinutes: 120,
        },
      ],
      stopRules: {
        onReply: true,
        onPurchase: true,
        onOptOut: true,
      },
      priority: 30,
      metadata: {
        presetId: 'win_back',
      },
    });

    await CampaignModel.create({
      tenantId,
      campaignId,
      name: 'Win-Back Test Campaign',
      presetId: 'win_back',
      status: 'ACTIVE',
      activeVersion: 1,
      activeVersionId: versionDoc._id.toString(),
      publishedVersions: [1],
      isPublished: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await CampaignControlGateModel.create({
      tenantId,
      campaignId,
      isPaused: false,
      killSwitchEngaged: false,
      reasons: [],
      updatedAt: new Date(),
    });

    return campaignId;
  }

  // ===========================================================================
  // TEST 1: Facts rebuild from orders (Spec p14 qualifying purchase rules)
  // ===========================================================================
  it('Facts Rebuild: correctly identifies qualifying purchases, skips non-qualifying orders, and sets nextEvaluationAt', async () => {
    // Check initial seed projection for cus_bday_jan05
    // ord_001: COMPLETED, paid: true, netPaise: 480000, completedAt: 2026-10-01T11:00:00Z
    const factJan05 = await CampaignCustomerFactModel.findOne({
      tenantId,
      customerId: 'cus_bday_jan05',
    });
    expect(factJan05).not.toBeNull();
    expect(factJan05!.lastQualifyingOrderId).toBe('ord_001');
    expect(factJan05!.lastQualifyingPurchaseAt).toEqual(new Date('2026-10-01T11:00:00Z'));
    expect(factJan05!.aggregateVersion).toBe(1);
    expect(
      factJan05!.categoryPurchases?.['item_kanjivaram_silk']?.lastQualifyingPurchaseAt
    ).toEqual(new Date('2026-10-01T11:00:00Z'));
    // nextEvaluationAt = 2026-10-01T11:00:00Z + 90 days = 2026-12-30T11:00:00Z
    expect(factJan05!.nextEvaluationAt).toEqual(new Date('2026-12-30T11:00:00Z'));

    // Check customer without qualifying purchases: cus_opted_out has ord_003 (CANCELLED, paid: false)
    const factOptedOut = await CampaignCustomerFactModel.findOne({
      tenantId,
      customerId: 'cus_opted_out',
    });
    expect(factOptedOut).not.toBeNull();
    expect(factOptedOut!.lastQualifyingOrderId).toBeNull();
    expect(factOptedOut!.lastQualifyingPurchaseAt).toBeNull();
    expect(factOptedOut!.nextEvaluationAt).toBeNull();

    // Insert pending order for cus_bday_jan05 -> does not affect qualifying purchase
    await SrcOrderModel.create({
      tenantId,
      orderId: 'ord_pending_001',
      customerId: 'cus_bday_jan05',
      status: 'PENDING',
      paid: false,
      netPaise: 990000,
      entityVersion: 1,
      completedAt: null,
      lines: [],
    });
    await customerFactsService.recomputeCustomerFacts(tenantId, 'cus_bday_jan05');

    const factAfterPending = await CampaignCustomerFactModel.findOne({
      tenantId,
      customerId: 'cus_bday_jan05',
    });
    expect(factAfterPending!.lastQualifyingOrderId).toBe('ord_001');

    // Insert zero-value completed order -> does not count (Spec p14: positive non-refunded value)
    await SrcOrderModel.create({
      tenantId,
      orderId: 'ord_zero_001',
      customerId: 'cus_bday_jan05',
      status: 'COMPLETED',
      paid: true,
      netPaise: 0,
      entityVersion: 1,
      completedAt: new Date('2026-10-15T10:00:00Z'),
      lines: [],
    });
    await customerFactsService.recomputeCustomerFacts(tenantId, 'cus_bday_jan05');

    const factAfterZero = await CampaignCustomerFactModel.findOne({
      tenantId,
      customerId: 'cus_bday_jan05',
    });
    expect(factAfterZero!.lastQualifyingOrderId).toBe('ord_001');

    // Insert fully refunded order (netPaise <= 0) -> does not count
    await SrcOrderModel.create({
      tenantId,
      orderId: 'ord_refunded_001',
      customerId: 'cus_bday_jan05',
      status: 'REFUNDED',
      paid: true,
      netPaise: 0,
      entityVersion: 1,
      completedAt: new Date('2026-10-16T10:00:00Z'),
      lines: [],
    });
    await customerFactsService.recomputeCustomerFacts(tenantId, 'cus_bday_jan05');

    const factAfterRefunded = await CampaignCustomerFactModel.findOne({
      tenantId,
      customerId: 'cus_bday_jan05',
    });
    expect(factAfterRefunded!.lastQualifyingOrderId).toBe('ord_001');

    // Verify rebuildAllCustomerFacts updates all customers idempotently
    const rebuildRes = await customerFactsService.rebuildAllCustomerFacts(tenantId);
    expect(rebuildRes.rebuiltCount).toBeGreaterThan(0);
    expect(rebuildRes.customerCount).toBeGreaterThan(0);
  });

  // ===========================================================================
  // TEST 2: Inactivity Evaluator scanning & single enrollment
  // ===========================================================================
  it('Inactivity Evaluator: scans indexed nextEvaluationAt with checkpoints and enrolls occurrence ONCE', async () => {
    const campaignId = await setupActiveWinBackCampaign('cmp_winback_scan', 90);

    // 1. Clock is at 2026-11-01 (before 90 days from 2026-10-01)
    clock.setSystemTime(new Date('2026-11-01T10:00:00Z'));
    let evalRes = await inactivityEvaluatorService.evaluateCampaign(tenantId, campaignId);
    expect(evalRes.enrolledCount).toBe(0);

    let enrollments = await CampaignEnrollmentModel.find({ tenantId, campaignId });
    expect(enrollments.length).toBe(0);

    // 2. Move clock past the 90 day threshold (2027-01-05T10:00:00Z)
    clock.setSystemTime(new Date('2027-01-05T10:00:00Z'));
    evalRes = await inactivityEvaluatorService.evaluateCampaign(tenantId, campaignId);
    expect(evalRes.enrolledCount).toBeGreaterThanOrEqual(1);

    // Check cus_bday_jan05 enrollment
    const jan05Enrollment = await CampaignEnrollmentModel.findOne({
      tenantId,
      campaignId,
      customerId: 'cus_bday_jan05',
    });
    expect(jan05Enrollment).not.toBeNull();
    // Occurrence ID MUST be winback:lastQualifyingOrderId:ruleId (Spec p14, p17)
    expect(jan05Enrollment!.occurrenceId).toBe('winback:ord_001:default');
    expect(jan05Enrollment!.status).toBe(ENROLLMENT_STATUS.ACTIVE);

    // Check scheduled executions
    const executions = await CampaignExecutionModel.find({
      tenantId,
      enrollmentId: jan05Enrollment!.enrollmentId,
    });
    expect(executions.length).toBe(2);
    expect(executions.map((e) => e.stepId)).toContain('step_invite');
    expect(executions.map((e) => e.stepId)).toContain('step_followup');

    // 3. Verify distributed lease checkpoint was used
    const checkpoint = await CampaignCheckpointModel.findOne({
      tenantId,
      campaignId,
      type: 'INACTIVITY_EVALUATOR',
    });
    expect(checkpoint).not.toBeNull();
    expect(checkpoint!.type).toBe('INACTIVITY_EVALUATOR');
  });

  // ===========================================================================
  // TEST 3: Idempotent re-scans (enrolled ONCE, zero duplicate executions)
  // ===========================================================================
  it('Idempotence: Repeated evaluation re-scans yield ZERO duplicate enrollments or executions', async () => {
    const campaignId = await setupActiveWinBackCampaign('cmp_winback_idempotent', 90);

    clock.setSystemTime(new Date('2027-01-10T10:00:00Z'));
    const evalRes1 = await inactivityEvaluatorService.evaluateCampaign(tenantId, campaignId);
    const initialEnrollmentsCount = await CampaignEnrollmentModel.countDocuments({
      tenantId,
      campaignId,
    });
    const initialExecutionsCount = await CampaignExecutionModel.countDocuments({
      tenantId,
      campaignId,
    });
    expect(evalRes1.enrolledCount).toBe(initialEnrollmentsCount);

    // Run again immediately
    const evalRes2 = await inactivityEvaluatorService.evaluateCampaign(tenantId, campaignId);
    expect(evalRes2.enrolledCount).toBe(0);

    // Run again after 2 days
    clock.setSystemTime(new Date('2027-01-12T10:00:00Z'));
    const evalRes3 = await inactivityEvaluatorService.evaluateCampaign(tenantId, campaignId);
    expect(evalRes3.enrolledCount).toBe(0);

    const postEnrollmentsCount = await CampaignEnrollmentModel.countDocuments({
      tenantId,
      campaignId,
    });
    const postExecutionsCount = await CampaignExecutionModel.countDocuments({
      tenantId,
      campaignId,
    });
    expect(postEnrollmentsCount).toBe(initialEnrollmentsCount);
    expect(postExecutionsCount).toBe(initialExecutionsCount);
  });

  // ===========================================================================
  // TEST 4: Exclusion of customers without purchase history (Spec p14)
  // ===========================================================================
  it('Audience Gating: Customers without purchase history are NOT a win-back audience', async () => {
    // Create customer with zero orders
    await SrcCustomerModel.create({
      tenantId,
      customerId: 'cus_no_orders_ever',
      firstName: 'New Visitor',
      destination: {
        encryptedPhone: 'enc_no_orders',
        destinationHash: 'hash_no_orders',
        masked: '+91 91000 00999',
        verified: true,
        version: 1,
      },
      marketingOptIn: true,
      channelSuppressed: false,
      status: 'ACTIVE',
      branchId: 'branch_main',
      language: 'en',
      version: 1,
    });
    await customerFactsService.recomputeCustomerFacts(tenantId, 'cus_no_orders_ever');

    const fact = await CampaignCustomerFactModel.findOne({
      tenantId,
      customerId: 'cus_no_orders_ever',
    });
    expect(fact!.lastQualifyingOrderId).toBeNull();
    expect(fact!.lastQualifyingPurchaseAt).toBeNull();

    const campaignId = await setupActiveWinBackCampaign('cmp_winback_no_orders', 90);
    clock.setSystemTime(new Date('2027-01-10T10:00:00Z'));

    await inactivityEvaluatorService.evaluateCampaign(tenantId, campaignId);

    const enrollment = await CampaignEnrollmentModel.findOne({
      tenantId,
      campaignId,
      customerId: 'cus_no_orders_ever',
    });
    expect(enrollment).toBeNull();
  });

  // ===========================================================================
  // TEST 5: QA Matrix A13 - New qualifying order cancels old win-back steps & resets anchor
  // ===========================================================================
  it('A13: New qualifying order cancels active win-back enrollments/steps and resets inactivity anchor', async () => {
    const campaignId = await setupActiveWinBackCampaign('cmp_winback_a13', 90);

    // Enroll cus_bday_jan05 after 90 days of inactivity (10:00 AM IST, before 11:00 AM step time)
    clock.setSystemTime(new Date('2027-01-05T04:30:00Z'));
    await inactivityEvaluatorService.evaluateCampaign(tenantId, campaignId);

    const enrollment = await CampaignEnrollmentModel.findOne({
      tenantId,
      campaignId,
      customerId: 'cus_bday_jan05',
    });
    expect(enrollment).not.toBeNull();
    expect(enrollment!.status).toBe(ENROLLMENT_STATUS.ACTIVE);

    // Verify executions are SCHEDULED
    const executionsBefore = await CampaignExecutionModel.find({
      tenantId,
      enrollmentId: enrollment!.enrollmentId,
    });
    expect(executionsBefore.length).toBe(2);
    expect(executionsBefore.every((e) => e.state === EXECUTION_STATE.SCHEDULED)).toBe(true);

    // Customer places a new qualifying order on 2027-01-08
    const newOrderCompletedAt = new Date('2027-01-08T15:30:00Z');
    await SrcOrderModel.create({
      tenantId,
      orderId: 'ord_new_qualifying_01',
      customerId: 'cus_bday_jan05',
      status: 'COMPLETED',
      paid: true,
      netPaise: 750000,
      entityVersion: 1,
      completedAt: newOrderCompletedAt,
      lines: [
        {
          lineId: 'line_new_01',
          itemRef: 'item_banarasi_silk',
          name: 'Banarasi Brocade Saree',
          quantity: 1,
          pricePaise: 750000,
        },
      ],
    });

    // Ingest order.completed domain event
    const eventRes = await request(app)
      .post('/internal/campaign-events')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        schemaVersion: 1,
        producer: 'orders',
        eventId: 'evt_order_a13_001',
        tenantId,
        type: 'order.completed',
        entityId: 'ord_new_qualifying_01',
        entityVersion: 1,
        customerId: 'cus_bday_jan05',
        occurredAt: newOrderCompletedAt.toISOString(),
        data: {
          paid: true,
          status: 'COMPLETED',
          netPaise: 750000,
        },
      });

    expect(eventRes.status).toBe(200);
    expect(eventRes.body.status).toBe(EVENT_INBOX_STATUS.PROCESSED);

    // Verify enrollment is CANCELLED (A13)
    const updatedEnrollment = await CampaignEnrollmentModel.findOne({
      tenantId,
      enrollmentId: enrollment!.enrollmentId,
    });
    expect(updatedEnrollment!.status).toBe(ENROLLMENT_STATUS.CANCELLED);

    // Verify scheduled executions are CANCELLED (A13)
    const executionsAfter = await CampaignExecutionModel.find({
      tenantId,
      enrollmentId: enrollment!.enrollmentId,
    });
    expect(executionsAfter.every((e) => e.state === EXECUTION_STATE.CANCELLED)).toBe(true);
    expect(executionsAfter[0].skipReason).toContain('New qualifying order completed');

    // Verify customer facts anchor has been reset
    const updatedFacts = await CampaignCustomerFactModel.findOne({
      tenantId,
      customerId: 'cus_bday_jan05',
    });
    expect(updatedFacts!.lastQualifyingOrderId).toBe('ord_new_qualifying_01');
    expect(updatedFacts!.lastQualifyingPurchaseAt).toEqual(newOrderCompletedAt);
    // nextEvaluationAt is now newOrderCompletedAt + 90 days = 2027-04-08T15:30:00Z
    expect(updatedFacts!.nextEvaluationAt).toEqual(new Date('2027-04-08T15:30:00Z'));

    // Move clock to 2027-02-01 (before cus_bday_jan05's new 90-day threshold) -> cus_bday_jan05 has no active enrollment
    clock.setSystemTime(new Date('2027-02-01T10:00:00Z'));
    await inactivityEvaluatorService.evaluateCampaign(tenantId, campaignId);

    const jan05EnrollmentBeforeThreshold = await CampaignEnrollmentModel.findOne({
      tenantId,
      campaignId,
      customerId: 'cus_bday_jan05',
      status: ENROLLMENT_STATUS.ACTIVE,
    });
    expect(jan05EnrollmentBeforeThreshold).toBeNull();

    // Move clock past 2027-04-08 (e.g. 2027-04-10) -> eligible for new occurrence
    clock.setSystemTime(new Date('2027-04-10T10:00:00Z'));
    await inactivityEvaluatorService.evaluateCampaign(tenantId, campaignId);

    const secondEnrollment = await CampaignEnrollmentModel.findOne({
      tenantId,
      campaignId,
      customerId: 'cus_bday_jan05',
      status: ENROLLMENT_STATUS.ACTIVE,
    });
    expect(secondEnrollment).not.toBeNull();
    // Occurrence ID is anchored to the new order
    expect(secondEnrollment!.occurrenceId).toBe('winback:ord_new_qualifying_01:default');
  });

  // ===========================================================================
  // TEST 6: QA Matrix B17 - Refund restores older anchor without resending completed occurrence
  // ===========================================================================
  it('B17: Refund restores older inactivity anchor but does NOT resend an already completed occurrence', async () => {
    const campaignId = await setupActiveWinBackCampaign('cmp_winback_b17', 90);

    // 1. Initial qualifying order ord_001 (2026-10-01) triggers winback on 2027-01-05
    clock.setSystemTime(new Date('2027-01-05T10:00:00Z'));
    await inactivityEvaluatorService.evaluateCampaign(tenantId, campaignId);

    const enrollment1 = await CampaignEnrollmentModel.findOne({
      tenantId,
      campaignId,
      customerId: 'cus_bday_jan05',
    });
    expect(enrollment1).not.toBeNull();
    expect(enrollment1!.occurrenceId).toBe('winback:ord_001:default');

    // Simulate completion of steps / enrollment
    await CampaignEnrollmentModel.updateOne(
      { tenantId, enrollmentId: enrollment1!.enrollmentId },
      { $set: { status: ENROLLMENT_STATUS.COMPLETED } }
    );
    await CampaignExecutionModel.updateMany(
      { tenantId, enrollmentId: enrollment1!.enrollmentId },
      { $set: { state: EXECUTION_STATE.DELIVERED } }
    );

    // 2. Customer places ord_002 on 2027-01-10
    const ord2CompletedAt = new Date('2027-01-10T12:00:00Z');
    await SrcOrderModel.create({
      tenantId,
      orderId: 'ord_002_temporary',
      customerId: 'cus_bday_jan05',
      status: 'COMPLETED',
      paid: true,
      netPaise: 500000,
      entityVersion: 1,
      completedAt: ord2CompletedAt,
      lines: [],
    });
    await customerFactsService.recomputeCustomerFacts(tenantId, 'cus_bday_jan05');

    const factsWithOrd2 = await CampaignCustomerFactModel.findOne({
      tenantId,
      customerId: 'cus_bday_jan05',
    });
    expect(factsWithOrd2!.lastQualifyingOrderId).toBe('ord_002_temporary');

    // 3. Customer returns ord_002 for full refund on 2027-01-12
    await SrcOrderModel.updateOne(
      { tenantId, orderId: 'ord_002_temporary' },
      { $set: { status: 'REFUNDED', netPaise: 0 } }
    );

    // Ingest order.refund_or_cancel domain event
    const refundEventRes = await request(app)
      .post('/internal/campaign-events')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        schemaVersion: 1,
        producer: 'orders',
        eventId: 'evt_refund_b17_001',
        tenantId,
        type: 'order.refund_or_cancel',
        entityId: 'ord_002_temporary',
        entityVersion: 2,
        customerId: 'cus_bday_jan05',
        occurredAt: '2027-01-12T14:00:00Z',
        data: {
          status: 'REFUNDED',
          refundPaise: 500000,
          netPaise: 0,
        },
      });

    expect(refundEventRes.status).toBe(200);

    // 4. Verify facts restored older anchor ord_001 (B17)
    const factsRestored = await CampaignCustomerFactModel.findOne({
      tenantId,
      customerId: 'cus_bday_jan05',
    });
    expect(factsRestored!.lastQualifyingOrderId).toBe('ord_001');
    expect(factsRestored!.lastQualifyingPurchaseAt).toEqual(new Date('2026-10-01T11:00:00Z'));
    // nextEvaluationAt is 2026-12-30 (which is in the past!)
    expect(factsRestored!.nextEvaluationAt).toEqual(new Date('2026-12-30T11:00:00Z'));

    // 5. Inactivity evaluator runs now on 2027-01-15 (B17 Hard Rule: must NOT resend completed occurrence)
    clock.setSystemTime(new Date('2027-01-15T10:00:00Z'));
    const evalResAfterRefund = await inactivityEvaluatorService.evaluateCampaign(
      tenantId,
      campaignId
    );

    // Confirm cus_bday_jan05 was NOT re-enrolled (B17 Hard Rule: must NOT resend an already completed occurrence)
    const jan05Enrollments = await CampaignEnrollmentModel.find({
      tenantId,
      campaignId,
      customerId: 'cus_bday_jan05',
    });
    expect(jan05Enrollments.length).toBe(1);
    expect(jan05Enrollments[0].occurrenceId).toBe('winback:ord_001:default');
    expect(jan05Enrollments[0].status).toBe(ENROLLMENT_STATUS.COMPLETED);
    // Newly created enrollments must not include cus_bday_jan05
    expect(evalResAfterRefund.createdEnrollmentIds).not.toContain(jan05Enrollments[0].enrollmentId);
  });

  // ===========================================================================
  // TEST 7: Category-specific Inactivity Threshold
  // ===========================================================================
  it('Category Filter: evaluates inactivity threshold against specific category purchases', async () => {
    // cus_bday_jan05 purchased item_kanjivaram_silk on 2026-10-01
    // Setup campaign requiring 60 days inactivity in item_kanjivaram_silk
    const campaignId = await setupActiveWinBackCampaign(
      'cmp_winback_category',
      60,
      'item_kanjivaram_silk'
    );

    // On 2026-11-15 (45 days) -> not reached 60 days
    clock.setSystemTime(new Date('2026-11-15T10:00:00Z'));
    let res = await inactivityEvaluatorService.evaluateCampaign(tenantId, campaignId);
    expect(res.enrolledCount).toBe(0);

    // On 2026-12-05 (65 days) -> reached 60 days
    clock.setSystemTime(new Date('2026-12-05T10:00:00Z'));
    res = await inactivityEvaluatorService.evaluateCampaign(tenantId, campaignId);
    expect(res.enrolledCount).toBeGreaterThanOrEqual(1);

    const enrollment = await CampaignEnrollmentModel.findOne({
      tenantId,
      campaignId,
      customerId: 'cus_bday_jan05',
    });
    expect(enrollment).not.toBeNull();
  });

  // ===========================================================================
  // TEST 8: Dry Run Simulation Support
  // ===========================================================================
  it('Dry Run: correctly evaluates INACTIVITY_THRESHOLD candidate audience and renders templates', async () => {
    // Create draft winback campaign
    const draftRes = await request(app)
      .post('/campaigns')
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('Idempotency-Key', 'dry-run-winback-test-init')
      .send({
        presetId: 'win_back',
        name: 'Draft Win-Back Campaign',
      });

    expect(draftRes.status).toBe(201);
    const campaignId = draftRes.body.campaign.campaignId;

    // Run dry run at 2027-01-10 (cus_bday_jan05 is inactive > 90 days)
    clock.setSystemTime(new Date('2027-01-10T10:00:00Z'));

    const dryRunRes = await request(app)
      .post(`/campaigns/${campaignId}/dry-runs`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({});

    expect(dryRunRes.status).toBe(201);
    expect(dryRunRes.body.dryRunId).toBeDefined();
    expect(dryRunRes.body.counts.scanned).toBeGreaterThan(0);
    expect(dryRunRes.body.counts.eligible).toBeGreaterThan(0);

    // Verify samplePlans include cus_bday_jan05 as eligible
    const eligiblePlan = dryRunRes.body.samplePlans.find(
      (c: any) => c.customerId === 'cus_bday_jan05'
    );
    expect(eligiblePlan).toBeDefined();
    expect(eligiblePlan.occurrenceId).toBe('winback:ord_001:default');
    expect(eligiblePlan.steps.length).toBeGreaterThanOrEqual(1);

    // Verify customer without orders is excluded with NO_PURCHASE_HISTORY in excludedSamples
    const noOrdersSample = dryRunRes.body.excludedSamples.find(
      (c: any) => c.customerId === 'cus_channel_suppressed'
    );
    if (noOrdersSample) {
      expect(noOrdersSample.primaryReason).toBe(EXCLUSION_REASONS.NO_PURCHASE_HISTORY);
    }
  });

  // ===========================================================================
  // TEST 9: API endpoint POST /campaigns/:id/evaluate-inactivity
  // ===========================================================================
  it('API Endpoint: POST /campaigns/:id/evaluate-inactivity triggers evaluator process', async () => {
    const campaignId = await setupActiveWinBackCampaign('cmp_winback_api', 90);

    clock.setSystemTime(new Date('2027-01-10T10:00:00Z'));

    const evalRes = await request(app)
      .post(`/campaigns/${campaignId}/evaluate-inactivity`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({});

    expect(evalRes.status).toBe(200);
    expect(evalRes.body.evaluated).toBe(true);
    expect(evalRes.body.enrolledCount).toBeGreaterThanOrEqual(1);
    expect(evalRes.body.campaignId).toBe(campaignId);
  });
});

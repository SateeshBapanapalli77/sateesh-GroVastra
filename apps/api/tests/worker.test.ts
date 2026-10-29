import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
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
  CampaignDeliveryIntentModel,
  CampaignContactGateModel,
  SrcCustomerModel,
  SrcTemplateModel,
} from '../src/db/models';
import { plannerService } from '../src/services/planner';
import { workerService } from '../src/services/worker';
import { getDispatchPort, setDispatchPort, resetDispatchPort } from '../src/services/dispatch/dispatch-port';
import { clock } from '../src/services/clock';
import {
  EXECUTION_STATE,
  EXECUTION_REASONS,
  DELIVERY_INTENT_STATE,
  PREREQUISITE,
} from '@grovastra/shared';

describe('GroVastra Campaign Worker & Step Evaluator (Feature 9, Spec p19, p20, p25, p33, QA Matrix A11, A12, B15, B20, C05, C09, C13)', () => {
  let shopAOwnerToken: string;
  let shopAStaffToken: string;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.ALLOW_TEST_CATEGORY_MISMATCH = 'true';
    process.env.DISPATCH_MODE = 'dry';
    await connectToDatabase();
    await seedDatabase('base');

    const loginAOwner = await request(app)
      .post('/auth/login')
      .send({ email: 'owner@shop-a.com', password: 'OwnerSecret#2026!' });
    shopAOwnerToken = loginAOwner.body.token;

    const loginAStaff = await request(app)
      .post('/auth/login')
      .send({ email: 'staff@shop-a.com', password: 'StaffSecret#2026!' });
    shopAStaffToken = loginAStaff.body.token;
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
    await CampaignEnrollmentModel.deleteMany({});
    await CampaignExecutionModel.deleteMany({});
    await CampaignDeliveryIntentModel.deleteMany({});
    await CampaignContactGateModel.deleteMany({});

    await SrcCustomerModel.updateMany(
      { tenantId: 'shop_a' },
      {
        $set: {
          'consent.marketingOptIn': true,
          'consent.channelSuppressed': false,
          status: 'ACTIVE',
        },
      }
    );
    await SrcCustomerModel.updateOne(
      { tenantId: 'shop_a', customerId: 'cus_bday_jan05' },
      { $set: { firstName: 'Priya' } }
    );
  });

  // Helper to activate a campaign with custom steps
  async function setupActiveCampaign(steps?: any[]) {
    const defaultSteps = [
      {
        stepId: 'invitation',
        stepName: 'Birthday Invitation',
        offsetDays: -14,
        localTime: '10:00',
        prerequisite: PREREQUISITE.NONE,
        templateRef: { id: 'tpl_birthday_invite', revision: 1, language: 'en' },
        bindings: { name: 'customer.firstName', shop: 'shop.displayName' },
        stopOnReply: true,
        stopOnGoal: true,
        maxLatenessMinutes: 120,
      },
      {
        stepId: 'followup',
        stepName: 'Birthday Followup',
        offsetDays: -7,
        localTime: '10:00',
        prerequisite: PREREQUISITE.PREVIOUS_ACCEPTED,
        templateRef: { id: 'tpl_birthday_followup', revision: 1, language: 'en' },
        bindings: { name: 'customer.firstName' },
        stopOnReply: true,
        stopOnGoal: true,
        maxLatenessMinutes: 120,
      },
    ];

    // Set Clock to 15 Dec 2026 per Spec p33 (Priya Sharma birthday Jan 5, D-14 due Dec 22)
    const targetDate = new Date('2026-12-15T09:00:00Z');
    clock.setOffsetMs(targetDate.getTime() - Date.now());

    const campaignRes = await request(app)
      .post('/campaigns')
      .set('Authorization', `Bearer ${shopAOwnerToken}`)
      .set('Idempotency-Key', `cmp-${Date.now()}-${Math.random()}`)
      .send({ presetId: 'birthday', name: `Worker Campaign ${Date.now()}` });
    expect(campaignRes.status).toBe(201);
    const campaignId = campaignRes.body.campaign.campaignId;

    const patchRes = await request(app)
      .patch(`/campaigns/${campaignId}/draft`)
      .set('Authorization', `Bearer ${shopAOwnerToken}`)
      .set('Idempotency-Key', `patch-${Date.now()}-${Math.random()}`)
      .send({
        expectedVersion: 1,
        steps: steps || defaultSteps,
      });
    expect(patchRes.status).toBe(200);

    const dryRes = await request(app)
      .post(`/campaigns/${campaignId}/dry-runs`)
      .set('Authorization', `Bearer ${shopAOwnerToken}`);
    expect(dryRes.status).toBe(201);

    const actRes = await request(app)
      .post(`/campaigns/${campaignId}/activate`)
      .set('Authorization', `Bearer ${shopAOwnerToken}`)
      .set('Idempotency-Key', `act-${Date.now()}-${Math.random()}`);
    expect(actRes.status).toBe(200);

    // Run planner so enrollments and executions exist
    await plannerService.planCampaign('shop_a', campaignId, { force: true });

    return campaignId;
  }

  // ===========================================================================
  // TEST 1: Worker claims due step, resolves late bindings, and freezes intent
  // ===========================================================================
  it('Worker claims due SCHEDULED step, evaluates gates, freezes exactly one immutable delivery intent, and marks DISPATCHING', async () => {
    const campaignId = await setupActiveCampaign();

    // Find a scheduled step
    const execution = await CampaignExecutionModel.findOne({
      tenantId: 'shop_a',
      campaignId,
      stepId: 'invitation',
      state: EXECUTION_STATE.SCHEDULED,
    });
    expect(execution).not.toBeNull();

    // Advance clock to due time
    clock.setSystemTime(new Date(execution!.dueAt.getTime() + 1000));

    // Run worker cycle
    const result = await workerService.runWorkerCycle({
      tenantId: 'shop_a',
      campaignId,
      batchSize: 10,
    });

    expect(result.claimedCount).toBeGreaterThanOrEqual(1);
    expect(result.dispatchedCount).toBeGreaterThanOrEqual(1);

    // Verify execution transitioned to DISPATCHING with deliveryIntentId
    const updatedExecution = await CampaignExecutionModel.findOne({
      tenantId: 'shop_a',
      executionId: execution!.executionId,
    });
    expect(updatedExecution!.state).toBe(EXECUTION_STATE.DISPATCHING);
    expect(updatedExecution!.deliveryIntentId).toBeTruthy();
    expect(updatedExecution!.lease?.token).toBeNull();

    // Verify immutable DeliveryIntent document was created
    const deliveryIntent = await CampaignDeliveryIntentModel.findOne({
      tenantId: 'shop_a',
      executionId: execution!.executionId,
    });
    expect(deliveryIntent).not.toBeNull();
    expect(deliveryIntent!.deliveryKey).toBe(execution!.executionId); // Spec p18, p23
    expect(deliveryIntent!.state).toBe(DELIVERY_INTENT_STATE.PREPARED_DRY);
    expect(deliveryIntent!.maskedRecipient).toBeTruthy();
    expect(deliveryIntent!.templateRef.id).toBe('tpl_birthday_invite');
    expect(Array.isArray(deliveryIntent!.parameters)).toBe(true);
    expect(deliveryIntent!.parameters).toEqual(
      expect.arrayContaining([
        { index: 1, text: 'Sunita Reddy' },
        { index: 2, text: 'Sample Boutique' },
      ])
    );
    expect(deliveryIntent!.payloadHash).toHaveLength(64); // SHA-256
    expect(deliveryIntent!.attemptId).toBeTruthy();

    // Running worker again for the same due time does not re-process or duplicate intent
    const repeatResult = await workerService.runWorkerCycle({
      tenantId: 'shop_a',
      campaignId,
      batchSize: 10,
    });
    const intentsCount = await CampaignDeliveryIntentModel.countDocuments({
      tenantId: 'shop_a',
      executionId: execution!.executionId,
    });
    expect(intentsCount).toBe(1);
  });

  // ===========================================================================
  // TEST 2: Two concurrent workers never process the same step
  // ===========================================================================
  it('Two concurrent workers never process the same step (concurrency safety via findOneAndUpdate lease claim)', async () => {
    const campaignId = await setupActiveCampaign();

    const execution = await CampaignExecutionModel.findOne({
      tenantId: 'shop_a',
      campaignId,
      stepId: 'invitation',
      state: EXECUTION_STATE.SCHEDULED,
    });
    expect(execution).not.toBeNull();

    const targetDueTime = new Date(execution!.dueAt.getTime() + 1000);
    clock.setSystemTime(targetDueTime);

    // Two workers attempt to claim simultaneously
    const [claimA, claimB] = await Promise.all([
      workerService.claimNextDueExecution('shop_a', campaignId, targetDueTime),
      workerService.claimNextDueExecution('shop_a', campaignId, targetDueTime),
    ]);

    // If there is only one due execution, exactly one worker must succeed and one must receive null (or a different execution)
    const claimedIds = [claimA?.execution.executionId, claimB?.execution.executionId].filter(Boolean);
    if (claimA && claimB) {
      expect(claimA.execution.executionId).not.toBe(claimB.execution.executionId);
    } else {
      expect(claimedIds.length).toBe(1);
    }
  });

  // ===========================================================================
  // TEST 3: A11 Logic - Customer replies after invitation (stopOnReply hold)
  // ===========================================================================
  it('A11: Customer replies after invitation -> reply hold stops sales step at due time with reason SKIPPED_REPLY_HOLD', async () => {
    const campaignId = await setupActiveCampaign();

    // Pick an enrollment with both invitation and followup
    const enrollment = await CampaignEnrollmentModel.findOne({
      tenantId: 'shop_a',
      campaignId,
    });
    expect(enrollment).not.toBeNull();

    const invitation = await CampaignExecutionModel.findOne({
      tenantId: 'shop_a',
      enrollmentId: enrollment!.enrollmentId,
      stepId: 'invitation',
    });
    const followup = await CampaignExecutionModel.findOne({
      tenantId: 'shop_a',
      enrollmentId: enrollment!.enrollmentId,
      stepId: 'followup',
    });
    expect(invitation).not.toBeNull();
    expect(followup).not.toBeNull();

    // Direct DB state change: Step 1 invitation was accepted by WhatsApp provider
    invitation!.state = EXECUTION_STATE.PROVIDER_ACCEPTED;
    await invitation!.save();

    // Direct DB state change: Customer replies -> enrollment replyHoldAt is set (A11, Spec p20, p33)
    enrollment!.replyHoldAt = clock.now();
    await enrollment!.save();

    // Advance clock to followup dueAt
    clock.setSystemTime(new Date(followup!.dueAt.getTime() + 1000));

    // Run worker cycle
    await workerService.runWorkerCycle({
      tenantId: 'shop_a',
      campaignId,
      batchSize: 50,
    });

    // Followup step must be SKIPPED with primary reason SKIPPED_REPLY_HOLD
    const updatedFollowup = await CampaignExecutionModel.findOne({
      tenantId: 'shop_a',
      executionId: followup!.executionId,
    });
    expect(updatedFollowup!.state).toBe(EXECUTION_STATE.SKIPPED);
    expect(updatedFollowup!.skipReason).toBe(EXECUTION_REASONS.SKIPPED_REPLY_HOLD);

    // Zero delivery intent created for stopped followup
    const intent = await CampaignDeliveryIntentModel.findOne({
      tenantId: 'shop_a',
      executionId: followup!.executionId,
    });
    expect(intent).toBeNull();
  });

  // ===========================================================================
  // TEST 4: A12 Logic - Goal purchase recorded (stopOnGoal)
  // ===========================================================================
  it('A12: Goal purchase recorded -> applicable follow-ups stop with reason SKIPPED_GOAL_REACHED', async () => {
    const campaignId = await setupActiveCampaign();

    const enrollment = await CampaignEnrollmentModel.findOne({
      tenantId: 'shop_a',
      campaignId,
    });
    const followup = await CampaignExecutionModel.findOne({
      tenantId: 'shop_a',
      enrollmentId: enrollment!.enrollmentId,
      stepId: 'followup',
    });

    // Direct DB state change: Prior step was accepted
    await CampaignExecutionModel.updateOne(
      { tenantId: 'shop_a', enrollmentId: enrollment!.enrollmentId, stepId: 'invitation' },
      { $set: { state: EXECUTION_STATE.PROVIDER_ACCEPTED } }
    );

    // Direct DB state change: Customer completed goal purchase (A12, Spec p20, p33)
    await CampaignEnrollmentModel.updateOne(
      { tenantId: 'shop_a', enrollmentId: enrollment!.enrollmentId },
      { $set: { goalReachedAt: clock.now() } }
    );

    // Advance clock to followup dueAt
    clock.setSystemTime(new Date(followup!.dueAt.getTime() + 1000));

    // Run worker cycle
    await workerService.runWorkerCycle({
      tenantId: 'shop_a',
      campaignId,
      batchSize: 50,
    });

    const updatedFollowup = await CampaignExecutionModel.findOne({
      tenantId: 'shop_a',
      executionId: followup!.executionId,
    });
    expect(updatedFollowup!.state).toBe(EXECUTION_STATE.SKIPPED);
    expect(updatedFollowup!.skipReason).toBe(EXECUTION_REASONS.SKIPPED_GOAL_REACHED);

    // Zero delivery intent created
    const intent = await CampaignDeliveryIntentModel.findOne({
      tenantId: 'shop_a',
      executionId: followup!.executionId,
    });
    expect(intent).toBeNull();
  });

  // ===========================================================================
  // TEST 5: Reason Precedence - Goal precedes reply hold (Spec p33)
  // ===========================================================================
  it('Spec p33 Reason Precedence: Goal precedes reply hold when both are present', async () => {
    const campaignId = await setupActiveCampaign();

    const enrollment = await CampaignEnrollmentModel.findOne({
      tenantId: 'shop_a',
      campaignId,
    });
    const followup = await CampaignExecutionModel.findOne({
      tenantId: 'shop_a',
      enrollmentId: enrollment!.enrollmentId,
      stepId: 'followup',
    });

    await CampaignExecutionModel.updateOne(
      { tenantId: 'shop_a', enrollmentId: enrollment!.enrollmentId, stepId: 'invitation' },
      { $set: { state: EXECUTION_STATE.PROVIDER_ACCEPTED } }
    );

    // Set BOTH goalReachedAt AND replyHoldAt
    await CampaignEnrollmentModel.updateOne(
      { tenantId: 'shop_a', enrollmentId: enrollment!.enrollmentId },
      { $set: { goalReachedAt: clock.now(), replyHoldAt: clock.now() } }
    );

    clock.setSystemTime(new Date(followup!.dueAt.getTime() + 1000));

    await workerService.runWorkerCycle({
      tenantId: 'shop_a',
      campaignId,
      batchSize: 50,
    });

    const updated = await CampaignExecutionModel.findOne({
      tenantId: 'shop_a',
      executionId: followup!.executionId,
    });
    expect(updated!.state).toBe(EXECUTION_STATE.SKIPPED);
    // Spec p33: "SKIPPED_GOAL_REACHED (goal precedes reply hold); reply evidence remains visible."
    expect(updated!.skipReason).toBe(EXECUTION_REASONS.SKIPPED_GOAL_REACHED);
  });

  // ===========================================================================
  // TEST 6: B15 Logic - Stale worker lease fails CAS, makes zero dispatch calls
  // ===========================================================================
  it('B15: Stale worker lease -> CAS fails and stale worker makes zero dispatch calls', async () => {
    const campaignId = await setupActiveCampaign();

    const execution = await CampaignExecutionModel.findOne({
      tenantId: 'shop_a',
      campaignId,
      stepId: 'invitation',
      state: EXECUTION_STATE.SCHEDULED,
    });
    const dueTime = new Date(execution!.dueAt.getTime() + 1000);
    clock.setSystemTime(dueTime);

    // Worker claims the execution
    const claim = await workerService.claimNextDueExecution('shop_a', campaignId, dueTime);
    expect(claim).not.toBeNull();
    const { execution: claimedEx, leaseToken, leaseUntil } = claim!;

    // Spy on dispatch port
    const dispatchSpy = vi.fn().mockResolvedValue({ success: true, mode: 'dry', status: 'PREPARED_DRY' });
    setDispatchPort({ dispatch: dispatchSpy });

    // Simulate clock advancing PAST the 30-second lease expiry before CAS is attempted (stale worker)
    const staleNow = new Date(leaseUntil.getTime() + 5000);
    clock.setSystemTime(staleNow);

    // Stale worker tries to evaluate and commit
    const evalResult = await workerService.evaluateAndProcessExecution(
      claimedEx,
      leaseToken,
      leaseUntil,
      staleNow
    );

    expect(evalResult.reason).toBe('STALE_CAS_FAILED');
    // Spec p31 (B15): CAS fails; stale worker makes zero provider requests
    expect(dispatchSpy).toHaveBeenCalledTimes(0);

    // Zero delivery intent created
    const intent = await CampaignDeliveryIntentModel.findOne({
      tenantId: 'shop_a',
      executionId: claimedEx.executionId,
    });
    expect(intent).toBeNull();
  });

  // ===========================================================================
  // TEST 7: B20 Logic - Racing replan increments planRevision, invalidating claim
  // ===========================================================================
  it('B20: Source replan races final submission -> planRevision CAS fails, stale claimant cannot send', async () => {
    const campaignId = await setupActiveCampaign();

    const execution = await CampaignExecutionModel.findOne({
      tenantId: 'shop_a',
      campaignId,
      stepId: 'invitation',
      state: EXECUTION_STATE.SCHEDULED,
    });
    const dueTime = new Date(execution!.dueAt.getTime() + 1000);
    clock.setSystemTime(dueTime);

    // Worker claims execution with expected planRevision = 1
    const claim = await workerService.claimNextDueExecution('shop_a', campaignId, dueTime);
    expect(claim).not.toBeNull();
    const { execution: claimedEx, leaseToken, leaseUntil } = claim!;
    expect(claimedEx.planRevision).toBe(1);

    // Spy on dispatch port
    const dispatchSpy = vi.fn();
    setDispatchPort({ dispatch: dispatchSpy });

    // A racing replan or date correction updates the execution's planRevision to 2 in MongoDB (B20, Spec p20, p31)
    await CampaignExecutionModel.updateOne(
      { tenantId: 'shop_a', executionId: claimedEx.executionId },
      { $set: { planRevision: 2 } }
    );

    // Worker attempts final submission CAS expecting planRevision = 1
    const evalResult = await workerService.evaluateAndProcessExecution(
      claimedEx,
      leaseToken,
      leaseUntil,
      dueTime
    );

    expect(evalResult.reason).toBe('STALE_CAS_FAILED');
    expect(dispatchSpy).toHaveBeenCalledTimes(0);

    // Execution state remains intact
    const current = await CampaignExecutionModel.findOne({
      tenantId: 'shop_a',
      executionId: claimedEx.executionId,
    });
    expect(current!.planRevision).toBe(2);
    expect(current!.deliveryIntentId).toBeNull();
  });

  // ===========================================================================
  // TEST 8: C05 Logic - Missing variable binding prevents partial send
  // ===========================================================================
  it('C05: Missing variable binding -> step skipped with reason MISSING_VARIABLE_BINDING, no partial message frozen', async () => {
    const campaignId = await setupActiveCampaign();

    const execution = await CampaignExecutionModel.findOne({
      tenantId: 'shop_a',
      campaignId,
      stepId: 'invitation',
      state: EXECUTION_STATE.SCHEDULED,
    });
    expect(execution).not.toBeNull();

    const enrollment = await CampaignEnrollmentModel.findOne({
      tenantId: 'shop_a',
      enrollmentId: execution!.enrollmentId,
    });
    expect(enrollment).not.toBeNull();

    // Customer's required variable becomes empty/missing in source data at late binding time (Spec p34 C05)
    await SrcCustomerModel.updateOne(
      { tenantId: 'shop_a', customerId: enrollment!.customerId },
      { $set: { firstName: '' } }
    );

    try {
      clock.setSystemTime(new Date(execution!.dueAt.getTime() + 1000));

      await workerService.runWorkerCycle({
        tenantId: 'shop_a',
        campaignId,
        batchSize: 50,
      });

      const updated = await CampaignExecutionModel.findOne({
        tenantId: 'shop_a',
        executionId: execution!.executionId,
      });
      expect(updated!.state).toBe(EXECUTION_STATE.SKIPPED);
      expect(updated!.skipReason).toBe(EXECUTION_REASONS.MISSING_VARIABLE_BINDING);

      const intent = await CampaignDeliveryIntentModel.findOne({
        tenantId: 'shop_a',
        executionId: execution!.executionId,
      });
      expect(intent).toBeNull();
    } finally {
      await SrcCustomerModel.updateOne(
        { tenantId: 'shop_a', customerId: enrollment!.customerId },
        { $set: { firstName: 'Priya' } }
      );
    }
  });

  // ===========================================================================
  // TEST 9: C09 Logic - Expiry reached beyond lateness cutoff
  // ===========================================================================
  it('C09: Expiry reached beyond lateness cutoff -> marked EXPIRED with reason EXPIRED_LATENESS_CUTOFF', async () => {
    const campaignId = await setupActiveCampaign();

    const execution = await CampaignExecutionModel.findOne({
      tenantId: 'shop_a',
      campaignId,
      stepId: 'invitation',
      state: EXECUTION_STATE.SCHEDULED,
    });
    expect(execution).not.toBeNull();

    // Advance clock past expiration cutoff (e.g. 10 hours after dueAt; maxLateness is 120 mins)
    const expiredTime = new Date(execution!.dueAt.getTime() + 10 * 3600 * 1000);
    clock.setSystemTime(expiredTime);

    await workerService.runWorkerCycle({
      tenantId: 'shop_a',
      campaignId,
      batchSize: 50,
    });

    const updated = await CampaignExecutionModel.findOne({
      tenantId: 'shop_a',
      executionId: execution!.executionId,
    });
    expect(updated!.state).toBe(EXECUTION_STATE.EXPIRED);
    expect(updated!.skipReason).toBe(EXECUTION_REASONS.EXPIRED_LATENESS_CUTOFF);

    const intent = await CampaignDeliveryIntentModel.findOne({
      tenantId: 'shop_a',
      executionId: execution!.executionId,
    });
    expect(intent).toBeNull();
  });

  // ===========================================================================
  // TEST 10: C13 Logic - Dependent reminder after unknown / failed invitation
  // ===========================================================================
  it('C13: Dependent reminder after OUTCOME_UNKNOWN invitation -> no advancement without acceptance evidence', async () => {
    const campaignId = await setupActiveCampaign();

    const enrollment = await CampaignEnrollmentModel.findOne({
      tenantId: 'shop_a',
      campaignId,
    });
    const invitation = await CampaignExecutionModel.findOne({
      tenantId: 'shop_a',
      enrollmentId: enrollment!.enrollmentId,
      stepId: 'invitation',
    });
    const followup = await CampaignExecutionModel.findOne({
      tenantId: 'shop_a',
      enrollmentId: enrollment!.enrollmentId,
      stepId: 'followup',
    });

    // Invitation submission outcome is unknown (Spec p19, p32 C13)
    invitation!.state = EXECUTION_STATE.OUTCOME_UNKNOWN;
    await invitation!.save();

    // Advance clock to followup dueAt
    clock.setSystemTime(new Date(followup!.dueAt.getTime() + 1000));

    await workerService.runWorkerCycle({
      tenantId: 'shop_a',
      campaignId,
      batchSize: 50,
    });

    // Followup must NOT be sent; must be SKIPPED with PREREQUISITE_NOT_MET
    const updatedFollowup = await CampaignExecutionModel.findOne({
      tenantId: 'shop_a',
      executionId: followup!.executionId,
    });
    expect(updatedFollowup!.state).toBe(EXECUTION_STATE.SKIPPED);
    expect(updatedFollowup!.skipReason).toBe(EXECUTION_REASONS.PREREQUISITE_NOT_MET);

    const intent = await CampaignDeliveryIntentModel.findOne({
      tenantId: 'shop_a',
      executionId: followup!.executionId,
    });
    expect(intent).toBeNull();
  });

  // ===========================================================================
  // TEST 11: USER VERIFY REQUIREMENT - Opt-out after planning sees precise skip reason
  // ===========================================================================
  it('USER VERIFICATION: Set customer to opted-out after planning -> precise skip reason MARKETING_OPT_OUT recorded', async () => {
    const campaignId = await setupActiveCampaign();

    const enrollment = await CampaignEnrollmentModel.findOne({
      tenantId: 'shop_a',
      campaignId,
    });
    expect(enrollment).not.toBeNull();
    const customerId = enrollment!.customerId;

    const execution = await CampaignExecutionModel.findOne({
      tenantId: 'shop_a',
      enrollmentId: enrollment!.enrollmentId,
      stepId: 'invitation',
      state: EXECUTION_STATE.SCHEDULED,
    });
    expect(execution).not.toBeNull();

    // 1. Customer opts out after planning (Spec p20, p32 C03)
    await SrcCustomerModel.updateOne(
      { tenantId: 'shop_a', customerId },
      { $set: { 'consent.marketingOptIn': false } }
    );

    // 2. Advance clock to dueAt
    clock.setSystemTime(new Date(execution!.dueAt.getTime() + 1000));

    // 3. Worker runs evaluation cycle
    const result = await workerService.runWorkerCycle({
      tenantId: 'shop_a',
      campaignId,
      batchSize: 50,
    });

    expect(result.cancelledCount).toBeGreaterThanOrEqual(1);

    // 4. Verify execution is CANCELLED with precise reason MARKETING_OPT_OUT
    const updatedExecution = await CampaignExecutionModel.findOne({
      tenantId: 'shop_a',
      executionId: execution!.executionId,
    });
    expect(updatedExecution!.state).toBe(EXECUTION_STATE.CANCELLED);
    expect(updatedExecution!.skipReason).toBe(EXECUTION_REASONS.MARKETING_OPT_OUT);

    // 5. Verify enrollment is marked CANCELLED and no intent is created
    const updatedEnrollment = await CampaignEnrollmentModel.findOne({
      tenantId: 'shop_a',
      enrollmentId: enrollment!.enrollmentId,
    });
    expect(updatedEnrollment!.status).toBe('CANCELLED');

    const intent = await CampaignDeliveryIntentModel.findOne({
      tenantId: 'shop_a',
      executionId: execution!.executionId,
    });
    expect(intent).toBeNull();
  });

  // ===========================================================================
  // TEST 12: GET /campaigns/:id/enrollments/:enrollmentId returns frozen intent summary
  // ===========================================================================
  it('GET /campaigns/:id/enrollments/:enrollmentId returns executions enriched with frozen delivery intent details', async () => {
    const campaignId = await setupActiveCampaign();

    const execution = await CampaignExecutionModel.findOne({
      tenantId: 'shop_a',
      campaignId,
      stepId: 'invitation',
      state: EXECUTION_STATE.SCHEDULED,
    });
    clock.setSystemTime(new Date(execution!.dueAt.getTime() + 1000));

    await workerService.runWorkerCycle({
      tenantId: 'shop_a',
      campaignId,
      batchSize: 10,
    });

    const res = await request(app)
      .get(`/campaigns/${campaignId}/enrollments/${execution!.enrollmentId}`)
      .set('Authorization', `Bearer ${shopAOwnerToken}`);

    expect(res.status).toBe(200);
    expect(res.body.executions).toBeInstanceOf(Array);

    const invitationStep = res.body.executions.find((x: any) => x.stepId === 'invitation');
    expect(invitationStep.state).toBe(EXECUTION_STATE.DISPATCHING);
    expect(invitationStep.deliveryIntent).not.toBeNull();
    expect(invitationStep.deliveryIntent.state).toBe(DELIVERY_INTENT_STATE.PREPARED_DRY);
    expect(invitationStep.deliveryIntent.maskedRecipient).toBeTruthy();
    expect(Array.isArray(invitationStep.deliveryIntent.parameters)).toBe(true);
    expect(invitationStep.deliveryIntent.parameters).toEqual(
      expect.arrayContaining([{ index: 1, text: 'Priya' }])
    );
  });

  // ===========================================================================
  // TEST 13: Immutability guard blocks mutating frozen delivery intent payload
  // ===========================================================================
  it('Frozen delivery intent is immutable: attempting to rewrite payload or recipientVersion throws error', async () => {
    const campaignId = await setupActiveCampaign();

    const execution = await CampaignExecutionModel.findOne({
      tenantId: 'shop_a',
      campaignId,
      stepId: 'invitation',
      state: EXECUTION_STATE.SCHEDULED,
    });
    clock.setSystemTime(new Date(execution!.dueAt.getTime() + 1000));

    await workerService.runWorkerCycle({
      tenantId: 'shop_a',
      campaignId,
      batchSize: 10,
    });

    const intent = await CampaignDeliveryIntentModel.findOne({
      tenantId: 'shop_a',
      executionId: execution!.executionId,
    });
    expect(intent).not.toBeNull();

    // Attempting to modify frozen parameter via save() throws Error
    intent!.parameters = { name: 'HackedName' };
    await expect(intent!.save()).rejects.toThrow(/immutable/i);

    // Attempting to modify frozen recipientVersion via updateOne() throws Error
    await expect(
      CampaignDeliveryIntentModel.updateOne(
        { _id: intent!._id },
        { $set: { recipientVersion: 99 } }
      )
    ).rejects.toThrow(/immutable/i);
  });
});

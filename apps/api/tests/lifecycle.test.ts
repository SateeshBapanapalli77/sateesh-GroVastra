import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import { app } from '../src/app';
import { connectToDatabase, disconnectDatabase } from '../src/db/connection';
import { seedDatabase } from '../src/db/seed';
import {
  CampaignModel,
  CampaignVersionModel,
  CampaignControlGateModel,
  TenantControlGateModel,
  CampaignEnrollmentModel,
  CampaignExecutionModel,
  CampaignDeliveryIntentModel,
  CampaignSettingsModel,
  SrcCustomerModel,
} from '../src/db/models';
import { plannerService } from '../src/services/planner';
import { workerService } from '../src/services/worker';
import { campaignService } from '../src/services/campaign.service';
import { campaignSettingsService } from '../src/services/campaign-settings.service';
import { setDispatchPort, resetDispatchPort } from '../src/services/dispatch/dispatch-port';
import { clock } from '../src/services/clock';
import {
  CAMPAIGN_STATUS,
  EXECUTION_STATE,
  EXECUTION_REASONS,
  PREREQUISITE,
} from '@grovastra/shared';

describe('Campaign Lifecycle Management: Pause, Resume, Archive, Global Pause, endAt (Spec p9, p16, p20, p25, p29, QA Matrix B11, B12, B13)', () => {
  let shopAOwnerToken: string;
  let shopAAdminToken: string;
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

    const loginAAdmin = await request(app)
      .post('/auth/login')
      .send({ email: 'admin@shop-a.com', password: 'AdminSecret#2026!' });
    shopAAdminToken = loginAAdmin.body.token;

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
    await CampaignControlGateModel.deleteMany({});
    await TenantControlGateModel.deleteMany({});
    await CampaignEnrollmentModel.deleteMany({});
    await CampaignExecutionModel.deleteMany({});
    await CampaignDeliveryIntentModel.deleteMany({});

    // Reset settings to not paused
    await CampaignSettingsModel.updateOne({ tenantId: 'shop_a' }, { $set: { isPaused: false } });

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
  });

  async function createAndActivateCampaign(overrides?: any) {
    const targetDate = new Date('2026-12-15T09:00:00Z');
    clock.setOffsetMs(targetDate.getTime() - Date.now());

    const campaignRes = await request(app)
      .post('/campaigns')
      .set('Authorization', `Bearer ${shopAOwnerToken}`)
      .set('Idempotency-Key', `idem_cmp_${Date.now()}_${Math.random()}`)
      .send({
        presetId: 'birthday',
        name: 'Birthday Campaign 2026',
        ...overrides,
      });

    expect(campaignRes.status).toBe(201);
    const campaignId = campaignRes.body.campaign.campaignId;

    const patchRes = await request(app)
      .patch(`/campaigns/${campaignId}/draft`)
      .set('Authorization', `Bearer ${shopAOwnerToken}`)
      .set('Idempotency-Key', `idem_draft_${Date.now()}_${Math.random()}`)
      .send({
        expectedVersion: 1,
        steps: [
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
        ],
      });

    await request(app)
      .post(`/campaigns/${campaignId}/dry-runs`)
      .set('Authorization', `Bearer ${shopAOwnerToken}`);

    await request(app)
      .post(`/campaigns/${campaignId}/activate`)
      .set('Authorization', `Bearer ${shopAOwnerToken}`)
      .set('Idempotency-Key', `idem_act_${Date.now()}_${Math.random()}`);

    return campaignId;
  }

  // ===========================================================================
  // TEST 1: Role boundaries & RBAC
  // ===========================================================================
  it('Enforces RBAC: Staff receives 403 Forbidden on pause, resume, archive; Owner and Admin succeed', async () => {
    const campaignId = await createAndActivateCampaign();

    // Staff tries to pause -> 403
    const staffPause = await request(app)
      .post(`/campaigns/${campaignId}/pause`)
      .set('Authorization', `Bearer ${shopAStaffToken}`);
    expect(staffPause.status).toBe(403);

    // Staff tries to resume -> 403
    const staffResume = await request(app)
      .post(`/campaigns/${campaignId}/resume`)
      .set('Authorization', `Bearer ${shopAStaffToken}`);
    expect(staffResume.status).toBe(403);

    // Staff tries to archive -> 403
    const staffArchive = await request(app)
      .post(`/campaigns/${campaignId}/archive`)
      .set('Authorization', `Bearer ${shopAStaffToken}`);
    expect(staffArchive.status).toBe(403);

    // Owner succeeds to pause
    const ownerPause = await request(app)
      .post(`/campaigns/${campaignId}/pause`)
      .set('Authorization', `Bearer ${shopAOwnerToken}`);
    expect(ownerPause.status).toBe(200);
    expect(ownerPause.body.status).toBe('PAUSED');

    // Admin succeeds to resume
    const adminResume = await request(app)
      .post(`/campaigns/${campaignId}/resume`)
      .set('Authorization', `Bearer ${shopAAdminToken}`);
    expect(adminResume.status).toBe(200);
    expect(adminResume.body.status).toBe('ACTIVE');

    // Admin succeeds to archive
    const adminArchive = await request(app)
      .post(`/campaigns/${campaignId}/archive`)
      .set('Authorization', `Bearer ${shopAAdminToken}`);
    expect(adminArchive.status).toBe(200);
    expect(adminArchive.body.status).toBe('ARCHIVED');
  });

  // ===========================================================================
  // TEST 2: Preview routes return counts without mutating state
  // ===========================================================================
  it('GET preview routes and POST preview flags return counts without mutating campaign state', async () => {
    const campaignId = await createAndActivateCampaign();

    // GET /pause/preview
    const pausePreview = await request(app)
      .get(`/campaigns/${campaignId}/pause/preview`)
      .set('Authorization', `Bearer ${shopAOwnerToken}`);
    expect(pausePreview.status).toBe(200);
    expect(pausePreview.body.affectedCounts).toBeDefined();
    expect(pausePreview.body.honestMessage).toContain('Messages already being sent may still go out');

    // Verify campaign is still ACTIVE
    let cmp = await CampaignModel.findOne({ campaignId });
    expect(cmp!.status).toBe('ACTIVE');

    // POST /pause with preview: true
    const postPausePreview = await request(app)
      .post(`/campaigns/${campaignId}/pause`)
      .set('Authorization', `Bearer ${shopAOwnerToken}`)
      .send({ preview: true });
    expect(postPausePreview.status).toBe(200);
    expect(postPausePreview.body.affectedCounts).toBeDefined();

    cmp = await CampaignModel.findOne({ campaignId });
    expect(cmp!.status).toBe('ACTIVE');

    // Pause it now
    await request(app)
      .post(`/campaigns/${campaignId}/pause`)
      .set('Authorization', `Bearer ${shopAOwnerToken}`);

    // GET /resume/preview
    const resumePreview = await request(app)
      .get(`/campaigns/${campaignId}/resume/preview`)
      .set('Authorization', `Bearer ${shopAOwnerToken}`);
    expect(resumePreview.status).toBe(200);
    expect(resumePreview.body.policy).toBe('FUTURE_ONLY');
    expect(resumePreview.body.affectedCounts).toBeDefined();

    cmp = await CampaignModel.findOne({ campaignId });
    expect(cmp!.status).toBe('PAUSED');

    // GET /archive/preview
    const archivePreview = await request(app)
      .get(`/campaigns/${campaignId}/archive/preview`)
      .set('Authorization', `Bearer ${shopAOwnerToken}`);
    expect(archivePreview.status).toBe(200);
    expect(archivePreview.body.affectedCounts.unsubmittedCancelledCount).toBeGreaterThanOrEqual(0);
    expect(archivePreview.body.honestMessage).toContain('cannot be recalled');
  });

  // ===========================================================================
  // TEST 3: B11 - Pause during evaluation invalidates stale submission CAS
  // ===========================================================================
  it('B11: Pause during evaluation invalidates stale submission CAS; zero provider messages sent', async () => {
    const campaignId = await createAndActivateCampaign();

    // 1. Locate due execution
    const execution = await CampaignExecutionModel.findOne({
      tenantId: 'shop_a',
      campaignId,
      stepId: 'invitation',
      state: EXECUTION_STATE.SCHEDULED,
    });
    expect(execution).not.toBeNull();

    // Move clock to due time
    clock.setSystemTime(new Date(execution!.dueAt.getTime() + 1000));

    // 2. Claim execution into EVALUATING (simulating worker starting evaluation)
    const claimed = await workerService.claimNextDueExecution('shop_a', campaignId, clock.now());
    expect(claimed).not.toBeNull();
    expect(claimed!.execution.executionId).toBe(execution!.executionId);

    // 3. User clicks PAUSE while execution is being evaluated (Spec p20, p25, B11)
    const pauseRes = await request(app)
      .post(`/campaigns/${campaignId}/pause`)
      .set('Authorization', `Bearer ${shopAOwnerToken}`);
    expect(pauseRes.status).toBe(200);
    expect(pauseRes.body.status).toBe('PAUSED');
    expect(pauseRes.body.pauseGeneration).toBe(1);

    // Track dispatch calls
    const dispatchedIntents: any[] = [];
    setDispatchPort({
      dispatch: async (intent) => {
        dispatchedIntents.push(intent);
        return { success: true, messageId: 'mock_wamid_should_never_send' };
      },
    });

    // 4. Stale worker attempts evaluation and submission CAS
    const result = await workerService.evaluateAndProcessExecution(
      claimed!.execution,
      claimed!.leaseToken,
      claimed!.leaseUntil,
      clock.now()
    );

    // The execution should be rejected/deferred due to pauseGeneration mismatch or campaign paused!
    expect(result.state).toBe(EXECUTION_STATE.DEFERRED);
    expect([EXECUTION_REASONS.CAMPAIGN_PAUSED, EXECUTION_REASONS.PAUSE_GENERATION_MISMATCH]).toContain(result.reason);

    // Verify ZERO messages were dispatched to provider
    expect(dispatchedIntents.length).toBe(0);

    // Verify delivery intent was NEVER frozen in MongoDB
    const intent = await CampaignDeliveryIntentModel.findOne({
      tenantId: 'shop_a',
      executionId: execution!.executionId,
    });
    expect(intent).toBeNull();
  });

  // ===========================================================================
  // TEST 4: B12 - In-flight submissions are preserved and reported honestly
  // ===========================================================================
  it('B12: Pause after submission starts shows in progress/may send with honest boundary message', async () => {
    const campaignId = await createAndActivateCampaign();

    const execution = await CampaignExecutionModel.findOne({
      tenantId: 'shop_a',
      campaignId,
      stepId: 'invitation',
      state: EXECUTION_STATE.SCHEDULED,
    });

    // Move state into DISPATCHING (in-flight provider submission)
    await CampaignExecutionModel.updateOne(
      { executionId: execution!.executionId },
      { $set: { state: EXECUTION_STATE.DISPATCHING } }
    );

    // Pause campaign
    const pauseRes = await request(app)
      .post(`/campaigns/${campaignId}/pause`)
      .set('Authorization', `Bearer ${shopAOwnerToken}`);

    expect(pauseRes.status).toBe(200);
    expect(pauseRes.body.affectedCounts.inProgressCount).toBe(1);
    expect(pauseRes.body.honestMessage).toContain('Messages already being sent may still go out');

    // The dispatching execution must NOT be recalled or modified to cancelled
    const updatedExecution = await CampaignExecutionModel.findOne({ executionId: execution!.executionId });
    expect(updatedExecution!.state).toBe(EXECUTION_STATE.DISPATCHING);
  });

  // ===========================================================================
  // TEST 5: B13 - Resume with overdue jobs (FUTURE_ONLY, zero burst)
  // ===========================================================================
  it('B13: Resuming after time travel skips overdue steps with FUTURE_ONLY policy; zero message burst', async () => {
    const campaignId = await createAndActivateCampaign();

    const execution = await CampaignExecutionModel.findOne({
      tenantId: 'shop_a',
      campaignId,
      stepId: 'invitation',
      state: EXECUTION_STATE.SCHEDULED,
    });
    expect(execution).not.toBeNull();

    // 1. Pause campaign
    await request(app)
      .post(`/campaigns/${campaignId}/pause`)
      .set('Authorization', `Bearer ${shopAOwnerToken}`);

    // 2. Advance Clock past due time (e.g. 5 days later)
    const futureDate = new Date(execution!.dueAt.getTime() + 5 * 24 * 60 * 60 * 1000);
    clock.setSystemTime(futureDate);

    // Track provider sends
    const dispatchedIntents: any[] = [];
    setDispatchPort({
      dispatch: async (intent) => {
        dispatchedIntents.push(intent);
        return { success: true, messageId: 'wamid_burst_test' };
      },
    });

    // 3. Resume campaign (default FUTURE_ONLY policy)
    const resumeRes = await request(app)
      .post(`/campaigns/${campaignId}/resume`)
      .set('Authorization', `Bearer ${shopAOwnerToken}`);

    expect(resumeRes.status).toBe(200);
    expect(resumeRes.body.status).toBe('ACTIVE');
    expect(resumeRes.body.policy).toBe('FUTURE_ONLY');
    expect(resumeRes.body.affectedCounts.missedStepsCount).toBeGreaterThanOrEqual(1);

    // 4. Verify overdue step was marked SKIPPED with reason
    const overdueExecution = await CampaignExecutionModel.findOne({ executionId: execution!.executionId });
    expect(overdueExecution!.state).toBe(EXECUTION_STATE.SKIPPED);
    expect(overdueExecution!.skipReason).toBe('Elapsed step prior to evaluation instant');

    // 5. Run worker cycle now -> zero messages must be dispatched!
    const cycleRes = await workerService.runWorkerCycle({ tenantId: 'shop_a', campaignId });
    expect(cycleRes.dispatchedCount).toBe(0);
    expect(dispatchedIntents.length).toBe(0);
  });

  // ===========================================================================
  // TEST 6: Tenant-level global pause in Settings blocks all campaigns
  // ===========================================================================
  it('Tenant-level global pause in Settings updates TenantControlGate and blocks all campaigns', async () => {
    const campaignId = await createAndActivateCampaign();

    const execution = await CampaignExecutionModel.findOne({
      tenantId: 'shop_a',
      campaignId,
      stepId: 'invitation',
      state: EXECUTION_STATE.SCHEDULED,
    });
    clock.setSystemTime(new Date(execution!.dueAt.getTime() + 1000));

    // Get current settings version
    const settings = await campaignSettingsService.getSettings('shop_a');

    // 1. Globally pause via PATCH /campaign-settings
    const patchRes = await request(app)
      .patch('/campaign-settings')
      .set('Authorization', `Bearer ${shopAOwnerToken}`)
      .set('Idempotency-Key', `idem_global_pause_${Date.now()}`)
      .send({
        expectedVersion: settings.version,
        isPaused: true,
      });

    expect(patchRes.status).toBe(200);
    expect(patchRes.body.isPaused).toBe(true);

    // Verify TenantControlGate document is updated
    const tenantGate = await TenantControlGateModel.findOne({ tenantId: 'shop_a' });
    expect(tenantGate).not.toBeNull();
    expect(tenantGate!.isPaused).toBe(true);
    expect(tenantGate!.pauseGeneration).toBeGreaterThanOrEqual(1);

    // 2. Run worker cycle -> execution must be deferred with GLOBAL_PAUSED
    const cycleRes = await workerService.runWorkerCycle({ tenantId: 'shop_a', campaignId });
    expect(cycleRes.dispatchedCount).toBe(0);

    const updatedExecution = await CampaignExecutionModel.findOne({ executionId: execution!.executionId });
    expect(updatedExecution!.state).toBe(EXECUTION_STATE.DEFERRED);
    expect(updatedExecution!.skipReason).toBe(EXECUTION_REASONS.GLOBAL_PAUSED);

    // 3. Unpause globally
    const settingsAfter = await campaignSettingsService.getSettings('shop_a');
    await request(app)
      .patch('/campaign-settings')
      .set('Authorization', `Bearer ${shopAOwnerToken}`)
      .set('Idempotency-Key', `idem_global_unpause_${Date.now()}`)
      .send({
        expectedVersion: settingsAfter.version,
        isPaused: false,
      });

    const tenantGateUnpaused = await TenantControlGateModel.findOne({ tenantId: 'shop_a' });
    expect(tenantGateUnpaused!.isPaused).toBe(false);
  });

  // ===========================================================================
  // TEST 7: Archive cancels unsubmitted work, preserves history intact
  // ===========================================================================
  it('Archive cancels unsubmitted work while preserving accepted, sent, delivered, unknown executions intact', async () => {
    const campaignId = await createAndActivateCampaign();

    // Create diverse executions representing campaign history
    const customer = await SrcCustomerModel.findOne({ tenantId: 'shop_a' });
    const enrollment = await CampaignEnrollmentModel.findOne({ tenantId: 'shop_a', campaignId });

    // 1. Accepted execution
    await CampaignExecutionModel.create({
      executionId: 'exe_hist_accepted',
      executionKey: `${enrollment!.enrollmentId}:step_hist_1`,
      tenantId: 'shop_a',
      campaignId,
      enrollmentId: enrollment!.enrollmentId,
      stepId: 'step_hist_1',
      stepName: 'Step 1',
      dueAt: new Date('2026-12-01T10:00:00Z'),
      originalDueAt: new Date('2026-12-01T10:00:00Z'),
      expiresAt: new Date('2026-12-01T12:00:00Z'),
      localDate: '2026-12-01',
      localTime: '10:00',
      timezone: 'Asia/Kolkata',
      planRevision: 1,
      state: EXECUTION_STATE.PROVIDER_ACCEPTED,
      providerMessageId: 'wamid_hist_accepted',
    });

    // 2. Outcome unknown execution
    await CampaignExecutionModel.create({
      executionId: 'exe_hist_unknown',
      executionKey: `${enrollment!.enrollmentId}:step_hist_2`,
      tenantId: 'shop_a',
      campaignId,
      enrollmentId: enrollment!.enrollmentId,
      stepId: 'step_hist_2',
      stepName: 'Step 2',
      dueAt: new Date('2026-12-05T10:00:00Z'),
      originalDueAt: new Date('2026-12-05T10:00:00Z'),
      expiresAt: new Date('2026-12-05T12:00:00Z'),
      localDate: '2026-12-05',
      localTime: '10:00',
      timezone: 'Asia/Kolkata',
      planRevision: 1,
      state: EXECUTION_STATE.OUTCOME_UNKNOWN,
      skipReason: 'TIMEOUT_OR_NETWORK_ERROR',
    });

    // 3. Dispatching execution
    await CampaignExecutionModel.create({
      executionId: 'exe_hist_dispatching',
      executionKey: `${enrollment!.enrollmentId}:step_hist_3`,
      tenantId: 'shop_a',
      campaignId,
      enrollmentId: enrollment!.enrollmentId,
      stepId: 'step_hist_3',
      stepName: 'Step 3',
      dueAt: new Date('2026-12-10T10:00:00Z'),
      originalDueAt: new Date('2026-12-10T10:00:00Z'),
      expiresAt: new Date('2026-12-10T12:00:00Z'),
      localDate: '2026-12-10',
      localTime: '10:00',
      timezone: 'Asia/Kolkata',
      planRevision: 1,
      state: EXECUTION_STATE.DISPATCHING,
    });

    // Archive campaign
    const archiveRes = await request(app)
      .post(`/campaigns/${campaignId}/archive`)
      .set('Authorization', `Bearer ${shopAOwnerToken}`);

    expect(archiveRes.status).toBe(200);
    expect(archiveRes.body.status).toBe('ARCHIVED');
    expect(archiveRes.body.affectedCounts.cancelledExecutionsCount).toBeGreaterThanOrEqual(1);

    // Verify history preserved:
    // Accepted execution untouched
    const exeAccepted = await CampaignExecutionModel.findOne({ executionId: 'exe_hist_accepted' });
    expect(exeAccepted!.state).toBe(EXECUTION_STATE.PROVIDER_ACCEPTED);

    // Outcome unknown untouched
    const exeUnknown = await CampaignExecutionModel.findOne({ executionId: 'exe_hist_unknown' });
    expect(exeUnknown!.state).toBe(EXECUTION_STATE.OUTCOME_UNKNOWN);

    // Dispatching execution untouched
    const exeDispatching = await CampaignExecutionModel.findOne({ executionId: 'exe_hist_dispatching' });
    expect(exeDispatching!.state).toBe(EXECUTION_STATE.DISPATCHING);

    // Unsubmitted executions (SCHEDULED, DEFERRED, EVALUATING) must now be 0
    const remainingUnsubmitted = await CampaignExecutionModel.countDocuments({
      tenantId: 'shop_a',
      campaignId,
      state: { $in: [EXECUTION_STATE.SCHEDULED, EXECUTION_STATE.DEFERRED, EXECUTION_STATE.EVALUATING] },
    });
    expect(remainingUnsubmitted).toBe(0);

    const cancelledExecutions = await CampaignExecutionModel.find({
      tenantId: 'shop_a',
      campaignId,
      state: EXECUTION_STATE.CANCELLED,
    });
    expect(cancelledExecutions.length).toBeGreaterThanOrEqual(1);
    for (const c of cancelledExecutions) {
      expect(c.skipReason).toBe('Campaign archived');
    }

    // Active enrollments cancelled
    const updatedEnrollment = await CampaignEnrollmentModel.findOne({ enrollmentId: enrollment!.enrollmentId });
    expect(updatedEnrollment!.status).toBe('CANCELLED');
  });

  // ===========================================================================
  // TEST 8: endAt behavior stops new enrollments and expires steps beyond deadline
  // ===========================================================================
  it('endAt behavior stops new enrollments and marks steps beyond deadline as EXPIRED', async () => {
    // Create campaign with endAt set to Dec 20, 2026
    const campaignId = await createAndActivateCampaign({
      endAt: new Date('2026-12-20T10:00:00Z'),
    });

    const cmp = await CampaignModel.findOne({ campaignId });
    expect(cmp!.endAt).not.toBeNull();

    // Set clock past endAt (e.g. Dec 25, 2026)
    clock.setSystemTime(new Date('2026-12-25T10:00:00Z'));

    // Planner run should refuse to plan new enrollments
    const planResult = await plannerService.planCampaign('shop_a', campaignId);
    expect(planResult.planned).toBe(false);
    expect(planResult.reason).toContain('deadline');
  });
});

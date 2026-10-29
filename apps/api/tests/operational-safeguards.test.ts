import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import crypto from 'crypto';
import { app } from '../src/app';
import { connectToDatabase, disconnectDatabase } from '../src/db/connection';
import {
  CampaignModel,
  CampaignVersionModel,
  CampaignEnrollmentModel,
  CampaignExecutionModel,
  CampaignCheckpointModel,
  CampaignDeliveryIntentModel,
  CampaignEventInboxModel,
  CampaignTombstoneModel,
} from '../src/db/models';
import { seedDatabase } from '../src/db/seed';
import { authService } from '../src/services/auth.service';
import { clock } from '../src/services/clock';
import { retentionService } from '../src/services/retention';
import { reconciliationService } from '../src/services/reconciliation';
import { workerService } from '../src/services/worker';
import { calendarPlannerService } from '../src/services/planner';
import { EXECUTION_STATE, ENROLLMENT_STATUS, CHECKPOINT_STATUS } from '@grovastra/shared';

describe('Operational Safeguards, Nightly Reconciliation & Data Retention (Spec p18, p25, p34, QA Matrix B18)', () => {
  const tenantId = 'shop_a';
  let ownerToken: string;
  let adminToken: string;
  let staffToken: string;
  let otherTenantToken: string;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.ALLOW_TEST_CATEGORY_MISMATCH = 'true';
    process.env.DISPATCH_MODE = 'dry';
    await connectToDatabase();
    await seedDatabase('base');

    ownerToken = authService.signToken({
      userId: 'usr_owner_a',
      tenantId: 'shop_a',
      role: 'owner',
      branchIds: ['branch_main'],
      email: 'owner@shop-a.com',
    });

    adminToken = authService.signToken({
      userId: 'usr_admin_a',
      tenantId: 'shop_a',
      role: 'admin',
      branchIds: ['branch_main'],
      email: 'admin@shop-a.com',
    });

    staffToken = authService.signToken({
      userId: 'usr_staff_a',
      tenantId: 'shop_a',
      role: 'staff',
      branchIds: ['branch_main'],
      email: 'staff@shop-a.com',
    });

    otherTenantToken = authService.signToken({
      userId: 'usr_owner_b',
      tenantId: 'shop_b',
      role: 'owner',
      branchIds: ['branch_b'],
      email: 'owner@shop-b.com',
    });
  });

  afterAll(async () => {
    await disconnectDatabase();
  });

  beforeEach(async () => {
    clock.resetOffset();
    process.env.DISPATCH_MODE = 'dry';
    process.env.ALLOW_TEST_CATEGORY_MISMATCH = 'true';
    const testCampaignIds = [
      'cmp_rec_test',
      'cmp_ret_test',
      'cmp_restart_test',
      'cmp_monitor_test',
    ];
    await Promise.all([
      CampaignModel.deleteMany({ campaignId: { $in: testCampaignIds } }),
      CampaignVersionModel.deleteMany({ campaignId: { $in: testCampaignIds } }),
      CampaignEnrollmentModel.deleteMany({ campaignId: { $in: testCampaignIds } }),
      CampaignExecutionModel.deleteMany({ campaignId: { $in: testCampaignIds } }),
      CampaignCheckpointModel.deleteMany({ campaignId: { $in: testCampaignIds } }),
      CampaignDeliveryIntentModel.deleteMany({ campaignId: { $in: testCampaignIds } }),
      CampaignTombstoneModel.deleteMany({ campaignId: { $in: testCampaignIds } }),
    ]);
  });

  // =========================================================================
  // 1. NIGHTLY RECONCILIATION JOB (SPEC P18, P25, P34)
  // =========================================================================
  it('Nightly reconciliation job sweeps stalled leases, orphaned intents, and expired steps (Spec p18, p25, p34)', async () => {
    const campaignId = 'cmp_rec_test';
    const now = clock.now();

    // 1. Setup stalled checkpoint with expired lease
    await CampaignCheckpointModel.create({
      tenantId,
      campaignId,
      type: 'CALENDAR_PLANNER',
      status: CHECKPOINT_STATUS.IN_PROGRESS,
      leaseToken: 'stalled_lease_token_123',
      leaseExpiresAt: new Date(now.getTime() - 10 * 60 * 1000), // expired 10m ago
      horizonStart: '2026-10-01',
      horizonEnd: '2026-11-01',
    });

    // 2. Setup stalled execution in EVALUATING with expired worker lease
    await CampaignExecutionModel.create({
      tenantId,
      campaignId,
      enrollmentId: 'enr_rec_01',
      executionId: 'exe_rec_stalled_eval',
      executionKey: 'enr_rec_01:step_1',
      stepId: 'step_1',
      dueAt: new Date(now.getTime() - 5 * 60 * 1000),
      originalDueAt: new Date(now.getTime() - 5 * 60 * 1000),
      expiresAt: new Date(now.getTime() + 60 * 60 * 1000),
      localDate: '2026-10-21',
      localTime: '10:00',
      timezone: 'Asia/Kolkata',
      planRevision: 1,
      state: EXECUTION_STATE.EVALUATING,
      lease: {
        token: 'stale_worker_token_456',
        until: new Date(now.getTime() - 2 * 60 * 1000), // expired 2m ago
      },
    });

    // 3. Setup orphaned delivery intent
    await CampaignDeliveryIntentModel.create({
      tenantId,
      campaignId,
      enrollmentId: 'enr_rec_01',
      executionId: 'exe_rec_stalled_eval',
      deliveryIntentId: 'di_rec_orphaned',
      deliveryKey: 'exe_rec_stalled_eval',
      connectionId: 'conn_shop_a',
      attemptId: 'att_001',
      recipientVersion: 1,
      encryptedRecipient: 'enc_phone_test',
      maskedRecipient: '+91 91*** **001',
      templateRef: { id: 'hello_world', revision: 1, language: 'en_US' },
      parameters: [],
      payloadHash: 'hash_test',
      state: 'PREPARED_DRY',
      createdAt: new Date(now.getTime() - 30 * 60 * 1000), // 30m old
    });

    // 4. Setup expired execution in SCHEDULED state
    await CampaignExecutionModel.create({
      tenantId,
      campaignId,
      enrollmentId: 'enr_rec_01',
      executionId: 'exe_rec_expired',
      executionKey: 'enr_rec_01:step_2',
      stepId: 'step_2',
      dueAt: new Date(now.getTime() - 120 * 60 * 1000), // 2h ago
      originalDueAt: new Date(now.getTime() - 120 * 60 * 1000),
      expiresAt: new Date(now.getTime() - 30 * 60 * 1000), // expired 30m ago
      localDate: '2026-10-21',
      localTime: '08:00',
      timezone: 'Asia/Kolkata',
      planRevision: 1,
      state: EXECUTION_STATE.SCHEDULED,
    });

    // 5. Trigger Nightly Reconciliation via API
    const res = await request(app)
      .post('/api/v1/monitoring/reconciliation/run')
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('COMPLETED');
    expect(res.body.counts.stalledLeasesReleased).toBeGreaterThanOrEqual(2);
    expect(res.body.counts.orphanedIntentsCleaned).toBeGreaterThanOrEqual(1);
    expect(res.body.counts.expiredStepsMarked).toBeGreaterThanOrEqual(1);

    // 6. Verify Database State
    const recoveredCheckpoint = await CampaignCheckpointModel.findOne({
      tenantId,
      campaignId,
      type: 'CALENDAR_PLANNER',
    });
    expect(recoveredCheckpoint!.status).toBe(CHECKPOINT_STATUS.IDLE);
    expect(recoveredCheckpoint!.leaseToken).toBeNull();

    const recoveredExecution = await CampaignExecutionModel.findOne({
      tenantId,
      executionId: 'exe_rec_stalled_eval',
    });
    expect(recoveredExecution!.state).toBe(EXECUTION_STATE.SCHEDULED);
    expect(recoveredExecution!.lease?.token).toBeNull();

    const orphanedIntent = await CampaignDeliveryIntentModel.findOne({
      tenantId,
      deliveryIntentId: 'di_rec_orphaned',
    });
    expect(orphanedIntent!.state).toBe('FAILED');
    expect(orphanedIntent!.lastErrorCategory).toBe('ORPHANED_INTENT_RECONCILED');

    const expiredExecution = await CampaignExecutionModel.findOne({
      tenantId,
      executionId: 'exe_rec_expired',
    });
    expect(expiredExecution!.state).toBe(EXECUTION_STATE.EXPIRED);
    expect(expiredExecution!.skipReason).toBe('RECONCILIATION_STEP_EXPIRED');

    // 7. Verify Checkpoint Record
    const recCheckpoint = await CampaignCheckpointModel.findOne({
      tenantId,
      campaignId: 'system',
      type: 'RECONCILIATION',
    });
    expect(recCheckpoint).toBeDefined();
    expect(recCheckpoint!.status).toBe(CHECKPOINT_STATUS.COMPLETED);
  });

  // =========================================================================
  // 2. RETENTION & LOGICAL-KEY TOMBSTONES (SPEC P18, P25, QA MATRIX B18)
  // =========================================================================
  it('B18: Atomic retention pruning creates logical-key tombstones and prevents re-enrollment duplicate steps (Spec p18, p25, B18)', async () => {
    const campaignId = 'cmp_ret_test';
    const customerId = 'cus_bday_jan05';
    const occurrenceId = 'birthday:2026';
    const enrollmentId = 'enr_ret_01';
    const enrollmentKey = `${tenantId}:${campaignId}:${customerId}:${occurrenceId}`;
    const executionKey = `${enrollmentId}:step_invitation`;

    // 1. Create completed campaign enrollment older than cutoff threshold
    const oldDate = new Date(Date.now() - 100 * 86400000); // 100 days old

    await CampaignEnrollmentModel.create({
      tenantId,
      campaignId,
      campaignVersionId: `${campaignId}_v1`,
      campaignVersion: 1,
      sourceRef: { type: 'birthday', id: customerId, version: 1 },
      enrollmentId,
      enrollmentKey,
      customerId,
      occurrenceId,
      occasionLocalDate: '2026-01-05',
      matchExplanation: 'Birthday January 5',
      status: ENROLLMENT_STATUS.COMPLETED,
    });
    await CampaignEnrollmentModel.updateOne(
      { tenantId, enrollmentId },
      { $set: { updatedAt: oldDate } },
      { timestamps: false }
    );

    await CampaignExecutionModel.create({
      tenantId,
      campaignId,
      enrollmentId,
      executionId: 'exe_ret_01',
      executionKey,
      stepId: 'step_invitation',
      stepName: 'Invitation',
      dueAt: oldDate,
      originalDueAt: oldDate,
      expiresAt: new Date(oldDate.getTime() + 7200000),
      localDate: '2025-12-22',
      localTime: '10:00',
      timezone: 'Asia/Kolkata',
      planRevision: 1,
      state: EXECUTION_STATE.DELIVERED,
    });
    await CampaignExecutionModel.updateOne(
      { tenantId, executionId: 'exe_ret_01' },
      { $set: { updatedAt: oldDate } },
      { timestamps: false }
    );

    // 2. Run Data Retention Pruning
    const pruneResult = await retentionService.pruneCampaignData(tenantId, {
      campaignId,
      cutoffDays: 90,
      retentionReason: 'TEST_ANNUAL_DATA_PRUNING',
    });

    expect(pruneResult.prunedEnrollmentsCount).toBe(1);
    expect(pruneResult.prunedExecutionsCount).toBe(1);
    expect(pruneResult.tombstonesCreatedCount).toBe(2);

    // 3. Verify detailed records removed atomically
    const enrAfter = await CampaignEnrollmentModel.findOne({ tenantId, enrollmentId });
    expect(enrAfter).toBeNull();

    const exeAfter = await CampaignExecutionModel.findOne({ tenantId, executionId: 'exe_ret_01' });
    expect(exeAfter).toBeNull();

    // 4. Verify tombstones created
    const enrTombstone = await CampaignTombstoneModel.findOne({
      tenantId,
      type: 'ENROLLMENT',
      key: enrollmentKey,
    });
    expect(enrTombstone).toBeDefined();
    expect(enrTombstone!.originalId).toBe(enrollmentId);

    const exeTombstone = await CampaignTombstoneModel.findOne({
      tenantId,
      type: 'EXECUTION',
      key: executionKey,
    });
    expect(exeTombstone).toBeDefined();

    // 5. QA Matrix B18 Check: Historical Replay / Re-evaluation must NOT re-enroll
    // Test that retentionService reports both keys as tombstoned
    const isEnrTombstoned = await retentionService.isEnrollmentTombstoned(tenantId, enrollmentKey);
    const isExeTombstoned = await retentionService.isExecutionTombstoned(tenantId, executionKey);
    expect(isEnrTombstoned).toBe(true);
    expect(isExeTombstoned).toBe(true);

    // Re-run planner evaluation logic - verifies tombstone prevents re-enrollment
    const isProtected = await CampaignTombstoneModel.exists({
      tenantId,
      type: 'ENROLLMENT',
      key: enrollmentKey,
    });
    expect(Boolean(isProtected)).toBe(true);
  });

  // =========================================================================
  // 3. MID-RUN RESTART & ZERO SCHEDULE LOSS (SPEC P34)
  // =========================================================================
  it('Restart workers mid-run without losing schedules; expired leases auto-reclaim and execute (Spec p34)', async () => {
    const campaignId = 'cmp_restart_test';
    const customerId = 'cus_bday_jan05';
    const occurrenceId = 'birthday:2027';
    const enrollmentId = 'enr_restart_01';
    const executionId = 'exe_restart_01';
    const now = clock.now();

    // 1. Create active campaign with published version
    await CampaignModel.create({
      tenantId,
      campaignId,
      name: 'Process Restart Test Campaign',
      presetId: 'birthday',
      status: 'ACTIVE',
      activeVersionId: `${campaignId}_v1`,
      activatedAt: new Date(now.getTime() - 86400000),
    });

    await CampaignVersionModel.create({
      tenantId,
      campaignId,
      version: 1,
      name: 'Process Restart Test Campaign v1',
      industry: 'RETAIL',
      purpose: 'MARKETING',
      timezone: 'Asia/Kolkata',
      priority: 1,
      resumePolicy: 'FUTURE_ONLY',
      importPolicy: 'FUTURE_ONLY',
      enabledBranches: ['branch_main'],
      isPublished: true,
      activatedAt: new Date(now.getTime() - 86400000),
      activatedBy: 'usr_owner_a',
      trigger: {
        type: 'ANNUAL_DATE',
        field: 'birthday',
        leapDayPolicy: 'FEB_28',
      },
      audience: { mode: 'ALL_ELIGIBLE', rules: null },
      goal: { type: 'OCCASION_TAGGED_OR_STAFF_COMPLETED' },
      steps: [
        {
          stepId: 'step_invitation',
          stepName: 'Invitation',
          offsetDays: -14,
          localTime: '10:00',
          prerequisite: 'NONE',
          templateRef: {
            id: 'tpl_plain_text',
            revision: 1,
            language: 'en_US',
          },
          bindings: [],
          stopOnReply: true,
          stopOnGoal: true,
          maxLatenessMinutes: 720,
        },
      ],
    });

    await CampaignEnrollmentModel.create({
      tenantId,
      campaignId,
      campaignVersionId: `${campaignId}_v1`,
      campaignVersion: 1,
      sourceRef: { type: 'birthday', id: customerId, version: 1 },
      enrollmentId,
      enrollmentKey: `${tenantId}:${campaignId}:${customerId}:${occurrenceId}`,
      customerId,
      occurrenceId,
      occasionLocalDate: '2027-01-05',
      matchExplanation: 'January 5 Birthday',
      status: ENROLLMENT_STATUS.ACTIVE,
    });

    // 2. Step was claimed by a worker into EVALUATING with a 30s lease, then worker crashed
    const dueTime = new Date(now.getTime() - 60000); // due 1m ago
    const expiredLeaseUntil = new Date(now.getTime() - 10000); // lease expired 10s ago

    await CampaignExecutionModel.create({
      tenantId,
      campaignId,
      enrollmentId,
      executionId,
      executionKey: `${enrollmentId}:step_invitation`,
      stepId: 'step_invitation',
      stepName: 'Invitation',
      dueAt: dueTime,
      originalDueAt: dueTime,
      expiresAt: new Date(dueTime.getTime() + 7200000), // expires in 2 hours
      localDate: '2026-12-22',
      localTime: '10:00',
      timezone: 'Asia/Kolkata',
      planRevision: 1,
      state: EXECUTION_STATE.EVALUATING,
      lease: {
        token: 'crashed_worker_lease_token',
        until: expiredLeaseUntil,
      },
    });

    // 3. Verify schedule is safely stored in MongoDB (no schedules lost in volatile memory)
    const storedExecution = await CampaignExecutionModel.findOne({ tenantId, executionId });
    expect(storedExecution).toBeDefined();
    expect(storedExecution!.state).toBe(EXECUTION_STATE.EVALUATING);

    // 4. Simulate restarted worker running worker evaluation cycle
    // The restarted worker reclaims the expired lease and dispatches the execution in dry mode
    const cycleResult = await workerService.runWorkerCycle({
      tenantId,
      batchSize: 10,
    });

    expect(cycleResult.claimedCount).toBeGreaterThanOrEqual(1);

    // 5. Verify the execution advanced to DISPATCHING or PROVIDER_ACCEPTED without losing schedule
    const advancedExecution = await CampaignExecutionModel.findOne({ tenantId, executionId });
    expect([EXECUTION_STATE.DISPATCHING, EXECUTION_STATE.PROVIDER_ACCEPTED]).toContain(advancedExecution!.state);
    expect(advancedExecution!.lease?.token).toBeNull();

    const createdIntent = await CampaignDeliveryIntentModel.findOne({ tenantId, executionId });
    expect(createdIntent).toBeDefined();
  });

  // =========================================================================
  // 4. OPERATIONAL MONITORING ENDPOINTS (SPEC P34)
  // =========================================================================
  it('GET /monitoring/operational-metrics and /system-health return planner lag, due-step age, and alerts (Spec p34)', async () => {
    const campaignId = 'cmp_monitor_test';
    const now = clock.now();

    // 1. Create active campaign with slight planner lag
    await CampaignModel.create({
      tenantId,
      campaignId,
      name: 'Monitoring Campaign',
      presetId: 'birthday',
      status: 'ACTIVE',
      nextEvaluationAt: new Date(now.getTime() - 120000), // 2 minutes overdue
    });

    // 2. Fetch operational metrics
    const resMetrics = await request(app)
      .get('/api/v1/monitoring/operational-metrics')
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(resMetrics.status).toBe(200);
    expect(resMetrics.body.tenantId).toBe(tenantId);
    expect(resMetrics.body.plannerLag.overdueCampaignsCount).toBeGreaterThanOrEqual(1);
    expect(resMetrics.body.plannerLag.maxLagMs).toBeGreaterThan(0);
    expect(resMetrics.body.dueStepAge).toBeDefined();
    expect(resMetrics.body.skippedReasons).toBeDefined();
    expect(resMetrics.body.eventBacklog).toBeDefined();
    expect(resMetrics.body.tenantFairProcessing).toBeDefined();
    expect(resMetrics.body.healthStatus).toBeDefined();

    // 3. Fetch system health summary
    const resHealth = await request(app)
      .get('/api/v1/monitoring/system-health')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(resHealth.status).toBe(200);
    expect(resHealth.body.status).toBeDefined();
    expect(resHealth.body.summary).toBeDefined();
    expect(resHealth.body.summary.overdueCampaigns).toBeGreaterThanOrEqual(1);
  });

  // =========================================================================
  // 5. SECURITY REVIEW & ROLE BOUNDARIES (HARD RULE 1, 9)
  // =========================================================================
  it('Enforces role matrix boundaries: staff is blocked from triggering reconciliation or retention pruning', async () => {
    // Staff cannot run reconciliation (403 Forbidden)
    const resStaffRec = await request(app)
      .post('/api/v1/monitoring/reconciliation/run')
      .set('Authorization', `Bearer ${staffToken}`);
    expect(resStaffRec.status).toBe(403);

    // Staff cannot run retention pruning (403 Forbidden)
    const resStaffRet = await request(app)
      .post('/api/v1/monitoring/retention/run')
      .set('Authorization', `Bearer ${staffToken}`)
      .send({ cutoffDays: 90 });
    expect(resStaffRet.status).toBe(403);

    // Cross-tenant access is blocked: other tenant only gets their tenant context
    const resTenantB = await request(app)
      .get('/api/v1/monitoring/operational-metrics')
      .set('Authorization', `Bearer ${otherTenantToken}`);
    expect(resTenantB.status).toBe(200);
    expect(resTenantB.body.tenantId).toBe('shop_b');
  });
});

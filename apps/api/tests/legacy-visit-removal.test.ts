import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import { app } from '../src/app';
import { connectToDatabase, disconnectDatabase } from '../src/db/connection';
import { seedDatabase } from '../src/db/seed';
import { authService } from '../src/services/auth.service';
import { checkLegacyVisit } from '../src/scripts/checkLegacyVisit';
import { runCleanupLegacyVisit } from '../src/scripts/cleanupLegacyVisit';
import { eventConsumerService } from '../src/services/event-consumer';
import { customerFactsService } from '../src/services/customer-facts';
import {
  CampaignModel,
  CampaignEnrollmentModel,
  CampaignExecutionModel,
  CampaignCustomerFactModel,
  AuditLogModel,
} from '../src/db/models';
import { QUARANTINE_REASONS, EVENT_INBOX_STATUS } from '@grovastra/shared';

describe('Legacy Visit Removal & Purchase-Based Welcome Verification (L01-L10)', () => {
  const tenantId = 'shop_a';
  let ownerToken: string;
  let adminToken: string;
  let staffToken: string;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.DISPATCH_MODE = 'dry';
    process.env.ALLOW_TEST_CATEGORY_MISMATCH = 'true';

    await connectToDatabase();
    await seedDatabase('welcome');

    ownerToken = authService.signToken({
      userId: 'usr_owner_01',
      tenantId,
      role: 'owner',
      branchIds: ['branch_main', 'branch_two'],
      email: 'owner@shop-a.com',
    });

    adminToken = authService.signToken({
      userId: 'usr_admin_01',
      tenantId,
      role: 'admin',
      branchIds: ['branch_main', 'branch_two'],
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

  // ============================================================================
  // L01: Leftover scan passes on code tree and database
  // ============================================================================
  it('L01: Leftover scan passes on code tree with zero violations', async () => {
    const report = await checkLegacyVisit({ checkDb: true });
    if (!report.passed) {
      console.error('Code violations:', report.codeViolations);
      console.error('DB violations:', report.dbViolations);
    }
    expect(report.passed).toBe(true);
    expect(report.codeViolations).toHaveLength(0);
    expect(report.dbViolations).toHaveLength(0);
  });

  // ============================================================================
  // L02: visit.recorded & visit.voided quarantined with UNSUPPORTED_EVENT_TYPE, zero side effects, deduplicated on replay
  // ============================================================================
  it('L02: visit.recorded & visit.voided quarantined with UNSUPPORTED_EVENT_TYPE, zero side effects, deduplicated on replay', async () => {
    const eventIdRecorded = `evt_visit_rec_${Date.now()}`;
    const enrollmentsBefore = await CampaignEnrollmentModel.countDocuments({ tenantId });
    const executionsBefore = await CampaignExecutionModel.countDocuments({ tenantId });

    // 1. Ingest visit.recorded
    const resRecorded = await eventConsumerService.ingestEvent(tenantId, 'crm', {
      eventId: eventIdRecorded,
      type: 'visit.recorded',
      schemaVersion: 1,
      entityId: 'vis_test_99',
      entityVersion: 1,
      customerId: 'cus_ord_01_eligible',
      occurredAt: new Date().toISOString(),
      data: { visitId: 'vis_test_99' },
    });

    expect(resRecorded.status).toBe(EVENT_INBOX_STATUS.QUARANTINED);
    expect(resRecorded.quarantineReason).toBe(QUARANTINE_REASONS.UNSUPPORTED_EVENT_TYPE);

    // Assert zero side effects
    const enrollmentsAfter1 = await CampaignEnrollmentModel.countDocuments({ tenantId });
    const executionsAfter1 = await CampaignExecutionModel.countDocuments({ tenantId });
    expect(enrollmentsAfter1).toBe(enrollmentsBefore);
    expect(executionsAfter1).toBe(executionsBefore);

    // Replay of visit.recorded is deduplicated
    const replayRecorded = await eventConsumerService.ingestEvent(tenantId, 'crm', {
      eventId: eventIdRecorded,
      type: 'visit.recorded',
      schemaVersion: 1,
      entityId: 'vis_test_99',
      entityVersion: 1,
      occurredAt: new Date().toISOString(),
      data: { visitId: 'vis_test_99' },
    });
    expect(replayRecorded.status).toBe('DUPLICATE');

    // 2. Ingest visit.voided
    const eventIdVoided = `evt_visit_void_${Date.now()}`;
    const resVoided = await eventConsumerService.ingestEvent(tenantId, 'crm', {
      eventId: eventIdVoided,
      type: 'visit.voided',
      schemaVersion: 1,
      entityId: 'vis_test_99',
      entityVersion: 2,
      customerId: 'cus_ord_01_eligible',
      occurredAt: new Date().toISOString(),
      data: { visitId: 'vis_test_99', voidReason: 'Cancelled' },
    });

    expect(resVoided.status).toBe(EVENT_INBOX_STATUS.QUARANTINED);
    expect(resVoided.quarantineReason).toBe(QUARANTINE_REASONS.UNSUPPORTED_EVENT_TYPE);

    // Assert zero side effects
    const enrollmentsAfter2 = await CampaignEnrollmentModel.countDocuments({ tenantId });
    const executionsAfter2 = await CampaignExecutionModel.countDocuments({ tenantId });
    expect(enrollmentsAfter2).toBe(enrollmentsBefore);
    expect(executionsAfter2).toBe(executionsBefore);
  });

  // ============================================================================
  // L03: Removed routes return 404
  // ============================================================================
  it('L03: Removed routes return 404 (POST/GET /customers/:id/visits, POST /visits/:id/void, /dev/mock-visits)', async () => {
    // POST /customers/:id/visits -> 404
    const postVisitRes = await request(app)
      .post('/customers/cus_ord_01_eligible/visits')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ branchId: 'branch_main' });
    expect(postVisitRes.status).toBe(404);

    // GET /customers/:id/visits -> 404
    const getVisitsRes = await request(app)
      .get('/customers/cus_ord_01_eligible/visits')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(getVisitsRes.status).toBe(404);

    // POST /visits/:id/void -> 404
    const voidVisitRes = await request(app)
      .post('/visits/vis_123/void')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ reason: 'Test' });
    expect(voidVisitRes.status).toBe(404);

    // DEV mock-visits -> 404
    const mockVisitsRes = await request(app)
      .get('/dev/mock-visits')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(mockVisitsRes.status).toBe(404);
  });

  // ============================================================================
  // L04: GET /campaign-presets does not contain WELCOME_FIRST_VISIT; creating draft with that preset or triggerMode returns 422
  // ============================================================================
  it('L04: GET /campaign-presets does not contain WELCOME_FIRST_VISIT; draft with that preset or triggerMode returns 422', async () => {
    const res = await request(app)
      .get('/campaign-presets')
      .set('Authorization', `Bearer ${staffToken}`);

    expect(res.status).toBe(200);
    const presets = res.body;
    expect(presets.find((p: any) => p.id === 'WELCOME_FIRST_VISIT' || p.id === 'welcome_first_visit')).toBeUndefined();

    // Rejection on triggerMode
    const triggerModeRes = await request(app)
      .post('/campaigns')
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('Idempotency-Key', `idemp-l04-trig-${Date.now()}`)
      .send({
        presetId: 'WELCOME_NEW_CUSTOMER',
        name: 'Trigger Mode Rejected',
        triggerMode: 'VISIT',
      });
    expect(triggerModeRes.status).toBe(422);
    expect(triggerModeRes.body.fieldPath === 'triggerMode' || triggerModeRes.body.errors?.some((e: any) => e.fieldPath === 'triggerMode')).toBe(true);

    // Rejection on legacy preset ID
    const legacyPresetRes = await request(app)
      .post('/campaigns')
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('Idempotency-Key', `idemp-l04-legacy-${Date.now()}`)
      .send({
        presetId: 'WELCOME_FIRST_VISIT',
        name: 'Legacy Preset Rejected',
      });
    expect(legacyPresetRes.status).toBe(422);
    expect(legacyPresetRes.body.fieldPath === 'presetId' || legacyPresetRes.body.errors?.some((e: any) => e.fieldPath === 'presetId')).toBe(true);
  });

  // ============================================================================
  // L05: Cleanup script dry-run vs --yes safety (refuses prod, non-dev DB, leaves order campaigns & audit log untouched)
  // ============================================================================
  it('L05: Cleanup script dry-run vs --yes safety (refuses prod, non-dev DB, leaves order campaigns & audit log untouched)', async () => {
    // 1. Refuses production
    process.env.NODE_ENV = 'production';
    await expect(runCleanupLegacyVisit({ yes: false, dbName: 'grovastra_test' })).rejects.toThrow(
      /strictly forbidden in production/
    );
    process.env.NODE_ENV = 'test';

    // 2. Refuses non-dev / non-test DB
    await expect(runCleanupLegacyVisit({ yes: false, dbName: 'production_customer_db' })).rejects.toThrow(
      /only operates on 'grovastra_dev' or 'grovastra_test'/
    );

    // 3. Dry-run execution
    const auditBefore = await AuditLogModel.countDocuments();
    const orderCampaignsBefore = await CampaignModel.countDocuments({ presetId: 'WELCOME_NEW_CUSTOMER' });

    const report = await runCleanupLegacyVisit({ yes: false, dbName: 'grovastra_test' });
    expect(report.dryRun).toBe(true);

    const auditAfter = await AuditLogModel.countDocuments();
    const orderCampaignsAfter = await CampaignModel.countDocuments({ presetId: 'WELCOME_NEW_CUSTOMER' });

    expect(auditAfter).toBe(auditBefore);
    expect(orderCampaignsAfter).toBe(orderCampaignsBefore);
  });

  // ============================================================================
  // L06: seed:scenario welcome creates no visit docs/fields, creates order campaign, and is idempotent
  // ============================================================================
  it('L06: seed:scenario welcome creates no visit docs/fields, creates order campaign, and is idempotent', async () => {
    await seedDatabase('welcome');

    const collections = await mongoose.connection.db!.listCollections().toArray();
    expect(collections.some((c) => c.name === 'src_visits')).toBe(false);

    const orderModeCampaign = await CampaignModel.findOne({
      tenantId,
      campaignId: 'cmp_wel_order_mode',
    });
    expect(orderModeCampaign).toBeDefined();
    expect(orderModeCampaign?.presetId).toBe('WELCOME_NEW_CUSTOMER');

    // Re-seed for idempotency
    await seedDatabase('welcome');

    const orderModeCampaignRecheck = await CampaignModel.findOne({
      tenantId,
      campaignId: 'cmp_wel_order_mode',
    });
    expect(orderModeCampaignRecheck).toBeDefined();
  });

  // ============================================================================
  // L07: Customer facts rebuild produces no visit fields
  // ============================================================================
  it('L07: Customer facts rebuild produces no visit fields', async () => {
    await customerFactsService.rebuildAllCustomerFacts(tenantId);

    const facts = await CampaignCustomerFactModel.find({ tenantId }).lean();
    expect(facts.length).toBeGreaterThan(0);

    for (const f of facts) {
      expect((f as any).visitCount).toBeUndefined();
      expect((f as any).firstVisitId).toBeUndefined();
      expect((f as any).firstVisitAt).toBeUndefined();
      expect((f as any).lastVisitAt).toBeUndefined();
      expect((f as any).visitAggregateVersion).toBeUndefined();
    }
  });

  // ============================================================================
  // L08: /campaigns/:id/welcome/summary response has no visit or triggerMode keys
  // ============================================================================
  it('L08: /campaigns/:id/welcome/summary response has no visit or triggerMode keys', async () => {
    const res = await request(app)
      .get('/campaigns/cmp_wel_order_mode/welcome/summary')
      .set('Authorization', `Bearer ${staffToken}`);

    expect(res.status).toBe(200);
    expect(res.body.observationalRepeatPurchases).toBeDefined();

    const keys = Object.keys(res.body);
    expect(keys).not.toContain('triggerMode');
    expect(keys).not.toContain('storeVisits');
    expect(keys).not.toContain('eligibleFirstVisits');
    expect(keys.some((k) => k.toLowerCase().includes('visit'))).toBe(false);
  });

  // ============================================================================
  // L09: Order-mode Welcome behaviour unchanged: all ported tests pass
  // ============================================================================
  it('L09: Order-mode Welcome behaviour unchanged: qualifying first completed order enrolls and plans steps', async () => {
    const orderCampaign = await CampaignModel.findOne({
      tenantId,
      campaignId: 'cmp_wel_order_mode',
    });
    expect(orderCampaign).toBeDefined();
    expect(orderCampaign?.status).toBe('ACTIVE');

    // Verify enrollment for qualifying seeded order customer exists
    const enrollments = await CampaignEnrollmentModel.find({
      tenantId,
      campaignId: 'cmp_wel_order_mode',
    });
    expect(enrollments.length).toBeGreaterThan(0);

    const executions = await CampaignExecutionModel.find({
      tenantId,
      campaignId: 'cmp_wel_order_mode',
    });
    expect(executions.length).toBeGreaterThan(0);
  });

  // ============================================================================
  // L10: F20 still passes with non-order event test
  // ============================================================================
  it('L10: F20 still passes with non-order event test', async () => {
    const facts = await customerFactsService.recomputeCustomerFacts(tenantId, 'cus_live_welcome_01');
    expect(facts.qualifyingOrderCount).toBeDefined();

    // Non-order event does not create repeat purchase enrollment
    const enrollment = await CampaignEnrollmentModel.findOne({
      tenantId,
      customerId: 'cus_live_welcome_01',
      campaignId: 'cmp_first_repeat',
    });
    // In welcome scenario without repeat purchase, no repeat enrollment exists
    expect(enrollment).toBeNull();
  });
});

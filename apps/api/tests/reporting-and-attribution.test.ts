import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app';
import { connectToDatabase, disconnectDatabase } from '../src/db/connection';
import { seedDatabase } from '../src/db/seed';
import {
  CampaignModel,
  CampaignVersionModel,
  CampaignEnrollmentModel,
  CampaignExecutionModel,
  CampaignDeliveryIntentModel,
  CampaignGoalEventModel,
  SrcOrderModel,
  SrcCustomerModel,
} from '../src/db/models';
import { authService } from '../src/services/auth.service';
import { clock } from '../src/services/clock';
import {
  EXECUTION_STATE,
  ENROLLMENT_STATUS,
} from '@grovastra/shared';

describe('GroVastra Campaign Reporting, Single-Attribution & Customer Timeline (Spec p22, p28, QA Matrix C17, C18)', () => {
  const app = createApp();

  const tenantId = 'shop_a';
  let ownerToken: string;
  let adminToken: string;
  let staffToken: string;
  let otherTenantToken: string;

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
    const testCampaignIds = [
      'cmp_birthday_c17',
      'cmp_birthday_c18',
      'cmp_festival_c18',
      'cmp_counts_test',
      'cmp_timeline_test',
      'cmp_csv_test',
      'cmp_isolation_test',
    ];
    await Promise.all([
      CampaignModel.deleteMany({ campaignId: { $in: testCampaignIds } }),
      CampaignEnrollmentModel.deleteMany({ campaignId: { $in: testCampaignIds } }),
      CampaignExecutionModel.deleteMany({ campaignId: { $in: testCampaignIds } }),
      CampaignGoalEventModel.deleteMany({ campaignId: { $in: testCampaignIds } }),
      SrcOrderModel.deleteMany({ orderId: { $in: ['ord_multi_c18', 'ord_extra_c18'] } }),
    ]);
  });

  // =========================================================================
  // C17: DELIVERED MESSAGE WITHOUT ORDER EVIDENCE (NO SALE/REVENUE FABRICATED)
  // =========================================================================
  it('C17: Delivered message without order evidence shows zero sales and no fabricated revenue (Spec p28, C17)', async () => {
    const campaignId = 'cmp_birthday_c17';
    const customerId = 'cus_001';
    const occurrenceId = 'birthday:2027';

    // 1. Create active campaign
    await CampaignModel.create({
      tenantId,
      campaignId,
      name: 'Birthday Campaign C17',
      presetId: 'birthday',
      status: 'ACTIVE',
      activatedAt: new Date('2026-10-01T00:00:00Z'),
    });

    // 2. Create enrollment
    const enrollmentId = 'enr_c17_01';
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
      matchExplanation: 'Selected because birthday is in 14 days',
      status: ENROLLMENT_STATUS.ACTIVE,
    });

    // 3. Create execution that was DELIVERED to recipient
    const executionId = 'exe_c17_01';
    await CampaignExecutionModel.create({
      tenantId,
      campaignId,
      enrollmentId,
      executionId,
      executionKey: `${enrollmentId}:step_invitation`,
      stepId: 'invitation',
      stepName: 'Invitation',
      dueAt: new Date('2026-12-22T04:30:00Z'),
      originalDueAt: new Date('2026-12-22T04:30:00Z'),
      expiresAt: new Date('2026-12-22T06:30:00Z'),
      localDate: '2026-12-22',
      localTime: '10:00',
      timezone: 'Asia/Kolkata',
      planRevision: 1,
      state: EXECUTION_STATE.DELIVERED,
      providerMessageId: 'wamid.HBgLMjA5NTkyNzM0',
      providerStatus: 'delivered',
      sentAt: new Date('2026-12-22T04:30:05Z'),
      deliveredAt: new Date('2026-12-22T04:31:00Z'),
      statusHistory: [
        { status: 'SCHEDULED', timestamp: new Date('2026-12-22T04:30:00Z') },
        { status: 'PROVIDER_ACCEPTED', timestamp: new Date('2026-12-22T04:30:05Z') },
        { status: 'DELIVERED', timestamp: new Date('2026-12-22T04:31:00Z') },
      ],
    });

    // Ensure customer has NO orders linking to this campaign
    await SrcOrderModel.deleteMany({ tenantId, customerId, occasionRef: occurrenceId });
    await CampaignGoalEventModel.deleteMany({ tenantId, campaignId });

    // 4. Fetch Campaign Report via API
    const res = await request(app)
      .get(`/api/v1/campaigns/${campaignId}/report`)
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(res.status).toBe(200);
    const report = res.body;

    // Delivery Evidence
    expect(report.deliveryEvidence.delivered).toBe(1);
    expect(report.deliveryEvidence.accepted).toBe(1);
    expect(report.deliveryEvidence.notice).toContain('Accepted is not delivered; delivered is not a sale');

    // Strict Spec p28 Guarantee: Delivered message alone MUST NEVER fabricate a sale
    expect(report.attribution.orderCount).toBe(0);
    expect(report.attribution.totalNetSalesPaise).toBe(0);
    expect(report.attribution.totalNetSalesRupees).toBe(0);
    expect(report.attribution.orders).toHaveLength(0);
  });

  // =========================================================================
  // C18: ORDER REFUND & MULTIPLE CAMPAIGN LINKS (SINGLE ATTRIBUTION & NET SALES)
  // =========================================================================
  it('C18: Multi-campaign order is counted strictly ONCE under declared precedence, and refunds reduce net sales (Spec p28, C18)', async () => {
    const campaignAId = 'cmp_birthday_c18';
    const campaignBId = 'cmp_festival_c18';
    const customerId = 'cus_002';
    const occurrenceId = 'birthday:2027';

    // 1. Create two distinct campaigns
    await CampaignModel.create([
      {
        tenantId,
        campaignId: campaignAId,
        name: 'Birthday Campaign A',
        presetId: 'birthday', // Priority 80
        status: 'ACTIVE',
        activatedAt: new Date('2026-10-01T00:00:00Z'),
      },
      {
        tenantId,
        campaignId: campaignBId,
        name: 'Festival Campaign B',
        presetId: 'winback', // Priority 40
        status: 'ACTIVE',
        activatedAt: new Date('2026-10-02T00:00:00Z'),
      },
    ]);

    // 2. Customer enrolled in both campaigns
    const enrAId = 'enr_c18_a';
    const enrBId = 'enr_c18_b';
    await CampaignEnrollmentModel.create([
      {
        tenantId,
        campaignId: campaignAId,
        campaignVersionId: `${campaignAId}_v1`,
        campaignVersion: 1,
        sourceRef: { type: 'birthday', id: customerId, version: 1 },
        enrollmentId: enrAId,
        enrollmentKey: `${tenantId}:${campaignAId}:${customerId}:${occurrenceId}`,
        customerId,
        occurrenceId,
        occasionLocalDate: '2027-01-05',
        status: ENROLLMENT_STATUS.ACTIVE,
      },
      {
        tenantId,
        campaignId: campaignBId,
        campaignVersionId: `${campaignBId}_v1`,
        campaignVersion: 1,
        sourceRef: { type: 'winback', id: customerId, version: 1 },
        enrollmentId: enrBId,
        enrollmentKey: `${tenantId}:${campaignBId}:${customerId}:winback:ord_old:rule1`,
        customerId,
        occurrenceId: 'winback:ord_old:rule1',
        occasionLocalDate: '2026-10-21',
        status: ENROLLMENT_STATUS.ACTIVE,
      },
    ]);

    // 3. Create store order with netPaise 500,000 (₹5,000)
    const orderId = 'ord_multi_c18';
    await SrcOrderModel.create({
      tenantId,
      orderId,
      customerId,
      status: 'COMPLETED',
      paid: true,
      netPaise: 500000, // ₹5,000
      occasionRef: occurrenceId, // matches Campaign A occurrence
      completedAt: new Date('2027-01-04T12:00:00Z'),
    });

    // Explicit goal event links order to Campaign A
    await CampaignGoalEventModel.create({
      goalEventId: 'cge_c18_01',
      tenantId,
      enrollmentId: enrAId,
      campaignId: campaignAId,
      customerId,
      occurrence: occurrenceId,
      orderRef: orderId,
      source: 'ORDER_OCCASION',
      recordedBy: 'system',
      at: new Date('2027-01-04T12:00:00Z'),
    });

    // 4. Verify Single Attribution: Order attributed to Campaign A ONLY, NOT Campaign B
    const resA = await request(app)
      .get(`/api/v1/campaigns/${campaignAId}/report`)
      .set('Authorization', `Bearer ${ownerToken}`);

    const resB = await request(app)
      .get(`/api/v1/campaigns/${campaignBId}/report`)
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);

    // Campaign A must receive the order
    expect(resA.body.attribution.orderCount).toBe(1);
    expect(resA.body.attribution.totalNetSalesPaise).toBe(500000);
    expect(resA.body.attribution.totalNetSalesRupees).toBe(5000);
    expect(resA.body.attribution.orders[0].orderId).toBe(orderId);
    expect(resA.body.attribution.orders[0].attributionSource).toBe('GOAL_EVENT');

    // Campaign B must NOT count this order (zero double-counting)
    const orderInB = resB.body.attribution.orders.find((o: any) => o.orderId === orderId);
    expect(orderInB).toBeUndefined();

    // 5. Part B: Refund reduces net sales
    // Customer returns items; netPaise is reduced from 500,000 to 320,000 (₹3,200)
    await SrcOrderModel.updateOne(
      { tenantId, orderId },
      { $set: { netPaise: 320000 } }
    );

    const resARefunded = await request(app)
      .get(`/api/v1/campaigns/${campaignAId}/report`)
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(resARefunded.status).toBe(200);
    // Net sales is reduced by the refund!
    expect(resARefunded.body.attribution.totalNetSalesPaise).toBe(320000);
    expect(resARefunded.body.attribution.totalNetSalesRupees).toBe(3200);

    // If order is completely CANCELLED, net contribution drops to zero
    await SrcOrderModel.updateOne(
      { tenantId, orderId },
      { $set: { status: 'CANCELLED', netPaise: 0 } }
    );

    const resACancelled = await request(app)
      .get(`/api/v1/campaigns/${campaignAId}/report`)
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(resACancelled.status).toBe(200);
    expect(resACancelled.body.attribution.totalNetSalesPaise).toBe(0);
    expect(resACancelled.body.attribution.refundsCount).toBeGreaterThanOrEqual(1);
  });

  // =========================================================================
  // COUNTS MATCH DB RECORDS & REASON BREAKDOWN VISIBILITY
  // =========================================================================
  it('Report metrics equal underlying DB records exactly, with primary reason breakdown visible to owners (Spec p28, p29)', async () => {
    const campaignId = 'cmp_counts_test';
    const occurrenceId = 'birthday:2027';

    await CampaignModel.create({
      tenantId,
      campaignId,
      name: 'Counts Test Campaign',
      presetId: 'birthday',
      status: 'ACTIVE',
    });

    // Seed 4 enrollments with distinct execution states
    const customers = ['cus_010', 'cus_011', 'cus_012', 'cus_013'];

    for (let i = 0; i < customers.length; i++) {
      const cid = customers[i];
      const eid = `enr_counts_${i}`;

      await CampaignEnrollmentModel.create({
        tenantId,
        campaignId,
        campaignVersionId: `${campaignId}_v1`,
        campaignVersion: 1,
        sourceRef: { type: 'birthday', id: cid, version: 1 },
        enrollmentId: eid,
        enrollmentKey: `${tenantId}:${campaignId}:${cid}:${occurrenceId}`,
        customerId: cid,
        occurrenceId,
        occasionLocalDate: '2027-01-05',
        status: i === 2 ? ENROLLMENT_STATUS.COMPLETED : ENROLLMENT_STATUS.ACTIVE,
        replyHoldAt: i === 1 ? new Date('2026-12-23T10:00:00Z') : null,
        replyAttribution: i === 1 ? 'CAMPAIGN' : null,
      });

      // Scheduled step
      const schedDue = new Date(Date.now() + 86400000 * (i + 1));
      await CampaignExecutionModel.create({
        tenantId,
        campaignId,
        enrollmentId: eid,
        executionId: `exe_counts_sched_${i}`,
        executionKey: `${eid}:step_sched`,
        stepId: 'step_sched',
        stepName: 'Scheduled Step',
        dueAt: schedDue,
        originalDueAt: schedDue,
        expiresAt: new Date(schedDue.getTime() + 7200000),
        localDate: '2026-12-25',
        localTime: '10:00',
        timezone: 'Asia/Kolkata',
        planRevision: 1,
        state: EXECUTION_STATE.SCHEDULED,
      });

      // Skipped step with specific business reason
      const skipDue = new Date('2026-12-20T10:00:00Z');
      await CampaignExecutionModel.create({
        tenantId,
        campaignId,
        enrollmentId: eid,
        executionId: `exe_counts_skip_${i}`,
        executionKey: `${eid}:step_skip`,
        stepId: 'step_skip',
        stepName: 'Skipped Step',
        dueAt: skipDue,
        originalDueAt: skipDue,
        expiresAt: new Date(skipDue.getTime() + 7200000),
        localDate: '2026-12-20',
        localTime: '10:00',
        timezone: 'Asia/Kolkata',
        planRevision: 1,
        state: EXECUTION_STATE.SKIPPED,
        skipReason: i % 2 === 0 ? 'Elapsed step prior to evaluation instant' : 'Reply hold active at execution time',
      });
    }

    // Query DB counts directly
    const [dbEnrollments, dbScheduled, dbSkipped] = await Promise.all([
      CampaignEnrollmentModel.countDocuments({ tenantId, campaignId }),
      CampaignExecutionModel.countDocuments({ tenantId, campaignId, state: EXECUTION_STATE.SCHEDULED }),
      CampaignExecutionModel.countDocuments({ tenantId, campaignId, state: EXECUTION_STATE.SKIPPED }),
    ]);

    // Fetch report via API
    const res = await request(app)
      .get(`/api/v1/campaigns/${campaignId}/report`)
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(res.status).toBe(200);
    const report = res.body;

    // Report counts MUST equal DB records
    expect(report.enrollments.total).toBe(dbEnrollments);
    expect(report.enrollments.uniqueCustomers).toBe(4);
    expect(report.executionCounts.scheduled).toBe(dbScheduled);
    expect(report.executionCounts.skipped).toBe(dbSkipped);

    // Primary Reason Breakdown visible to boutique owners (Spec p29)
    expect(report.executionCounts.primaryReasons).toHaveLength(2);
    const elapsedReason = report.executionCounts.primaryReasons.find(
      (r: any) => r.reason === 'Elapsed step prior to evaluation instant'
    );
    const holdReason = report.executionCounts.primaryReasons.find(
      (r: any) => r.reason === 'Reply hold active at execution time'
    );

    expect(elapsedReason).toBeDefined();
    expect(elapsedReason.count).toBe(2);
    expect(holdReason).toBeDefined();
    expect(holdReason.count).toBe(2);

    // Replies & Holds: 1 exact reply attribution
    expect(report.repliesAndHolds.exactCampaignReplies).toBe(1);
    expect(report.repliesAndHolds.currentlyOnHold).toBe(1);
  });

  // =========================================================================
  // CUSTOMER TIMELINE ENDPOINT (SPEC P28)
  // =========================================================================
  it('GET /campaigns/:id/customer-timeline/:customerId returns explainable timeline with why selected, occurrence, planned vs actual, template revision, and masked phones', async () => {
    const campaignId = 'cmp_timeline_test';
    const customerId = 'cus_bday_jan05';
    const occurrenceId = 'birthday:2027';

    await CampaignModel.create({
      tenantId,
      campaignId,
      name: 'Timeline Test Campaign',
      presetId: 'birthday',
      status: 'ACTIVE',
    });

    const enrollmentId = 'enr_timeline_01';
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
      matchExplanation: 'Selected because birthday is in 14 days',
      status: ENROLLMENT_STATUS.ACTIVE,
    });

    await CampaignExecutionModel.create({
      tenantId,
      campaignId,
      enrollmentId,
      executionId: 'exe_timeline_01',
      executionKey: `${enrollmentId}:step_invite`,
      stepId: 'step_invite',
      stepName: 'Birthday Invitation',
      dueAt: new Date('2026-12-22T04:30:00Z'),
      originalDueAt: new Date('2026-12-22T04:30:00Z'),
      expiresAt: new Date('2026-12-22T06:30:00Z'),
      localDate: '2026-12-22',
      localTime: '10:00',
      timezone: 'Asia/Kolkata',
      planRevision: 1,
      state: EXECUTION_STATE.READ,
      providerMessageId: 'wamid.HBgLMjA5NTkyNzM0',
      sentAt: new Date('2026-12-22T04:30:05Z'),
      deliveredAt: new Date('2026-12-22T04:31:00Z'),
      readAt: new Date('2026-12-22T05:00:00Z'),
      templateRef: {
        id: 'tpl_birthday_invite',
        revision: 3,
        language: 'en',
      },
      statusHistory: [
        { status: 'SCHEDULED', timestamp: new Date('2026-12-22T04:30:00Z') },
        { status: 'PROVIDER_ACCEPTED', timestamp: new Date('2026-12-22T04:30:05Z') },
        { status: 'DELIVERED', timestamp: new Date('2026-12-22T04:31:00Z') },
        { status: 'READ', timestamp: new Date('2026-12-22T05:00:00Z') },
      ],
    });

    const res = await request(app)
      .get(`/api/v1/campaigns/${campaignId}/customer-timeline/${customerId}`)
      .set('Authorization', `Bearer ${staffToken}`); // staff permitted (Spec p26)

    expect(res.status).toBe(200);
    const timeline = res.body;

    // Verification of explainable customer timeline requirements (Spec p28)
    expect(timeline.customerId).toBe(customerId);
    expect(timeline.maskedPhone).toMatch(/\+91 \d{2}\*{3} \*{2}\d{3}/); // Strictly Masked Phone (Hard Rule 9)
    expect(timeline.enrollment.matchExplanation).toBe('Selected because birthday is in 14 days');
    expect(timeline.enrollment.occurrenceId).toBe(occurrenceId);

    // Planned vs Actual
    expect(timeline.steps).toHaveLength(1);
    const step = timeline.steps[0];
    expect(step.stepId).toBe('step_invite');
    expect(step.plannedLocalDate).toBe('2026-12-22');
    expect(step.plannedLocalTime).toBe('10:00');
    expect(step.actualDispatchedAt).toBeDefined();
    expect(step.actualDeliveredAt).toBeDefined();
    expect(step.actualReadAt).toBeDefined();

    // Template Revision
    expect(step.template.id).toBe('tpl_birthday_invite');
    expect(step.template.revision).toBe(3);
    expect(step.template.language).toBe('en');

    // Chronological Status Events
    expect(step.statusHistory).toHaveLength(4);
    expect(step.statusHistory[0].state).toBe('SCHEDULED');
    expect(step.statusHistory[3].state).toBe('READ');

    // Also verify via GET /enrollments/:id/timeline
    const resEnr = await request(app)
      .get(`/api/v1/enrollments/${enrollmentId}/timeline`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(resEnr.status).toBe(200);
    expect(resEnr.body.customerId).toBe(customerId);
  });

  // =========================================================================
  // CSV EXPORT (MASKED PHONES & ZERO MESSAGE BODIES)
  // =========================================================================
  it('GET /campaigns/:id/export/csv exports CSV with strictly masked phones and zero message bodies (Spec p28, Hard Rule 9)', async () => {
    const campaignId = 'cmp_csv_test';
    const customerId = 'cus_bday_jan05';
    const occurrenceId = 'birthday:2027';

    await CampaignModel.create({
      tenantId,
      campaignId,
      name: 'CSV Test Campaign',
      presetId: 'birthday',
      status: 'ACTIVE',
    });

    const enrollmentId = 'enr_csv_01';
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
      matchExplanation: 'Selected because birthday is in 14 days',
      status: ENROLLMENT_STATUS.ACTIVE,
    });

    await CampaignExecutionModel.create({
      tenantId,
      campaignId,
      enrollmentId,
      executionId: 'exe_csv_01',
      executionKey: `${enrollmentId}:step_invite`,
      stepId: 'step_invite',
      dueAt: new Date('2026-12-22T04:30:00Z'),
      originalDueAt: new Date('2026-12-22T04:30:00Z'),
      expiresAt: new Date('2026-12-22T06:30:00Z'),
      localDate: '2026-12-22',
      localTime: '10:00',
      timezone: 'Asia/Kolkata',
      planRevision: 1,
      state: EXECUTION_STATE.SCHEDULED,
    });

    const res = await request(app)
      .get(`/api/v1/campaigns/${campaignId}/export/csv`)
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(res.status).toBe(200);
    expect(res.header['content-type']).toContain('text/csv');
    expect(res.header['content-disposition']).toContain(`attachment; filename="campaign_${campaignId}_report_`);

    const csvContent = res.text;

    // Headers verification
    expect(csvContent).toContain('Enrollment ID,Customer ID,Masked Phone,Occurrence');
    expect(csvContent).toContain('Why Selected');

    // Phone MUST be masked (+91 98*** **321)
    expect(csvContent).toMatch(/\+91 \d{2}\*{3} \*{2}\d{3}/);

    // Hard Rule 9 & Spec p28 Guarantee: Zero raw unmasked phone numbers in export
    expect(csvContent).not.toContain('919876543210');
    expect(csvContent).not.toContain('9876543210');

    // Zero WhatsApp message bodies in export (Spec p28: "ordinary logs and exports do not need full message bodies")
    expect(csvContent).not.toContain('Wishing you a joyous celebration');
  });

  // =========================================================================
  // TENANT ISOLATION (HARD RULE 1)
  // =========================================================================
  it('Reporting and exports strictly enforce tenant isolation and block cross-tenant access (Hard Rule 1)', async () => {
    const campaignId = 'cmp_isolation_test';

    await CampaignModel.create({
      tenantId: 'shop_a',
      campaignId,
      name: 'Shop A Campaign',
      presetId: 'birthday',
      status: 'ACTIVE',
    });

    // Tenant B attempts to fetch Shop A report
    const res = await request(app)
      .get(`/api/v1/campaigns/${campaignId}/report`)
      .set('Authorization', `Bearer ${otherTenantToken}`);

    expect(res.status).toBe(404);
  });
});

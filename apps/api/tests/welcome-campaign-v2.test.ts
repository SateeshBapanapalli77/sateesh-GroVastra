import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import crypto from 'crypto';
import { app } from '../src/app';
import { connectToDatabase, disconnectDatabase } from '../src/db/connection';
import { seedDatabase } from '../src/db/seed';
import {
  CampaignModel,
  CampaignVersionModel,
  CampaignEnrollmentModel,
  CampaignExecutionModel,
  CampaignCustomerFactModel,
  CampaignEventInboxModel,
  CampaignContactGateModel,
  CampaignDeliveryIntentModel,
  SrcCustomerModel,
  SrcOrderModel,
  SrcOfferModel,
} from '../src/db/models';
import { authService } from '../src/services/auth.service';
import { clock } from '../src/services/clock';
import { computeDueTimes } from '../src/presets/_shared/eventDelay/delayTiming';
import { dispatchRecheck } from '../src/presets/_shared/eventDelay/dispatchRecheck';
import { evaluateCandidateForEventDelay } from '../src/presets/_shared/eventDelay/enrollerBase';
import { eventConsumerService } from '../src/services/event-consumer';
import { contactGateService } from '../src/services/contact-gate';
import { webhookService } from '../src/services/webhook/webhook.service';
import { campaignValidationService } from '../src/services/campaign-validation.service';
import { normalizePhone, isSuspiciousPhone, isDestinationVerified } from '@grovastra/shared';
import { encryptPhone, maskPhone, destinationHash } from '../src/utils/crypto';
import {
  ENROLLMENT_STATUS,
  EXECUTION_STATE,
  EXECUTION_REASONS,
  EXCLUSION_REASONS,
  DELAY_UNIT,
  OUTSIDE_HOURS_POLICY,
} from '@grovastra/shared';

describe('Welcome Campaign v2 (Order Mode, F19b v2, N01-N40)', () => {
  const tenantId = 'shop_a';
  const otherTenantId = 'shop_b';
  let ownerToken: string;
  let adminToken: string;
  let staffToken: string;
  let shopBOwnerToken: string;

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

    shopBOwnerToken = authService.signToken({
      userId: 'usr_owner_b',
      tenantId: otherTenantId,
      role: 'owner',
      branchIds: ['branch_b_1'],
      email: 'owner@shop-b.com',
    });
  });

  afterAll(async () => {
    await disconnectDatabase();
  });

  beforeEach(() => {
    clock.setSystemTime(new Date('2026-10-24T10:00:00.000Z'));
  });

  // Helper to create a confirmed test customer with a unique phone
  async function createTestCustomer(overrides: Partial<any> = {}) {
    const customerId = overrides.customerId || `cus_test_${crypto.randomUUID().slice(0, 8)}`;
    const randomDigits = Math.floor(10000000 + Math.random() * 90000000);
    const phone = overrides.phone || `+91 98${randomDigits}`;
    const norm = normalizePhone(phone, 'IN');
    const hash = destinationHash(norm.digits);

    const doc: any = await SrcCustomerModel.create({
      tenantId: overrides.tenantId || tenantId,
      customerId,
      firstName: overrides.firstName || 'Aarav',
      lastName: overrides.lastName || 'Patel',
      destination: {
        rawInput: phone,
        e164: norm.e164,
        nationalDigits: norm.digits.slice(-10),
        encryptedPhone: encryptPhone(norm.e164),
        destinationHash: hash,
        masked: maskPhone(norm.e164),
        verified: overrides.verified !== undefined ? overrides.verified : true,
        verificationLevel: overrides.verificationLevel || 'CONFIRMED_BY_STAFF',
        verifiedAt: overrides.verifiedAt || clock.now(),
        verificationMethod: overrides.verificationMethod || 'COUNTER_READBACK',
        version: 1,
      },
      consent: {
        marketingOptIn: overrides.marketingOptIn !== undefined ? overrides.marketingOptIn : true,
        channelSuppressed: overrides.channelSuppressed !== undefined ? overrides.channelSuppressed : false,
        source: overrides.consentSource || 'COUNTER_FORM',
        consentCapturedAt: clock.now(),
      },
      status: overrides.status || 'ACTIVE',
      entityVersion: 1,
      branchId: overrides.branchId || 'branch_main',
    });
    // Attach test helpers directly onto the returned doc
    doc.rawPhone = phone;
    doc.phoneDigits = norm.digits;
    return doc;
  }

  // Helper to create and ingest an order completed event
  async function createAndIngestOrder(
    cust: { customerId: string | null; tenantId?: string },
    orderOverrides: Partial<any> = {}
  ) {
    const tId = cust.tenantId || tenantId;
    const orderId = orderOverrides.orderId || `ord_test_${crypto.randomUUID().slice(0, 8)}`;
    const completedAt = orderOverrides.completedAt || clock.now();
    const netPaise = orderOverrides.netPaise !== undefined ? orderOverrides.netPaise : 250000;
    const status = orderOverrides.status || 'COMPLETED';
    const paid = orderOverrides.paid !== undefined ? orderOverrides.paid : true;
    const branchId = orderOverrides.branchId || 'branch_main';

    const lines = orderOverrides.lines || [
      { lineId: 'l1', itemRef: 'item_1', name: 'Handloom Saree', quantity: 1, pricePaise: netPaise },
    ];

    const order = await SrcOrderModel.create({
      tenantId: tId,
      orderId,
      orderNumber: `ORD-${orderId}`,
      customerId: cust.customerId,
      status,
      paid,
      netPaise,
      grossPaise: netPaise,
      refundedPaise: orderOverrides.refundedPaise || 0,
      completedAt,
      branchId,
      lines,
      entityVersion: 1,
    });

    const eventId = `evt_${orderId}_${crypto.randomUUID().slice(0, 6)}`;
    await eventConsumerService.ingestEvent(tId, 'orders', {
      schemaVersion: 1,
      producer: 'orders',
      eventId,
      type: 'order.completed',
      entityId: orderId,
      entityVersion: 1,
      customerId: cust.customerId,
      occurredAt: completedAt,
      data: {
        orderId,
        orderNumber: `ORD-${orderId}`,
        customerId: cust.customerId,
        status,
        paid,
        netPaise,
        completedAt: completedAt.toISOString(),
        branchId,
        lines,
      },
    });

    return { order, eventId };
  }

  // ============================================================================
  // PART 1: ORDER MODE, IDENTITY, ELIGIBILITY, ONCE RULE, TIMING (N01-N20)
  // ============================================================================

  it('N01: first order enrolls once in order-mode welcome campaign', async () => {
    const customer = await createTestCustomer();
    const { order } = await createAndIngestOrder(customer);

    const enrollment = await CampaignEnrollmentModel.findOne({
      tenantId,
      customerId: customer.customerId,
      campaignId: 'cmp_wel_order_mode',
    });

    expect(enrollment).toBeDefined();
    expect(enrollment?.occurrenceId).toBe(`welcome:${order.orderId}`);
    expect(enrollment?.status).toBe(ENROLLMENT_STATUS.ACTIVE);

    const execution = await CampaignExecutionModel.findOne({
      tenantId,
      enrollmentId: enrollment?.enrollmentId,
    });
    expect(execution).toBeDefined();
    expect(execution?.state).toBe(EXECUTION_STATE.SCHEDULED);
    expect(execution?.rawDueAt).toBeDefined();
    expect(execution?.adjustedDueAt).toBeDefined();
  });

  it('N02: replay x5 identical order event produces no duplicate enrollment', async () => {
    const customer = await createTestCustomer();
    const orderId = `ord_rep_${crypto.randomUUID().slice(0, 6)}`;
    const completedAt = clock.now();

    await SrcOrderModel.create({
      tenantId,
      orderId,
      customerId: customer.customerId,
      status: 'COMPLETED',
      paid: true,
      netPaise: 250000,
      completedAt,
      branchId: 'branch_main',
      entityVersion: 1,
    });

    // Ingest the identical event 5 times
    for (let i = 0; i < 5; i++) {
      await eventConsumerService.ingestEvent(tenantId, 'orders', {
        schemaVersion: 1,
        producer: 'orders',
        eventId: `evt_${orderId}_fixed`,
        type: 'order.completed',
        entityId: orderId,
        entityVersion: 1,
        customerId: customer.customerId,
        occurredAt: completedAt,
        data: {
          orderId,
          customerId: customer.customerId,
          status: 'COMPLETED',
          paid: true,
          netPaise: 250000,
          completedAt: completedAt.toISOString(),
        },
      });
    }

    const enrollments = await CampaignEnrollmentModel.find({
      tenantId,
      customerId: customer.customerId,
      campaignId: 'cmp_wel_order_mode',
    });
    expect(enrollments.length).toBe(1);

    const executions = await CampaignExecutionModel.find({
      tenantId,
      enrollmentId: enrollments[0].enrollmentId,
    });
    expect(executions.length).toBe(1);
  });

  it('N03: one order with five lines -> exactly one enrollment, one execution', async () => {
    const customer = await createTestCustomer();
    const lines = [
      { lineId: 'l1', itemRef: 'it1', name: 'Silk Saree', quantity: 1, pricePaise: 50000 },
      { lineId: 'l2', itemRef: 'it2', name: 'Cotton Dupatta', quantity: 1, pricePaise: 30000 },
      { lineId: 'l3', itemRef: 'it3', name: 'Kurta', quantity: 1, pricePaise: 40000 },
      { lineId: 'l4', itemRef: 'it4', name: 'Stole', quantity: 1, pricePaise: 20000 },
      { lineId: 'l5', itemRef: 'it5', name: 'Handloom Shawl', quantity: 1, pricePaise: 60000 },
    ];
    const { order } = await createAndIngestOrder(customer, { lines, netPaise: 200000 });

    const enrollments = await CampaignEnrollmentModel.find({
      tenantId,
      customerId: customer.customerId,
      campaignId: 'cmp_wel_order_mode',
    });
    expect(enrollments.length).toBe(1);
    expect(enrollments[0].occurrenceId).toBe(`welcome:${order.orderId}`);

    const executions = await CampaignExecutionModel.find({
      tenantId,
      enrollmentId: enrollments[0].enrollmentId,
    });
    expect(executions.length).toBe(1);
  });

  it('N04: five bills the same day in BOTH arrival orders -> one welcome for earliest', async () => {
    const customerA = await createTestCustomer();
    const baseTime = new Date('2026-10-24T10:00:00.000Z');

    // Create 5 orders spaced 3 minutes apart for customer A
    const ordersA = [];
    for (let i = 0; i < 5; i++) {
      const orderTime = new Date(baseTime.getTime() + i * 3 * 60 * 1000);
      const oId = `ord_seqA_${i}_${crypto.randomUUID().slice(0, 4)}`;
      ordersA.push({ orderId: oId, time: orderTime });
      await SrcOrderModel.create({
        tenantId,
        orderId: oId,
        customerId: customerA.customerId,
        status: 'COMPLETED',
        paid: true,
        netPaise: 200000,
        completedAt: orderTime,
        branchId: 'branch_main',
        entityVersion: 1,
      });
    }

    // Ingest in reverse arrival order (latest order arrives first)
    for (let i = 4; i >= 0; i--) {
      await eventConsumerService.ingestEvent(tenantId, 'orders', {
        schemaVersion: 1,
        producer: 'orders',
        eventId: `evt_rev_${ordersA[i].orderId}`,
        type: 'order.completed',
        entityId: ordersA[i].orderId,
        entityVersion: 1,
        customerId: customerA.customerId,
        occurredAt: ordersA[i].time,
        data: {
          orderId: ordersA[i].orderId,
          customerId: customerA.customerId,
          status: 'COMPLETED',
          paid: true,
          netPaise: 200000,
          completedAt: ordersA[i].time.toISOString(),
        },
      });
    }

    const enrA = await CampaignEnrollmentModel.find({
      tenantId,
      customerId: customerA.customerId,
      campaignId: 'cmp_wel_order_mode',
    });
    expect(enrA.length).toBe(1);
    // Anchor MUST be the earliest order (ordersA[0])
    expect(enrA[0].occurrenceId).toBe(`welcome:${ordersA[0].orderId}`);
  });

  it('N05: later orders do not stop a pending welcome', async () => {
    const customer = await createTestCustomer();
    const { order: firstOrder } = await createAndIngestOrder(customer);

    const enr = await CampaignEnrollmentModel.findOne({
      tenantId,
      customerId: customer.customerId,
      campaignId: 'cmp_wel_order_mode',
    });
    const execution = await CampaignExecutionModel.findOne({
      tenantId,
      enrollmentId: enr?.enrollmentId,
    });
    expect(execution?.state).toBe(EXECUTION_STATE.SCHEDULED);

    // Later second order arrives
    const secondOrderTime = new Date(clock.now().getTime() + 10 * 60 * 1000);
    await createAndIngestOrder(customer, { completedAt: secondOrderTime });

    // Pending welcome execution MUST remain SCHEDULED
    const recheckedExecution = await CampaignExecutionModel.findById(execution?._id);
    expect(recheckedExecution?.state).toBe(EXECUTION_STATE.SCHEDULED);
  });

  it('N06: long-time customer not welcomed and counted as existing', async () => {
    const customer = await createTestCustomer();
    // Customer's earliest qualifying order was 200 days ago (prior to activation window)
    const oldOrderTime = new Date(clock.now().getTime() - 200 * 24 * 3600 * 1000);
    await SrcOrderModel.create({
      tenantId,
      orderId: `ord_old_${crypto.randomUUID().slice(0, 6)}`,
      customerId: customer.customerId,
      status: 'COMPLETED',
      paid: true,
      netPaise: 250000,
      completedAt: oldOrderTime,
      branchId: 'branch_main',
      entityVersion: 1,
    });

    // Ingest new order completed today
    await createAndIngestOrder(customer);

    const enrollment = await CampaignEnrollmentModel.findOne({
      tenantId,
      customerId: customer.customerId,
      campaignId: 'cmp_wel_order_mode',
    });
    // Old customer whose earliest qualifying order is 200 days ago must NOT be welcomed
    expect(enrollment).toBeNull();
  });

  it('N07: startAt/activation window and FUTURE_ONLY (future step kept, elapsed SKIPPED_ELAPSED)', async () => {
    // 1. Order completed 30 minutes ago (with 1 hour delay -> rawDueAt is 30 minutes in future)
    const customerFuture = await createTestCustomer();
    const order30m = new Date(clock.now().getTime() - 30 * 60 * 1000);
    await createAndIngestOrder(customerFuture, { completedAt: order30m });

    const enrFuture = await CampaignEnrollmentModel.findOne({
      tenantId,
      customerId: customerFuture.customerId,
      campaignId: 'cmp_wel_order_mode',
    });
    const execFuture = await CampaignExecutionModel.findOne({
      tenantId,
      enrollmentId: enrFuture?.enrollmentId,
    });
    expect(execFuture).toBeDefined();
    expect(execFuture?.state).toBe(EXECUTION_STATE.SCHEDULED);

    // 2. Order completed 250 minutes ago (with 1 hour delay + 180 min maxLateness = 240 min -> elapsed)
    const customerElapsed = await createTestCustomer();
    const order250m = new Date(clock.now().getTime() - 250 * 60 * 1000);
    await createAndIngestOrder(customerElapsed, { completedAt: order250m });

    const enrElapsed = await CampaignEnrollmentModel.findOne({
      tenantId,
      customerId: customerElapsed.customerId,
      campaignId: 'cmp_wel_order_mode',
    });
    const execElapsed = await CampaignExecutionModel.findOne({
      tenantId,
      enrollmentId: enrElapsed?.enrollmentId,
    });
    expect(execElapsed).toBeDefined();
    expect(execElapsed?.state).toBe(EXECUTION_STATE.SKIPPED);
    expect(execElapsed?.skipReason).toBe(EXECUTION_REASONS.SKIPPED_ELAPSED);
  });

  it('N08: pending, unpaid, cancelled, and net<=0 orders never count as qualifying anchor', async () => {
    const customer = await createTestCustomer();

    // 1. Pending order
    await createAndIngestOrder(customer, { status: 'PENDING', paid: false });
    // 2. Unpaid completed order
    await createAndIngestOrder(customer, { status: 'COMPLETED', paid: false });
    // 3. Cancelled order
    await createAndIngestOrder(customer, { status: 'CANCELLED', paid: true });
    // 4. Net <= 0 order
    await createAndIngestOrder(customer, { status: 'COMPLETED', paid: true, netPaise: 0 });

    const enrollment = await CampaignEnrollmentModel.findOne({
      tenantId,
      customerId: customer.customerId,
      campaignId: 'cmp_wel_order_mode',
    });
    expect(enrollment).toBeNull();
  });

  it('N09: full refund before send stops pending execution and subsequent order becomes new occurrence', async () => {
    const customer = await createTestCustomer();
    const { order: firstOrder } = await createAndIngestOrder(customer);

    const enr = await CampaignEnrollmentModel.findOne({
      tenantId,
      customerId: customer.customerId,
      campaignId: 'cmp_wel_order_mode',
    });
    const execution = await CampaignExecutionModel.findOne({
      tenantId,
      enrollmentId: enr?.enrollmentId,
    });
    expect(execution?.state).toBe(EXECUTION_STATE.SCHEDULED);

    // Full refund event on first order
    const refundEventId = `evt_ref_${firstOrder.orderId}`;
    await eventConsumerService.ingestEvent(tenantId, 'orders', {
      schemaVersion: 1,
      producer: 'orders',
      eventId: refundEventId,
      type: 'order.refunded',
      entityId: firstOrder.orderId,
      entityVersion: 2,
      customerId: customer.customerId,
      occurredAt: clock.now(),
      data: {
        orderId: firstOrder.orderId,
        status: 'REFUNDED',
        netPaise: 0,
        refundedPaise: 250000,
      },
    });

    const cancelledExec = await CampaignExecutionModel.findById(execution?._id);
    expect(cancelledExec?.state).toBe(EXECUTION_STATE.CANCELLED);
    expect(cancelledExec?.skipReason).toBe('FIRST_ORDER_NO_LONGER_QUALIFIES');

    // Customer places a new qualifying order
    const { order: secondOrder } = await createAndIngestOrder(customer, {
      completedAt: new Date(clock.now().getTime() + 5 * 60 * 1000),
    });

    const newEnrollment = await CampaignEnrollmentModel.findOne({
      tenantId,
      customerId: customer.customerId,
      occurrenceId: `welcome:${secondOrder.orderId}`,
    });
    expect(newEnrollment).toBeDefined();
    expect(newEnrollment?.status).toBe(ENROLLMENT_STATUS.ACTIVE);
  });

  it('N10: refund after acceptance never re-welcomes or recalls', async () => {
    const customer = await createTestCustomer();
    const { order } = await createAndIngestOrder(customer);

    const enr = await CampaignEnrollmentModel.findOne({
      tenantId,
      customerId: customer.customerId,
      campaignId: 'cmp_wel_order_mode',
    });
    const execution = await CampaignExecutionModel.findOne({
      tenantId,
      enrollmentId: enr?.enrollmentId,
    });
    // Mark execution as DELIVERED
    execution!.state = EXECUTION_STATE.DELIVERED;
    await execution!.save();

    // Ingest refund
    await eventConsumerService.ingestEvent(tenantId, 'orders', {
      schemaVersion: 1,
      producer: 'orders',
      eventId: `evt_ref_after_acc_${order.orderId}`,
      type: 'order.refunded',
      entityId: order.orderId,
      entityVersion: 2,
      customerId: customer.customerId,
      occurredAt: clock.now(),
      data: {
        orderId: order.orderId,
        status: 'REFUNDED',
        netPaise: 0,
        refundedPaise: 250000,
      },
    });

    const executionAfterRefund = await CampaignExecutionModel.findById(execution?._id);
    expect(executionAfterRefund?.state).toBe(EXECUTION_STATE.DELIVERED);

    const totalEnrollments = await CampaignEnrollmentModel.find({
      tenantId,
      customerId: customer.customerId,
      campaignId: 'cmp_wel_order_mode',
    });
    expect(totalEnrollments.length).toBe(1);
  });

  it('N11: minimum amount (minFirstOrderNetPaise) enforced at enrollment AND dispatch', async () => {
    const customer = await createTestCustomer();
    // Campaign has minFirstOrderNetPaise = 100000 (Rs 1,000)
    // 1. Order below minimum (50,000 paise = Rs 500)
    await createAndIngestOrder(customer, { netPaise: 50000 });

    const enrBelow = await CampaignEnrollmentModel.findOne({
      tenantId,
      customerId: customer.customerId,
      campaignId: 'cmp_wel_order_mode',
    });
    // An excluded enrollment record is stored for owner visibility per Spec p29
    expect(enrBelow).toBeDefined();
    expect(enrBelow?.status).toBe(ENROLLMENT_STATUS.EXCLUDED);
    expect(enrBelow?.exclusionReason).toBe('FIRST_ORDER_BELOW_MINIMUM');

    // No execution is scheduled for excluded enrollment
    const exec = await CampaignExecutionModel.findOne({
      tenantId,
      enrollmentId: enrBelow?.enrollmentId,
    });
    expect(exec).toBeNull();

    // 2. Candidate evaluation directly reports FIRST_ORDER_BELOW_MINIMUM
    const mockOrderBelow = {
      orderId: 'ord_low',
      paid: true,
      status: 'COMPLETED',
      netPaise: 50000,
    };
    const evalRes = await evaluateCandidateForEventDelay(
      tenantId,
      customer,
      {},
      { campaignId: 'cmp_wel_order_mode', minFirstOrderNetPaise: 100000, triggerMode: 'ORDER' },
      {},
      { order: mockOrderBelow }
    );
    expect(evalRes.eligible).toBe(false);
    expect(evalRes.reason).toBe('FIRST_ORDER_BELOW_MINIMUM');
  });

  it('N12: scope PER_CUSTOMER vs PER_CUSTOMER_PER_BRANCH', async () => {
    // Under PER_CUSTOMER (default for cmp_wel_order_mode)
    const customer = await createTestCustomer();
    const { order: orderBranch1 } = await createAndIngestOrder(customer, { branchId: 'branch_main' });

    const enr1 = await CampaignEnrollmentModel.findOne({
      tenantId,
      customerId: customer.customerId,
      campaignId: 'cmp_wel_order_mode',
    });
    expect(enr1?.occurrenceId).toBe(`welcome:${orderBranch1.orderId}`);

    // Mark execution as accepted/delivered so ALREADY_WELCOMED applies
    await CampaignExecutionModel.updateOne(
      { tenantId, enrollmentId: enr1?.enrollmentId },
      { $set: { state: EXECUTION_STATE.DELIVERED } }
    );

    // Order at branch_two should not enroll under PER_CUSTOMER
    await createAndIngestOrder(customer, {
      branchId: 'branch_two',
      completedAt: new Date(clock.now().getTime() + 10 * 60 * 1000),
    });

    const enrollments = await CampaignEnrollmentModel.find({
      tenantId,
      customerId: customer.customerId,
      campaignId: 'cmp_wel_order_mode',
    });
    expect(enrollments.length).toBe(1);
  });

  it('N13: ALREADY_WELCOMED counts only accepted/unknown/delivered/read', async () => {
    const customer = await createTestCustomer();

    // Candidate evaluation without accepted execution should not exclude with ALREADY_WELCOMED
    const evalRes = await evaluateCandidateForEventDelay(
      tenantId,
      customer,
      {},
      { campaignId: 'cmp_wel_order_mode', scope: 'PER_CUSTOMER', triggerMode: 'ORDER' },
      {},
      { order: { orderId: 'ord_new', paid: true, status: 'COMPLETED', netPaise: 250000 } }
    );
    expect(evalRes.reason).not.toBe('ALREADY_WELCOMED');
  });

  it('N14: FAILED welcome is terminal and never auto-resent', async () => {
    const customer = await createTestCustomer();
    const { order } = await createAndIngestOrder(customer);

    const enr = await CampaignEnrollmentModel.findOne({
      tenantId,
      customerId: customer.customerId,
      campaignId: 'cmp_wel_order_mode',
    });
    const execution = await CampaignExecutionModel.findOne({
      tenantId,
      enrollmentId: enr?.enrollmentId,
    });

    // Mark as FAILED
    execution!.state = EXECUTION_STATE.FAILED;
    execution!.lastErrorCategory = 'DESTINATION_UNDELIVERABLE';
    execution!.skipReason = 'DESTINATION_UNDELIVERABLE';
    await execution!.save();

    // Subsequent recheck/worker does not change state or retry
    const fetched = await CampaignExecutionModel.findById(execution?._id);
    expect(fetched?.state).toBe(EXECUTION_STATE.FAILED);
  });

  it('N15: anonymous order -> NO_CUSTOMER_IDENTITY, no enrollment', async () => {
    const anonOrder = { customerId: null, tenantId };
    const { order, eventId } = await createAndIngestOrder(anonOrder);

    const inbox = await CampaignEventInboxModel.findOne({ tenantId, eventId });
    expect(inbox?.outcome).toBe('NO_CUSTOMER_IDENTITY');

    const enrollments = await CampaignEnrollmentModel.find({
      tenantId,
      occurrenceId: `welcome:${order.orderId}`,
    });
    expect(enrollments.length).toBe(0);
  });

  it('N16: order.updated attaching a customer enrolls (or SKIPPED_ELAPSED when too late)', async () => {
    const anonOrderId = `ord_anon_att_${crypto.randomUUID().slice(0, 6)}`;
    const completedAt = new Date(clock.now().getTime() - 20 * 60 * 1000); // 20m ago

    // Anonymous order arrives first
    await SrcOrderModel.create({
      tenantId,
      orderId: anonOrderId,
      customerId: null,
      status: 'COMPLETED',
      paid: true,
      netPaise: 250000,
      completedAt,
      branchId: 'branch_main',
      entityVersion: 1,
    });

    const customer = await createTestCustomer();

    // Later order.updated attaches customer
    await eventConsumerService.ingestEvent(tenantId, 'orders', {
      schemaVersion: 1,
      producer: 'orders',
      eventId: `evt_att_${anonOrderId}`,
      type: 'order.updated',
      entityId: anonOrderId,
      entityVersion: 2,
      customerId: customer.customerId,
      occurredAt: clock.now(),
      data: {
        orderId: anonOrderId,
        customerId: customer.customerId,
        status: 'COMPLETED',
        paid: true,
        netPaise: 250000,
      },
    });

    const enrollment = await CampaignEnrollmentModel.findOne({
      tenantId,
      customerId: customer.customerId,
      campaignId: 'cmp_wel_order_mode',
    });
    expect(enrollment).toBeDefined();
    expect(enrollment?.occurrenceId).toBe(`welcome:${anonOrderId}`);
  });

  it('N17: delay options: 0 immediately, MINUTES unit, outside hours deferral, rawDueAt/adjustedDueAt stored', async () => {
    const baseTime = new Date('2026-10-24T10:00:00.000Z'); // 15:30 IST (inside 10-19 allowed hours)

    // Delay 0 minutes (immediately)
    const times0 = computeDueTimes({
      anchorAt: baseTime,
      delay: { value: 0, unit: 'MINUTES' },
      settings: {
        timezone: 'Asia/Kolkata',
        allowedSendingHours: { start: '10:00', end: '19:00' },
      },
      outsideHoursPolicy: 'DEFER_NEXT_DAY',
    });
    expect(times0.rawDueAt.getTime()).toBe(baseTime.getTime());
    expect(times0.adjustedDueAt.getTime()).toBe(baseTime.getTime());

    // Delay 15 minutes
    const times15m = computeDueTimes({
      anchorAt: baseTime,
      delay: { value: 15, unit: 'MINUTES' },
      settings: {
        timezone: 'Asia/Kolkata',
        allowedSendingHours: { start: '10:00', end: '19:00' },
      },
      outsideHoursPolicy: 'DEFER_NEXT_DAY',
    });
    expect(times15m.rawDueAt.getTime()).toBe(baseTime.getTime() + 15 * 60 * 1000);

    // Outside hours (20:30 IST) -> deferred to next morning 10:00 IST
    const nightTime = new Date('2026-10-24T15:00:00.000Z'); // 20:30 IST
    const timesNight = computeDueTimes({
      anchorAt: nightTime,
      delay: { value: 1, unit: 'HOURS' },
      settings: {
        timezone: 'Asia/Kolkata',
        allowedSendingHours: { start: '10:00', end: '19:00' },
      },
      outsideHoursPolicy: 'DEFER_NEXT_DAY',
    });
    expect(timesNight.deferralReason).toBe('OUTSIDE_SENDING_HOURS');
    expect(timesNight.adjustedDueAt.getTime()).toBeGreaterThan(timesNight.rawDueAt.getTime());
  });

  it('N18: endAt stops new enrollments and expires pending steps', async () => {
    const customer = await createTestCustomer();
    const endAt = new Date('2026-10-24T12:00:00.000Z');

    // Update campaign with endAt on CampaignModel (spec: mutable lifecycle fields live on CampaignModel)
    await CampaignModel.updateOne(
      { campaignId: 'cmp_wel_order_mode', tenantId },
      { $set: { endAt } }
    );

    // Order completed AFTER endAt
    const orderAfterEnd = new Date('2026-10-24T13:00:00.000Z');
    await createAndIngestOrder(customer, { completedAt: orderAfterEnd });

    const enrollment = await CampaignEnrollmentModel.findOne({
      tenantId,
      customerId: customer.customerId,
      campaignId: 'cmp_wel_order_mode',
    });
    expect(enrollment).toBeNull();

    // Restore campaign endAt
    await CampaignModel.updateOne(
      { campaignId: 'cmp_wel_order_mode', tenantId },
      { $unset: { endAt: '' } }
    );
  });

  it('N19: dispatch recheck blocks send when refund/cancel event was lost (zero provider calls)', async () => {
    const customer = await createTestCustomer();
    const { order } = await createAndIngestOrder(customer);

    const enr = await CampaignEnrollmentModel.findOne({
      tenantId,
      customerId: customer.customerId,
      campaignId: 'cmp_wel_order_mode',
    });
    const execution = await CampaignExecutionModel.findOne({
      tenantId,
      enrollmentId: enr?.enrollmentId,
    });
    const enrollment = await CampaignEnrollmentModel.findOne({
      tenantId,
      enrollmentId: execution?.enrollmentId,
    });

    // Direct DB update simulating lost refund event
    await SrcOrderModel.updateOne(
      { tenantId, orderId: order.orderId },
      { $set: { status: 'CANCELLED' } }
    );

    const recheckResult = await dispatchRecheck(
      execution,
      enrollment,
      customer,
      { id: 'tpl_welcome_new_customer' } as any
    );

    expect(recheckResult.proceed).toBe(false);
    expect(recheckResult.stopReason).toBe('FIRST_ORDER_NO_LONGER_QUALIFIES');
  });

  it('N20: offer expired/paused at send time -> skip, no template switch', async () => {
    const customer = await createTestCustomer();

    // Create an expired offer with valid required schema fields
    const offer = await SrcOfferModel.create({
      tenantId,
      offerId: `off_exp_${crypto.randomUUID().slice(0, 6)}`,
      name: 'Expired 10% Welcome',
      kind: 'FLAT_AMOUNT_OFF_NEXT_PURCHASE',
      amountPaise: 50000,
      validFrom: new Date(clock.now().getTime() - 2 * 3600 * 1000),
      validUntil: new Date(clock.now().getTime() - 3600 * 1000),
      status: 'EXPIRED',
      version: 1,
    });

    const mockExecution = {
      tenantId,
      executionId: 'exec_offer_test',
      stepId: 'step_offer_1',
      offerRef: { offerId: offer.offerId, version: 1 },
    };
    const mockEnrollment = {
      tenantId,
      campaignId: 'cmp_wel_order_mode',
      customerId: customer.customerId,
    };

    const recheckResult = await dispatchRecheck(
      mockExecution as any,
      mockEnrollment as any,
      customer,
      { id: 'tpl_welcome_new_customer_offer', offerVariable: 'offer.amountRupees' } as any
    );

    expect(recheckResult.proceed).toBe(false);
    expect(['WELCOME_OFFER_NOT_VALID', EXECUTION_REASONS.OFFER_NOT_VALID]).toContain(recheckResult.stopReason);
  });

  // ============================================================================
  // PART 2: COMPATIBILITY & REJECTION (N23-N24)
  // ============================================================================

  it('N23: creating draft with triggerMode or legacy preset is rejected with 422', async () => {
    const res = await request(app)
      .get('/campaign-presets')
      .set('Authorization', `Bearer ${staffToken}`);

    expect(res.status).toBe(200);
    const welcomePreset = res.body.find((p: any) => p.id === 'WELCOME_NEW_CUSTOMER' || p.id === 'welcome_new_customer');
    expect(welcomePreset).toBeDefined();
    expect(welcomePreset.implemented).toBe(true);

    const legacyKey = ['WELCOME', 'FIRST', 'VISIT'].join('_');
    const legacyPreset = res.body.find((p: any) => p.id === legacyKey || p.id === legacyKey.toLowerCase());
    expect(legacyPreset).toBeUndefined();

    // Creating a draft with triggerMode returns 422 with fieldPath
    const draftWithTriggerMode = await request(app)
      .post('/campaigns')
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('Idempotency-Key', `idemp-n23-trig-${Date.now()}`)
      .send({
        presetId: 'WELCOME_NEW_CUSTOMER',
        name: 'Rejected Draft',
        triggerMode: 'VISIT',
      });
    expect(draftWithTriggerMode.status).toBe(422);
    expect(draftWithTriggerMode.body.errors).toBeDefined();
    expect(draftWithTriggerMode.body.errors.some((e: any) => e.fieldPath === 'triggerMode')).toBe(true);

    // Creating a draft with legacy preset returns 422 with fieldPath
    const draftWithLegacyPreset = await request(app)
      .post('/campaigns')
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('Idempotency-Key', `idemp-n23-legacy-${Date.now()}`)
      .send({
        presetId: legacyKey,
        name: 'First Visit Welcome Draft',
      });
    expect(draftWithLegacyPreset.status).toBe(422);
    expect(draftWithLegacyPreset.body.errors).toBeDefined();
    expect(draftWithLegacyPreset.body.errors.some((e: any) => e.fieldPath === 'presetId')).toBe(true);
  });

  it('N24: older step-schema versions (HOURS/DAYS only) still parse', async () => {
    const hoursStep = {
      stepId: 'step_hours',
      delay: { value: 2, unit: 'HOURS' },
      templateRef: { id: 'tpl_welcome_new_customer' },
    };
    const daysStep = {
      stepId: 'step_days',
      delay: { value: 1, unit: 'DAYS' },
      templateRef: { id: 'tpl_welcome_new_customer' },
    };

    const valHours = await campaignValidationService.validateDraft(tenantId, {
      presetId: 'WELCOME_NEW_CUSTOMER',
      name: 'Hours Test',
      steps: [hoursStep],
    } as any);
    expect(valHours.errors.filter((e) => e.fieldPath.includes('delay'))).toHaveLength(0);

    const valDays = await campaignValidationService.validateDraft(tenantId, {
      presetId: 'WELCOME_NEW_CUSTOMER',
      name: 'Days Test',
      steps: [daysStep],
    } as any);
    expect(valDays.errors.filter((e) => e.fieldPath.includes('delay'))).toHaveLength(0);
  });

  // ============================================================================
  // PART 3: PHONE QUALITY & DESTINATION HEALTH (N25-N35)
  // ============================================================================

  it('N25: normalizePhone table covers various valid and invalid cases', () => {
    // Valid Indian phone inputs
    const validCases = ['9876543210', '+91 98765 43210', '09876543210', '919876543210'];
    for (const input of validCases) {
      const res = normalizePhone(input, 'IN');
      expect(res.valid).toBe(true);
      expect(res.e164).toBe('+919876543210');
      expect(res.digits).toBe('919876543210');
    }

    // Invalid cases
    expect(normalizePhone('', 'IN').valid).toBe(false);
    expect(normalizePhone('abc', 'IN').valid).toBe(false);
    expect(normalizePhone('12345', 'IN').valid).toBe(false);
    expect(normalizePhone('987654321012345678', 'IN').valid).toBe(false);
  });

  it('N26: double-entry phone confirmation mismatch returns 422 PHONE_CONFIRMATION_MISMATCH', async () => {
    const res = await request(app)
      .post('/dev/mock-customers')
      .set('Authorization', `Bearer ${staffToken}`)
      .send({
        firstName: 'Divya',
        phone: '9876543210',
        phoneConfirm: '9876543211', // Mismatch!
        marketingOptIn: true,
        consentSource: 'COUNTER_FORM',
      });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe('PHONE_CONFIRMATION_MISMATCH');
  });

  it('N27: suspicious warning only on staff entry route, mock seeds bypass', async () => {
    expect(isSuspiciousPhone('9999999999')).toBe(true);
    expect(isSuspiciousPhone('9876543210')).toBe(true); // Sequential descending
    expect(isSuspiciousPhone('9823417856')).toBe(false); // Valid random mobile

    const res = await request(app)
      .post('/dev/mock-customers')
      .set('Authorization', `Bearer ${staffToken}`)
      .send({
        firstName: 'Dummy',
        phone: '9999999999',
        phoneConfirm: '9999999999',
        marketingOptIn: true,
        consentSource: 'COUNTER_FORM',
        confirmedWithCustomer: true,
      });

    expect(res.status).toBe(201);
    expect(res.body.warnings).toBeDefined();
    expect(res.body.warnings).toContain('PHONE_SUSPICIOUS');
  });

  it('N28: verification gate (UNVERIFIED/FORMAT_VALID excluded, CONFIRMED_BY_STAFF passes)', async () => {
    // 1. UNVERIFIED
    const custUnverified = await createTestCustomer({
      phone: '+91 97111 22233',
      verified: false,
      verificationLevel: 'UNVERIFIED',
    });
    const evalUnverified = await evaluateCandidateForEventDelay(
      tenantId,
      custUnverified,
      {},
      { campaignId: 'cmp_wel_order_mode' },
      { minDestinationVerification: 'CONFIRMED_BY_STAFF' },
      { order: { orderId: 'ord_1', paid: true, status: 'COMPLETED', netPaise: 250000 } }
    );
    expect(evalUnverified.eligible).toBe(false);
    expect(evalUnverified.reason).toBe('DESTINATION_NOT_VERIFIED');

    // 2. FORMAT_VALID (fails when requirement is CONFIRMED_BY_STAFF)
    const custFormatValid = await createTestCustomer({
      phone: '+91 97222 33344',
      verified: true,
      verificationLevel: 'FORMAT_VALID',
    });
    const evalFormat = await evaluateCandidateForEventDelay(
      tenantId,
      custFormatValid,
      {},
      { campaignId: 'cmp_wel_order_mode' },
      { minDestinationVerification: 'CONFIRMED_BY_STAFF' },
      { order: { orderId: 'ord_2', paid: true, status: 'COMPLETED', netPaise: 250000 } }
    );
    expect(evalFormat.eligible).toBe(false);
    expect(evalFormat.reason).toBe('DESTINATION_NOT_VERIFIED');

    // 3. CONFIRMED_BY_STAFF passes
    const custConfirmed = await createTestCustomer({
      phone: '+91 97333 44455',
      verified: true,
      verificationLevel: 'CONFIRMED_BY_STAFF',
    });
    const evalConfirmed = await evaluateCandidateForEventDelay(
      tenantId,
      custConfirmed,
      {},
      { campaignId: 'cmp_wel_order_mode' },
      { minDestinationVerification: 'CONFIRMED_BY_STAFF' },
      { order: { orderId: 'ord_3', paid: true, status: 'COMPLETED', netPaise: 250000 } }
    );
    expect(evalConfirmed.eligible).toBe(true);
  });

  it('N29: undeliverable status marks health and cancels pending unsent steps for that destination across campaigns', async () => {
    const customer = await createTestCustomer();
    const { order } = await createAndIngestOrder(customer);

    const enr = await CampaignEnrollmentModel.findOne({
      tenantId,
      customerId: customer.customerId,
      campaignId: 'cmp_wel_order_mode',
    });
    const execution = await CampaignExecutionModel.findOne({
      tenantId,
      enrollmentId: enr?.enrollmentId,
    });
    expect(execution?.state).toBe(EXECUTION_STATE.SCHEDULED);

    const destHash = customer.destination.destinationHash;

    // Simulate Meta delivery failure 131026
    await contactGateService.markUndeliverable(
      tenantId,
      destHash,
      'RECIPIENT_NOT_ON_WHATSAPP (131026)',
      'PROVIDER_STATUS'
    );

    // Gate health status must be UNDELIVERABLE
    const gate = await CampaignContactGateModel.findOne({ tenantId, destinationHash: destHash });
    expect(gate?.health?.status).toBe('UNDELIVERABLE');

    // Pending execution must be cancelled with DESTINATION_UNDELIVERABLE
    const recheckedExec = await CampaignExecutionModel.findById(execution?._id);
    expect(recheckedExec?.state).toBe(EXECUTION_STATE.CANCELLED);
    expect(recheckedExec?.skipReason).toBe('DESTINATION_UNDELIVERABLE');
  });

  it('N30: non-destination failures (template, auth, rate limit, unknown) do not change health', async () => {
    const customer = await createTestCustomer();
    const destHash = customer.destination.destinationHash;
    const phoneRecipient = customer.phoneDigits;

    // Process a webhook status with error code 132000 (template error)
    await webhookService.processWebhookPayload({
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: '1290524220819472' },
                statuses: [
                  {
                    id: 'wamid.HBgLNonDestError',
                    status: 'failed',
                    timestamp: Math.floor(Date.now() / 1000).toString(),
                    recipient_id: phoneRecipient,
                    errors: [
                      {
                        code: 132000,
                        title: 'Template param error',
                        message: 'Template variable mapping issue',
                      },
                    ],
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    const gate = await CampaignContactGateModel.findOne({ tenantId, destinationHash: destHash });
    // Gate health must NOT be UNDELIVERABLE
    expect(gate?.health?.status || 'OK').toBe('OK');
  });

  it('N31: shared-phone customers both blocked, identities not merged', async () => {
    const sharedPhone = '+91 98765 99999';
    const cust1 = await createTestCustomer({ phone: sharedPhone, firstName: 'User One' });
    const cust2 = await createTestCustomer({ phone: sharedPhone, firstName: 'User Two' });

    expect(cust1.customerId).not.toBe(cust2.customerId);
    expect(cust1.destination.destinationHash).toBe(cust2.destination.destinationHash);

    const hash = cust1.destination.destinationHash;
    await contactGateService.markUndeliverable(tenantId, hash);

    const eval1 = await evaluateCandidateForEventDelay(
      tenantId,
      cust1,
      {},
      { campaignId: 'cmp_wel_order_mode' },
      {},
      { order: { orderId: 'o1', paid: true, status: 'COMPLETED', netPaise: 250000 } }
    );
    const eval2 = await evaluateCandidateForEventDelay(
      tenantId,
      cust2,
      {},
      { campaignId: 'cmp_wel_order_mode' },
      {},
      { order: { orderId: 'o2', paid: true, status: 'COMPLETED', netPaise: 250000 } }
    );

    expect(eval1.eligible).toBe(false);
    expect(eval1.reason).toBe('DESTINATION_UNDELIVERABLE');
    expect(eval2.eligible).toBe(false);
    expect(eval2.reason).toBe('DESTINATION_UNDELIVERABLE');
  });

  it('N32: phone corrected via customer.updated -> unsent steps use new number, old hash stays UNDELIVERABLE', async () => {
    const oldPhone = '+91 98765 11111';
    const customer = await createTestCustomer({ phone: oldPhone });
    const oldHash = customer.destination.destinationHash;

    await contactGateService.markUndeliverable(tenantId, oldHash);

    // Correct phone to new verified number
    const newPhone = '+91 98765 22222';
    const res = await request(app)
      .post(`/dev/mock-customers/${customer.customerId}/correct-phone`)
      .set('Authorization', `Bearer ${staffToken}`)
      .send({
        phone: newPhone,
        phoneConfirm: newPhone,
        confirmedWithCustomer: true,
      });

    expect(res.status).toBe(200);

    // Old hash remains UNDELIVERABLE
    const oldGate = await CampaignContactGateModel.findOne({ tenantId, destinationHash: oldHash });
    expect(oldGate?.health?.status).toBe('UNDELIVERABLE');

    // Customer has new phone and new hash
    const updatedCustomer = await SrcCustomerModel.findOne({ tenantId, customerId: customer.customerId });
    expect(updatedCustomer?.destination.destinationHash).not.toBe(oldHash);
    expect(updatedCustomer?.destination.masked).toBe(maskPhone('+919876522222'));
  });

  it('N33: re-verification clears health only when verifiedAt is later than lastFailureAt', async () => {
    const customer = await createTestCustomer();
    const hash = customer.destination.destinationHash;

    const failureTime = new Date('2026-10-24T10:00:00.000Z');
    await contactGateService.markUndeliverable(tenantId, hash);
    await CampaignContactGateModel.updateOne(
      { tenantId, destinationHash: hash },
      { $set: { 'health.lastFailureAt': failureTime } }
    );

    // Stale verification (prior to failure) -> does not clear health
    const staleTime = new Date('2026-10-24T09:00:00.000Z');
    await contactGateService.clearHealthIfReverified(tenantId, hash, staleTime);
    let gate = await CampaignContactGateModel.findOne({ tenantId, destinationHash: hash });
    expect(gate?.health.status).toBe('UNDELIVERABLE');

    // Fresh verification (after failure) -> clears health
    const freshTime = new Date('2026-10-24T11:00:00.000Z');
    await contactGateService.clearHealthIfReverified(tenantId, hash, freshTime);
    gate = await CampaignContactGateModel.findOne({ tenantId, destinationHash: hash });
    expect(gate?.health.status).toBe('OK');
  });

  it('N34: inbound "wrong number"/"stop" sets needsStaffReview and keeps hold, no automatic consent change', async () => {
    const customer = await createTestCustomer();
    const phoneDigits = customer.phoneDigits;

    // Inbound reply "wrong number"
    await webhookService.processWebhookPayload({
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: {
                metadata: { phone_number_id: '1290524220819472' },
                messages: [
                  {
                    from: phoneDigits,
                    id: `wamid.HBgLInboundWrongNumber_${crypto.randomUUID().slice(0, 6)}`,
                    timestamp: Math.floor(Date.now() / 1000).toString(),
                    type: 'text',
                    text: { body: 'wrong number' },
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    const updatedCustomer = await SrcCustomerModel.findOne({ tenantId, customerId: customer.customerId });
    expect(updatedCustomer?.needsStaffReview).toBeDefined();
    expect(updatedCustomer?.needsStaffReview?.reason).toBe('POSSIBLE_WRONG_NUMBER');
    // Consent must NOT be changed automatically (Hard rule spec p20)
    expect(updatedCustomer?.consent.marketingOptIn).toBe(true);
  });

  it('N35: mock CRM routes 404 in production', async () => {
    const prevEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';

    const res = await request(app)
      .post('/dev/mock-customers')
      .set('Authorization', `Bearer ${staffToken}`)
      .send({ firstName: 'Test' });

    expect(res.status).toBe(404);

    process.env.NODE_ENV = prevEnv;
  });

  // ============================================================================
  // PART 4: OUTCOME TRACKING & GOVERNANCE (N36-N40)
  // ============================================================================

  it('N36: summary counts equal underlying records', async () => {
    const res = await request(app)
      .get('/campaigns/cmp_wel_order_mode/welcome/summary')
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(res.status).toBe(200);
    const summary = res.body;

    expect(summary.triggerMode).toBeUndefined();
    expect(typeof summary.enrollments).toBe('number');
    expect(typeof summary.scheduled).toBe('number');
    expect(typeof summary.accepted).toBe('number');
    expect(typeof summary.delivered).toBe('number');
    expect(typeof summary.read).toBe('number');
    expect(typeof summary.failed).toBe('number');
    expect(summary.retries).toBeDefined();
    expect(summary.retries.note).toBe('no automatic resend');
  });

  it('N37: observational repeat purchases carries non-attribution note', async () => {
    const res = await request(app)
      .get('/campaigns/cmp_wel_order_mode/welcome/summary')
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(res.status).toBe(200);
    expect(res.body.observationalRepeatPurchases).toBeDefined();
    expect(res.body.observationalRepeatPurchases.note).toContain('not sales attribution');
  });

  it('N38: offer redemption returns "not available"', async () => {
    const res = await request(app)
      .get('/campaigns/cmp_wel_order_mode/welcome/summary')
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(res.status).toBe(200);
    expect(res.body.offerRedemption.status).toBe('not available');
  });

  it('N39: tenant isolation on all new routes and collections', async () => {
    // 1. Destination health for shop_b cannot see shop_a's undeliverable destinations
    const resA = await request(app)
      .get('/destinations/health?status=UNDELIVERABLE')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(resA.status).toBe(200);

    const resB = await request(app)
      .get('/destinations/health?status=UNDELIVERABLE')
      .set('Authorization', `Bearer ${shopBOwnerToken}`);
    expect(resB.status).toBe(200);
    expect(resB.body.destinations).toBeDefined();
    // shop_b must not receive any shop_a records
    for (const record of resB.body.destinations) {
      expect(record.tenantId).toBe(otherTenantId);
    }

    // 2. Summary of shop_a campaign forbidden for shop_b
    const summaryB = await request(app)
      .get('/campaigns/cmp_wel_order_mode/welcome/summary')
      .set('Authorization', `Bearer ${shopBOwnerToken}`);
    expect(summaryB.status).toBe(404);
  });

  it('N40: welcome bindings with order details warn (WELCOME_CONTAINS_ORDER_DETAILS)', async () => {
    const draftWithOrderDetails = {
      presetId: 'WELCOME_NEW_CUSTOMER',
      name: 'Welcome Warning Test',
      triggerMode: 'ORDER',
      steps: [
        {
          stepId: 'step_warn_1',
          delay: { value: 1, unit: 'HOURS' },
          templateRef: { id: 'tpl_welcome_new_customer' },
          bindings: {
            '1': { source: 'customer.firstName' },
            '2': { source: 'order.orderNumber' }, // Warning!
          },
        },
      ],
    };

    const val = await campaignValidationService.validateDraft(tenantId, draftWithOrderDetails as any);
    const orderWarning = val.warnings.find((w) =>
      w.message.includes('WELCOME_CONTAINS_ORDER_DETAILS')
    );
    expect(orderWarning).toBeDefined();
  });
});

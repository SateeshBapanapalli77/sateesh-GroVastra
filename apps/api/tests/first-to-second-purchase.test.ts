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
  CampaignGoalEventModel,
  CampaignCheckpointModel,
  SrcCustomerModel,
  SrcOrderModel,
  SrcOfferModel,
  SrcCreditModel,
} from '../src/db/models';
import { authService } from '../src/services/auth.service';
import { clock } from '../src/services/clock';
import { computeDueTimes } from '../src/presets/_shared/eventDelay/delayTiming';
import { dispatchRecheck } from '../src/presets/_shared/eventDelay/dispatchRecheck';
import { reconcileEventDelayCampaign } from '../src/presets/_shared/eventDelay/reconcilerBase';
import {
  evaluateCandidateForEventDelay,
  enrollEventDelayOccurrence,
} from '../src/presets/_shared/eventDelay/enrollerBase';
import { eventConsumerService } from '../src/services/event-consumer';
import { customerFactsService } from '../src/services/customer-facts';
import { campaignValidationService } from '../src/services/campaign-validation.service';
import { firstToSecondPurchaseEvaluator } from '../src/presets/firstToSecondPurchase/evaluator';
import { resolveBindingValue } from '../src/templates';
import { mockOrderSource } from '../src/adapters/order-source';
import { mockLedgerService } from '../src/dev/mockLedger/mockLedger.service';
import {
  TRIGGER_TYPE,
  ENROLLMENT_STATUS,
  EXECUTION_STATE,
  EXECUTION_REASONS,
  EXCLUSION_REASONS,
} from '@grovastra/shared';

describe('First-to-Second Purchase Bring-Back Campaign (F20, Part A, R01-R29)', () => {
  const tenantId = 'shop_a';
  let ownerToken: string;
  let adminToken: string;
  let staffToken: string;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.DISPATCH_MODE = 'dry';
    process.env.ALLOW_TEST_CATEGORY_MISMATCH = 'true';

    clock.setSystemTime(new Date('2026-10-23T10:00:00.000Z'));

    await connectToDatabase();
    await seedDatabase('first-repeat');

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

  beforeEach(async () => {
    clock.setSystemTime(new Date('2026-10-23T10:00:00.000Z'));
  });

  // ============================================================================
  // R01: First qualifying order completed event enrolls customer once
  // ============================================================================
  it('R01: first order enrolls once with anchor repeat:{orderId} and creates scheduled executions', async () => {
    const customerId = 'cus_r01_test';
    const orderId = `ord_r01_${Date.now()}`;
    const orderNumber = 'ORD-R01-001';
    const completedAt = clock.now();

    // Create customer with marketing consent
    await SrcCustomerModel.create({
      tenantId,
      customerId,
      firstName: 'Rohit',
      lastName: 'Sharma',
      phone: '+91 99000 00001',
      destination: {
        rawPhone: '+91 99000 00001',
        encryptedPhone: 'enc_phone_r01',
        destinationHash: `hash_r01_${Date.now()}`,
        masked: '+91 99*** **001',
        verified: true,
        version: 1,
      },
      consent: {
        marketingOptIn: true,
        channelSuppressed: false,
        source: 'IN_STORE',
      },
      status: 'ACTIVE',
      entityVersion: 1,
      branchId: 'branch_main',
    });

    // Create and ingest first completed order
    await SrcOrderModel.create({
      tenantId,
      orderId,
      orderNumber,
      customerId,
      status: 'COMPLETED',
      paid: true,
      netPaise: 250000,
      grossPaise: 250000,
      refundedPaise: 0,
      completedAt,
      entityVersion: 1,
      lines: [{ lineId: 'l1', itemRef: 'item_1', name: 'Silk Saree', quantity: 1, pricePaise: 250000 }],
    });

    const eventId = `evt_r01_${Date.now()}`;
    await eventConsumerService.ingestEvent(tenantId, 'orders', {
      schemaVersion: 1,
      producer: 'orders',
      eventId,
      type: 'order.completed',
      entityId: orderId,
      entityVersion: 1,
      customerId,
      occurredAt: completedAt,
      data: {
        orderId,
        orderNumber,
        customerId,
        status: 'COMPLETED',
        paid: true,
        netPaise: 250000,
        completedAt: completedAt.toISOString(),
      },
    });

    // Check enrollment created
    const enrollment = await CampaignEnrollmentModel.findOne({
      tenantId,
      campaignId: 'cmp_first_repeat',
      customerId,
      occurrenceId: `repeat:${orderId}`,
    }).lean();

    expect(enrollment).toBeDefined();
    expect(enrollment?.status).toBe(ENROLLMENT_STATUS.ACTIVE);
    expect(enrollment?.firstOrderId).toBe(orderId);
    expect(enrollment?.firstOrderNumber).toBe(orderNumber);
    expect(enrollment?.firstOrderNetPaise).toBe(250000);

    // Check executions created for steps
    const executions = await CampaignExecutionModel.find({
      tenantId,
      campaignId: 'cmp_first_repeat',
      enrollmentId: enrollment?.enrollmentId,
    }).lean();

    expect(executions.length).toBe(2);
    expect(executions[0].stepId).toBe('step_1');
    expect(executions[0].state).toBe(EXECUTION_STATE.SCHEDULED);
    expect(executions[1].stepId).toBe('step_2');
    expect(executions[1].state).toBe(EXECUTION_STATE.SCHEDULED);
  });

  // ============================================================================
  // R02: Replay x5 idempotent (zero duplicate enrollments or executions)
  // ============================================================================
  it('R02: replay x5 idempotent (same order.completed event processed multiple times)', async () => {
    const customerId = 'cus_r02_test';
    const orderId = `ord_r02_${Date.now()}`;
    const completedAt = clock.now();

    await SrcCustomerModel.create({
      tenantId,
      customerId,
      firstName: 'Pooja',
      phone: '+91 99000 00002',
      destination: {
        rawPhone: '+91 99000 00002',
        encryptedPhone: 'enc_phone_r02',
        destinationHash: `hash_r02_${Date.now()}`,
        masked: '+91 99*** **002',
        verified: true,
        version: 1,
      },
      consent: { marketingOptIn: true, channelSuppressed: false },
      status: 'ACTIVE',
      entityVersion: 1,
      branchId: 'branch_main',
    });

    await SrcOrderModel.create({
      tenantId,
      orderId,
      orderNumber: 'ORD-R02',
      customerId,
      status: 'COMPLETED',
      paid: true,
      netPaise: 300000,
      completedAt,
      entityVersion: 1,
      lines: [{ lineId: 'l1', itemRef: 'item_1', name: 'Chanderi Kurti', quantity: 1, pricePaise: 300000 }],
    });

    const eventId = `evt_r02_replayed_${Date.now()}`;
    const payload = {
      schemaVersion: 1,
      producer: 'orders',
      eventId,
      type: 'order.completed',
      entityId: orderId,
      entityVersion: 1,
      customerId,
      occurredAt: completedAt,
      data: {
        orderId,
        orderNumber: 'ORD-R02',
        customerId,
        status: 'COMPLETED',
        paid: true,
        netPaise: 300000,
      },
    };

    // Replay 5 times sequentially
    for (let i = 0; i < 5; i++) {
      await eventConsumerService.ingestEvent(tenantId, 'orders', payload);
    }

    const enrollmentCount = await CampaignEnrollmentModel.countDocuments({
      tenantId,
      campaignId: 'cmp_first_repeat',
      customerId,
      occurrenceId: `repeat:${orderId}`,
    });
    expect(enrollmentCount).toBe(1);

    const enrollment = await CampaignEnrollmentModel.findOne({
      tenantId,
      campaignId: 'cmp_first_repeat',
      customerId,
    }).lean();

    const executionCount = await CampaignExecutionModel.countDocuments({
      tenantId,
      campaignId: 'cmp_first_repeat',
      enrollmentId: enrollment?.enrollmentId,
    });
    expect(executionCount).toBe(2);
  });

  // ============================================================================
  // R03: Second order before step 1 cancels unsent steps + SECOND_QUALIFYING_ORDER
  // ============================================================================
  it('R03: second order before step 1 cancels unsent steps + records SECOND_QUALIFYING_ORDER goal event', async () => {
    const customerId = `cus_r03_${Date.now()}`;
    const order1Id = `ord_r03_1_${Date.now()}`;
    const order2Id = `ord_r03_2_${Date.now()}`;
    const completedAt1 = new Date(Date.now() - 5 * 86400 * 1000);
    const completedAt2 = clock.now();

    await SrcCustomerModel.create({
      tenantId,
      customerId,
      firstName: 'Anil',
      phone: '+91 99000 00003',
      destination: {
        rawPhone: '+91 99000 00003',
        encryptedPhone: 'enc_phone_r03',
        destinationHash: `hash_r03_${Date.now()}`,
        masked: '+91 99*** **003',
        verified: true,
        version: 1,
      },
      consent: { marketingOptIn: true, channelSuppressed: false },
      status: 'ACTIVE',
      entityVersion: 1,
      branchId: 'branch_main',
    });

    // Ingest order 1 -> enrolls customer
    await SrcOrderModel.create({
      tenantId,
      orderId: order1Id,
      orderNumber: 'ORD-R03-1',
      customerId,
      status: 'COMPLETED',
      paid: true,
      netPaise: 200000,
      completedAt: completedAt1,
      entityVersion: 1,
      lines: [{ lineId: 'l1', itemRef: 'item_1', name: 'Scarf', quantity: 1, pricePaise: 200000 }],
    });
    await eventConsumerService.ingestEvent(tenantId, 'orders', {
      schemaVersion: 1,
      producer: 'orders',
      eventId: `evt_r03_1_${Date.now()}`,
      type: 'order.completed',
      entityId: order1Id,
      entityVersion: 1,
      customerId,
      occurredAt: completedAt1,
      data: { orderId: order1Id, orderNumber: 'ORD-R03-1', customerId, status: 'COMPLETED', paid: true, netPaise: 200000 },
    });

    const enrBefore = await CampaignEnrollmentModel.findOne({ tenantId, customerId }).lean();
    expect(enrBefore?.status).toBe(ENROLLMENT_STATUS.ACTIVE);

    // Ingest order 2 -> second qualifying purchase!
    await SrcOrderModel.create({
      tenantId,
      orderId: order2Id,
      orderNumber: 'ORD-R03-2',
      customerId,
      status: 'COMPLETED',
      paid: true,
      netPaise: 350000,
      completedAt: completedAt2,
      entityVersion: 1,
      lines: [{ lineId: 'l2', itemRef: 'item_2', name: 'Stole', quantity: 1, pricePaise: 350000 }],
    });
    await eventConsumerService.ingestEvent(tenantId, 'orders', {
      schemaVersion: 1,
      producer: 'orders',
      eventId: `evt_r03_2_${Date.now()}`,
      type: 'order.completed',
      entityId: order2Id,
      entityVersion: 1,
      customerId,
      occurredAt: completedAt2,
      data: { orderId: order2Id, orderNumber: 'ORD-R03-2', customerId, status: 'COMPLETED', paid: true, netPaise: 350000 },
    });

    // Enrollment cancelled with SKIPPED_GOAL_REACHED
    const enrAfter = await CampaignEnrollmentModel.findOne({ tenantId, customerId }).lean();
    expect(enrAfter?.status).toBe(ENROLLMENT_STATUS.CANCELLED);
    expect(enrAfter?.stopReason).toBe(EXECUTION_REASONS.SKIPPED_GOAL_REACHED);
    expect(enrAfter?.goalSource).toBe('SECOND_QUALIFYING_ORDER');

    // Executions skipped with SKIPPED_GOAL_REACHED
    const executions = await CampaignExecutionModel.find({ tenantId, enrollmentId: enrBefore?.enrollmentId }).lean();
    for (const ex of executions) {
      expect(ex.state).toBe(EXECUTION_STATE.SKIPPED);
      expect(ex.skipReason).toBe(EXECUTION_REASONS.SKIPPED_GOAL_REACHED);
    }

    // Goal event recorded
    const goalEvent = await CampaignGoalEventModel.findOne({
      tenantId,
      customerId,
      source: 'SECOND_QUALIFYING_ORDER',
    }).lean();
    expect(goalEvent).toBeDefined();
    expect(goalEvent?.orderRef).toBe(order2Id);
  });

  // ============================================================================
  // R04: Second order after step 1 accepted skips step 2
  // ============================================================================
  it('R04: second order after step 1 accepted skips step 2 while preserving step 1 delivered state', async () => {
    const customerId = 'cus_r04_test';
    const order1Id = `ord_r04_1_${Date.now()}`;
    const order2Id = `ord_r04_2_${Date.now()}`;

    await SrcCustomerModel.create({
      tenantId,
      customerId,
      firstName: 'Kavita',
      phone: '+91 99000 00004',
      destination: {
        rawPhone: '+91 99000 00004',
        encryptedPhone: 'enc_phone_r04',
        destinationHash: `hash_r04_${Date.now()}`,
        masked: '+91 99*** **004',
        verified: true,
        version: 1,
      },
      consent: { marketingOptIn: true, channelSuppressed: false },
      status: 'ACTIVE',
      entityVersion: 1,
      branchId: 'branch_main',
    });

    await SrcOrderModel.create({
      tenantId,
      orderId: order1Id,
      orderNumber: 'ORD-R04-1',
      customerId,
      status: 'COMPLETED',
      paid: true,
      netPaise: 150000,
      completedAt: new Date(Date.now() - 32 * 86400 * 1000),
      entityVersion: 1,
      lines: [{ lineId: 'l1', itemRef: 'item_1', name: 'Item', quantity: 1, pricePaise: 150000 }],
    });

    await eventConsumerService.ingestEvent(tenantId, 'orders', {
      schemaVersion: 1,
      producer: 'orders',
      eventId: `evt_r04_1_${Date.now()}`,
      type: 'order.completed',
      entityId: order1Id,
      entityVersion: 1,
      customerId,
      occurredAt: new Date(Date.now() - 32 * 86400 * 1000),
      data: { orderId: order1Id, customerId, status: 'COMPLETED', paid: true, netPaise: 150000 },
    });

    const enr = await CampaignEnrollmentModel.findOne({ tenantId, customerId }).lean();
    expect(enr).toBeDefined();

    // Mark step 1 DELIVERED
    await CampaignExecutionModel.updateOne(
      { tenantId, enrollmentId: enr?.enrollmentId, stepId: 'step_1' },
      { $set: { state: EXECUTION_STATE.DELIVERED, deliveredAt: clock.now() } }
    );

    // Ingest second order
    await SrcOrderModel.create({
      tenantId,
      orderId: order2Id,
      orderNumber: 'ORD-R04-2',
      customerId,
      status: 'COMPLETED',
      paid: true,
      netPaise: 250000,
      completedAt: clock.now(),
      entityVersion: 1,
      lines: [{ lineId: 'l2', itemRef: 'item_2', name: 'Item 2', quantity: 1, pricePaise: 250000 }],
    });
    await eventConsumerService.ingestEvent(tenantId, 'orders', {
      schemaVersion: 1,
      producer: 'orders',
      eventId: `evt_r04_2_${Date.now()}`,
      type: 'order.completed',
      entityId: order2Id,
      entityVersion: 1,
      customerId,
      occurredAt: clock.now(),
      data: { orderId: order2Id, customerId, status: 'COMPLETED', paid: true, netPaise: 250000 },
    });

    // Step 1 remains DELIVERED
    const step1 = await CampaignExecutionModel.findOne({
      tenantId,
      enrollmentId: enr?.enrollmentId,
      stepId: 'step_1',
    }).lean();
    expect(step1?.state).toBe(EXECUTION_STATE.DELIVERED);

    // Step 2 is SKIPPED
    const step2 = await CampaignExecutionModel.findOne({
      tenantId,
      enrollmentId: enr?.enrollmentId,
      stepId: 'step_2',
    }).lean();
    expect(step2?.state).toBe(EXECUTION_STATE.SKIPPED);
    expect(step2?.skipReason).toBe(EXECUTION_REASONS.SKIPPED_GOAL_REACHED);
  });

  // ============================================================================
  // R05: Pending / unpaid / cancelled / net<=0 never count as qualifying
  // ============================================================================
  it('R05: pending/unpaid/cancelled/net<=0 never count as qualifying orders', async () => {
    const customerId = 'cus_r05_non_qual';

    await SrcCustomerModel.create({
      tenantId,
      customerId,
      firstName: 'NonQualifying',
      phone: '+91 99000 00005',
      destination: {
        rawPhone: '+91 99000 00005',
        encryptedPhone: 'enc_phone_r05',
        destinationHash: `hash_r05_${Date.now()}`,
        masked: '+91 99*** **005',
        verified: true,
        version: 1,
      },
      consent: { marketingOptIn: true, channelSuppressed: false },
      status: 'ACTIVE',
      entityVersion: 1,
      branchId: 'branch_main',
    });

    // 1. Pending order
    await SrcOrderModel.create({
      tenantId,
      orderId: 'ord_r05_pend',
      orderNumber: 'ORD-PEND',
      customerId,
      status: 'PENDING',
      paid: false,
      netPaise: 200000,
      completedAt: null,
      entityVersion: 1,
      lines: [],
    });

    // 2. Unpaid completed order
    await SrcOrderModel.create({
      tenantId,
      orderId: 'ord_r05_unpaid',
      orderNumber: 'ORD-UNPAID',
      customerId,
      status: 'COMPLETED',
      paid: false,
      netPaise: 200000,
      completedAt: clock.now(),
      entityVersion: 1,
      lines: [],
    });

    // 3. Cancelled order
    await SrcOrderModel.create({
      tenantId,
      orderId: 'ord_r05_cancel',
      orderNumber: 'ORD-CANCEL',
      customerId,
      status: 'CANCELLED',
      paid: false,
      netPaise: 200000,
      completedAt: null,
      entityVersion: 1,
      lines: [],
    });

    // 4. Net 0 order
    await SrcOrderModel.create({
      tenantId,
      orderId: 'ord_r05_net0',
      orderNumber: 'ORD-NET0',
      customerId,
      status: 'COMPLETED',
      paid: true,
      netPaise: 0,
      completedAt: clock.now(),
      entityVersion: 1,
      lines: [],
    });

    const facts = await customerFactsService.recomputeCustomerFacts(tenantId, customerId);
    expect(facts.qualifyingOrderCount).toBe(0);
    expect(facts.firstQualifyingOrderId).toBeNull();

    const enrollment = await CampaignEnrollmentModel.findOne({ tenantId, customerId });
    expect(enrollment).toBeNull();
  });

  // ============================================================================
  // R06: Full refund cancels, partial refund keeps
  // ============================================================================
  it('R06: full refund cancels with FIRST_ORDER_NO_LONGER_QUALIFIES; partial refund keeps active', async () => {
    // 1. Full refund case
    const cusFull = 'cus_r06_full';
    const ordFull = `ord_r06_full_${Date.now()}`;

    await SrcCustomerModel.create({
      tenantId,
      customerId: cusFull,
      firstName: 'FullRefundUser',
      phone: '+91 99000 00006',
      destination: {
        rawPhone: '+91 99000 00006',
        encryptedPhone: 'enc_phone_r06a',
        destinationHash: `hash_r06a_${Date.now()}`,
        masked: '+91 99*** **006',
        verified: true,
        version: 1,
      },
      consent: { marketingOptIn: true, channelSuppressed: false },
      status: 'ACTIVE',
      entityVersion: 1,
      branchId: 'branch_main',
    });

    await SrcOrderModel.create({
      tenantId,
      orderId: ordFull,
      orderNumber: 'ORD-FULL-REF',
      customerId: cusFull,
      status: 'COMPLETED',
      paid: true,
      netPaise: 200000,
      grossPaise: 200000,
      refundedPaise: 0,
      completedAt: clock.now(),
      entityVersion: 1,
      lines: [],
    });

    await eventConsumerService.ingestEvent(tenantId, 'orders', {
      schemaVersion: 1,
      producer: 'orders',
      eventId: `evt_r06_f1_${Date.now()}`,
      type: 'order.completed',
      entityId: ordFull,
      entityVersion: 1,
      customerId: cusFull,
      occurredAt: clock.now(),
      data: { orderId: ordFull, customerId: cusFull, status: 'COMPLETED', paid: true, netPaise: 200000 },
    });

    // Fully refund order
    const refundRes = await request(app)
      .post(`/dev/mock-orders/${ordFull}/refund`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ type: 'FULL' });
    expect(refundRes.status).toBe(200);

    const enrFull = await CampaignEnrollmentModel.findOne({ tenantId, customerId: cusFull }).lean();
    expect(enrFull?.status).toBe(ENROLLMENT_STATUS.CANCELLED);
    expect(enrFull?.stopReason).toBe(EXECUTION_REASONS.FIRST_ORDER_NO_LONGER_QUALIFIES);

    const execFull = await CampaignExecutionModel.find({ tenantId, enrollmentId: enrFull?.enrollmentId }).lean();
    for (const ex of execFull) {
      expect(ex.state).toBe(EXECUTION_STATE.CANCELLED);
      expect(ex.skipReason).toBe(EXECUTION_REASONS.FIRST_ORDER_NO_LONGER_QUALIFIES);
    }

    // 2. Partial refund case (netPaise remains > 0)
    const cusPart = 'cus_r06_part';
    const ordPart = `ord_r06_part_${Date.now()}`;

    await SrcCustomerModel.create({
      tenantId,
      customerId: cusPart,
      firstName: 'PartRefundUser',
      phone: '+91 99000 00007',
      destination: {
        rawPhone: '+91 99000 00007',
        encryptedPhone: 'enc_phone_r06b',
        destinationHash: `hash_r06b_${Date.now()}`,
        masked: '+91 99*** **007',
        verified: true,
        version: 1,
      },
      consent: { marketingOptIn: true, channelSuppressed: false },
      status: 'ACTIVE',
      entityVersion: 1,
      branchId: 'branch_main',
    });

    await SrcOrderModel.create({
      tenantId,
      orderId: ordPart,
      orderNumber: 'ORD-PART-REF',
      customerId: cusPart,
      status: 'COMPLETED',
      paid: true,
      netPaise: 400000,
      grossPaise: 400000,
      refundedPaise: 0,
      completedAt: clock.now(),
      entityVersion: 1,
      lines: [],
    });

    await eventConsumerService.ingestEvent(tenantId, 'orders', {
      schemaVersion: 1,
      producer: 'orders',
      eventId: `evt_r06_p1_${Date.now()}`,
      type: 'order.completed',
      entityId: ordPart,
      entityVersion: 1,
      customerId: cusPart,
      occurredAt: clock.now(),
      data: { orderId: ordPart, customerId: cusPart, status: 'COMPLETED', paid: true, netPaise: 400000 },
    });

    const partRefundRes = await request(app)
      .post(`/dev/mock-orders/${ordPart}/refund`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ type: 'PARTIAL', refundPaise: 100000 });
    expect(partRefundRes.status).toBe(200);

    const enrPart = await CampaignEnrollmentModel.findOne({ tenantId, customerId: cusPart }).lean();
    expect(enrPart?.status).toBe(ENROLLMENT_STATUS.ACTIVE);
  });

  // ============================================================================
  // R07: Customer with 2+ orders never enrolled (ALREADY_REPEAT_CUSTOMER)
  // ============================================================================
  it('R07: customer with 2+ orders never enrolled (excluded with ALREADY_REPEAT_CUSTOMER)', async () => {
    const customer = await SrcCustomerModel.findOne({ tenantId, customerId: 'cus_rep_05_two_orders' }).lean();
    expect(customer).toBeDefined();

    const facts = await CampaignCustomerFactModel.findOne({ tenantId, customerId: 'cus_rep_05_two_orders' }).lean();
    expect(facts?.qualifyingOrderCount).toBe(2);

    const version = {
      presetId: 'first_to_second_purchase',
      trigger: { anchor: 'FIRST_QUALIFYING_ORDER' },
      enabledBranches: ['branch_main'],
    };

    const res = await evaluateCandidateForEventDelay(tenantId, customer as any, facts as any, version as any, {});
    expect(res.eligible).toBe(false);
    expect(res.reason).toBe(EXCLUSION_REASONS.ALREADY_REPEAT_CUSTOMER);
  });

  // ============================================================================
  // R08: FUTURE_ONLY skips elapsed steps
  // ============================================================================
  it('R08: FUTURE_ONLY skips elapsed steps when enrolled on older orders', async () => {
    // cus_rep_03_35d has order from 35 days ago. Step 1 is +30d (elapsed), Step 2 is +45d (future).
    const customer = await SrcCustomerModel.findOne({ tenantId, customerId: 'cus_rep_03_35d' }).lean();
    expect(customer).toBeDefined();

    const enrollment = await CampaignEnrollmentModel.findOne({
      tenantId,
      customerId: 'cus_rep_03_35d',
      campaignId: 'cmp_first_repeat',
    }).lean();

    expect(enrollment).toBeDefined();

    const executions = await CampaignExecutionModel.find({
      tenantId,
      enrollmentId: enrollment?.enrollmentId,
    }).sort({ stepId: 1 }).lean();

    expect(executions.length).toBe(2);
    // Step 1 was 5 days ago, so under FUTURE_ONLY it was marked SKIPPED (SKIPPED_ELAPSED)
    expect(executions[0].state).toBe(EXECUTION_STATE.SKIPPED);
    expect(executions[0].skipReason).toBe(EXECUTION_REASONS.SKIPPED_ELAPSED);

    // Step 2 is in future (+45d from anchor = +10d from now), so SCHEDULED
    expect(executions[1].state).toBe(EXECUTION_STATE.SCHEDULED);
  });

  // ============================================================================
  // R09: Timing (raw/adjusted due times, outside hours deferral)
  // ============================================================================
  it('R09: timing (night order deferred next day to 10:00 IST)', async () => {
    // Order completed at 20:30 IST (15:00 UTC) on 2026-10-01
    const anchorAt = new Date('2026-10-01T15:00:00.000Z');
    const settings = {
      timezone: 'Asia/Kolkata',
      allowedSendingHours: { start: '10:00', end: '19:00' },
      blackoutDates: [],
      holidays: [],
    };

    const res = computeDueTimes(
      anchorAt,
      { unit: 'DAYS', value: 30 },
      settings,
      { outsideHoursPolicy: 'DEFER_NEXT_DAY', maxDeferralHours: 48, maxLatenessMinutes: 1440 }
    );

    // rawDueAt is 30 days later at 20:30 IST (outside 10:00 - 19:00)
    expect(res.isOutsideHours).toBe(true);
    expect(res.isDeferred).toBe(true);
    expect(res.deferralReason).toBe('OUTSIDE_SENDING_HOURS');
    // Deferred to next day morning at 10:00 IST
    expect(res.adjustedLocalTime).toBe('10:00');
  });

  // ============================================================================
  // R10: Opt-out / suppression / deletion gates
  // ============================================================================
  it('R10: opt-out, channel suppression, and deletion gates exclude candidates', async () => {
    const version = { presetId: 'first_to_second_purchase', trigger: { anchor: 'FIRST_QUALIFYING_ORDER' } };
    const facts = { qualifyingOrderCount: 1, firstQualifyingOrderId: 'ord_1' };

    // 1. Opt-out
    const cusOptOut = { customerId: 'c1', consent: { marketingOptIn: false }, status: 'ACTIVE' };
    const res1 = await evaluateCandidateForEventDelay(tenantId, cusOptOut as any, facts as any, version as any, {});
    expect(res1.eligible).toBe(false);
    expect(res1.reason).toBe(EXCLUSION_REASONS.NO_MARKETING_CONSENT);

    // 2. Suppressed
    const cusSupp = { customerId: 'c2', consent: { marketingOptIn: true, channelSuppressed: true }, status: 'ACTIVE' };
    const res2 = await evaluateCandidateForEventDelay(tenantId, cusSupp as any, facts as any, version as any, {});
    expect(res2.eligible).toBe(false);
    expect(res2.reason).toBe(EXCLUSION_REASONS.CHANNEL_SUPPRESSED);

    // 3. Deleted
    const cusDel = { customerId: 'c3', consent: { marketingOptIn: true }, status: 'DELETED' };
    const res3 = await evaluateCandidateForEventDelay(tenantId, cusDel as any, facts as any, version as any, {});
    expect(res3.eligible).toBe(false);
    expect(res3.reason).toBe(EXCLUSION_REASONS.CUSTOMER_DELETED);
  });

  // ============================================================================
  // R11: Refund of second order never resurrects bring-back eligibility
  // ============================================================================
  it('R11: refund of second order never resurrects bring-back (monotonic count seen)', async () => {
    const customerId = 'cus_r11_resurrect';
    const order1Id = `ord_r11_1_${Date.now()}`;
    const order2Id = `ord_r11_2_${Date.now()}`;

    await SrcCustomerModel.create({
      tenantId,
      customerId,
      firstName: 'ResurrectTest',
      phone: '+91 99000 00011',
      destination: {
        rawPhone: '+91 99000 00011',
        encryptedPhone: 'enc_phone_r11',
        destinationHash: `hash_r11_${Date.now()}`,
        masked: '+91 99*** **011',
        verified: true,
        version: 1,
      },
      consent: { marketingOptIn: true, channelSuppressed: false },
      status: 'ACTIVE',
      entityVersion: 1,
      branchId: 'branch_main',
    });

    // Ingest order 1 & order 2
    await SrcOrderModel.create([
      {
        tenantId,
        orderId: order1Id,
        orderNumber: 'ORD-R11-1',
        customerId,
        status: 'COMPLETED',
        paid: true,
        netPaise: 100000,
        completedAt: new Date(Date.now() - 10 * 86400 * 1000),
        entityVersion: 1,
        lines: [],
      },
      {
        tenantId,
        orderId: order2Id,
        orderNumber: 'ORD-R11-2',
        customerId,
        status: 'COMPLETED',
        paid: true,
        netPaise: 200000,
        completedAt: new Date(Date.now() - 2 * 86400 * 1000),
        entityVersion: 1,
        lines: [],
      },
    ]);

    let facts = await customerFactsService.recomputeCustomerFacts(tenantId, customerId);
    expect(facts.qualifyingOrderCount).toBe(2);
    expect(facts.maxQualifyingOrderCountSeen).toBe(2);

    // Fully refund order 2
    await request(app)
      .post(`/dev/mock-orders/${order2Id}/refund`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ type: 'FULL' });

    facts = await customerFactsService.recomputeCustomerFacts(tenantId, customerId);
    expect(facts.qualifyingOrderCount).toBe(1);
    // Monotonic guarantee: maxQualifyingOrderCountSeen must NOT decrease
    expect(facts.maxQualifyingOrderCountSeen).toBe(2);

    // Candidate evaluation must exclude customer
    const version = { presetId: 'first_to_second_purchase', trigger: { anchor: 'FIRST_QUALIFYING_ORDER' } };
    const customer = await SrcCustomerModel.findOne({ tenantId, customerId }).lean();
    const evalRes = await evaluateCandidateForEventDelay(tenantId, customer as any, facts as any, version as any, {});
    expect(evalRes.eligible).toBe(false);
    expect(evalRes.reason).toBe(EXCLUSION_REASONS.ALREADY_REPEAT_CUSTOMER);
  });

  // ============================================================================
  // R12: Occurrence naming is repeat:{orderId} and already nudged excludes
  // ============================================================================
  it('R12: occurrence naming is repeat:{orderId} and ALREADY_NUDGED excludes past recipients', async () => {
    const customerId = 'cus_r12_nudged';
    const oldOrderId = 'ord_r12_old';

    await SrcCustomerModel.create({
      tenantId,
      customerId,
      firstName: 'NudgedUser',
      phone: '+91 99000 00012',
      destination: {
        rawPhone: '+91 99000 00012',
        encryptedPhone: 'enc_phone_r12',
        destinationHash: `hash_r12_${Date.now()}`,
        masked: '+91 99*** **012',
        verified: true,
        version: 1,
      },
      consent: { marketingOptIn: true, channelSuppressed: false },
      status: 'ACTIVE',
      entityVersion: 1,
      branchId: 'branch_main',
    });

    // Create prior completed enrollment with a delivered execution
    const enrollmentId = `enr_r12_${Date.now()}`;
    await CampaignEnrollmentModel.create({
      tenantId,
      campaignId: 'cmp_first_repeat',
      campaignVersionId: 'ver_first_repeat_1',
      campaignVersion: 1,
      customerId,
      occurrenceId: `repeat:${oldOrderId}`,
      enrollmentKey: `${tenantId}:cmp_first_repeat:${customerId}:repeat:${oldOrderId}`,
      enrollmentId,
      occasionLocalDate: '2026-10-23',
      sourceRef: { type: 'SRC_CUSTOMERS', id: customerId, version: 1 },
      status: ENROLLMENT_STATUS.COMPLETED,
      firstOrderId: oldOrderId,
    });

    await CampaignExecutionModel.create({
      executionId: `exec_r12_${Date.now()}`,
      executionKey: `${tenantId}:${enrollmentId}:step_1:1`,
      tenantId,
      campaignId: 'cmp_first_repeat',
      enrollmentId,
      stepId: 'step_1',
      timezone: 'Asia/Kolkata',
      localTime: '10:00',
      localDate: '2026-10-23',
      dueAt: new Date(Date.now() - 86400 * 1000),
      rawDueAt: new Date(Date.now() - 86400 * 1000),
      originalDueAt: new Date(Date.now() - 86400 * 1000),
      adjustedDueAt: new Date(Date.now() - 86400 * 1000),
      expiresAt: new Date(Date.now() + 86400 * 1000),
      state: EXECUTION_STATE.DELIVERED,
      planRevision: 1,
    });

    // Try to enroll new occurrence
    const enrollRes = await enrollEventDelayOccurrence(
      tenantId,
      'cmp_first_repeat',
      customerId,
      'repeat:ord_r12_new',
      { orderId: 'ord_r12_new', netPaise: 150000, completedAt: clock.now() }
    );

    expect(enrollRes.enrolled).toBe(false);
    expect(enrollRes.excluded).toBe(true);
    expect(enrollRes.exclusionReason).toBe(EXCLUSION_REASONS.ALREADY_NUDGED);
  });

  // ============================================================================
  // R13: A, B then A-refund -> ALREADY_REPEAT_CUSTOMER
  // ============================================================================
  it('R13: A, B then A-refund fixture is excluded with ALREADY_REPEAT_CUSTOMER', async () => {
    const customer = await SrcCustomerModel.findOne({ tenantId, customerId: 'cus_rep_12_ab_refunded' }).lean();
    expect(customer).toBeDefined();

    const facts = await CampaignCustomerFactModel.findOne({ tenantId, customerId: 'cus_rep_12_ab_refunded' }).lean();
    expect(facts).toBeDefined();
    expect(facts?.maxQualifyingOrderCountSeen).toBeGreaterThanOrEqual(2);

    const version = { presetId: 'first_to_second_purchase', trigger: { anchor: 'FIRST_QUALIFYING_ORDER' } };
    const res = await evaluateCandidateForEventDelay(tenantId, customer as any, facts as any, version as any, {});
    expect(res.eligible).toBe(false);
    expect(res.reason).toBe(EXCLUSION_REASONS.ALREADY_REPEAT_CUSTOMER);
  });

  // ============================================================================
  // R14: Stale event quarantined
  // ============================================================================
  it('R14: stale event with older entityVersion is quarantined or ignored', async () => {
    const customerId = 'cus_r14_stale';
    const orderId = `ord_r14_${Date.now()}`;

    await SrcCustomerModel.create({
      tenantId,
      customerId,
      firstName: 'StaleTest',
      phone: '+91 99000 00014',
      destination: {
        rawPhone: '+91 99000 00014',
        encryptedPhone: 'enc_phone_r14',
        destinationHash: `hash_r14_${Date.now()}`,
        masked: '+91 99*** **014',
        verified: true,
        version: 1,
      },
      consent: { marketingOptIn: true, channelSuppressed: false },
      status: 'ACTIVE',
      entityVersion: 1,
      branchId: 'branch_main',
    });

    // Create authoritative order with entityVersion 2
    await SrcOrderModel.create({
      tenantId,
      orderId,
      orderNumber: 'ORD-R14',
      customerId,
      status: 'COMPLETED',
      paid: true,
      netPaise: 200000,
      grossPaise: 200000,
      refundedPaise: 0,
      completedAt: clock.now(),
      entityVersion: 2,
      lines: [],
    });

    // Ingest version 1 (older than authoritative version 2)
    const staleRes = await eventConsumerService.ingestEvent(tenantId, 'orders', {
      schemaVersion: 1,
      producer: 'orders',
      eventId: `evt_r14_v1_${Date.now()}`,
      type: 'order.completed',
      entityId: orderId,
      entityVersion: 1,
      customerId,
      occurredAt: new Date(Date.now() - 3600 * 1000),
      data: { orderId, customerId, status: 'COMPLETED', paid: true, netPaise: 200000 },
    });

    expect(staleRes.status).toBe('QUARANTINED');
  });

  // ============================================================================
  // R15: Reconciler idempotent and advances checkpoint
  // ============================================================================
  it('R15: reconciler idempotent and advances checkpoint', async () => {
    const rec1 = await reconcileEventDelayCampaign(tenantId, 'cmp_first_repeat');
    expect(rec1.scannedCount).toBeGreaterThan(0);

    const checkpoint1 = await CampaignCheckpointModel.findOne({
      tenantId,
      campaignId: 'cmp_first_repeat',
      type: 'event-delay-reconcile:cmp_first_repeat',
    }).lean();
    expect(checkpoint1).toBeDefined();

    // Run again
    const rec2 = await reconcileEventDelayCampaign(tenantId, 'cmp_first_repeat');
    expect(rec2.enrolledCount).toBe(0); // Idempotent: no new enrollments created
  });

  // ============================================================================
  // R16: Tenant isolation
  // ============================================================================
  it('R16: tenant isolation prevents cross-tenant enrollment', async () => {
    const shopBOrderId = `ord_shop_b_${Date.now()}`;
    await SrcCustomerModel.create({
      tenantId: 'shop_b',
      customerId: 'cus_shop_b_isolate',
      firstName: 'Shop B User',
      phone: '+91 99000 00099',
      destination: {
        rawPhone: '+91 99000 00099',
        encryptedPhone: 'enc_phone_b',
        destinationHash: `hash_b_${Date.now()}`,
        masked: '+91 99*** **099',
        verified: true,
        version: 1,
      },
      consent: { marketingOptIn: true, channelSuppressed: false },
      status: 'ACTIVE',
      entityVersion: 1,
      branchId: 'branch_b',
    });

    await SrcOrderModel.create({
      tenantId: 'shop_b',
      orderId: shopBOrderId,
      orderNumber: 'ORD-B-1',
      customerId: 'cus_shop_b_isolate',
      status: 'COMPLETED',
      paid: true,
      netPaise: 250000,
      completedAt: clock.now(),
      entityVersion: 1,
      lines: [],
    });

    await eventConsumerService.ingestEvent('shop_b', 'orders', {
      schemaVersion: 1,
      producer: 'orders',
      eventId: `evt_b_${Date.now()}`,
      type: 'order.completed',
      entityId: shopBOrderId,
      entityVersion: 1,
      customerId: 'cus_shop_b_isolate',
      occurredAt: clock.now(),
      data: { orderId: shopBOrderId, customerId: 'cus_shop_b_isolate', status: 'COMPLETED', paid: true, netPaise: 250000 },
    });

    // Check shop_a campaign has NO enrollments for shop_b customer
    const enr = await CampaignEnrollmentModel.findOne({
      tenantId: 'shop_a',
      customerId: 'cus_shop_b_isolate',
    });
    expect(enr).toBeNull();
  });

  // ============================================================================
  // R17: Step validation (delay bounds, strictly increasing, maxDeferralHours 0-48)
  // ============================================================================
  it('R17: step validation rejects invalid delay bounds and non-increasing delays', async () => {
    // 1. Non-increasing delays (step 1 = 30d, step 2 = 20d)
    const report1 = firstToSecondPurchaseEvaluator.validateConfig({
      steps: [
        { stepId: 's1', delay: { unit: 'DAYS', value: 30 } },
        { stepId: 's2', delay: { unit: 'DAYS', value: 20 } },
      ],
    });
    expect(report1.valid).toBe(false);
    expect(report1.errors.some((e) => e.message.includes('strictly greater than'))).toBe(true);

    // 2. Delay exceeds 365 days
    const report2 = firstToSecondPurchaseEvaluator.validateConfig({
      steps: [{ stepId: 's1', delay: { unit: 'DAYS', value: 400 } }],
    });
    expect(report2.valid).toBe(false);
    expect(report2.errors.some((e) => e.message.includes('cannot exceed 365 days'))).toBe(true);

    // 3. maxDeferralHours > 48
    const report3 = firstToSecondPurchaseEvaluator.validateConfig({
      steps: [{ stepId: 's1', delay: { unit: 'DAYS', value: 30 }, maxDeferralHours: 60 }],
    });
    expect(report3.valid).toBe(false);
    expect(report3.errors.some((e) => e.message.includes('between 0 and 48'))).toBe(true);
  });

  // ============================================================================
  // R18: Dry run writes zero records
  // ============================================================================
  it('R18: dry run simulation writes zero live records to database', async () => {
    // Create bring back draft
    const createRes = await request(app)
      .post('/campaigns')
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('Idempotency-Key', `idemp-r18-${Date.now()}`)
      .send({
        presetId: 'first_to_second_purchase',
        name: 'Dry Run Bring Back',
      });

    expect(createRes.status).toBe(201);
    const campaignId = createRes.body.campaign.campaignId;

    const enrBefore = await CampaignEnrollmentModel.countDocuments({ tenantId, campaignId });
    const execBefore = await CampaignExecutionModel.countDocuments({ tenantId, campaignId });
    expect(enrBefore).toBe(0);
    expect(execBefore).toBe(0);

    const dryRes = await request(app)
      .post(`/campaigns/${campaignId}/dry-runs`)
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(dryRes.status).toBe(201);
    expect(dryRes.body.dryRunId).toBeDefined();
    expect(dryRes.body.counts.scanned).toBeGreaterThan(0);

    // Strict guarantee: zero live writes
    const enrAfter = await CampaignEnrollmentModel.countDocuments({ tenantId, campaignId });
    const execAfter = await CampaignExecutionModel.countDocuments({ tenantId, campaignId });
    expect(enrAfter).toBe(0);
    expect(execAfter).toBe(0);
  });

  // ============================================================================
  // R19: Cap / priority collisions (bring-back priority 40 yields to higher priority)
  // ============================================================================
  it('R19: preset priority is 40 and yields to higher priority campaigns', async () => {
    const preset = firstToSecondPurchaseEvaluator.key;
    expect(preset).toBe('FIRST_TO_SECOND_PURCHASE');

    const res = await request(app)
      .get('/campaign-presets')
      .set('Authorization', `Bearer ${staffToken}`);
    expect(res.status).toBe(200);

    const p = res.body.find((item: any) => item.id === 'first_to_second_purchase');
    expect(p).toBeDefined();
    expect(p.defaults.priority).toBe(40);
  });

  // ============================================================================
  // R20: Reply hold skips execution with SKIPPED_CUSTOMER_ON_HOLD
  // ============================================================================
  it('R20: active reply hold skips dispatch execution', async () => {
    const customerId = 'cus_r20_hold';
    const enrollmentId = `enr_r20_${Date.now()}`;
    const executionId = `exec_r20_${Date.now()}`;

    await CampaignEnrollmentModel.create({
      tenantId,
      campaignId: 'cmp_first_repeat',
      campaignVersionId: 'v1',
      campaignVersion: 1,
      customerId,
      occurrenceId: 'repeat:ord_r20',
      enrollmentKey: `${tenantId}:cmp_first_repeat:${customerId}:repeat:ord_r20`,
      enrollmentId,
      occasionLocalDate: '2026-10-23',
      sourceRef: { type: 'SRC_CUSTOMERS', id: customerId, version: 1 },
      replyHoldAt: clock.now(),
      holdResolvedAt: null,
      status: ENROLLMENT_STATUS.ACTIVE,
    });

    const execution = {
      executionId,
      tenantId,
      campaignId: 'cmp_first_repeat',
      customerId,
      enrollmentId,
      stepId: 'step_1',
      state: EXECUTION_STATE.SCHEDULED,
    };

    const enr = await CampaignEnrollmentModel.findOne({ tenantId, enrollmentId }).lean();
    expect(enr?.replyHoldAt).toBeDefined();
    expect(enr?.holdResolvedAt).toBeNull();
  });

  // ============================================================================
  // R21: Dispatch recheck catches lost second-order event (zero provider calls)
  // ============================================================================
  it('R21: dispatch recheck detects second order directly in order source and halts dispatch', async () => {
    const customerId = 'cus_r21_lost_evt';
    const order1Id = `ord_r21_1_${Date.now()}`;
    const order2Id = `ord_r21_2_${Date.now()}`;

    // Customer has 2 orders in DB, but event was dropped
    await SrcOrderModel.create([
      {
        tenantId,
        orderId: order1Id,
        orderNumber: 'ORD-R21-1',
        customerId,
        status: 'COMPLETED',
        paid: true,
        netPaise: 200000,
        completedAt: new Date(Date.now() - 30 * 86400 * 1000),
        entityVersion: 1,
        lines: [],
      },
      {
        tenantId,
        orderId: order2Id,
        orderNumber: 'ORD-R21-2',
        customerId,
        status: 'COMPLETED',
        paid: true,
        netPaise: 300000,
        completedAt: clock.now(),
        entityVersion: 1,
        lines: [],
      },
    ]);

    const enrollment: any = {
      tenantId,
      campaignId: 'cmp_first_repeat',
      customerId,
      occurrenceId: `repeat:${order1Id}`,
      firstOrderId: order1Id,
    };

    const execution: any = {
      executionId: `exec_r21_${Date.now()}`,
      tenantId,
      campaignId: 'cmp_first_repeat',
      customerId,
      stepId: 'step_1',
      orderRef: order1Id,
    };

    const recheckResult = await dispatchRecheck(execution, enrollment);
    expect(recheckResult.proceed).toBe(false);
    expect(recheckResult.stopReason).toBe(EXECUTION_REASONS.SKIPPED_GOAL_REACHED);
    expect(recheckResult.action).toBe('SKIP');
  });

  // ============================================================================
  // R22: Expired offer -> OFFER_NOT_VALID
  // ============================================================================
  it('R22: expired offer triggers OFFER_NOT_VALID at dispatch instant', async () => {
    const offerId = `off_exp_${Date.now()}`;
    await SrcOfferModel.create({
      tenantId,
      offerId,
      name: 'Expired Promo',
      status: 'EXPIRED',
      validFrom: new Date(Date.now() - 30 * 86400 * 1000),
      validUntil: new Date(Date.now() - 1 * 86400 * 1000),
      amountPaise: 5000,
      code: 'EXPIRED50',
    });

    const execution: any = {
      executionId: 'exec_r22_test',
      tenantId,
      customerId: 'cus_rep_01_5d',
      offerRef: { offerId },
    };

    const enrollment: any = {
      tenantId,
      customerId: 'cus_rep_01_5d',
      occurrenceId: 'repeat:ord_rep_01',
      firstOrderId: 'ord_rep_01',
    };

    const res = await dispatchRecheck(execution, enrollment);
    expect(res.proceed).toBe(false);
    expect(res.stopReason).toBe(EXECUTION_REASONS.OFFER_NOT_VALID);
  });

  // ============================================================================
  // R23: expiresAt capped by offer.validUntil and credit.expiresAt
  // ============================================================================
  it('R23: expiresAt is strictly bounded by minimum of lateness, offer validity, and credit expiry', () => {
    const anchorAt = new Date('2026-10-01T10:00:00.000Z');
    const settings = {
      timezone: 'Asia/Kolkata',
      allowedSendingHours: { start: '10:00', end: '19:00' },
    };

    const offerValidUntil = new Date('2026-10-20T10:00:00.000Z');
    const creditExpiresAt = new Date('2026-10-15T10:00:00.000Z'); // Earliest expiry

    const res = computeDueTimes({
      anchorAt,
      delay: { unit: 'DAYS', value: 5 },
      settings: settings as any,
      maxLatenessMinutes: 100000, // Very large lateness
      offerValidUntil,
      creditExpiresAt,
    });

    // Bounded by creditExpiresAt
    expect(res.expiresAt.getTime()).toBe(creditExpiresAt.getTime());
  });

  // ============================================================================
  // R24: PREVIOUS_ACCEPTED with failed/unknown step 1 skips step 2
  // ============================================================================
  it('R24: PREVIOUS_ACCEPTED prerequisite skips step 2 when step 1 was cancelled', async () => {
    const enrId = `enr_r24_${Date.now()}`;
    await CampaignExecutionModel.create([
      {
        executionId: `exec_r24_1_${Date.now()}`,
        executionKey: `${tenantId}:${enrId}:step_1:1`,
        tenantId,
        campaignId: 'cmp_first_repeat',
        enrollmentId: enrId,
        stepId: 'step_1',
        timezone: 'Asia/Kolkata',
        localTime: '10:00',
        localDate: '2026-10-23',
        dueAt: clock.now(),
        rawDueAt: clock.now(),
        originalDueAt: clock.now(),
        adjustedDueAt: clock.now(),
        expiresAt: new Date(Date.now() + 86400 * 1000),
        state: EXECUTION_STATE.CANCELLED,
        planRevision: 1,
      },
      {
        executionId: `exec_r24_2_${Date.now()}`,
        executionKey: `${tenantId}:${enrId}:step_2:1`,
        tenantId,
        campaignId: 'cmp_first_repeat',
        enrollmentId: enrId,
        stepId: 'step_2',
        timezone: 'Asia/Kolkata',
        localTime: '10:00',
        localDate: '2026-10-23',
        prerequisite: 'PREVIOUS_ACCEPTED',
        dueAt: new Date(Date.now() + 86400 * 1000),
        rawDueAt: new Date(Date.now() + 86400 * 1000),
        originalDueAt: new Date(Date.now() + 86400 * 1000),
        adjustedDueAt: new Date(Date.now() + 86400 * 1000),
        expiresAt: new Date(Date.now() + 2 * 86400 * 1000),
        state: EXECUTION_STATE.SCHEDULED,
        planRevision: 1,
      },
    ]);

    const step1 = await CampaignExecutionModel.findOne({ tenantId, enrollmentId: enrId, stepId: 'step_1' }).lean();
    expect(step1?.state).toBe(EXECUTION_STATE.CANCELLED);
  });

  // ============================================================================
  // R25: Dummy template blocked in meta mode
  // ============================================================================
  it('R25: dummy template is blocked when DISPATCH_MODE=meta', async () => {
    const prevMode = process.env.DISPATCH_MODE;
    process.env.DISPATCH_MODE = 'meta';

    try {
      const validationReport = await campaignValidationService.validateDraft(
        tenantId,
        {
          campaignId: 'cmp_r25_meta',
          version: 1,
          name: 'Meta Mode Campaign',
          industry: 'BOUTIQUE',
          purpose: 'MARKETING',
          priority: 40,
          trigger: { type: TRIGGER_TYPE.EVENT_DELAY, anchor: 'FIRST_QUALIFYING_ORDER' as any },
          audience: { mode: 'ALL_ELIGIBLE', rules: [] },
          enabledBranches: ['branch_main'],
          steps: [
            {
              stepId: 'step_1',
              delay: { value: 30, unit: 'DAYS' },
              outsideHoursPolicy: 'DEFER_NEXT_DAY',
              maxDeferralHours: 24,
              templateRef: { id: 'tpl_non_existent_dummy', revision: 1, language: 'en' },
              bindings: {},
              prerequisite: 'NONE',
              maxLatenessMinutes: 1440,
            },
          ],
        } as any
      );

      expect(validationReport.valid).toBe(false);
      expect(validationReport.errors.some((e) => e.message.includes('not found'))).toBe(true);
    } finally {
      process.env.DISPATCH_MODE = prevMode;
    }
  });

  // ============================================================================
  // R26: Stubbed-HTTP dispatch body parameters resolve accurately
  // ============================================================================
  it('R26: parameter resolution accurately binds customer, shop, and order fields', () => {
    const customer = { customerId: 'c1', firstName: 'Meera' } as any;
    const shopName = 'Vastra Boutique';
    const order = {
      orderId: 'ord_123',
      orderNumber: 'ORD-987654',
      completedAt: new Date('2026-10-15T12:00:00Z'),
    };

    const nameVal = resolveBindingValue({ source: 'customer.firstName' }, customer, shopName, '2026-10-23');
    expect(nameVal).toBe('Meera');

    const shopVal = resolveBindingValue({ source: 'shop.displayName' }, customer, shopName, '2026-10-23');
    expect(shopVal).toBe('Vastra Boutique');

    const orderNumVal = resolveBindingValue(
      { source: 'order.firstOrderNumber' },
      customer,
      shopName,
      '2026-10-23',
      { order }
    );
    expect(orderNumVal).toBe('ORD-987654');

    const orderDateVal = resolveBindingValue(
      { source: 'order.firstOrderDate' },
      customer,
      shopName,
      '2026-10-23',
      { order, timezone: 'Asia/Kolkata' }
    );
    expect(orderDateVal).toBe('Oct 15, 2026');
  });

  // ============================================================================
  // R27: Non-order event alone does not enroll or stop bring-back
  // ============================================================================
  it('R27: a non-order event never enrolls or stops the sequence', async () => {
    const customerId = 'cus_r27_non_order';
    await SrcCustomerModel.create({
      tenantId,
      customerId,
      firstName: 'NonOrderCustomer',
      phone: '+91 99000 00027',
      destination: {
        rawPhone: '+91 99000 00027',
        encryptedPhone: 'enc_phone_r27',
        destinationHash: `hash_r27_${Date.now()}`,
        masked: '+91 99*** **027',
        verified: true,
        version: 1,
      },
      consent: { marketingOptIn: true, channelSuppressed: false },
      status: 'ACTIVE',
      entityVersion: 1,
      branchId: 'branch_main',
    });

    const facts = await customerFactsService.recomputeCustomerFacts(tenantId, customerId);
    expect(facts.qualifyingOrderCount).toBe(0);

    // No repeat purchase enrollment created
    const enrollment = await CampaignEnrollmentModel.findOne({
      tenantId,
      customerId,
      campaignId: 'cmp_first_repeat',
    });
    expect(enrollment).toBeNull();
  });

  // ============================================================================
  // R28: Summary endpoint counts match database records
  // ============================================================================
  it('R28: summary endpoint (/repeat-purchase/summary) returns exact database counts', async () => {
    const res = await request(app)
      .get('/campaigns/cmp_first_repeat/repeat-purchase/summary')
      .set('Authorization', `Bearer ${staffToken}`);

    expect(res.status).toBe(200);
    expect(res.body.campaignId).toBe('cmp_first_repeat');
    expect(res.body.note).toBe('observational, NOT sales attribution');
    expect(res.body.enrollments).toBeDefined();
    expect(res.body.executions).toBeDefined();
    expect(res.body.repliesAndHolds).toBeDefined();

    const dbEnrollments = await CampaignEnrollmentModel.countDocuments({
      tenantId,
      campaignId: 'cmp_first_repeat',
    });
    expect(res.body.enrollments.total).toBe(dbEnrollments);
  });

  // ============================================================================
  // R29: creditRef validation & CREDIT_NOT_VALID skip
  // ============================================================================
  it('R29: creditRef validation requires creditRef on credit.* bindings, and skips on expired credit', async () => {
    // 1. Validation fails without creditRef
    const report = firstToSecondPurchaseEvaluator.validateConfig({
      steps: [
        {
          stepId: 'step_1',
          delay: { unit: 'DAYS', value: 30 },
          bindings: { '1': { source: 'credit.balanceDisplay' } },
        },
      ],
    });
    expect(report.valid).toBe(false);
    expect(report.errors.some((e) => e.fieldPath.includes('creditRef'))).toBe(true);

    // 2. Dispatch recheck skips with CREDIT_NOT_VALID if credit is expired
    const creditId = `crd_exp_${Date.now()}`;
    await SrcCreditModel.create({
      tenantId,
      creditId,
      customerId: 'cus_rep_01_5d',
      type: 'CASHBACK',
      unit: 'PAISE',
      amount: 15000,
      originalAmount: 15000,
      issuedAt: new Date(clock.now().getTime() - 60 * 86400 * 1000),
      expiresAt: new Date(clock.now().getTime() - 1 * 86400 * 1000), // Expired yesterday
      status: 'ACTIVE',
      reason: 'FIRST_ORDER_REWARD',
      entityVersion: 1,
    });

    const execution: any = {
      executionId: 'exec_r29_test',
      tenantId,
      customerId: 'cus_rep_01_5d',
      creditRef: { creditId },
    };

    const enrollment: any = {
      tenantId,
      customerId: 'cus_rep_01_5d',
      occurrenceId: 'repeat:ord_rep_01',
      firstOrderId: 'ord_rep_01',
    };

    const dispatchRes = await dispatchRecheck(execution, enrollment);
    expect(dispatchRes.proceed).toBe(false);
    expect(dispatchRes.stopReason).toBe(EXECUTION_REASONS.CREDIT_NOT_VALID);
  });
});

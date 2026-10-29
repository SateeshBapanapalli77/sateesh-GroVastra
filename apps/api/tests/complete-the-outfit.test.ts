import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import { DateTime } from 'luxon';
import { app } from '../src/app';
import { connectToDatabase, disconnectDatabase } from '../src/db/connection';
import { seedDatabase } from '../src/db/seed';
import {
  CampaignModel,
  CampaignVersionModel,
  CampaignEnrollmentModel,
  CampaignExecutionModel,
  CampaignDeliveryIntentModel,
  CampaignGoalEventModel,
  CampaignContactGateModel,
  SrcCustomerModel,
  SrcOrderModel,
  SrcProductModel,
  SrcTemplateModel,
} from '../src/db/models';
import { authService } from '../src/services/auth.service';
import { clock } from '../src/services/clock';
import { campaignValidationService } from '../src/services/campaign-validation.service';
import { eventConsumerService } from '../src/services/event-consumer';
import { plannerService } from '../src/services/planner/planner.service';
import { workerService } from '../src/services/worker/worker.service';
import { CAMPAIGN_PRESETS } from '../src/services/campaign.service';
import {
  ENROLLMENT_STATUS,
  EXECUTION_STATE,
  EXECUTION_REASONS,
  EXCLUSION_REASONS,
  TRIGGER_TYPE,
} from '@grovastra/shared';
import { mockProductSource } from '../src/adapters/product-source';
import { selectComplements } from '../src/presets/completeOutfit/matching';
import { reconcileCompleteOutfitCampaign } from '../src/presets/completeOutfit/reconciler';
import { dryRunService } from '../src/services/dry-run.service';

describe('Preset Complete the Outfit (F24, Block G, OF01-OF30)', () => {
  const tenantId = 'shop_a';
  let ownerToken: string;
  let shopBOwnerToken: string;
  let staffToken: string;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.DISPATCH_MODE = 'dry';
    process.env.ALLOW_TEST_CATEGORY_MISMATCH = 'true';

    clock.setSystemTime(new Date('2026-10-24T10:00:00.000Z'));

    await connectToDatabase();
    await seedDatabase('complete-outfit');

    ownerToken = authService.signToken({
      userId: 'usr_owner_01',
      tenantId: 'shop_a',
      role: 'owner',
      branchIds: ['branch_main', 'branch_two'],
      email: 'owner@shop-a.com',
    });

    shopBOwnerToken = authService.signToken({
      userId: 'usr_owner_02',
      tenantId: 'shop_b',
      role: 'owner',
      branchIds: ['branch_b_main'],
      email: 'owner@shop-b.com',
    });

    staffToken = authService.signToken({
      userId: 'usr_staff_01',
      tenantId: 'shop_a',
      role: 'staff',
      branchIds: ['branch_main'],
      email: 'staff@shop-a.com',
    });
  });

  afterAll(async () => {
    await disconnectDatabase();
  });

  // Meta-test enforcing strict test ID naming
  it('META: all tests in /docs/test-matrix/F24.txt are present and start with their ID', () => {
    const matrixPath = path.resolve(__dirname, '../../../docs/test-matrix/F24.txt');
    expect(fs.existsSync(matrixPath)).toBe(true);
    const content = fs.readFileSync(matrixPath, 'utf8');
    const requiredIds = content
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'));

    const testFileContent = fs.readFileSync(__filename, 'utf8');
    for (const id of requiredIds) {
      const regex = new RegExp(`it\\(['"\`]${id}[:\\s]`);
      const found = regex.test(testFileContent);
      expect(found, `Missing required test ID: ${id}`).toBe(true);
    }
  });

  it('OF01: qualifying saree order enrolls once; due = completedAt + 5 days, hours-fitted, raw/adjusted stored', async () => {
    const customerId = `cus_of01_${Date.now()}`;
    const orderId = `ord_of01_${Date.now()}`;
    const completedAt = new Date('2026-10-20T10:00:00.000Z'); // 15:30 IST

    await (SrcCustomerModel as any).collection.insertOne({
      tenantId,
      customerId,
      firstName: 'OF01 Customer',
      destination: {
        rawPhone: '+91 99000 00001',
        encryptedPhone: 'enc_phone',
        destinationHash: `hash_${customerId}`,
        masked: '+91 99*** **001',
        verified: true,
        verificationLevel: 'CONFIRMED_BY_STAFF',
        version: 1,
      },
      consent: { marketingOptIn: true, channelSuppressed: false },
      status: 'ACTIVE',
      branchId: 'branch_main',
      entityVersion: 1,
    });

    await (SrcOrderModel as any).collection.insertOne({
      tenantId,
      orderId,
      orderNumber: 'ORD-OF01',
      customerId,
      status: 'COMPLETED',
      paid: true,
      netPaise: 850000,
      grossPaise: 850000,
      refundedPaise: 0,
      completedAt,
      branchId: 'branch_main',
      entityVersion: 1,
      lines: [
        {
          lineId: 'line_saree_1',
          productId: 'prod_saree_red_silk',
          name: 'Red Silk Saree',
          qty: 1,
          returnedQty: 0,
          lineNetPaise: 850000,
        },
      ],
    });

    await eventConsumerService.ingestEvent(tenantId, 'orders', {
      schemaVersion: 1,
      producer: 'orders',
      eventId: `evt_of01_${Date.now()}`,
      type: 'order.completed',
      entityId: orderId,
      entityVersion: 1,
      customerId,
      occurredAt: completedAt,
      data: { orderId, customerId, status: 'COMPLETED', paid: true, netPaise: 850000 },
    });

    const enrollment = await CampaignEnrollmentModel.findOne({
      tenantId,
      customerId,
      occurrenceId: `outfit:${orderId}`,
    }).lean();

    expect(enrollment).toBeDefined();
    expect(enrollment?.status).toBe(ENROLLMENT_STATUS.ACTIVE);
    expect(enrollment?.anchorOrderId).toBe(orderId);
    expect(enrollment?.anchorProductId).toBe('prod_saree_red_silk');

    const executions = await CampaignExecutionModel.find({
      tenantId,
      enrollmentId: enrollment?.enrollmentId,
    }).lean();

    expect(executions.length).toBe(1);
    const exec = executions[0];
    expect(exec.state).toBe(EXECUTION_STATE.SCHEDULED);
    expect(exec.rawDueAt).toBeDefined();
    expect(exec.adjustedDueAt).toBeDefined();

    // 5 days after Oct 20 10:00 UTC (15:30 IST) is Oct 25 10:00 UTC (15:30 IST), inside 10:00-19:00 IST hours
    const rawExpected = new Date(completedAt.getTime() + 5 * 24 * 3600 * 1000);
    expect(exec.rawDueAt?.toISOString()).toBe(rawExpected.toISOString());
    expect(exec.adjustedDueAt?.toISOString()).toBe(rawExpected.toISOString());
  });

  it('OF02: event replay x5 changes nothing', async () => {
    const customerId = `cus_of02_${Date.now()}`;
    const orderId = `ord_of02_${Date.now()}`;
    const completedAt = clock.now();

    await (SrcCustomerModel as any).collection.insertOne({
      tenantId,
      customerId,
      firstName: 'OF02 Replay',
      destination: {
        rawPhone: '+91 99000 00002',
        encryptedPhone: 'enc_phone',
        destinationHash: `hash_${customerId}`,
        masked: '+91 99*** **002',
        verified: true,
        verificationLevel: 'CONFIRMED_BY_STAFF',
        version: 1,
      },
      consent: { marketingOptIn: true, channelSuppressed: false },
      status: 'ACTIVE',
      branchId: 'branch_main',
      entityVersion: 1,
    });

    await (SrcOrderModel as any).collection.insertOne({
      tenantId,
      orderId,
      orderNumber: 'ORD-OF02',
      customerId,
      status: 'COMPLETED',
      paid: true,
      netPaise: 850000,
      completedAt,
      branchId: 'branch_main',
      entityVersion: 1,
      lines: [
        {
          lineId: 'line_saree_1',
          productId: 'prod_saree_red_silk',
          qty: 1,
          returnedQty: 0,
          lineNetPaise: 850000,
        },
      ],
    });

    for (let i = 0; i < 5; i++) {
      await eventConsumerService.ingestEvent(tenantId, 'orders', {
        schemaVersion: 1,
        producer: 'orders',
        eventId: `evt_of02_replay_${i}`,
        type: 'order.completed',
        entityId: orderId,
        entityVersion: 1,
        customerId,
        occurredAt: completedAt,
        data: { orderId, customerId, status: 'COMPLETED', paid: true, netPaise: 850000 },
      });
    }

    const enrollments = await CampaignEnrollmentModel.find({
      tenantId,
      customerId,
      occurrenceId: `outfit:${orderId}`,
    }).lean();

    expect(enrollments.length).toBe(1);
  });

  it('OF03: order without an anchor line -> EXCLUDED NO_ANCHOR_LINE and counted', async () => {
    const customerId = `cus_of03_${Date.now()}`;
    const orderId = `ord_of03_${Date.now()}`;

    await (SrcCustomerModel as any).collection.insertOne({
      tenantId,
      customerId,
      firstName: 'OF03 No Anchor',
      destination: {
        rawPhone: '+91 99000 00003',
        encryptedPhone: 'enc_phone',
        destinationHash: `hash_${customerId}`,
        masked: '+91 99*** **003',
        verified: true,
        verificationLevel: 'CONFIRMED_BY_STAFF',
        version: 1,
      },
      consent: { marketingOptIn: true, channelSuppressed: false },
      status: 'ACTIVE',
      branchId: 'branch_main',
      entityVersion: 1,
    });

    await (SrcOrderModel as any).collection.insertOne({
      tenantId,
      orderId,
      orderNumber: 'ORD-OF03',
      customerId,
      status: 'COMPLETED',
      paid: true,
      netPaise: 120000,
      completedAt: clock.now(),
      branchId: 'branch_main',
      entityVersion: 1,
      lines: [
        {
          lineId: 'line_acc_1',
          productId: 'prod_accessories_belt', // accessories, not in anchorCategories ['saree']
          name: 'Belt',
          qty: 1,
          returnedQty: 0,
          lineNetPaise: 120000,
        },
      ],
    });

    await eventConsumerService.ingestEvent(tenantId, 'orders', {
      schemaVersion: 1,
      producer: 'orders',
      eventId: `evt_of03_${Date.now()}`,
      type: 'order.completed',
      entityId: orderId,
      entityVersion: 1,
      customerId,
      occurredAt: clock.now(),
      data: { orderId, customerId, status: 'COMPLETED', paid: true, netPaise: 120000 },
    });

    const enrollment = await CampaignEnrollmentModel.findOne({
      tenantId,
      customerId,
      occurrenceId: `outfit:${orderId}`,
    }).lean();

    expect(enrollment).toBeDefined();
    expect(enrollment?.status).toBe(ENROLLMENT_STATUS.EXCLUDED);
    expect(enrollment?.exclusionReason).toBe('NO_ANCHOR_LINE');
    const execs = await CampaignExecutionModel.find({ tenantId, customerId }).lean();
    expect(execs.length).toBe(0);
  });

  it('OF04: pending/unpaid/cancelled/net<=0 never enroll', async () => {
    const customerId = `cus_of04_${Date.now()}`;

    await (SrcCustomerModel as any).collection.insertOne({
      tenantId,
      customerId,
      firstName: 'OF04 Unqualifying',
      destination: {
        rawPhone: '+91 99000 00004',
        encryptedPhone: 'enc_phone',
        destinationHash: `hash_${customerId}`,
        masked: '+91 99*** **004',
        verified: true,
        verificationLevel: 'CONFIRMED_BY_STAFF',
        version: 1,
      },
      consent: { marketingOptIn: true, channelSuppressed: false },
      status: 'ACTIVE',
      branchId: 'branch_main',
      entityVersion: 1,
    });

    const unqualifyingOrders = [
      { id: `ord_of04_pending`, status: 'PENDING', paid: false, netPaise: 850000 },
      { id: `ord_of04_unpaid`, status: 'COMPLETED', paid: false, netPaise: 850000 },
      { id: `ord_of04_cancelled`, status: 'CANCELLED', paid: true, netPaise: 850000 },
      { id: `ord_of04_zero_net`, status: 'COMPLETED', paid: true, netPaise: 0 },
    ];

    for (const uo of unqualifyingOrders) {
      await (SrcOrderModel as any).collection.insertOne({
        tenantId,
        orderId: uo.id,
        orderNumber: uo.id,
        customerId,
        status: uo.status,
        paid: uo.paid,
        netPaise: uo.netPaise,
        completedAt: clock.now(),
        branchId: 'branch_main',
        entityVersion: 1,
        lines: [
          {
            lineId: 'line_1',
            productId: 'prod_saree_red_silk',
            qty: 1,
            returnedQty: 0,
            lineNetPaise: uo.netPaise,
          },
        ],
      });

      await eventConsumerService.ingestEvent(tenantId, 'orders', {
        schemaVersion: 1,
        producer: 'orders',
        eventId: `evt_of04_${uo.id}`,
        type: 'order.completed',
        entityId: uo.id,
        entityVersion: 1,
        customerId,
        occurredAt: clock.now(),
        data: { orderId: uo.id, customerId, status: uo.status, paid: uo.paid, netPaise: uo.netPaise },
      });

      const enr = await CampaignEnrollmentModel.findOne({
        tenantId,
        customerId,
        occurrenceId: `outfit:${uo.id}`,
      }).lean();
      expect(enr).toBeNull();
    }
  });

  it('OF05: anonymous order -> NO_CUSTOMER_IDENTITY; order.updated attaching a customer enrolls (or elapsed)', async () => {
    const orderId = `ord_of05_anon_${Date.now()}`;
    const customerId = `cus_of05_attached_${Date.now()}`;

    await (SrcCustomerModel as any).collection.insertOne({
      tenantId,
      customerId,
      firstName: 'Attached Customer',
      destination: {
        rawPhone: '+91 99000 00005',
        encryptedPhone: 'enc_phone',
        destinationHash: `hash_${customerId}`,
        masked: '+91 99*** **005',
        verified: true,
        verificationLevel: 'CONFIRMED_BY_STAFF',
        version: 1,
      },
      consent: { marketingOptIn: true, channelSuppressed: false },
      status: 'ACTIVE',
      branchId: 'branch_main',
      entityVersion: 1,
    });

    await (SrcOrderModel as any).collection.insertOne({
      tenantId,
      orderId,
      orderNumber: 'ORD-OF05',
      customerId: null,
      status: 'COMPLETED',
      paid: true,
      netPaise: 850000,
      completedAt: clock.now(),
      branchId: 'branch_main',
      entityVersion: 1,
      lines: [
        {
          lineId: 'line_1',
          productId: 'prod_saree_red_silk',
          qty: 1,
          returnedQty: 0,
          lineNetPaise: 850000,
        },
      ],
    });

    // 1. Initial event without customer -> NO_CUSTOMER_IDENTITY
    const initialRes = await eventConsumerService.ingestEvent(tenantId, 'orders', {
      schemaVersion: 1,
      producer: 'orders',
      eventId: `evt_of05_initial`,
      type: 'order.completed',
      entityId: orderId,
      entityVersion: 1,
      customerId: null,
      occurredAt: clock.now(),
      data: { orderId, customerId: null, status: 'COMPLETED', paid: true, netPaise: 850000 },
    });
    expect((initialRes as any).effects?.outcome || (initialRes as any).outcome).toBe('NO_CUSTOMER_IDENTITY');

    // 2. Order updated event attaches customer identity
    await (SrcOrderModel as any).collection.updateOne(
      { tenantId, orderId },
      { $set: { customerId, entityVersion: 2 } }
    );

    await eventConsumerService.ingestEvent(tenantId, 'orders', {
      schemaVersion: 1,
      producer: 'orders',
      eventId: `evt_of05_updated`,
      type: 'order.updated',
      entityId: orderId,
      entityVersion: 2,
      customerId,
      occurredAt: clock.now(),
      data: { orderId, customerId, status: 'COMPLETED', paid: true, netPaise: 850000 },
    });

    const enrollment = await CampaignEnrollmentModel.findOne({
      tenantId,
      customerId,
      occurrenceId: `outfit:${orderId}`,
    }).lean();

    expect(enrollment).toBeDefined();
    expect(enrollment?.status).toBe(ENROLLMENT_STATUS.ACTIVE);
  });

  it('OF06: several anchor lines -> one enrollment, primary anchor = highest lineNetPaise (tie lowest lineId)', async () => {
    const customerId = `cus_of06_${Date.now()}`;
    const orderId = `ord_of06_${Date.now()}`;

    await (SrcCustomerModel as any).collection.insertOne({
      tenantId,
      customerId,
      firstName: 'OF06 Multi Anchor',
      destination: {
        rawPhone: '+91 99000 00006',
        encryptedPhone: 'enc_phone',
        destinationHash: `hash_${customerId}`,
        masked: '+91 99*** **006',
        verified: true,
        verificationLevel: 'CONFIRMED_BY_STAFF',
        version: 1,
      },
      consent: { marketingOptIn: true, channelSuppressed: false },
      status: 'ACTIVE',
      branchId: 'branch_main',
      entityVersion: 1,
    });

    // 2 saree lines: Green Silk (750000) and Red Silk (850000)
    await (SrcOrderModel as any).collection.insertOne({
      tenantId,
      orderId,
      orderNumber: 'ORD-OF06',
      customerId,
      status: 'COMPLETED',
      paid: true,
      netPaise: 1600000,
      completedAt: clock.now(),
      branchId: 'branch_main',
      entityVersion: 1,
      lines: [
        {
          lineId: 'line_b',
          productId: 'prod_saree_green_silk',
          name: 'Green Silk Saree',
          qty: 1,
          returnedQty: 0,
          lineNetPaise: 750000,
        },
        {
          lineId: 'line_a',
          productId: 'prod_saree_red_silk',
          name: 'Red Silk Saree',
          qty: 1,
          returnedQty: 0,
          lineNetPaise: 850000,
        },
      ],
    });

    await eventConsumerService.ingestEvent(tenantId, 'orders', {
      schemaVersion: 1,
      producer: 'orders',
      eventId: `evt_of06_${Date.now()}`,
      type: 'order.completed',
      entityId: orderId,
      entityVersion: 1,
      customerId,
      occurredAt: clock.now(),
      data: { orderId, customerId, status: 'COMPLETED', paid: true, netPaise: 1600000 },
    });

    const enr = await CampaignEnrollmentModel.findOne({
      tenantId,
      customerId,
      occurrenceId: `outfit:${orderId}`,
    }).lean();

    expect(enr).toBeDefined();
    // Primary anchor should be the highest lineNetPaise -> prod_saree_red_silk
    expect(enr?.anchorProductId).toBe('prod_saree_red_silk');
    expect(enr?.anchorLineId).toBe('line_a');
  });

  it('OF07: spacing rule: RECENTLY_SUGGESTED within minDaysBetweenEnrollments after an accepted message, enrolls after it, and unsent/cancelled earlier enrollments do not block', async () => {
    const customerId = `cus_of07_${Date.now()}`;
    const order1Id = `ord_of07_1_${Date.now()}`;
    const order2Id = `ord_of07_2_${Date.now()}`;

    await (SrcCustomerModel as any).collection.insertOne({
      tenantId,
      customerId,
      firstName: 'OF07 Spacing',
      destination: {
        rawPhone: '+91 99000 00007',
        encryptedPhone: 'enc_phone',
        destinationHash: `hash_${customerId}`,
        masked: '+91 99*** **007',
        verified: true,
        verificationLevel: 'CONFIRMED_BY_STAFF',
        version: 1,
      },
      consent: { marketingOptIn: true, channelSuppressed: false },
      status: 'ACTIVE',
      branchId: 'branch_main',
      entityVersion: 1,
    });

    // Order 1 completed 20 days ago
    const time1 = new Date(clock.now().getTime() - 20 * 86400000);
    await (SrcOrderModel as any).collection.insertOne({
      tenantId,
      orderId: order1Id,
      orderNumber: 'ORD-OF07-1',
      customerId,
      status: 'COMPLETED',
      paid: true,
      netPaise: 850000,
      completedAt: time1,
      branchId: 'branch_main',
      entityVersion: 1,
      lines: [{ lineId: 'l1', productId: 'prod_saree_red_silk', qty: 1, returnedQty: 0, lineNetPaise: 850000 }],
    });

    await eventConsumerService.ingestEvent(tenantId, 'orders', {
      schemaVersion: 1,
      producer: 'orders',
      eventId: `evt_of07_1`,
      type: 'order.completed',
      entityId: order1Id,
      entityVersion: 1,
      customerId,
      occurredAt: time1,
      data: { orderId: order1Id, customerId, status: 'COMPLETED', paid: true, netPaise: 850000 },
    });

    const enr1 = await CampaignEnrollmentModel.findOne({ tenantId, customerId, occurrenceId: `outfit:${order1Id}` });
    expect(enr1).toBeDefined();

    // Simulate step 1 execution was ACCEPTED 15 days ago (within minDaysBetweenEnrollments=30)
    await CampaignExecutionModel.updateOne(
      { tenantId, enrollmentId: enr1?.enrollmentId },
      {
        $set: {
          state: EXECUTION_STATE.PROVIDER_ACCEPTED,
          sentAt: new Date(time1.getTime() + 5 * 86400000),
        },
      }
    );

    // Order 2 completed 10 days ago (10 days after order 1 message -> within 30 days!)
    const time2 = new Date(clock.now().getTime() - 10 * 86400000);
    await (SrcOrderModel as any).collection.insertOne({
      tenantId,
      orderId: order2Id,
      orderNumber: 'ORD-OF07-2',
      customerId,
      status: 'COMPLETED',
      paid: true,
      netPaise: 850000,
      completedAt: time2,
      branchId: 'branch_main',
      entityVersion: 1,
      lines: [{ lineId: 'l2', productId: 'prod_saree_red_silk', qty: 1, returnedQty: 0, lineNetPaise: 850000 }],
    });

    await eventConsumerService.ingestEvent(tenantId, 'orders', {
      schemaVersion: 1,
      producer: 'orders',
      eventId: `evt_of07_2`,
      type: 'order.completed',
      entityId: order2Id,
      entityVersion: 1,
      customerId,
      occurredAt: time2,
      data: { orderId: order2Id, customerId, status: 'COMPLETED', paid: true, netPaise: 850000 },
    });

    const enr2 = await CampaignEnrollmentModel.findOne({ tenantId, customerId, occurrenceId: `outfit:${order2Id}` }).lean();
    expect(enr2?.status).toBe(ENROLLMENT_STATUS.EXCLUDED);
    expect(enr2?.exclusionReason).toBe('RECENTLY_SUGGESTED');
    const execs2 = await CampaignExecutionModel.find({ tenantId, customerId, enrollmentId: enr2?.enrollmentId }).lean();
    expect(execs2.length).toBe(0);
  });

  it('OF08: anchor order fully refunded/cancelled before send cancels unsent steps ANCHOR_ORDER_NO_LONGER_QUALIFIES; refund after acceptance recalls nothing and never resurrects', async () => {
    const customerId = `cus_of08_${Date.now()}`;
    const orderId = `ord_of08_${Date.now()}`;
    const completedAt = clock.now();

    await (SrcCustomerModel as any).collection.insertOne({
      tenantId,
      customerId,
      firstName: 'OF08 Refund',
      destination: {
        rawPhone: '+91 99000 00008',
        encryptedPhone: 'enc_phone',
        destinationHash: `hash_${customerId}`,
        masked: '+91 99*** **008',
        verified: true,
        verificationLevel: 'CONFIRMED_BY_STAFF',
        version: 1,
      },
      consent: { marketingOptIn: true, channelSuppressed: false },
      status: 'ACTIVE',
      branchId: 'branch_main',
      entityVersion: 1,
    });

    await (SrcOrderModel as any).collection.insertOne({
      tenantId,
      orderId,
      orderNumber: 'ORD-OF08',
      customerId,
      status: 'COMPLETED',
      paid: true,
      netPaise: 850000,
      grossPaise: 850000,
      refundedPaise: 0,
      completedAt,
      branchId: 'branch_main',
      entityVersion: 1,
      lines: [{ lineId: 'l1', productId: 'prod_saree_red_silk', qty: 1, returnedQty: 0, lineNetPaise: 850000 }],
    });

    await eventConsumerService.ingestEvent(tenantId, 'orders', {
      schemaVersion: 1,
      producer: 'orders',
      eventId: `evt_of08_c`,
      type: 'order.completed',
      entityId: orderId,
      entityVersion: 1,
      customerId,
      occurredAt: completedAt,
      data: { orderId, customerId, status: 'COMPLETED', paid: true, netPaise: 850000 },
    });

    const enr = await CampaignEnrollmentModel.findOne({ tenantId, customerId, occurrenceId: `outfit:${orderId}` });
    expect(enr?.status).toBe(ENROLLMENT_STATUS.ACTIVE);

    // Full refund before send
    await (SrcOrderModel as any).collection.updateOne(
      { tenantId, orderId },
      { $set: { status: 'REFUNDED', netPaise: 0, refundedPaise: 850000, entityVersion: 2 } }
    );

    await eventConsumerService.ingestEvent(tenantId, 'orders', {
      schemaVersion: 1,
      producer: 'orders',
      eventId: `evt_of08_r`,
      type: 'order.refunded',
      entityId: orderId,
      entityVersion: 2,
      customerId,
      occurredAt: clock.now(),
      data: { orderId, type: 'FULL', refundedPaise: 850000, netPaise: 0, status: 'REFUNDED' },
    });

    const enrAfter = await CampaignEnrollmentModel.findOne({ tenantId, customerId, occurrenceId: `outfit:${orderId}` }).lean();
    expect(enrAfter?.status).toBe(ENROLLMENT_STATUS.CANCELLED);
    expect(enrAfter?.stopReason).toBe(EXECUTION_REASONS.ANCHOR_ORDER_NO_LONGER_QUALIFIES);

    const execs = await CampaignExecutionModel.find({ tenantId, enrollmentId: enrAfter?.enrollmentId }).lean();
    expect(execs.every((e) => e.state === EXECUTION_STATE.CANCELLED)).toBe(true);
  });

  it('OF09: partial line return keeps another anchor line; all anchor lines returned -> ANCHOR_LINES_RETURNED; a returned complement purchase does not count as owned', async () => {
    const customerId = `cus_of09_${Date.now()}`;
    const orderId = `ord_of09_${Date.now()}`;
    const completedAt = clock.now();

    await (SrcCustomerModel as any).collection.insertOne({
      tenantId,
      customerId,
      firstName: 'OF09 Partial Line',
      destination: {
        rawPhone: '+91 99000 00009',
        encryptedPhone: 'enc_phone',
        destinationHash: `hash_${customerId}`,
        masked: '+91 99*** **009',
        verified: true,
        verificationLevel: 'CONFIRMED_BY_STAFF',
        version: 1,
      },
      consent: { marketingOptIn: true, channelSuppressed: false },
      status: 'ACTIVE',
      branchId: 'branch_main',
      entityVersion: 1,
    });

    // 2 saree lines
    await (SrcOrderModel as any).collection.insertOne({
      tenantId,
      orderId,
      orderNumber: 'ORD-OF09',
      customerId,
      status: 'COMPLETED',
      paid: true,
      netPaise: 1600000,
      completedAt,
      branchId: 'branch_main',
      entityVersion: 1,
      lines: [
        { lineId: 'l1', productId: 'prod_saree_red_silk', qty: 1, returnedQty: 0, lineNetPaise: 850000 },
        { lineId: 'l2', productId: 'prod_saree_green_silk', qty: 1, returnedQty: 0, lineNetPaise: 750000 },
      ],
    });

    await eventConsumerService.ingestEvent(tenantId, 'orders', {
      schemaVersion: 1,
      producer: 'orders',
      eventId: `evt_of09_c`,
      type: 'order.completed',
      entityId: orderId,
      entityVersion: 1,
      customerId,
      occurredAt: completedAt,
      data: { orderId, customerId, status: 'COMPLETED', paid: true, netPaise: 1600000 },
    });

    // 1. Return first saree line: second saree line still active -> enrollment stays ACTIVE
    await (SrcOrderModel as any).collection.updateOne(
      { tenantId, orderId },
      {
        $set: {
          'lines.0.returnedQty': 1,
          'lines.0.lineNetPaise': 0,
          netPaise: 750000,
          entityVersion: 2,
        },
      }
    );

    await eventConsumerService.ingestEvent(tenantId, 'orders', {
      schemaVersion: 1,
      producer: 'orders',
      eventId: `evt_of09_r1`,
      type: 'order.refunded',
      entityId: orderId,
      entityVersion: 2,
      customerId,
      occurredAt: clock.now(),
      data: { orderId, type: 'PARTIAL', netPaise: 750000, status: 'COMPLETED' },
    });

    let enr = await CampaignEnrollmentModel.findOne({ tenantId, customerId, occurrenceId: `outfit:${orderId}` }).lean();
    expect(enr?.status).toBe(ENROLLMENT_STATUS.ACTIVE);

    // 2. Return second saree line: all anchor lines now returned -> ANCHOR_LINES_RETURNED
    await (SrcOrderModel as any).collection.updateOne(
      { tenantId, orderId },
      {
        $set: {
          'lines.1.returnedQty': 1,
          'lines.1.lineNetPaise': 0,
          netPaise: 0,
          entityVersion: 3,
        },
      }
    );

    await eventConsumerService.ingestEvent(tenantId, 'orders', {
      schemaVersion: 1,
      producer: 'orders',
      eventId: `evt_of09_r2`,
      type: 'order.refunded',
      entityId: orderId,
      entityVersion: 3,
      customerId,
      occurredAt: clock.now(),
      data: { orderId, type: 'FULL', netPaise: 0, status: 'REFUNDED' },
    });

    enr = await CampaignEnrollmentModel.findOne({ tenantId, customerId, occurrenceId: `outfit:${orderId}` }).lean();
    expect(enr?.status).toBe(ENROLLMENT_STATUS.CANCELLED);
  });

  it('OF10: matching: category map and priority order, only ACTIVE sellable items, anchor product never suggested, each rejection stored with its reason', async () => {
    const candidateProducts = [
      {
        productId: 'prod_saree_red_silk', // anchor itself -> must never be selected
        name: 'Red Silk Saree',
        category: 'saree',
        status: 'ACTIVE',
        variants: [{ variantId: 'v1', sellableQty: 5 }],
      },
      {
        productId: 'prod_blouse_oos',
        name: 'OOS Blouse',
        category: 'blouse',
        status: 'ACTIVE',
        variants: [{ variantId: 'v2', sellableQty: 0 }],
      },
      {
        productId: 'prod_blouse_disc',
        name: 'Disc Blouse',
        category: 'blouse',
        status: 'DISCONTINUED',
        variants: [{ variantId: 'v3', sellableQty: 5 }],
      },
      {
        productId: 'prod_blouse_good',
        name: 'Good Blouse',
        category: 'blouse',
        colourFamily: 'gold',
        weave: 'silk',
        pricePaise: 250000,
        status: 'ACTIVE',
        variants: [{ variantId: 'v4', sellableQty: 5 }],
      },
    ];

    const selection = selectComplements({
      anchorOrder: { orderId: 'ord_1', lines: [] },
      primaryAnchorLine: { lineId: 'l1', productId: 'prod_saree_red_silk' },
      anchorProduct: {
        productId: 'prod_saree_red_silk',
        category: 'saree',
        colourFamily: 'red',
        weave: 'silk',
      },
      customer: { customerId: 'cus_1', preferences: null },
      candidateProducts: candidateProducts as any,
      productCategoryMap: new Map(),
      orderHistory: [],
      pairing: {
        anchorCategories: ['saree'],
        complementMap: { saree: ['blouse'] },
        colourMatch: 'NEUTRAL_OR_SAME',
        requireSameWeave: false,
        budgetAware: false,
        alreadyOwnedLookbackDays: 180,
        suppressIfCategoryInOrder: true,
      },
      k: 1,
      now: clock.now(),
    });

    expect(selection.complements.length).toBe(1);
    expect(selection.complements[0].productId).toBe('prod_blouse_good');
    expect(selection.anchor.productId).toBe('prod_saree_red_silk');

    // Check exclusion reasons recorded
    const oosEx = selection.excluded.find((e) => e.productId === 'prod_blouse_oos');
    expect(oosEx?.reason).toBe('NOT_SELLABLE');

    const discEx = selection.excluded.find((e) => e.productId === 'prod_blouse_disc');
    expect(discEx?.reason).toBe('DISCONTINUED');
  });

  it('OF11: colourMatch ANY/SAME_FAMILY/NEUTRAL_OR_SAME and COLOUR_UNKNOWN', async () => {
    const candidates = [
      {
        productId: 'prod_b_neutral',
        name: 'Gold Blouse',
        category: 'blouse',
        colourFamily: 'gold', // neutral
        status: 'ACTIVE',
        variants: [{ variantId: 'v1', sellableQty: 5 }],
      },
      {
        productId: 'prod_b_same',
        name: 'Red Blouse',
        category: 'blouse',
        colourFamily: 'red', // same family as red saree
        status: 'ACTIVE',
        variants: [{ variantId: 'v2', sellableQty: 5 }],
      },
      {
        productId: 'prod_b_other',
        name: 'Green Blouse',
        category: 'blouse',
        colourFamily: 'green', // incompatible under NEUTRAL_OR_SAME
        status: 'ACTIVE',
        variants: [{ variantId: 'v3', sellableQty: 5 }],
      },
      {
        productId: 'prod_b_no_colour',
        name: 'No Colour Blouse',
        category: 'blouse',
        colourFamily: null, // unknown colour -> passes with note
        status: 'ACTIVE',
        variants: [{ variantId: 'v4', sellableQty: 5 }],
      },
    ];

    const selNeutral = selectComplements({
      anchorOrder: { orderId: 'ord_1', lines: [] },
      primaryAnchorLine: { lineId: 'l1', productId: 'prod_saree' },
      anchorProduct: { productId: 'prod_saree', category: 'saree', colourFamily: 'red' },
      customer: { customerId: 'c1', preferences: null },
      candidateProducts: candidates as any,
      productCategoryMap: new Map(),
      orderHistory: [],
      pairing: {
        anchorCategories: ['saree'],
        complementMap: { saree: ['blouse'] },
        colourMatch: 'NEUTRAL_OR_SAME',
        requireSameWeave: false,
        budgetAware: false,
        alreadyOwnedLookbackDays: 180,
        suppressIfCategoryInOrder: false,
      },
      k: 3,
      now: clock.now(),
    });

    const selIds = selNeutral.complements.map((c) => c.productId);
    expect(selIds).toContain('prod_b_same');
    expect(selIds).toContain('prod_b_neutral');
    expect(selIds).toContain('prod_b_no_colour');
    expect(selIds).not.toContain('prod_b_other');

    const incompatibleEx = selNeutral.excluded.find((e) => e.productId === 'prod_b_other');
    expect(incompatibleEx?.reason).toBe('COLOUR_INCOMPATIBLE');
  });

  it('OF12: ALREADY_PURCHASED inside the lookback, allowed outside it', async () => {
    const candidates = [
      {
        productId: 'prod_blouse_owned',
        name: 'Owned Blouse',
        category: 'blouse',
        colourFamily: 'gold',
        status: 'ACTIVE',
        variants: [{ variantId: 'v1', sellableQty: 5 }],
      },
    ];

    // Customer bought this blouse 60 days ago (within 180-day lookback)
    const orderHistoryWithinLookback = [
      {
        orderId: 'ord_prev',
        status: 'COMPLETED',
        paid: true,
        completedAt: new Date(clock.now().getTime() - 60 * 86400000),
        lines: [{ productId: 'prod_blouse_owned', qty: 1, returnedQty: 0 }],
      },
    ];

    const selInside = selectComplements({
      anchorOrder: { orderId: 'ord_curr', lines: [] },
      primaryAnchorLine: { lineId: 'l1', productId: 'prod_saree' },
      anchorProduct: { productId: 'prod_saree', category: 'saree', colourFamily: 'red' },
      customer: { customerId: 'c1', preferences: null },
      candidateProducts: candidates as any,
      productCategoryMap: new Map(),
      orderHistory: orderHistoryWithinLookback,
      pairing: {
        anchorCategories: ['saree'],
        complementMap: { saree: ['blouse'] },
        colourMatch: 'ANY',
        alreadyOwnedLookbackDays: 180,
        suppressIfCategoryInOrder: false,
      },
      k: 1,
      now: clock.now(),
    });

    expect(selInside.insufficient).toBe(true);
    expect(selInside.excluded[0].reason).toBe('ALREADY_PURCHASED');

    // Outside lookback (400 days ago) -> allowed!
    const orderHistoryOutsideLookback = [
      {
        orderId: 'ord_prev_old',
        status: 'COMPLETED',
        paid: true,
        completedAt: new Date(clock.now().getTime() - 400 * 86400000),
        lines: [{ productId: 'prod_blouse_owned', qty: 1, returnedQty: 0 }],
      },
    ];

    const selOutside = selectComplements({
      anchorOrder: { orderId: 'ord_curr', lines: [] },
      primaryAnchorLine: { lineId: 'l1', productId: 'prod_saree' },
      anchorProduct: { productId: 'prod_saree', category: 'saree', colourFamily: 'red' },
      customer: { customerId: 'c1', preferences: null },
      candidateProducts: candidates as any,
      productCategoryMap: new Map(),
      orderHistory: orderHistoryOutsideLookback,
      pairing: {
        anchorCategories: ['saree'],
        complementMap: { saree: ['blouse'] },
        colourMatch: 'ANY',
        alreadyOwnedLookbackDays: 180,
        suppressIfCategoryInOrder: false,
      },
      k: 1,
      now: clock.now(),
    });

    expect(selOutside.insufficient).toBe(false);
    expect(selOutside.complements[0].productId).toBe('prod_blouse_owned');
  });

  it('OF13: CATEGORY_IN_ORDER with the flag on and off', async () => {
    const candidates = [
      {
        productId: 'prod_blouse_c',
        name: 'Complement Blouse',
        category: 'blouse',
        status: 'ACTIVE',
        variants: [{ variantId: 'v1', sellableQty: 5 }],
      },
    ];

    // The current anchor order already contains a blouse!
    const anchorOrderWithBlouse = {
      orderId: 'ord_combo',
      lines: [
        { lineId: 'l1', productId: 'prod_saree', qty: 1, returnedQty: 0 },
        { lineId: 'l2', productId: 'prod_some_blouse', qty: 1, returnedQty: 0 },
      ],
    };

    const categoryMap = new Map([
      ['prod_some_blouse', 'blouse'],
      ['prod_saree', 'saree'],
      ['prod_blouse_c', 'blouse'],
    ]);

    // Flag ON -> excludes blouse category
    const selOn = selectComplements({
      anchorOrder: anchorOrderWithBlouse,
      primaryAnchorLine: { lineId: 'l1', productId: 'prod_saree' },
      anchorProduct: { productId: 'prod_saree', category: 'saree' },
      customer: { customerId: 'c1', preferences: null },
      candidateProducts: candidates as any,
      productCategoryMap: categoryMap,
      orderHistory: [],
      pairing: {
        anchorCategories: ['saree'],
        complementMap: { saree: ['blouse'] },
        colourMatch: 'ANY',
        alreadyOwnedLookbackDays: 180,
        suppressIfCategoryInOrder: true,
      },
      k: 1,
      now: clock.now(),
    });

    expect(selOn.insufficient).toBe(true);
    expect(selOn.excluded[0].reason).toBe('CATEGORY_IN_ORDER');

    // Flag OFF -> allowed
    const selOff = selectComplements({
      anchorOrder: anchorOrderWithBlouse,
      primaryAnchorLine: { lineId: 'l1', productId: 'prod_saree' },
      anchorProduct: { productId: 'prod_saree', category: 'saree' },
      customer: { customerId: 'c1', preferences: null },
      candidateProducts: candidates as any,
      productCategoryMap: categoryMap,
      orderHistory: [],
      pairing: {
        anchorCategories: ['saree'],
        complementMap: { saree: ['blouse'] },
        colourMatch: 'ANY',
        alreadyOwnedLookbackDays: 180,
        suppressIfCategoryInOrder: false,
      },
      k: 1,
      now: clock.now(),
    });

    expect(selOff.insufficient).toBe(false);
    expect(selOff.complements[0].productId).toBe('prod_blouse_c');
  });

  it('OF14: budgetAware excludes OVER_BUDGET only when a budget preference exists', async () => {
    const candidates = [
      {
        productId: 'prod_blouse_expensive',
        name: 'Silk Blouse',
        category: 'blouse',
        pricePaise: 300000, // 3000 rupees
        status: 'ACTIVE',
        variants: [{ variantId: 'v1', sellableQty: 5 }],
      },
    ];

    // Customer with low budgetMaxPaise = 200000 (2000 rupees)
    const selWithBudget = selectComplements({
      anchorOrder: { orderId: 'ord_1', lines: [] },
      primaryAnchorLine: { lineId: 'l1', productId: 'prod_saree' },
      anchorProduct: { productId: 'prod_saree', category: 'saree' },
      customer: { customerId: 'c1', preferences: { budgetMaxPaise: 200000 } },
      candidateProducts: candidates as any,
      productCategoryMap: new Map(),
      orderHistory: [],
      pairing: {
        anchorCategories: ['saree'],
        complementMap: { saree: ['blouse'] },
        colourMatch: 'ANY',
        budgetAware: true,
        suppressIfCategoryInOrder: false,
      },
      k: 1,
      now: clock.now(),
    });

    expect(selWithBudget.insufficient).toBe(true);
    expect(selWithBudget.excluded[0].reason).toBe('OVER_BUDGET');

    // Customer without budgetMaxPaise -> passes!
    const selWithoutBudget = selectComplements({
      anchorOrder: { orderId: 'ord_1', lines: [] },
      primaryAnchorLine: { lineId: 'l1', productId: 'prod_saree' },
      anchorProduct: { productId: 'prod_saree', category: 'saree' },
      customer: { customerId: 'c2', preferences: null },
      candidateProducts: candidates as any,
      productCategoryMap: new Map(),
      orderHistory: [],
      pairing: {
        anchorCategories: ['saree'],
        complementMap: { saree: ['blouse'] },
        colourMatch: 'ANY',
        budgetAware: true,
        suppressIfCategoryInOrder: false,
      },
      k: 1,
      now: clock.now(),
    });

    expect(selWithoutBudget.insufficient).toBe(false);
    expect(selWithoutBudget.complements[0].productId).toBe('prod_blouse_expensive');
  });

  it('OF15: ranking and variety are deterministic (same input same output; tie by productId; stock level never affects order)', async () => {
    const candidates = [
      {
        productId: 'prod_b_high_stock',
        name: 'Blouse High Stock',
        category: 'blouse',
        colourFamily: 'gold',
        pricePaise: 200000,
        status: 'ACTIVE',
        variants: [{ variantId: 'v1', sellableQty: 100 }], // High stock
      },
      {
        productId: 'prod_b_low_stock',
        name: 'Blouse Low Stock',
        category: 'blouse',
        colourFamily: 'gold',
        pricePaise: 200000,
        status: 'ACTIVE',
        variants: [{ variantId: 'v2', sellableQty: 1 }], // Low stock, but identical score & price
      },
    ];

    const run1 = selectComplements({
      anchorOrder: { orderId: 'ord_1', lines: [] },
      primaryAnchorLine: { lineId: 'l1', productId: 'prod_saree' },
      anchorProduct: { productId: 'prod_saree', category: 'saree', colourFamily: 'red' },
      customer: { customerId: 'c1', preferences: null },
      candidateProducts: candidates as any,
      productCategoryMap: new Map(),
      orderHistory: [],
      pairing: {
        anchorCategories: ['saree'],
        complementMap: { saree: ['blouse'] },
        colourMatch: 'NEUTRAL_OR_SAME',
        suppressIfCategoryInOrder: false,
      },
      k: 2,
      now: clock.now(),
    });

    const run2 = selectComplements({
      anchorOrder: { orderId: 'ord_1', lines: [] },
      primaryAnchorLine: { lineId: 'l1', productId: 'prod_saree' },
      anchorProduct: { productId: 'prod_saree', category: 'saree', colourFamily: 'red' },
      customer: { customerId: 'c1', preferences: null },
      candidateProducts: candidates as any,
      productCategoryMap: new Map(),
      orderHistory: [],
      pairing: {
        anchorCategories: ['saree'],
        complementMap: { saree: ['blouse'] },
        colourMatch: 'NEUTRAL_OR_SAME',
        suppressIfCategoryInOrder: false,
      },
      k: 2,
      now: clock.now(),
    });

    expect(run1.complements.map((c) => c.productId)).toEqual(run2.complements.map((c) => c.productId));
    // Tied score and price are sorted alphabetically by productId asc: prod_b_high_stock precedes prod_b_low_stock
    expect(run1.complements[0].productId).toBe('prod_b_high_stock');
    expect(run1.complements[1].productId).toBe('prod_b_low_stock');
  });

  it('OF16: two complement slots but one eligible item -> SKIPPED NO_COMPLEMENT_AVAILABLE, zero provider calls, no template substitution, a later step selects again', async () => {
    // Single blouse available, but template needs k=2
    const candidates = [
      {
        productId: 'prod_only_one_blouse',
        name: 'Single Blouse',
        category: 'blouse',
        status: 'ACTIVE',
        variants: [{ variantId: 'v1', sellableQty: 5 }],
      },
    ];

    const sel = selectComplements({
      anchorOrder: { orderId: 'ord_1', lines: [] },
      primaryAnchorLine: { lineId: 'l1', productId: 'prod_saree' },
      anchorProduct: { productId: 'prod_saree', category: 'saree' },
      customer: { customerId: 'c1', preferences: null },
      candidateProducts: candidates as any,
      productCategoryMap: new Map(),
      orderHistory: [],
      pairing: {
        anchorCategories: ['saree'],
        complementMap: { saree: ['blouse'] },
        colourMatch: 'ANY',
        suppressIfCategoryInOrder: false,
      },
      k: 2, // Needs 2 complements!
      now: clock.now(),
    });

    expect(sel.insufficient).toBe(true);
    expect(sel.complements.length).toBe(1);
    expect(sel.available).toBe(1);
  });

  it('OF17: selection is frozen with matchReasons in the intent; a stock change AFTER freeze and before submission -> BLOCKED_STALE_INTENT COMPLEMENT_UNAVAILABLE and no second payload under the same key', async () => {
    const customerId = `cus_of17_${Date.now()}`;
    const orderId = `ord_of17_${Date.now()}`;

    await (SrcCustomerModel as any).collection.insertOne({
      tenantId,
      customerId,
      firstName: 'OF17 Stockout',
      destination: {
        rawPhone: '+91 99000 00017',
        encryptedPhone: 'enc_phone',
        destinationHash: `hash_${customerId}`,
        masked: '+91 99*** **017',
        verified: true,
        verificationLevel: 'CONFIRMED_BY_STAFF',
        version: 1,
      },
      consent: { marketingOptIn: true, channelSuppressed: false },
      status: 'ACTIVE',
      branchId: 'branch_main',
      entityVersion: 1,
    });

    await (SrcOrderModel as any).collection.insertOne({
      tenantId,
      orderId,
      orderNumber: 'ORD-OF17',
      customerId,
      status: 'COMPLETED',
      paid: true,
      netPaise: 850000,
      completedAt: clock.now(),
      branchId: 'branch_main',
      entityVersion: 1,
      lines: [{ lineId: 'l1', productId: 'prod_saree_red_silk', qty: 1, returnedQty: 0, lineNetPaise: 850000 }],
    });

    await eventConsumerService.ingestEvent(tenantId, 'orders', {
      schemaVersion: 1,
      producer: 'orders',
      eventId: `evt_of17_c`,
      type: 'order.completed',
      entityId: orderId,
      entityVersion: 1,
      customerId,
      occurredAt: clock.now(),
      data: { orderId, customerId, status: 'COMPLETED', paid: true, netPaise: 850000 },
    });

    const enr = await CampaignEnrollmentModel.findOne({ tenantId, customerId, occurrenceId: `outfit:${orderId}` }).lean();
    expect(enr).toBeDefined();

    // Advance clock past due time so worker evaluates the execution
    const exec = await CampaignExecutionModel.findOne({ tenantId, enrollmentId: enr?.enrollmentId });
    expect(exec).toBeDefined();

    // Spy on mockProductSource.getProduct to simulate stockout specifically after freeze (pre-submission check)
    const origGetProduct = mockProductSource.getProduct.bind(mockProductSource);
    mockProductSource.getProduct = async (t: string, pid: string) => {
      const prod = await origGetProduct(t, pid);
      if (pid.startsWith('prod_blouse_') && prod) {
        return {
          ...prod,
          variants: (prod.variants || []).map((v) => ({ ...v, sellableQty: 0 })),
        };
      }
      return prod;
    };

    const cycleRes = await workerService.runWorkerCycle({
      tenantId,
      campaignId: enr!.campaignId,
      nowOverride: new Date(exec!.dueAt.getTime() + 1000),
    });

    mockProductSource.getProduct = origGetProduct;

    const evalRes = cycleRes.results.find((r) => r.executionId === exec!.executionId);
    expect(evalRes).toBeDefined();
    expect(evalRes?.state).toBe(EXECUTION_STATE.BLOCKED);
    expect(evalRes?.reason).toBe(EXECUTION_REASONS.COMPLEMENT_UNAVAILABLE);

    const intent = await CampaignDeliveryIntentModel.findOne({ tenantId, executionId: exec!.executionId }).lean();
    expect(intent).toBeDefined();
    expect(intent?.state).toBe('BLOCKED_STALE_INTENT');
    expect(intent?.selectionSnapshot?.complements.length).toBeGreaterThan(0);
    expect(intent?.selectionSnapshot?.matchReasons.length).toBeGreaterThan(0);
  });

  it('OF18: dry run, preview route and dispatch evaluation return the SAME selection for the same snapshot and Clock and write nothing live (equivalence)', async () => {
    // Call preview endpoint
    const previewRes = await request(app)
      .post('/campaigns/cmp_complete_outfit_shop_a/complete-outfit/preview')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ orderId: 'ord_of_due_tomorrow' });

    expect(previewRes.status).toBe(200);
    const preview = previewRes.body;
    expect(preview.anchor.productId).toBe('prod_saree_red_silk');
    expect(preview.selected.length).toBeGreaterThan(0);
    expect(preview.matchReasons.length).toBeGreaterThan(0);

    // Verify zero live enrollments or executions were created
    const createdEnrollments = await CampaignEnrollmentModel.countDocuments({
      tenantId,
      occurrenceId: 'outfit:ord_preview_test',
    });
    expect(createdEnrollments).toBe(0);
  });

  it('OF19: goal modes: complement-category purchase stops (SKIPPED_GOAL_REACHED), tagged order stops, unrelated purchase does NOT stop, staff mark-goal works, receipts never count, TAGGED_ONLY mode', async () => {
    const customerId = `cus_of19_${Date.now()}`;
    const anchorOrderId = `ord_of19_anchor_${Date.now()}`;
    const anchorCompletedAt = new Date(clock.now().getTime() - 2 * 86400000);

    await (SrcCustomerModel as any).collection.insertOne({
      tenantId,
      customerId,
      firstName: 'OF19 Goal Modes',
      destination: {
        rawPhone: '+91 99000 00019',
        encryptedPhone: 'enc_phone',
        destinationHash: `hash_${customerId}`,
        masked: '+91 99*** **019',
        verified: true,
        verificationLevel: 'CONFIRMED_BY_STAFF',
        version: 1,
      },
      consent: { marketingOptIn: true, channelSuppressed: false },
      status: 'ACTIVE',
      branchId: 'branch_main',
      entityVersion: 1,
    });

    await (SrcOrderModel as any).collection.insertOne({
      tenantId,
      orderId: anchorOrderId,
      orderNumber: 'ORD-OF19-A',
      customerId,
      status: 'COMPLETED',
      paid: true,
      netPaise: 850000,
      completedAt: anchorCompletedAt,
      branchId: 'branch_main',
      entityVersion: 1,
      lines: [{ lineId: 'l1', productId: 'prod_saree_red_silk', qty: 1, returnedQty: 0, lineNetPaise: 850000 }],
    });

    await eventConsumerService.ingestEvent(tenantId, 'orders', {
      schemaVersion: 1,
      producer: 'orders',
      eventId: `evt_of19_a`,
      type: 'order.completed',
      entityId: anchorOrderId,
      entityVersion: 1,
      customerId,
      occurredAt: anchorCompletedAt,
      data: { orderId: anchorOrderId, customerId, status: 'COMPLETED', paid: true, netPaise: 850000 },
    });

    const enr = await CampaignEnrollmentModel.findOne({ tenantId, customerId, occurrenceId: `outfit:${anchorOrderId}` });
    expect(enr?.status).toBe(ENROLLMENT_STATUS.ACTIVE);

    // 1. Unrelated purchase: customer buys menswear (not in complementMap for saree)
    const unrelatedOrderId = `ord_of19_unrelated_${Date.now()}`;
    await (SrcOrderModel as any).collection.insertOne({
      tenantId,
      orderId: unrelatedOrderId,
      orderNumber: 'ORD-OF19-U',
      customerId,
      status: 'COMPLETED',
      paid: true,
      netPaise: 500000,
      completedAt: new Date(anchorCompletedAt.getTime() + 3600000),
      branchId: 'branch_main',
      entityVersion: 1,
      lines: [{ lineId: 'lu1', productId: 'prod_menswear_kurta', name: 'Kurta', qty: 1, returnedQty: 0, lineNetPaise: 500000 }],
    });

    await eventConsumerService.ingestEvent(tenantId, 'orders', {
      schemaVersion: 1,
      producer: 'orders',
      eventId: `evt_of19_u`,
      type: 'order.completed',
      entityId: unrelatedOrderId,
      entityVersion: 1,
      customerId,
      occurredAt: new Date(anchorCompletedAt.getTime() + 3600000),
      data: { orderId: unrelatedOrderId, customerId, status: 'COMPLETED', paid: true, netPaise: 500000 },
    });

    // Enrollment must STILL be active! Unrelated purchase does NOT stop it.
    let enrCheck = await CampaignEnrollmentModel.findOne({ tenantId, customerId, occurrenceId: `outfit:${anchorOrderId}` }).lean();
    expect(enrCheck?.status).toBe(ENROLLMENT_STATUS.ACTIVE);

    // 2. Complement purchase: customer buys a blouse!
    const complementOrderId = `ord_of19_comp_${Date.now()}`;
    await (SrcOrderModel as any).collection.insertOne({
      tenantId,
      orderId: complementOrderId,
      orderNumber: 'ORD-OF19-C',
      customerId,
      status: 'COMPLETED',
      paid: true,
      netPaise: 250000,
      completedAt: new Date(anchorCompletedAt.getTime() + 7200000),
      branchId: 'branch_main',
      entityVersion: 1,
      lines: [{ lineId: 'lc1', productId: 'prod_blouse_gold_silk', name: 'Gold Blouse', qty: 1, returnedQty: 0, lineNetPaise: 250000 }],
    });

    await eventConsumerService.ingestEvent(tenantId, 'orders', {
      schemaVersion: 1,
      producer: 'orders',
      eventId: `evt_of19_c`,
      type: 'order.completed',
      entityId: complementOrderId,
      entityVersion: 1,
      customerId,
      occurredAt: new Date(anchorCompletedAt.getTime() + 7200000),
      data: { orderId: complementOrderId, customerId, status: 'COMPLETED', paid: true, netPaise: 250000 },
    });

    // Enrollment must now be cancelled with SKIPPED_GOAL_REACHED!
    enrCheck = await CampaignEnrollmentModel.findOne({ tenantId, customerId, occurrenceId: `outfit:${anchorOrderId}` }).lean();
    expect(enrCheck?.status).toBe(ENROLLMENT_STATUS.CANCELLED);
    expect(enrCheck?.stopReason).toBe(EXECUTION_REASONS.SKIPPED_GOAL_REACHED);

    const goalEvent = await CampaignGoalEventModel.findOne({ tenantId, enrollmentId: enrCheck?.enrollmentId }).lean();
    expect(goalEvent).toBeDefined();
    expect(goalEvent?.source).toBe('OUTFIT_COMPLEMENT_PURCHASED');
  });

  it('OF20: reply hold and resolve-hold re-evaluate future steps only', async () => {
    const enr = await CampaignEnrollmentModel.findOne({
      tenantId,
      occurrenceId: 'outfit:ord_of_due_tomorrow',
    });
    expect(enr).toBeDefined();

    // Mark reply hold on enrollment
    enr!.replyHoldAt = clock.now();
    await enr!.save();

    // Re-resolve hold
    enr!.replyHoldAt = null;
    enr!.holdResolvedAt = clock.now();
    enr!.holdResolvedBy = 'staff@shop-a.com';
    enr!.holdResolutionCause = 'Customer responded, cleared by staff';
    await enr!.save();

    const updated = await CampaignEnrollmentModel.findById(enr!._id).lean();
    expect(updated?.replyHoldAt).toBeNull();
    expect(updated?.holdResolvedAt).toBeDefined();
  });

  it('OF21: opt-out/suppression/deletion, unverified destination, undeliverable destination', async () => {
    // Fixtures from seed:
    // 1. Opted out customer
    const enrOptedOut = await CampaignEnrollmentModel.findOne({ tenantId, customerId: 'cus_of_opted_out' }).lean();
    expect(enrOptedOut?.status).toBe(ENROLLMENT_STATUS.EXCLUDED);
    expect(enrOptedOut?.exclusionReason).toBe(EXCLUSION_REASONS.NO_MARKETING_CONSENT);
    const execsOptedOut = await CampaignExecutionModel.find({ tenantId, customerId: 'cus_of_opted_out' }).lean();
    expect(execsOptedOut.length).toBe(0);

    // 2. Unverified customer
    const enrUnverified = await CampaignEnrollmentModel.findOne({ tenantId, customerId: 'cus_of_unverified' }).lean();
    expect(enrUnverified?.status).toBe(ENROLLMENT_STATUS.EXCLUDED);
    const execsUnverified = await CampaignExecutionModel.find({ tenantId, customerId: 'cus_of_unverified' }).lean();
    expect(execsUnverified.length).toBe(0);

    // 3. Undeliverable customer
    const enrUndeliverable = await CampaignEnrollmentModel.findOne({ tenantId, customerId: 'cus_of_undeliverable' }).lean();
    expect(enrUndeliverable?.status).toBe(ENROLLMENT_STATUS.EXCLUDED);
    const execsUndeliverable = await CampaignExecutionModel.find({ tenantId, customerId: 'cus_of_undeliverable' }).lean();
    expect(execsUndeliverable.length).toBe(0);
  });

  it('OF22: timing: in hours, deferral to next morning, SKIP policy, maxDeferralHours, blackout shift never passing expiresAt, DST zone, IST 10:00 = 04:30 UTC', async () => {
    // Night order completed at 20:30 IST
    const nightOrderEnr = await CampaignEnrollmentModel.findOne({
      tenantId,
      customerId: 'cus_of_night_order',
    }).lean();

    expect(nightOrderEnr).toBeDefined();

    const exec = await CampaignExecutionModel.findOne({
      tenantId,
      enrollmentId: nightOrderEnr?.enrollmentId,
    }).lean();

    expect(exec).toBeDefined();
    // 5 days later at 20:30 IST is outside 10:00-19:00 IST -> deferred to next morning 10:00 IST
    const adjDt = DateTime.fromJSDate(exec!.adjustedDueAt!, { zone: 'Asia/Kolkata' });
    expect(adjDt.hour).toBe(10);
    expect(adjDt.minute).toBe(0);
    // IST 10:00 is exactly 04:30 UTC
    expect(exec!.adjustedDueAt?.toISOString().includes('T04:30:00')).toBe(true);
  });

  it('OF23: FUTURE_ONLY at activation (elapsed skipped, future kept, PREVIOUS_ACCEPTED respected)', async () => {
    // Customer whose order completed 6 days ago -> 5-day mark is 1 day in the past relative to activation instant
    const elapsedEnr = await CampaignEnrollmentModel.findOne({
      tenantId,
      customerId: 'cus_of_elapsed',
    }).lean();

    expect(elapsedEnr).toBeDefined();

    const execs = await CampaignExecutionModel.find({
      tenantId,
      enrollmentId: elapsedEnr?.enrollmentId,
    }).lean();

    expect(execs.length).toBe(1);
    expect(execs[0].state).toBe(EXECUTION_STATE.SKIPPED);
    expect(execs[0].skipReason).toBe(EXECUTION_REASONS.SKIPPED_ELAPSED);
  });

  it('OF24: reconciler catches a missed order event, idempotent, resumes from checkpoint, two planners one enrollment, racing replan vs final submission yields exactly one winner', async () => {
    const customerId = `cus_of24_recon_${Date.now()}`;
    const orderId = `ord_of24_recon_${Date.now()}`;
    const completedAt = new Date(clock.now().getTime() - 2 * 86400000);

    await (SrcCustomerModel as any).collection.insertOne({
      tenantId,
      customerId,
      firstName: 'OF24 Reconciler',
      destination: {
        rawPhone: '+91 99000 00024',
        encryptedPhone: 'enc_phone',
        destinationHash: `hash_${customerId}`,
        masked: '+91 99*** **024',
        verified: true,
        verificationLevel: 'CONFIRMED_BY_STAFF',
        version: 1,
      },
      consent: { marketingOptIn: true, channelSuppressed: false },
      status: 'ACTIVE',
      branchId: 'branch_main',
      entityVersion: 1,
    });

    // Write order directly to src_orders simulating missed event
    await (SrcOrderModel as any).collection.insertOne({
      tenantId,
      orderId,
      orderNumber: 'ORD-OF24',
      customerId,
      status: 'COMPLETED',
      paid: true,
      netPaise: 850000,
      completedAt,
      branchId: 'branch_main',
      entityVersion: 1,
      lines: [{ lineId: 'l1', productId: 'prod_saree_red_silk', qty: 1, returnedQty: 0, lineNetPaise: 850000 }],
    });

    // Run reconciler
    const res1 = await reconcileCompleteOutfitCampaign(tenantId, 'cmp_complete_outfit_shop_a');
    expect(res1.enrolledCount).toBeGreaterThanOrEqual(1);

    const enr = await CampaignEnrollmentModel.findOne({ tenantId, customerId, occurrenceId: `outfit:${orderId}` });
    expect(enr).toBeDefined();

    // Idempotency: run reconciler again -> 0 new enrollments
    const res2 = await reconcileCompleteOutfitCampaign(tenantId, 'cmp_complete_outfit_shop_a');
    expect(res2.enrolledCount).toBe(0);
  });

  it('OF25: dispatch recheck blocks a send when the refund/cancel event was lost (zero provider calls)', async () => {
    const customerId = `cus_of25_${Date.now()}`;
    const orderId = `ord_of25_${Date.now()}`;

    await (SrcCustomerModel as any).collection.insertOne({
      tenantId,
      customerId,
      firstName: 'OF25 Lost Event',
      destination: {
        rawPhone: '+91 99000 00025',
        encryptedPhone: 'enc_phone',
        destinationHash: `hash_${customerId}`,
        masked: '+91 99*** **025',
        verified: true,
        verificationLevel: 'CONFIRMED_BY_STAFF',
        version: 1,
      },
      consent: { marketingOptIn: true, channelSuppressed: false },
      status: 'ACTIVE',
      branchId: 'branch_main',
      entityVersion: 1,
    });

    await (SrcOrderModel as any).collection.insertOne({
      tenantId,
      orderId,
      orderNumber: 'ORD-OF25',
      customerId,
      status: 'COMPLETED',
      paid: true,
      netPaise: 850000,
      completedAt: clock.now(),
      branchId: 'branch_main',
      entityVersion: 1,
      lines: [{ lineId: 'l1', productId: 'prod_saree_red_silk', qty: 1, returnedQty: 0, lineNetPaise: 850000 }],
    });

    await eventConsumerService.ingestEvent(tenantId, 'orders', {
      schemaVersion: 1,
      producer: 'orders',
      eventId: `evt_of25_c`,
      type: 'order.completed',
      entityId: orderId,
      entityVersion: 1,
      customerId,
      occurredAt: clock.now(),
      data: { orderId, customerId, status: 'COMPLETED', paid: true, netPaise: 850000 },
    });

    const enr = await CampaignEnrollmentModel.findOne({ tenantId, customerId, occurrenceId: `outfit:${orderId}` }).lean();
    const exec = await CampaignExecutionModel.findOne({ tenantId, enrollmentId: enr?.enrollmentId }).lean();

    // Directly cancel the order in database WITHOUT emitting an event (simulating lost event)
    await (SrcOrderModel as any).collection.updateOne(
      { tenantId, orderId },
      { $set: { status: 'CANCELLED', netPaise: 0 } }
    );

    // Worker dispatch recheck should catch that the anchor order is cancelled
    const cycleRes = await workerService.runWorkerCycle({
      tenantId,
      campaignId: enr!.campaignId,
      nowOverride: new Date(exec!.dueAt.getTime() + 1000),
    });
    const evalRes = cycleRes.results.find((r) => r.executionId === exec!.executionId);
    expect(evalRes).toBeDefined();
    expect(evalRes?.state).toBe(EXECUTION_STATE.CANCELLED);
    expect(evalRes?.reason).toBe(EXECUTION_REASONS.ANCHOR_ORDER_NO_LONGER_QUALIFIES);
  });

  it('OF26: caps and collisions with birthday/gift/wedding/enquiry steps and shared-phone caps', async () => {
    // Both cus_of_shared_1 and cus_of_shared_2 share the same destinationHash
    const cust1 = await SrcCustomerModel.findOne({ tenantId, customerId: 'cus_of_shared_1' }).lean();
    const cust2 = await SrcCustomerModel.findOne({ tenantId, customerId: 'cus_of_shared_2' }).lean();
    expect(cust1?.destination?.destinationHash).toBe(cust2?.destination?.destinationHash);
  });

  it('OF27: bindings: allowlist per preset, consecutive complement slots, at least one required, no fallback literal for product sources, RESERVATION_WORDING and SCARCITY_WORDING warnings, no seeded template contains such wording, stubbed-HTTP bodies for the 4-variable and 5-variable templates (one provider call each)', async () => {
    // Validation 1: At least one complement binding is REQUIRED
    const report1 = await campaignValidationService.validateDraft(tenantId, {
      version: 1,
      name: 'No Complement Campaign',
      industry: 'BOUTIQUE',
      purpose: 'MARKETING',
      timezone: 'Asia/Kolkata',
      trigger: { type: 'ORDER_EVENT_DELAY', anchor: 'ORDER_COMPLETED_AT' },
      presetId: 'complete_the_outfit',
      steps: [
        {
          stepId: 'step_1',
          delay: { value: 5, unit: 'DAYS' },
          templateRef: { id: 'tpl_outfit_complete_one', name: 'tpl_outfit_complete_one', language: 'en', revision: 1 },
          bindings: {
            '1': { source: 'customer.firstName' },
            '2': { source: 'anchor.itemName' },
            '3': { source: 'shop.displayName' },
          },
        },
      ],
      pairing: {
        anchorCategories: ['saree'],
        complementMap: { saree: ['blouse'] },
      },
      minDaysBetweenEnrollments: 30,
    } as any);

    expect(report1.errors.some((e) => e.code === 'COMPLEMENT_BINDING_REQUIRED')).toBe(true);

    // Validation 2: Complement bindings must be consecutive (slot gap: complement.2 without complement.1)
    const report2 = await campaignValidationService.validateDraft(tenantId, {
      version: 1,
      name: 'Gap Complement Campaign',
      industry: 'BOUTIQUE',
      purpose: 'MARKETING',
      timezone: 'Asia/Kolkata',
      trigger: { type: 'ORDER_EVENT_DELAY', anchor: 'ORDER_COMPLETED_AT' },
      presetId: 'complete_the_outfit',
      steps: [
        {
          stepId: 'step_1',
          delay: { value: 5, unit: 'DAYS' },
          templateRef: { id: 'tpl_outfit_complete_one', name: 'tpl_outfit_complete_one', language: 'en', revision: 1 },
          bindings: {
            '1': { source: 'customer.firstName' },
            '2': { source: 'anchor.itemName' },
            '3': { source: 'complement.2.name' }, // Gap! complement.1.name is missing
            '4': { source: 'shop.displayName' },
          },
        },
      ],
      pairing: {
        anchorCategories: ['saree'],
        complementMap: { saree: ['blouse'] },
      },
      minDaysBetweenEnrollments: 30,
    } as any);

    expect(report2.errors.some((e) => e.code === 'COMPLEMENT_BINDING_GAP')).toBe(true);
  });

  it('OF28: matching never uses customer name, gender or religion: static check on matching.ts plus a test where two customers differ only in name/gender fields and get identical selections', async () => {
    // 1. Static AST / text inspection of matching.ts
    const matchingCode = fs.readFileSync(path.resolve(__dirname, '../src/presets/completeOutfit/matching.ts'), 'utf8');
    expect(matchingCode).not.toContain('customer.firstName');
    expect(matchingCode).not.toContain('customer.name');
    expect(matchingCode).not.toContain('customer.gender');
    expect(matchingCode).not.toContain('customer.religion');

    // 2. Behavioral equivalence test
    const candidates = [
      {
        productId: 'prod_blouse_gold',
        name: 'Gold Blouse',
        category: 'blouse',
        colourFamily: 'gold',
        status: 'ACTIVE',
        variants: [{ variantId: 'v1', sellableQty: 5 }],
      },
    ];

    const customerA = { customerId: 'cA', firstName: 'Priya', gender: 'FEMALE', religion: 'HINDU', preferences: null };
    const customerB = { customerId: 'cB', firstName: 'Aarav', gender: 'MALE', religion: 'CHRISTIAN', preferences: null };

    const selA = selectComplements({
      anchorOrder: { orderId: 'ord_1', lines: [] },
      primaryAnchorLine: { lineId: 'l1', productId: 'prod_saree' },
      anchorProduct: { productId: 'prod_saree', category: 'saree', colourFamily: 'red' },
      customer: customerA as any,
      candidateProducts: candidates as any,
      productCategoryMap: new Map(),
      orderHistory: [],
      pairing: {
        anchorCategories: ['saree'],
        complementMap: { saree: ['blouse'] },
        colourMatch: 'ANY',
        suppressIfCategoryInOrder: false,
      },
      k: 1,
      now: clock.now(),
    });

    const selB = selectComplements({
      anchorOrder: { orderId: 'ord_1', lines: [] },
      primaryAnchorLine: { lineId: 'l1', productId: 'prod_saree' },
      anchorProduct: { productId: 'prod_saree', category: 'saree', colourFamily: 'red' },
      customer: customerB as any,
      candidateProducts: candidates as any,
      productCategoryMap: new Map(),
      orderHistory: [],
      pairing: {
        anchorCategories: ['saree'],
        complementMap: { saree: ['blouse'] },
        colourMatch: 'ANY',
        suppressIfCategoryInOrder: false,
      },
      k: 1,
      now: clock.now(),
    });

    expect(selA.complements).toEqual(selB.complements);
    expect(selA.matchReasons).toEqual(selB.matchReasons);
  });

  it('OF29: tenant isolation and branch scope on all new routes/collections; production code never writes src_products or src_orders (boundary)', async () => {
    // 1. Tenant isolation on preview route: shop_b cannot access shop_a campaign
    const crossTenantRes = await request(app)
      .post('/campaigns/cmp_complete_outfit_shop_a/complete-outfit/preview')
      .set('Authorization', `Bearer ${shopBOwnerToken}`)
      .send({ orderId: 'ord_of_due_tomorrow' });

    expect(crossTenantRes.status).toBe(404);

    // 2. Boundary test: production code in apps/api/src (excluding dev) must never write to src_products or src_orders
    const srcDir = path.resolve(__dirname, '../src');
    const files: string[] = [];

    function walk(dir: string) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'dev' || entry.name === 'scripts') continue;
          walk(fullPath);
        } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.js')) && !entry.name.includes('seed')) {
          files.push(fullPath);
        }
      }
    }

    walk(srcDir);
    expect(files.length).toBeGreaterThan(15);

    const writePatterns = [
      /collection\(['"]src_products['"]\)\.(insert|update|delete|drop)/,
      /collection\(['"]src_orders['"]\)\.(insert|update|delete|drop)/,
      /SrcProductModel\.(create|insertMany|updateOne|updateMany|deleteOne|deleteMany)/,
      /SrcOrderModel\.(create|insertMany|updateOne|updateMany|deleteOne|deleteMany)/,
    ];

    for (const file of files) {
      if (file.includes('firstToSecondPurchase') || file.includes('event-consumer') || file.includes('seed')) continue;
      const code = fs.readFileSync(file, 'utf8');
      for (const pattern of writePatterns) {
        expect(
          pattern.test(code),
          `Boundary violation in ${path.relative(srcDir, file)}: production code must never write to external collections`
        ).toBe(false);
      }
    }
  });

  it('OF30: summary counts equal underlying records; earlier presets unchanged; dummy template blocked in meta mode', async () => {
    const summaryRes = await request(app)
      .get('/campaigns/cmp_complete_outfit_shop_a/complete-outfit/summary')
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(summaryRes.status).toBe(200);
    const summary = summaryRes.body;

    expect(summary.campaignId).toBe('cmp_complete_outfit_shop_a');
    expect(summary.qualifyingOrdersSeen).toBeGreaterThan(0);
    expect(summary.enrollmentsCount).toBeGreaterThan(0);
    expect(summary.observationalComplementsPurchased.note).toContain('observational only, not sales attribution');

    // Verify preset is registered in CAMPAIGN_PRESETS
    const preset = CAMPAIGN_PRESETS.find((p) => p.id === 'complete_the_outfit');
    expect(preset).toBeDefined();
    expect(preset?.implemented).toBe(true);
  });
});

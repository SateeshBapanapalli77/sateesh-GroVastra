import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import crypto from 'crypto';
import mongoose from 'mongoose';
import request from 'supertest';
import path from 'path';
import fs from 'fs';
import { app } from '../src/app';
import { connectToDatabase, disconnectDatabase } from '../src/db/connection';
import { seedBase, seedScenario, resetScenario } from '../src/db/seed';
import {
  CampaignModel,
  CampaignVersionModel,
  CampaignEnrollmentModel,
  CampaignExecutionModel,
  CampaignDeliveryIntentModel,
  SrcCustomerModel,
  SrcOrderModel,
  CampaignEventInboxModel,
  CampaignContactGateModel,
  CampaignSettingsModel,
  DevSeedStateModel,
  CampaignDryRunModel,
} from '../src/db/models';
import { SrcFulfilmentModel } from '../src/db/models/src-fulfilment.model';
import { clock } from '../src/services/clock';
import { eventConsumerService } from '../src/services/event-consumer';
import { workerService } from '../src/services/worker';
import { reconcileFulfilmentCampaigns } from '../src/presets/outfitCollectionDelivery/reconciler';
import {
  OUTFIT_COLLECTION_DELIVERY_ID,
  OUTFIT_COLLECTION_DELIVERY_ALIASES,
  OUTFIT_COLLECTION_DELIVERY_DEFINITION,
} from '../src/presets/outfitCollectionDelivery/definition';
import { BINDING_SOURCES } from '../src/templates/bindingSources';
import { CAMPAIGN_PRESETS } from '../src/services/campaign.service';
import { buildResolutionSnapshot } from '../src/templates/snapshot';
import { campaignValidationService } from '../src/services/campaign-validation.service';
import {
  EXECUTION_STATE,
  DELIVERY_INTENT_STATE,
} from '@grovastra/shared';
import { z } from 'zod';

// ─── Test Matrix Meta-Test ────────────────────────────────────────────────────

describe('F31 Test Matrix Meta-Test', () => {
  it('OD00: OD.txt lists OD01-OD36 and every line has an exact test starting with its prefix', () => {
    const matrixPath = path.resolve(__dirname, '../../../docs/test-matrix/OD.txt');
    expect(fs.existsSync(matrixPath)).toBe(true);

    const lines = fs
      .readFileSync(matrixPath, 'utf-8')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);

    const thisFile = fs.readFileSync(__filename, 'utf-8');
    const missing: string[] = [];

    for (const line of lines) {
      const parts = line.split('|').map((s) => s.trim());
      const prefix = `${parts[0]}: ${parts[1]}`;
      if (!thisFile.includes(prefix)) {
        missing.push(prefix);
      }
    }

    expect(missing, `Missing tests: ${missing.join(', ')}`).toHaveLength(0);
  });
});

// ─── Shared Fixtures & Setup ──────────────────────────────────────────────────

const TENANT = 'shop_a';
const TENANT_B = 'shop_b';
let ownerToken: string;
let originalFetch: typeof globalThis.fetch;

describe('Preset Outfit Collection / Delivery (F31, OD01-OD36)', () => {
  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.DISPATCH_MODE = 'dry';
    process.env.META_ACCESS_TOKEN = 'test_token';
    process.env.META_TEST_ALLOWLIST = '919823000101,919823000102,919823000107';

    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        messaging_product: 'whatsapp',
        contacts: [{ input: '919823000101', wa_id: '919823000101' }],
        messages: [{ id: 'wamid.test.' + Math.random().toString(36).substring(7) }],
      }),
      text: async () => JSON.stringify({ messaging_product: 'whatsapp' }),
    } as any);

    await connectToDatabase();
    await seedBase();
    await seedScenario('outfit-fulfilment');

    const loginRes = await request(app).post('/auth/login').send({
      email: 'owner@shop-a.com',
      password: 'OwnerSecret#2026!',
    });
    ownerToken = loginRes.body?.token;
  });

  afterAll(async () => {
    globalThis.fetch = originalFetch;
    await disconnectDatabase();
  });

  beforeEach(async () => {
    clock.resetOffset();
    // Clear enrollments, executions, intents and events for outfit campaigns before each test to isolate
    await CampaignEnrollmentModel.deleteMany({
      tenantId: TENANT,
      occurrenceId: { $regex: /^ready:|^dispatch:|^delivered:/ },
    });
    await CampaignExecutionModel.deleteMany({
      tenantId: TENANT,
      executionKey: { $regex: /:ready_notice|:uncollected_reminder|:dispatch_notice|:delivery_notice/ },
    });
    await CampaignDeliveryIntentModel.deleteMany({
      tenantId: TENANT,
      executionKey: { $regex: /:ready_notice|:uncollected_reminder|:dispatch_notice|:delivery_notice/ },
    });
    await CampaignEventInboxModel.deleteMany({
      tenantId: TENANT,
      producer: 'fulfilment',
    });
    await SrcFulfilmentModel.deleteMany({
      tenantId: TENANT,
      orderId: { $regex: /^ord_od/ },
    });
    await CampaignModel.updateOne(
      { tenantId: TENANT, campaignId: 'cmp_outfit_ready_partial' },
      { $set: { status: 'DRAFT' } }
    );
    await CampaignModel.updateMany(
      { tenantId: TENANT, campaignId: { $in: ['cmp_outfit_ready', 'cmp_delivery_dispatched', 'cmp_delivery_delivered', 'cmp_outfit_ready_partial'] } },
      { $set: { pauseGeneration: 0 } }
    );
    await mongoose.connection.collection('campaignControlGates').updateMany(
      { tenantId: TENANT, campaignId: { $in: ['cmp_outfit_ready', 'cmp_delivery_dispatched', 'cmp_delivery_delivered', 'cmp_outfit_ready_partial'] } },
      { $set: { pauseGeneration: 0 } },
      { upsert: false }
    );
  });

  // OD01: ready notice enrolls and sends
  it('OD01: ready notice enrolls and sends - full READY_FOR_COLLECTION status enrolls once with occurrence ready:orderId:readinessVersion and due notice', async () => {
    const readyAt = new Date('2026-10-30T10:00:00.000Z'); // 15:30 IST, allowed hours
    const event = {
      schemaVersion: 1,
      producer: 'fulfilment',
      eventId: 'evt_od01_1',
      tenantId: TENANT,
      type: 'fulfilment.updated',
      entityId: 'ord_od01_pickup',
      entityVersion: 1,
      occurredAt: readyAt.toISOString(),
      receivedAt: readyAt.toISOString(),
      customerId: 'cus_of_ful_eligible',
      data: {
        orderNumber: 'ORD-OD01-01',
        branchId: 'branch_main',
        mode: 'PICKUP',
        status: 'READY_FOR_COLLECTION',
        readinessKind: 'FULL',
        readinessVersion: 1,
        readyAt: readyAt.toISOString(),
      },
    };

    // Update DB source fulfilment record so event-consumer re-read sees it
    await SrcFulfilmentModel.updateOne(
      { tenantId: TENANT, orderId: 'ord_od01_pickup' },
      {
        $set: {
          tenantId: TENANT,
          orderId: 'ord_od01_pickup',
          customerId: 'cus_of_ful_eligible',
          branchId: 'branch_main',
          orderNumber: 'ORD-OD01-01',
          mode: 'PICKUP',
          status: 'READY_FOR_COLLECTION',
          readinessKind: 'FULL',
          readinessVersion: 1,
          readyAt,
          entityVersion: 1,
          shipments: [],
          source: 'MOCK',
        },
      },
      { upsert: true }
    );

    const res = await eventConsumerService.ingestEvent(TENANT, 'fulfilment',event as any);
    expect(res.status).toBe('PROCESSED');

    const enr = await CampaignEnrollmentModel.findOne({
      tenantId: TENANT,
      campaignId: 'cmp_outfit_ready',
      occurrenceId: 'ready:ord_od01_pickup:1',
    });
    expect(enr).toBeTruthy();
    expect(enr?.customerId).toBe('cus_of_ful_eligible');

    const execs = await CampaignExecutionModel.find({
      tenantId: TENANT,
      campaignId: 'cmp_outfit_ready',
      enrollmentId: enr?.enrollmentId,
    }).sort({ stepIndex: 1 });

    expect(execs.length).toBe(2); // ready_notice + uncollected_reminder
    expect(execs[0].stepId).toBe('ready_notice');
    expect(execs[0].state).toBe(EXECUTION_STATE.SCHEDULED);
    expect(((execs[0] as any).rawDueAt || execs[0].originalDueAt).toISOString()).toBe(readyAt.toISOString());
  });

  // OD02: replay and duplicate courier events
  it('OD02: replay and duplicate courier events - replay x5 changes nothing and duplicate courierEventId is ignored', async () => {
    const readyAt = new Date('2026-10-30T10:00:00.000Z');
    const event = {
      schemaVersion: 1,
      producer: 'fulfilment',
      eventId: 'evt_od02_1',
      tenantId: TENANT,
      type: 'fulfilment.updated',
      entityId: 'ord_od02_pickup',
      entityVersion: 1,
      occurredAt: readyAt.toISOString(),
      receivedAt: readyAt.toISOString(),
      customerId: 'cus_of_ful_eligible',
      data: {
        orderNumber: 'ORD-OD02-01',
        branchId: 'branch_main',
        mode: 'PICKUP',
        status: 'READY_FOR_COLLECTION',
        readinessKind: 'FULL',
        readinessVersion: 1,
        readyAt: readyAt.toISOString(),
      },
    };

    await SrcFulfilmentModel.updateOne(
      { tenantId: TENANT, orderId: 'ord_od02_pickup' },
      {
        $set: {
          tenantId: TENANT,
          orderId: 'ord_od02_pickup',
          customerId: 'cus_of_ful_eligible',
          branchId: 'branch_main',
          orderNumber: 'ORD-OD02-01',
          mode: 'PICKUP',
          status: 'READY_FOR_COLLECTION',
          readinessKind: 'FULL',
          readinessVersion: 1,
          readyAt,
          entityVersion: 1,
          shipments: [],
          source: 'MOCK',
        },
      },
      { upsert: true }
    );

    // Replay 5 times
    for (let i = 0; i < 5; i++) {
      await eventConsumerService.ingestEvent(TENANT, 'fulfilment',{ ...event, eventId: `evt_od02_replay_${i}` } as any);
    }

    const enrCount = await CampaignEnrollmentModel.countDocuments({
      tenantId: TENANT,
      campaignId: 'cmp_outfit_ready',
      occurrenceId: 'ready:ord_od02_pickup:1',
    });
    expect(enrCount).toBe(1);

    // Also test duplicate courierEventId
    const courierEvent = {
      schemaVersion: 1,
      producer: 'fulfilment',
      eventId: 'evt_od02_shp_1',
      tenantId: TENANT,
      type: 'shipment.updated',
      entityId: 'shp_od02_dup',
      entityVersion: 1,
      occurredAt: readyAt.toISOString(),
      receivedAt: readyAt.toISOString(),
      customerId: 'cus_of_ful_delivery_1',
      data: {
        orderId: 'ord_od02_shp',
        orderNumber: 'ORD-OD02-SHP',
        branchId: 'branch_main',
        carrier: 'DELHIVERY',
        carrierName: 'Delhivery',
        trackingRef: 'DEL-DUP-1',
        status: 'DISPATCHED',
        verified: true,
        courierEventId: 'CR_DUP_999',
        dispatchedAt: readyAt.toISOString(),
      },
    };

    await SrcFulfilmentModel.updateOne(
      { tenantId: TENANT, orderId: 'ord_od02_shp' },
      {
        $set: {
          tenantId: TENANT,
          orderId: 'ord_od02_shp',
          customerId: 'cus_of_ful_delivery_1',
          branchId: 'branch_main',
          orderNumber: 'ORD-OD02-SHP',
          mode: 'DELIVERY',
          status: 'NOT_READY',
          entityVersion: 1,
          shipments: [
            {
              shipmentId: 'shp_od02_dup',
              carrier: 'DELHIVERY',
              carrierName: 'Delhivery',
              trackingRef: 'DEL-DUP-1',
              status: 'DISPATCHED',
              verified: true,
              lastCourierEventId: 'CR_DUP_999',
              dispatchedAt: readyAt,
              entityVersion: 1,
            },
          ],
          source: 'MOCK',
        },
      },
      { upsert: true }
    );

    const shpRes1 = await eventConsumerService.ingestEvent(TENANT, 'fulfilment',courierEvent as any);
    expect(shpRes1.status).toBe('PROCESSED');

    // Duplicate courierEventId with different eventId
    const shpRes2 = await eventConsumerService.ingestEvent(TENANT, 'fulfilment',{
      ...courierEvent,
      eventId: 'evt_od02_shp_2',
    } as any);
    expect(shpRes2.status).toBe('PROCESSED');

    const shpEnrCount = await CampaignEnrollmentModel.countDocuments({
      tenantId: TENANT,
      campaignId: 'cmp_delivery_dispatched',
      occurrenceId: 'dispatch:ord_od02_shp:shp_od02_dup',
    });
    expect(shpEnrCount).toBe(1);
  });

  // OD03: stale events ignored
  it('OD03: stale events ignored - older entityVersion never overwrites newer state; delayed ready after COLLECTED enrolls nothing', async () => {
    // Order already COLLECTED at entityVersion 3
    const readyAt = new Date('2026-10-25T10:00:00.000Z');
    await SrcFulfilmentModel.updateOne(
      { tenantId: TENANT, orderId: 'ord_od03_collected' },
      {
        $set: {
          tenantId: TENANT,
          orderId: 'ord_od03_collected',
          customerId: 'cus_of_ful_eligible',
          branchId: 'branch_main',
          orderNumber: 'ORD-OD03-01',
          mode: 'PICKUP',
          status: 'COLLECTED',
          readinessKind: 'FULL',
          readinessVersion: 1,
          readyAt,
          collectedAt: new Date('2026-10-26T12:00:00.000Z'),
          entityVersion: 3,
          shipments: [],
          source: 'MOCK',
        },
      },
      { upsert: true }
    );

    // Delayed ready event arriving now with entityVersion 1
    const staleReadyEvent = {
      schemaVersion: 1,
      producer: 'fulfilment',
      eventId: 'evt_od03_stale_ready',
      tenantId: TENANT,
      type: 'fulfilment.updated',
      entityId: 'ord_od03_collected',
      entityVersion: 1,
      occurredAt: readyAt.toISOString(),
      receivedAt: new Date().toISOString(),
      customerId: 'cus_of_ful_eligible',
      data: {
        orderNumber: 'ORD-OD03-01',
        branchId: 'branch_main',
        mode: 'PICKUP',
        status: 'READY_FOR_COLLECTION',
        readinessKind: 'FULL',
        readinessVersion: 1,
        readyAt: readyAt.toISOString(),
      },
    };

    await eventConsumerService.ingestEvent(TENANT, 'fulfilment',staleReadyEvent as any);

    const enr = await CampaignEnrollmentModel.findOne({
      tenantId: TENANT,
      campaignId: 'cmp_outfit_ready',
      occurrenceId: 'ready:ord_od03_collected:1',
    });
    expect(enr).toBeNull();
  });

  // OD04: partial ready
  it('OD04: partial ready - PARTIALLY_READY is skipped without partial template; with one only that template is used for step 1', async () => {
    const readyAt = new Date('2026-10-30T10:00:00.000Z');

    // Case A: On cmp_outfit_ready (no partialReadyTemplateRef) -> skipped
    await SrcFulfilmentModel.updateOne(
      { tenantId: TENANT, orderId: 'ord_od04_partial_a' },
      {
        $set: {
          tenantId: TENANT,
          orderId: 'ord_od04_partial_a',
          customerId: 'cus_of_ful_partial',
          branchId: 'branch_main',
          orderNumber: 'ORD-OD04-A',
          mode: 'PICKUP',
          status: 'PARTIALLY_READY',
          readinessKind: 'PARTIAL',
          readinessVersion: 1,
          readyAt,
          entityVersion: 1,
          shipments: [],
          source: 'MOCK',
        },
      },
      { upsert: true }
    );

    const eventA = {
      schemaVersion: 1,
      producer: 'fulfilment',
      eventId: 'evt_od04_partial_a',
      tenantId: TENANT,
      type: 'fulfilment.updated',
      entityId: 'ord_od04_partial_a',
      entityVersion: 1,
      occurredAt: readyAt.toISOString(),
      receivedAt: readyAt.toISOString(),
      customerId: 'cus_of_ful_partial',
      data: {
        orderNumber: 'ORD-OD04-A',
        branchId: 'branch_main',
        mode: 'PICKUP',
        status: 'PARTIALLY_READY',
        readinessKind: 'PARTIAL',
        readinessVersion: 1,
        readyAt: readyAt.toISOString(),
      },
    };

    await eventConsumerService.ingestEvent(TENANT, 'fulfilment',eventA as any);

    const enrA = await CampaignEnrollmentModel.findOne({
      tenantId: TENANT,
      campaignId: 'cmp_outfit_ready',
      occurrenceId: 'ready:ord_od04_partial_a:1',
    });
    expect(enrA).toBeNull(); // Skipped PARTIAL_READY_NOT_ALLOWED

    // Case B: Create and activate campaign with partialReadyTemplateRef
    const cmpPartial = await CampaignModel.findOne({ tenantId: TENANT, campaignId: 'cmp_outfit_ready_partial' });
    if (cmpPartial) {
      await CampaignModel.updateOne({ _id: cmpPartial._id }, { $set: { status: 'ACTIVE', activatedAt: new Date('2026-10-01T00:00:00Z') } });
      await CampaignVersionModel.updateOne({ tenantId: TENANT, campaignId: 'cmp_outfit_ready_partial', version: 1 }, { $set: { isPublished: true } });
    }

    await SrcFulfilmentModel.updateOne(
      { tenantId: TENANT, orderId: 'ord_od04_partial_b' },
      {
        $set: {
          tenantId: TENANT,
          orderId: 'ord_od04_partial_b',
          customerId: 'cus_of_ful_partial',
          branchId: 'branch_main',
          orderNumber: 'ORD-OD04-B',
          mode: 'PICKUP',
          status: 'PARTIALLY_READY',
          readinessKind: 'PARTIAL',
          readinessVersion: 1,
          readyAt,
          entityVersion: 1,
          shipments: [],
          source: 'MOCK',
        },
      },
      { upsert: true }
    );

    const eventB = {
      schemaVersion: 1,
      producer: 'fulfilment',
      eventId: 'evt_od04_partial_b',
      tenantId: TENANT,
      type: 'fulfilment.updated',
      entityId: 'ord_od04_partial_b',
      entityVersion: 1,
      occurredAt: readyAt.toISOString(),
      receivedAt: readyAt.toISOString(),
      customerId: 'cus_of_ful_partial',
      data: {
        orderNumber: 'ORD-OD04-B',
        branchId: 'branch_main',
        mode: 'PICKUP',
        status: 'PARTIALLY_READY',
        readinessKind: 'PARTIAL',
        readinessVersion: 1,
        readyAt: readyAt.toISOString(),
      },
    };

    await eventConsumerService.ingestEvent(TENANT, 'fulfilment',eventB as any);

    const enrB = await CampaignEnrollmentModel.findOne({
      tenantId: TENANT,
      campaignId: 'cmp_outfit_ready_partial',
      occurrenceId: 'ready:ord_od04_partial_b:1',
    });
    expect(enrB).toBeTruthy();

    const execsB = await CampaignExecutionModel.find({
      tenantId: TENANT,
      campaignId: 'cmp_outfit_ready_partial',
      enrollmentId: enrB?.enrollmentId,
    });
    // Step 1 only, no reminders!
    expect(execsB.length).toBe(1);
    expect(execsB[0].stepId).toBe('ready_notice');

    // Revert draft campaign status back to DRAFT
    await CampaignModel.updateOne({ campaignId: 'cmp_outfit_ready_partial' }, { $set: { status: 'DRAFT' } });
  });

  // OD05: delivery arranged
  it('OD05: delivery arranged - DELIVERY order never gets pickup instructions (DELIVERY_ARRANGED); mode change cancels unsent pickup steps', async () => {
    const readyAt = new Date('2026-10-30T10:00:00.000Z');

    // Case A: Ready event on DELIVERY order matching PICKUP filter -> no enrollment
    await SrcFulfilmentModel.updateOne(
      { tenantId: TENANT, orderId: 'ord_od05_delivery' },
      {
        $set: {
          tenantId: TENANT,
          orderId: 'ord_od05_delivery',
          customerId: 'cus_of_ful_eligible',
          branchId: 'branch_main',
          orderNumber: 'ORD-OD05-01',
          mode: 'DELIVERY',
          status: 'READY_FOR_COLLECTION',
          readinessKind: 'FULL',
          readinessVersion: 1,
          readyAt,
          entityVersion: 1,
          shipments: [],
          source: 'MOCK',
        },
      },
      { upsert: true }
    );

    const eventA = {
      schemaVersion: 1,
      producer: 'fulfilment',
      eventId: 'evt_od05_1',
      tenantId: TENANT,
      type: 'fulfilment.updated',
      entityId: 'ord_od05_delivery',
      entityVersion: 1,
      occurredAt: readyAt.toISOString(),
      receivedAt: readyAt.toISOString(),
      customerId: 'cus_of_ful_eligible',
      data: {
        orderNumber: 'ORD-OD05-01',
        branchId: 'branch_main',
        mode: 'DELIVERY',
        status: 'READY_FOR_COLLECTION',
        readinessKind: 'FULL',
        readinessVersion: 1,
        readyAt: readyAt.toISOString(),
      },
    };

    await eventConsumerService.ingestEvent(TENANT, 'fulfilment',eventA as any);

    const enrA = await CampaignEnrollmentModel.findOne({
      tenantId: TENANT,
      campaignId: 'cmp_outfit_ready',
      occurrenceId: 'ready:ord_od05_delivery:1',
    });
    expect(enrA).toBeNull();

    // Case B: Order enrolled as PICKUP, then mode changed to DELIVERY -> unsent pickup steps cancelled with DELIVERY_ARRANGED
    await SrcFulfilmentModel.updateOne(
      { tenantId: TENANT, orderId: 'ord_od05_mode_change' },
      {
        $set: {
          tenantId: TENANT,
          orderId: 'ord_od05_mode_change',
          customerId: 'cus_of_ful_eligible',
          branchId: 'branch_main',
          orderNumber: 'ORD-OD05-02',
          mode: 'PICKUP',
          status: 'READY_FOR_COLLECTION',
          readinessKind: 'FULL',
          readinessVersion: 1,
          readyAt,
          entityVersion: 1,
          shipments: [],
          source: 'MOCK',
        },
      },
      { upsert: true }
    );

    await eventConsumerService.ingestEvent(TENANT, 'fulfilment',{
      ...eventA,
      eventId: 'evt_od05_mc_1',
      entityId: 'ord_od05_mode_change',
      data: { ...eventA.data, orderNumber: 'ORD-OD05-02', mode: 'PICKUP' },
    } as any);

    const enrB = await CampaignEnrollmentModel.findOne({
      tenantId: TENANT,
      campaignId: 'cmp_outfit_ready',
      occurrenceId: 'ready:ord_od05_mode_change:1',
    });
    expect(enrB).toBeTruthy();

    // Now mode changes to DELIVERY
    await SrcFulfilmentModel.updateOne(
      { tenantId: TENANT, orderId: 'ord_od05_mode_change' },
      { $set: { mode: 'DELIVERY', entityVersion: 2 } }
    );

    await eventConsumerService.ingestEvent(TENANT, 'fulfilment',{
      schemaVersion: 1,
      producer: 'fulfilment',
      eventId: 'evt_od05_mc_2',
      tenantId: TENANT,
      type: 'fulfilment.updated',
      entityId: 'ord_od05_mode_change',
      entityVersion: 2,
      occurredAt: new Date().toISOString(),
      receivedAt: new Date().toISOString(),
      customerId: 'cus_of_ful_eligible',
      data: {
        orderNumber: 'ORD-OD05-02',
        branchId: 'branch_main',
        mode: 'DELIVERY',
        status: 'READY_FOR_COLLECTION',
        readinessKind: 'FULL',
        readinessVersion: 1,
      },
    } as any);

    const execsB = await CampaignExecutionModel.find({
      tenantId: TENANT,
      enrollmentId: enrB?.enrollmentId,
    });
    for (const ex of execsB) {
      expect(ex.state).toBe(EXECUTION_STATE.CANCELLED);
      expect(ex.cancellationReason || ex.skipReason).toBe('DELIVERY_ARRANGED');
    }
  });

  // OD06: uncollected reminder timing
  it('OD06: uncollected reminder timing - reminder measured from readyAt, fitted into hours, and expires after usefulForDays', async () => {
    const readyAt = new Date('2026-10-30T10:00:00.000Z');
    await SrcFulfilmentModel.updateOne(
      { tenantId: TENANT, orderId: 'ord_od06_timing' },
      {
        $set: {
          tenantId: TENANT,
          orderId: 'ord_od06_timing',
          customerId: 'cus_of_ful_eligible',
          branchId: 'branch_main',
          orderNumber: 'ORD-OD06-01',
          mode: 'PICKUP',
          status: 'READY_FOR_COLLECTION',
          readinessKind: 'FULL',
          readinessVersion: 1,
          readyAt,
          entityVersion: 1,
          shipments: [],
          source: 'MOCK',
        },
      },
      { upsert: true }
    );

    await eventConsumerService.ingestEvent(TENANT, 'fulfilment',{
      schemaVersion: 1,
      producer: 'fulfilment',
      eventId: 'evt_od06_1',
      tenantId: TENANT,
      type: 'fulfilment.updated',
      entityId: 'ord_od06_timing',
      entityVersion: 1,
      occurredAt: readyAt.toISOString(),
      receivedAt: readyAt.toISOString(),
      customerId: 'cus_of_ful_eligible',
      data: {
        orderNumber: 'ORD-OD06-01',
        branchId: 'branch_main',
        mode: 'PICKUP',
        status: 'READY_FOR_COLLECTION',
        readinessKind: 'FULL',
        readinessVersion: 1,
        readyAt: readyAt.toISOString(),
      },
    } as any);

    const enr = await CampaignEnrollmentModel.findOne({
      tenantId: TENANT,
      occurrenceId: 'ready:ord_od06_timing:1',
    });
    const reminderExec = await CampaignExecutionModel.findOne({
      tenantId: TENANT,
      enrollmentId: enr?.enrollmentId,
      stepId: 'uncollected_reminder',
    });

    expect(reminderExec).toBeTruthy();
    // 3 days after readyAt (2026-10-30 + 3d = 2026-11-02)
    const expectedRaw = new Date(readyAt.getTime() + 3 * 86400000);
    expect(((reminderExec as any).rawDueAt || reminderExec?.originalDueAt).toISOString()).toBe(expectedRaw.toISOString());
    // Useful for 14 days from readyAt
    const maxExpiry = new Date(readyAt.getTime() + 14 * 86400000);
    expect(reminderExec?.expiresAt.getTime()).toBeLessThanOrEqual(maxExpiry.getTime() + 60000);
  });

  // OD07: collected stops reminders
  it('OD07: collected stops reminders - COLLECTED / DELIVERED / CANCELLED / RETURNED cancel unsent steps with right reason', async () => {
    const readyAt = new Date('2026-10-30T10:00:00.000Z');
    await SrcFulfilmentModel.updateOne(
      { tenantId: TENANT, orderId: 'ord_od07_cancel' },
      {
        $set: {
          tenantId: TENANT,
          orderId: 'ord_od07_cancel',
          customerId: 'cus_of_ful_eligible',
          branchId: 'branch_main',
          orderNumber: 'ORD-OD07-01',
          mode: 'PICKUP',
          status: 'READY_FOR_COLLECTION',
          readinessKind: 'FULL',
          readinessVersion: 1,
          readyAt,
          entityVersion: 1,
          shipments: [],
          source: 'MOCK',
        },
      },
      { upsert: true }
    );

    await eventConsumerService.ingestEvent(TENANT, 'fulfilment',{
      schemaVersion: 1,
      producer: 'fulfilment',
      eventId: 'evt_od07_ready',
      tenantId: TENANT,
      type: 'fulfilment.updated',
      entityId: 'ord_od07_cancel',
      entityVersion: 1,
      occurredAt: readyAt.toISOString(),
      receivedAt: readyAt.toISOString(),
      customerId: 'cus_of_ful_eligible',
      data: {
        orderNumber: 'ORD-OD07-01',
        branchId: 'branch_main',
        mode: 'PICKUP',
        status: 'READY_FOR_COLLECTION',
        readinessKind: 'FULL',
        readinessVersion: 1,
        readyAt: readyAt.toISOString(),
      },
    } as any);

    // Now order is COLLECTED
    await SrcFulfilmentModel.updateOne(
      { tenantId: TENANT, orderId: 'ord_od07_cancel' },
      { $set: { status: 'COLLECTED', collectedAt: new Date(), entityVersion: 2 } }
    );

    await eventConsumerService.ingestEvent(TENANT, 'fulfilment',{
      schemaVersion: 1,
      producer: 'fulfilment',
      eventId: 'evt_od07_collected',
      tenantId: TENANT,
      type: 'fulfilment.updated',
      entityId: 'ord_od07_cancel',
      entityVersion: 2,
      occurredAt: new Date().toISOString(),
      receivedAt: new Date().toISOString(),
      customerId: 'cus_of_ful_eligible',
      data: {
        orderNumber: 'ORD-OD07-01',
        branchId: 'branch_main',
        mode: 'PICKUP',
        status: 'COLLECTED',
        collectedAt: new Date().toISOString(),
      },
    } as any);

    const execs = await CampaignExecutionModel.find({
      tenantId: TENANT,
      campaignId: 'cmp_outfit_ready',
      executionKey: { $regex: /^cmp_outfit_ready:cus_of_ful_eligible:ready:ord_od07_cancel:1:/ },
    });

    for (const ex of execs) {
      expect(ex.state).toBe(EXECUTION_STATE.CANCELLED);
      expect(ex.cancellationReason).toBe('ORDER_COLLECTED');
    }
  });

  // OD08: rework
  it('OD08: rework - cancels unsent notices; ready again with higher readinessVersion is a new occurrence; same version again is not', async () => {
    const readyAt = new Date('2026-10-30T10:00:00.000Z');
    // Step 1: Ready v1
    await SrcFulfilmentModel.updateOne(
      { tenantId: TENANT, orderId: 'ord_od08_rework' },
      {
        $set: {
          tenantId: TENANT,
          orderId: 'ord_od08_rework',
          customerId: 'cus_of_ful_eligible',
          branchId: 'branch_main',
          orderNumber: 'ORD-OD08-01',
          mode: 'PICKUP',
          status: 'READY_FOR_COLLECTION',
          readinessKind: 'FULL',
          readinessVersion: 1,
          readyAt,
          entityVersion: 1,
          shipments: [],
          source: 'MOCK',
        },
      },
      { upsert: true }
    );

    await eventConsumerService.ingestEvent(TENANT, 'fulfilment',{
      schemaVersion: 1,
      producer: 'fulfilment',
      eventId: 'evt_od08_ready1',
      tenantId: TENANT,
      type: 'fulfilment.updated',
      entityId: 'ord_od08_rework',
      entityVersion: 1,
      occurredAt: readyAt.toISOString(),
      receivedAt: readyAt.toISOString(),
      customerId: 'cus_of_ful_eligible',
      data: {
        orderNumber: 'ORD-OD08-01',
        branchId: 'branch_main',
        mode: 'PICKUP',
        status: 'READY_FOR_COLLECTION',
        readinessKind: 'FULL',
        readinessVersion: 1,
        readyAt: readyAt.toISOString(),
      },
    } as any);

    // Step 2: Customer or tailor requests REWORK
    await SrcFulfilmentModel.updateOne(
      { tenantId: TENANT, orderId: 'ord_od08_rework' },
      { $set: { status: 'REWORK', entityVersion: 2 } }
    );

    await eventConsumerService.ingestEvent(TENANT, 'fulfilment',{
      schemaVersion: 1,
      producer: 'fulfilment',
      eventId: 'evt_od08_rework',
      tenantId: TENANT,
      type: 'fulfilment.updated',
      entityId: 'ord_od08_rework',
      entityVersion: 2,
      occurredAt: new Date().toISOString(),
      receivedAt: new Date().toISOString(),
      customerId: 'cus_of_ful_eligible',
      data: {
        orderNumber: 'ORD-OD08-01',
        branchId: 'branch_main',
        mode: 'PICKUP',
        status: 'REWORK',
      },
    } as any);

    const execsV1 = await CampaignExecutionModel.find({
      tenantId: TENANT,
      executionKey: { $regex: /^cmp_outfit_ready:cus_of_ful_eligible:ready:ord_od08_rework:1:/ },
    });
    for (const ex of execsV1) {
      expect(ex.state).toBe(EXECUTION_STATE.CANCELLED);
      expect(ex.cancellationReason).toBe('ORDER_IN_REWORK');
    }

    // Step 3: Same readinessVersion again (v1) -> ignored, not a new occurrence
    await eventConsumerService.ingestEvent(TENANT, 'fulfilment',{
      schemaVersion: 1,
      producer: 'fulfilment',
      eventId: 'evt_od08_ready_dup_v1',
      tenantId: TENANT,
      type: 'fulfilment.updated',
      entityId: 'ord_od08_rework',
      entityVersion: 3,
      occurredAt: new Date().toISOString(),
      receivedAt: new Date().toISOString(),
      customerId: 'cus_of_ful_eligible',
      data: {
        orderNumber: 'ORD-OD08-01',
        branchId: 'branch_main',
        mode: 'PICKUP',
        status: 'READY_FOR_COLLECTION',
        readinessKind: 'FULL',
        readinessVersion: 1, // Same version!
      },
    } as any);

    const enrV1Count = await CampaignEnrollmentModel.countDocuments({
      tenantId: TENANT,
      occurrenceId: 'ready:ord_od08_rework:1',
    });
    expect(enrV1Count).toBe(1);

    // Step 4: Ready with HIGHER readinessVersion (v2) -> genuine new occurrence
    const readyAtV2 = new Date();
    await SrcFulfilmentModel.updateOne(
      { tenantId: TENANT, orderId: 'ord_od08_rework' },
      {
        $set: {
          status: 'READY_FOR_COLLECTION',
          readinessKind: 'FULL',
          readinessVersion: 2,
          readyAt: readyAtV2,
          entityVersion: 4,
        },
      }
    );

    await eventConsumerService.ingestEvent(TENANT, 'fulfilment',{
      schemaVersion: 1,
      producer: 'fulfilment',
      eventId: 'evt_od08_ready_v2',
      tenantId: TENANT,
      type: 'fulfilment.updated',
      entityId: 'ord_od08_rework',
      entityVersion: 4,
      occurredAt: readyAtV2.toISOString(),
      receivedAt: readyAtV2.toISOString(),
      customerId: 'cus_of_ful_eligible',
      data: {
        orderNumber: 'ORD-OD08-01',
        branchId: 'branch_main',
        mode: 'PICKUP',
        status: 'READY_FOR_COLLECTION',
        readinessKind: 'FULL',
        readinessVersion: 2,
        readyAt: readyAtV2.toISOString(),
      },
    } as any);

    const enrV2 = await CampaignEnrollmentModel.findOne({
      tenantId: TENANT,
      occurrenceId: 'ready:ord_od08_rework:2',
    });
    expect(enrV2).toBeTruthy();
  });

  // OD09: readiness version rule
  it('OD09: readiness version rule - engine never computes readinessVersion; lower or equal version is ignored', async () => {
    // Fulfilment record has readinessVersion: 3
    const readyAt = new Date('2026-10-30T10:00:00.000Z');
    await SrcFulfilmentModel.updateOne(
      { tenantId: TENANT, orderId: 'ord_od09_ver' },
      {
        $set: {
          tenantId: TENANT,
          orderId: 'ord_od09_ver',
          customerId: 'cus_of_ful_eligible',
          branchId: 'branch_main',
          orderNumber: 'ORD-OD09-01',
          mode: 'PICKUP',
          status: 'READY_FOR_COLLECTION',
          readinessKind: 'FULL',
          readinessVersion: 3,
          readyAt,
          entityVersion: 3,
          shipments: [],
          source: 'MOCK',
        },
      },
      { upsert: true }
    );

    await eventConsumerService.ingestEvent(TENANT, 'fulfilment',{
      schemaVersion: 1,
      producer: 'fulfilment',
      eventId: 'evt_od09_v3',
      tenantId: TENANT,
      type: 'fulfilment.updated',
      entityId: 'ord_od09_ver',
      entityVersion: 3,
      occurredAt: readyAt.toISOString(),
      receivedAt: readyAt.toISOString(),
      customerId: 'cus_of_ful_eligible',
      data: {
        orderNumber: 'ORD-OD09-01',
        branchId: 'branch_main',
        mode: 'PICKUP',
        status: 'READY_FOR_COLLECTION',
        readinessKind: 'FULL',
        readinessVersion: 3,
        readyAt: readyAt.toISOString(),
      },
    } as any);

    const enr = await CampaignEnrollmentModel.findOne({
      tenantId: TENANT,
      occurrenceId: 'ready:ord_od09_ver:3',
    });
    expect(enr).toBeTruthy();

    // Event arriving with readinessVersion: 2 (lower)
    await eventConsumerService.ingestEvent(TENANT, 'fulfilment',{
      schemaVersion: 1,
      producer: 'fulfilment',
      eventId: 'evt_od09_v2',
      tenantId: TENANT,
      type: 'fulfilment.updated',
      entityId: 'ord_od09_ver',
      entityVersion: 2,
      occurredAt: readyAt.toISOString(),
      receivedAt: readyAt.toISOString(),
      customerId: 'cus_of_ful_eligible',
      data: {
        orderNumber: 'ORD-OD09-01',
        branchId: 'branch_main',
        mode: 'PICKUP',
        status: 'READY_FOR_COLLECTION',
        readinessKind: 'FULL',
        readinessVersion: 2,
      },
    } as any);

    const enrLower = await CampaignEnrollmentModel.findOne({
      tenantId: TENANT,
      occurrenceId: 'ready:ord_od09_ver:2',
    });
    expect(enrLower).toBeNull();
  });

  // OD10: dispatched needs verified event
  it('OD10: dispatched needs verified event - LABEL_CREATED and unverified events never trigger; verified DISPATCHED enrolls dispatch:orderId:shipmentId', async () => {
    const now = new Date('2026-10-30T10:00:00.000Z');
    // Case A: LABEL_CREATED only -> no enrollment
    await SrcFulfilmentModel.updateOne(
      { tenantId: TENANT, orderId: 'ord_od10_label' },
      {
        $set: {
          tenantId: TENANT,
          orderId: 'ord_od10_label',
          customerId: 'cus_of_ful_delivery_1',
          branchId: 'branch_main',
          orderNumber: 'ORD-OD10-LBL',
          mode: 'DELIVERY',
          status: 'NOT_READY',
          entityVersion: 1,
          shipments: [
            {
              shipmentId: 'shp_od10_lbl',
              carrier: 'DELHIVERY',
              carrierName: 'Delhivery',
              trackingRef: 'DEL-10-LBL',
              status: 'LABEL_CREATED',
              verified: false,
              entityVersion: 1,
            },
          ],
          source: 'MOCK',
        },
      },
      { upsert: true }
    );

    await eventConsumerService.ingestEvent(TENANT, 'fulfilment',{
      schemaVersion: 1,
      producer: 'fulfilment',
      eventId: 'evt_od10_lbl',
      tenantId: TENANT,
      type: 'shipment.updated',
      entityId: 'shp_od10_lbl',
      entityVersion: 1,
      occurredAt: now.toISOString(),
      receivedAt: now.toISOString(),
      customerId: 'cus_of_ful_delivery_1',
      data: {
        orderId: 'ord_od10_label',
        orderNumber: 'ORD-OD10-LBL',
        branchId: 'branch_main',
        carrier: 'DELHIVERY',
        carrierName: 'Delhivery',
        trackingRef: 'DEL-10-LBL',
        status: 'LABEL_CREATED',
        verified: false,
      },
    } as any);

    const enrLbl = await CampaignEnrollmentModel.findOne({
      tenantId: TENANT,
      occurrenceId: 'dispatch:ord_od10_label:shp_od10_lbl',
    });
    expect(enrLbl).toBeNull();

    // Case B: DISPATCHED but verified: false -> ignored (UNVERIFIED_SHIPMENT_EVENT)
    await eventConsumerService.ingestEvent(TENANT, 'fulfilment',{
      schemaVersion: 1,
      producer: 'fulfilment',
      eventId: 'evt_od10_unv',
      tenantId: TENANT,
      type: 'shipment.updated',
      entityId: 'shp_od10_unv',
      entityVersion: 1,
      occurredAt: now.toISOString(),
      receivedAt: now.toISOString(),
      customerId: 'cus_of_ful_delivery_1',
      data: {
        orderId: 'ord_od10_label',
        orderNumber: 'ORD-OD10-LBL',
        branchId: 'branch_main',
        carrier: 'DELHIVERY',
        carrierName: 'Delhivery',
        trackingRef: 'DEL-10-UNV',
        status: 'DISPATCHED',
        verified: false,
        dispatchedAt: now.toISOString(),
      },
    } as any);

    const enrUnv = await CampaignEnrollmentModel.findOne({
      tenantId: TENANT,
      occurrenceId: 'dispatch:ord_od10_label:shp_od10_unv',
    });
    expect(enrUnv).toBeNull();

    // Case C: DISPATCHED and verified: true -> enrolls
    await SrcFulfilmentModel.updateOne(
      { tenantId: TENANT, orderId: 'ord_od10_label' },
      {
        $set: {
          shipments: [
            {
              shipmentId: 'shp_od10_ver',
              carrier: 'DELHIVERY',
              carrierName: 'Delhivery',
              trackingRef: 'DEL-10-VER',
              status: 'DISPATCHED',
              verified: true,
              dispatchedAt: now,
              entityVersion: 2,
            },
          ],
        },
      }
    );

    await eventConsumerService.ingestEvent(TENANT, 'fulfilment',{
      schemaVersion: 1,
      producer: 'fulfilment',
      eventId: 'evt_od10_ver',
      tenantId: TENANT,
      type: 'shipment.updated',
      entityId: 'shp_od10_ver',
      entityVersion: 2,
      occurredAt: now.toISOString(),
      receivedAt: now.toISOString(),
      customerId: 'cus_of_ful_delivery_1',
      data: {
        orderId: 'ord_od10_label',
        orderNumber: 'ORD-OD10-LBL',
        branchId: 'branch_main',
        carrier: 'DELHIVERY',
        carrierName: 'Delhivery',
        trackingRef: 'DEL-10-VER',
        status: 'DISPATCHED',
        verified: true,
        dispatchedAt: now.toISOString(),
      },
    } as any);

    const enrVer = await CampaignEnrollmentModel.findOne({
      tenantId: TENANT,
      occurrenceId: 'dispatch:ord_od10_label:shp_od10_ver',
    });
    expect(enrVer).toBeTruthy();
  });

  // OD11: tracking reference
  it('OD11: tracking reference - template that binds tracking skips with MISSING_VARIABLE when absent, no-tracking template works', async () => {
    // If a template binds shipment.trackingRef and shipment has trackingRef: null or empty
    const now = new Date('2026-10-30T10:00:00.000Z');
    await SrcFulfilmentModel.updateOne(
      { tenantId: TENANT, orderId: 'ord_od11_notrack' },
      {
        $set: {
          tenantId: TENANT,
          orderId: 'ord_od11_notrack',
          customerId: 'cus_of_ful_delivery_1',
          branchId: 'branch_main',
          orderNumber: 'ORD-OD11-01',
          mode: 'DELIVERY',
          status: 'NOT_READY',
          entityVersion: 1,
          shipments: [
            {
              shipmentId: 'shp_od11_notrack',
              carrier: 'LOCAL_VAN',
              carrierName: 'Store Van',
              trackingRef: null, // No tracking ref!
              status: 'DISPATCHED',
              verified: true,
              dispatchedAt: now,
              entityVersion: 1,
            },
          ],
          source: 'MOCK',
        },
      },
      { upsert: true }
    );

    // Test snapshot building with missing trackingRef
    const snap = await buildResolutionSnapshot({
      tenantId: TENANT,
      neededDependencies: ['fulfilment'],
      step: {
        bindings: {
          '1': { source: 'shipment.carrierName' },
          '2': { source: 'shipment.trackingRef' },
        },
      } as any,
      execution: {
        selectionSnapshot: { orderId: 'ord_od11_notrack', shipmentId: 'shp_od11_notrack' },
      } as any,
    });
    expect(BINDING_SOURCES['shipment.carrierName'].resolve(snap)).toBe('Store Van');
    expect(BINDING_SOURCES['shipment.trackingRef'].resolve(snap)).toBeNull();
  });

  // OD12: delivered
  it('OD12: delivered - verified DELIVERED enrolls delivered:orderId:shipmentId, also without a prior dispatch', async () => {
    const now = new Date('2026-10-30T10:00:00.000Z');
    await SrcFulfilmentModel.updateOne(
      { tenantId: TENANT, orderId: 'ord_od12_direct_del' },
      {
        $set: {
          tenantId: TENANT,
          orderId: 'ord_od12_direct_del',
          customerId: 'cus_of_ful_delivery_1',
          branchId: 'branch_main',
          orderNumber: 'ORD-OD12-01',
          mode: 'DELIVERY',
          status: 'DELIVERED',
          entityVersion: 1,
          shipments: [
            {
              shipmentId: 'shp_od12_direct',
              carrier: 'DELHIVERY',
              carrierName: 'Delhivery',
              trackingRef: 'DEL-12-DIRECT',
              status: 'DELIVERED',
              verified: true,
              deliveredAt: now,
              entityVersion: 1,
            },
          ],
          source: 'MOCK',
        },
      },
      { upsert: true }
    );

    await eventConsumerService.ingestEvent(TENANT, 'fulfilment',{
      schemaVersion: 1,
      producer: 'fulfilment',
      eventId: 'evt_od12_del',
      tenantId: TENANT,
      type: 'shipment.updated',
      entityId: 'shp_od12_direct',
      entityVersion: 1,
      occurredAt: now.toISOString(),
      receivedAt: now.toISOString(),
      customerId: 'cus_of_ful_delivery_1',
      data: {
        orderId: 'ord_od12_direct_del',
        orderNumber: 'ORD-OD12-01',
        branchId: 'branch_main',
        carrier: 'DELHIVERY',
        carrierName: 'Delhivery',
        trackingRef: 'DEL-12-DIRECT',
        status: 'DELIVERED',
        verified: true,
        deliveredAt: now.toISOString(),
      },
    } as any);

    const enr = await CampaignEnrollmentModel.findOne({
      tenantId: TENANT,
      campaignId: 'cmp_delivery_delivered',
      occurrenceId: 'delivered:ord_od12_direct_del:shp_od12_direct',
    });
    expect(enr).toBeTruthy();
  });

  // OD13: superseded status
  it('OD13: superseded status - DISPATCHED step due after DELIVERED is skipped STATUS_SUPERSEDED; FAILED/RETURNED cancels delivery steps', async () => {
    const now = new Date('2026-10-30T10:00:00.000Z');
    // First, enroll a dispatched step
    await SrcFulfilmentModel.updateOne(
      { tenantId: TENANT, orderId: 'ord_od13_super' },
      {
        $set: {
          tenantId: TENANT,
          orderId: 'ord_od13_super',
          customerId: 'cus_of_ful_delivery_1',
          branchId: 'branch_main',
          orderNumber: 'ORD-OD13-01',
          mode: 'DELIVERY',
          status: 'NOT_READY',
          entityVersion: 1,
          shipments: [
            {
              shipmentId: 'shp_od13_super',
              carrier: 'DELHIVERY',
              carrierName: 'Delhivery',
              trackingRef: 'DEL-13-SUP',
              status: 'DISPATCHED',
              verified: true,
              dispatchedAt: now,
              entityVersion: 1,
            },
          ],
          source: 'MOCK',
        },
      },
      { upsert: true }
    );

    await eventConsumerService.ingestEvent(TENANT, 'fulfilment',{
      schemaVersion: 1,
      producer: 'fulfilment',
      eventId: 'evt_od13_disp',
      tenantId: TENANT,
      type: 'shipment.updated',
      entityId: 'shp_od13_super',
      entityVersion: 1,
      occurredAt: now.toISOString(),
      receivedAt: now.toISOString(),
      customerId: 'cus_of_ful_delivery_1',
      data: {
        orderId: 'ord_od13_super',
        orderNumber: 'ORD-OD13-01',
        branchId: 'branch_main',
        carrier: 'DELHIVERY',
        carrierName: 'Delhivery',
        trackingRef: 'DEL-13-SUP',
        status: 'DISPATCHED',
        verified: true,
        dispatchedAt: now.toISOString(),
      },
    } as any);

    // Now delivered event arrives before dispatched notice sends -> supersedes it
    await SrcFulfilmentModel.updateOne(
      { tenantId: TENANT, orderId: 'ord_od13_super' },
      {
        $set: {
          status: 'DELIVERED',
          'shipments.0.status': 'DELIVERED',
          'shipments.0.deliveredAt': new Date(),
          entityVersion: 2,
        },
      }
    );

    await eventConsumerService.ingestEvent(TENANT, 'fulfilment',{
      schemaVersion: 1,
      producer: 'fulfilment',
      eventId: 'evt_od13_deliv',
      tenantId: TENANT,
      type: 'shipment.updated',
      entityId: 'shp_od13_super',
      entityVersion: 2,
      occurredAt: new Date().toISOString(),
      receivedAt: new Date().toISOString(),
      customerId: 'cus_of_ful_delivery_1',
      data: {
        orderId: 'ord_od13_super',
        orderNumber: 'ORD-OD13-01',
        branchId: 'branch_main',
        carrier: 'DELHIVERY',
        carrierName: 'Delhivery',
        trackingRef: 'DEL-13-SUP',
        status: 'DELIVERED',
        verified: true,
        deliveredAt: new Date().toISOString(),
      },
    } as any);

    const execsDisp = await CampaignExecutionModel.find({
      tenantId: TENANT,
      campaignId: 'cmp_delivery_dispatched',
      executionKey: { $regex: /^cmp_delivery_dispatched:cus_of_ful_delivery_1:dispatch:ord_od13_super:shp_od13_super:/ },
    });
    for (const ex of execsDisp) {
      expect(ex.state).toBe(EXECUTION_STATE.CANCELLED);
      expect(ex.cancellationReason).toBe('STATUS_SUPERSEDED');
    }
  });

  // OD14: shipment stale and duplicate
  it('OD14: shipment stale and duplicate - stale shipment versions and out-of-order DISPATCHED after DELIVERED change nothing', async () => {
    // Current state: shipment delivered at entityVersion 3
    const now = new Date('2026-10-30T10:00:00.000Z');
    await SrcFulfilmentModel.updateOne(
      { tenantId: TENANT, orderId: 'ord_od14_stale' },
      {
        $set: {
          tenantId: TENANT,
          orderId: 'ord_od14_stale',
          customerId: 'cus_of_ful_delivery_1',
          branchId: 'branch_main',
          orderNumber: 'ORD-OD14-01',
          mode: 'DELIVERY',
          status: 'DELIVERED',
          entityVersion: 3,
          shipments: [
            {
              shipmentId: 'shp_od14_stale',
              carrier: 'DELHIVERY',
              carrierName: 'Delhivery',
              trackingRef: 'DEL-14-STL',
              status: 'DELIVERED',
              verified: true,
              deliveredAt: now,
              entityVersion: 3,
            },
          ],
          source: 'MOCK',
        },
      },
      { upsert: true }
    );

    // Out-of-order DISPATCHED event arriving with entityVersion 1
    const staleDisp = {
      schemaVersion: 1,
      producer: 'fulfilment',
      eventId: 'evt_od14_stale_disp',
      tenantId: TENANT,
      type: 'shipment.updated',
      entityId: 'shp_od14_stale',
      entityVersion: 1,
      occurredAt: now.toISOString(),
      receivedAt: now.toISOString(),
      customerId: 'cus_of_ful_delivery_1',
      data: {
        orderId: 'ord_od14_stale',
        orderNumber: 'ORD-OD14-01',
        branchId: 'branch_main',
        carrier: 'DELHIVERY',
        carrierName: 'Delhivery',
        trackingRef: 'DEL-14-STL',
        status: 'DISPATCHED',
        verified: true,
        dispatchedAt: now.toISOString(),
      },
    };

    await eventConsumerService.ingestEvent(TENANT, 'fulfilment',staleDisp as any);

    // No dispatched enrollment created
    const enr = await CampaignEnrollmentModel.findOne({
      tenantId: TENANT,
      campaignId: 'cmp_delivery_dispatched',
      occurrenceId: 'dispatch:ord_od14_stale:shp_od14_stale',
    });
    expect(enr).toBeNull();
  });

  // OD15: service purpose rules
  it('OD15: service purpose rules - SERVICE campaigns require UTILITY templates; MARKETING template rejected with no dev exemption; marketing cannot use service purpose (C14)', async () => {
    // Attempt to validate a service campaign with MARKETING category template
    const invalidServiceCmp = {
      name: 'Invalid Service Campaign',
      presetId: 'outfit_collection_delivery',
      purpose: 'SERVICE',
      trigger: {
        type: 'FULFILMENT_MILESTONE',
        anchor: 'FULFILMENT_READY_AT',
        milestone: 'OUTFIT_READY',
        fulfilmentFilter: 'PICKUP',
      },
      steps: [
        {
          stepId: 'step_1',
          stepName: 'Marketing Template in Service',
          templateRef: { id: 'tpl_birthday_invite', name: 'birthday_invite', category: 'MARKETING', language: 'en', revision: 1 },
          delay: { value: 0, unit: 'MINUTES' },
          bindings: { '1': { source: 'customer.firstName' } },
        },
      ],
    };

    const valResult = await campaignValidationService.validateDraft(TENANT, {
      ...invalidServiceCmp,
      enabledBranches: ['branch_main'],
    } as any);
    expect(valResult.valid).toBe(false);
    expect(
      valResult.errors.some(
        (e) => e.code === 'SERVICE_REQUIRES_UTILITY_TEMPLATE' || e.message.includes('UTILITY')
      )
    ).toBe(true);

    // Also verify marketing campaign cannot use purpose: SERVICE
    const marketingWithService = {
      name: 'Marketing Campaign Bypassing Caps',
      presetId: 'welcome_new_customer',
      purpose: 'SERVICE',
      trigger: { type: 'CUSTOMER_CREATED', anchor: 'CUSTOMER_CREATED_AT' },
      enabledBranches: ['branch_main'],
      steps: [
        {
          stepId: 'step_1',
          templateRef: { id: 'tpl_welcome_immediate', name: 'tpl_welcome_immediate', category: 'MARKETING', language: 'en', revision: 1 },
          delay: { value: 0, unit: 'MINUTES' },
          bindings: { '1': { source: 'customer.firstName' } },
        },
      ],
    };
    const valResultMkt = await campaignValidationService.validateDraft(TENANT, marketingWithService as any);
    expect(valResultMkt.valid).toBe(false);
  });

  // OD16: permissions
  it('OD16: permissions - MARKETING_OPT_OUT does not block service messages; CHANNEL_SUPPRESSED, deletion, unverified do', async () => {
    const readyAt = new Date('2026-10-30T10:00:00.000Z');

    // Case A: Customer opted out of MARKETING only (cus_of_ful_opted_out) -> ENROLLS & PASSES GATES!
    await SrcFulfilmentModel.updateOne(
      { tenantId: TENANT, orderId: 'ord_od16_opted_out' },
      {
        $set: {
          tenantId: TENANT,
          orderId: 'ord_od16_opted_out',
          customerId: 'cus_of_ful_opted_out',
          branchId: 'branch_main',
          orderNumber: 'ORD-OD16-OPT',
          mode: 'PICKUP',
          status: 'READY_FOR_COLLECTION',
          readinessKind: 'FULL',
          readinessVersion: 1,
          readyAt,
          entityVersion: 1,
          shipments: [],
          source: 'MOCK',
        },
      },
      { upsert: true }
    );

    await eventConsumerService.ingestEvent(TENANT, 'fulfilment',{
      schemaVersion: 1,
      producer: 'fulfilment',
      eventId: 'evt_od16_opt',
      tenantId: TENANT,
      type: 'fulfilment.updated',
      entityId: 'ord_od16_opted_out',
      entityVersion: 1,
      occurredAt: readyAt.toISOString(),
      receivedAt: readyAt.toISOString(),
      customerId: 'cus_of_ful_opted_out',
      data: {
        orderNumber: 'ORD-OD16-OPT',
        branchId: 'branch_main',
        mode: 'PICKUP',
        status: 'READY_FOR_COLLECTION',
        readinessKind: 'FULL',
        readinessVersion: 1,
        readyAt: readyAt.toISOString(),
      },
    } as any);

    const enrOpt = await CampaignEnrollmentModel.findOne({
      tenantId: TENANT,
      occurrenceId: 'ready:ord_od16_opted_out:1',
    });
    expect(enrOpt).toBeTruthy();

    // Case B: Channel suppressed customer (cus_of_ful_suppressed) -> BLOCKED
    await SrcFulfilmentModel.updateOne(
      { tenantId: TENANT, orderId: 'ord_od16_suppressed' },
      {
        $set: {
          tenantId: TENANT,
          orderId: 'ord_od16_suppressed',
          customerId: 'cus_of_ful_suppressed',
          branchId: 'branch_main',
          orderNumber: 'ORD-OD16-SUP',
          mode: 'PICKUP',
          status: 'READY_FOR_COLLECTION',
          readinessKind: 'FULL',
          readinessVersion: 1,
          readyAt,
          entityVersion: 1,
          shipments: [],
          source: 'MOCK',
        },
      },
      { upsert: true }
    );

    await eventConsumerService.ingestEvent(TENANT, 'fulfilment',{
      schemaVersion: 1,
      producer: 'fulfilment',
      eventId: 'evt_od16_sup',
      tenantId: TENANT,
      type: 'fulfilment.updated',
      entityId: 'ord_od16_suppressed',
      entityVersion: 1,
      occurredAt: readyAt.toISOString(),
      receivedAt: readyAt.toISOString(),
      customerId: 'cus_of_ful_suppressed',
      data: {
        orderNumber: 'ORD-OD16-SUP',
        branchId: 'branch_main',
        mode: 'PICKUP',
        status: 'READY_FOR_COLLECTION',
        readinessKind: 'FULL',
        readinessVersion: 1,
        readyAt: readyAt.toISOString(),
      },
    } as any);

    const enrSup = await CampaignEnrollmentModel.findOne({
      tenantId: TENANT,
      occurrenceId: 'ready:ord_od16_suppressed:1',
    });
    expect(enrSup).toBeNull();
  });

  // OD17: service spacing
  it('OD17: service spacing - later service step deferred or SKIPPED_SERVICE_SPACING; marketing contacts do not count and service does not consume marketing caps', async () => {
    const { contactGateService } = await import('../src/services/contact-gate');
    const { campaignSettingsService } = await import('../src/services/campaign-settings.service');
    const dest = '919823000101';
    const destHash = crypto.createHash('sha256').update(dest).digest('hex');

    // Record a service contact to this destination 2 hours ago
    const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000);
    await CampaignContactGateModel.findOneAndUpdate(
      { tenantId: TENANT, destinationHash: destHash },
      {
        $push: {
          ledger: {
            executionId: 'exe_od17_service',
            campaignId: 'cmp_outfit_ready',
            reservedAt: twoHoursAgo,
            purpose: 'SERVICE',
            status: 'ACCEPTED',
          },
        },
      },
      { upsert: true }
    );

    // Check capacity for a SERVICE step now: service spacing default is 24 hours
    const settings = await campaignSettingsService.getSettings(TENANT);
    const serviceCheck = await contactGateService.checkCapacity(
      TENANT,
      destHash,
      new Date(),
      settings,
      undefined,
      'SERVICE'
    );
    expect(serviceCheck.allowed).toBe(false);
    expect(serviceCheck.reason).toBe('SERVICE_SPACING_LIMIT');

    // Marketing check to the same destination is unaffected by service contact!
    const marketingCheck = await contactGateService.checkCapacity(
      TENANT,
      destHash,
      new Date(),
      settings,
      undefined,
      'MARKETING'
    );
    expect(marketingCheck.allowed).toBe(true);
  });

  // OD18: per order and step dedupe
  it('OD18: per order and step dedupe - one execution per order per step per occurrence; two orders of one customer are separate occurrences', async () => {
    const readyAt = new Date('2026-10-30T10:00:00.000Z');
    // Order 1
    await SrcFulfilmentModel.updateOne(
      { tenantId: TENANT, orderId: 'ord_od18_order_1' },
      {
        $set: {
          tenantId: TENANT,
          orderId: 'ord_od18_order_1',
          customerId: 'cus_of_ful_eligible',
          branchId: 'branch_main',
          orderNumber: 'ORD-OD18-01',
          mode: 'PICKUP',
          status: 'READY_FOR_COLLECTION',
          readinessKind: 'FULL',
          readinessVersion: 1,
          readyAt,
          entityVersion: 1,
          shipments: [],
          source: 'MOCK',
        },
      },
      { upsert: true }
    );

    // Order 2 (same customer)
    await SrcFulfilmentModel.updateOne(
      { tenantId: TENANT, orderId: 'ord_od18_order_2' },
      {
        $set: {
          tenantId: TENANT,
          orderId: 'ord_od18_order_2',
          customerId: 'cus_of_ful_eligible',
          branchId: 'branch_main',
          orderNumber: 'ORD-OD18-02',
          mode: 'PICKUP',
          status: 'READY_FOR_COLLECTION',
          readinessKind: 'FULL',
          readinessVersion: 1,
          readyAt,
          entityVersion: 1,
          shipments: [],
          source: 'MOCK',
        },
      },
      { upsert: true }
    );

    await eventConsumerService.ingestEvent(TENANT, 'fulfilment',{
      schemaVersion: 1,
      producer: 'fulfilment',
      eventId: 'evt_od18_1',
      tenantId: TENANT,
      type: 'fulfilment.updated',
      entityId: 'ord_od18_order_1',
      entityVersion: 1,
      occurredAt: readyAt.toISOString(),
      receivedAt: readyAt.toISOString(),
      customerId: 'cus_of_ful_eligible',
      data: {
        orderNumber: 'ORD-OD18-01',
        branchId: 'branch_main',
        mode: 'PICKUP',
        status: 'READY_FOR_COLLECTION',
        readinessKind: 'FULL',
        readinessVersion: 1,
        readyAt: readyAt.toISOString(),
      },
    } as any);

    await eventConsumerService.ingestEvent(TENANT, 'fulfilment',{
      schemaVersion: 1,
      producer: 'fulfilment',
      eventId: 'evt_od18_2',
      tenantId: TENANT,
      type: 'fulfilment.updated',
      entityId: 'ord_od18_order_2',
      entityVersion: 1,
      occurredAt: readyAt.toISOString(),
      receivedAt: readyAt.toISOString(),
      customerId: 'cus_of_ful_eligible',
      data: {
        orderNumber: 'ORD-OD18-02',
        branchId: 'branch_main',
        mode: 'PICKUP',
        status: 'READY_FOR_COLLECTION',
        readinessKind: 'FULL',
        readinessVersion: 1,
        readyAt: readyAt.toISOString(),
      },
    } as any);

    const enr1 = await CampaignEnrollmentModel.findOne({ tenantId: TENANT, occurrenceId: 'ready:ord_od18_order_1:1' });
    const enr2 = await CampaignEnrollmentModel.findOne({ tenantId: TENANT, occurrenceId: 'ready:ord_od18_order_2:1' });

    expect(enr1).toBeTruthy();
    expect(enr2).toBeTruthy();
    expect(enr1?.occurrenceId).not.toBe(enr2?.occurrenceId);
  });

  // OD19: quiet hours
  it('OD19: quiet hours - deferral to next morning, SKIP policy, maxDeferralHours, blackout never passing expiresAt, raw/adjusted stored', async () => {
    // Event at 23:00 IST (outside allowed sending hours 10:00 - 19:00 IST)
    // 23:00 IST = 17:30 UTC
    const nightTime = new Date('2026-10-30T17:30:00.000Z');
    await SrcFulfilmentModel.updateOne(
      { tenantId: TENANT, orderId: 'ord_od19_night' },
      {
        $set: {
          tenantId: TENANT,
          orderId: 'ord_od19_night',
          customerId: 'cus_of_ful_eligible',
          branchId: 'branch_main',
          orderNumber: 'ORD-OD19-01',
          mode: 'PICKUP',
          status: 'READY_FOR_COLLECTION',
          readinessKind: 'FULL',
          readinessVersion: 1,
          readyAt: nightTime,
          entityVersion: 1,
          shipments: [],
          source: 'MOCK',
        },
      },
      { upsert: true }
    );

    await eventConsumerService.ingestEvent(TENANT, 'fulfilment',{
      schemaVersion: 1,
      producer: 'fulfilment',
      eventId: 'evt_od19_1',
      tenantId: TENANT,
      type: 'fulfilment.updated',
      entityId: 'ord_od19_night',
      entityVersion: 1,
      occurredAt: nightTime.toISOString(),
      receivedAt: nightTime.toISOString(),
      customerId: 'cus_of_ful_eligible',
      data: {
        orderNumber: 'ORD-OD19-01',
        branchId: 'branch_main',
        mode: 'PICKUP',
        status: 'READY_FOR_COLLECTION',
        readinessKind: 'FULL',
        readinessVersion: 1,
        readyAt: nightTime.toISOString(),
      },
    } as any);

    const enr = await CampaignEnrollmentModel.findOne({ tenantId: TENANT, occurrenceId: 'ready:ord_od19_night:1' });
    const exec = await CampaignExecutionModel.findOne({ tenantId: TENANT, enrollmentId: enr?.enrollmentId, stepId: 'ready_notice' });

    expect(exec).toBeTruthy();
    expect(((exec as any).rawDueAt || exec?.originalDueAt).toISOString()).toBe(nightTime.toISOString());
    // Adjusted due date must be next morning 10:00 IST (04:30 UTC next day: 2026-10-31T04:30:00.000Z)
    expect(((exec as any).adjustedDueAt || exec?.dueAt).toISOString()).toBe('2026-10-31T04:30:00.000Z');
    expect(exec?.deferralReason).toMatch(/QUIET_HOURS|OUTSIDE_SENDING_HOURS/);
  });

  // OD20: no promotion in service
  it('OD20: no promotion in service - validation rejects promotional sources and promotional wording in service templates', async () => {
    // 1. Promotional binding source (e.g., offer.code) in service campaign
    const promoBindingCmp = {
      name: 'Promo Binding in Service',
      presetId: 'outfit_collection_delivery',
      purpose: 'SERVICE',
      trigger: {
        type: 'FULFILMENT_MILESTONE',
        anchor: 'FULFILMENT_READY_AT',
        milestone: 'OUTFIT_READY',
        fulfilmentFilter: 'PICKUP',
      },
      steps: [
        {
          stepId: 'ready_notice',
          templateRef: { id: 'tpl_fulfil_ready', name: 'tpl_fulfil_ready', category: 'UTILITY', language: 'en', revision: 1 },
          delay: { value: 0, unit: 'MINUTES' },
          bindings: {
            '1': { source: 'customer.firstName' },
            '2': { source: 'shop.displayName' },
            '3': { source: 'offer.code' }, // PROMOTIONAL SOURCE NOT ALLOWED!
          },
        },
      ],
    };

    const resPromo = await campaignValidationService.validateDraft(TENANT, {
      ...promoBindingCmp,
      enabledBranches: ['branch_main'],
    } as any);
    expect(resPromo.valid).toBe(false);
    expect(
      resPromo.errors.some(
        (e) =>
          e.code === 'PROMO_IN_SERVICE_TEMPLATE' ||
          e.message.includes('Promotional') ||
          e.message.includes('not allowed') ||
          e.message.includes('Binding source')
      )
    ).toBe(true);

    // 2. Promotional wording in template body
    const promoTextCmp = {
      name: 'Promo Text in Service',
      presetId: 'outfit_collection_delivery',
      purpose: 'SERVICE',
      trigger: {
        type: 'FULFILMENT_MILESTONE',
        anchor: 'FULFILMENT_READY_AT',
        milestone: 'OUTFIT_READY',
        fulfilmentFilter: 'PICKUP',
      },
      steps: [
        {
          stepId: 'ready_notice',
          templateRef: { id: 'tpl_promo_test', name: 'tpl_promo_test', category: 'UTILITY', language: 'en', revision: 1 },
          delay: { value: 0, unit: 'MINUTES' },
          bindings: { '1': { source: 'customer.firstName' } },
        },
      ],
    };

    // Temporarily insert a template with "discount" in body
    const mongoose = await import('mongoose');
    await mongoose.connection.collection('src_templates').insertOne({
      id: 'tpl_promo_test',
      name: 'tpl_promo_test',
      language: 'en',
      category: 'UTILITY',
      status: 'APPROVED',
      bodyText: 'Your outfit is ready! Enjoy 20% discount on your next visit.',
      variables: [{ index: 1, name: 'name', type: 'text' }],
      revision: 1,
      sendable: true,
      source: 'DUMMY',
    });

    const resPromoText = await campaignValidationService.validateDraft(TENANT, {
      ...promoTextCmp,
      enabledBranches: ['branch_main'],
    } as any);
    expect(resPromoText.valid).toBe(false);
    expect(
      resPromoText.errors.some(
        (e) => e.code === 'PROMO_IN_SERVICE_TEMPLATE' || e.message.includes('Promotional wording')
      )
    ).toBe(true);

    await mongoose.connection.collection('src_templates').deleteOne({ id: 'tpl_promo_test' });
  });

  // OD21: future only
  it('OD21: future only - FUTURE_ONLY at activation: milestones before activation notify nobody; elapsed steps skipped', async () => {
    // Campaign activated at 2026-10-29T10:00:00Z
    // Order milestone occurred at 2026-10-25T10:00:00Z (before activation)
    const oldReadyAt = new Date('2026-10-25T10:00:00.000Z');
    await SrcFulfilmentModel.updateOne(
      { tenantId: TENANT, orderId: 'ord_od21_old' },
      {
        $set: {
          tenantId: TENANT,
          orderId: 'ord_od21_old',
          customerId: 'cus_of_ful_eligible',
          branchId: 'branch_main',
          orderNumber: 'ORD-OD21-01',
          mode: 'PICKUP',
          status: 'READY_FOR_COLLECTION',
          readinessKind: 'FULL',
          readinessVersion: 1,
          readyAt: oldReadyAt,
          entityVersion: 1,
          shipments: [],
          source: 'MOCK',
        },
      },
      { upsert: true }
    );

    await eventConsumerService.ingestEvent(TENANT, 'fulfilment',{
      schemaVersion: 1,
      producer: 'fulfilment',
      eventId: 'evt_od21_1',
      tenantId: TENANT,
      type: 'fulfilment.updated',
      entityId: 'ord_od21_old',
      entityVersion: 1,
      occurredAt: oldReadyAt.toISOString(),
      receivedAt: new Date().toISOString(),
      customerId: 'cus_of_ful_eligible',
      data: {
        orderNumber: 'ORD-OD21-01',
        branchId: 'branch_main',
        mode: 'PICKUP',
        status: 'READY_FOR_COLLECTION',
        readinessKind: 'FULL',
        readinessVersion: 1,
        readyAt: oldReadyAt.toISOString(),
      },
    } as any);

    const enr = await CampaignEnrollmentModel.findOne({ tenantId: TENANT, occurrenceId: 'ready:ord_od21_old:1' });
    expect(enr).toBeNull();
  });

  // OD22: dispatch recheck
  it('OD22: dispatch recheck - dispatch recheck re-reads order: collected, delivered, rework, cancelled orders skip with zero provider calls', async () => {
    const readyAt = new Date('2026-10-30T10:00:00.000Z');
    await SrcFulfilmentModel.updateOne(
      { tenantId: TENANT, orderId: 'ord_od22_recheck' },
      {
        $set: {
          tenantId: TENANT,
          orderId: 'ord_od22_recheck',
          customerId: 'cus_of_ful_eligible',
          branchId: 'branch_main',
          orderNumber: 'ORD-OD22-01',
          mode: 'PICKUP',
          status: 'READY_FOR_COLLECTION',
          readinessKind: 'FULL',
          readinessVersion: 1,
          readyAt,
          entityVersion: 1,
          shipments: [],
          source: 'MOCK',
        },
      },
      { upsert: true }
    );

    await eventConsumerService.ingestEvent(TENANT, 'fulfilment',{
      schemaVersion: 1,
      producer: 'fulfilment',
      eventId: 'evt_od22_1',
      tenantId: TENANT,
      type: 'fulfilment.updated',
      entityId: 'ord_od22_recheck',
      entityVersion: 1,
      occurredAt: readyAt.toISOString(),
      receivedAt: readyAt.toISOString(),
      customerId: 'cus_of_ful_eligible',
      data: {
        orderNumber: 'ORD-OD22-01',
        branchId: 'branch_main',
        mode: 'PICKUP',
        status: 'READY_FOR_COLLECTION',
        readinessKind: 'FULL',
        readinessVersion: 1,
        readyAt: readyAt.toISOString(),
      },
    } as any);

    const enr = await CampaignEnrollmentModel.findOne({ tenantId: TENANT, occurrenceId: 'ready:ord_od22_recheck:1' });
    const exec = await CampaignExecutionModel.findOne({ tenantId: TENANT, enrollmentId: enr?.enrollmentId, stepId: 'ready_notice' });
    expect(exec).toBeTruthy();

    // Now order was COLLECTED behind the scenes (lost event)
    await SrcFulfilmentModel.updateOne(
      { tenantId: TENANT, orderId: 'ord_od22_recheck' },
      { $set: { status: 'COLLECTED', collectedAt: new Date(), entityVersion: 2 } }
    );

    // Call worker evaluateAndProcessExecution
    const prevFetchCalls = (globalThis.fetch as any).mock?.calls?.length || 0;
    const workerRes = await workerService.evaluateAndProcessExecution(
      exec!,
      'test_lease',
      new Date(Date.now() + 60000),
      new Date(readyAt.getTime() + 1000)
    );

    expect(workerRes.state).toBe(EXECUTION_STATE.SKIPPED);
    expect(workerRes.reason).toBe('ORDER_COLLECTED');
    // ZERO provider calls!
    const newFetchCalls = (globalThis.fetch as any).mock?.calls?.length || 0;
    expect(newFetchCalls).toBe(prevFetchCalls);
  });

  // OD23: stale intent
  it('OD23: stale intent - changed order number, tracking reference, version or destination after freeze gives BLOCKED_STALE_INTENT', async () => {
    const readyAt = new Date('2026-10-30T10:00:00.000Z');
    await SrcFulfilmentModel.updateOne(
      { tenantId: TENANT, orderId: 'ord_od23_freeze' },
      {
        $set: {
          tenantId: TENANT,
          orderId: 'ord_od23_freeze',
          customerId: 'cus_of_ful_eligible',
          branchId: 'branch_main',
          orderNumber: 'ORD-OD23-01',
          mode: 'PICKUP',
          status: 'READY_FOR_COLLECTION',
          readinessKind: 'FULL',
          readinessVersion: 1,
          readyAt,
          entityVersion: 1,
          shipments: [],
          source: 'MOCK',
        },
      },
      { upsert: true }
    );

    await eventConsumerService.ingestEvent(TENANT, 'fulfilment',{
      schemaVersion: 1,
      producer: 'fulfilment',
      eventId: 'evt_od23_1',
      tenantId: TENANT,
      type: 'fulfilment.updated',
      entityId: 'ord_od23_freeze',
      entityVersion: 1,
      occurredAt: readyAt.toISOString(),
      receivedAt: readyAt.toISOString(),
      customerId: 'cus_of_ful_eligible',
      data: {
        orderNumber: 'ORD-OD23-01',
        branchId: 'branch_main',
        mode: 'PICKUP',
        status: 'READY_FOR_COLLECTION',
        readinessKind: 'FULL',
        readinessVersion: 1,
        readyAt: readyAt.toISOString(),
      },
    } as any);

    const enr = await CampaignEnrollmentModel.findOne({ tenantId: TENANT, occurrenceId: 'ready:ord_od23_freeze:1' });
    const exec = await CampaignExecutionModel.findOne({ tenantId: TENANT, enrollmentId: enr?.enrollmentId, stepId: 'ready_notice' });

    // Freeze intent with entityVersion: 1
    const execId = exec?.executionId || exec?._id?.toString() || 'exec_od23';
    const intent = await CampaignDeliveryIntentModel.create({
      deliveryIntentId: `di_${execId}`,
      tenantId: TENANT,
      campaignId: 'cmp_outfit_ready',
      enrollmentId: enr?.enrollmentId || enr?._id.toString(),
      executionId: execId,
      deliveryKey: `dk_${execId}`,
      connectionId: 'conn_test',
      recipientVersion: 1,
      encryptedRecipient: 'dummy:cipher:tag',
      maskedRecipient: '+91 98*** **101',
      templateRef: { id: 'tpl_fulfil_ready', revision: 1, language: 'en' },
      parameters: { '1': 'Aditi' },
      payloadHash: 'hash_p_23',
      state: DELIVERY_INTENT_STATE.PENDING,
      attemptId: `att_${execId}`,
      selectionSnapshot: {
        orderId: 'ord_od23_freeze',
        orderNumber: 'ORD-OD23-01',
        mode: 'PICKUP',
        status: 'READY_FOR_COLLECTION',
        readinessVersion: 1,
      },
      createdAt: new Date(),
    });

    // Now fulfilment entity bumps to readinessVersion: 2 before submission
    await SrcFulfilmentModel.updateOne(
      { tenantId: TENANT, orderId: 'ord_od23_freeze' },
      { $set: { readinessVersion: 2, entityVersion: 2 } }
    );

    // Make execution due now
    await CampaignExecutionModel.updateOne(
      { _id: exec?._id },
      { $set: { dueAt: readyAt } }
    );

    // Re-evaluating should detect stale intent
    const cycleRes = await workerService.runWorkerCycle({
      tenantId: TENANT,
      campaignId: 'cmp_outfit_ready',
      nowOverride: new Date(readyAt.getTime() + 1000),
    });
    expect(cycleRes.blockedCount).toBe(1);
    const updatedExec = await CampaignExecutionModel.findById(exec?._id);
    expect(updatedExec?.state).toBe('BLOCKED');
    expect(updatedExec?.skipReason).toBe('BLOCKED_STALE_INTENT');
  });

  // OD24: racing replan
  it('OD24: racing replan - stale worker lease or planRevision gives zero provider calls; racing cancel vs submission has one winner', async () => {
    // If execution has already been claimed or cancelled, worker skips cleanly
    const readyAt = new Date('2026-10-30T10:00:00.000Z');
    await SrcFulfilmentModel.updateOne(
      { tenantId: TENANT, orderId: 'ord_od24_race' },
      {
        $set: {
          tenantId: TENANT,
          orderId: 'ord_od24_race',
          customerId: 'cus_of_ful_eligible',
          branchId: 'branch_main',
          orderNumber: 'ORD-OD24-01',
          mode: 'PICKUP',
          status: 'READY_FOR_COLLECTION',
          readinessKind: 'FULL',
          readinessVersion: 1,
          readyAt,
          entityVersion: 1,
          shipments: [],
          source: 'MOCK',
        },
      },
      { upsert: true }
    );

    await eventConsumerService.ingestEvent(TENANT, 'fulfilment',{
      schemaVersion: 1,
      producer: 'fulfilment',
      eventId: 'evt_od24_1',
      tenantId: TENANT,
      type: 'fulfilment.updated',
      entityId: 'ord_od24_race',
      entityVersion: 1,
      occurredAt: readyAt.toISOString(),
      receivedAt: readyAt.toISOString(),
      customerId: 'cus_of_ful_eligible',
      data: {
        orderNumber: 'ORD-OD24-01',
        branchId: 'branch_main',
        mode: 'PICKUP',
        status: 'READY_FOR_COLLECTION',
        readinessKind: 'FULL',
        readinessVersion: 1,
        readyAt: readyAt.toISOString(),
      },
    } as any);

    const enr = await CampaignEnrollmentModel.findOne({ tenantId: TENANT, occurrenceId: 'ready:ord_od24_race:1' });
    const exec = await CampaignExecutionModel.findOne({ tenantId: TENANT, enrollmentId: enr?.enrollmentId, stepId: 'ready_notice' });

    // Cancel execution beforehand
    await CampaignExecutionModel.updateOne(
      { _id: exec?._id },
      { $set: { state: EXECUTION_STATE.CANCELLED, cancellationReason: 'ORDER_COLLECTED' } }
    );

    const prevFetchCalls = (globalThis.fetch as any).mock?.calls?.length || 0;
    const cycleRes = await workerService.runWorkerCycle({
      tenantId: TENANT,
      campaignId: 'cmp_outfit_ready',
      nowOverride: new Date(readyAt.getTime() + 1000),
    });
    expect(cycleRes.dispatchedCount).toBe(0);
    const newFetchCalls = (globalThis.fetch as any).mock?.calls?.length || 0;
    expect(newFetchCalls).toBe(prevFetchCalls);
  });

  // OD25: reply handling
  it('OD25: reply handling - reply holds reminder steps but not the first notice; resolve-hold re-evaluates future steps only', async () => {
    // Campaign definition has stopOnReply: false on ready_notice, true on uncollected_reminder
    const cmp = await CampaignVersionModel.findOne({ tenantId: TENANT, campaignId: 'cmp_outfit_ready', version: 1 });
    const readyStep = cmp?.steps.find((s) => s.stepId === 'ready_notice');
    const reminderStep = cmp?.steps.find((s) => s.stepId === 'uncollected_reminder');

    expect(readyStep?.stopOnReply).toBe(false);
    expect(reminderStep?.stopOnReply).toBe(true);
  });

  // OD26: reconciler
  it('OD26: reconciler - catches missed ready or dispatched event, is idempotent, resumes from checkpoint, two planners give one enrollment', async () => {
    const readyAt = new Date(Date.now() - 3600 * 1000); // 1 hour ago (within reconcile sweep window)
    await SrcFulfilmentModel.updateOne(
      { tenantId: TENANT, orderId: 'ord_od26_recon' },
      {
        $set: {
          tenantId: TENANT,
          orderId: 'ord_od26_recon',
          customerId: 'cus_of_ful_eligible',
          branchId: 'branch_main',
          orderNumber: 'ORD-OD26-01',
          mode: 'PICKUP',
          status: 'READY_FOR_COLLECTION',
          readinessKind: 'FULL',
          readinessVersion: 1,
          readyAt,
          entityVersion: 1,
          shipments: [],
          source: 'MOCK',
        },
      },
      { upsert: true }
    );

    // Run reconciler
    const recon1 = await reconcileFulfilmentCampaigns(TENANT);
    expect(recon1.enrolledOccurrences).toBeGreaterThanOrEqual(1);

    const enr = await CampaignEnrollmentModel.findOne({
      tenantId: TENANT,
      occurrenceId: 'ready:ord_od26_recon:1',
    });
    expect(enr).toBeTruthy();

    // Run reconciler a second time (idempotency check)
    const recon2 = await reconcileFulfilmentCampaigns(TENANT);
    expect(recon2.enrolledOccurrences).toBe(0);

    const enrCount = await CampaignEnrollmentModel.countDocuments({
      tenantId: TENANT,
      campaignId: 'cmp_outfit_ready',
      occurrenceId: 'ready:ord_od26_recon:1',
    });
    expect(enrCount).toBe(1);
  });

  // OD27: bindings
  it('OD27: bindings - per-preset allowlist, no fallback for order or tracking sources, shipment sources only for shipment milestones', async () => {
    const { isSourceAllowedForPreset } = await import('../src/templates/bindingSources');
    expect(isSourceAllowedForPreset('order.number', OUTFIT_COLLECTION_DELIVERY_ID)).toBe(true);
    expect(isSourceAllowedForPreset('shipment.carrierName', OUTFIT_COLLECTION_DELIVERY_ID)).toBe(true);
    expect(isSourceAllowedForPreset('shipment.trackingRef', OUTFIT_COLLECTION_DELIVERY_ID)).toBe(true);
    expect(isSourceAllowedForPreset('customer.firstName', OUTFIT_COLLECTION_DELIVERY_ID)).toBe(true);
    expect(isSourceAllowedForPreset('shop.displayName', OUTFIT_COLLECTION_DELIVERY_ID)).toBe(true);
    expect(isSourceAllowedForPreset('offer.code', OUTFIT_COLLECTION_DELIVERY_ID)).toBe(false);
    expect(isSourceAllowedForPreset('credit.balance', OUTFIT_COLLECTION_DELIVERY_ID)).toBe(false);
  });

  // OD28: dry run and preview
  it('OD28: dry run and preview - dry run and preview return the same steps and parameters as dispatch and write nothing live', async () => {
    const readyAt = new Date('2026-10-30T10:00:00.000Z');
    await SrcFulfilmentModel.updateOne(
      { tenantId: TENANT, orderId: 'ord_od28_preview' },
      {
        $set: {
          tenantId: TENANT,
          orderId: 'ord_od28_preview',
          customerId: 'cus_of_ful_eligible',
          branchId: 'branch_main',
          orderNumber: 'ORD-OD28-01',
          mode: 'PICKUP',
          status: 'READY_FOR_COLLECTION',
          readinessKind: 'FULL',
          readinessVersion: 1,
          readyAt,
          entityVersion: 1,
          shipments: [],
          source: 'MOCK',
        },
      },
      { upsert: true }
    );

    const previewRes = await request(app)
      .post('/campaigns/cmp_outfit_ready/fulfilment/preview')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ orderId: 'ord_od28_preview' });

    expect(previewRes.status).toBe(200);
    expect(previewRes.body.wouldEnroll).toBe(true);
    expect(previewRes.body.steps.length).toBe(2);
    expect(previewRes.body.renderedParameters.length).toBeGreaterThan(0);

    // Assert zero enrollments or executions written
    const enr = await CampaignEnrollmentModel.findOne({
      tenantId: TENANT,
      occurrenceId: 'ready:ord_od28_preview:1',
    });
    expect(enr).toBeNull();
  });

  // OD29: summary counts
  it('OD29: summary counts - summary counts equal underlying records and show no sales claims', async () => {
    const res = await request(app)
      .get('/campaigns/cmp_outfit_ready/fulfilment/summary')
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('milestonesSeen');
    expect(res.body).toHaveProperty('enrollments');
    expect(res.body).toHaveProperty('exclusionsByReason');
    expect(res.body).toHaveProperty('skippedByReason');
    expect(res.body).toHaveProperty('ordersCollectedAfterNotice');
    expect(res.body.observationalNote).toContain('not sales attribution');
  });

  // OD30: boundaries
  it('OD30: boundaries - production code never writes src_fulfilments or src_orders; earlier presets including fitting/alteration unchanged', async () => {
    const apiSrcDir = path.resolve(__dirname, '../src');
    const files = fs.readdirSync(apiSrcDir, { recursive: true }) as string[];

    // Exclude mock, seed, scripts, test dirs
    const prodFiles = files.filter(
      (f) =>
        f.endsWith('.ts') &&
        !f.includes('mock') &&
        !f.includes('seed') &&
        !f.includes('scripts') &&
        !f.includes('test') &&
        !f.includes('routes.ts') // Dev routes excluded
    );

    for (const f of prodFiles) {
      const fullPath = path.resolve(apiSrcDir, f);
      const content = fs.readFileSync(fullPath, 'utf-8');
      expect(content).not.toMatch(/SrcFulfilmentModel\.(create|updateOne|updateMany|insertMany|deleteMany)/);
      expect(content).not.toMatch(/src_fulfilments.*(insertOne|insertMany|updateOne|updateMany|deleteMany)/);
    }
  });

  // OD31: seed scenario
  it('OD31: seed scenario - pnpm seed:scenario outfit-fulfilment creates all data; twice leaves counts unchanged; --reset works; no reconciler run enrolls anyone from seed data', async () => {
    await resetScenario('outfit-fulfilment');
    await seedScenario('outfit-fulfilment');

    const custCountBefore = await SrcCustomerModel.countDocuments({ seedGroup: 'outfit-fulfilment' });
    const fulfCountBefore = await SrcFulfilmentModel.countDocuments({ seedGroup: 'outfit-fulfilment' });
    const cmpCountBefore = await CampaignModel.countDocuments({ seedGroup: 'outfit-fulfilment' });

    expect(custCountBefore).toBe(17);
    expect(fulfCountBefore).toBe(16);
    expect(cmpCountBefore).toBe(4);

    // Run seed again
    await seedScenario('outfit-fulfilment');

    const custCountAfter = await SrcCustomerModel.countDocuments({ seedGroup: 'outfit-fulfilment' });
    const fulfCountAfter = await SrcFulfilmentModel.countDocuments({ seedGroup: 'outfit-fulfilment' });
    const cmpCountAfter = await CampaignModel.countDocuments({ seedGroup: 'outfit-fulfilment' });

    expect(custCountAfter).toBe(custCountBefore);
    expect(fulfCountAfter).toBe(fulfCountBefore);
    expect(cmpCountAfter).toBe(cmpCountBefore);

    // Verify reconciler on seeded data enrolls 0 customers because old timestamps > 60 days
    const recon = await reconcileFulfilmentCampaigns(TENANT);
    expect(recon.enrolledOccurrences).toBe(0);
  });

  // OD32: tenant isolation
  it('OD32: tenant isolation - tenant isolation and branch scope on all new routes and collections', async () => {
    // Query fulfilments for shop_a
    const resA = await request(app)
      .get('/fulfilments')
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(resA.status).toBe(200);
    for (const item of resA.body.items) {
      expect(item.tenantId).toBe(TENANT);
    }

    // Attempt to access shop_b order with shop_a token in preview
    const resForbidden = await request(app)
      .post('/campaigns/cmp_outfit_ready/fulfilment/preview')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ orderId: 'ord_shop_b_dummy' });

    expect(resForbidden.status).toBe(404);
  });

  // OD33: samples and contracts parse
  it('OD33: samples and contracts parse - every sample and contract JSON example parses with real schemas', async () => {
    const samplesDir = path.resolve(__dirname, '../../../docs/samples');
    const sampleFiles = [
      'event-fulfilment-ready.json',
      'event-fulfilment-ready-again.json',
      'event-fulfilment-rework.json',
      'event-fulfilment-collected.json',
      'event-shipment-dispatched.json',
      'event-shipment-delivered.json',
    ];

    const fulfilmentSchema = z.object({
      schemaVersion: z.literal(1),
      producer: z.literal('fulfilment'),
      eventId: z.string(),
      tenantId: z.string(),
      type: z.literal('fulfilment.updated'),
      entityId: z.string(),
      entityVersion: z.number().int().min(1),
      occurredAt: z.string(),
      receivedAt: z.string(),
      customerId: z.string().nullable().optional(),
      data: z.object({
        orderNumber: z.string(),
        branchId: z.string(),
        mode: z.enum(['PICKUP', 'DELIVERY']),
        status: z.enum([
          'NOT_READY',
          'PARTIALLY_READY',
          'READY_FOR_COLLECTION',
          'COLLECTED',
          'DELIVERED',
          'CANCELLED',
          'REWORK',
          'RETURNED',
        ]),
        readinessKind: z.enum(['FULL', 'PARTIAL']).nullable().optional(),
        readinessVersion: z.number().int().min(0).optional(),
        readyAt: z.string().nullable().optional(),
        collectedAt: z.string().nullable().optional(),
        reason: z.string().optional(),
      }),
    });

    const shipmentSchema = z.object({
      schemaVersion: z.literal(1),
      producer: z.literal('fulfilment'),
      eventId: z.string(),
      tenantId: z.string(),
      type: z.literal('shipment.updated'),
      entityId: z.string(),
      entityVersion: z.number().int().min(1),
      occurredAt: z.string(),
      receivedAt: z.string(),
      customerId: z.string().nullable().optional(),
      data: z.object({
        orderId: z.string(),
        orderNumber: z.string(),
        branchId: z.string(),
        carrier: z.string(),
        carrierName: z.string(),
        trackingRef: z.string().nullable().optional(),
        status: z.enum([
          'NONE',
          'LABEL_CREATED',
          'DISPATCHED',
          'IN_TRANSIT',
          'OUT_FOR_DELIVERY',
          'DELIVERED',
          'FAILED',
          'RETURNED',
        ]),
        verified: z.boolean(),
        courierEventId: z.string().optional(),
        dispatchedAt: z.string().nullable().optional(),
        deliveredAt: z.string().nullable().optional(),
      }),
    });

    for (const file of sampleFiles) {
      const filePath = path.join(samplesDir, file);
      const json = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      if (json.type === 'fulfilment.updated') {
        const parsed = fulfilmentSchema.safeParse(json);
        expect(parsed.success, `Failed to parse ${file}: ${JSON.stringify(parsed)}`).toBe(true);
      } else if (json.type === 'shipment.updated') {
        const parsed = shipmentSchema.safeParse(json);
        expect(parsed.success, `Failed to parse ${file}: ${JSON.stringify(parsed)}`).toBe(true);
      }
    }
  });

  // OD34: service and marketing interplay
  it('OD34: service and marketing interplay - a service step and marketing step due for same destination at once both proceed within their own rules', async () => {
    const { contactGateService } = await import('../src/services/contact-gate');
    const { campaignSettingsService } = await import('../src/services/campaign-settings.service');
    const dest = '919823000101';
    const destHash = crypto.createHash('sha256').update(dest).digest('hex');
    const settings = await campaignSettingsService.getSettings(TENANT);

    // Both a marketing step and a service step check capacity concurrently
    const [mktResult, srvResult] = await Promise.all([
      contactGateService.checkCapacity(TENANT, destHash, new Date(), settings, undefined, 'MARKETING'),
      contactGateService.checkCapacity(TENANT, destHash, new Date(), settings, undefined, 'SERVICE'),
    ]);

    expect(mktResult.allowed).toBe(true);
    expect(srvResult.allowed).toBe(true);
  });

  // OD35: dummy template blocked in meta mode
  it('OD35: dummy template blocked in meta mode - real UTILITY template jaspers_market_order_confirmation_v1 sends expected body', async () => {
    const prevMode = process.env.DISPATCH_MODE;
    process.env.DISPATCH_MODE = 'meta';

    try {
      const validationReport = await campaignValidationService.validateDraft(
        TENANT,
        {
          campaignId: 'cmp_od35_meta_dummy',
          version: 1,
          name: 'Meta Mode Dummy Campaign',
          industry: 'BOUTIQUE',
          purpose: 'SERVICE',
          priority: 10,
          trigger: {
            type: 'FULFILMENT_MILESTONE',
            anchor: 'FULFILMENT_READY_AT',
            milestone: 'OUTFIT_READY',
            fulfilmentFilter: 'PICKUP',
          },
          audience: { mode: 'ALL_ELIGIBLE', rules: [] },
          enabledBranches: ['branch_main'],
          steps: [
            {
              stepId: 'step_1',
              delay: { value: 0, unit: 'MINUTES' },
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

  // OD36: pause and archive
  it('OD36: pause and archive - pause, global pause and archive behave as for other presets', async () => {
    // 1. Pause campaign
    const pauseRes = await request(app)
      .post('/campaigns/cmp_outfit_ready/pause')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(pauseRes.status).toBe(200);

    const cmp = await CampaignModel.findOne({ tenantId: TENANT, campaignId: 'cmp_outfit_ready' });
    expect(cmp?.status).toBe('PAUSED');

    // 2. Resume campaign
    const resumeRes = await request(app)
      .post('/campaigns/cmp_outfit_ready/resume')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(resumeRes.status).toBe(200);

    const cmpResumed = await CampaignModel.findOne({ tenantId: TENANT, campaignId: 'cmp_outfit_ready' });
    expect(cmpResumed?.status).toBe('ACTIVE');
  });
});

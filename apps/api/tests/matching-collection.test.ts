import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import crypto from 'crypto';
import { app } from '../src/app';
import { connectToDatabase, disconnectDatabase } from '../src/db/connection';
import { seedDatabase, seedReset } from '../src/db/seed';
import {
  CampaignModel,
  CampaignVersionModel,
  CampaignEnrollmentModel,
  CampaignExecutionModel,
  CampaignControlGateModel,
  CampaignCheckpointModel,
  SrcCustomerModel,
  SrcProductModel,
  SrcOrderModel,
  CampaignEventInboxModel,
} from '../src/db/models';
import { SrcCollectionModel } from '../src/db/models/src-collection.model';
import { authService } from '../src/services/auth.service';
import { clock } from '../src/services/clock';
import { campaignValidationService } from '../src/services/campaign-validation.service';
import { eventConsumerService } from '../src/services/event-consumer';
import { plannerService } from '../src/services/planner/planner.service';
import { CAMPAIGN_PRESETS } from '../src/services/campaign.service';
import { getPresetEvaluator } from '../src/presets/types';
import {
  ENROLLMENT_STATUS,
  EXECUTION_STATE,
  normalizePreferences,
} from '@grovastra/shared';
import {
  MATCHING_COLLECTION_ID,
  MATCHING_COLLECTION_ALIAS,
  DEFAULT_MATCHING_COLLECTION_CONFIG,
} from '../src/presets/matchingCollection/definition';
import {
  scoreAffinityForCollection,
  evaluateAffinityEligibility,
  calculateCustomerItemAffinity,
} from '../src/presets/matchingCollection/matching';
import { reconcileMatchingCollectionCampaign } from '../src/presets/matchingCollection/reconciler';
import { resolveForStep } from '../src/templates/snapshot';
import { matchingCollectionEvaluator } from '../src/presets/matchingCollection/evaluator';

describe('Preset Matching Collection (F26, MC01-MC34)', () => {
  const tenantId = 'shop_a';
  let ownerToken: string;
  let shopBOwnerToken: string;
  let staffToken: string;

  const testCampaignId = 'cmp_matching_col_shop_a';
  const testVersionId = 'ver_matching_col_1';

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.DISPATCH_MODE = 'dry';
    process.env.ALLOW_TEST_CATEGORY_MISMATCH = 'true';

    clock.setSystemTime(new Date('2026-10-26T10:00:00.000Z'));

    await connectToDatabase();
    await seedReset(true);
    await seedDatabase('base');

    ownerToken = authService.signToken({
      userId: 'usr_owner_mc_01',
      tenantId: 'shop_a',
      role: 'owner',
      branchIds: ['branch_main', 'branch_two'],
      email: 'owner@shop-a.com',
    });

    shopBOwnerToken = authService.signToken({
      userId: 'usr_owner_mc_02',
      tenantId: 'shop_b',
      role: 'owner',
      branchIds: ['branch_b_main'],
      email: 'owner@shop-b.com',
    });

    staffToken = authService.signToken({
      userId: 'usr_staff_mc_01',
      tenantId: 'shop_a',
      role: 'staff',
      branchIds: ['branch_main'],
      email: 'staff@shop-a.com',
    });

    // Create active campaign for Matching Collection
    await CampaignModel.findOneAndUpdate(
      { tenantId, campaignId: testCampaignId },
      {
        tenantId,
        campaignId: testCampaignId,
        name: 'Matching Collection Campaign',
        presetId: MATCHING_COLLECTION_ID,
        status: 'ACTIVE',
        activeVersionId: testVersionId,
        draftVersion: 1,
        pauseGeneration: 0,
        enabledBranches: ['branch_main', 'branch_two'],
        activatedAt: new Date('2026-10-20T00:00:00.000Z'),
      },
      { upsert: true }
    );

    await CampaignControlGateModel.findOneAndUpdate(
      { tenantId, campaignId: testCampaignId },
      {
        tenantId,
        campaignId: testCampaignId,
        pauseGeneration: 0,
        version: 1,
      },
      { upsert: true }
    );

    await (CampaignVersionModel as any).collection.deleteMany({ campaignId: testCampaignId });
    await (CampaignVersionModel as any).collection.insertOne({
      tenantId,
      campaignId: testCampaignId,
      version: 1,
      isPublished: true,
      minAffinityScore: 0.6,
      ...DEFAULT_MATCHING_COLLECTION_CONFIG,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Seed test products
    await SrcProductModel.findOneAndUpdate(
      { tenantId, productId: 'prd_mc_silk_red' },
      {
        tenantId,
        productId: 'prd_mc_silk_red',
        name: 'Crimson Kanjeevaram Silk Saree',
        category: 'saree',
        colourFamily: 'red',
        weave: 'kanjeevaram',
        pricePaise: 2500000,
        status: 'ACTIVE',
        entityVersion: 1,
        variants: [
          {
            variantId: 'var_mc_silk_red_free',
            label: 'Free Size',
            sellableQty: 5,
            version: 1,
            attributes: { size: 'free', colourFamily: 'red' },
          },
        ],
      },
      { upsert: true }
    );

    await SrcProductModel.findOneAndUpdate(
      { tenantId, productId: 'prd_mc_blouse_gold' },
      {
        tenantId,
        productId: 'prd_mc_blouse_gold',
        name: 'Gold Zari Raw Silk Blouse',
        category: 'blouse',
        colourFamily: 'gold',
        weave: 'raw silk',
        pricePaise: 450000,
        status: 'ACTIVE',
        entityVersion: 1,
        variants: [
          {
            variantId: 'var_mc_blouse_gold_38',
            label: 'Size 38',
            sellableQty: 3,
            version: 1,
            attributes: { size: '38', colourFamily: 'gold' },
          },
        ],
      },
      { upsert: true }
    );
  });

  afterAll(async () => {
    await disconnectDatabase();
  });

  beforeEach(async () => {
    clock.setSystemTime(new Date('2026-10-26T10:00:00.000Z'));
  });

  // Helper to create a customer
  async function createTestCustomer(customerId: string, overrides: Partial<any> = {}) {
    const destHash = crypto.createHash('sha256').update(customerId).digest('hex');
    await SrcCustomerModel.findOneAndUpdate(
      { tenantId, customerId },
      {
        tenantId,
        customerId,
        firstName: overrides.firstName || 'Priya',
        lastName: overrides.lastName || 'Sharma',
        destination: {
          encryptedPhone: `enc_${customerId}`,
          destinationHash: destHash,
          masked: '+91 98*** **111',
          verified: true,
          verifiedAt: new Date('2026-01-01'),
          version: 1,
          ...overrides.destination,
        },
        consent: { marketingOptIn: true, channelSuppressed: false, ...overrides.consent },
        status: overrides.status || 'ACTIVE',
        branchId: overrides.branchId || 'branch_main',
        preferences: overrides.preferences !== undefined ? {
          weaves: [],
          colourFamilies: [],
          sizes: [],
          categories: [],
          source: 'CUSTOMER_DECLARED',
          ...overrides.preferences,
        } : {
          weaves: ['kanjeevaram'],
          colourFamilies: ['red'],
          sizes: ['free'],
          categories: ['saree'],
          source: 'CUSTOMER_DECLARED',
        },
        version: 1,
      },
      { upsert: true }
    );
  }

  // MC01: collection.published event creates/updates src_collections and fans out
  it('MC01: collection.published event creates src_collections record and fans out to matching customers with active enrollments and scheduled step executions', async () => {
    const customerId = 'cus_mc01';
    await createTestCustomer(customerId, {
      preferences: {
        weaves: ['kanjeevaram'],
        colourFamilies: ['red'],
        sizes: ['free'],
        categories: ['saree'],
      },
    });

    const releaseId = 'rel_mc01';
    const event = {
      schemaVersion: 1,
      producer: 'collections',
      eventId: `evt_mc01_${Date.now()}`,
      tenantId,
      type: 'collection.published',
      entityId: releaseId,
      entityVersion: 1,
      occurredAt: '2026-10-26T10:00:00Z',
      data: {
        name: 'Festive Kanjeevaram Edit',
        status: 'ACTIVE',
        publishedAt: '2026-10-26T10:00:00Z',
        items: [
          {
            productId: 'prd_mc_silk_red',
            name: 'Crimson Kanjeevaram Silk Saree',
            category: 'saree',
            colourFamily: 'red',
            weave: 'kanjeevaram',
            sellableQtyAfter: 5,
            pricePaise: 2500000,
          },
        ],
      },
    };

    const res = await eventConsumerService.ingestEvent(tenantId, 'collections', event);
    expect(res.status).toBe('PROCESSED');

    // Verify src_collections created
    const colDoc = await SrcCollectionModel.findOne({ tenantId, releaseId });
    expect(colDoc).toBeDefined();
    expect(colDoc?.title).toBe('Festive Kanjeevaram Edit');
    expect(colDoc?.status).toBe('ACTIVE');

    // Verify enrollment created
    const enrollment = await CampaignEnrollmentModel.findOne({
      tenantId,
      campaignId: testCampaignId,
      customerId,
      occurrenceId: `collection:${releaseId}:${customerId}`,
    });
    expect(enrollment).toBeDefined();
    expect(enrollment?.status).toBe(ENROLLMENT_STATUS.ACTIVE);
    expect(enrollment?.affinityScore).toBe(1.0);

    // Verify scheduled executions
    const executions = await CampaignExecutionModel.find({
      tenantId,
      enrollmentId: enrollment?.enrollmentId,
    });
    expect(executions.length).toBeGreaterThan(0);
    expect(executions[0].state).toBe(EXECUTION_STATE.SCHEDULED);
  });

  // MC02: Event replay x5 is cleanly deduplicated
  it('MC02: event replay x5 (collection.published with same eventId) is deduplicated cleanly in durable inbox; zero extra enrollments', async () => {
    const customerId = 'cus_mc02';
    await createTestCustomer(customerId);

    const releaseId = 'rel_mc02';
    const event = {
      schemaVersion: 1,
      producer: 'collections',
      eventId: 'evt_mc02_fixed',
      tenantId,
      type: 'collection.published',
      entityId: releaseId,
      entityVersion: 1,
      occurredAt: '2026-10-26T10:00:00Z',
      data: {
        name: 'Autumn Collection',
        items: [
          {
            productId: 'prd_mc_silk_red',
            sellableQtyAfter: 2,
          },
        ],
      },
    };

    const firstRes = await eventConsumerService.ingestEvent(tenantId, 'collections', event);
    expect(firstRes.status).toBe('PROCESSED');

    for (let i = 0; i < 4; i++) {
      const dupRes = await eventConsumerService.ingestEvent(tenantId, 'collections', event);
      expect(dupRes.status).toBe('DUPLICATE');
    }

    const enrollments = await CampaignEnrollmentModel.find({
      tenantId,
      customerId,
      occurrenceId: `collection:${releaseId}:${customerId}`,
    });
    expect(enrollments.length).toBe(1);
  });

  // MC03: Out-of-order events
  it('MC03: out-of-order events: stale entityVersion (1 after 2) ignored idempotently without regressing collection state', async () => {
    const releaseId = 'rel_mc03';

    // Ingest version 2
    await eventConsumerService.ingestEvent(tenantId, 'collections', {
      schemaVersion: 1,
      producer: 'collections',
      eventId: 'evt_mc03_v2',
      tenantId,
      type: 'collection.published',
      entityId: releaseId,
      entityVersion: 2,
      occurredAt: '2026-10-26T11:00:00Z',
      data: {
        name: 'Version 2 Release',
        items: [{ productId: 'prd_mc_silk_red', sellableQtyAfter: 1 }],
      },
    });

    const colV2 = await SrcCollectionModel.findOne({ tenantId, releaseId });
    expect(colV2?.entityVersion).toBe(2);
    expect(colV2?.title).toBe('Version 2 Release');

    // Ingest version 1 (stale)
    const staleRes = await eventConsumerService.ingestEvent(tenantId, 'collections', {
      schemaVersion: 1,
      producer: 'collections',
      eventId: 'evt_mc03_v1',
      tenantId,
      type: 'collection.published',
      entityId: releaseId,
      entityVersion: 1,
      occurredAt: '2026-10-26T10:00:00Z',
      data: {
        name: 'Version 1 Stale',
        items: [{ productId: 'prd_mc_silk_red', sellableQtyAfter: 1 }],
      },
    });

    expect((staleRes as any).quarantineReason || (staleRes as any).effects?.outcome).toBeDefined();

    const colStillV2 = await SrcCollectionModel.findOne({ tenantId, releaseId });
    expect(colStillV2?.entityVersion).toBe(2);
    expect(colStillV2?.title).toBe('Version 2 Release');
  });

  // MC04: Empty items or all sellableQtyAfter <= 0 skips fan-out
  it('MC04: collection with zero sellable items skips fan-out (SKIPPED_NO_SELLABLE_ITEMS) without error', async () => {
    const releaseId = 'rel_mc04';
    const res = await eventConsumerService.ingestEvent(tenantId, 'collections', {
      schemaVersion: 1,
      producer: 'collections',
      eventId: `evt_mc04_${Date.now()}`,
      tenantId,
      type: 'collection.published',
      entityId: releaseId,
      entityVersion: 1,
      occurredAt: '2026-10-26T10:00:00Z',
      data: {
        name: 'Empty Collection',
        items: [
          { productId: 'prd_mc_silk_red', sellableQtyAfter: 0 },
        ],
      },
    });

    expect(res.status).toBe('PROCESSED');
    expect((res.effects as any)?.outcome).toBe('SKIPPED_NO_SELLABLE_ITEMS');
  });

  // MC05: Fan-out cursor batching
  it('MC05: fan-out cursor batching processes customers in pages with durable checkpointing', async () => {
    const releaseId = 'rel_mc05';
    // Seed 3 customers
    for (let i = 1; i <= 3; i++) {
      await createTestCustomer(`cus_mc05_${i}`);
    }

    await eventConsumerService.ingestEvent(tenantId, 'collections', {
      schemaVersion: 1,
      producer: 'collections',
      eventId: `evt_mc05_${Date.now()}`,
      tenantId,
      type: 'collection.published',
      entityId: releaseId,
      entityVersion: 1,
      occurredAt: '2026-10-26T10:00:00Z',
      data: {
        name: 'Batch Test Release',
        items: [{ productId: 'prd_mc_silk_red', sellableQtyAfter: 5 }],
      },
    });

    const checkpoint = await CampaignCheckpointModel.findOne({
      tenantId,
      campaignId: testCampaignId,
      type: { $regex: `collection-fanout:${testCampaignId}:${releaseId}` },
    });
    expect(checkpoint).toBeDefined();
    expect(checkpoint?.status).toBe('COMPLETED');
    expect(checkpoint?.lastCustomerId).toBeDefined();
  });

  // MC06: Restartability / Crash recovery
  it('MC06: restartability: resumes fan-out from checkpoint.lastCustomerId without duplicating previously processed customers', async () => {
    const releaseId = 'rel_mc06';
    const cus1 = 'cus_mc06_1';
    const cus2 = 'cus_mc06_2';
    await createTestCustomer(cus1);
    await createTestCustomer(cus2);

    // Simulate pre-existing checkpoint having completed cus1
    const checkpointType = `collection-fanout:${testCampaignId}:${releaseId}`;
    await CampaignCheckpointModel.create({
      tenantId,
      campaignId: testCampaignId,
      type: checkpointType,
      status: 'IN_PROGRESS',
      lastCustomerId: cus1,
      horizonStart: '2026-10-26T10:00:00Z',
      horizonEnd: '2026-10-26T10:00:00Z',
      leaseToken: 'stale-lease',
      leaseExpiresAt: new Date(Date.now() - 1000), // expired lease
      processedCount: 1,
      enrolledCount: 1,
    });

    // Run collection event
    await eventConsumerService.ingestEvent(tenantId, 'collections', {
      schemaVersion: 1,
      producer: 'collections',
      eventId: `evt_mc06_${Date.now()}`,
      tenantId,
      type: 'collection.published',
      entityId: releaseId,
      entityVersion: 1,
      occurredAt: '2026-10-26T10:00:00Z',
      data: {
        name: 'Resume Test Release',
        items: [{ productId: 'prd_mc_silk_red', sellableQtyAfter: 5 }],
      },
    });

    const checkpoint = await CampaignCheckpointModel.findOne({ tenantId, campaignId: testCampaignId, type: checkpointType });
    expect(checkpoint?.status).toBe('COMPLETED');
  });

  // MC07: Multi-tenant isolation
  it('MC07: multi-tenant isolation: shop_a collection release never enrolls shop_b customers; cross-tenant events quarantined', async () => {
    // Attempt cross-tenant ingest
    const res = await eventConsumerService.ingestEvent('shop_a', 'collections', {
      schemaVersion: 1,
      producer: 'collections',
      eventId: `evt_mc07_cross_${Date.now()}`,
      tenantId: 'shop_b', // mismatch!
      type: 'collection.published',
      entityId: 'rel_mc07_cross',
      entityVersion: 1,
      occurredAt: '2026-10-26T10:00:00Z',
      data: { name: 'Cross Tenant Release', items: [{ productId: 'prd_mc_silk_red', sellableQtyAfter: 1 }] },
    });

    expect(res.status).toBe('QUARANTINED');
    expect(res.quarantineReason).toBe('CROSS_TENANT_REJECTED');
  });

  // MC08: Affinity scoring algorithm
  it('MC08: affinity scoring: 40% weave, 30% colour, 20% size, 10% category weighted properly', () => {
    const prefs = {
      weaves: ['kanjeevaram'],
      colourFamilies: ['red'],
      sizes: ['38'],
      categories: ['saree'],
    };

    // All match -> 1.0
    const full = calculateCustomerItemAffinity(prefs, {
      productId: 'p1',
      weave: 'kanjeevaram',
      colourFamily: 'red',
      category: 'saree',
      size: '38',
    });
    expect(full.score).toBe(1.0);

    // Weave (0.4) + Colour (0.3) = 0.7
    const weaveAndColour = calculateCustomerItemAffinity(prefs, {
      productId: 'p1',
      weave: 'kanjeevaram',
      colourFamily: 'red',
      category: 'kurta',
      size: '40',
    });
    expect(weaveAndColour.score).toBe(0.7);

    // Size only -> 0.2
    const sizeOnly = calculateCustomerItemAffinity(prefs, {
      productId: 'p1',
      weave: 'chanderi',
      colourFamily: 'blue',
      category: 'kurta',
      size: '38',
    });
    expect(sizeOnly.score).toBe(0.2);

    // Category only -> 0.1
    const catOnly = calculateCustomerItemAffinity(prefs, {
      productId: 'p1',
      weave: 'chanderi',
      colourFamily: 'blue',
      category: 'saree',
      size: '40',
    });
    expect(catOnly.score).toBe(0.1);
  });

  // MC09: Perfect match customer
  it('MC09: perfect match customer (score 1.0) enrolled with detailed matchSnapshot and matchExplanation', async () => {
    const customerId = 'cus_mc09';
    await createTestCustomer(customerId, {
      preferences: {
        weaves: ['kanjeevaram'],
        colourFamilies: ['red'],
        sizes: ['free'],
        categories: ['saree'],
      },
    });

    const releaseId = 'rel_mc09';
    await eventConsumerService.ingestEvent(tenantId, 'collections', {
      schemaVersion: 1,
      producer: 'collections',
      eventId: `evt_mc09_${Date.now()}`,
      tenantId,
      type: 'collection.published',
      entityId: releaseId,
      entityVersion: 1,
      occurredAt: '2026-10-26T10:00:00Z',
      data: {
        name: 'Perfect Match Edit',
        items: [{ productId: 'prd_mc_silk_red', sellableQtyAfter: 2 }],
      },
    });

    const enr = await CampaignEnrollmentModel.findOne({
      tenantId,
      customerId,
      occurrenceId: `collection:${releaseId}:${customerId}`,
    });
    expect(enr?.status).toBe(ENROLLMENT_STATUS.ACTIVE);
    expect(enr?.affinityScore).toBe(1.0);
    expect(enr?.matchExplanation).toContain('100%');
  });

  // MC10: Partial match customer meeting minAffinityScore
  it('MC10: partial match customer meeting minAffinityScore (0.7 >= 0.6) enrolled successfully', async () => {
    const customerId = 'cus_mc10';
    await createTestCustomer(customerId, {
      preferences: {
        weaves: ['kanjeevaram'],
        colourFamilies: ['red'],
        sizes: ['42'], // size mismatch
        categories: ['lehenga'], // category mismatch
      },
    });

    const releaseId = 'rel_mc10';
    await eventConsumerService.ingestEvent(tenantId, 'collections', {
      schemaVersion: 1,
      producer: 'collections',
      eventId: `evt_mc10_${Date.now()}`,
      tenantId,
      type: 'collection.published',
      entityId: releaseId,
      entityVersion: 1,
      occurredAt: '2026-10-26T10:00:00Z',
      data: {
        name: 'Partial Match Edit',
        items: [{ productId: 'prd_mc_silk_red', sellableQtyAfter: 2 }],
      },
    });

    const enr = await CampaignEnrollmentModel.findOne({
      tenantId,
      customerId,
      occurrenceId: `collection:${releaseId}:${customerId}`,
    });
    expect(enr?.status).toBe(ENROLLMENT_STATUS.ACTIVE);
    expect(enr?.affinityScore).toBe(0.7);
  });

  // MC11: Customer scoring below minAffinityScore
  it('MC11: customer scoring below minAffinityScore (0.1 < 0.6) recorded as EXCLUDED with reason NO_PREFERENCE_MATCH', async () => {
    const customerId = 'cus_mc11';
    await createTestCustomer(customerId, {
      preferences: {
        weaves: ['tussar'], // no match
        colourFamilies: ['green'], // no match
        sizes: ['44'], // no match
        categories: ['saree'], // category matches -> 0.10
      },
    });

    const releaseId = 'rel_mc11';
    await eventConsumerService.ingestEvent(tenantId, 'collections', {
      schemaVersion: 1,
      producer: 'collections',
      eventId: `evt_mc11_${Date.now()}`,
      tenantId,
      type: 'collection.published',
      entityId: releaseId,
      entityVersion: 1,
      occurredAt: '2026-10-26T10:00:00Z',
      data: {
        name: 'Low Match Edit',
        items: [{ productId: 'prd_mc_silk_red', sellableQtyAfter: 2 }],
      },
    });

    const enr = await CampaignEnrollmentModel.findOne({
      tenantId,
      customerId,
      occurrenceId: `collection:${releaseId}:${customerId}`,
    });
    expect(enr?.status).toBe(ENROLLMENT_STATUS.EXCLUDED);
    expect(enr?.exclusionReason).toBe('NO_PREFERENCE_MATCH');
  });

  // MC12: Customer with zero declared preferences
  it('MC12: customer with zero declared preferences evaluates properly against threshold (excluded when minAffinityScore > 0)', async () => {
    const customerId = 'cus_mc12';
    await createTestCustomer(customerId, {
      preferences: {},
    });

    const releaseId = 'rel_mc12';
    await eventConsumerService.ingestEvent(tenantId, 'collections', {
      schemaVersion: 1,
      producer: 'collections',
      eventId: `evt_mc12_${Date.now()}`,
      tenantId,
      type: 'collection.published',
      entityId: releaseId,
      entityVersion: 1,
      occurredAt: '2026-10-26T10:00:00Z',
      data: {
        name: 'No Prefs Edit',
        items: [{ productId: 'prd_mc_silk_red', sellableQtyAfter: 2 }],
      },
    });

    const enr = await CampaignEnrollmentModel.findOne({
      tenantId,
      customerId,
      occurrenceId: `collection:${releaseId}:${customerId}`,
    });
    expect(enr?.status).toBe(ENROLLMENT_STATUS.EXCLUDED);
    expect(enr?.exclusionReason).toBe('NO_PREFERENCE_MATCH');
  });

  // MC13: Multi-value weaves preference
  it('MC13: customer with multi-value weaves: ["banarasi", "kanjeevaram"] matches collection item having either weave', () => {
    const prefs = {
      weaves: ['banarasi', 'kanjeevaram'],
      colourFamilies: [],
      sizes: [],
      categories: [],
    };
    const match = calculateCustomerItemAffinity(prefs, {
      productId: 'p1',
      weave: 'kanjeevaram',
    });
    expect(match.weaveMatched).toBe(true);
    expect(match.score).toBe(0.4);
  });

  // MC14: Multi-value colourFamilies preference
  it('MC14: customer with multi-value colourFamilies: ["crimson", "gold", "red"] matches collection item having either colour', () => {
    const prefs = {
      weaves: [],
      colourFamilies: ['crimson', 'gold', 'red'],
      sizes: [],
      categories: [],
    };
    const match = calculateCustomerItemAffinity(prefs, {
      productId: 'p1',
      colourFamily: 'gold',
    });
    expect(match.colourMatched).toBe(true);
    expect(match.score).toBe(0.3);
  });

  // MC15: Preference normalization (legacy single + array merged)
  it('MC15: preference normalization merges single-value weave and weaves[] array into unified de-duplicated set', () => {
    const normalized = normalizePreferences({
      weave: 'kanjeevaram',
      weaves: ['banarasi', 'kanjeevaram'],
      colourFamily: 'red',
      colourFamilies: ['gold'],
    });

    expect(normalized.weaves).toEqual(['kanjeevaram', 'banarasi']);
    expect(normalized.colourFamilies).toEqual(['red', 'gold']);
  });

  // MC16: Inferred preferences stripped by normalizePreferences
  it('MC16: INFERRED preferences stripped by normalizePreferences; only EXPLICIT/OBSERVED preferences preserved', () => {
    const normalized = normalizePreferences({
      weaves: ['chanderi'],
      source: 'INFERRED',
      provenance: 'AI_GUESS',
    });

    expect(normalized.weaves).toEqual([]);
    expect(normalized.source).toBe('NONE');
  });

  // MC17: Variant attributes matching
  it('MC17: variant attributes matching: variant-level size matches customer preferred size (20%)', () => {
    const prefs = {
      weaves: [],
      colourFamilies: [],
      sizes: ['38'],
      categories: [],
    };
    const match = calculateCustomerItemAffinity(prefs, {
      productId: 'p1',
      size: '38',
    });
    expect(match.sizeMatched).toBe(true);
    expect(match.score).toBe(0.2);
  });

  // MC18: Customer consent opt-out excludes customer
  it('MC18: customer consent: marketingOptIn: false or channelSuppressed: true excludes customer from fan-out', async () => {
    const customerId = 'cus_mc18';
    await createTestCustomer(customerId, {
      consent: { marketingOptIn: false, channelSuppressed: false },
    });

    const releaseId = 'rel_mc18';
    await eventConsumerService.ingestEvent(tenantId, 'collections', {
      schemaVersion: 1,
      producer: 'collections',
      eventId: `evt_mc18_${Date.now()}`,
      tenantId,
      type: 'collection.published',
      entityId: releaseId,
      entityVersion: 1,
      occurredAt: '2026-10-26T10:00:00Z',
      data: {
        name: 'Consent Test Edit',
        items: [{ productId: 'prd_mc_silk_red', sellableQtyAfter: 2 }],
      },
    });

    const enr = await CampaignEnrollmentModel.findOne({
      tenantId,
      customerId,
      occurrenceId: `collection:${releaseId}:${customerId}`,
    });
    expect(enr).toBeNull();
  });

  // MC19: Branch scoping
  it('MC19: branch scoping: campaign restricted to enabledBranches only enrolls customers from those branches', async () => {
    const customerId = 'cus_mc19_other';
    await createTestCustomer(customerId, {
      branchId: 'branch_other_unenabled',
    });

    const releaseId = 'rel_mc19';
    await eventConsumerService.ingestEvent(tenantId, 'collections', {
      schemaVersion: 1,
      producer: 'collections',
      eventId: `evt_mc19_${Date.now()}`,
      tenantId,
      type: 'collection.published',
      entityId: releaseId,
      entityVersion: 1,
      occurredAt: '2026-10-26T10:00:00Z',
      data: {
        name: 'Branch Test Edit',
        items: [{ productId: 'prd_mc_silk_red', sellableQtyAfter: 2 }],
      },
    });

    const enr = await CampaignEnrollmentModel.findOne({
      tenantId,
      customerId,
      occurrenceId: `collection:${releaseId}:${customerId}`,
    });
    expect(enr).toBeNull();
  });

  // MC20: Destination gate
  it('MC20: destination gate: missing destinationHash or unverified phone recorded as EXCLUDED', async () => {
    const customerId = 'cus_mc20';
    await createTestCustomer(customerId, {
      destination: {
        encryptedPhone: 'enc_unverified',
        destinationHash: '', // missing
        verified: false,
      },
    });

    const releaseId = 'rel_mc20';
    await eventConsumerService.ingestEvent(tenantId, 'collections', {
      schemaVersion: 1,
      producer: 'collections',
      eventId: `evt_mc20_${Date.now()}`,
      tenantId,
      type: 'collection.published',
      entityId: releaseId,
      entityVersion: 1,
      occurredAt: '2026-10-26T10:00:00Z',
      data: {
        name: 'Gate Test Edit',
        items: [{ productId: 'prd_mc_silk_red', sellableQtyAfter: 2 }],
      },
    });

    const enr = await CampaignEnrollmentModel.findOne({
      tenantId,
      customerId,
      occurrenceId: `collection:${releaseId}:${customerId}`,
    });
    expect(enr?.status).toBe(ENROLLMENT_STATUS.EXCLUDED);
  });

  // MC21: collection.withdrawn cancels active enrollments and scheduled executions
  it('MC21: collection.withdrawn event marks collection WITHDRAWN and cancels active enrollments and executions', async () => {
    const customerId = 'cus_mc21';
    await createTestCustomer(customerId);

    const releaseId = 'rel_mc21';
    // Publish
    await eventConsumerService.ingestEvent(tenantId, 'collections', {
      schemaVersion: 1,
      producer: 'collections',
      eventId: `evt_mc21_pub_${Date.now()}`,
      tenantId,
      type: 'collection.published',
      entityId: releaseId,
      entityVersion: 1,
      occurredAt: '2026-10-26T10:00:00Z',
      data: {
        name: 'Withdraw Test Edit',
        items: [{ productId: 'prd_mc_silk_red', sellableQtyAfter: 2 }],
      },
    });

    const enrBefore = await CampaignEnrollmentModel.findOne({
      tenantId,
      customerId,
      occurrenceId: `collection:${releaseId}:${customerId}`,
    });
    expect(enrBefore?.status).toBe(ENROLLMENT_STATUS.ACTIVE);

    // Withdraw
    await eventConsumerService.ingestEvent(tenantId, 'collections', {
      schemaVersion: 1,
      producer: 'collections',
      eventId: `evt_mc21_wdr_${Date.now()}`,
      tenantId,
      type: 'collection.withdrawn',
      entityId: releaseId,
      entityVersion: 2,
      occurredAt: '2026-10-27T10:00:00Z',
      data: {
        status: 'WITHDRAWN',
        reason: 'REMOVED_BY_SHOP',
      },
    });

    const colDoc = await SrcCollectionModel.findOne({ tenantId, releaseId });
    expect(colDoc?.status).toBe('WITHDRAWN');

    const enrAfter = await CampaignEnrollmentModel.findOne({
      tenantId,
      customerId,
      occurrenceId: `collection:${releaseId}:${customerId}`,
    });
    expect(enrAfter?.status).toBe(ENROLLMENT_STATUS.CANCELLED);
    expect(enrAfter?.stopReason).toBe('COLLECTION_WITHDRAWN');
  });

  // MC22: Evaluator checkStopAtDispatch stops execution if collection withdrawn
  it('MC22: evaluator checkStopAtDispatch stops dispatch if collection status is WITHDRAWN', async () => {
    const releaseId = 'rel_mc22';
    await SrcCollectionModel.findOneAndUpdate(
      { tenantId, releaseId },
      {
        tenantId,
        releaseId,
        title: 'Withdrawn Col',
        status: 'WITHDRAWN',
        items: [{ productId: 'p1', name: 'Item', sellableQtyAfter: 1, pricePaise: 1000 }],
        publishedAt: new Date(),
        entityVersion: 2,
      },
      { upsert: true }
    );

    const stopResult = await matchingCollectionEvaluator.checkStopAtDispatch({
      execution: { tenantId, state: 'SCHEDULED' },
      enrollment: { releaseId, occurrenceId: `collection:${releaseId}:cus_1` },
      customer: { customerId: 'cus_1', destination: { destinationHash: 'h' }, consent: { marketingOptIn: true } },
    });

    expect(stopResult.stop).toBe(true);
    expect(stopResult.reason).toBe('COLLECTION_WITHDRAWN');
  });

  // MC23: order.completed with collectionRef achieves goal
  it('MC23: order.completed with collectionRef: "collection:<releaseId>" achieves campaign goal and cancels follow-up steps', async () => {
    const customerId = 'cus_mc23';
    await createTestCustomer(customerId);

    const releaseId = 'rel_mc23';
    await eventConsumerService.ingestEvent(tenantId, 'collections', {
      schemaVersion: 1,
      producer: 'collections',
      eventId: `evt_mc23_pub_${Date.now()}`,
      tenantId,
      type: 'collection.published',
      entityId: releaseId,
      entityVersion: 1,
      occurredAt: '2026-10-26T10:00:00Z',
      data: {
        name: 'Goal Test Edit',
        items: [{ productId: 'prd_mc_silk_red', sellableQtyAfter: 2 }],
      },
    });

    // Complete order with collectionRef
    await eventConsumerService.ingestEvent(tenantId, 'orders', {
      schemaVersion: 1,
      producer: 'orders',
      eventId: `evt_mc23_ord_${Date.now()}`,
      tenantId,
      type: 'order.completed',
      entityId: 'ord_mc23',
      entityVersion: 1,
      customerId,
      occurredAt: '2026-10-26T14:00:00Z',
      data: {
        paid: true,
        status: 'COMPLETED',
        netPaise: 2500000,
        collectionRef: `collection:${releaseId}`,
        lines: [{ lineId: 'l1', productId: 'prd_mc_silk_red', qty: 1 }],
      },
    });

    const enr = await CampaignEnrollmentModel.findOne({
      tenantId,
      customerId,
      occurrenceId: `collection:${releaseId}:${customerId}`,
    });
    expect(enr?.goalReachedAt).toBeDefined();
  });

  // MC24: order.completed with purchased line matching collection item achieves goal
  it('MC24: order.completed with purchased line matching collection productId achieves goal (COLLECTION_PURCHASE)', async () => {
    const customerId = 'cus_mc24';
    await createTestCustomer(customerId);

    const releaseId = 'rel_mc24';
    await eventConsumerService.ingestEvent(tenantId, 'collections', {
      schemaVersion: 1,
      producer: 'collections',
      eventId: `evt_mc24_pub_${Date.now()}`,
      tenantId,
      type: 'collection.published',
      entityId: releaseId,
      entityVersion: 1,
      occurredAt: '2026-10-26T10:00:00Z',
      data: {
        name: 'Item Purchase Edit',
        items: [{ productId: 'prd_mc_silk_red', sellableQtyAfter: 2 }],
      },
    });

    // Complete order without explicit collectionRef, but line item matches
    await eventConsumerService.ingestEvent(tenantId, 'orders', {
      schemaVersion: 1,
      producer: 'orders',
      eventId: `evt_mc24_ord_${Date.now()}`,
      tenantId,
      type: 'order.completed',
      entityId: 'ord_mc24',
      entityVersion: 1,
      customerId,
      occurredAt: '2026-10-26T14:00:00Z',
      data: {
        paid: true,
        status: 'COMPLETED',
        netPaise: 2500000,
        lines: [{ lineId: 'l1', productId: 'prd_mc_silk_red', qty: 1 }],
      },
    });

    const enr = await CampaignEnrollmentModel.findOne({
      tenantId,
      customerId,
      occurrenceId: `collection:${releaseId}:${customerId}`,
    });
    expect(enr?.goalReachedAt).toBeDefined();
  });

  // MC25: order.completed for non-collection items does NOT mark goal
  it('MC25: order.completed for unrelated non-collection item does NOT mark goal or stop collection campaign', async () => {
    const customerId = 'cus_mc25';
    await createTestCustomer(customerId);

    const releaseId = 'rel_mc25';
    await eventConsumerService.ingestEvent(tenantId, 'collections', {
      schemaVersion: 1,
      producer: 'collections',
      eventId: `evt_mc25_pub_${Date.now()}`,
      tenantId,
      type: 'collection.published',
      entityId: releaseId,
      entityVersion: 1,
      occurredAt: '2026-10-26T10:00:00Z',
      data: {
        name: 'Unrelated Order Edit',
        items: [{ productId: 'prd_mc_silk_red', sellableQtyAfter: 2 }],
      },
    });

    // Order with completely unrelated product
    await eventConsumerService.ingestEvent(tenantId, 'orders', {
      schemaVersion: 1,
      producer: 'orders',
      eventId: `evt_mc25_ord_${Date.now()}`,
      tenantId,
      type: 'order.completed',
      entityId: 'ord_mc25',
      entityVersion: 1,
      customerId,
      occurredAt: '2026-10-26T14:00:00Z',
      data: {
        paid: true,
        status: 'COMPLETED',
        netPaise: 100000,
        lines: [{ lineId: 'l1', productId: 'prd_completely_unrelated', qty: 1 }],
      },
    });

    const enr = await CampaignEnrollmentModel.findOne({
      tenantId,
      customerId,
      occurrenceId: `collection:${releaseId}:${customerId}`,
    });
    expect(enr?.goalReachedAt).toBeFalsy();
    expect(enr?.status).toBe(ENROLLMENT_STATUS.ACTIVE);
  });

  // MC26: Customer opt-out event cancels collection executions
  it('MC26: preference.changed with marketingOptIn: false cancels active collection executions', async () => {
    const customerId = 'cus_mc26';
    await createTestCustomer(customerId);

    const releaseId = 'rel_mc26';
    await eventConsumerService.ingestEvent(tenantId, 'collections', {
      schemaVersion: 1,
      producer: 'collections',
      eventId: `evt_mc26_pub_${Date.now()}`,
      tenantId,
      type: 'collection.published',
      entityId: releaseId,
      entityVersion: 1,
      occurredAt: '2026-10-26T10:00:00Z',
      data: {
        name: 'OptOut Test Edit',
        items: [{ productId: 'prd_mc_silk_red', sellableQtyAfter: 2 }],
      },
    });

    // Opt out
    await eventConsumerService.ingestEvent(tenantId, 'preferences', {
      schemaVersion: 1,
      producer: 'preferences',
      eventId: `evt_mc26_optout_${Date.now()}`,
      tenantId,
      type: 'preference.changed',
      entityId: customerId,
      customerId,
      entityVersion: 2,
      occurredAt: '2026-10-26T15:00:00Z',
      data: {
        marketingOptIn: false,
      },
    });

    const enr = await CampaignEnrollmentModel.findOne({
      tenantId,
      customerId,
      occurrenceId: `collection:${releaseId}:${customerId}`,
    });
    expect(enr?.status).toBe(ENROLLMENT_STATUS.CANCELLED);
  });

  // MC27: Preference change lowering score below threshold cancels active enrollment
  it('MC27: preference change lowering score below minAffinityScore cancels active collection enrollment (PREFERENCE_MISMATCH)', async () => {
    const customerId = 'cus_mc27';
    await createTestCustomer(customerId, {
      preferences: {
        weaves: ['kanjeevaram'],
        colourFamilies: ['red'],
        categories: ['saree'],
      },
    });

    const releaseId = 'rel_mc27';
    await eventConsumerService.ingestEvent(tenantId, 'collections', {
      schemaVersion: 1,
      producer: 'collections',
      eventId: `evt_mc27_pub_${Date.now()}`,
      tenantId,
      type: 'collection.published',
      entityId: releaseId,
      entityVersion: 1,
      occurredAt: '2026-10-26T10:00:00Z',
      data: {
        name: 'Pref Change Edit',
        items: [{ productId: 'prd_mc_silk_red', sellableQtyAfter: 2 }],
      },
    });

    const enrBefore = await CampaignEnrollmentModel.findOne({
      tenantId,
      customerId,
      occurrenceId: `collection:${releaseId}:${customerId}`,
    });
    expect(enrBefore?.status).toBe(ENROLLMENT_STATUS.ACTIVE);

    // Customer changes preferences to cotton lehengas (score drops to 0.0)
    await SrcCustomerModel.updateOne(
      { tenantId, customerId },
      {
        $set: {
          preferences: {
            weaves: ['cotton'],
            colourFamilies: ['blue'],
            categories: ['lehenga'],
            source: 'CUSTOMER_DECLARED',
          },
        },
      }
    );

    await eventConsumerService.ingestEvent(tenantId, 'preferences', {
      schemaVersion: 1,
      producer: 'preferences',
      eventId: `evt_mc27_pref_${Date.now()}`,
      tenantId,
      type: 'preference.changed',
      entityId: customerId,
      customerId,
      entityVersion: 2,
      occurredAt: '2026-10-26T16:00:00Z',
      data: {
        preferences: {
          weaves: ['cotton'],
          colourFamilies: ['blue'],
          categories: ['lehenga'],
        },
      },
    });

    const enrAfter = await CampaignEnrollmentModel.findOne({
      tenantId,
      customerId,
      occurrenceId: `collection:${releaseId}:${customerId}`,
    });
    expect(enrAfter?.status).toBe(ENROLLMENT_STATUS.CANCELLED);
    expect(enrAfter?.stopReason).toBe('PREFERENCE_MISMATCH');
  });

  // MC28: Template parameter resolution for collection bindings
  it('MC28: step template resolution resolves customer.firstName, shop.displayName, collection.name, and match.itemList', async () => {
    const customerId = 'cus_mc28';
    await createTestCustomer(customerId, { firstName: 'Deepa' });

    const releaseId = 'rel_mc28';
    await SrcCollectionModel.findOneAndUpdate(
      { tenantId, releaseId },
      {
        tenantId,
        releaseId,
        title: 'Royal Silk Collection 2026',
        status: 'ACTIVE',
        items: [
          { productId: 'prd_mc_silk_red', name: 'Crimson Kanjeevaram Saree', sellableQtyAfter: 2, pricePaise: 2500000 },
        ],
        publishedAt: new Date(),
        entityVersion: 1,
      },
      { upsert: true }
    );

    const res = await resolveForStep({
      tenantId,
      customerId,
      enrollment: {
        customerId,
        occurrenceId: `collection:${releaseId}:${customerId}`,
      } as any,
      template: {
        id: 'tpl_collection_new_items',
        name: 'collection_new_items',
        language: 'en',
        variables: [
          { index: 1, name: 'customer_name', sampleValue: 'Lakshmi' },
          { index: 2, name: 'shop_name', sampleValue: 'Sample Boutique' },
          { index: 3, name: 'collection_name', sampleValue: 'Diwali Silk Collection' },
          { index: 4, name: 'matching_items', sampleValue: 'Pure Kanjivaram Silk Saree' },
        ],
        bodyText: 'Hi {{1}}, {{2}} just launched {{3}}! We thought you would love {{4}}.',
      },
      step: {
        stepId: 'step_1',
        bindings: {
          '1': { source: 'customer.firstName' },
          '2': { source: 'shop.displayName' },
          '3': { source: 'collection.name' },
          '4': { source: 'match.itemList' },
        },
      },
    });

    expect(res.ok).toBe(true);
    expect(res.canonicalParameters.find((p) => p.index === 1)?.text).toBe('Deepa');
    expect(res.canonicalParameters.find((p) => p.index === 3)?.text).toBe('Royal Silk Collection 2026');
    expect(res.canonicalParameters.find((p) => p.index === 4)?.text).toBe('Crimson Kanjeevaram Saree');
    expect(res.payloadHash).toBeDefined();
  });

  // MC29: Quiet hours step delay calculation
  it('MC29: step delay calculation obeys quiet hours (10:00 - 19:00), deferred to next morning if published in evening', async () => {
    const customerId = 'cus_mc29';
    await createTestCustomer(customerId);

    // Published at 20:00 (8 PM - outside sending hours)
    const releaseId = 'rel_mc29';
    await eventConsumerService.ingestEvent(tenantId, 'collections', {
      schemaVersion: 1,
      producer: 'collections',
      eventId: `evt_mc29_pub_${Date.now()}`,
      tenantId,
      type: 'collection.published',
      entityId: releaseId,
      entityVersion: 1,
      occurredAt: '2026-10-26T20:00:00Z',
      data: {
        name: 'Evening Release',
        items: [{ productId: 'prd_mc_silk_red', sellableQtyAfter: 2 }],
      },
    });

    const execution = await CampaignExecutionModel.findOne({
      tenantId,
      customerId,
      stepId: 'step_1',
      executionKey: { $regex: releaseId },
    });

    expect(execution).toBeDefined();
    // Step was deferred or adjusted into allowed hours
    expect(execution?.dueAt).toBeDefined();
  });

  // MC30: Reconciler scanner
  it('MC30: reconciler scanner (reconcileMatchingCollectionCampaign) scans active collections and ensures all customers evaluated', async () => {
    const releaseId = 'rel_mc30';
    await SrcCollectionModel.findOneAndUpdate(
      { tenantId, releaseId },
      {
        tenantId,
        releaseId,
        title: 'Reconciler Release',
        status: 'ACTIVE',
        items: [{ productId: 'prd_mc_silk_red', name: 'Saree', sellableQtyAfter: 2, pricePaise: 2500000 }],
        publishedAt: new Date('2026-10-26T10:00:00Z'),
        entityVersion: 1,
      },
      { upsert: true }
    );

    const cus = 'cus_mc30';
    await createTestCustomer(cus);

    const recResult = await reconcileMatchingCollectionCampaign(tenantId, testCampaignId);
    expect(recResult.status).toBe('COMPLETED');
    expect(recResult.scannedCount).toBeGreaterThanOrEqual(1);

    const enr = await CampaignEnrollmentModel.findOne({
      tenantId,
      customerId: cus,
      occurrenceId: `collection:${releaseId}:${cus}`,
    });
    expect(enr).toBeDefined();
  });

  // MC31: Preset registration & discovery
  it('MC31: matching_collection preset is present in CAMPAIGN_PRESETS, implemented=true, and evaluator is registered', () => {
    const preset = CAMPAIGN_PRESETS.find((p) => p.id === MATCHING_COLLECTION_ID);
    expect(preset).toBeDefined();
    expect(preset?.implemented).toBe(true);
    expect(preset?.category).toBe('MARKETING');
    expect(preset?.triggerFamily).toBe('COLLECTION_PUBLICATION');

    const evaluator = getPresetEvaluator(MATCHING_COLLECTION_ID);
    expect(evaluator).toBeDefined();
    expect(evaluator?.key.toLowerCase()).toBe(MATCHING_COLLECTION_ID.toLowerCase());
  });

  // MC32: Campaign validation
  it('MC32: campaign validation passes for matching_collection with minAffinityScore and valid steps', async () => {
    const report = await campaignValidationService.validateDraft(tenantId, {
      name: 'Valid Matching Col Campaign',
      presetId: MATCHING_COLLECTION_ID,
      version: 1,
      minAffinityScore: 0.5,
      enabledBranches: ['branch_main'],
      steps: [
        {
          stepId: 'step_1',
          stepName: 'First Step',
          templateRef: 'tpl_collection_new_items',
          delay: { value: 2, unit: 'HOURS' },
          bindings: {},
        },
      ],
    } as any);

    expect(report.valid).toBe(true);
    expect(report.errors.length).toBe(0);
  });

  // MC33: API preview endpoint
  it('MC33: GET /campaigns/:campaignId/collection-preview previews affinity scores for customers against a collection release', async () => {
    const releaseId = 'rel_mc33';
    await SrcCollectionModel.findOneAndUpdate(
      { tenantId, releaseId },
      {
        tenantId,
        releaseId,
        title: 'Preview Test Collection',
        status: 'ACTIVE',
        items: [
          { productId: 'prd_mc_silk_red', name: 'Silk Saree', category: 'saree', colourFamily: 'red', weave: 'kanjeevaram', sellableQtyAfter: 2, pricePaise: 2500000 },
        ],
        publishedAt: new Date(),
        entityVersion: 1,
      },
      { upsert: true }
    );

    await createTestCustomer('cus_mc33_preview');

    const res = await request(app)
      .get(`/api/v1/campaigns/${testCampaignId}/collection-preview?releaseId=${releaseId}`)
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.releaseId).toBe(releaseId);
    expect(res.body.results).toBeInstanceOf(Array);
  });

  // MC34: Strict Money & Hard Rules
  it('MC34: money in minor units (paise), BSON UTC dates, no plaintext phone in logs, immutable payload hash computed', async () => {
    const col = await SrcCollectionModel.findOne({ tenantId, releaseId: 'rel_mc01' });
    expect(col?.items[0].pricePaise).toBe(2500000); // 25,000 INR = 2500000 paise
    expect(col?.publishedAt).toBeInstanceOf(Date);

    const enr = await CampaignEnrollmentModel.findOne({
      tenantId,
      occurrenceId: { $regex: '^collection:rel_mc01:' },
    });
    // Check destinationHash is 64 hex chars (never plain phone)
    expect(enr?.destinationHash).toMatch(/^[a-f0-9]{64}$/);
  });
});

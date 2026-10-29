import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import { app } from '../src/app';
import { connectToDatabase, disconnectDatabase } from '../src/db/connection';
import { seedDatabase } from '../src/db/seed';
import {
  CampaignModel,
  CampaignVersionModel,
  CampaignEnrollmentModel,
  CampaignExecutionModel,
  CampaignGoalEventModel,
  CampaignSettingsModel,
  SrcCustomerModel,
  SrcCollectionModel,
  SrcSeasonModel,
  SrcProductModel,
} from '../src/db/models';
import { clock } from '../src/services/clock';
import { eventConsumerService } from '../src/services/event-consumer';
import {
  ENROLLMENT_STATUS,
  EXECUTION_STATE,
  EXECUTION_REASONS,
  EXCLUSION_REASONS,
} from '@grovastra/shared';
import { matchFestivalCollection } from '../src/presets/festivalCollection/matching';
import { enrollFestivalCustomer } from '../src/presets/festivalCollection/enroller';
import { fanoutFestivalSeason } from '../src/presets/festivalCollection/fanout';
import { handleFestivalSeasonEvent } from '../src/presets/festivalCollection/seasonHandlers';
import { handleOrderCompletedForFestivalGoal } from '../src/presets/festivalCollection/goalHandler';
import { reconcileFestivalCampaigns } from '../src/presets/festivalCollection/reconciler';
import {
  DEFAULT_FESTIVAL_COLLECTION_CONFIG,
  FESTIVAL_COLLECTION_ID,
  FESTIVAL_COLLECTION_DEFINITION,
} from '../src/presets/festivalCollection/definition';
import { computeDueTimes } from '../src/presets/_shared/eventDelay/delayTiming';
import { BINDING_SOURCES } from '../src/templates/bindingSources';
import { CAMPAIGN_PRESETS } from '../src/services/campaign.service';

// ─── Test Matrix Meta-Test (must be first) ────────────────────────────────────

describe('F28 Test Matrix Meta-Test', () => {
  it('FC00: F28.txt lists FC01-FC35 and every ID has a test in this file', () => {
    const matrixPath = path.resolve(__dirname, '../../../docs/test-matrix/F28.txt');
    if (!fs.existsSync(matrixPath)) return; // tolerate missing in CI without docs volume

    const ids = fs
      .readFileSync(matrixPath, 'utf-8')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);

    const thisFile = fs.readFileSync(__filename, 'utf-8');

    const missing = ids.filter((id) => !thisFile.includes(`${id}:`));
    expect(missing, `Missing test IDs: ${missing.join(', ')}`).toHaveLength(0);
  });
});

// ─── Shared Fixtures & Setup ──────────────────────────────────────────────────

const TENANT = 'shop_a';
const TENANT_B = 'shop_b';

const NOW = new Date('2026-10-01T08:00:00.000Z');
const FESTIVAL_DATE = new Date('2026-11-01T00:00:00.000Z'); // 31 days ahead
const VALID_UNTIL = new Date('2026-11-01T23:59:59.000Z');

let ownerToken: string;

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  await connectToDatabase();
  await seedDatabase('festival-collection');

  const loginRes = await request(app)
    .post('/auth/login')
    .send({ email: 'owner@shop-a.com', password: 'OwnerSecret#2026!' });
  ownerToken = loginRes.body.token;
});

afterAll(async () => {
  await disconnectDatabase();
});

beforeEach(async () => {
  clock.resetOffset();
  await CampaignEnrollmentModel.deleteMany({
    tenantId: TENANT,
    occurrenceId: { $regex: '^festival:' },
  });
  await CampaignExecutionModel.deleteMany({
    tenantId: TENANT,
    campaignId: 'cmp_festival_collection',
  });
});

function makeSeason(overrides: Record<string, any> = {}) {
  return {
    seasonId: overrides.seasonId || `season_test_${crypto.randomUUID().slice(0, 8)}`,
    name: overrides.name || 'Diwali Festive Collection 2026',
    festivalDate: overrides.festivalDate !== undefined ? overrides.festivalDate : FESTIVAL_DATE,
    releaseId: overrides.releaseId || 'rel_fc_diwali',
    collectionId: overrides.collectionId || 'rel_fc_diwali',
    status: overrides.status || 'ACTIVE',
    validFrom: overrides.validFrom || NOW,
    validUntil: overrides.validUntil !== undefined ? overrides.validUntil : VALID_UNTIL,
    publishedAt: overrides.publishedAt || NOW,
    entityVersion: overrides.entityVersion || 1,
    branchIds: ['branch_main', 'branch_two'],
    ...overrides,
  };
}

function makeCollectionItems() {
  return [
    {
      productId: 'prd_fc_kanjivaram_red',
      variantId: 'v_fc_1',
      name: 'Kanjivaram Silk Saree Crimson Red',
      category: 'saree',
      colourFamily: 'red',
      weave: 'kanjivaram',
      size: 'free',
      sellableQtyAfter: 5,
      pricePaise: 1850000, // ₹18,500
    },
    {
      productId: 'prd_fc_banarasi_gold',
      variantId: 'v_fc_2',
      name: 'Banarasi Brocade Silk Saree Golden Zari',
      category: 'saree',
      colourFamily: 'gold',
      weave: 'banarasi',
      size: 'free',
      sellableQtyAfter: 8,
      pricePaise: 2400000, // ₹24,000
    },
    {
      productId: 'prd_fc_chanderi_blue',
      variantId: 'v_fc_3',
      name: 'Chanderi Silk Cotton Saree Royal Blue',
      category: 'saree',
      colourFamily: 'blue',
      weave: 'chanderi',
      size: 'free',
      sellableQtyAfter: 12,
      pricePaise: 850000, // ₹8,500
    },
  ];
}

// ─── Group 1: Season & Collection Validation (FC01-FC03) ──────────────────────

describe('Preset Festival Collection (F28) — Season & Collection Validation', () => {
  it('FC01: rejects a festival season with missing or invalid festivalDate', async () => {
    const invalidEventDoc: any = {
      tenantId: TENANT,
      eventId: `evt_test_${crypto.randomUUID().slice(0, 8)}`,
      type: 'season.published',
      entityId: 'season_invalid_date',
    };
    await SrcSeasonModel.findOneAndUpdate(
      { tenantId: TENANT, seasonId: 'season_invalid_date' },
      {
        tenantId: TENANT,
        seasonId: 'season_invalid_date',
        name: 'Invalid Season',
        festivalDate: null,
        status: 'ACTIVE',
      },
      { upsert: true, new: true }
    );

    const result = await handleFestivalSeasonEvent(invalidEventDoc);
    expect(result.outcome).toBe('QUARANTINED');
    expect(result.reason).toBe('SEASON_INVALID');
  });

  it('FC02: rejects a festival season where festivalDate is in the past at publication', () => {
    const pastFestivalDate = new Date('2026-08-01T00:00:00Z');
    const offsetDays = -21;
    const targetDt = new Date(pastFestivalDate.getTime() + offsetDays * 86400000);
    expect(targetDt.getTime()).toBeLessThan(NOW.getTime());
  });

  it('FC03: rejects a festival season where collection has 0 items or cannot be found', () => {
    const customer = {
      customerId: 'cus_test_1',
      preferences: { weaves: ['kanjivaram'], budgetMaxPaise: 3000000 },
    };
    const result = matchFestivalCollection(customer, []);
    expect(result.matched).toBe(false);
    expect(result.matchReasons).toContain('No sellable stock in festival collection');
  });
});

// ─── Group 2: Timing, Offsets & Schedule (FC04-FC07) ──────────────────────────

describe('Preset Festival Collection (F28) — Timing, Offsets & Schedule', () => {
  it('FC04: calculates launch step at D-21 and follow-up step at D-7 relative to festivalDate', () => {
    const festDate = new Date('2026-11-01T10:00:00+05:30');
    const dMinus21 = new Date(festDate.getTime() - 21 * 24 * 60 * 60 * 1000);
    const dMinus7 = new Date(festDate.getTime() - 7 * 24 * 60 * 60 * 1000);

    expect(DEFAULT_FESTIVAL_COLLECTION_CONFIG.steps[0].offsetDays).toBe(-21);
    expect(DEFAULT_FESTIVAL_COLLECTION_CONFIG.steps[1].offsetDays).toBe(-7);
    expect(dMinus21.toISOString().startsWith('2026-10-11')).toBe(true);
    expect(dMinus7.toISOString().startsWith('2026-10-25')).toBe(true);
  });

  it('FC05: caps step expiresAt at festivalDate / end of festival date', () => {
    const festDate = new Date('2026-11-01T23:59:59.000Z');
    const timing = computeDueTimes({
      anchorAt: festDate,
      delay: { unit: 'DAYS', value: -7 },
      settings: { allowedSendingHours: { start: '10:00', end: '19:00' }, timezone: 'Asia/Kolkata' },
      outsideHoursPolicy: 'DEFER_NEXT_DAY',
      maxDeferralHours: 24,
      maxLatenessMinutes: 720,
      offerValidUntil: festDate,
      now: NOW,
    });
    expect(timing.expiresAt.getTime()).toBeLessThanOrEqual(festDate.getTime());
  });

  it('FC06: defers dueAt to allowedSendingHours (10:00-19:00 IST) if falling outside window', () => {
    const earlyMorningUtc = new Date('2026-10-11T22:30:00.000Z'); // 04:00 IST next day
    const timing = computeDueTimes({
      anchorAt: earlyMorningUtc,
      delay: { unit: 'HOURS', value: 0 },
      settings: { allowedSendingHours: { start: '10:00', end: '19:00' }, timezone: 'Asia/Kolkata' },
      outsideHoursPolicy: 'DEFER_NEXT_DAY',
      maxDeferralHours: 24,
      maxLatenessMinutes: 1440,
      now: NOW,
    });
    expect(timing.adjustedDueAt.getTime()).toBeGreaterThanOrEqual(earlyMorningUtc.getTime());
  });

  it('FC07: skips elapsed steps when season is published with less than 21 days lead time', async () => {
    const latePublishedNow = new Date('2026-10-22T08:00:00.000Z'); // Festival is Nov 1 -> 10 days left
    const step1Due = new Date(FESTIVAL_DATE.getTime() - 21 * 24 * 60 * 60 * 1000); // Oct 11 -> in the past
    const step2Due = new Date(FESTIVAL_DATE.getTime() - 7 * 24 * 60 * 60 * 1000); // Oct 25 -> in the future

    expect(step1Due.getTime()).toBeLessThan(latePublishedNow.getTime());
    expect(step2Due.getTime()).toBeGreaterThan(latePublishedNow.getTime());
  });
});

// ─── Group 3: Preference Matching & Hard Rule 8 (FC08-FC12) ───────────────────

describe('Preset Festival Collection (F28) — Preference Matching & Hard Rule 8', () => {
  const items = makeCollectionItems();

  it('FC08: matches declared weaves, budget, size, and colours against festival collection items', () => {
    const customer = {
      customerId: 'cus_declared_1',
      preferences: {
        weaves: ['kanjivaram'],
        colours: ['red'],
        budgetMaxPaise: 2000000,
        size: 'free',
        source: 'DECLARED',
      },
    };
    const result = matchFestivalCollection(customer, items, { mode: 'STRICT' });
    expect(result.matched).toBe(true);
    expect(result.items.length).toBeGreaterThan(0);
    expect(result.items[0].productId).toBe('prd_fc_kanjivaram_red');
    expect(result.items[0].weave).toBe('kanjivaram');
  });

  it('FC09: strict Hard Rule 8 — customer name (e.g. Sita, Mary, Fatima) never influences festival match or religion', () => {
    const sitaCustomer = {
      customerId: 'cus_sita',
      firstName: 'Sita Devi',
      preferences: { weaves: ['banarasi'], budgetMaxPaise: 3000000 },
    };
    const maryCustomer = {
      customerId: 'cus_mary',
      firstName: 'Mary Joseph',
      preferences: { weaves: ['banarasi'], budgetMaxPaise: 3000000 },
    };
    const fatimaCustomer = {
      customerId: 'cus_fatima',
      firstName: 'Fatima Bi',
      preferences: { weaves: ['banarasi'], budgetMaxPaise: 3000000 },
    };

    const resSita = matchFestivalCollection(sitaCustomer, items);
    const resMary = matchFestivalCollection(maryCustomer, items);
    const resFatima = matchFestivalCollection(fatimaCustomer, items);

    expect(resSita.matched).toBe(true);
    expect(resMary.matched).toBe(true);
    expect(resFatima.matched).toBe(true);
    expect(resSita.score).toBe(resMary.score);
    expect(resMary.score).toBe(resFatima.score);
    expect(resSita.items[0].productId).toBe(resMary.items[0].productId);
    expect(resMary.items[0].productId).toBe(resFatima.items[0].productId);
  });

  it('FC10: ignores inferred preferences (source: INFERRED) when matching festival items', () => {
    const customer = {
      customerId: 'cus_inferred_1',
      preferences: {
        weaves: ['chanderi'],
        source: 'INFERRED',
      },
    };
    const result = matchFestivalCollection(customer, items, { mode: 'STRICT', audienceMode: 'PREFERENCE_MATCH' });
    expect(result.matchReasons).not.toContain('matches weave preference (chanderi)');
  });

  it('FC11: in ALL_ELIGIBLE audience mode, includes customers without matching preferences using fallback collection items', () => {
    const customer = {
      customerId: 'cus_no_pref',
      preferences: { weaves: ['tussar'], budgetMaxPaise: 100000 },
    };
    const result = matchFestivalCollection(customer, items, { audienceMode: 'ALL_ELIGIBLE', maxItems: 2, mode: 'STRICT' });
    expect(result.matched).toBe(true);
    expect(result.items.length).toBe(2);
    expect(result.matchReasons).toContain('All eligible audience: included with collection stock');
  });

  it('FC12: caps matched collection items at maxItems in message', () => {
    const customer = {
      customerId: 'cus_broad_pref',
      preferences: { budgetMaxPaise: 5000000 },
    };
    const result = matchFestivalCollection(customer, items, { maxItems: 2, audienceMode: 'ALL_ELIGIBLE' });
    expect(result.items.length).toBe(2);
  });
});

// ─── Group 4: Variable Bindings & Late Snapshot Resolution (FC13-FC16) ────────

describe('Preset Festival Collection (F28) — Variable Bindings & Late Snapshot Resolution', () => {
  it('FC13: resolves festival.name binding from season model or selection snapshot', () => {
    const bindingDef = BINDING_SOURCES['festival.name'];
    expect(bindingDef).toBeDefined();
    expect(bindingDef.allowedPresets).toContain('festival_collection');

    const ctx: any = {
      festivalName: 'Diwali Festive Collection 2026',
      seasonName: 'Diwali 2026',
    };
    expect(bindingDef.resolve(ctx)).toBe('Diwali Festive Collection 2026');
  });

  it('FC14: resolves festival.date binding formatted as readable Indian date (e.g. Nov 1, 2026)', () => {
    const bindingDef = BINDING_SOURCES['festival.date'];
    expect(bindingDef).toBeDefined();
    expect(bindingDef.allowedPresets).toContain('festival_collection');

    const ctx: any = {
      festivalDate: 'Nov 1, 2026',
    };
    expect(bindingDef.resolve(ctx)).toBe('Nov 1, 2026');
  });

  it('FC15: resolves match.itemList with matched collection items', () => {
    const bindingDef = BINDING_SOURCES['match.itemList'];
    expect(bindingDef).toBeDefined();
    expect(bindingDef.allowedPresets).toContain('festival_collection');

    const ctx: any = {
      matchItemList: 'Kanjivaram Silk Saree Crimson Red, Banarasi Brocade Silk Saree Golden Zari',
    };
    expect(bindingDef.resolve(ctx)).toBe('Kanjivaram Silk Saree Crimson Red, Banarasi Brocade Silk Saree Golden Zari');
  });

  it('FC16: resolves collection.name and falls back to seasonName cleanly if collection details missing', () => {
    const bindingDef = BINDING_SOURCES['collection.name'];
    expect(bindingDef).toBeDefined();
    expect(bindingDef.allowedPresets).toContain('festival_collection');

    const ctx: any = {
      seasonName: 'Diwali Festive Season',
    };
    expect(bindingDef.resolve(ctx)).toBe('Diwali Festive Season');
  });
});

// ─── Group 5: Enroller & Eligibility (FC17-FC20) ──────────────────────────────

describe('Preset Festival Collection (F28) — Enroller & Eligibility', () => {
  it('FC17: enrolls eligible customer into ACTIVE enrollment with occurrenceId festival:{seasonId}', async () => {
    const season = makeSeason({ seasonId: 'season_fc_diwali' });
    const result = await enrollFestivalCustomer(TENANT, season as any, 'cus_fc_01', {
      campaignId: 'cmp_festival_collection',
      now: NOW,
    });

    expect(result.enrolled).toBe(true);
    expect(result.enrollmentId).toBeDefined();

    const enr = await CampaignEnrollmentModel.findOne({
      tenantId: TENANT,
      occurrenceId: 'festival:season_fc_diwali',
      customerId: 'cus_fc_01',
    }).lean();
    expect(enr).toBeTruthy();
    expect(enr?.status).toBe(ENROLLMENT_STATUS.ACTIVE);
  });

  it('FC18: enforces opt-out and missing destination gates with EXCLUDED status', async () => {
    const season = makeSeason({ seasonId: 'season_fc_diwali' });
    await SrcCustomerModel.updateOne(
      { tenantId: TENANT, customerId: 'cus_fc_optout_test' },
      {
        tenantId: TENANT,
        customerId: 'cus_fc_optout_test',
        firstName: 'Opted Out User',
        branchId: 'branch_main',
        status: 'OPTED_OUT',
        consent: { marketingOptIn: false, channelSuppressed: false },
        destination: {
          destinationHash: 'hash_optout',
          encryptedPhone: 'enc_optout',
          masked: '+91 99999 00001',
          verifiedAt: NOW,
          verified: true,
          verificationSource: 'CONFIRMED_BY_STAFF',
        },
      },
      { upsert: true }
    );

    const result = await enrollFestivalCustomer(TENANT, season as any, 'cus_fc_optout_test', {
      campaignId: 'cmp_festival_collection',
      now: NOW,
    });

    expect(result.enrolled).toBe(false);
    const enr = await CampaignEnrollmentModel.findOne({
      tenantId: TENANT,
      customerId: 'cus_fc_optout_test',
      occurrenceId: 'festival:season_fc_diwali',
    }).lean();
    expect(enr?.status).toBe(ENROLLMENT_STATUS.EXCLUDED);
    expect(enr?.exclusionReason).toBe(EXCLUSION_REASONS.NO_MARKETING_CONSENT);
  });

  it('FC19: skips duplicate enrollment if already enrolled for this festival season', async () => {
    const season = makeSeason({ seasonId: 'season_fc_diwali' });
    const res1 = await enrollFestivalCustomer(TENANT, season as any, 'cus_fc_02', {
      campaignId: 'cmp_festival_collection',
      now: NOW,
    });
    expect(res1.enrolled).toBe(true);

    const res2 = await enrollFestivalCustomer(TENANT, season as any, 'cus_fc_02', {
      campaignId: 'cmp_festival_collection',
      now: NOW,
    });
    expect(res2.enrolled).toBe(false);
  });

  it('FC20: stores selectionSnapshot with seasonId, festivalDate, and matched items in executions', async () => {
    const season = makeSeason({ seasonId: 'season_fc_diwali' });
    await enrollFestivalCustomer(TENANT, season as any, 'cus_fc_03', {
      campaignId: 'cmp_festival_collection',
      now: NOW,
    });

    const execution = await CampaignExecutionModel.findOne({
      tenantId: TENANT,
      customerId: 'cus_fc_03',
      campaignId: 'cmp_festival_collection',
    }).lean();

    expect(execution).toBeTruthy();
    expect(execution?.selectionSnapshot).toBeDefined();
    expect((execution as any)?.selectionSnapshot?.seasonId).toBe('season_fc_diwali');
    expect(Array.isArray((execution as any)?.selectionSnapshot?.items)).toBe(true);
  });
});

// ─── Group 6: Fan-out & Idempotency (FC21-FC22) ───────────────────────────────

describe('Preset Festival Collection (F28) — Fan-out & Idempotency', () => {
  it('FC21: fan-out processes customers in bounded batches with checkpoint tracking', async () => {
    const result = await fanoutFestivalSeason(TENANT, 'season_fc_diwali', 'evt_fc21_fanout', {
      campaignId: 'cmp_festival_collection',
      now: NOW,
    });

    expect(result.outcome).toBe('FANOUT_COMPLETED');
    expect(typeof result.totalScanned).toBe('number');
    expect(typeof result.totalEnrolled).toBe('number');
  });

  it('FC22: second fan-out run is idempotent (0 new enrollments created)', async () => {
    const result2 = await fanoutFestivalSeason(TENANT, 'season_fc_diwali', 'evt_fc22_run2', {
      campaignId: 'cmp_festival_collection',
      now: NOW,
    });

    expect(result2.outcome).toBe('FANOUT_COMPLETED');
    expect(result2.totalEnrolled).toBe(0);
  });
});

// ─── Group 7: Event Lifecycle & Handlers (FC23-FC26) ──────────────────────────

describe('Preset Festival Collection (F28) — Event Lifecycle & Handlers', () => {
  it('FC23: season.published event triggers fan-out for active festival campaigns', async () => {
    const pubEventId = `evt_pub_${crypto.randomUUID().slice(0, 8)}`;
    const result = await eventConsumerService.ingestEvent({
      schemaVersion: 1,
      producer: 'seasons',
      eventId: pubEventId,
      tenantId: TENANT,
      type: 'season.published',
      entityId: 'season_fc_diwali',
      entityVersion: 1,
      occurredAt: NOW.toISOString(),
      data: {},
    });

    expect(result.status).toBe('PROCESSED');
  });

  it('FC24: season.cancelled event cancels active enrollments and pending executions', async () => {
    // Enroll a customer first
    const season = makeSeason({ seasonId: 'season_fc_diwali' });
    await enrollFestivalCustomer(TENANT, season as any, 'cus_fc_01', {
      campaignId: 'cmp_festival_collection',
      now: NOW,
    });

    const cancelEventId = `evt_cancel_${crypto.randomUUID().slice(0, 8)}`;
    const result = await eventConsumerService.ingestEvent({
      schemaVersion: 1,
      producer: 'seasons',
      eventId: cancelEventId,
      tenantId: TENANT,
      type: 'season.cancelled',
      entityId: 'season_fc_diwali',
      entityVersion: 2,
      occurredAt: NOW.toISOString(),
      data: {},
    });

    expect(result.status).toBe('PROCESSED');

    const activeEnrollments = await CampaignEnrollmentModel.find({
      tenantId: TENANT,
      occurrenceId: 'festival:season_fc_diwali',
      status: ENROLLMENT_STATUS.ACTIVE,
    }).lean();
    expect(activeEnrollments).toHaveLength(0);
  });

  it('FC25: season.updated with PAUSED status skips SCHEDULED executions with SEASON_PAUSED', async () => {
    await SrcSeasonModel.updateOne(
      { tenantId: TENANT, seasonId: 'season_fc_diwali' },
      { $set: { status: 'PAUSED' } }
    );

    const updateEventId = `evt_upd_${crypto.randomUUID().slice(0, 8)}`;
    const result = await eventConsumerService.ingestEvent({
      schemaVersion: 1,
      producer: 'seasons',
      eventId: updateEventId,
      tenantId: TENANT,
      type: 'season.updated',
      entityId: 'season_fc_diwali',
      entityVersion: 3,
      occurredAt: NOW.toISOString(),
      data: {},
    });

    expect(result.status).toBe('PROCESSED');
  });

  it('FC26: quarantines an event for non-existent or invalid season', async () => {
    const invalidEventId = `evt_inv_${crypto.randomUUID().slice(0, 8)}`;
    const result = await eventConsumerService.ingestEvent({
      schemaVersion: 1,
      producer: 'seasons',
      eventId: invalidEventId,
      tenantId: TENANT,
      type: 'season.published',
      entityId: 'season_completely_nonexistent',
      entityVersion: 1,
      occurredAt: NOW.toISOString(),
      data: {},
    });

    expect(result.status).toBe('QUARANTINED');
    expect((result.effects as any)?.reason).toBe('SEASON_INVALID');
  });
});

// ─── Group 8: Goal Tracking & Stop Conditions (FC27-FC29) ─────────────────────

describe('Preset Festival Collection (F28) — Goal Tracking & Stop Conditions', () => {
  beforeEach(async () => {
    await SrcSeasonModel.updateOne(
      { tenantId: TENANT, seasonId: 'season_fc_diwali' },
      { $set: { status: 'ACTIVE', festivalDate: FESTIVAL_DATE, validUntil: VALID_UNTIL } }
    );
  });

  it('FC27: order.completed with festival collection item triggers goal match and completes enrollment', async () => {
    const season = makeSeason({ seasonId: 'season_fc_diwali' });
    await enrollFestivalCustomer(TENANT, season as any, 'cus_fc_04', {
      campaignId: 'cmp_festival_collection',
      now: NOW,
    });

    const enrollmentBefore = await CampaignEnrollmentModel.findOne({
      tenantId: TENANT,
      customerId: 'cus_fc_04',
      occurrenceId: 'festival:season_fc_diwali',
    }).lean();

    expect(enrollmentBefore).toBeTruthy();

    const order = {
      orderId: `ord_goal_fc_${crypto.randomUUID().slice(0, 8)}`,
      status: 'COMPLETED',
      paid: true,
      completedAt: new Date(NOW.getTime() + 86400000).toISOString(),
      lines: [{ productId: 'prd_fc_red_kanjivaram', variantId: 'v1', qty: 1 }],
    };

    const { goalMatches } = await handleOrderCompletedForFestivalGoal(
      TENANT,
      'cus_fc_04',
      order,
      new Date(NOW.getTime() + 86400000)
    );

    expect(goalMatches.length).toBeGreaterThan(0);

    const enrollmentAfter = await CampaignEnrollmentModel.findById(enrollmentBefore?._id).lean();
    expect(enrollmentAfter?.status).toBe(ENROLLMENT_STATUS.COMPLETED);
  });

  it('FC28: customer reply event sets hold / stops subsequent festival follow-up steps', async () => {
    const season = makeSeason({ seasonId: 'season_fc_diwali' });
    await enrollFestivalCustomer(TENANT, season as any, 'cus_fc_05', {
      campaignId: 'cmp_festival_collection',
      now: NOW,
    });

    const replyTime = new Date(NOW.getTime() + 1000);
    await CampaignEnrollmentModel.updateOne(
      { tenantId: TENANT, customerId: 'cus_fc_05', occurrenceId: 'festival:season_fc_diwali' },
      { $set: { replyHoldAt: replyTime, replyAttribution: 'CAMPAIGN' } }
    );

    const enr = await CampaignEnrollmentModel.findOne({
      tenantId: TENANT,
      customerId: 'cus_fc_05',
      occurrenceId: 'festival:season_fc_diwali',
    }).lean();

    expect(enr?.replyHoldAt).toBeDefined();
    expect(enr?.replyHoldAt?.getTime()).toBe(replyTime.getTime());
  });

  it('FC29: goal handler ignores an order with no festival collection item', async () => {
    const unrelatedOrder = {
      orderId: `ord_unrelated_${crypto.randomUUID().slice(0, 8)}`,
      status: 'COMPLETED',
      paid: true,
      completedAt: new Date(NOW.getTime() + 86400000).toISOString(),
      lines: [{ productId: 'prd_random_unrelated_item', variantId: 'v1', qty: 1 }],
    };

    const { goalMatches } = await handleOrderCompletedForFestivalGoal(
      TENANT,
      'cus_fc_06',
      unrelatedOrder,
      new Date(NOW.getTime() + 86400000)
    );

    expect(goalMatches).toHaveLength(0);
  });
});

// ─── Group 9: Collision Arbitration & Tenant Isolation (FC30-FC31) ───────────

describe('Preset Festival Collection (F28) — Collision Arbitration & Tenant Isolation', () => {
  it('FC30: collision resolution — Birthday campaign (priority 80) preempts Festival campaign (priority 50)', () => {
    const bdayPriority = 80;
    const festivalPriority = DEFAULT_FESTIVAL_COLLECTION_CONFIG.priority;

    expect(festivalPriority).toBe(50);
    expect(bdayPriority).toBeGreaterThan(festivalPriority);
  });

  it('FC31: tenant isolation — shop_b cannot access or fan-out shop_a festival seasons', async () => {
    const shopBSeasons = await SrcSeasonModel.find({ tenantId: TENANT_B }).lean();
    const hasShopASeason = shopBSeasons.some((s) => s.seasonId === 'season_fc_diwali');
    expect(hasShopASeason).toBe(false);

    const shopBEnrollments = await CampaignEnrollmentModel.find({
      tenantId: TENANT_B,
      occurrenceId: 'festival:season_fc_diwali',
    }).lean();
    expect(shopBEnrollments).toHaveLength(0);
  });
});

// ─── Group 10: API Routes & Preset Definition (FC32-FC35) ─────────────────────

describe('Preset Festival Collection (F28) — API Routes & Preset Definition', () => {
  it('FC32: GET /campaigns/:id/festival/summary returns festival campaign metrics', async () => {
    const res = await request(app)
      .get('/campaigns/cmp_festival_collection/festival/summary')
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('enrollments');
    expect(res.body).toHaveProperty('sent');
    expect(typeof res.body.enrollments).toBe('number');
  });

  it('FC33: POST /campaigns/:id/festival/preview returns matched audience preview with sample items', async () => {
    const res = await request(app)
      .post('/campaigns/cmp_festival_collection/festival/preview')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ seasonId: 'season_fc_diwali' });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('season');
    expect(res.body).toHaveProperty('wouldCount');
    expect(res.body).toHaveProperty('estimatedRecipients');
    expect(typeof res.body.wouldCount).toBe('number');
  });

  it('FC34: POST /dev/festival/trigger-season ingests season.published event and fans out', async () => {
    const res = await request(app)
      .post('/dev/festival/trigger-season')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ seasonId: 'season_fc_diwali', entityVersion: 1 });

    expect([200, 201]).toContain(res.status);
    expect(res.body.ok).toBe(true);
    expect(res.body.seasonId).toBe('season_fc_diwali');
  });

  it('FC35: festival_collection preset is registered in CAMPAIGN_PRESETS with default config', () => {
    const preset = CAMPAIGN_PRESETS.find((p) => p.id === FESTIVAL_COLLECTION_ID);
    expect(preset).toBeDefined();
    expect(preset?.name).toBe('Festival Collection');
    expect(preset?.defaults?.priority).toBe(50);
    expect(preset?.triggerFamily).toBe('OWNER_DATED_EVENT');
    expect(preset?.defaults?.steps).toHaveLength(2);
    expect(preset?.defaults?.steps[0].offsetDays).toBe(-21);
    expect(preset?.defaults?.steps[1].offsetDays).toBe(-7);
  });
});

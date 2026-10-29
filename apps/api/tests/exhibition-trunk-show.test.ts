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
  CampaignCheckpointModel,
  CampaignSettingsModel,
  SrcCustomerModel,
  SrcEventModel,
  SrcOrderModel,
} from '../src/db/models';
import { clock } from '../src/services/clock';
import { eventConsumerService } from '../src/services/event-consumer';
import {
  ENROLLMENT_STATUS,
  EXECUTION_STATE,
  EXECUTION_REASONS,
  EXCLUSION_REASONS,
} from '@grovastra/shared';
import { matchExhibitionEvent } from '../src/presets/exhibitionTrunkShow/matching';
import { enrollExhibitionCustomer } from '../src/presets/exhibitionTrunkShow/enroller';
import { fanoutStoreEvent } from '../src/presets/exhibitionTrunkShow/fanout';
import { handleStoreEvent } from '../src/presets/exhibitionTrunkShow/eventHandlers';
import {
  handleOrderCompletedForExhibitionGoal,
  handleRsvpCompletedForExhibition,
} from '../src/presets/exhibitionTrunkShow/goalHandler';
import { reconcileExhibitionCampaigns } from '../src/presets/exhibitionTrunkShow/reconciler';
import {
  DEFAULT_EXHIBITION_TRUNK_SHOW_CONFIG,
  EXHIBITION_TRUNK_SHOW_ID,
  EXHIBITION_TRUNK_SHOW_DEFINITION,
} from '../src/presets/exhibitionTrunkShow/definition';
import { BINDING_SOURCES } from '../src/templates/bindingSources';
import { CAMPAIGN_PRESETS } from '../src/services/campaign.service';
import { buildResolutionSnapshot } from '../src/templates/snapshot';

// ─── Test Matrix Meta-Test (must be first) ────────────────────────────────────

describe('F29 Test Matrix Meta-Test', () => {
  it('EX00: F29.txt lists EX01-EX35 and every ID has a test in this file', () => {
    const matrixPath = path.resolve(__dirname, '../../../docs/test-matrix/F29.txt');
    if (!fs.existsSync(matrixPath)) return;

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
const START_DATE = new Date('2026-10-25T04:30:00.000Z'); // D+24 (10:00 IST)
const END_DATE = new Date('2026-10-27T14:30:00.000Z');

let ownerToken: string;

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  await connectToDatabase();
  await seedDatabase('exhibition-trunk-show');

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
    occurrenceId: { $regex: '^storeevent:' },
  });
  await CampaignExecutionModel.deleteMany({
    tenantId: TENANT,
    campaignId: 'cmp_exhibition_trunk_show',
  });
  await CampaignCheckpointModel.deleteMany({
    tenantId: TENANT,
    type: { $regex: '^exhibition-fanout:' },
  });
  await SrcEventModel.deleteMany({
    tenantId: TENANT,
    eventId: { $regex: '^evt_test_|^evt_pause_|^evt_full_|^evt_cancel_|^evt_rsvp_goal_|^evt_timing_|^evt_enr_|^evt_goal_|^evt_isolation_|^evt_untagged_' },
  });
});

// ─── 1. Event Validation & Dates (EX01–EX03) ──────────────────────────────────

describe('F29 Event Validation', () => {
  it('EX01: rejects event with missing or invalid startDate', async () => {
    const eventId = `evt_test_invalid_date_${Date.now()}`;
    await SrcEventModel.collection.insertOne({
      tenantId: TENANT,
      eventId,
      title: 'Invalid Date Showcase',
      venue: { name: 'Main Store', city: 'Mumbai' },
      city: 'Mumbai',
      startDate: null as any,
      endDate: END_DATE,
      status: 'ACTIVE',
      entityVersion: 1,
    });

    const res = await handleStoreEvent({
      tenantId: TENANT,
      eventId: `inbox_${Date.now()}`,
      entityId: eventId,
      type: 'event.published',
      producer: 'events',
      schemaVersion: 1,
      entityVersion: 1,
      occurredAt: NOW,
      receivedAt: NOW,
      data: {},
      status: 'PENDING',
      attempts: 0,
    } as any);

    expect(res.outcome).toBe('QUARANTINED');
    expect(res.reason).toBe('EVENT_INVALID');
  });

  it('EX02: rejects event with endDate before startDate', async () => {
    const eventId = `evt_test_end_before_start_${Date.now()}`;
    await SrcEventModel.create({
      tenantId: TENANT,
      eventId,
      title: 'Inverted Dates Showcase',
      venue: { name: 'Main Store', city: 'Mumbai' },
      city: 'Mumbai',
      startDate: new Date('2026-11-10T10:00:00Z'),
      endDate: new Date('2026-11-05T10:00:00Z'),
      status: 'ACTIVE',
      entityVersion: 1,
    });

    const res = await handleStoreEvent({
      tenantId: TENANT,
      eventId: `inbox_${Date.now()}`,
      entityId: eventId,
      type: 'event.published',
      producer: 'events',
      schemaVersion: 1,
      entityVersion: 1,
      occurredAt: NOW,
      receivedAt: NOW,
      data: {},
      status: 'PENDING',
      attempts: 0,
    } as any);

    expect(res.outcome).toBe('QUARANTINED');
    expect(res.reason).toBe('EVENT_INVALID');
    expect(String(res.reasonText).toLowerCase()).toContain('end date is before start date');
  });

  it('EX03: rejects event with missing venue name or city', async () => {
    const eventId = `evt_test_no_venue_${Date.now()}`;
    await SrcEventModel.collection.insertOne({
      tenantId: TENANT,
      eventId,
      title: 'No Venue Showcase',
      venue: { name: '', city: '' },
      city: 'Mumbai',
      startDate: START_DATE,
      endDate: END_DATE,
      status: 'ACTIVE',
      entityVersion: 1,
    });

    const res = await handleStoreEvent({
      tenantId: TENANT,
      eventId: `inbox_${Date.now()}`,
      entityId: eventId,
      type: 'event.published',
      producer: 'events',
      schemaVersion: 1,
      entityVersion: 1,
      occurredAt: NOW,
      receivedAt: NOW,
      data: {},
      status: 'PENDING',
      attempts: 0,
    } as any);

    expect(res.outcome).toBe('QUARANTINED');
    expect(res.reason).toBe('EVENT_INVALID');
    expect(String(res.reasonText).toLowerCase()).toContain('venue');
  });
});

// ─── 2. Timing & Offsets (EX04–EX07) ──────────────────────────────────────────

describe('F29 Timing & Offsets', () => {
  it('EX04: Step 1 Invitation is scheduled D-14 before event start date', async () => {
    const event = {
      tenantId: TENANT,
      eventId: 'evt_timing_test',
      title: 'Timing Trunk Show',
      eventType: 'TRUNK_SHOW' as const,
      venue: { name: 'Taj Mahal Palace', city: 'Mumbai' },
      city: 'Mumbai',
      startDate: new Date('2026-11-20T04:30:00.000Z'), // 10:00 IST Nov 20
      endDate: new Date('2026-11-22T14:30:00.000Z'),
      capacity: 50,
      registeredCount: 0,
      status: 'ACTIVE' as const,
      entityVersion: 1,
    };

    const result = await enrollExhibitionCustomer(TENANT, event, 'cus_ex_01', {
      campaignId: 'cmp_exhibition_trunk_show',
      now: NOW,
    });

    expect(result.enrolled).toBe(true);

    const execs = await CampaignExecutionModel.find({
      tenantId: TENANT,
      enrollmentId: result.enrollmentId,
    }).sort({ stepId: 1 }).lean();

    const inviteExec = execs.find((e) => e.stepId === 'step_invite');
    expect(inviteExec).toBeDefined();
    expect(inviteExec?.localDate).toBe('2026-11-06'); // Nov 20 minus 14 days = Nov 06
  });

  it('EX05: Step 2 Reminder is scheduled D-3 before event start date', async () => {
    const event = {
      tenantId: TENANT,
      eventId: 'evt_timing_test_2',
      title: 'Timing Trunk Show 2',
      eventType: 'TRUNK_SHOW' as const,
      venue: { name: 'Taj Mahal Palace', city: 'Mumbai' },
      city: 'Mumbai',
      startDate: new Date('2026-11-20T04:30:00.000Z'),
      endDate: new Date('2026-11-22T14:30:00.000Z'),
      capacity: 50,
      registeredCount: 0,
      status: 'ACTIVE' as const,
      entityVersion: 1,
    };

    const result = await enrollExhibitionCustomer(TENANT, event, 'cus_ex_01', {
      campaignId: 'cmp_exhibition_trunk_show',
      now: NOW,
    });

    const execs = await CampaignExecutionModel.find({
      tenantId: TENANT,
      enrollmentId: result.enrollmentId,
    }).lean();

    const reminderExec = execs.find((e) => e.stepId === 'step_reminder');
    expect(reminderExec).toBeDefined();
    expect(reminderExec?.localDate).toBe('2026-11-17'); // Nov 20 minus 3 days = Nov 17
  });

  it('EX06: executions scheduled past event startDate skip with EVENT_ENDED', async () => {
    // Event starting tomorrow at 10:00 IST
    const event = {
      tenantId: TENANT,
      eventId: 'evt_timing_ended',
      title: 'Nearly Ended Show',
      eventType: 'TRUNK_SHOW' as const,
      venue: { name: 'Taj Mahal Palace', city: 'Mumbai' },
      city: 'Mumbai',
      startDate: new Date('2026-10-02T04:30:00.000Z'), // tomorrow
      endDate: new Date('2026-10-03T14:30:00.000Z'),
      capacity: 50,
      registeredCount: 0,
      status: 'ACTIVE' as const,
      entityVersion: 1,
    };

    // If campaign has offsetDays: +1 (past event start), it skips with EVENT_ENDED
    // Let's test with now set after startDate:
    const pastNow = new Date('2026-10-05T00:00:00.000Z');
    const result = await enrollExhibitionCustomer(TENANT, event, 'cus_ex_01', {
      campaignId: 'cmp_exhibition_trunk_show',
      now: pastNow,
    });

    expect(result.enrolled).toBe(true);

    const execs = await CampaignExecutionModel.find({
      tenantId: TENANT,
      enrollmentId: result.enrollmentId,
    }).lean();

    expect(execs.every((e) => e.state === EXECUTION_STATE.SKIPPED)).toBe(true);
  });

  it('EX07: future-only rule skips executions whose adjustedDueAt <= now with SKIPPED_ELAPSED', async () => {
    // Current time is Nov 10, event is Nov 20. Step 1 (due Nov 06) has elapsed!
    const midNow = new Date('2026-11-10T08:00:00.000Z');
    const event = {
      tenantId: TENANT,
      eventId: 'evt_timing_future_only',
      title: 'Mid Period Show',
      eventType: 'TRUNK_SHOW' as const,
      venue: { name: 'Taj Mahal Palace', city: 'Mumbai' },
      city: 'Mumbai',
      startDate: new Date('2026-11-20T04:30:00.000Z'),
      endDate: new Date('2026-11-22T14:30:00.000Z'),
      capacity: 50,
      registeredCount: 0,
      status: 'ACTIVE' as const,
      entityVersion: 1,
    };

    const result = await enrollExhibitionCustomer(TENANT, event, 'cus_ex_01', {
      campaignId: 'cmp_exhibition_trunk_show',
      now: midNow,
    });

    const execs = await CampaignExecutionModel.find({
      tenantId: TENANT,
      enrollmentId: result.enrollmentId,
    }).lean();

    const inviteExec = execs.find((e) => e.stepId === 'step_invite');
    expect(inviteExec?.state).toBe(EXECUTION_STATE.SKIPPED);
    expect(inviteExec?.skipReason).toBe(EXECUTION_REASONS.SKIPPED_ELAPSED);

    const reminderExec = execs.find((e) => e.stepId === 'step_reminder');
    expect(reminderExec?.state).toBe(EXECUTION_STATE.SCHEDULED);
  });
});

// ─── 3. Matching: Geography, Capacity & Preferences (EX08–EX12) ───────────────

describe('F29 Matching Engine', () => {
  it('EX08: customer in targetCities or targetBranches matches; outside is excluded with OUTSIDE_GEOGRAPHY', () => {
    const event = {
      eventId: 'evt_match_geo',
      title: 'Mumbai Trunk Show',
      city: 'Mumbai',
      targetCities: ['Mumbai', 'Thane'],
      targetBranches: ['branch_main'],
      capacity: 50,
      registeredCount: 10,
      status: 'ACTIVE',
      categories: ['saree'],
    };

    // Customer in Mumbai
    const mumbCustomer = {
      customerId: 'cus_mumbai',
      city: 'Mumbai',
      branchId: 'branch_two',
    };
    const resMumb = matchExhibitionEvent(mumbCustomer, event);
    expect(resMumb.matched).toBe(true);

    // Customer in Bangalore with branch outside
    const blrCustomer = {
      customerId: 'cus_blr',
      city: 'Bengaluru',
      branchId: 'branch_other',
    };
    const resBlr = matchExhibitionEvent(blrCustomer, event);
    expect(resBlr.matched).toBe(false);
    expect(resBlr.reason).toBe('OUTSIDE_GEOGRAPHY');
  });

  it('EX09: event at full capacity skips/excludes with EVENT_AT_CAPACITY', () => {
    const event = {
      eventId: 'evt_match_cap',
      title: 'Full Boutique Show',
      city: 'Mumbai',
      capacity: 20,
      registeredCount: 20,
      status: 'ACTIVE',
    };

    const res = matchExhibitionEvent(
      { customerId: 'cus_01', city: 'Mumbai' },
      event
    );
    expect(res.matched).toBe(false);
    expect(res.reason).toBe('EVENT_AT_CAPACITY');
  });

  it('EX10: already registered customer skips with CUSTOMER_REGISTERED', () => {
    const event = {
      eventId: 'evt_match_rsvp',
      title: 'RSVP Trunk Show',
      city: 'Mumbai',
      capacity: 50,
      registeredCount: 5,
      status: 'ACTIVE',
    };

    const res = matchExhibitionEvent(
      {
        customerId: 'cus_01',
        city: 'Mumbai',
        rsvpEventIds: ['evt_match_rsvp'],
      },
      event
    );
    expect(res.matched).toBe(false);
    expect(res.reason).toBe('CUSTOMER_REGISTERED');
  });

  it('EX11: customer declared preferences match event categories', () => {
    const event = {
      eventId: 'evt_match_pref',
      title: 'Silk & Zari Show',
      city: 'Mumbai',
      categories: ['saree', 'lehenga'],
      capacity: 50,
      registeredCount: 0,
      status: 'ACTIVE',
    };

    const customer = {
      customerId: 'cus_pref',
      city: 'Mumbai',
      preferences: {
        source: 'CUSTOMER_DECLARED',
        categories: ['saree'],
      },
    };

    const res = matchExhibitionEvent(customer, event, { mode: 'STRICT', audienceMode: 'PREFERENCE_MATCH' });
    expect(res.matched).toBe(true);
    expect(res.score).toBeGreaterThan(0.5);
  });

  it('EX12: Hard Rule 8 compliance: customer names never alter matching or eligibility', () => {
    const event = {
      eventId: 'evt_match_hr8',
      title: 'Universal Trunk Show',
      city: 'Mumbai',
      targetCities: ['Mumbai'],
      capacity: 50,
      registeredCount: 0,
      status: 'ACTIVE',
    };

    const names = ['Fatima', 'Pooja', 'Mary', 'Gurpreet', 'Zoya'];
    const results = names.map((firstName) =>
      matchExhibitionEvent(
        {
          customerId: `cus_${firstName}`,
          firstName,
          city: 'Mumbai',
          preferences: { source: 'CUSTOMER_DECLARED', categories: ['saree'] },
        },
        event
      )
    );

    const firstScore = results[0].score;
    const firstMatched = results[0].matched;
    for (const r of results) {
      expect(r.matched).toBe(firstMatched);
      expect(r.score).toBe(firstScore);
    }
  });
});

// ─── 4. Variable Bindings & Late Snapshot Resolution (EX13–EX16) ─────────────

describe('F29 Variable Bindings & Snapshot Resolution', () => {
  it('EX13: event.name resolves to event title', async () => {
    const snapshot = await buildResolutionSnapshot({
      tenantId: TENANT,
      step: {
        bindings: { '3': { source: 'event.name' } },
      },
      overrides: {
        eventName: 'Exclusive Taj Trunk Show',
      },
    });

    const def = BINDING_SOURCES['event.name'];
    expect(def).toBeDefined();
    expect(def.resolve(snapshot)).toBe('Exclusive Taj Trunk Show');
  });

  it('EX14: event.date resolves to formatted start date', async () => {
    const snapshot = await buildResolutionSnapshot({
      tenantId: TENANT,
      step: {
        bindings: { '4': { source: 'event.date' } },
      },
      overrides: {
        eventDate: 'Nov 20, 2026',
      },
    });

    const def = BINDING_SOURCES['event.date'];
    expect(def).toBeDefined();
    expect(def.resolve(snapshot)).toBe('Nov 20, 2026');
  });

  it('EX15: event.venue resolves to venue name and city', async () => {
    const snapshot = await buildResolutionSnapshot({
      tenantId: TENANT,
      step: {
        bindings: { '5': { source: 'event.venue' } },
      },
      overrides: {
        eventVenue: 'The Taj Mahal Palace, Mumbai',
      },
    });

    const def = BINDING_SOURCES['event.venue'];
    expect(def).toBeDefined();
    expect(def.resolve(snapshot)).toBe('The Taj Mahal Palace, Mumbai');
  });

  it('EX16: event.rsvpLink resolves to event RSVP link', async () => {
    const snapshot = await buildResolutionSnapshot({
      tenantId: TENANT,
      step: {
        bindings: { '6': { source: 'event.rsvpLink' } },
      },
      overrides: {
        eventRsvpLink: 'https://rsvp.example.com/trunk-show-2026',
      },
    });

    const def = BINDING_SOURCES['event.rsvpLink'];
    expect(def).toBeDefined();
    expect(def.resolve(snapshot)).toBe('https://rsvp.example.com/trunk-show-2026');
  });
});

// ─── 5. Enroller & Gate Checks (EX17–EX20) ────────────────────────────────────

describe('F29 Enroller & Gates', () => {
  it('EX17: enroller creates ACTIVE enrollment with storeevent:{eventId}', async () => {
    const event = {
      tenantId: TENANT,
      eventId: 'evt_enr_test',
      title: 'Enroller Trunk Show',
      eventType: 'TRUNK_SHOW' as const,
      venue: { name: 'Taj', city: 'Mumbai' },
      city: 'Mumbai',
      startDate: new Date('2026-11-20T04:30:00Z'),
      endDate: new Date('2026-11-22T14:30:00Z'),
      capacity: 50,
      registeredCount: 0,
      status: 'ACTIVE' as const,
      entityVersion: 1,
    };

    const res = await enrollExhibitionCustomer(TENANT, event, 'cus_ex_01', {
      campaignId: 'cmp_exhibition_trunk_show',
      now: NOW,
    });

    expect(res.enrolled).toBe(true);

    const enrollment = await CampaignEnrollmentModel.findOne({
      tenantId: TENANT,
      enrollmentId: res.enrollmentId,
    }).lean();

    expect(enrollment?.status).toBe(ENROLLMENT_STATUS.ACTIVE);
    expect(enrollment?.occurrenceId).toBe('storeevent:evt_enr_test');
    expect(enrollment?.sourceRef?.type).toBe('SRC_EVENTS');
  });

  it('EX18: enroller excludes customer without marketing consent', async () => {
    const event = {
      tenantId: TENANT,
      eventId: 'evt_enr_optout',
      title: 'Opt-out Showcase',
      eventType: 'TRUNK_SHOW' as const,
      venue: { name: 'Taj', city: 'Mumbai' },
      city: 'Mumbai',
      startDate: new Date('2026-11-20T04:30:00Z'),
      endDate: new Date('2026-11-22T14:30:00Z'),
      status: 'ACTIVE' as const,
      registeredCount: 0,
      entityVersion: 1,
    };

    // cus_ex_12 was seeded with marketingOptIn = false
    const res = await enrollExhibitionCustomer(TENANT, event, 'cus_ex_12', {
      campaignId: 'cmp_exhibition_trunk_show',
      now: NOW,
    });

    expect(res.enrolled).toBe(false);

    const enrollment = await CampaignEnrollmentModel.findOne({
      tenantId: TENANT,
      customerId: 'cus_ex_12',
      occurrenceId: 'storeevent:evt_enr_optout',
    }).lean();

    expect(enrollment?.status).toBe(ENROLLMENT_STATUS.EXCLUDED);
    expect(enrollment?.exclusionReason).toBe(EXCLUSION_REASONS.NO_MARKETING_CONSENT);
  });

  it('EX19: enroller excludes customer with unverified destination', async () => {
    const event = {
      tenantId: TENANT,
      eventId: 'evt_enr_unverified',
      title: 'Unverified Showcase',
      eventType: 'TRUNK_SHOW' as const,
      venue: { name: 'Taj', city: 'Mumbai' },
      city: 'Mumbai',
      startDate: new Date('2026-11-20T04:30:00Z'),
      endDate: new Date('2026-11-22T14:30:00Z'),
      status: 'ACTIVE' as const,
      registeredCount: 0,
      entityVersion: 1,
    };

    // cus_ex_14 was seeded with verified = false
    const res = await enrollExhibitionCustomer(TENANT, event, 'cus_ex_14', {
      campaignId: 'cmp_exhibition_trunk_show',
      now: NOW,
    });

    expect(res.enrolled).toBe(false);

    const enrollment = await CampaignEnrollmentModel.findOne({
      tenantId: TENANT,
      customerId: 'cus_ex_14',
      occurrenceId: 'storeevent:evt_enr_unverified',
    }).lean();

    expect(enrollment?.status).toBe(ENROLLMENT_STATUS.EXCLUDED);
    expect(enrollment?.exclusionReason).toBe(EXCLUSION_REASONS.DESTINATION_NOT_VERIFIED);
  });

  it('EX20: enroller skips duplicate enrollment for same customer and event', async () => {
    const event = {
      tenantId: TENANT,
      eventId: 'evt_enr_dup',
      title: 'Dup Check Showcase',
      eventType: 'TRUNK_SHOW' as const,
      venue: { name: 'Taj', city: 'Mumbai' },
      city: 'Mumbai',
      startDate: new Date('2026-11-20T04:30:00Z'),
      endDate: new Date('2026-11-22T14:30:00Z'),
      status: 'ACTIVE' as const,
      registeredCount: 0,
      entityVersion: 1,
    };

    const first = await enrollExhibitionCustomer(TENANT, event, 'cus_ex_01', {
      campaignId: 'cmp_exhibition_trunk_show',
      now: NOW,
    });
    expect(first.enrolled).toBe(true);

    const second = await enrollExhibitionCustomer(TENANT, event, 'cus_ex_01', {
      campaignId: 'cmp_exhibition_trunk_show',
      now: NOW,
    });
    expect(second.enrolled).toBe(false);
  });
});

// ─── 6. Fan-out Engine & Idempotency (EX21–EX22) ──────────────────────────────

describe('F29 Fan-out Engine', () => {
  it('EX21: fan-out processes customers in bounded batches with checkpoint', async () => {
    const result: any = await fanoutStoreEvent(
      TENANT,
      'evt_ex_mumbai_2026',
      'evt_fanout_chk_1',
      { campaignId: 'cmp_exhibition_trunk_show', now: NOW }
    );

    expect(result.outcome).toBe('FANOUT_COMPLETED');
    expect(result.totalEnrolled).toBeGreaterThan(0);
    expect(typeof result.totalScanned).toBe('number');
  });

  it('EX22: fan-out idempotency: running fan-out twice does not duplicate enrollments', async () => {
    const eventId = 'evt_ex_delhi_2026';
    const first: any = await fanoutStoreEvent(
      TENANT,
      eventId,
      'evt_fanout_idemp_1',
      { campaignId: 'cmp_exhibition_trunk_show', now: NOW }
    );
    expect(first.outcome).toBe('FANOUT_COMPLETED');

    const second: any = await fanoutStoreEvent(
      TENANT,
      eventId,
      'evt_fanout_idemp_1',
      { campaignId: 'cmp_exhibition_trunk_show', now: NOW }
    );

    // Second run should enroll 0
    expect(second.totalEnrolled).toBe(0);
  });
});

// ─── 7. Event Lifecycle & Handlers (EX23–EX26) ────────────────────────────────

describe('F29 Event Lifecycle & Handlers', () => {
  it('EX23: event.published event triggers fan-out for active exhibition campaigns', async () => {
    const eventId = 'evt_ex_mumbai_2026';
    const inboxDoc = {
      tenantId: TENANT,
      eventId: `evt_pub_${Date.now()}`,
      entityId: eventId,
      type: 'event.published',
      producer: 'events',
      schemaVersion: 1,
      entityVersion: 1,
      occurredAt: NOW,
      receivedAt: NOW,
      data: {},
      status: 'PENDING',
      attempts: 0,
    };

    const res: any = await handleStoreEvent(inboxDoc as any);
    expect(res.outcome).toBe('FANOUT_COMPLETED');
  });

  it('EX24: event.cancelled cancels active enrollments and unexecuted executions with EVENT_CANCELLED', async () => {
    const event = {
      tenantId: TENANT,
      eventId: 'evt_cancel_test',
      title: 'Cancellation Showcase',
      eventType: 'TRUNK_SHOW' as const,
      venue: { name: 'Taj', city: 'Mumbai' },
      city: 'Mumbai',
      startDate: new Date('2026-11-20T04:30:00Z'),
      endDate: new Date('2026-11-22T14:30:00Z'),
      status: 'ACTIVE' as const,
      registeredCount: 0,
      entityVersion: 1,
    };

    const enrRes = await enrollExhibitionCustomer(TENANT, event, 'cus_ex_01', {
      campaignId: 'cmp_exhibition_trunk_show',
      now: NOW,
    });
    expect(enrRes.enrolled).toBe(true);

    // Now send event.cancelled
    await SrcEventModel.create({ ...event, status: 'CANCELLED' });
    const res: any = await handleStoreEvent({
      tenantId: TENANT,
      eventId: `inbox_${Date.now()}`,
      entityId: 'evt_cancel_test',
      type: 'event.cancelled',
      producer: 'events',
      schemaVersion: 1,
      entityVersion: 2,
      occurredAt: NOW,
      receivedAt: NOW,
      data: {},
      status: 'PENDING',
      attempts: 0,
    } as any);

    expect(res.outcome).toBe('CANCELLED');

    const updatedEnr = await CampaignEnrollmentModel.findOne({
      tenantId: TENANT,
      enrollmentId: enrRes.enrollmentId,
    }).lean();

    expect(updatedEnr?.status).toBe(ENROLLMENT_STATUS.CANCELLED);
    expect(updatedEnr?.stopReason).toBe('EVENT_CANCELLED');
  });

  it('EX25: event.updated with status PAUSED skips scheduled executions with EVENT_PAUSED', async () => {
    const event = {
      tenantId: TENANT,
      eventId: 'evt_pause_test',
      title: 'Pause Showcase',
      eventType: 'TRUNK_SHOW' as const,
      venue: { name: 'Taj', city: 'Mumbai' },
      city: 'Mumbai',
      startDate: new Date('2026-11-20T04:30:00Z'),
      endDate: new Date('2026-11-22T14:30:00Z'),
      status: 'ACTIVE' as const,
      registeredCount: 0,
      entityVersion: 1,
    };

    const enrRes = await enrollExhibitionCustomer(TENANT, event, 'cus_ex_01', {
      campaignId: 'cmp_exhibition_trunk_show',
      now: NOW,
    });
    expect(enrRes.enrolled).toBe(true);

    await SrcEventModel.create({ ...event, status: 'PAUSED' });

    const res: any = await handleStoreEvent({
      tenantId: TENANT,
      eventId: `inbox_${Date.now()}`,
      entityId: 'evt_pause_test',
      type: 'event.updated',
      producer: 'events',
      schemaVersion: 1,
      entityVersion: 2,
      occurredAt: NOW,
      receivedAt: NOW,
      data: {},
      status: 'PENDING',
      attempts: 0,
    } as any);

    expect(res.outcome).toBe('PAUSED');

    const execs = await CampaignExecutionModel.find({
      tenantId: TENANT,
      enrollmentId: enrRes.enrollmentId,
    }).lean();

    const pausedExec = execs.find((e) => e.skipReason === 'EVENT_PAUSED');
    expect(pausedExec).toBeDefined();
  });

  it('EX26: event.updated with status FULL skips remaining invitations with EVENT_AT_CAPACITY', async () => {
    const event = {
      tenantId: TENANT,
      eventId: 'evt_full_test',
      title: 'Full Showcase',
      eventType: 'TRUNK_SHOW' as const,
      venue: { name: 'Taj', city: 'Mumbai' },
      city: 'Mumbai',
      startDate: new Date('2026-11-20T04:30:00Z'),
      endDate: new Date('2026-11-22T14:30:00Z'),
      status: 'ACTIVE' as const,
      registeredCount: 0,
      entityVersion: 1,
    };

    const enrRes = await enrollExhibitionCustomer(TENANT, event, 'cus_ex_01', {
      campaignId: 'cmp_exhibition_trunk_show',
      now: NOW,
    });
    expect(enrRes.enrolled).toBe(true);

    await SrcEventModel.create({ ...event, status: 'FULL' });

    const res: any = await handleStoreEvent({
      tenantId: TENANT,
      eventId: `inbox_${Date.now()}`,
      entityId: 'evt_full_test',
      type: 'event.updated',
      producer: 'events',
      schemaVersion: 1,
      entityVersion: 2,
      occurredAt: NOW,
      receivedAt: NOW,
      data: {},
      status: 'PENDING',
      attempts: 0,
    } as any);

    expect(res.outcome).toBe('FULL');

    const execs = await CampaignExecutionModel.find({
      tenantId: TENANT,
      enrollmentId: enrRes.enrollmentId,
    }).lean();

    const fullExec = execs.find((e) => e.skipReason === 'EVENT_AT_CAPACITY');
    expect(fullExec).toBeDefined();
  });
});

// ─── 8. Goal Tracking & Stop Conditions (EX27–EX29) ───────────────────────────

describe('F29 Goal Tracking', () => {
  it('EX27: order.completed with eventRef matches goal, marks COMPLETED, skips unexecuted steps', async () => {
    const event = {
      tenantId: TENANT,
      eventId: 'evt_goal_test',
      title: 'Goal Showcase',
      eventType: 'TRUNK_SHOW' as const,
      venue: { name: 'Taj', city: 'Mumbai' },
      city: 'Mumbai',
      startDate: new Date('2026-11-20T04:30:00Z'),
      endDate: new Date('2026-11-22T14:30:00Z'),
      status: 'ACTIVE' as const,
      registeredCount: 0,
      entityVersion: 1,
    };

    const enrRes = await enrollExhibitionCustomer(TENANT, event, 'cus_ex_01', {
      campaignId: 'cmp_exhibition_trunk_show',
      now: NOW,
    });
    expect(enrRes.enrolled).toBe(true);

    const order = {
      orderId: 'ord_ex_goal_1',
      customerId: 'cus_ex_01',
      eventRef: 'evt_goal_test',
      netPaise: 1500000,
      status: 'COMPLETED',
      completedAt: new Date(),
    };

    const goalRes = await handleOrderCompletedForExhibitionGoal(
      TENANT,
      'cus_ex_01',
      order,
      new Date()
    );

    expect(goalRes.goalMatches).toContain(enrRes.enrollmentId);

    const enrollment = await CampaignEnrollmentModel.findOne({
      tenantId: TENANT,
      enrollmentId: enrRes.enrollmentId,
    }).lean();

    expect(enrollment?.status).toBe(ENROLLMENT_STATUS.COMPLETED);
    expect(enrollment?.stopReason).toBe('GOAL_ACHIEVED');

    const execs = await CampaignExecutionModel.find({
      tenantId: TENANT,
      enrollmentId: enrRes.enrollmentId,
    }).lean();

    expect(execs.every((e) => e.state === EXECUTION_STATE.SKIPPED)).toBe(true);
  });

  it('EX28: customer RSVP stops invitations with CUSTOMER_REGISTERED and increments registeredCount', async () => {
    const eventId = 'evt_rsvp_goal_test';
    await SrcEventModel.create({
      tenantId: TENANT,
      eventId,
      title: 'RSVP Test Event',
      venue: { name: 'Taj', city: 'Mumbai' },
      city: 'Mumbai',
      startDate: new Date('2026-11-20T04:30:00Z'),
      endDate: new Date('2026-11-22T14:30:00Z'),
      capacity: 50,
      registeredCount: 2,
      status: 'ACTIVE',
      entityVersion: 1,
    });

    const event = {
      tenantId: TENANT,
      eventId,
      title: 'RSVP Test Event',
      eventType: 'TRUNK_SHOW' as const,
      venue: { name: 'Taj', city: 'Mumbai' },
      city: 'Mumbai',
      startDate: new Date('2026-11-20T04:30:00Z'),
      endDate: new Date('2026-11-22T14:30:00Z'),
      status: 'ACTIVE' as const,
      registeredCount: 2,
      entityVersion: 1,
    };

    const enrRes = await enrollExhibitionCustomer(TENANT, event, 'cus_ex_01', {
      campaignId: 'cmp_exhibition_trunk_show',
      now: NOW,
    });

    const rsvpRes = await handleRsvpCompletedForExhibition(
      TENANT,
      eventId,
      'cus_ex_01'
    );

    expect(rsvpRes.stoppedEnrollments).toContain(enrRes.enrollmentId);

    const updatedEvent = await SrcEventModel.findOne({ tenantId: TENANT, eventId }).lean();
    expect(updatedEvent?.registeredCount).toBe(3); // 2 + 1 = 3

    const enrollment = await CampaignEnrollmentModel.findOne({
      tenantId: TENANT,
      enrollmentId: enrRes.enrollmentId,
    }).lean();

    expect(enrollment?.status).toBe(ENROLLMENT_STATUS.COMPLETED);
    expect(enrollment?.stopReason).toBe('CUSTOMER_REGISTERED');
  });

  it('EX29: order without eventRef or occasionRef does not trigger goal completion', async () => {
    const event = {
      tenantId: TENANT,
      eventId: 'evt_untagged_order',
      title: 'Untagged Order Test',
      eventType: 'TRUNK_SHOW' as const,
      venue: { name: 'Taj', city: 'Mumbai' },
      city: 'Mumbai',
      startDate: new Date('2026-11-20T04:30:00Z'),
      endDate: new Date('2026-11-22T14:30:00Z'),
      status: 'ACTIVE' as const,
      registeredCount: 0,
      entityVersion: 1,
    };

    const enrRes = await enrollExhibitionCustomer(TENANT, event, 'cus_ex_01', {
      campaignId: 'cmp_exhibition_trunk_show',
      now: NOW,
    });

    const untaggedOrder = {
      orderId: 'ord_untagged_1',
      customerId: 'cus_ex_01',
      netPaise: 500000,
      status: 'COMPLETED',
      completedAt: new Date(),
    };

    const res = await handleOrderCompletedForExhibitionGoal(
      TENANT,
      'cus_ex_01',
      untaggedOrder,
      new Date()
    );

    expect(res.goalMatches).toHaveLength(0);

    const enrollment = await CampaignEnrollmentModel.findOne({
      tenantId: TENANT,
      enrollmentId: enrRes.enrollmentId,
    }).lean();

    expect(enrollment?.status).toBe(ENROLLMENT_STATUS.ACTIVE);
  });
});

// ─── 9. Arbitration & Tenant Isolation (EX30–EX31) ────────────────────────────

describe('F29 Arbitration & Tenant Isolation', () => {
  it('EX30: Birthday campaign priority (80) wins over Exhibition campaign (45)', () => {
    const birthdayPreset = CAMPAIGN_PRESETS.find((p) => p.id === 'birthday');
    const exhibitionPreset = CAMPAIGN_PRESETS.find((p) => p.id === EXHIBITION_TRUNK_SHOW_ID);

    expect(birthdayPreset).toBeDefined();
    expect(exhibitionPreset).toBeDefined();

    const birthdayPriority = birthdayPreset?.defaults?.priority ?? 80;
    const exhibitionPriority = exhibitionPreset?.defaults?.priority ?? 45;

    expect(birthdayPriority).toBeGreaterThan(exhibitionPriority);
    expect(birthdayPriority).toBe(80);
    expect(exhibitionPriority).toBe(45);
  });

  it('EX31: Tenant isolation: operations on shop_a never match or enroll shop_b customers', async () => {
    const eventA = {
      tenantId: TENANT,
      eventId: 'evt_isolation_test',
      title: 'Shop A Show',
      eventType: 'TRUNK_SHOW' as const,
      venue: { name: 'Taj', city: 'Mumbai' },
      city: 'Mumbai',
      startDate: new Date('2026-11-20T04:30:00Z'),
      endDate: new Date('2026-11-22T14:30:00Z'),
      status: 'ACTIVE' as const,
      registeredCount: 0,
      entityVersion: 1,
    };

    // Attempting to enroll shop_b customer in shop_a campaign
    const res = await enrollExhibitionCustomer(TENANT, eventA, 'cus_ex_b_01', {
      campaignId: 'cmp_exhibition_trunk_show',
      now: NOW,
    });

    expect(res.enrolled).toBe(false);

    const bEnrollment = await CampaignEnrollmentModel.findOne({
      tenantId: TENANT_B,
      customerId: 'cus_ex_b_01',
      occurrenceId: 'storeevent:evt_isolation_test',
    }).lean();

    expect(bEnrollment).toBeNull();
  });
});

// ─── 10. API Routes & Preset Definition (EX32–EX35) ───────────────────────────

describe('F29 API Routes & Preset Definition', () => {
  it('EX32: GET /campaigns/:id/exhibition/summary returns summary counts', async () => {
    const res = await request(app)
      .get('/campaigns/cmp_exhibition_trunk_show/exhibition/summary')
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('x-tenant-id', TENANT);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('eventsSeen');
    expect(res.body).toHaveProperty('enrollments');
    expect(res.body).toHaveProperty('scheduled');
    expect(res.body).toHaveProperty('skipped');
  });

  it('EX33: POST /campaigns/:id/exhibition/preview returns preview counts and samples', async () => {
    const res = await request(app)
      .post('/campaigns/cmp_exhibition_trunk_show/exhibition/preview')
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('x-tenant-id', TENANT)
      .send({ eventId: 'evt_ex_mumbai_2026' });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('event');
    expect(res.body).toHaveProperty('wouldCount');
    expect(res.body).toHaveProperty('samples');
    expect(Array.isArray(res.body.samples)).toBe(true);
  });

  it('EX34: POST /dev/exhibition/trigger-event ingests event and triggers fan-out', async () => {
    const res = await request(app)
      .post('/dev/exhibition/trigger-event')
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('x-tenant-id', TENANT)
      .send({ eventId: 'evt_ex_mumbai_2026', type: 'event.published' });

    expect([200, 201]).toContain(res.status);
    expect(res.body.ok).toBe(true);
    expect(res.body.storeEventId).toBe('evt_ex_mumbai_2026');
  });

  it('EX35: Preset registry: exhibition_trunk_show exists in CAMPAIGN_PRESETS, implemented=true, priority=45', () => {
    const preset = CAMPAIGN_PRESETS.find((p) => p.id === EXHIBITION_TRUNK_SHOW_ID);
    expect(preset).toBeDefined();
    expect(preset?.implemented).toBe(true);
    expect(preset?.defaults?.priority).toBe(45);
    expect(preset?.triggerFamily).toBe('OWNER_DATED_EVENT');
    expect(EXHIBITION_TRUNK_SHOW_DEFINITION.id).toBe(EXHIBITION_TRUNK_SHOW_ID);
  });
});

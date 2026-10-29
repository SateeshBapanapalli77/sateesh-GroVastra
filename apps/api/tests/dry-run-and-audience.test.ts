import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { DateTime } from 'luxon';
import { app } from '../src/app';
import { connectToDatabase, disconnectDatabase } from '../src/db/connection';
import { seedDatabase } from '../src/db/seed';
import { clock } from '../src/services/clock';
import {
  nextOccurrence,
  getOccurrenceId,
  resolveStepDueAt,
  computeStepExpiresAt,
  fitIntoAllowedHours,
  evaluateStepFutureOnly,
} from '../src/services/datetime';
import {
  validateAudience,
  evaluateCustomerForCampaign,
  compileSafeMongoQuery,
} from '../src/services/audience';
import { computeDraftFingerprint } from '../src/services/dry-run.service';
import { CampaignDryRunModel } from '../src/db/models/campaign-dry-run.model';
import { CampaignVersionModel } from '../src/db/models/campaign-version.model';
import { CampaignModel } from '../src/db/models/campaign.model';
import {
  EXCLUSION_REASONS,
  SourceCustomer,
  CampaignAudience,
} from '@grovastra/shared';

describe('GroVastra Campaign Dry Run and Audience Engine (Feature 6, Spec p10-12, p17, p29, p33)', () => {
  let shopAOwnerToken: string;
  let shopAAdminToken: string;
  let shopAStaffToken: string;
  let shopBOwnerToken: string;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.ALLOW_TEST_CATEGORY_MISMATCH = 'true';
    await connectToDatabase();
    await seedDatabase('base');

    const loginAOwner = await request(app)
      .post('/auth/login')
      .send({ email: 'owner@shop-a.com', password: 'OwnerSecret#2026!' });
    shopAOwnerToken = loginAOwner.body.token;

    const loginAAdmin = await request(app)
      .post('/auth/login')
      .send({ email: 'admin@shop-a.com', password: 'AdminSecret#2026!' });
    shopAAdminToken = loginAAdmin.body.token;

    const loginAStaff = await request(app)
      .post('/auth/login')
      .send({ email: 'staff@shop-a.com', password: 'StaffSecret#2026!' });
    shopAStaffToken = loginAStaff.body.token;

    const loginBOwner = await request(app)
      .post('/auth/login')
      .send({ email: 'owner@shop-b.com', password: 'ShopBSecret#2026!' });
    shopBOwnerToken = loginBOwner.body.token;
  });

  afterAll(async () => {
    clock.resetOffset();
    await disconnectDatabase();
  });

  // ==========================================================================
  // SECTION 1: Pure Date-Time Engine (Spec p11-12, p17, p29, A07, A08, B07, B08)
  // ==========================================================================
  describe('Pure Date-Time Engine', () => {
    describe('nextOccurrence & getOccurrenceId (Spec p11-12, A07, A08)', () => {
      it('A07: evaluates January birthday in December using upcoming year', () => {
        const evalTime = new Date('2026-12-15T10:00:00Z');
        const res = nextOccurrence({ month: 1, day: 5 }, evalTime, 'FEB_28', 'Asia/Kolkata');

        expect(res.year).toBe(2027);
        expect(res.localDate).toBe('2027-01-05');
        expect(res.policyApplied).toBe('EXACT');

        const occId = getOccurrenceId('birthday', res.year);
        expect(occId).toBe('birthday:2027');
      });

      it('evaluates upcoming birthday within current calendar year when date is in future', () => {
        const evalTime = new Date('2026-10-15T10:00:00Z');
        const res = nextOccurrence({ month: 12, day: 25 }, evalTime, 'FEB_28', 'Asia/Kolkata');

        expect(res.year).toBe(2026);
        expect(res.localDate).toBe('2026-12-25');
      });

      it('advances to next year when birthday date has already passed today', () => {
        const evalTime = new Date('2026-10-20T10:00:00Z');
        const res = nextOccurrence({ month: 10, day: 10 }, evalTime, 'FEB_28', 'Asia/Kolkata');

        expect(res.year).toBe(2027);
        expect(res.localDate).toBe('2027-10-10');
      });

      it('A08: Feb 29 in non-leap year (2027) with FEB_28 policy resolves to Feb 28 once', () => {
        const evalTime = new Date('2026-10-15T10:00:00Z');
        const res = nextOccurrence({ month: 2, day: 29 }, evalTime, 'FEB_28', 'Asia/Kolkata');

        expect(res.year).toBe(2027);
        expect(res.localDate).toBe('2027-02-28');
        expect(res.isLeapYear).toBe(false);
        expect(res.policyApplied).toBe('FEB_28');
      });

      it('A08: Feb 29 in non-leap year (2027) with MAR_01 policy resolves to March 1 once', () => {
        const evalTime = new Date('2026-10-15T10:00:00Z');
        const res = nextOccurrence({ month: 2, day: 29 }, evalTime, 'MAR_01', 'Asia/Kolkata');

        expect(res.year).toBe(2027);
        expect(res.localDate).toBe('2027-03-01');
        expect(res.isLeapYear).toBe(false);
        expect(res.policyApplied).toBe('MAR_01');
      });

      it('A08: Feb 29 with LEAP_ONLY policy skips non-leap years to next leap year (2028)', () => {
        const evalTime = new Date('2026-10-15T10:00:00Z');
        const res = nextOccurrence({ month: 2, day: 29 }, evalTime, 'LEAP_ONLY', 'Asia/Kolkata');

        expect(res.year).toBe(2028);
        expect(res.localDate).toBe('2028-02-29');
        expect(res.isLeapYear).toBe(true);
        expect(res.policyApplied).toBe('LEAP_ONLY');
      });

      it('formats anniversary occurrenceId with eventId and year (Spec p12)', () => {
        const occId = getOccurrenceId('anniversary', 2027, 'evt_silver_jubilee');
        expect(occId).toBe('anniversary:evt_silver_jubilee:2027');
      });
    });

    describe('resolveStepDueAt & DST Handling (Spec p17, B07)', () => {
      it('converts Asia/Kolkata local date + offset + 10:00 IST to exact 04:30 UTC', () => {
        const res = resolveStepDueAt({
          occasionLocalDate: '2027-01-05',
          offsetDays: -14,
          localTime: '10:00',
          timezone: 'Asia/Kolkata',
        });

        expect(res.localDate).toBe('2026-12-22');
        expect(res.localTime).toBe('10:00');
        expect(res.dueAt.toISOString()).toBe('2026-12-22T04:30:00.000Z');
      });

      it('B07 DST Gap: America/New_York spring forward nonexistent 02:30 shifts to next valid instant (03:00 EDT)', () => {
        // In 2026, US clocks spring forward on March 8: 02:00 -> 03:00
        const res = resolveStepDueAt({
          occasionLocalDate: '2026-03-08',
          offsetDays: 0,
          localTime: '02:30',
          timezone: 'America/New_York',
        });

        expect(res.localTime).toBe('03:00');
        // 03:00 EDT (UTC-4) = 07:00 UTC
        expect(res.dueAt.toISOString()).toBe('2026-03-08T07:00:00.000Z');
      });

      it('B07 DST Gap: Europe/London spring forward nonexistent 01:30 shifts to next valid instant (02:00 BST)', () => {
        // In 2026, UK clocks spring forward on March 29: 01:00 -> 02:00
        const res = resolveStepDueAt({
          occasionLocalDate: '2026-03-29',
          offsetDays: 0,
          localTime: '01:30',
          timezone: 'Europe/London',
        });

        expect(res.localTime).toBe('02:00');
        // 02:00 BST (UTC+1) = 01:00 UTC
        expect(res.dueAt.toISOString()).toBe('2026-03-29T01:00:00.000Z');
      });

      it('B07 DST Fold: America/New_York fall back repeated 01:30 chooses first occurrence (EDT, earlier UTC)', () => {
        // In 2026, US clocks fall back on Nov 1: 01:30 occurs first at EDT (-04:00) then EST (-05:00)
        const res = resolveStepDueAt({
          occasionLocalDate: '2026-11-01',
          offsetDays: 0,
          localTime: '01:30',
          timezone: 'America/New_York',
        });

        // First occurrence is 01:30 EDT = 05:30 UTC (the second occurrence would be 06:30 UTC)
        expect(res.dueAt.toISOString()).toBe('2026-11-01T05:30:00.000Z');
      });
    });

    describe('computeStepExpiresAt & fitIntoAllowedHours (Spec p17, p29, B08)', () => {
      it('calculates expiresAt as earliest of lateness cutoff, campaign end, and latestUsefulAt', () => {
        const dueAt = new Date('2026-12-22T04:30:00.000Z');
        const latenessMinutes = 120; // 06:30 UTC

        // Case 1: only lateness
        const exp1 = computeStepExpiresAt({ dueAt, maxLatenessMinutes: latenessMinutes });
        expect(exp1.toISOString()).toBe('2026-12-22T06:30:00.000Z');

        // Case 2: campaign ends earlier (05:00 UTC)
        const campaignEnd = new Date('2026-12-22T05:00:00.000Z');
        const exp2 = computeStepExpiresAt({
          dueAt,
          maxLatenessMinutes: latenessMinutes,
          campaignEndAt: campaignEnd,
        });
        expect(exp2.toISOString()).toBe('2026-12-22T05:00:00.000Z');

        // Case 3: latestUsefulAt is earliest (04:45 UTC)
        const latestUseful = new Date('2026-12-22T04:45:00.000Z');
        const exp3 = computeStepExpiresAt({
          dueAt,
          maxLatenessMinutes: latenessMinutes,
          latestUsefulAt: latestUseful,
        });
        expect(exp3.toISOString()).toBe('2026-12-22T04:45:00.000Z');
      });

      it('leaves due instant untouched when already within allowed sending hours', () => {
        const dueAt = new Date('2026-12-22T04:30:00.000Z'); // 10:00 IST
        const expiresAt = new Date('2026-12-22T06:30:00.000Z');
        const settings = {
          timezone: 'Asia/Kolkata',
          allowedSendingHours: { start: '10:00', end: '19:00' },
          blackoutDates: [],
          holidays: [],
        };

        const res = fitIntoAllowedHours(dueAt, settings, expiresAt);
        expect(res.status).toBe('OK');
        expect(res.adjusted).toBe(false);
        expect(res.dueAt.toISOString()).toBe(dueAt.toISOString());
      });

      it('adjusts send forward to 10:00 start if planned before allowed window', () => {
        const dueAt = new Date('2026-12-22T02:30:00.000Z'); // 08:00 IST
        const expiresAt = new Date('2026-12-22T06:30:00.000Z'); // 12:00 IST
        const settings = {
          timezone: 'Asia/Kolkata',
          allowedSendingHours: { start: '10:00', end: '19:00' },
        };

        const res = fitIntoAllowedHours(dueAt, settings, expiresAt);
        expect(res.status).toBe('OK');
        expect(res.adjusted).toBe(true);
        expect(res.dueAt.toISOString()).toBe('2026-12-22T04:30:00.000Z'); // 10:00 IST
      });

      it('B08: skips with reason when blackout pushes due instant past expiresAt', () => {
        const dueAt = new Date('2026-12-25T04:30:00.000Z'); // Christmas 10:00 IST
        const expiresAt = new Date('2026-12-25T06:30:00.000Z'); // Expires same day at 12:00 IST
        const settings = {
          timezone: 'Asia/Kolkata',
          allowedSendingHours: { start: '10:00', end: '19:00' },
          blackoutDates: ['2026-12-25'], // Christmas is blacked out
        };

        const res = fitIntoAllowedHours(dueAt, settings, expiresAt);
        expect(res.status).toBe('SKIP');
        expect(res.reason).toBe('SKIPPED_BLACKOUT_EXPIRED');
      });

      it('evaluates FUTURE_ONLY policy correctly', () => {
        const now = new Date('2026-12-15T10:00:00Z');
        const elapsed = new Date('2026-12-10T10:00:00Z');
        const future = new Date('2026-12-22T10:00:00Z');

        expect(evaluateStepFutureOnly(elapsed, now)).toBe('SKIPPED_ELAPSED');
        expect(evaluateStepFutureOnly(future, now)).toBe('SCHEDULED');
      });
    });
  });

  // ==========================================================================
  // SECTION 2: Audience Rules Engine (Spec p10)
  // ==========================================================================
  describe('Audience Rules Engine', () => {
    it('validates ALL_ELIGIBLE mode cleanly', () => {
      const res = validateAudience({ mode: 'ALL_ELIGIBLE' });
      expect(res.valid).toBe(true);
      expect(res.errors.length).toBe(0);
    });

    it('rejects unknown fields with structured validation error', () => {
      const res = validateAudience({
        mode: 'CUSTOM_RULES',
        rules: {
          all: [{ field: 'unknownField' as any, op: 'eq', value: 'foo' }],
        },
      });
      expect(res.valid).toBe(false);
      expect(res.errors[0].fieldPath).toBe('audience.rules.all[0].field');
      expect(res.errors[0].message).toContain('Unknown audience field');
    });

    it('rejects unknown operators with structured validation error', () => {
      const res = validateAudience({
        mode: 'CUSTOM_RULES',
        rules: {
          all: [{ field: 'preferences.weave', op: 'matchesRegex' as any, value: 'silk' }],
        },
      });
      expect(res.valid).toBe(false);
      expect(res.errors[0].fieldPath).toBe('audience.rules.all[0].op');
      expect(res.errors[0].message).toContain('Unknown audience operator');
    });

    it('rejects entirely empty audience rules in CUSTOM_RULES mode (Spec p10)', () => {
      const res = validateAudience({
        mode: 'CUSTOM_RULES',
        rules: { all: [], any: [], none: [] },
      });
      expect(res.valid).toBe(false);
      expect(res.errors[0].message).toContain('entirely empty audience is invalid');
    });

    it('evaluates all/any/none semantics per Spec p10 and produces match explanation', () => {
      const customer: SourceCustomer = {
        tenantId: 'shop_a',
        customerId: 'cus_test',
        firstName: 'Lakshmi',
        destination: {
          encryptedPhone: 'enc',
          destinationHash: 'hash',
          masked: '+91 91000 ••••1',
          verified: true,
          version: 1,
        },
        birthday: { month: 1, day: 5 },
        consent: { marketingOptIn: true, channelSuppressed: false },
        preferences: { weave: 'silk', budgetMaxPaise: 600000 },
        tags: ['occasionwear', 'vip'],
        status: 'ACTIVE',
        branchId: 'branch_main',
        deletedAt: null,
        version: 1,
        language: 'en',
      };

      const audience: CampaignAudience = {
        mode: 'CUSTOM_RULES',
        rules: {
          all: [
            { field: 'customer.status', op: 'eq', value: 'ACTIVE' },
            { field: 'preferences.weave', op: 'in', value: ['silk'] },
          ],
          any: [
            { field: 'preferences.budgetMaxPaise', op: 'gte', value: 600000 },
            { field: 'tags', op: 'contains', value: 'occasionwear' },
          ],
          none: [{ field: 'serviceIssueOpen', op: 'eq', value: true }],
        },
      };

      const res = evaluateCustomerForCampaign({
        customer,
        campaign: {
          trigger: { type: 'ANNUAL_DATE', field: 'customer.birthday', leapDayPolicy: 'FEB_28' },
          enabledBranches: ['branch_main'],
          audience,
        },
        daysUntilOccasion: 14,
      });

      expect(res.eligible).toBe(true);
      expect(res.explanation).toContain('birthday in 14 days');
      expect(res.explanation).toContain('opted in');
      expect(res.explanation).toContain('silk preference');
    });

    it('missing field fails ordinary comparisons (Spec p10)', () => {
      const customerWithoutWeave: SourceCustomer = {
        tenantId: 'shop_a',
        customerId: 'cus_no_weave',
        firstName: 'NoWeave',
        destination: {
          encryptedPhone: 'enc',
          destinationHash: 'hash',
          masked: '+91 91000 ••••1',
          verified: true,
          version: 1,
        },
        birthday: { month: 1, day: 5 },
        consent: { marketingOptIn: true, channelSuppressed: false },
        preferences: {}, // Missing weave
        tags: [],
        status: 'ACTIVE',
        branchId: 'branch_main',
        deletedAt: null,
        version: 1,
        language: 'en',
      };

      const audience: CampaignAudience = {
        mode: 'CUSTOM_RULES',
        rules: {
          all: [{ field: 'preferences.weave', op: 'eq', value: 'silk' }],
        },
      };

      const res = evaluateCustomerForCampaign({
        customer: customerWithoutWeave,
        campaign: {
          trigger: { type: 'ANNUAL_DATE', field: 'customer.birthday', leapDayPolicy: 'FEB_28' },
          enabledBranches: ['branch_main'],
          audience,
        },
      });

      expect(res.eligible).toBe(false);
      expect(res.primaryReason).toBe(EXCLUSION_REASONS.EXCLUDED_AUDIENCE_FILTER);
    });

    it('compiles safe MongoDB query strictly scoped to tenant and branch (Hard Rule 1, Spec p10)', () => {
      const query = compileSafeMongoQuery({
        tenantId: 'shop_a',
        branchIds: ['branch_main'],
        audience: {
          mode: 'CUSTOM_RULES',
          rules: {
            all: [
              { field: 'customer.status', op: 'eq', value: 'ACTIVE' },
              { field: 'preferences.weave', op: 'in', value: ['silk', 'linen'] },
            ],
          },
        },
      });

      expect(query.tenantId).toBe('shop_a');
      expect(query.deletedAt).toBe(null);
      expect(query.branchId).toEqual({ $in: ['branch_main'] });
      expect(query['preferences.weave']).toBeDefined();
    });
  });

  // ==========================================================================
  // SECTION 3: Campaign Dry Run API & Walkthrough (Spec p8, p26, p33, C01, C05)
  // ==========================================================================
  describe('Campaign Dry Run (POST /campaigns/:id/dry-runs)', () => {
    let campaignId: string;

    beforeAll(async () => {
      // Create a birthday draft campaign for testing
      const createRes = await request(app)
        .post('/campaigns')
        .set('Authorization', `Bearer ${shopAOwnerToken}`)
        .set('Idempotency-Key', 'dry-run-test-campaign-init')
        .send({
          presetId: 'birthday',
          name: 'Birthday Dry Run Test',
          enabledBranches: ['branch_main', 'branch_two'],
        });

      campaignId = createRes.body.campaign.campaignId;

      // Update draft with template reference
      await request(app)
        .patch(`/campaigns/${campaignId}/draft`)
        .set('Authorization', `Bearer ${shopAOwnerToken}`)
        .set('Idempotency-Key', 'dry-run-test-patch-templates')
        .send({
          expectedVersion: 1,
          steps: [
            {
              stepId: 'invitation',
              stepName: 'Occasion Invitation',
              offsetDays: -14,
              localTime: '10:00',
              prerequisite: 'NONE',
              templateRef: {
                id: 'tpl_birthday_invite',
                revision: 1,
                language: 'en',
              },
              bindings: {
                name: 'customer.firstName',
                shop: 'shop.displayName',
              },
              stopOnReply: true,
              stopOnGoal: true,
              maxLatenessMinutes: 120,
            },
            {
              stepId: 'followup',
              stepName: 'Friendly Reminder',
              offsetDays: -7,
              localTime: '10:00',
              prerequisite: 'PREVIOUS_ACCEPTED',
              templateRef: {
                id: 'tpl_birthday_followup',
                revision: 1,
                language: 'en',
              },
              bindings: {
                name: 'customer.firstName',
              },
              stopOnReply: true,
              stopOnGoal: true,
              maxLatenessMinutes: 120,
            },
            {
              stepId: 'greeting',
              stepName: 'Birthday Greeting',
              offsetDays: 0,
              localTime: '10:00',
              prerequisite: 'NONE',
              templateRef: {
                id: 'tpl_hello_world', // Category UTILITY permitted in dev/test with ALLOW_TEST_CATEGORY_MISMATCH
                revision: 1,
                language: 'en_US',
              },
              bindings: {},
              stopOnReply: false,
              stopOnGoal: true,
              maxLatenessMinutes: 120,
            },
          ],
        });
    });

    it('C01: dry run produces zero live message requests and zero live execution records in DB', async () => {
      const res = await request(app)
        .post(`/campaigns/${campaignId}/dry-runs`)
        .set('Authorization', `Bearer ${shopAOwnerToken}`);

      expect(res.status).toBe(201);
      expect(res.body.dryRunId).toBeDefined();
      expect(res.body.counts.scanned).toBeGreaterThan(0);
      expect(res.body.counts.eligible).toBeGreaterThan(0);

      // Verify ZERO writes to enrollments or executions collection for this campaign
      const enrCollection = CampaignDryRunModel.db.collection('campaignEnrollments');
      const exeCollection = CampaignDryRunModel.db.collection('campaignExecutions');
      const enrCount = await enrCollection.countDocuments({ campaignId });
      const exeCount = await exeCollection.countDocuments({ campaignId });

      expect(enrCount).toBe(0);
      expect(exeCount).toBe(0);
    });

    it('Lakshmi Worked Example (Spec p33): on 15 Dec 2026, invitation due 22 Dec at 10:00 IST = 04:30 UTC', async () => {
      // Set clock to 15 Dec 2026 10:00 UTC
      const lakshmiEvalDate = new Date('2026-12-15T10:00:00Z');
      const currentMs = Date.now();
      const targetMs = lakshmiEvalDate.getTime();
      clock.setOffsetMs(targetMs - currentMs);

      const res = await request(app)
        .post(`/campaigns/${campaignId}/dry-runs`)
        .set('Authorization', `Bearer ${shopAOwnerToken}`);

      expect(res.status).toBe(201);

      // Find Lakshmi in samplePlans
      const lakshmiPlan = res.body.samplePlans.find(
        (p: any) => p.customerName === 'Lakshmi'
      );

      expect(lakshmiPlan).toBeDefined();
      expect(lakshmiPlan.occurrenceId).toBe('birthday:2027');
      expect(lakshmiPlan.occasionLocalDate).toBe('2027-01-05');
      expect(lakshmiPlan.matchExplanation).toContain('opted in');

      // Step 1: Invitation D-14
      const step1 = lakshmiPlan.steps.find((s: any) => s.stepId === 'invitation');
      expect(step1).toBeDefined();
      expect(step1.offsetDays).toBe(-14);
      expect(step1.localDate).toBe('2026-12-22');
      expect(step1.localTime).toBe('10:00');
      expect(step1.dueAtUtc).toBe('2026-12-22T04:30:00.000Z'); // 10:00 IST = 04:30 UTC
      expect(step1.status).toBe('SCHEDULED');
      expect(step1.renderedMessage).toContain('Hi Lakshmi, your birthday is coming up!');

      // Step 2: Followup D-7
      const step2 = lakshmiPlan.steps.find((s: any) => s.stepId === 'followup');
      expect(step2).toBeDefined();
      expect(step2.offsetDays).toBe(-7);
      expect(step2.localDate).toBe('2026-12-29');
      expect(step2.dueAtUtc).toBe('2026-12-29T04:30:00.000Z');
      expect(step2.status).toBe('SCHEDULED');

      // Step 3: Greeting D0 (template hello_world has bodyText: null -> displays templateName [params])
      const step3 = lakshmiPlan.steps.find((s: any) => s.stepId === 'greeting');
      expect(step3).toBeDefined();
      expect(step3.offsetDays).toBe(0);
      expect(step3.localDate).toBe('2027-01-05');
      expect(step3.dueAtUtc).toBe('2027-01-05T04:30:00.000Z');
      expect(step3.renderedMessage).toBe('hello_world []');

      // Reset dev offset
      clock.resetOffset();
    });

    it('A08: Feb 29 customer (Ananya Sen) follows FEB_28 policy once', async () => {
      const res = await request(app)
        .post(`/campaigns/${campaignId}/dry-runs`)
        .set('Authorization', `Bearer ${shopAOwnerToken}`);

      expect(res.status).toBe(201);
      const feb29Plan = res.body.samplePlans.find(
        (p: any) => p.customerName === 'Ananya Sen'
      );

      expect(feb29Plan).toBeDefined();
      // In 2027 (non-leap year), Feb 28 is used per FEB_28 policy
      expect(feb29Plan.occasionLocalDate).toBe('2027-02-28');
    });

    it('A04: evaluates cleanly even when zero customers match an aggressive audience rule', async () => {
      // Create campaign with impossible audience filter
      const createRes = await request(app)
        .post('/campaigns')
        .set('Authorization', `Bearer ${shopAOwnerToken}`)
        .set('Idempotency-Key', 'a04-zero-match-init')
        .send({
          presetId: 'birthday',
          name: 'Zero Match Audience Test',
        });

      const zeroCmpId = createRes.body.campaign.campaignId;

      await request(app)
        .patch(`/campaigns/${zeroCmpId}/draft`)
        .set('Authorization', `Bearer ${shopAOwnerToken}`)
        .set('Idempotency-Key', 'a04-zero-match-patch')
        .send({
          expectedVersion: 1,
          audience: {
            mode: 'CUSTOM_RULES',
            rules: {
              all: [{ field: 'preferences.weave', op: 'eq', value: 'NonExistentFabric999' }],
            },
          },
          steps: [
            {
              stepId: 'invitation',
              offsetDays: -14,
              localTime: '10:00',
              prerequisite: 'NONE',
              templateRef: { id: 'tpl_hello_world', revision: 1, language: 'en_US' },
              bindings: {},
              stopOnReply: true,
              stopOnGoal: true,
              maxLatenessMinutes: 120,
            },
          ],
        });

      const dryRes = await request(app)
        .post(`/campaigns/${zeroCmpId}/dry-runs`)
        .set('Authorization', `Bearer ${shopAOwnerToken}`);

      expect(dryRes.status).toBe(201);
      expect(dryRes.body.counts.eligible).toBe(0);
      expect(dryRes.body.reasonBreakdown[EXCLUSION_REASONS.EXCLUDED_AUDIENCE_FILTER]).toBeGreaterThan(0);
    });

    it('C05 / A05: rejects dry run when campaign draft has blocking validation errors', async () => {
      const createRes = await request(app)
        .post('/campaigns')
        .set('Authorization', `Bearer ${shopAOwnerToken}`)
        .set('Idempotency-Key', 'invalid-draft-dry-run-test')
        .send({
          presetId: 'birthday',
          name: 'Invalid Draft Test',
        });

      const invCmpId = createRes.body.campaign.campaignId;

      // In initial draft, templateRef is null (invalid for dry run)
      const dryRes = await request(app)
        .post(`/campaigns/${invCmpId}/dry-runs`)
        .set('Authorization', `Bearer ${shopAOwnerToken}`);

      expect(dryRes.status).toBe(400);
      expect(dryRes.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('Editing the draft changes the fingerprint and flags the previous dry run as stale', async () => {
      // 1. Run dry run on current draft
      const initialDryRun = await request(app)
        .post(`/campaigns/${campaignId}/dry-runs`)
        .set('Authorization', `Bearer ${shopAOwnerToken}`);

      expect(initialDryRun.status).toBe(201);
      const initialFingerprint = initialDryRun.body.draftFingerprint;

      // 2. Fetch latest dry run: isStale should be false
      const latestBefore = await request(app)
        .get(`/campaigns/${campaignId}/dry-runs/latest`)
        .set('Authorization', `Bearer ${shopAOwnerToken}`);

      expect(latestBefore.status).toBe(200);
      expect(latestBefore.body.isStale).toBe(false);
      expect(latestBefore.body.draftFingerprint).toBe(initialFingerprint);

      // 3. Edit draft (change campaign name or step offset)
      const campaignDoc = await CampaignModel.findOne({ campaignId });
      const patchRes = await request(app)
        .patch(`/campaigns/${campaignId}/draft`)
        .set('Authorization', `Bearer ${shopAOwnerToken}`)
        .set('Idempotency-Key', `fingerprint-change-${Date.now()}`)
        .send({
          expectedVersion: campaignDoc!.draftVersion,
          name: 'Updated Name for Fingerprint Test',
        });

      expect(patchRes.status).toBe(200);

      // 4. Calculate new fingerprint
      const updatedDraft = await CampaignVersionModel.findOne({
        campaignId,
        version: patchRes.body.draft.version,
      }).lean();
      const newFingerprint = computeDraftFingerprint(updatedDraft as any);

      expect(newFingerprint).not.toBe(initialFingerprint);

      // 5. Fetch latest dry run: MUST now be flagged as isStale: true
      const latestAfter = await request(app)
        .get(`/campaigns/${campaignId}/dry-runs/latest`)
        .set('Authorization', `Bearer ${shopAOwnerToken}`);

      expect(latestAfter.status).toBe(200);
      expect(latestAfter.body.isStale).toBe(true);
      expect(latestAfter.body.draftFingerprint).toBe(initialFingerprint);
      expect(latestAfter.body.currentFingerprint).toBe(newFingerprint);
    });

    it('staff role receives 403 Forbidden on dry-run routes (RBAC)', async () => {
      const resPost = await request(app)
        .post(`/campaigns/${campaignId}/dry-runs`)
        .set('Authorization', `Bearer ${shopAStaffToken}`);

      expect(resPost.status).toBe(403);

      const resGet = await request(app)
        .get(`/campaigns/${campaignId}/dry-runs/latest`)
        .set('Authorization', `Bearer ${shopAStaffToken}`);

      expect(resGet.status).toBe(403);
    });
  });
});

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../src/app';
import { connectToDatabase, disconnectDatabase } from '../src/db/connection';
import { seedDatabase } from '../src/db/seed';
import { CampaignModel } from '../src/db/models/campaign.model';
import { CampaignVersionModel } from '../src/db/models/campaign-version.model';
import { CampaignControlGateModel } from '../src/db/models/campaign-control-gate.model';
import { IdempotencyRecordModel } from '../src/db/models/idempotency-record.model';

describe('Campaign Creation, Draft Management & Validation Engine (Feature 5, Spec p5-8, p20-26, C15, C16)', () => {
  let shopAOwnerToken: string;
  let shopAAdminToken: string;
  let shopAStaffToken: string;
  let shopBOwnerToken: string;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.ALLOW_TEST_CATEGORY_MISMATCH = 'true';
    await connectToDatabase();
    await seedDatabase('base');

    // 1. Log in as shop_a owner
    const loginAOwner = await request(app)
      .post('/auth/login')
      .send({ email: 'owner@shop-a.com', password: 'OwnerSecret#2026!' });
    shopAOwnerToken = loginAOwner.body.token;

    // 2. Log in as shop_a admin
    const loginAAdmin = await request(app)
      .post('/auth/login')
      .send({ email: 'admin@shop-a.com', password: 'AdminSecret#2026!' });
    shopAAdminToken = loginAAdmin.body.token;

    // 3. Log in as shop_a staff
    const loginAStaff = await request(app)
      .post('/auth/login')
      .send({ email: 'staff@shop-a.com', password: 'StaffSecret#2026!' });
    shopAStaffToken = loginAStaff.body.token;

    // 4. Log in as shop_b owner
    const loginBOwner = await request(app)
      .post('/auth/login')
      .send({ email: 'owner@shop-b.com', password: 'ShopBSecret#2026!' });
    shopBOwnerToken = loginBOwner.body.token;
  });

  afterAll(async () => {
    await disconnectDatabase();
  });

  // ==========================================================================
  // 1. Presets Catalogue (Hard Rule 10, Spec p5)
  // ==========================================================================
  describe('GET /campaign-presets', () => {
    it('returns all catalogue presets with accurate implemented capability flags', async () => {
      const res = await request(app)
        .get('/campaign-presets')
        .set('Authorization', `Bearer ${shopAStaffToken}`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);

      const birthday = res.body.find((p: any) => p.id === 'birthday');
      const anniversary = res.body.find((p: any) => p.id === 'anniversary');
      const winBack = res.body.find((p: any) => p.id === 'win_back');
      const festival = res.body.find((p: any) => p.id === 'festival_collection' || p.id === 'festival');

      expect(birthday).toBeDefined();
      expect(birthday.implemented).toBe(true);
      expect(birthday.defaults.trigger.type).toBe('ANNUAL_DATE');

      expect(anniversary).toBeDefined();
      expect(anniversary.implemented).toBe(true);

      // Win-back is now implemented in F16 (Hard Rule 10, Spec p5, p14, p17)
      expect(winBack).toBeDefined();
      expect(winBack.implemented).toBe(true);
      expect(winBack.defaults.trigger.type).toBe('INACTIVITY_THRESHOLD');

      // Festival is implemented in F28 (Hard Rule 10, Spec p5, p13, p18)
      expect(festival).toBeDefined();
      expect(festival.implemented).toBe(true);
    });

    it('supports alias /api/v1/campaign-presets', async () => {
      const res = await request(app)
        .get('/api/v1/campaign-presets')
        .set('Authorization', `Bearer ${shopAStaffToken}`);

      expect(res.status).toBe(200);
    });
  });

  // ==========================================================================
  // 2. Draft Creation & RBAC & Control Gate Initialization
  // ==========================================================================
  describe('POST /campaigns (Create Draft, No Sends)', () => {
    it('rejects unauthenticated requests with 401', async () => {
      const res = await request(app)
        .post('/campaigns')
        .send({ presetId: 'birthday', name: 'Birthday 2026' });

      expect(res.status).toBe(401);
    });

    it('rejects staff role with 403 Forbidden', async () => {
      const res = await request(app)
        .post('/campaigns')
        .set('Authorization', `Bearer ${shopAStaffToken}`)
        .set('Idempotency-Key', 'staff-create-attempt')
        .send({ presetId: 'birthday', name: 'Staff Birthday Campaign' });

      expect(res.status).toBe(403);
    });

    it('rejects missing Idempotency-Key with 400', async () => {
      const res = await request(app)
        .post('/campaigns')
        .set('Authorization', `Bearer ${shopAOwnerToken}`)
        .send({ presetId: 'birthday', name: 'Birthday No Idempotency' });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain('Idempotency-Key');
    });

    it('rejects unimplemented presets with 400 (Hard Rule 10)', async () => {
      const res = await request(app)
        .post('/campaigns')
        .set('Authorization', `Bearer ${shopAOwnerToken}`)
        .set('Idempotency-Key', 'unimplemented-preset-key')
        .send({ presetId: 'vip_loyalty', name: 'VIP Campaign' });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain('evaluator is not yet implemented');
    });

    it('rejects unauthorized branch references with 400', async () => {
      const res = await request(app)
        .post('/campaigns')
        .set('Authorization', `Bearer ${shopAOwnerToken}`)
        .set('Idempotency-Key', 'unauthorized-branch-key')
        .send({
          presetId: 'birthday',
          name: 'Invalid Branch Campaign',
          enabledBranches: ['branch_shop_b_only'],
        });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain('Unauthorized or invalid branch reference');
    });

    it('creates a Birthday draft successfully with control-gate and version 1', async () => {
      const res = await request(app)
        .post('/campaigns')
        .set('Authorization', `Bearer ${shopAOwnerToken}`)
        .set('Idempotency-Key', 'birthday-draft-create-1')
        .send({
          presetId: 'birthday',
          name: 'Boutique Birthday Club',
        });

      expect(res.status).toBe(201);
      expect(res.body.campaign).toBeDefined();
      expect(res.body.draft).toBeDefined();

      const { campaign, draft } = res.body;

      expect(campaign.tenantId).toBe('shop_a');
      expect(campaign.status).toBe('DRAFT');
      expect(campaign.draftVersion).toBe(1);
      expect(campaign.activeVersionId).toBeNull();
      expect(campaign.pauseGeneration).toBe(0);

      expect(draft.tenantId).toBe('shop_a');
      expect(draft.campaignId).toBe(campaign.campaignId);
      expect(draft.version).toBe(1);
      expect(draft.trigger.type).toBe('ANNUAL_DATE');
      expect(draft.trigger.field).toBe('customer.birthday');
      expect(draft.trigger.leapDayPolicy).toBe('FEB_28');
      expect(draft.timezone).toBe('Asia/Kolkata');
      expect(draft.steps.length).toBe(3);

      // Verify campaignControlGates document in Mongo
      const gate = await CampaignControlGateModel.findOne({
        tenantId: 'shop_a',
        campaignId: campaign.campaignId,
      });
      expect(gate).toBeDefined();
      expect(gate?.pauseGeneration).toBe(0);
      expect(gate?.version).toBe(1);
    });

    it('enforces duplicate click idempotency (C15): returns same result without duplicate documents', async () => {
      const key = `duplicate-click-idempotency-test-key-${Date.now()}`;
      const name = `Anniversary Idempotency Test ${Date.now()}`;

      // First click
      const res1 = await request(app)
        .post('/campaigns')
        .set('Authorization', `Bearer ${shopAOwnerToken}`)
        .set('Idempotency-Key', key)
        .send({ presetId: 'anniversary', name });

      expect(res1.status).toBe(201);
      const campaignId1 = res1.body.campaign.campaignId;

      // Second identical click (e.g. double click or network retry)
      const res2 = await request(app)
        .post('/campaigns')
        .set('Authorization', `Bearer ${shopAOwnerToken}`)
        .set('Idempotency-Key', key)
        .send({ presetId: 'anniversary', name });

      expect(res2.status).toBe(201);
      expect(res2.headers['x-idempotent-replay']).toBe('true');
      expect(res2.body.campaign.campaignId).toBe(campaignId1);

      // Verify in DB that only one campaign was created
      const count = await CampaignModel.countDocuments({
        tenantId: 'shop_a',
        name,
      });
      expect(count).toBe(1);
    });
  });

  // ==========================================================================
  // 3. Campaign Retrieval & Tenant Isolation
  // ==========================================================================
  describe('GET /campaigns & GET /campaigns/:id', () => {
    let createdCampaignId: string;

    beforeAll(async () => {
      const res = await request(app)
        .post('/campaigns')
        .set('Authorization', `Bearer ${shopAOwnerToken}`)
        .set('Idempotency-Key', 'get-test-campaign-key')
        .send({ presetId: 'birthday', name: 'Get Campaign Test' });
      createdCampaignId = res.body.campaign.campaignId;
    });

    it('lists campaigns strictly scoped to authenticated tenant', async () => {
      const resA = await request(app)
        .get('/campaigns')
        .set('Authorization', `Bearer ${shopAOwnerToken}`);

      expect(resA.status).toBe(200);
      expect(resA.body.some((c: any) => c.campaignId === createdCampaignId)).toBe(true);

      // Shop B list must NOT contain Shop A's campaign
      const resB = await request(app)
        .get('/campaigns')
        .set('Authorization', `Bearer ${shopBOwnerToken}`);

      expect(resB.status).toBe(200);
      expect(resB.body.some((c: any) => c.campaignId === createdCampaignId)).toBe(false);
    });

    it('returns 404 when shop_b attempts to retrieve shop_a campaign by ID (cross-tenant isolation)', async () => {
      const res = await request(app)
        .get(`/campaigns/${createdCampaignId}`)
        .set('Authorization', `Bearer ${shopBOwnerToken}`);

      expect(res.status).toBe(404);
    });

    it('returns full campaign, draft version, and control gate to authorized owner', async () => {
      const res = await request(app)
        .get(`/campaigns/${createdCampaignId}`)
        .set('Authorization', `Bearer ${shopAOwnerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.campaign.campaignId).toBe(createdCampaignId);
      expect(res.body.draft.version).toBe(1);
      expect(res.body.controlGate).toBeDefined();
      expect(res.body.oldVersionEnrollmentCounts).toBe(0);
    });
  });

  // ==========================================================================
  // 4. Draft Updates & 409 Optimistic Concurrency Conflict (Spec p26, C16)
  // ==========================================================================
  describe('PATCH /campaigns/:id/draft', () => {
    let campaignId: string;

    beforeAll(async () => {
      const res = await request(app)
        .post('/campaigns')
        .set('Authorization', `Bearer ${shopAOwnerToken}`)
        .set('Idempotency-Key', 'patch-test-setup-key')
        .send({ presetId: 'birthday', name: 'Patch Concurrency Test' });
      campaignId = res.body.campaign.campaignId;
    });

    it('updates draft successfully when expectedVersion matches and increments draft version to 2', async () => {
      const res = await request(app)
        .patch(`/campaigns/${campaignId}/draft`)
        .set('Authorization', `Bearer ${shopAOwnerToken}`)
        .set('Idempotency-Key', 'patch-update-v1-to-v2')
        .send({
          expectedVersion: 1,
          name: 'Updated Boutique Birthday Campaign',
        });

      expect(res.status).toBe(200);
      expect(res.body.draft.version).toBe(2);
      expect(res.body.campaign.draftVersion).toBe(2);
      expect(res.body.draft.name).toBe('Updated Boutique Birthday Campaign');
      expect(res.body.campaign.name).toBe('Updated Boutique Birthday Campaign');
    });

    it('returns 409 Conflict when expectedVersion is stale (C16)', async () => {
      // Current version is 2; passing expectedVersion 1 must trigger 409
      const res = await request(app)
        .patch(`/campaigns/${campaignId}/draft`)
        .set('Authorization', `Bearer ${shopAOwnerToken}`)
        .set('Idempotency-Key', 'stale-patch-attempt-key')
        .send({
          expectedVersion: 1,
          name: 'Stale Overwrite Attempt',
        });

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('CONFLICT');
      expect(res.body.error.message).toContain('expected version 1, but current version is 2');
      expect(res.body.error.details.expectedVersion).toBe(1);
      expect(res.body.error.details.currentVersion).toBe(2);
    });

    it('rejects non-allowlisted configuration fields via schema strict check', async () => {
      const res = await request(app)
        .patch(`/campaigns/${campaignId}/draft`)
        .set('Authorization', `Bearer ${shopAOwnerToken}`)
        .set('Idempotency-Key', 'forbidden-field-patch')
        .send({
          expectedVersion: 2,
          arbitraryScriptField: 'DROP TABLE',
        });

      expect(res.status).toBe(400);
    });
  });

  // ==========================================================================
  // 5. Validation Matrix, Variables & Category Rule (The Verification Suite)
  // Spec: "You verify: build a draft with order-confirmation (3 variables) mapped to
  // firstName, a literal, and occasion date; then try 2 bindings, 4 steps,
  // descending offsets, and a template that is not in the catalogue."
  // ==========================================================================
  describe('POST /campaigns/:id/validate - Verification Suite', () => {
    let testCampaignId: string;

    beforeAll(async () => {
      const res = await request(app)
        .post('/campaigns')
        .set('Authorization', `Bearer ${shopAOwnerToken}`)
        .set('Idempotency-Key', 'validation-suite-setup-key')
        .send({ presetId: 'birthday', name: 'Validation Matrix Campaign' });
      testCampaignId = res.body.campaign.campaignId;
    });

    it('VERIFY 1: Passes validation with order-confirmation (3 vars) mapped to firstName, literal, and occasion date when ALLOW_TEST_CATEGORY_MISMATCH=true', async () => {
      process.env.ALLOW_TEST_CATEGORY_MISMATCH = 'true';

      // Update draft with order confirmation template and 3 bindings
      const patchRes = await request(app)
        .patch(`/campaigns/${testCampaignId}/draft`)
        .set('Authorization', `Bearer ${shopAOwnerToken}`)
        .set('Idempotency-Key', 'patch-order-confirmation-3-vars')
        .send({
          expectedVersion: 1,
          steps: [
            {
              stepId: 'invitation',
              offsetDays: -14,
              localTime: '10:00',
              prerequisite: 'NONE',
              templateRef: {
                id: 'tpl_order_confirmation',
                revision: 1,
                language: 'en_US',
              },
              bindings: {
                '1': 'customer.firstName',
                '2': 'literal:ORD-TEST-999',
                '3': 'occasion.localDate',
              },
              stopOnReply: true,
              stopOnGoal: true,
              maxLatenessMinutes: 120,
            },
            {
              stepId: 'followup',
              offsetDays: -7,
              localTime: '10:00',
              prerequisite: 'PREVIOUS_ACCEPTED',
              templateRef: {
                id: 'tpl_hello_world',
                revision: 1,
                language: 'en_US',
              },
              bindings: {},
              stopOnReply: true,
              stopOnGoal: true,
              maxLatenessMinutes: 120,
            },
          ],
        });

      expect(patchRes.status).toBe(200);

      // Validate
      const valRes = await request(app)
        .post(`/campaigns/${testCampaignId}/validate`)
        .set('Authorization', `Bearer ${shopAOwnerToken}`);

      expect(valRes.status).toBe(200);
      expect(valRes.body.valid).toBe(true);
      expect(valRes.body.errors.length).toBe(0);

      // Warnings should flag TEST ONLY category mismatch for the UTILITY templates
      expect(valRes.body.warnings.some((w: any) => w.message.includes('TEST ONLY: category mismatch'))).toBe(true);

      // Verify campaign status updated to VALIDATED
      const campaignDoc = await CampaignModel.findOne({
        tenantId: 'shop_a',
        campaignId: testCampaignId,
      });
      expect(campaignDoc?.status).toBe('VALIDATED');
    });

    it('VERIFY 2: Category mismatch fails with error (resolutionOwner: INTEGRATION_DEVELOPER) when ALLOW_TEST_CATEGORY_MISMATCH=false', async () => {
      process.env.ALLOW_TEST_CATEGORY_MISMATCH = 'false';

      const valRes = await request(app)
        .post(`/campaigns/${testCampaignId}/validate`)
        .set('Authorization', `Bearer ${shopAOwnerToken}`);

      expect(valRes.status).toBe(200);
      expect(valRes.body.valid).toBe(false);

      const categoryError = valRes.body.errors.find(
        (e: any) => e.fieldPath === 'steps[0].templateRef.category'
      );
      expect(categoryError).toBeDefined();
      expect(categoryError.message).toContain('Category mismatch: marketing campaigns require MARKETING templates');
      expect(categoryError.resolutionOwner).toBe('INTEGRATION_DEVELOPER');

      // Re-enable for subsequent tests
      process.env.ALLOW_TEST_CATEGORY_MISMATCH = 'true';
    });

    it('VERIFY 3: Fails validation when 2 bindings are provided for 3-variable template', async () => {
      // Patch step with only 2 bindings
      const patchRes = await request(app)
        .patch(`/campaigns/${testCampaignId}/draft`)
        .set('Authorization', `Bearer ${shopAOwnerToken}`)
        .set('Idempotency-Key', 'patch-2-bindings-test')
        .send({
          expectedVersion: 2,
          steps: [
            {
              stepId: 'invitation',
              offsetDays: -14,
              localTime: '10:00',
              prerequisite: 'NONE',
              templateRef: {
                id: 'tpl_order_confirmation',
                revision: 1,
                language: 'en_US',
              },
              bindings: {
                '1': 'customer.firstName',
                '2': 'literal:ORD-TEST-999',
                // Missing variable 3
              },
              stopOnReply: true,
              stopOnGoal: true,
              maxLatenessMinutes: 120,
            },
          ],
        });

      expect(patchRes.status).toBe(200);

      const valRes = await request(app)
        .post(`/campaigns/${testCampaignId}/validate`)
        .set('Authorization', `Bearer ${shopAOwnerToken}`);

      expect(valRes.status).toBe(200);
      expect(valRes.body.valid).toBe(false);

      const varCountError = valRes.body.errors.find(
        (e: any) => e.fieldPath === 'steps[0].bindings'
      );
      expect(varCountError).toBeDefined();
      expect(varCountError.message).toContain('Variable count mismatch: template requires 3 variable bindings, but 2 were provided');
      expect(varCountError.resolutionOwner).toBe('BOUTIQUE_OWNER');
    });

    it('VERIFY 4: Fails validation when 4 steps are configured (maximum is 3)', async () => {
      const patchRes = await request(app)
        .patch(`/campaigns/${testCampaignId}/draft`)
        .set('Authorization', `Bearer ${shopAOwnerToken}`)
        .set('Idempotency-Key', 'patch-4-steps-test')
        .send({
          expectedVersion: 3,
          steps: [
            {
              stepId: 'step1',
              offsetDays: -21,
              localTime: '10:00',
              prerequisite: 'NONE',
              templateRef: { id: 'tpl_hello_world', revision: 1, language: 'en_US' },
              bindings: {},
              stopOnReply: true,
              stopOnGoal: true,
              maxLatenessMinutes: 120,
            },
            {
              stepId: 'step2',
              offsetDays: -14,
              localTime: '10:00',
              prerequisite: 'PREVIOUS_ACCEPTED',
              templateRef: { id: 'tpl_hello_world', revision: 1, language: 'en_US' },
              bindings: {},
              stopOnReply: true,
              stopOnGoal: true,
              maxLatenessMinutes: 120,
            },
            {
              stepId: 'step3',
              offsetDays: -7,
              localTime: '10:00',
              prerequisite: 'PREVIOUS_ACCEPTED',
              templateRef: { id: 'tpl_hello_world', revision: 1, language: 'en_US' },
              bindings: {},
              stopOnReply: true,
              stopOnGoal: true,
              maxLatenessMinutes: 120,
            },
            {
              stepId: 'step4',
              offsetDays: 0,
              localTime: '10:00',
              prerequisite: 'NONE',
              templateRef: { id: 'tpl_hello_world', revision: 1, language: 'en_US' },
              bindings: {},
              stopOnReply: false,
              stopOnGoal: true,
              maxLatenessMinutes: 120,
            },
          ],
        });

      // The schema parser itself catches max 3 steps
      expect(patchRes.status).toBe(400);
      expect(patchRes.body.error.message).toBeDefined();
    });

    it('VERIFY 5: Fails validation when steps have descending offsets (-7 then -14)', async () => {
      const patchRes = await request(app)
        .patch(`/campaigns/${testCampaignId}/draft`)
        .set('Authorization', `Bearer ${shopAOwnerToken}`)
        .set('Idempotency-Key', 'patch-descending-offsets-test')
        .send({
          expectedVersion: 3,
          steps: [
            {
              stepId: 'step1',
              offsetDays: -7,
              localTime: '10:00',
              prerequisite: 'NONE',
              templateRef: { id: 'tpl_hello_world', revision: 1, language: 'en_US' },
              bindings: {},
              stopOnReply: true,
              stopOnGoal: true,
              maxLatenessMinutes: 120,
            },
            {
              stepId: 'step2',
              offsetDays: -14, // Descending! Invalid!
              localTime: '10:00',
              prerequisite: 'PREVIOUS_ACCEPTED',
              templateRef: { id: 'tpl_hello_world', revision: 1, language: 'en_US' },
              bindings: {},
              stopOnReply: true,
              stopOnGoal: true,
              maxLatenessMinutes: 120,
            },
          ],
        });

      expect(patchRes.status).toBe(200);

      const valRes = await request(app)
        .post(`/campaigns/${testCampaignId}/validate`)
        .set('Authorization', `Bearer ${shopAOwnerToken}`);

      expect(valRes.status).toBe(200);
      expect(valRes.body.valid).toBe(false);

      const offsetError = valRes.body.errors.find(
        (e: any) => e.fieldPath === 'steps[1].offsetDays'
      );
      expect(offsetError).toBeDefined();
      expect(offsetError.message).toContain('Step offsets must be strictly increasing');
      expect(offsetError.resolutionOwner).toBe('BOUTIQUE_OWNER');
    });

    it('VERIFY 6: Fails validation when template is not in the catalogue (resolutionOwner: INTEGRATION_DEVELOPER)', async () => {
      const patchRes = await request(app)
        .patch(`/campaigns/${testCampaignId}/draft`)
        .set('Authorization', `Bearer ${shopAOwnerToken}`)
        .set('Idempotency-Key', 'patch-missing-template-test')
        .send({
          expectedVersion: 4,
          steps: [
            {
              stepId: 'step1',
              offsetDays: -14,
              localTime: '10:00',
              prerequisite: 'NONE',
              templateRef: {
                id: 'tpl_nonexistent_xyz',
                revision: 1,
                language: 'en_US',
              },
              bindings: {},
              stopOnReply: true,
              stopOnGoal: true,
              maxLatenessMinutes: 120,
            },
          ],
        });

      expect(patchRes.status).toBe(200);

      const valRes = await request(app)
        .post(`/campaigns/${testCampaignId}/validate`)
        .set('Authorization', `Bearer ${shopAOwnerToken}`);

      expect(valRes.status).toBe(200);
      expect(valRes.body.valid).toBe(false);

      const tplError = valRes.body.errors.find(
        (e: any) => e.fieldPath === 'steps[0].templateRef.id'
      );
      expect(tplError).toBeDefined();
      expect(tplError.message).toContain("Template 'tpl_nonexistent_xyz' was not found in the approved template catalogue");
      expect(tplError.resolutionOwner).toBe('INTEGRATION_DEVELOPER');
    });

    it('VERIFY 7: Flags dummy templates (sendable=false) as warnings in draft (spec p8)', async () => {
      const patchRes = await request(app)
        .patch(`/campaigns/${testCampaignId}/draft`)
        .set('Authorization', `Bearer ${shopAOwnerToken}`)
        .set('Idempotency-Key', 'patch-dummy-template-test')
        .send({
          expectedVersion: 5,
          steps: [
            {
              stepId: 'step1',
              offsetDays: -14,
              localTime: '10:00',
              prerequisite: 'NONE',
              templateRef: {
                id: 'tpl_birthday_invite',
                revision: 1,
                language: 'en',
              },
              bindings: {
                '1': 'customer.firstName',
                '2': 'shop.displayName',
              },
              stopOnReply: true,
              stopOnGoal: true,
              maxLatenessMinutes: 120,
            },
          ],
        });

      expect(patchRes.status).toBe(200);

      const valRes = await request(app)
        .post(`/campaigns/${testCampaignId}/validate`)
        .set('Authorization', `Bearer ${shopAOwnerToken}`);

      expect(valRes.status).toBe(200);
      expect(valRes.body.valid).toBe(true);

      const dummyWarning = valRes.body.warnings.find(
        (w: any) => w.message.includes('dummy template: cannot be sent')
      );
      expect(dummyWarning).toBeDefined();
      expect(dummyWarning.resolutionOwner).toBe('INTEGRATION_DEVELOPER');
    });

    it('VERIFY 8: Rejects invalid binding source not in allowlist', async () => {
      const patchRes = await request(app)
        .patch(`/campaigns/${testCampaignId}/draft`)
        .set('Authorization', `Bearer ${shopAOwnerToken}`)
        .set('Idempotency-Key', 'patch-invalid-binding-source')
        .send({
          expectedVersion: 6,
          steps: [
            {
              stepId: 'step1',
              offsetDays: -14,
              localTime: '10:00',
              prerequisite: 'NONE',
              templateRef: {
                id: 'tpl_birthday_invite',
                revision: 1,
                language: 'en',
              },
              bindings: {
                '1': 'customer.phone', // Invalid binding source!
                '2': 'shop.displayName',
              },
              stopOnReply: true,
              stopOnGoal: true,
              maxLatenessMinutes: 120,
            },
          ],
        });

      expect(patchRes.status).toBe(200);

      const valRes = await request(app)
        .post(`/campaigns/${testCampaignId}/validate`)
        .set('Authorization', `Bearer ${shopAOwnerToken}`);

      expect(valRes.status).toBe(200);
      expect(valRes.body.valid).toBe(false);

      const bindingError = valRes.body.errors.find(
        (e: any) => e.fieldPath === 'steps[0].bindings[1]'
      );
      expect(bindingError).toBeDefined();
      expect(bindingError.message).toContain('Invalid binding source');
      expect(bindingError.resolutionOwner).toBe('BOUTIQUE_OWNER');
    });

    it('VERIFY 9: First step cannot have prerequisite PREVIOUS_ACCEPTED', async () => {
      const patchRes = await request(app)
        .patch(`/campaigns/${testCampaignId}/draft`)
        .set('Authorization', `Bearer ${shopAOwnerToken}`)
        .set('Idempotency-Key', 'patch-prerequisite-step-0')
        .send({
          expectedVersion: 7,
          steps: [
            {
              stepId: 'step1',
              offsetDays: -14,
              localTime: '10:00',
              prerequisite: 'PREVIOUS_ACCEPTED', // Invalid on first step!
              templateRef: {
                id: 'tpl_birthday_invite',
                revision: 1,
                language: 'en',
              },
              bindings: {
                '1': 'customer.firstName',
                '2': 'shop.displayName',
              },
              stopOnReply: true,
              stopOnGoal: true,
              maxLatenessMinutes: 120,
            },
          ],
        });

      expect(patchRes.status).toBe(200);

      const valRes = await request(app)
        .post(`/campaigns/${testCampaignId}/validate`)
        .set('Authorization', `Bearer ${shopAOwnerToken}`);

      expect(valRes.status).toBe(200);
      expect(valRes.body.valid).toBe(false);

      const prereqError = valRes.body.errors.find(
        (e: any) => e.fieldPath === 'steps[0].prerequisite'
      );
      expect(prereqError).toBeDefined();
      expect(prereqError.message).toContain('First campaign step cannot require PREVIOUS_ACCEPTED');
      expect(prereqError.resolutionOwner).toBe('BOUTIQUE_OWNER');
    });
  });
});

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import { app } from '../src/app';
import { connectToDatabase, disconnectDatabase } from '../src/db/connection';
import { seedDatabase } from '../src/db/seed';
import { CampaignModel } from '../src/db/models/campaign.model';
import { CampaignVersionModel } from '../src/db/models/campaign-version.model';
import { createCampaignVersionRepository } from '../src/db/tenant-repository';
import { clock } from '../src/services/clock';

describe('Campaign Activation, Immutable Versions & Revisions (Feature 7, Spec p9, p20, p25, A02-A05, B14, C15, C16)', () => {
  let shopAOwnerToken: string;
  let shopAAdminToken: string;
  let shopAStaffToken: string;
  let shopBOwnerToken: string;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.ALLOW_TEST_CATEGORY_MISMATCH = 'true';
    process.env.DISPATCH_MODE = 'dry';
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

  beforeEach(() => {
    clock.resetOffset();
    process.env.DISPATCH_MODE = 'dry';
    process.env.ALLOW_TEST_CATEGORY_MISMATCH = 'true';
  });

  // Helper to create a valid, dry-run simulated campaign ready for activation
  async function createValidCampaignWithDryRun(params: {
    name?: string;
    templateId?: string;
    sendable?: boolean;
    audienceRules?: any;
    token?: string;
  }) {
    const authToken = params.token || shopAOwnerToken;
    const name = params.name || `Activation Test ${Date.now()}`;
    const templateId = params.templateId || 'tpl_hello_world';

    // 1. Create campaign draft
    const createRes = await request(app)
      .post('/campaigns')
      .set('Authorization', `Bearer ${authToken}`)
      .set('Idempotency-Key', `create-${Date.now()}-${Math.random()}`)
      .send({ presetId: 'birthday', name });

    expect(createRes.status).toBe(201);
    const campaignId = createRes.body.campaign.campaignId;

    // 2. Patch draft with valid step referencing template
    const patchRes = await request(app)
      .patch(`/campaigns/${campaignId}/draft`)
      .set('Authorization', `Bearer ${authToken}`)
      .set('Idempotency-Key', `patch-${Date.now()}-${Math.random()}`)
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
              id: templateId,
              revision: 1,
              language: templateId === 'tpl_birthday_invite' ? 'en' : 'en_US',
            },
            bindings:
              templateId === 'tpl_birthday_invite'
                ? { name: 'customer.firstName', shop: 'shop.displayName' }
                : {},
            stopOnReply: true,
            stopOnGoal: true,
            maxLatenessMinutes: 120,
          },
        ],
        audience: params.audienceRules
          ? { mode: 'CUSTOM_RULES', rules: params.audienceRules }
          : { mode: 'ALL_ELIGIBLE' },
      });

    expect(patchRes.status).toBe(200);

    // 3. Run dry run simulation
    const dryRunRes = await request(app)
      .post(`/campaigns/${campaignId}/dry-runs`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(dryRunRes.status).toBe(201);

    return { campaignId, draftVersion: patchRes.body.draft.version, dryRun: dryRunRes.body };
  }

  // ==========================================================================
  // 1. A02: Activate Reviewed Valid Draft
  // ==========================================================================
  describe('A02: Activate Reviewed Valid Draft (Spec p9, p20, p25, A02)', () => {
    it('activates draft: publishes immutable version, sets activeVersionId, returns next evaluation and never says sent', async () => {
      const { campaignId, draftVersion } = await createValidCampaignWithDryRun({
        name: 'A02 Clean Birthday Campaign',
      });

      const activateRes = await request(app)
        .post(`/campaigns/${campaignId}/activate`)
        .set('Authorization', `Bearer ${shopAOwnerToken}`)
        .set('Idempotency-Key', `activate-${campaignId}`);

      expect(activateRes.status).toBe(200);
      expect(activateRes.body.campaign.status).toBe('ACTIVE');
      expect(activateRes.body.campaign.activeVersionId).toBeDefined();
      expect(activateRes.body.activeVersion).toBeDefined();
      expect(activateRes.body.activeVersion.isPublished).toBe(true);
      expect(activateRes.body.activeVersion.reviewFingerprint).toBeDefined();
      expect(activateRes.body.nextEvaluationAt).toBeDefined();

      // Return "next evaluation", NEVER "sent"
      expect(activateRes.body.message.toLowerCase()).toContain('next evaluation');
      expect(activateRes.body.message.toLowerCase()).not.toContain('sent');
      expect(activateRes.body).not.toHaveProperty('sentCount');
      expect(activateRes.body).not.toHaveProperty('messagesSent');

      // Verify DB persistence
      const campaignDoc = await CampaignModel.findOne({ tenantId: 'shop_a', campaignId });
      expect(campaignDoc?.status).toBe('ACTIVE');
      expect(campaignDoc?.activeVersionId).toBe(activateRes.body.activeVersion._id);

      const versionDoc = await CampaignVersionModel.findOne({
        tenantId: 'shop_a',
        campaignId,
        version: draftVersion,
      });
      expect(versionDoc?.isPublished).toBe(true);
      expect(versionDoc?.activatedBy).toBeDefined();
      expect(versionDoc?.activatedAt).toBeDefined();
      expect(versionDoc?.reviewFingerprint).toBe(activateRes.body.activeVersion.reviewFingerprint);
      expect(versionDoc?.nextEvaluationAt).toBeDefined();
    });

    it('rejects staff activation attempt with 403 Forbidden', async () => {
      const { campaignId } = await createValidCampaignWithDryRun({
        name: 'Staff Activation Guard',
      });

      const activateRes = await request(app)
        .post(`/campaigns/${campaignId}/activate`)
        .set('Authorization', `Bearer ${shopAStaffToken}`);

      expect(activateRes.status).toBe(403);
    });

    it('prevents cross-tenant activation attempts (shop_b cannot activate shop_a campaign)', async () => {
      const { campaignId } = await createValidCampaignWithDryRun({
        name: 'Cross Tenant Guard',
      });

      const activateRes = await request(app)
        .post(`/campaigns/${campaignId}/activate`)
        .set('Authorization', `Bearer ${shopBOwnerToken}`);

      expect(activateRes.status).toBe(404);
    });
  });

  // ==========================================================================
  // 2. A03: Draft Changed After Dry Run (Fingerprint Mismatch)
  // ==========================================================================
  describe('A03: Draft Changed After Dry Run (Spec p8, p26, A03)', () => {
    it('rejects activation when draft configuration was modified after the dry run simulation', async () => {
      const { campaignId, draftVersion } = await createValidCampaignWithDryRun({
        name: 'A03 Stale Dry Run Campaign',
      });

      // Modify the draft after the dry run simulation (increments version and changes fingerprint)
      const patchRes = await request(app)
        .patch(`/campaigns/${campaignId}/draft`)
        .set('Authorization', `Bearer ${shopAOwnerToken}`)
        .set('Idempotency-Key', `stale-patch-${Date.now()}`)
        .send({
          expectedVersion: draftVersion,
          name: 'Modified Campaign Name After Dry Run',
        });
      expect(patchRes.status).toBe(200);

      // Attempt to activate with the old dry run
      const activateRes = await request(app)
        .post(`/campaigns/${campaignId}/activate`)
        .set('Authorization', `Bearer ${shopAOwnerToken}`);

      expect(activateRes.status).toBe(400);
      expect(activateRes.body.error.code).toBe('VALIDATION_ERROR');
      expect(activateRes.body.error.message.toLowerCase()).toContain('fingerprint mismatch');

      // Campaign must remain in non-ACTIVE status
      const campaignDoc = await CampaignModel.findOne({ tenantId: 'shop_a', campaignId });
      expect(campaignDoc?.status).not.toBe('ACTIVE');
    });
  });

  // ==========================================================================
  // 3. A04: Zero Current Matches = Warning Only
  // ==========================================================================
  describe('A04: Zero Current Matches Warning (Spec p8, A04)', () => {
    it('activates successfully with visible warning when zero eligible customers match today', async () => {
      // Create campaign with impossible budget rule to force 0 eligible candidates
      const { campaignId } = await createValidCampaignWithDryRun({
        name: 'A04 Zero Matches Campaign',
        audienceRules: {
          all: [{ field: 'preferences.budgetMaxPaise', op: 'gte', value: 9999999999 }],
        },
      });

      const activateRes = await request(app)
        .post(`/campaigns/${campaignId}/activate`)
        .set('Authorization', `Bearer ${shopAOwnerToken}`);

      expect(activateRes.status).toBe(200);
      expect(activateRes.body.campaign.status).toBe('ACTIVE');
      expect(activateRes.body.warnings).toBeDefined();
      expect(
        activateRes.body.warnings.some((w: string) =>
          w.toLowerCase().includes('zero eligible customers')
        )
      ).toBe(true);
    });
  });

  // ==========================================================================
  // 4. A05: Missing Template or Mapping Source Blocks Activation
  // ==========================================================================
  describe('A05: Missing Template or Mapping Source (Spec p8, p20, A05)', () => {
    it('blocks activation with fieldPath and resolutionOwner when template is not in approved catalogue', async () => {
      // 1. Create draft
      const createRes = await request(app)
        .post('/campaigns')
        .set('Authorization', `Bearer ${shopAOwnerToken}`)
        .set('Idempotency-Key', `a05-tpl-${Date.now()}`)
        .send({ presetId: 'birthday', name: 'A05 Missing Template Campaign' });
      const campaignId = createRes.body.campaign.campaignId;

      // 2. Set non-existent template directly in DB to bypass draft patch check
      await CampaignVersionModel.updateOne(
        { tenantId: 'shop_a', campaignId, version: 1 },
        {
          $set: {
            steps: [
              {
                stepId: 'invitation',
                stepName: 'Occasion Invitation',
                offsetDays: -14,
                localTime: '10:00',
                prerequisite: 'NONE',
                templateRef: {
                  id: 'tpl_nonexistent_in_catalogue',
                  revision: 1,
                  language: 'en_US',
                },
                bindings: {},
                stopOnReply: true,
                stopOnGoal: true,
                maxLatenessMinutes: 120,
              },
            ],
          },
        }
      );

      // 3. Attempt activation
      const activateRes = await request(app)
        .post(`/campaigns/${campaignId}/activate`)
        .set('Authorization', `Bearer ${shopAOwnerToken}`);

      expect(activateRes.status).toBe(400);
      const errors = activateRes.body.error.details;
      expect(Array.isArray(errors)).toBe(true);

      const tplError = errors.find((e: any) => e.fieldPath.includes('templateRef'));
      expect(tplError).toBeDefined();
      expect(tplError.resolutionOwner).toBe('INTEGRATION_DEVELOPER');
    });

    it('blocks activation with fieldPath and resolutionOwner when variable binding source is invalid', async () => {
      const createRes = await request(app)
        .post('/campaigns')
        .set('Authorization', `Bearer ${shopAOwnerToken}`)
        .set('Idempotency-Key', `a05-binding-${Date.now()}`)
        .send({ presetId: 'birthday', name: 'A05 Bad Binding Campaign' });
      const campaignId = createRes.body.campaign.campaignId;

      // Set invalid binding source directly in DB
      await CampaignVersionModel.updateOne(
        { tenantId: 'shop_a', campaignId, version: 1 },
        {
          $set: {
            steps: [
              {
                stepId: 'invitation',
                stepName: 'Occasion Invitation',
                offsetDays: -14,
                localTime: '10:00',
                prerequisite: 'NONE',
                templateRef: {
                  id: 'tpl_hello_world',
                  revision: 1,
                  language: 'en_US',
                },
                bindings: {
                  unwantedParam: 'customer.nonExistentUnknownSource',
                },
                stopOnReply: true,
                stopOnGoal: true,
                maxLatenessMinutes: 120,
              },
            ],
          },
        }
      );

      const activateRes = await request(app)
        .post(`/campaigns/${campaignId}/activate`)
        .set('Authorization', `Bearer ${shopAOwnerToken}`);

      expect(activateRes.status).toBe(400);
      const errors = activateRes.body.error.details;
      expect(Array.isArray(errors)).toBe(true);
      const bindingErr = errors.find((e: any) => e.fieldPath.includes('bindings'));
      expect(bindingErr).toBeDefined();
      expect(bindingErr.resolutionOwner).toBe('BOUTIQUE_OWNER');
    });
  });

  // ==========================================================================
  // 5. Dummy Template Rule in Both Dispatch Modes
  // ==========================================================================
  describe('Dummy Template Rule in Both Dispatch Modes (Spec p8, F7)', () => {
    it('BLOCKS activation when DISPATCH_MODE=meta and step uses dummy template (sendable=false)', async () => {
      process.env.DISPATCH_MODE = 'meta';

      const { campaignId } = await createValidCampaignWithDryRun({
        name: 'Meta Mode Dummy Template Test',
        templateId: 'tpl_birthday_invite', // sendable: false
      });

      const activateRes = await request(app)
        .post(`/campaigns/${campaignId}/activate`)
        .set('Authorization', `Bearer ${shopAOwnerToken}`);

      expect(activateRes.status).toBe(400);
      expect(activateRes.body.error.code).toBe('VALIDATION_ERROR');
      const errors = activateRes.body.error.details;
      const dummyErr = errors.find((e: any) => e.fieldPath.includes('templateRef'));
      expect(dummyErr).toBeDefined();
      expect(dummyErr.resolutionOwner).toBe('INTEGRATION_DEVELOPER');
      expect(dummyErr.message).toContain('sendable=false');
    });

    it('ALLOWS activation when DISPATCH_MODE=dry with visible warning', async () => {
      process.env.DISPATCH_MODE = 'dry';

      const { campaignId } = await createValidCampaignWithDryRun({
        name: 'Dry Mode Dummy Template Test',
        templateId: 'tpl_birthday_invite', // sendable: false
      });

      const activateRes = await request(app)
        .post(`/campaigns/${campaignId}/activate`)
        .set('Authorization', `Bearer ${shopAOwnerToken}`);

      expect(activateRes.status).toBe(200);
      expect(activateRes.body.campaign.status).toBe('ACTIVE');
      expect(activateRes.body.warnings).toBeDefined();
      expect(
        activateRes.body.warnings.some((w: string) =>
          w.includes('dry mode: this campaign cannot send real messages')
        )
      ).toBe(true);
    });
  });

  // ==========================================================================
  // 6. C15: Stable Idempotency & Rapid Double Click (Spec p20, p25, C15)
  // ==========================================================================
  describe('C15: Rapid Double Click & Stable Idempotency (Spec p20, p25, C15)', () => {
    it('returns identical operation response without duplicate publish on rapid double-click', async () => {
      const { campaignId } = await createValidCampaignWithDryRun({
        name: 'C15 Double Click Campaign',
      });
      const idempotencyKey = `double-click-${Date.now()}`;

      // First click
      const res1 = await request(app)
        .post(`/campaigns/${campaignId}/activate`)
        .set('Authorization', `Bearer ${shopAOwnerToken}`)
        .set('Idempotency-Key', idempotencyKey);

      expect(res1.status).toBe(200);
      const activeVersionId = res1.body.campaign.activeVersionId;

      // Rapid second click with same idempotency key
      const res2 = await request(app)
        .post(`/campaigns/${campaignId}/activate`)
        .set('Authorization', `Bearer ${shopAOwnerToken}`)
        .set('Idempotency-Key', idempotencyKey);

      expect(res2.status).toBe(200);
      expect(res2.headers['x-idempotent-replay']).toBe('true');
      expect(res2.body.campaign.activeVersionId).toBe(activeVersionId);

      // Verify in DB only 1 published version exists for this campaign
      const publishedCount = await CampaignVersionModel.countDocuments({
        tenantId: 'shop_a',
        campaignId,
        isPublished: true,
      });
      expect(publishedCount).toBe(1);
    });

    it('returns existing active operation safely without error on page refresh without idempotency key', async () => {
      const { campaignId } = await createValidCampaignWithDryRun({
        name: 'C15 Refresh Campaign',
      });

      // Initial activation
      const res1 = await request(app)
        .post(`/campaigns/${campaignId}/activate`)
        .set('Authorization', `Bearer ${shopAOwnerToken}`);
      expect(res1.status).toBe(200);

      // Page refresh / duplicate call without key
      const res2 = await request(app)
        .post(`/campaigns/${campaignId}/activate`)
        .set('Authorization', `Bearer ${shopAOwnerToken}`);
      expect(res2.status).toBe(200);
      expect(res2.body.campaign.status).toBe('ACTIVE');
      expect(res2.body.message).toContain('already active');
    });
  });

  // ==========================================================================
  // 7. B14 Setup & Revisions: Version N+1 Does Not Touch Version N (Spec p9, p20, B14)
  // ==========================================================================
  describe('B14 & Publish Revision: Version N+1 Does Not Touch Version N (Spec p9, p20, B14)', () => {
    it('editing an active campaign creates draft N+1; published version N is untouched; publishing revision pins new enrollments', async () => {
      // 1. Create and activate version 1 (with 1 step)
      const { campaignId } = await createValidCampaignWithDryRun({
        name: 'B14 Multi-version Campaign',
      });

      const activateRes = await request(app)
        .post(`/campaigns/${campaignId}/activate`)
        .set('Authorization', `Bearer ${shopAOwnerToken}`);
      expect(activateRes.status).toBe(200);
      const v1Id = activateRes.body.activeVersion._id;

      // Verify Version 1 in DB
      const v1Before = await CampaignVersionModel.findById(v1Id).lean();
      expect(v1Before.isPublished).toBe(true);
      expect(v1Before.steps.length).toBe(1);

      // 2. Edit active campaign: PATCH /campaigns/:id/draft with expectedVersion: 2
      // Adding a second step to create draft version N+1
      const patchRes = await request(app)
        .patch(`/campaigns/${campaignId}/draft`)
        .set('Authorization', `Bearer ${shopAOwnerToken}`)
        .set('Idempotency-Key', `patch-b14-${Date.now()}`)
        .send({
          expectedVersion: v1Before.version,
          steps: [
            {
              stepId: 'invitation',
              stepName: 'Occasion Invitation',
              offsetDays: -14,
              localTime: '10:00',
              prerequisite: 'NONE',
              templateRef: { id: 'tpl_hello_world', revision: 1, language: 'en_US' },
              bindings: {},
              stopOnReply: true,
              stopOnGoal: true,
              maxLatenessMinutes: 120,
            },
            {
              stepId: 'followup',
              stepName: 'Followup Reminder',
              offsetDays: -7,
              localTime: '10:00',
              prerequisite: 'PREVIOUS_ACCEPTED',
              templateRef: { id: 'tpl_plain_text', revision: 1, language: 'en_US' },
              bindings: {},
              stopOnReply: true,
              stopOnGoal: true,
              maxLatenessMinutes: 120,
            },
          ],
        });

      expect(patchRes.status).toBe(200);
      expect(patchRes.body.draft.version).toBe(v1Before.version + 1);
      expect(patchRes.body.draft.isPublished).toBe(false);
      expect(patchRes.body.draft.steps.length).toBe(2);

      // CRITICAL (B14): Verify Version 1 in DB is 100% UNTOUCHED!
      const v1After = await CampaignVersionModel.findById(v1Id).lean();
      expect(v1After.isPublished).toBe(true);
      expect(v1After.steps.length).toBe(1);
      expect(v1After.version).toBe(v1Before.version);

      // Verify campaign status is still ACTIVE and activeVersionId is still Version 1
      const campaignDuringEdit = await CampaignModel.findOne({ tenantId: 'shop_a', campaignId });
      expect(campaignDuringEdit?.status).toBe('ACTIVE');
      expect(campaignDuringEdit?.activeVersionId).toBe(v1Id.toString());
      expect(campaignDuringEdit?.draftVersion).toBe(v1Before.version + 1);

      // 3. Dry run on the new draft revision
      const dryRunRes = await request(app)
        .post(`/campaigns/${campaignId}/dry-runs`)
        .set('Authorization', `Bearer ${shopAOwnerToken}`);
      expect(dryRunRes.status).toBe(201);

      // 4. Publish revision: POST /campaigns/:id/publish-revision
      const publishRes = await request(app)
        .post(`/campaigns/${campaignId}/publish-revision`)
        .set('Authorization', `Bearer ${shopAOwnerToken}`)
        .send({ expectedVersion: patchRes.body.draft.version });

      expect(publishRes.status).toBe(200);
      expect(publishRes.body.activeVersion.version).toBe(patchRes.body.draft.version);
      expect(publishRes.body.activeVersion.isPublished).toBe(true);
      expect(publishRes.body.activeVersion.steps.length).toBe(2);
      expect(publishRes.body.campaign.activeVersionId).toBe(publishRes.body.activeVersion._id);
      expect(publishRes.body.message.toLowerCase()).toContain('revision published');

      // Verify Version 1 is STILL untouched in DB
      const v1Final = await CampaignVersionModel.findById(v1Id).lean();
      expect(v1Final.steps.length).toBe(1);
      expect(v1Final.isPublished).toBe(true);

      // Verify GET /campaigns/:id/versions lists both versions in descending order
      const versionsRes = await request(app)
        .get(`/campaigns/${campaignId}/versions`)
        .set('Authorization', `Bearer ${shopAOwnerToken}`);

      expect(versionsRes.status).toBe(200);
      expect(versionsRes.body.length).toBe(2);
      expect(versionsRes.body[0].version).toBe(patchRes.body.draft.version);
      expect(versionsRes.body[1].version).toBe(v1Before.version);
    });

    it('returns 409 Conflict when expectedVersion is stale on publish-revision (C16)', async () => {
      const { campaignId } = await createValidCampaignWithDryRun({
        name: 'C16 Revision Conflict Test',
      });

      await request(app)
        .post(`/campaigns/${campaignId}/activate`)
        .set('Authorization', `Bearer ${shopAOwnerToken}`);

      // Create draft v2
      await request(app)
        .patch(`/campaigns/${campaignId}/draft`)
        .set('Authorization', `Bearer ${shopAOwnerToken}`)
        .send({ expectedVersion: 2, name: 'Revision Draft 2' });

      // Run dry run
      await request(app)
        .post(`/campaigns/${campaignId}/dry-runs`)
        .set('Authorization', `Bearer ${shopAOwnerToken}`);

      // Attempt publish-revision with stale expectedVersion 99
      const publishRes = await request(app)
        .post(`/campaigns/${campaignId}/publish-revision`)
        .set('Authorization', `Bearer ${shopAOwnerToken}`)
        .send({ expectedVersion: 99 });

      expect(publishRes.status).toBe(409);
      expect(publishRes.body.error.code).toBe('CONFLICT');
    });
  });

  // ==========================================================================
  // 8. Repository Layer Immutability Enforcement
  // ==========================================================================
  describe('Repository & Model Layer Immutability (Hard Rule 6, Spec p9)', () => {
    it('strictly forbids modifying an already published version via Mongoose doc.save()', async () => {
      const { campaignId } = await createValidCampaignWithDryRun({
        name: 'Immutability Save Guard Test',
      });

      const activateRes = await request(app)
        .post(`/campaigns/${campaignId}/activate`)
        .set('Authorization', `Bearer ${shopAOwnerToken}`);
      expect(activateRes.status).toBe(200);

      const publishedDoc = await CampaignVersionModel.findById(
        activateRes.body.activeVersion._id
      );
      expect(publishedDoc?.isPublished).toBe(true);

      // Attempt to modify and save
      publishedDoc!.name = 'Illegal Alteration on Published Version';
      await expect(publishedDoc!.save()).rejects.toThrow(
        /published and immutable\. Modifications are forbidden/i
      );
    });

    it('strictly forbids modifying an already published version via CampaignVersionModel.updateOne() or findOneAndUpdate()', async () => {
      const { campaignId } = await createValidCampaignWithDryRun({
        name: 'Immutability Query Guard Test',
      });

      const activateRes = await request(app)
        .post(`/campaigns/${campaignId}/activate`)
        .set('Authorization', `Bearer ${shopAOwnerToken}`);
      expect(activateRes.status).toBe(200);

      const publishedVersionId = activateRes.body.activeVersion._id;

      // Attempt updateOne on published doc
      await expect(
        CampaignVersionModel.updateOne(
          { _id: publishedVersionId },
          { $set: { name: 'Direct Update Attempt' } }
        )
      ).rejects.toThrow(/published and immutable\. Updates are forbidden/i);

      // Attempt findOneAndUpdate on published doc
      await expect(
        CampaignVersionModel.findOneAndUpdate(
          { _id: publishedVersionId },
          { $set: { name: 'FindOneAndUpdate Attempt' } }
        )
      ).rejects.toThrow(/published and immutable\. Updates are forbidden/i);
    });

    it('strictly forbids modifying a published version via CampaignVersionRepository', async () => {
      const { campaignId } = await createValidCampaignWithDryRun({
        name: 'Repository Guard Test',
      });

      const activateRes = await request(app)
        .post(`/campaigns/${campaignId}/activate`)
        .set('Authorization', `Bearer ${shopAOwnerToken}`);
      expect(activateRes.status).toBe(200);

      const repo = createCampaignVersionRepository('shop_a');
      await expect(
        repo.updateDraftVersion(campaignId, activateRes.body.activeVersion.version, {
          name: 'Repo Modification Attempt',
        })
      ).rejects.toThrow(/published and immutable/i);
    });
  });

  // ==========================================================================
  // 9. Multi-document Transaction Atomicity
  // ==========================================================================
  describe('Activation Transaction Atomicity (Spec p25)', () => {
    it('rolls back all mutations if any failure occurs during activation transaction', async () => {
      const { campaignId } = await createValidCampaignWithDryRun({
        name: 'Atomicity Rollback Test',
      });

      // Force an error during the transaction by temporarily sabotaging the database index or hook
      const origSave = CampaignModel.prototype.save;
      CampaignModel.prototype.save = async function (options?: any) {
        if (options?.session) {
          throw new Error('Simulated atomic transaction failure');
        }
        return origSave.apply(this, arguments as any);
      };

      try {
        const activateRes = await request(app)
          .post(`/campaigns/${campaignId}/activate`)
          .set('Authorization', `Bearer ${shopAOwnerToken}`);

        expect(activateRes.status).toBe(500);

        // Verify that transaction cleanly rolled back:
        // Campaign must NOT be active, and draft must NOT be marked isPublished
        const campaignDoc = await CampaignModel.findOne({ tenantId: 'shop_a', campaignId });
        expect(campaignDoc?.status).not.toBe('ACTIVE');
        expect(campaignDoc?.activeVersionId).toBeNull();

        const draftDoc = await CampaignVersionModel.findOne({ tenantId: 'shop_a', campaignId });
        expect(draftDoc?.isPublished).toBe(false);
      } finally {
        CampaignModel.prototype.save = origSave;
      }
    });
  });
});

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../src/app';
import { connectToDatabase, disconnectDatabase } from '../src/db/connection';
import { seedDatabase, seedReset } from '../src/db/seed';
import { authService } from '../src/services/auth.service';
import { SrcTemplateModel } from '../src/db/models/src-template.model';
import { SrcConnectionModel } from '../src/db/models/src-connection.model';
import fs from 'fs';
import path from 'path';

describe('Integration Readiness & Approved Template Catalogue (Spec p3, p7, p26, p27)', () => {
  const metaTemplateCatalogue = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, '../../../docs/meta-templates.json'), 'utf8')
  );
  const expectedTemplateCount = metaTemplateCatalogue.templates.length;
  const expectedMetaProvidedCount = metaTemplateCatalogue.templates.filter(
    (template: { source: string }) => template.source === 'META_PROVIDED'
  ).length;
  const expectedSendableCount = metaTemplateCatalogue.templates.filter(
    (template: { sendable: boolean }) => template.sendable
  ).length;
  const expectedUtilityCount = metaTemplateCatalogue.templates.filter(
    (template: { category: string }) => template.category === 'UTILITY'
  ).length;
  const expectedDummyCount = expectedTemplateCount - expectedMetaProvidedCount;
  let ownerShopAToken: string;
  let adminShopAToken: string;
  let staffShopAToken: string;
  let ownerShopBToken: string;

  const originalEnvToken = process.env.META_ACCESS_TOKEN;
  const originalEnvAllowlist = process.env.META_TEST_ALLOWLIST;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    await connectToDatabase();
    await seedReset(true);
    await seedDatabase('base');

    // Generate tokens for role and tenant matrix
    ownerShopAToken = authService.signToken({
      userId: 'user_owner_a',
      tenantId: 'shop_a',
      role: 'owner',
      branchIds: ['branch_main'],
      email: 'owner@shop-a.com',
    });

    adminShopAToken = authService.signToken({
      userId: 'user_admin_a',
      tenantId: 'shop_a',
      role: 'admin',
      branchIds: ['branch_main'],
      email: 'admin@shop-a.com',
    });

    staffShopAToken = authService.signToken({
      userId: 'user_staff_a',
      tenantId: 'shop_a',
      role: 'staff',
      branchIds: ['branch_main'],
      email: 'staff@shop-a.com',
    });

    ownerShopBToken = authService.signToken({
      userId: 'user_owner_b',
      tenantId: 'shop_b',
      role: 'owner',
      branchIds: ['branch_b_main'],
      email: 'owner@shop-b.com',
    });
  });

  afterAll(async () => {
    process.env.META_ACCESS_TOKEN = originalEnvToken;
    process.env.META_TEST_ALLOWLIST = originalEnvAllowlist;
    await disconnectDatabase();
  });

  beforeEach(() => {
    // Default valid test environment for shop_a
    process.env.META_ACCESS_TOKEN = 'EAAG_valid_meta_test_access_token_mock_secret';
    process.env.META_TEST_ALLOWLIST = '919876543210, 919876543211';
  });

  describe('Seed Verification & Exact Match with meta-templates.json', () => {
    it('seeds templates and connection exactly matching docs/meta-templates.json', async () => {
      const metaJsonPath = path.resolve(__dirname, '../../../docs/meta-templates.json');
      const metaContent = JSON.parse(fs.readFileSync(metaJsonPath, 'utf-8'));

      const dbTemplates = await SrcTemplateModel.find({}).sort({ id: 1 }).lean();
      expect(dbTemplates.length).toBe(metaContent.templates.length);

      for (const expected of metaContent.templates) {
        const found = dbTemplates.find((t) => t.id === expected.id);
        expect(found, `Template ${expected.id} must exist in database`).toBeDefined();
        expect(found?.name).toBe(expected.name);
        expect(found?.language).toBe(expected.language);
        expect(found?.category).toBe(expected.category);
        expect(found?.status).toBe(expected.status);
        expect(found?.revision).toBe(expected.revision);
        expect(found?.source).toBe(expected.source);

        // Dummy templates must strictly have sendable=false
        if (expected.source === 'DUMMY') {
          expect(found?.sendable).toBe(false);
        } else {
          expect(found?.sendable).toBe(expected.sendable);
        }
      }

      // Check shop_a connection
      const connectionA = await SrcConnectionModel.findOne({ tenantId: 'shop_a' }).lean();
      expect(connectionA).not.toBeNull();
      expect(connectionA?.id).toBe(metaContent.connection.connectionId);
      expect(connectionA?.phoneNumberId).toBe(metaContent.connection.phoneNumberId);
      expect(connectionA?.wabaId).toBe(metaContent.connection.wabaId);
      expect(connectionA?.secretRef).toBe(metaContent.connection.secretRefEnvKey);
      expect(connectionA?.graphApiVersion).toBe(metaContent.graphApiVersion);
      expect(connectionA?.status).toBe('ACTIVE');
    });

    it('enforces read-only protection against application updates and deletions', async () => {
      // Application code trying to mutate templates should throw
      await expect(
        SrcTemplateModel.updateOne({ id: 'tpl_hello_world' }, { status: 'MODIFIED' })
      ).rejects.toThrow(/read-only to application code/i);

      // Application code trying to mutate connections should throw
      await expect(
        SrcConnectionModel.updateOne({ tenantId: 'shop_a' }, { status: 'MODIFIED' })
      ).rejects.toThrow(/read-only to application code/i);
    });
  });

  describe('GET /approved-template-catalogue', () => {
    it('allows owner to retrieve template catalogue with sendable badges and variable schemas', async () => {
      const res = await request(app)
        .get('/approved-template-catalogue')
        .set('Authorization', `Bearer ${ownerShopAToken}`);

      expect(res.status).toBe(200);
      expect(res.body.templates).toBeInstanceOf(Array);
      expect(res.body.templates.length).toBe(expectedTemplateCount);
      expect(res.body.total).toBe(expectedTemplateCount);
      expect(res.body.sendableCount).toBe(expectedSendableCount);
      expect(res.body.metaProvidedCount).toBe(expectedMetaProvidedCount);
      expect(res.body.dummyCount).toBe(expectedDummyCount);

      const orderConfTpl = res.body.templates.find(
        (t: { id: string }) => t.id === 'tpl_order_confirmation'
      );
      expect(orderConfTpl).toBeDefined();
      expect(orderConfTpl.variables.length).toBe(3);
      expect(orderConfTpl.variables[0]).toEqual({
        index: 1,
        name: 'customer_name',
        type: 'text',
        sample: 'John Doe',
      });
      expect(orderConfTpl.sendable).toBe(true);
      expect(orderConfTpl.source).toBe('META_PROVIDED');

      const dummyInvite = res.body.templates.find(
        (t: { id: string }) => t.id === 'tpl_birthday_invite'
      );
      expect(dummyInvite).toBeDefined();
      expect(dummyInvite.sendable).toBe(false);
      expect(dummyInvite.source).toBe('DUMMY');
    });

    it('allows admin to retrieve template catalogue', async () => {
      const res = await request(app)
        .get('/approved-template-catalogue')
        .set('Authorization', `Bearer ${adminShopAToken}`);

      expect(res.status).toBe(200);
      expect(res.body.total).toBe(expectedTemplateCount);
    });

    it('supports category and sendable filter parameters', async () => {
      const resSendable = await request(app)
        .get('/approved-template-catalogue?sendable=true')
        .set('Authorization', `Bearer ${ownerShopAToken}`);

      expect(resSendable.status).toBe(200);
      expect(resSendable.body.templates.length).toBe(expectedSendableCount);
      expect(resSendable.body.templates.every((t: { sendable: boolean }) => t.sendable)).toBe(true);

      const resUtility = await request(app)
        .get('/approved-template-catalogue?category=UTILITY')
        .set('Authorization', `Bearer ${ownerShopAToken}`);

      expect(resUtility.status).toBe(200);
      expect(resUtility.body.templates.length).toBe(expectedUtilityCount);
      expect(
        resUtility.body.templates.every((t: { category: string }) => t.category === 'UTILITY')
      ).toBe(true);
    });

    it('forbids staff role with 403 Forbidden', async () => {
      const res = await request(app)
        .get('/approved-template-catalogue')
        .set('Authorization', `Bearer ${staffShopAToken}`);

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });

    it('rejects unauthenticated requests with 401 Unauthorized', async () => {
      const res = await request(app).get('/approved-template-catalogue');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
    });
  });

  describe('GET /integration/readiness', () => {
    it('returns ready: true with all checks passed when environment and connection are properly configured', async () => {
      const res = await request(app)
        .get('/integration/readiness')
        .set('Authorization', `Bearer ${ownerShopAToken}`);

      expect(res.status).toBe(200);
      expect(res.body.ready).toBe(true);
      expect(res.body.tenantId).toBe('shop_a');
      expect(res.body.failures).toEqual([]);
      expect(res.body.sendableTemplatesCount).toBe(expectedSendableCount);
      expect(res.body.totalTemplatesCount).toBe(expectedTemplateCount);

      // Verify required settings notice exact wording
      expect(res.body.notice).toBe(
        'This module runs auto campaigns using an existing WhatsApp connection and approved templates. WhatsApp setup and template approval are managed by the integration developer.'
      );

      // Checks structure
      expect(res.body.checks.connectionExists.passed).toBe(true);
      expect(res.body.checks.tokenPresent.passed).toBe(true);
      expect(res.body.checks.allowlistConfigured.passed).toBe(true);
      expect(res.body.checks.hasSendableTemplate.passed).toBe(true);
    });

    it('NEVER exposes secrets or token strings in API responses (Hard Rule)', async () => {
      const res = await request(app)
        .get('/integration/readiness')
        .set('Authorization', `Bearer ${ownerShopAToken}`);

      expect(res.status).toBe(200);

      const rawResponseBody = JSON.stringify(res.body);

      // Ensure actual token value never leaks
      expect(rawResponseBody).not.toContain('EAAG_valid_meta_test_access_token_mock_secret');
      if (process.env.SESSION_SECRET) {
        expect(rawResponseBody).not.toContain(process.env.SESSION_SECRET);
      }
      if (process.env.ENCRYPTION_KEY) {
        expect(rawResponseBody).not.toContain(process.env.ENCRYPTION_KEY);
      }

      // Only the environment variable reference NAME may be present
      expect(res.body.connection.secretRef).toBe('META_ACCESS_TOKEN');
      expect(res.body.checks.tokenPresent.secretRef).toBe('META_ACCESS_TOKEN');
    });

    it('tenant scope: returns ready: false with CONNECTION_NOT_FOUND when boutique has no connection record (shop_b)', async () => {
      const res = await request(app)
        .get('/integration/readiness')
        .set('Authorization', `Bearer ${ownerShopBToken}`);

      expect(res.status).toBe(200);
      expect(res.body.ready).toBe(false);
      expect(res.body.tenantId).toBe('shop_b');
      expect(res.body.connection).toBeNull();

      const connectionFailure = res.body.failures.find(
        (f: { code: string }) => f.code === 'CONNECTION_NOT_FOUND'
      );
      expect(connectionFailure).toBeDefined();
      expect(connectionFailure.fixOwner).toBe('INTEGRATION_DEVELOPER');
    });

    it('returns ready: false with TOKEN_ENV_MISSING when token env var is unset or placeholder', async () => {
      // Test 1: Unset
      delete process.env.META_ACCESS_TOKEN;

      const resUnset = await request(app)
        .get('/integration/readiness')
        .set('Authorization', `Bearer ${ownerShopAToken}`);

      expect(resUnset.status).toBe(200);
      expect(resUnset.body.ready).toBe(false);
      expect(resUnset.body.checks.tokenPresent.passed).toBe(false);

      const unsetFailure = resUnset.body.failures.find(
        (f: { code: string }) => f.code === 'TOKEN_ENV_MISSING'
      );
      expect(unsetFailure).toBeDefined();
      expect(unsetFailure.fixOwner).toBe('INTEGRATION_DEVELOPER');

      // Test 2: Placeholder '<your token>'
      process.env.META_ACCESS_TOKEN = '<your token>';

      const resPlaceholder = await request(app)
        .get('/integration/readiness')
        .set('Authorization', `Bearer ${ownerShopAToken}`);

      expect(resPlaceholder.body.ready).toBe(false);
      expect(resPlaceholder.body.checks.tokenPresent.passed).toBe(false);
      const placeholderFailure = resPlaceholder.body.failures.find(
        (f: { code: string }) => f.code === 'TOKEN_ENV_MISSING'
      );
      expect(placeholderFailure).toBeDefined();
    });

    it('returns ready: false with ALLOWLIST_NOT_CONFIGURED when allowlist is empty or placeholder', async () => {
      process.env.META_ACCESS_TOKEN = 'EAAG_valid_token';
      process.env.META_TEST_ALLOWLIST = '<your verified numbers, digits only, comma separated>';

      const res = await request(app)
        .get('/integration/readiness')
        .set('Authorization', `Bearer ${ownerShopAToken}`);

      expect(res.status).toBe(200);
      expect(res.body.ready).toBe(false);
      expect(res.body.checks.allowlistConfigured.passed).toBe(false);

      const failure = res.body.failures.find(
        (f: { code: string }) => f.code === 'ALLOWLIST_NOT_CONFIGURED'
      );
      expect(failure).toBeDefined();
      expect(failure.fixOwner).toBe('INTEGRATION_DEVELOPER');
    });

    it('forbids staff from checking readiness with 403 Forbidden', async () => {
      const res = await request(app)
        .get('/integration/readiness')
        .set('Authorization', `Bearer ${staffShopAToken}`);

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });
  });
});

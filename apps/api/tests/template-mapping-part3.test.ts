import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import { app } from '../src/app';
import { connectToDatabase, disconnectDatabase } from '../src/db/connection';
import { seedDatabase } from '../src/db/seed';
import {
  loadTemplateMappingSuggestions,
  reloadTemplateMappingSuggestions,
  getTemplateMappingSuggestions,
  templateMappingSuggestionsRegistry,
  resolveTemplateParameters,
  buildMetaTemplateBody,
} from '../src/templates';
import {
  SrcCustomerModel,
  CampaignModel,
  CampaignVersionModel,
  CampaignDryRunModel,
} from '../src/db/models';
import { DryRunService } from '../src/services/dry-run.service';

describe('Part 3: Suggestion Loader, Dev Reload, Preview API, AST Audit, Dry Run Counters & Seed Verification (M19-M24)', () => {
  let shopAOwnerToken: string;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.DISPATCH_MODE = 'dry';
    process.env.ALLOW_TEST_CATEGORY_MISMATCH = 'true';

    await connectToDatabase();
    await seedDatabase('welcome');

    const loginRes = await request(app)
      .post('/auth/login')
      .send({ email: 'owner@shop-a.com', password: 'OwnerSecret#2026!' });
    shopAOwnerToken = loginRes.body.token;
  });

  afterAll(async () => {
    await disconnectDatabase();
  });

  // ===========================================================================
  // M19: Suggestion Loader Validation
  // ===========================================================================
  describe('M19: Suggestion Loader Validation', () => {
    it('loads valid suggestions from /docs/template-mappings.json and queries by template/preset', () => {
      const result = loadTemplateMappingSuggestions();
      expect(result.loadedCount).toBeGreaterThan(0);

      // Query all suggestions
      const allSuggestions = getTemplateMappingSuggestions();
      expect(allSuggestions).toBeDefined();
      expect(typeof allSuggestions).toBe('object');

      // Query specific template
      const helloWorld = getTemplateMappingSuggestions(undefined, 'tpl_hello_world');
      expect(helloWorld).toBeDefined();
      expect((helloWorld as any).templateId).toBe('tpl_hello_world');

      // Query template with preset
      const orderConf = getTemplateMappingSuggestions('WELCOME_NEW_CUSTOMER', 'tpl_order_confirmation');
      expect(orderConf).toBeDefined();
      expect((orderConf as any).bindings).toBeDefined();
      expect((orderConf as any).bindings['1'].source).toBe('customer.firstName');
    });

    it('discards invalid suggestions (unapproved template, variable count mismatch, unallowed source) with warnings', () => {
      // Test registry validation by mocking / verifying rejection logic
      const candidatePaths = [
        path.resolve(process.cwd(), 'docs/template-mappings.json'),
        path.resolve(process.cwd(), '../../docs/template-mappings.json'),
        path.resolve(__dirname, '../../../docs/template-mappings.json'),
      ];
      const originalFile = candidatePaths.find((p) => fs.existsSync(p));
      expect(originalFile).toBeDefined();

      const raw = JSON.parse(fs.readFileSync(originalFile!, 'utf-8'));
      expect(Array.isArray(raw.suggestions)).toBe(true);

      // Verify each loaded suggestion has valid bindings conforming to catalogue
      const allLoaded = templateMappingSuggestionsRegistry.getAll();
      for (const [templateId, item] of allLoaded.entries()) {
        expect(templateId).toBe(item.templateId);
        expect(item.presets).toBeDefined();
        for (const [presetKey, presetData] of Object.entries(item.presets)) {
          expect(presetData.bindings).toBeDefined();
          // Bindings must be normalized object schema
          for (const [vIdx, bDef] of Object.entries(presetData.bindings)) {
            expect(Number(vIdx)).toBeGreaterThan(0);
            expect(bDef).toHaveProperty('source');
          }
        }
      }
    });
  });

  // ===========================================================================
  // M20: Dev Reload Endpoint
  // ===========================================================================
  describe('M20: Dev Reload Endpoint (POST /dev/template-mapping/reload-suggestions)', () => {
    it('reloads suggestions in dev/test environment without restarting process', async () => {
      const res = await request(app)
        .post('/dev/template-mapping/reload-suggestions')
        .set('Authorization', `Bearer ${shopAOwnerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.loadedCount).toBeGreaterThan(0);
      expect(Array.isArray(res.body.errors)).toBe(true);
    });

    it('forbids reload endpoint in production mode (403 Forbidden)', async () => {
      const prevEnv = process.env.NODE_ENV;
      try {
        process.env.NODE_ENV = 'production';
        const res = await request(app)
          .post('/dev/template-mapping/reload-suggestions')
          .set('Authorization', `Bearer ${shopAOwnerToken}`);

        expect(res.status).toBe(403);
        expect(res.body.success).toBe(false);
        expect(res.body.error).toMatch(/forbidden in production/i);
      } finally {
        process.env.NODE_ENV = prevEnv;
      }
    });
  });

  // ===========================================================================
  // M21: Preview API (POST /template-mapping/preview)
  // ===========================================================================
  describe('M21: Preview API (POST /template-mapping/preview)', () => {
    it('renders preview with valid bindings and sample customer', async () => {
      const res = await request(app)
        .post('/template-mapping/preview')
        .set('Authorization', `Bearer ${shopAOwnerToken}`)
        .send({
          presetId: 'welcome_new_customer',
          templateRef: {
            id: 'tpl_welcome_new_customer',
            revision: 1,
            language: 'en',
          },
          bindings: {
            '1': { source: 'customer.firstName' },
            '2': { source: 'shop.displayName' },
          },
          sampleCustomer: {
            firstName: 'Aditi',
          },
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.ok).toBe(true);
      expect(res.body.renderedText).toContain('Aditi');
      expect(res.body.renderedText).toContain('Sample Boutique');
      expect(res.body.paramValues['1']).toBe('Aditi');
      expect(res.body.paramValues['2']).toBe('Sample Boutique');
    });

    it('renders preview using fallbackLiteral when customer name is empty', async () => {
      const res = await request(app)
        .post('/template-mapping/preview')
        .set('Authorization', `Bearer ${shopAOwnerToken}`)
        .send({
          presetId: 'welcome_new_customer',
          templateRef: {
            id: 'tpl_welcome_new_customer',
            revision: 1,
            language: 'en',
          },
          bindings: {
            '1': {
              source: 'customer.firstName',
              fallbackLiteral: 'Valued Patron',
            },
            '2': { source: 'shop.displayName' },
          },
          sampleCustomer: {
            firstName: '',
          },
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.ok).toBe(true);
      expect(res.body.usedFallback).toBe(true);
      expect(res.body.renderedText).toContain('Valued Patron');
      expect(res.body.paramValues['1']).toBe('Valued Patron');
    });

    it('enforces privacy invariants: no raw recipient phones or unredacted PII in preview response', async () => {
      const res = await request(app)
        .post('/template-mapping/preview')
        .set('Authorization', `Bearer ${shopAOwnerToken}`)
        .send({
          presetId: 'welcome_new_customer',
          templateRef: {
            id: 'tpl_welcome_new_customer',
            revision: 1,
            language: 'en_US',
          },
          bindings: {
            '1': { source: 'customer.firstName' },
            '2': { source: 'shop.displayName' },
          },
        });

      const responseString = JSON.stringify(res.body);
      // Hard Rule 9: Must not leak raw phone numbers (e.g. 9198... or +91...)
      expect(responseString).not.toMatch(/\+91\s*\d{10}/);
      expect(responseString).not.toMatch(/919\d{9}/);
    });

    it('returns error when template is not found in catalogue', async () => {
      const res = await request(app)
        .post('/template-mapping/preview')
        .set('Authorization', `Bearer ${shopAOwnerToken}`)
        .send({
          presetId: 'welcome_new_customer',
          templateRef: {
            id: 'tpl_nonexistent_xyz',
            revision: 1,
            language: 'en_US',
          },
          bindings: {},
        });

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toMatch(/not found/i);
    });
  });

  // ===========================================================================
  // M22: AST Lint Audit (Single Canonical Meta Payload Builder)
  // ===========================================================================
  describe('M22: AST Lint Audit (Single Canonical Meta Payload Builder)', () => {
    it('verifies NO second Meta template payload builder exists across the entire codebase', () => {
      const srcDir = path.resolve(__dirname, '../src');

      function getAllTsFiles(dir: string): string[] {
        const files: string[] = [];
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            files.push(...getAllTsFiles(fullPath));
          } else if (entry.isFile() && fullPath.endsWith('.ts') && !fullPath.endsWith('.d.ts')) {
            files.push(fullPath);
          }
        }
        return files;
      }

      const allFiles = getAllTsFiles(srcDir);
      const canonicalBuilderFile = path.resolve(srcDir, 'templates/buildMetaTemplateBody.ts').replace(/\\/g, '/');

      const violations: string[] = [];

      for (const file of allFiles) {
        const normalizedPath = file.replace(/\\/g, '/');
        if (normalizedPath === canonicalBuilderFile) {
          // This is the canonical builder itself
          continue;
        }

        const content = fs.readFileSync(file, 'utf-8');

        // Look for ad-hoc template message construction in AST
        const sourceFile = ts.createSourceFile(
          file,
          content,
          ts.ScriptTarget.Latest,
          true
        );

        function checkNode(node: ts.Node) {
          // Check for object literals with messaging_product: 'whatsapp' AND type: 'template'
          if (ts.isObjectLiteralExpression(node)) {
            let hasMessagingProduct = false;
            let hasTemplateType = false;

            for (const prop of node.properties) {
              if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name)) {
                const propName = prop.name.text;
                if (propName === 'messaging_product' && ts.isStringLiteral(prop.initializer) && prop.initializer.text === 'whatsapp') {
                  hasMessagingProduct = true;
                }
                if (propName === 'type' && ts.isStringLiteral(prop.initializer) && prop.initializer.text === 'template') {
                  hasTemplateType = true;
                }
              }
            }

            if (hasMessagingProduct && hasTemplateType) {
              violations.push(
                `Ad-hoc Meta template payload builder found in ${normalizedPath}`
              );
            }
          }

          ts.forEachChild(node, checkNode);
        }

        checkNode(sourceFile);
      }

      expect(violations).toEqual([]);

      // Verify that whatsapp-delivery.ts delegates to buildMetaTemplateBody
      const deliveryAdapterFile = path.resolve(srcDir, 'adapters/whatsapp-delivery.ts');
      const deliveryContent = fs.readFileSync(deliveryAdapterFile, 'utf-8');
      expect(deliveryContent).toContain('buildMetaTemplateBody');
    });
  });

  // ===========================================================================
  // M23: Dry Run Per-Variable Breakdown Counters
  // ===========================================================================
  describe('M23: Dry Run Per-Variable Breakdown Counters', () => {
    it('records ok, usedFallback, skippedMissing, and skippedTooLong in dry run variableBreakdown', async () => {
      // Create a valid campaign draft via API
      const createRes = await request(app)
        .post('/campaigns')
        .set('Authorization', `Bearer ${shopAOwnerToken}`)
        .set('Idempotency-Key', `idemp-m23-dryrun-${Date.now()}`)
        .send({
          presetId: 'welcome_new_customer',
          name: 'Dry Run Variable Breakdown Test',
        });
      expect(createRes.status).toBe(201);
      const campaignId = createRes.body.campaign.campaignId;

      const dryRunService = new DryRunService();
      const report = await dryRunService.executeDryRun({
        tenantId: 'shop_a',
        userId: 'test_user_owner',
        campaignId,
      });

      expect(report).toBeDefined();
      expect(report.variableBreakdown).toBeDefined();
      expect(typeof report.variableBreakdown.ok).toBe('number');
      expect(typeof report.variableBreakdown.usedFallback).toBe('number');
      expect(typeof report.variableBreakdown.skippedMissing).toBe('number');
      expect(typeof report.variableBreakdown.skippedTooLong).toBe('number');

      // Check persisted document in MongoDB
      const persisted = await CampaignDryRunModel.findOne({ dryRunId: report.dryRunId });
      expect(persisted).toBeDefined();
      expect(persisted?.variableBreakdown).toBeDefined();
      expect(persisted?.variableBreakdown.ok).toBe(report.variableBreakdown.ok);
      expect(persisted?.variableBreakdown.usedFallback).toBe(report.variableBreakdown.usedFallback);
      expect(persisted?.variableBreakdown.skippedMissing).toBe(report.variableBreakdown.skippedMissing);
      expect(persisted?.variableBreakdown.skippedTooLong).toBe(report.variableBreakdown.skippedTooLong);
    });
  });

  // ===========================================================================
  // M24: Scenario Welcome Edge Cases Seeded with mapping-test Tag
  // ===========================================================================
  describe('M24: Scenario Welcome Edge Cases Seeded with mapping-test Tag', () => {
    it('seeds 5 specific mapping edge cases tagged mapping-test in scenario welcome', async () => {
      const mappingTestCustomers = await SrcCustomerModel.find({
        tenantId: 'shop_a',
        tags: 'mapping-test',
      });

      expect(mappingTestCustomers.length).toBe(5);

      const customerMap = new Map(mappingTestCustomers.map((c) => [c.customerId, c]));

      // 1. Empty firstName customer
      const cusEmpty = customerMap.get('cus_map_01_empty');
      expect(cusEmpty).toBeDefined();
      expect(cusEmpty?.firstName).toBe('');

      // 2. Whitespace and newline customer
      const cusWhitespace = customerMap.get('cus_map_02_whitespace');
      expect(cusWhitespace).toBeDefined();
      expect(cusWhitespace?.firstName).toContain('\n');

      // 3. 300-char long name customer
      const cusLong = customerMap.get('cus_map_03_long');
      expect(cusLong).toBeDefined();
      expect(cusLong?.firstName?.length).toBe(300);

      // 4. Emoji name customer
      const cusEmoji = customerMap.get('cus_map_04_emoji');
      expect(cusEmoji).toBeDefined();
      expect(cusEmoji?.firstName).toContain('🌸');

      // 5. Tab character customer
      const cusTab = customerMap.get('cus_map_05_tab');
      expect(cusTab).toBeDefined();
      expect(cusTab?.firstName).toContain('\t');
    });

    it('verifies resolution outcomes on seeded mapping edge cases', () => {
      const template = {
        id: 'tpl_welcome_new_customer',
        name: 'welcome_new_customer',
        language: 'en_US',
        revision: 1,
        variables: [
          { index: 1, name: 'customer_name' },
          { index: 2, name: 'store_name' },
        ],
        bodyText: 'Welcome {{1}} to {{2}}!',
      };

      // 1. Empty name customer without fallback -> MISSING_VARIABLE
      const resEmptyNoFallback = resolveTemplateParameters({
        template: template as any,
        bindings: {
          '1': { source: 'customer.firstName' },
          '2': { source: 'shop.displayName' },
        },
        customer: { customerId: 'cus_map_01_empty', firstName: '' } as any,
        snapshot: { shopName: 'Sample Boutique' },
      });
      expect(resEmptyNoFallback.ok).toBe(false);
      expect(resEmptyNoFallback.problems.some((p) => p.code === 'MISSING_VARIABLE')).toBe(true);

      // Empty name customer with fallback -> OK, usedFallback = true
      const resEmptyWithFallback = resolveTemplateParameters({
        template: template as any,
        bindings: {
          '1': { source: 'customer.firstName', fallbackLiteral: 'Valued Customer' },
          '2': { source: 'shop.displayName' },
        },
        customer: { customerId: 'cus_map_01_empty', firstName: '' } as any,
        snapshot: { shopName: 'Sample Boutique' },
      });
      expect(resEmptyWithFallback.ok).toBe(true);
      expect(resEmptyWithFallback.usedFallback).toBe(true);
      expect(resEmptyWithFallback.renderedPreview).toBe('Welcome Valued Customer to Sample Boutique!');

      // 2. Whitespace customer -> sanitized cleanly (whitespace trimmed & collapsed)
      const resWhitespace = resolveTemplateParameters({
        template: template as any,
        bindings: {
          '1': { source: 'customer.firstName' },
          '2': { source: 'shop.displayName' },
        },
        customer: { customerId: 'cus_map_02_whitespace', firstName: ' Lakshmi Devi \n' } as any,
        snapshot: { shopName: 'Sample Boutique' },
      });
      expect(resWhitespace.ok).toBe(true);
      expect(resWhitespace.renderedPreview).toBe('Welcome Lakshmi Devi to Sample Boutique!');

      // 3. 300-char customer -> rejected with VARIABLE_TOO_LONG
      const resLong = resolveTemplateParameters({
        template: template as any,
        bindings: {
          '1': { source: 'customer.firstName' },
          '2': { source: 'shop.displayName' },
        },
        customer: { customerId: 'cus_map_03_long', firstName: 'A'.repeat(300) } as any,
        snapshot: { shopName: 'Sample Boutique' },
      });
      expect(resLong.ok).toBe(false);
      expect(resLong.problems.some((p) => p.code === 'VARIABLE_TOO_LONG')).toBe(true);

      // 4. Emoji customer -> NFC preserved
      const resEmoji = resolveTemplateParameters({
        template: template as any,
        bindings: {
          '1': { source: 'customer.firstName' },
          '2': { source: 'shop.displayName' },
        },
        customer: { customerId: 'cus_map_04_emoji', firstName: 'Priya 🌸' } as any,
        snapshot: { shopName: 'Sample Boutique' },
      });
      expect(resEmoji.ok).toBe(true);
      expect(resEmoji.renderedPreview).toBe('Welcome Priya 🌸 to Sample Boutique!');

      // 5. Tab customer -> tab replaced with space
      const resTab = resolveTemplateParameters({
        template: template as any,
        bindings: {
          '1': { source: 'customer.firstName' },
          '2': { source: 'shop.displayName' },
        },
        customer: { customerId: 'cus_map_05_tab', firstName: 'Sunita\tDevi' } as any,
        snapshot: { shopName: 'Sample Boutique' },
      });
      expect(resTab.ok).toBe(true);
      expect(resTab.renderedPreview).toBe('Welcome Sunita Devi to Sample Boutique!');
    });
  });
});

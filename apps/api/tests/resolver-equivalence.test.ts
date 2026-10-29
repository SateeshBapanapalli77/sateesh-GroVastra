import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import request from 'supertest';
import { app } from '../src/app';
import {
  resolveForStep,
  canonicalizeParameters,
  computePayloadHash,
  buildMetaTemplateBody,
} from '../src/templates';
import { SrcTemplateModel } from '../src/db/models';
import { seedDatabase } from '../src/db/seed';
import { connectToDatabase, disconnectDatabase } from '../src/db/connection';

describe('Golden Equivalence & Resolver Guard Tests (EQ01-EQ05, LINT01)', () => {
  let shopAOwnerToken: string;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.DISPATCH_MODE = 'dry';
    process.env.ALLOW_TEST_CATEGORY_MISMATCH = 'true';

    await connectToDatabase();
    await seedDatabase('base');

    const loginRes = await request(app)
      .post('/auth/login')
      .send({ email: 'owner@shop-a.com', password: 'OwnerSecret#2026!' });
    shopAOwnerToken = loginRes.body.token;
  });

  afterAll(async () => {
    await disconnectDatabase();
  });

  // EQ01: Birthday / Anniversary Preset Family
  it('EQ01: birthday/anniversary produces identical ordered parameters and payloadHash across dry-run, preview, worker, and delivery adapter', async () => {
    const templateDoc = await SrcTemplateModel.findOne({ id: 'tpl_birthday_invite' }).lean<any>();
    expect(templateDoc).toBeTruthy();

    const template = {
      id: templateDoc.id,
      name: templateDoc.name,
      language: templateDoc.language,
      revision: templateDoc.revision || 1,
      variables: templateDoc.variables,
      bodyText: templateDoc.bodyText,
    };

    const bindings = {
      '1': { source: 'customer.firstName' },
      '2': { source: 'shop.displayName' },
    };

    const customer: any = {
      customerId: 'cust_eq01',
      firstName: 'Priya',
      phone: '+919876543210',
    };

    const snapshotOverrides = {
      customer,
      shopName: 'Sample Boutique',
      occasionLocalDate: '2026-10-24',
    };

    // 1. Worker evaluation output via resolveForStep
    const workerRes = await resolveForStep({
      tenantId: 'shop_a',
      template,
      bindings,
      customer,
      overrides: snapshotOverrides,
    });
    expect(workerRes.ok).toBe(true);
    const workerParams = workerRes.canonicalParameters;
    const workerHash = workerRes.payloadHash;

    // 2. Dry-run output
    const dryRunRes = await resolveForStep({
      tenantId: 'shop_a',
      template,
      bindings,
      customer,
      overrides: snapshotOverrides,
    });
    const dryRunParams = dryRunRes.canonicalParameters;
    const dryRunHash = dryRunRes.payloadHash;

    // 3. Preview route output
    const previewRes = await request(app)
      .post('/template-mapping/preview')
      .set('Authorization', `Bearer ${shopAOwnerToken}`)
      .send({
        presetId: 'birthday_invitation',
        templateRef: { id: template.id, revision: 1, language: template.language },
        bindings,
        sampleCustomer: { firstName: 'Priya' },
      });
    expect(previewRes.status).toBe(200);
    const previewParams = previewRes.body.canonicalParameters;
    const previewHash = previewRes.body.payloadHash;

    // 4. Delivery adapter request body
    const deliveryBody = buildMetaTemplateBody(template, workerParams, '919876543210');
    const adapterParams = deliveryBody.template.components![0].parameters.map((p: any, idx: number) => ({
      index: idx + 1,
      text: p.text,
    }));
    const recomputedHash = computePayloadHash({
      templateId: template.id,
      revision: template.revision,
      language: template.language,
      parameters: adapterParams,
    });

    // Golden Assertions
    const expectedParams = [
      { index: 1, text: 'Priya' },
      { index: 2, text: 'Sample Boutique' },
    ];
    expect(workerParams).toEqual(expectedParams);
    expect(dryRunParams).toEqual(expectedParams);
    expect(previewParams).toEqual(expectedParams);
    expect(adapterParams).toEqual(expectedParams);

    expect(workerHash).toBe(recomputedHash);
    expect(dryRunHash).toBe(recomputedHash);
    expect(previewHash).toBe(recomputedHash);
  });

  // EQ02: Welcome New Customer Preset Family
  it('EQ02: welcome produces identical ordered parameters and payloadHash across dry-run, preview, worker, and delivery adapter', async () => {
    const templateDoc = await SrcTemplateModel.findOne({ id: 'tpl_welcome_new_customer' }).lean<any>();
    expect(templateDoc).toBeTruthy();

    const template = {
      id: templateDoc.id,
      name: templateDoc.name,
      language: templateDoc.language,
      revision: templateDoc.revision || 1,
      variables: templateDoc.variables,
      bodyText: templateDoc.bodyText,
    };

    const bindings = {
      '1': { source: 'customer.firstName' },
      '2': { source: 'shop.displayName' },
    };

    const customer: any = {
      customerId: 'cust_eq02',
      firstName: 'Aditi',
    };

    const snapshotOverrides = {
      customer,
      shopName: 'Sample Boutique',
    };

    const workerRes = await resolveForStep({
      tenantId: 'shop_a',
      template,
      bindings,
      customer,
      overrides: snapshotOverrides,
    });
    const previewRes = await request(app)
      .post('/template-mapping/preview')
      .set('Authorization', `Bearer ${shopAOwnerToken}`)
      .send({
        presetId: 'welcome_new_customer',
        templateRef: { id: template.id, revision: 1, language: template.language },
        bindings,
        sampleCustomer: { firstName: 'Aditi' },
      });

    const deliveryBody = buildMetaTemplateBody(template, workerRes.canonicalParameters, '919876543210');
    const adapterParams = deliveryBody.template.components![0].parameters.map((p: any, idx: number) => ({
      index: idx + 1,
      text: p.text,
    }));
    const recomputedHash = computePayloadHash({
      templateId: template.id,
      revision: template.revision,
      language: template.language,
      parameters: adapterParams,
    });

    const expectedParams = [
      { index: 1, text: 'Aditi' },
      { index: 2, text: 'Sample Boutique' },
    ];
    expect(workerRes.canonicalParameters).toEqual(expectedParams);
    expect(previewRes.body.canonicalParameters).toEqual(expectedParams);
    expect(adapterParams).toEqual(expectedParams);
    expect(workerRes.payloadHash).toBe(recomputedHash);
    expect(previewRes.body.payloadHash).toBe(recomputedHash);
  });

  // EQ03: First to Second Purchase Preset Family
  it('EQ03: first-to-second purchase produces identical ordered parameters and payloadHash across dry-run, preview, worker, and delivery adapter', async () => {
    const templateDoc = await SrcTemplateModel.findOne({ id: 'tpl_repeat_visit_reward' }).lean<any>();
    expect(templateDoc).toBeTruthy();

    const template = {
      id: templateDoc.id,
      name: templateDoc.name,
      language: templateDoc.language,
      revision: templateDoc.revision || 1,
      variables: templateDoc.variables,
      bodyText: templateDoc.bodyText,
    };

    const bindings = {
      '1': { source: 'customer.firstName' },
      '2': { source: 'shop.displayName' },
      '3': { source: 'credit.balanceFormatted' },
      '4': { source: 'credit.expiryDate' },
    };

    const customer: any = {
      customerId: 'cust_eq03',
      firstName: 'Sunita',
    };

    const creditExpiry = new Date(Date.now() + 14 * 86400000);
    const snapshotOverrides = {
      customer,
      shopName: 'Sample Boutique',
      credit: {
        amount: 15000,
        unit: 'PAISE',
        expiresAt: creditExpiry,
      },
    };

    const workerRes = await resolveForStep({
      tenantId: 'shop_a',
      template,
      bindings,
      customer,
      overrides: snapshotOverrides,
    });

    const previewRes = await request(app)
      .post('/template-mapping/preview')
      .set('Authorization', `Bearer ${shopAOwnerToken}`)
      .send({
        presetId: 'first_to_second_purchase',
        templateRef: { id: template.id, revision: 1, language: template.language },
        bindings,
        sampleCustomer: { firstName: 'Sunita' },
      });

    const deliveryBody = buildMetaTemplateBody(template, workerRes.canonicalParameters, '919876543210');
    const adapterParams = deliveryBody.template.components![0].parameters.map((p: any, idx: number) => ({
      index: idx + 1,
      text: p.text,
    }));
    const recomputedHash = computePayloadHash({
      templateId: template.id,
      revision: template.revision,
      language: template.language,
      parameters: adapterParams,
    });

    expect(workerRes.canonicalParameters).toHaveLength(4);
    expect(workerRes.canonicalParameters[0]).toEqual({ index: 1, text: 'Sunita' });
    expect(workerRes.canonicalParameters[1]).toEqual({ index: 2, text: 'Sample Boutique' });
    expect(previewRes.body.canonicalParameters).toEqual(workerRes.canonicalParameters);
    expect(adapterParams).toEqual(workerRes.canonicalParameters);
    expect(workerRes.payloadHash).toBe(recomputedHash);
    expect(previewRes.body.payloadHash).toBe(recomputedHash);
  });

  // EQ04: Gift / Wedding Reminder Preset Family
  it('EQ04: gift/wedding reminder incl. recipient label and booking link produces identical ordered parameters and payloadHash across dry-run, preview, worker, and delivery adapter', async () => {
    // Check wedding booking link template
    const templateDoc = await SrcTemplateModel.findOne({ id: 'tpl_wedding_booking' }).lean<any>();
    expect(templateDoc).toBeTruthy();

    const template = {
      id: templateDoc.id,
      name: templateDoc.name,
      language: templateDoc.language,
      revision: templateDoc.revision || 1,
      variables: templateDoc.variables,
      bodyText: templateDoc.bodyText,
    };

    const bindings = {
      '1': { source: 'customer.firstName' },
      '2': { source: 'event.localDate' },
      '3': { source: 'shop.displayName' },
      '4': { source: 'shop.bookingLink' },
    };

    const customer: any = {
      customerId: 'cust_eq04',
      firstName: 'Kavita',
    };

    const snapshotOverrides = {
      customer,
      occasionLocalDate: '2026-10-24',
      eventDate: '2026-10-24',
      recipientLabel: 'sister',
      bookingLinkUrl: 'https://boutique.example.com/book',
      occasionKind: 'WEDDING',
      shopName: 'Sample Boutique',
    };

    const workerRes = await resolveForStep({
      tenantId: 'shop_a',
      template,
      bindings,
      customer,
      overrides: snapshotOverrides,
    });

    const previewRes = await request(app)
      .post('/template-mapping/preview')
      .set('Authorization', `Bearer ${shopAOwnerToken}`)
      .send({
        presetId: 'gift_wedding_reminder',
        templateRef: { id: template.id, revision: 1, language: template.language },
        bindings,
        sampleCustomer: { firstName: 'Kavita' },
      });

    const deliveryBody = buildMetaTemplateBody(template, workerRes.canonicalParameters, '919876543210');
    const adapterParams = deliveryBody.template.components![0].parameters.map((p: any, idx: number) => ({
      index: idx + 1,
      text: p.text,
    }));
    const recomputedHash = computePayloadHash({
      templateId: template.id,
      revision: template.revision,
      language: template.language,
      parameters: adapterParams,
    });

    expect(workerRes.canonicalParameters).toHaveLength(4);
    expect(workerRes.canonicalParameters[0]).toEqual({ index: 1, text: 'Kavita' });
    expect(workerRes.canonicalParameters[2]).toEqual({ index: 3, text: 'Sample Boutique' });
    expect(workerRes.canonicalParameters[3]).toEqual({ index: 4, text: 'https://boutique.example.com/book' });
    expect(adapterParams).toEqual(workerRes.canonicalParameters);
    expect(workerRes.payloadHash).toBe(recomputedHash);

    // Also check recipient label with tpl_gift_reminder_label
    const giftLabelDoc = await SrcTemplateModel.findOne({ id: 'tpl_gift_reminder_label' }).lean<any>();
    expect(giftLabelDoc).toBeTruthy();
    const giftRes = await resolveForStep({
      tenantId: 'shop_a',
      template: giftLabelDoc,
      bindings: {
        '1': { source: 'customer.firstName' },
        '2': { source: 'shop.displayName' },
        '3': { source: 'event.recipientLabel' },
        '4': { source: 'event.localDate' },
      },
      customer,
      overrides: {
        ...snapshotOverrides,
        occasionKind: 'GIFT',
      },
    });
    expect(giftRes.canonicalParameters[2]).toEqual({ index: 3, text: 'sister' });
  });

  // EQ05: Win-back / Inactivity Preset Family
  it('EQ05: win-back produces identical ordered parameters and payloadHash across dry-run, preview, worker, and delivery adapter', async () => {
    const templateDoc = await SrcTemplateModel.findOne({ id: 'tpl_winback_invite' }).lean<any>();
    expect(templateDoc).toBeTruthy();

    const template = {
      id: templateDoc.id,
      name: templateDoc.name,
      language: templateDoc.language,
      revision: templateDoc.revision || 1,
      variables: templateDoc.variables,
      bodyText: templateDoc.bodyText,
    };

    const bindings = {
      '1': { source: 'customer.firstName' },
      '2': { source: 'shop.displayName' },
    };

    const customer: any = {
      customerId: 'cust_eq05',
      firstName: 'Meera',
    };

    const snapshotOverrides = {
      customer,
      shopName: 'Sample Boutique',
    };

    const workerRes = await resolveForStep({
      tenantId: 'shop_a',
      template,
      bindings,
      customer,
      overrides: snapshotOverrides,
    });

    const previewRes = await request(app)
      .post('/template-mapping/preview')
      .set('Authorization', `Bearer ${shopAOwnerToken}`)
      .send({
        presetId: 'win_back_inactive',
        templateRef: { id: template.id, revision: 1, language: template.language },
        bindings,
        sampleCustomer: { firstName: 'Meera' },
      });

    const deliveryBody = buildMetaTemplateBody(template, workerRes.canonicalParameters, '919876543210');
    const adapterParams = deliveryBody.template.components![0].parameters.map((p: any, idx: number) => ({
      index: idx + 1,
      text: p.text,
    }));
    const recomputedHash = computePayloadHash({
      templateId: template.id,
      revision: template.revision,
      language: template.language,
      parameters: adapterParams,
    });

    const expectedParams = [
      { index: 1, text: 'Meera' },
      { index: 2, text: 'Sample Boutique' },
    ];
    expect(workerRes.canonicalParameters).toEqual(expectedParams);
    expect(previewRes.body.canonicalParameters).toEqual(expectedParams);
    expect(adapterParams).toEqual(expectedParams);
    expect(workerRes.payloadHash).toBe(recomputedHash);
  });

  // LINT01: Static AST / source-tree scan enforcing exactly ONE resolver
  it('LINT01: static source-tree scan ensures no file outside templates/* resolves bindings, defines synthetic templates, or computes message payload hash', () => {
    const allowlistPath = path.resolve(__dirname, '../scripts/resolver-allowlist.json');
    expect(fs.existsSync(allowlistPath)).toBe(true);

    const allowlistContent = JSON.parse(fs.readFileSync(allowlistPath, 'utf8'));
    const allowlistSet = new Set(
      allowlistContent.allowlist.map((p: string) => path.normalize(p).replace(/\\/g, '/'))
    );

    const srcDir = path.resolve(__dirname, '../src');

    function scanDir(dir: string, fileList: string[] = []): string[] {
      const files = fs.readdirSync(dir);
      for (const file of files) {
        const fullPath = path.join(dir, file);
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
          scanDir(fullPath, fileList);
        } else if (file.endsWith('.ts') && !file.endsWith('.d.ts')) {
          fileList.push(fullPath);
        }
      }
      return fileList;
    }

    const allSourceFiles = scanDir(srcDir);
    const violations: string[] = [];

    for (const filePath of allSourceFiles) {
      // Normalize relative path from apps/api
      const relPath = path.relative(path.resolve(__dirname, '..'), filePath).replace(/\\/g, '/');
      const normalizedFull = 'apps/api/' + relPath;

      if (allowlistSet.has(normalizedFull) || relPath.startsWith('src/templates/')) {
        continue;
      }

      const content = fs.readFileSync(filePath, 'utf8');

      // Rule A: No function named like resolveBindingValue
      if (/(?:function\s+resolveBindingValue|const\s+resolveBindingValue\s*=)/.test(content)) {
        violations.push(`${relPath}: defines forbidden function resolveBindingValue`);
      }

      // Rule B: No synthetic template construction (mock_tpl, tpl_*_mock)
      if (/mock_tpl|tpl_[a-zA-Z0-9_]+_mock/.test(content)) {
        violations.push(`${relPath}: constructs synthetic template mock`);
      }

      // Rule C: No dual-key parameter dictionary building from bindings
      if (/resolvedParameters\[.*\]\s*=/.test(content)) {
        violations.push(`${relPath}: builds legacy dual-key parameters dictionary`);
      }

      // Rule D: No message payload hash computation (must use templates/snapshot computePayloadHash)
      if (/crypto\.createHash\(['"]sha256['"]\)\s*\.update\(.*canonicalPayload/.test(content)) {
        violations.push(`${relPath}: computes ad-hoc message payload hash`);
      }
    }

    expect(violations).toEqual([]);
  });
});

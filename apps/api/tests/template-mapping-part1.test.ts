import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  BINDING_SOURCES,
  isSourceAllowedForPreset,
  normalizeBindings,
  validateTemplateMapping,
  buildMetaTemplateBody,
  validateLiteralInput,
} from '../src/templates';
import { CampaignVersionModel } from '../src/db/models/campaign-version.model';
import { connectToDatabase, disconnectDatabase } from '../src/db/connection';

describe('Part 1: Shared Template Mapping, Validation & Resolver (M01-M08)', () => {
  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.DISPATCH_MODE = 'dry';
    await connectToDatabase();
  });

  afterAll(async () => {
    await disconnectDatabase();
  });

  // ===========================================================================
  // M01: Binding normalization legacy -> normalized equals; published version bytes unchanged
  // ===========================================================================
  it('M01: normalizes legacy string and object forms to v2 schema without mutating published version bytes', async () => {
    const legacyBindings = {
      '1': 'customer.firstName',
      '2': 'literal:Winter Collection',
      '3': { source: 'offer.amountRupees' },
    };

    const normalized = normalizeBindings(legacyBindings);

    expect(normalized).toEqual({
      '1': { source: 'customer.firstName' },
      '2': { source: 'literal', value: 'Winter Collection' },
      '3': { source: 'offer.amountRupees' },
    });

    // Also handles named keys when template is provided
    const template: any = {
      id: 'tpl_named',
      name: 'named_template',
      language: 'en',
      variables: [
        { index: 1, name: 'customer_name' },
        { index: 2, name: 'store_name' },
      ],
    };

    const namedBindings = {
      customer_name: 'customer.firstName',
      store_name: 'shop.displayName',
    };

    const normalizedNamed = normalizeBindings(namedBindings, template);
    expect(normalizedNamed).toEqual({
      '1': { source: 'customer.firstName' },
      '2': { source: 'shop.displayName' },
    });

    // Immutability check: published version document is never rewritten
    const rawVersionData = {
      tenantId: 'shop_a',
      campaignId: 'cmp_m01_immutability',
      version: 1,
      name: 'Immutable Version Check',
      industry: 'BOUTIQUE',
      purpose: 'MARKETING',
      timezone: 'Asia/Kolkata',
      trigger: { type: 'ANNUAL_DATE', field: 'customer.birthday', leapDayPolicy: 'FEB_28' },
      audience: { mode: 'ALL_ELIGIBLE' },
      goal: { type: 'OCCASION_TAGGED_OR_STAFF_COMPLETED' },
      priority: 80,
      resumePolicy: 'FUTURE_ONLY',
      importPolicy: 'FUTURE_ONLY',
      enabledBranches: ['branch_main'],
      isPublished: true,
      steps: [
        {
          stepId: 'step_1',
          offsetDays: 0,
          localTime: '10:00',
          maxLatenessMinutes: 120,
          templateRef: { id: 'tpl_birthday_invite', revision: 1, language: 'en' },
          bindings: legacyBindings,
          stopOnReply: true,
          stopOnGoal: true,
        },
      ],
    };

    await CampaignVersionModel.deleteMany({ campaignId: 'cmp_m01_immutability' });
    const created = await CampaignVersionModel.create(rawVersionData);

    const reloaded: any = await CampaignVersionModel.findById(created._id).lean();
    // Published version retains exact legacy bindings as stored
    expect(reloaded.steps[0].bindings).toEqual(legacyBindings);

    // Normalizing in memory produces normalized form without database write
    const inMemoryNormalized = normalizeBindings(reloaded.steps[0].bindings);
    expect(inMemoryNormalized['2']).toEqual({ source: 'literal', value: 'Winter Collection' });
  });

  // ===========================================================================
  // M02: Source / Preset allowlist matrix
  // ===========================================================================
  it('M02: enforces source x preset allowlist matrix correctly', () => {
    // customer.firstName, shop.displayName, literal are allowed for ALL presets
    expect(isSourceAllowedForPreset('customer.firstName', 'birthday')).toBe(true);
    expect(isSourceAllowedForPreset('customer.firstName', 'welcome_new_customer')).toBe(true);
    expect(isSourceAllowedForPreset('shop.displayName', 'first_to_second_purchase')).toBe(true);
    expect(isSourceAllowedForPreset('literal', 'win_back')).toBe(true);

    // occasion.localDate is allowed for birthday and anniversary, but NOT welcome
    expect(isSourceAllowedForPreset('occasion.localDate', 'birthday')).toBe(true);
    expect(isSourceAllowedForPreset('occasion.localDate', 'anniversary')).toBe(true);
    expect(isSourceAllowedForPreset('occasion.localDate', 'welcome_new_customer')).toBe(false);

    // order.* is allowed for first_to_second_purchase
    expect(isSourceAllowedForPreset('order.firstOrderNumber', 'first_to_second_purchase')).toBe(true);
    expect(isSourceAllowedForPreset('order.firstOrderDate', 'first_to_second_purchase')).toBe(true);
    expect(isSourceAllowedForPreset('order.firstOrderNumber', 'birthday')).toBe(false);

    // credit.* is allowed for first_to_second_purchase and rewards
    expect(isSourceAllowedForPreset('credit.balanceDisplay', 'first_to_second_purchase')).toBe(true);
    expect(isSourceAllowedForPreset('credit.expiryDate', 'first_to_second_purchase')).toBe(true);
    expect(isSourceAllowedForPreset('credit.daysToExpiry', 'first_to_second_purchase')).toBe(true);
    expect(isSourceAllowedForPreset('credit.balanceDisplay', 'birthday')).toBe(false);

    // Disallowed source validation returns BINDING_SOURCE_NOT_ALLOWED
    const template: any = {
      id: 'tpl_birthday_invite',
      revision: 1,
      language: 'en',
      variables: [
        { index: 1, name: 'name', type: 'text' },
        { index: 2, name: 'shop', type: 'text' },
      ],
    };

    const res = validateTemplateMapping({
      template,
      templateRef: { id: 'tpl_birthday_invite', revision: 1, language: 'en' },
      bindings: {
        '1': { source: 'credit.balanceDisplay' }, // Disallowed for birthday!
        '2': { source: 'shop.displayName' },
      },
      presetId: 'birthday',
    });

    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.code === 'BINDING_SOURCE_NOT_ALLOWED')).toBe(true);
  });

  // ===========================================================================
  // M03: Count / Index matrix (extra, missing, duplicate, gap, non-numeric, zero)
  // ===========================================================================
  it('M03: rejects invalid variable indices (missing, extra, gap, non-numeric, zero-variable with bindings)', () => {
    const twoVarTemplate: any = {
      id: 'tpl_two_var',
      revision: 1,
      language: 'en',
      variables: [
        { index: 1, name: 'v1' },
        { index: 2, name: 'v2' },
      ],
    };

    // Missing index 2
    const missingRes = validateTemplateMapping({
      template: twoVarTemplate,
      templateRef: { id: 'tpl_two_var', revision: 1, language: 'en' },
      bindings: { '1': { source: 'customer.firstName' } },
      presetId: 'birthday',
    });
    expect(missingRes.valid).toBe(false);
    expect(missingRes.errors.some((e) => e.code === 'BINDING_COUNT_MISMATCH')).toBe(true);

    // Gap in index (1 and 3 instead of 1 and 2)
    const gapRes = validateTemplateMapping({
      template: twoVarTemplate,
      templateRef: { id: 'tpl_two_var', revision: 1, language: 'en' },
      bindings: {
        '1': { source: 'customer.firstName' },
        '3': { source: 'shop.displayName' },
      },
      presetId: 'birthday',
    });
    expect(gapRes.valid).toBe(false);
    expect(gapRes.errors.some((e) => e.code === 'BINDING_INDEX_INVALID')).toBe(true);

    // Non-integer or non-positive index
    const invalidIndexRes = validateTemplateMapping({
      template: twoVarTemplate,
      templateRef: { id: 'tpl_two_var', revision: 1, language: 'en' },
      bindings: {
        '0': { source: 'customer.firstName' },
        '1': { source: 'shop.displayName' },
      },
      presetId: 'birthday',
    });
    expect(invalidIndexRes.valid).toBe(false);
    expect(invalidIndexRes.errors.some((e) => e.code === 'BINDING_INDEX_INVALID')).toBe(true);

    // Zero-variable template with non-empty bindings
    const zeroVarTemplate: any = {
      id: 'tpl_zero',
      revision: 1,
      language: 'en',
      variables: [],
    };
    const zeroRes = validateTemplateMapping({
      template: zeroVarTemplate,
      templateRef: { id: 'tpl_zero', revision: 1, language: 'en' },
      bindings: { '1': { source: 'customer.firstName' } },
      presetId: 'birthday',
    });
    expect(zeroRes.valid).toBe(false);
    expect(zeroRes.errors.some((e) => e.code === 'BINDING_COUNT_MISMATCH')).toBe(true);
  });

  // ===========================================================================
  // M04: Literal validation (empty, newline, tab, length bounds)
  // ===========================================================================
  it('M04: validates literal inputs: rejects empty, newline, tab, and excessive length while providing clean suggestions', () => {
    // Valid literal
    const valid = validateLiteralInput('Festive Offer 2026');
    expect(valid.valid).toBe(true);
    expect(valid.cleanedSuggestion).toBe('Festive Offer 2026');

    // Forbidden newline
    const withNewline = validateLiteralInput('Line 1\nLine 2');
    expect(withNewline.valid).toBe(false);
    expect(withNewline.error).toContain('newline or tab');
    expect(withNewline.cleanedSuggestion).toBe('Line 1 Line 2');

    // Forbidden tab
    const withTab = validateLiteralInput('Code\t123');
    expect(withTab.valid).toBe(false);
    expect(withTab.error).toContain('newline or tab');
    expect(withTab.cleanedSuggestion).toBe('Code 123');

    // Excessive length > 200
    const longString = 'A'.repeat(201);
    const tooLong = validateLiteralInput(longString);
    expect(tooLong.valid).toBe(false);
    expect(tooLong.error).toContain('maximum length');

    // ValidateMapping reports LITERAL_INVALID
    const template: any = {
      id: 'tpl_one',
      revision: 1,
      language: 'en',
      variables: [{ index: 1, name: 'v1' }],
    };
    const mappingRes = validateTemplateMapping({
      template,
      templateRef: { id: 'tpl_one', revision: 1, language: 'en' },
      bindings: {
        '1': { source: 'literal', value: 'Invalid\nValue' },
      },
      presetId: 'birthday',
    });
    expect(mappingRes.valid).toBe(false);
    expect(mappingRes.errors.some((e) => e.code === 'LITERAL_INVALID')).toBe(true);
  });

  // ===========================================================================
  // M05: Fallback allowed ONLY for customer.firstName
  // ===========================================================================
  it('M05: allows fallbackLiteral only for customer.firstName, forbids for dates/offers/credits', () => {
    const template: any = {
      id: 'tpl_three',
      revision: 1,
      language: 'en',
      variables: [
        { index: 1, name: 'name' },
        { index: 2, name: 'date' },
        { index: 3, name: 'amount' },
      ],
    };

    // Valid fallback on customer.firstName
    const validRes = validateTemplateMapping({
      template,
      templateRef: { id: 'tpl_three', revision: 1, language: 'en' },
      bindings: {
        '1': { source: 'customer.firstName', fallbackLiteral: 'Valued Customer' },
        '2': { source: 'order.firstOrderDate' },
        '3': { source: 'offer.amountRupees' },
      },
      offerRef: { offerId: 'off_001' },
      presetId: 'welcome_new_customer',
    });
    expect(validRes.valid).toBe(true);

    // Invalid fallback on date source (occasion.localDate doesn't allow fallback)
    const invalidDateFallback = validateTemplateMapping({
      template,
      templateRef: { id: 'tpl_three', revision: 1, language: 'en' },
      bindings: {
        '1': { source: 'customer.firstName' },
        '2': { source: 'occasion.localDate', fallbackLiteral: 'tomorrow' },
        '3': { source: 'literal', value: 'Hello' },
      },
      presetId: 'birthday',
    });
    expect(invalidDateFallback.valid).toBe(false);
    expect(invalidDateFallback.errors.some((e) => e.code === 'LITERAL_INVALID')).toBe(true);

    // Invalid fallback on offer source
    const invalidOfferFallback = validateTemplateMapping({
      template,
      templateRef: { id: 'tpl_three', revision: 1, language: 'en' },
      bindings: {
        '1': { source: 'customer.firstName' },
        '2': { source: 'shop.displayName' },
        '3': { source: 'offer.amountRupees', fallbackLiteral: '100' },
      },
      offerRef: { offerId: 'off_001' },
      presetId: 'welcome_new_customer',
    });
    expect(invalidOfferFallback.valid).toBe(false);
    expect(invalidOfferFallback.errors.some((e) => e.code === 'LITERAL_INVALID')).toBe(true);
  });

  // ===========================================================================
  // M06: offerRef and creditRef requirements
  // ===========================================================================
  it('M06: enforces offerRef and creditRef requirements when corresponding variables or bindings are used', () => {
    const offerTemplate: any = {
      id: 'tpl_offer',
      revision: 1,
      language: 'en',
      variables: [
        { index: 1, name: 'name' },
        { index: 2, name: 'offer_amount' },
      ],
    };

    // Missing offerRef
    const missingOfferRes = validateTemplateMapping({
      template: offerTemplate,
      templateRef: { id: 'tpl_offer', revision: 1, language: 'en' },
      bindings: {
        '1': { source: 'customer.firstName' },
        '2': { source: 'offer.amountRupees' },
      },
      presetId: 'first_to_second_purchase',
    });
    expect(missingOfferRes.valid).toBe(false);
    expect(missingOfferRes.errors.some((e) => e.code === 'OFFER_REF_REQUIRED')).toBe(true);

    // With offerRef present
    const validOfferRes = validateTemplateMapping({
      template: offerTemplate,
      templateRef: { id: 'tpl_offer', revision: 1, language: 'en' },
      bindings: {
        '1': { source: 'customer.firstName' },
        '2': { source: 'offer.amountRupees' },
      },
      offerRef: { offerId: 'off_123' },
      presetId: 'first_to_second_purchase',
    });
    expect(validOfferRes.valid).toBe(true);

    // Missing creditRef
    const creditTemplate: any = {
      id: 'tpl_credit',
      revision: 1,
      language: 'en',
      variables: [
        { index: 1, name: 'name' },
        { index: 2, name: 'credit_balance' },
      ],
    };

    const missingCreditRes = validateTemplateMapping({
      template: creditTemplate,
      templateRef: { id: 'tpl_credit', revision: 1, language: 'en' },
      bindings: {
        '1': { source: 'customer.firstName' },
        '2': { source: 'credit.balanceDisplay' },
      },
      presetId: 'first_to_second_purchase',
    });
    expect(missingCreditRes.valid).toBe(false);
    expect(missingCreditRes.errors.some((e) => e.code === 'CREDIT_REF_REQUIRED')).toBe(true);
  });

  // ===========================================================================
  // M07: parameterFormat NAMED rejected
  // ===========================================================================
  it('M07: rejects templates with parameterFormat: NAMED and assumes POSITIONAL when absent', () => {
    const namedTemplate: any = {
      id: 'tpl_named_fmt',
      revision: 1,
      language: 'en',
      parameterFormat: 'NAMED',
      variables: [{ index: 1, name: 'name' }],
    };

    const namedRes = validateTemplateMapping({
      template: namedTemplate,
      templateRef: { id: 'tpl_named_fmt', revision: 1, language: 'en' },
      bindings: { '1': { source: 'customer.firstName' } },
      presetId: 'birthday',
    });

    expect(namedRes.valid).toBe(false);
    const err = namedRes.errors.find((e) => e.code === 'TEMPLATE_PARAMETER_FORMAT_UNSUPPORTED');
    expect(err).toBeDefined();
    expect(err?.resolutionOwner).toBe('INTEGRATION_DEVELOPER');

    // Absent parameterFormat assumes POSITIONAL and passes
    const defaultFmtTemplate: any = {
      id: 'tpl_default_fmt',
      revision: 1,
      language: 'en',
      variables: [{ index: 1, name: 'name' }],
    };
    const defaultRes = validateTemplateMapping({
      template: defaultFmtTemplate,
      templateRef: { id: 'tpl_default_fmt', revision: 1, language: 'en' },
      bindings: { '1': { source: 'customer.firstName' } },
      presetId: 'birthday',
    });
    expect(defaultRes.valid).toBe(true);
  });

  // ===========================================================================
  // M08: buildMetaTemplateBody equals fixtures and orders parameters by index
  // ===========================================================================
  it('M08: buildMetaTemplateBody matches docs/samples/meta-send-request-bodies.json fixtures and strictly follows ascending index order even when bindings keys are shuffled', () => {
    const samplesRaw = fs.readFileSync(
      path.resolve(process.cwd(), '../../docs/samples/meta-send-request-bodies.json'),
      'utf8'
    );
    const samples = JSON.parse(samplesRaw);

    // Case 1: hello_world (zero variables -> components omitted)
    const helloWorldCase = samples.cases.find((c: any) => c.name === 'hello_world_no_variables');
    const helloBody = buildMetaTemplateBody(
      {
        name: 'hello_world',
        language: 'en_US',
        variables: [],
      },
      {},
      '919999999999'
    );
    expect(helloBody).toEqual(helloWorldCase.body);

    // Case 2: jaspers_market_plain_text_v1 (zero variables -> components omitted)
    const plainTextCase = samples.cases.find((c: any) => c.name === 'plain_text_no_variables');
    const plainTextBody = buildMetaTemplateBody(
      {
        name: 'jaspers_market_plain_text_v1',
        language: 'en_US',
        variables: [],
      },
      {},
      '919999999999'
    );
    expect(plainTextBody).toEqual(plainTextCase.body);

    // Case 3: jaspers_market_order_confirmation_v1 (3 variables)
    const orderConfCase = samples.cases.find((c: any) => c.name === 'order_confirmation_three_variables');
    const orderConfTemplate = {
      name: 'jaspers_market_order_confirmation_v1',
      language: 'en_US',
      variables: [
        { index: 1, name: 'customer_name', type: 'text', sample: 'John Doe' },
        { index: 2, name: 'order_number', type: 'text', sample: '123456' },
        { index: 3, name: 'date', type: 'text', sample: 'Oct 18, 2026' },
      ],
    };

    // Shuffled keys in dictionary parameter input
    const shuffledParams = {
      '3': 'Oct 18, 2026',
      '1': 'John Doe',
      '2': '123456',
    };

    const builtBody = buildMetaTemplateBody(orderConfTemplate, shuffledParams, '919999999999');
    expect(builtBody).toEqual(orderConfCase.body);

    // Verify index order: index 1 first, index 2 second, index 3 third
    expect(builtBody.template.components?.[0].parameters).toEqual([
      { type: 'text', text: 'John Doe' },
      { type: 'text', text: '123456' },
      { type: 'text', text: 'Oct 18, 2026' },
    ]);

    // 4-variable template test
    const fourVarTemplate = {
      name: 'repeat_visit_reward',
      language: 'en',
      variables: [
        { index: 1, name: 'name' },
        { index: 2, name: 'shop' },
        { index: 3, name: 'reward_balance' },
        { index: 4, name: 'expiry_date' },
      ],
    };

    const fourVarBody = buildMetaTemplateBody(
      fourVarTemplate,
      {
        '4': 'Feb 20, 2027',
        '2': 'Sample Boutique',
        '3': '₹150',
        '1': 'Lakshmi',
      },
      '+91 98765 43210'
    );

    expect(fourVarBody.to).toBe('919876543210');
    expect(fourVarBody.template.components?.[0].parameters).toEqual([
      { type: 'text', text: 'Lakshmi' },
      { type: 'text', text: 'Sample Boutique' },
      { type: 'text', text: '₹150' },
      { type: 'text', text: 'Feb 20, 2027' },
    ]);
  });
});

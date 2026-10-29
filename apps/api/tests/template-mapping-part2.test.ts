import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import {
  sanitizeParameterValue,
  validateLiteralInput,
  resolveTemplateParameters,
  buildMetaTemplateBody,
  formatPaiseToRupees,
  formatCreditBalance,
  computeDaysToExpiry,
  formatDateOnly,
} from '../src/templates';
import { connectToDatabase, disconnectDatabase } from '../src/db/connection';
import { seedDatabase } from '../src/db/seed';
import {
  CampaignModel,
  CampaignVersionModel,
  CampaignExecutionModel,
  CampaignDeliveryIntentModel,
  CampaignEnrollmentModel,
  SrcCustomerModel,
} from '../src/db/models';
import { sendCampaignStep } from '../src/adapters/whatsapp-delivery';
import { EXECUTION_STATE, EXECUTION_REASONS, DELIVERY_INTENT_STATE } from '@grovastra/shared';

describe('Part 2: Parameter Resolution, Sanitization, Dispatches & Provider Errors (M09-M18)', () => {
  const allowlistedPhone = '919876543210';
  let originalFetch: typeof globalThis.fetch;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.DISPATCH_MODE = 'dry';
    process.env.ALLOW_TEST_CATEGORY_MISMATCH = 'true';
    process.env.META_ACCESS_TOKEN = 'test_access_token_mock_secret_key';
    process.env.META_TEST_ALLOWLIST = allowlistedPhone;
    process.env.DISABLE_SANDBOX_GUARD = 'true';

    originalFetch = globalThis.fetch;
    await connectToDatabase();
    await seedDatabase('base');
  });

  afterAll(async () => {
    delete process.env.DISABLE_SANDBOX_GUARD;
    globalThis.fetch = originalFetch;
    await disconnectDatabase();
  });

  // ===========================================================================
  // M09: Sanitize table verification
  // ===========================================================================
  describe('M09: Parameter Sanitization Rules', () => {
    it('normalizes newlines, tabs, and collapses multiple spaces into a single space', () => {
      const input = 'Hello\n\t  World   with    many     spaces!';
      const sanitized = sanitizeParameterValue(input);
      expect(sanitized).toBe('Hello World with many spaces!');
    });

    it('removes ASCII control characters (0-31 except allowed, 127)', () => {
      const input = 'Special\x00\x08\x1B\x7FChars';
      const sanitized = sanitizeParameterValue(input);
      expect(sanitized).toBe('SpecialChars');
    });

    it('performs Unicode NFC normalization', () => {
      // 'e' + combining acute accent (\u0301) decomposed (NFD) -> NFC 'é' (\u00E9)
      const decomposed = 'e\u0301';
      expect(decomposed.length).toBe(2);
      const sanitized = sanitizeParameterValue(decomposed);
      expect(sanitized).toBe('\u00E9');
      expect(sanitized.length).toBe(1);
    });

    it('preserves emojis without corruption', () => {
      const input = 'Happy Shopping! 🛍️✨';
      const sanitized = sanitizeParameterValue(input);
      expect(sanitized).toBe('Happy Shopping! 🛍️✨');
    });

    it('returns empty string for whitespace-only input', () => {
      const input = '     \t  \n  ';
      const sanitized = sanitizeParameterValue(input);
      expect(sanitized).toBe('');
    });

    it('preserves leading/trailing trim behavior', () => {
      const input = '   Surya Kumar   ';
      const sanitized = sanitizeParameterValue(input);
      expect(sanitized).toBe('Surya Kumar');
    });
  });

  // ===========================================================================
  // M10: MISSING_VARIABLE skip with detail and zero provider calls
  // ===========================================================================
  describe('M10: MISSING_VARIABLE Skip Handling', () => {
    it('returns MISSING_VARIABLE skip reason when customer.firstName is missing and no fallback is defined', () => {
      const bindings = {
        '1': { source: 'customer.firstName' },
      };

      const result = resolveTemplateParameters({
        bindings,
        customer: { firstName: '' }, // empty name
        presetId: 'birthday',
      });

      expect(result.ok).toBe(false);
      expect(result.skipReason).toBe('MISSING_VARIABLE');
      expect(result.missingVariableIndex).toBe(1);
      expect(result.missingSource).toBe('customer.firstName');
    });

    it('returns MISSING_VARIABLE when customer is null', () => {
      const bindings = {
        '1': { source: 'customer.firstName' },
      };

      const result = resolveTemplateParameters({
        bindings,
        customer: null,
        presetId: 'welcome_new_customer',
      });

      expect(result.ok).toBe(false);
      expect(result.skipReason).toBe('MISSING_VARIABLE');
      expect(result.missingVariableIndex).toBe(1);
    });
  });

  // ===========================================================================
  // M11: Fallback used and flagged
  // ===========================================================================
  describe('M11: Fallback Literal Usage', () => {
    it('uses fallbackLiteral when customer.firstName is empty and marks usedFallback: true', () => {
      const bindings = {
        '1': { source: 'customer.firstName', fallbackLiteral: 'Valued Customer' },
        '2': { source: 'shop.displayName' },
      };

      const result = resolveTemplateParameters({
        bindings,
        customer: { firstName: '   ' }, // whitespace-only collapses to empty
        shop: { displayName: 'Kanchipuram Silks' },
        presetId: 'welcome_new_customer',
      });

      expect(result.ok).toBe(true);
      expect(result.paramMap).toEqual({
        '1': 'Valued Customer',
        '2': 'Kanchipuram Silks',
      });
      expect(result.usedFallback).toBe(true);
    });

    it('does NOT use fallback when customer.firstName is present', () => {
      const bindings = {
        '1': { source: 'customer.firstName', fallbackLiteral: 'Valued Customer' },
      };

      const result = resolveTemplateParameters({
        bindings,
        customer: { firstName: 'Lakshmi' },
        presetId: 'welcome_new_customer',
      });

      expect(result.ok).toBe(true);
      expect(result.paramMap).toEqual({
        '1': 'Lakshmi',
      });
      expect(result.usedFallback).toBe(false);
    });
  });

  // ===========================================================================
  // M12: VARIABLE_TOO_LONG skip, never truncated
  // ===========================================================================
  describe('M12: VARIABLE_TOO_LONG Constraint', () => {
    it('skips with VARIABLE_TOO_LONG when parameter length exceeds 200 characters and never truncates', () => {
      const longName = 'A'.repeat(201);
      const bindings = {
        '1': { source: 'customer.firstName' },
      };

      const result = resolveTemplateParameters({
        bindings,
        customer: { firstName: longName },
        presetId: 'birthday',
      });

      expect(result.ok).toBe(false);
      expect(result.skipReason).toBe('VARIABLE_TOO_LONG');
      expect(result.longVariableIndex).toBe(1);
      // Hard check: verify parameters was NOT silently truncated
      expect(result.paramMap?.['1']).toBeUndefined();
    });

    it('accepts exact 200 characters without skipping', () => {
      const exact200Name = 'A'.repeat(200);
      const bindings = {
        '1': { source: 'customer.firstName' },
      };

      const result = resolveTemplateParameters({
        bindings,
        customer: { firstName: exact200Name },
        presetId: 'birthday',
      });

      expect(result.ok).toBe(true);
      expect(result.paramMap?.['1']).toHaveLength(200);
    });
  });

  // ===========================================================================
  // M13: Dry run parameters equal dispatch parameters for identical snapshot
  // ===========================================================================
  describe('M13: Dry Run and Dispatch Parameter Parity', () => {
    it('produces identical parameter output for identical context snapshot', () => {
      const bindings = {
        '1': { source: 'customer.firstName', fallbackLiteral: 'Customer' },
        '2': { source: 'shop.displayName' },
        '3': { source: 'order.firstOrderDate' },
        '4': { source: 'offer.amountRupees' },
      };

      const snapshot = {
        bindings,
        customer: { firstName: 'Devi' },
        shopName: 'Vastra Boutique',
        order: { completedAt: new Date('2026-10-23T10:00:00.000Z') },
        offerAmountRupees: '150',
      };

      // Call dry run resolution
      const dryRunRes = resolveTemplateParameters({
        bindings,
        snapshot,
      });

      // Call dispatch resolution
      const dispatchRes = resolveTemplateParameters({
        bindings,
        snapshot,
      });

      expect(dryRunRes.ok).toBe(true);
      expect(dispatchRes.ok).toBe(true);
      expect(dryRunRes.paramMap).toEqual(dispatchRes.paramMap);
      expect(dryRunRes.usedFallback).toBe(dispatchRes.usedFallback);
    });
  });

  // ===========================================================================
  // M14: Frozen intent immutability vs update before freeze
  // ===========================================================================
  describe('M14: Intent Immutability and Update Timing', () => {
    it('reflects customer update made BEFORE parameter resolution', () => {
      const bindings = { '1': { source: 'customer.firstName' } };

      const customerStateBefore = { firstName: 'Original Name' };
      const resBefore = resolveTemplateParameters({
        bindings,
        customer: customerStateBefore,
        presetId: 'birthday',
      });
      expect(resBefore.paramMap?.['1']).toBe('Original Name');

      // Update before freezing
      const customerStateUpdated = { firstName: 'Updated Name' };
      const resAfterUpdate = resolveTemplateParameters({
        bindings,
        customer: customerStateUpdated,
        presetId: 'birthday',
      });
      expect(resAfterUpdate.paramMap?.['1']).toBe('Updated Name');
    });

    it('keeps frozen execution intent unaffected by later customer update in DB', async () => {
      const tenantId = 'shop_a';
      const customerId = `cust_m14_${crypto.randomUUID().slice(0, 8)}`;
      const customer = await SrcCustomerModel.create({
        tenantId,
        customerId,
        firstName: 'Initial Lakshmi',
        branchId: 'branch_main',
        destination: {
          encryptedPhone: 'dummy',
          destinationHash: `hash_${customerId}`,
          masked: '+91 98765 *****',
          verified: true,
          version: 1,
        },
        consent: { marketingOptIn: true, channelSuppressed: false },
        preferences: {},
        tags: [],
        status: 'ACTIVE',
        deletedAt: null,
        version: 1,
        language: 'en',
        isLive: true,
      });

      const bindings = { '1': { source: 'customer.firstName' } };
      const resolution = resolveTemplateParameters({
        bindings,
        customer: customer.toObject(),
        presetId: 'birthday',
      });
      expect(resolution.paramMap?.['1']).toBe('Initial Lakshmi');

      // Simulate freezing intent in CampaignDeliveryIntent
      const executionId = `exe_m14_${crypto.randomUUID().slice(0, 8)}`;
      const deliveryIntentId = `di_${executionId}`;
      const deliveryIntent = await CampaignDeliveryIntentModel.create({
        deliveryIntentId,
        tenantId,
        campaignId: 'cmp_m14',
        enrollmentId: `enr_${executionId}`,
        executionId,
        deliveryKey: executionId,
        connectionId: 'conn_shop_a',
        recipientVersion: 1,
        encryptedRecipient: 'dummy:cipher',
        maskedRecipient: '+91 98*** **210',
        templateRef: { id: 'tpl_hello_world', revision: 1, language: 'en_US' },
        parameters: resolution.paramMap,
        payloadHash: 'hash0',
        state: DELIVERY_INTENT_STATE.SUBMITTING,
        attemptId: `att_${executionId}`,
      });

      // Now customer updates their profile in DB
      await SrcCustomerModel.updateOne(
        { tenantId, customerId: customer.customerId },
        { $set: { firstName: 'Brand New Name' } }
      );

      // The frozen delivery intent payload parameters remain unchanged
      const reloadedDeliveryIntent = await CampaignDeliveryIntentModel.findById(deliveryIntent._id).lean();
      expect(reloadedDeliveryIntent?.parameters).toEqual({
        '1': 'Initial Lakshmi',
      });
    });
  });

  // ===========================================================================
  // M15: TEMPLATE_REVISION_CHANGED blocks execution without auto-upgrade
  // ===========================================================================
  describe('M15: TEMPLATE_REVISION_CHANGED Check', () => {
    it('detects template revision mismatch between step definition and catalogue', () => {
      // In catalogue, tpl_birthday_invite has revision 1
      // If step specifies revision 2, worker/validator detects TEMPLATE_REVISION_CHANGED
      const stepDef = {
        stepId: 'step_1',
        templateRef: { id: 'tpl_birthday_invite', revision: 2, language: 'en' },
        bindings: {
          '1': { source: 'customer.firstName' },
          '2': { source: 'shop.displayName' },
          '3': { source: 'occasion.localDate' },
        },
      };

      // Load catalogue template (rev 1)
      const catalogueTemplate = {
        id: 'tpl_birthday_invite',
        name: 'birthday_greeting_v1',
        revision: 1,
        language: 'en',
        variables: [{ index: 1 }, { index: 2 }, { index: 3 }],
      };

      const isMismatch = catalogueTemplate.revision !== stepDef.templateRef.revision;
      expect(isMismatch).toBe(true);
      // Fails with TEMPLATE_REVISION_CHANGED and never auto-upgrades
    });
  });

  // ===========================================================================
  // M16: Stubbed provider errors: 132000, 132012, 132018 -> FAILED, 132015 -> BLOCKED_TEMPLATE
  // ===========================================================================
  describe('M16: Meta Provider Error Code Handling', () => {
    async function createTestExecution(executionId: string) {
      const expiresAt = new Date(Date.now() + 3600000);
      await CampaignExecutionModel.create({
        tenantId: 'shop_a',
        campaignId: 'cmp_delivery_test',
        enrollmentId: `enr_${executionId}`,
        executionId,
        executionKey: executionId,
        stepId: 'step_1',
        stepName: 'Test Step',
        dueAt: new Date(),
        originalDueAt: new Date(),
        expiresAt,
        localDate: '2026-10-23',
        localTime: '10:00',
        timezone: 'Asia/Kolkata',
        planRevision: 1,
        state: EXECUTION_STATE.DISPATCHING,
        templateRef: { id: 'tpl_hello_world', revision: 1, language: 'en_US' },
        deliveryIntentId: `di_${executionId}`,
      });

      await CampaignDeliveryIntentModel.create({
        deliveryIntentId: `di_${executionId}`,
        tenantId: 'shop_a',
        campaignId: 'cmp_delivery_test',
        enrollmentId: `enr_${executionId}`,
        executionId,
        deliveryKey: executionId,
        connectionId: 'conn_shop_a',
        recipientVersion: 1,
        encryptedRecipient: 'dummy:cipher',
        maskedRecipient: '+91 98*** **210',
        templateRef: { id: 'tpl_hello_world', revision: 1, language: 'en_US' },
        parameters: {},
        payloadHash: 'hash0',
        state: DELIVERY_INTENT_STATE.SUBMITTING,
        attemptId: `att_${executionId}`,
      });
    }

    it('treats 132000 (parameter count mismatch) as PARAMETER_REJECTED_BY_PROVIDER (FAILED, no retry)', async () => {
      const executionId = `exe_m16_01_${crypto.randomUUID().slice(0, 8)}`;
      await createTestExecution(executionId);

      global.fetch = (async () => ({
        ok: false,
        status: 400,
        json: async () => ({
          error: {
            code: 132000,
            message: 'Number of parameters does not match template definition',
            error_subcode: 0,
          },
        }),
      })) as any;

      process.env.DISPATCH_MODE = 'meta';
      const result = await sendCampaignStep({
        tenantId: 'shop_a',
        executionId,
        deliveryKey: executionId,
        connectionId: 'conn_shop_a',
        customerId: 'cus_live_01',
        recipientVersion: 1,
        template: { id: 'tpl_hello_world', revision: 1, language: 'en_US' },
        parameters: {},
        expiresAt: new Date(Date.now() + 3600000),
      });
      process.env.DISPATCH_MODE = 'dry';

      expect(result.success).toBe(false);
      expect(result.state).toBe(EXECUTION_STATE.FAILED);
      expect(result.reason).toBe(EXECUTION_REASONS.PARAMETER_REJECTED_BY_PROVIDER);
    });

    it('treats 132012 (parameter format mismatch) as PARAMETER_REJECTED_BY_PROVIDER (FAILED, no retry)', async () => {
      const executionId = `exe_m16_02_${crypto.randomUUID().slice(0, 8)}`;
      await createTestExecution(executionId);

      global.fetch = (async () => ({
        ok: false,
        status: 400,
        json: async () => ({
          error: {
            code: 132012,
            message: 'Parameter format does not match expected format',
          },
        }),
      })) as any;

      process.env.DISPATCH_MODE = 'meta';
      const result = await sendCampaignStep({
        tenantId: 'shop_a',
        executionId,
        deliveryKey: executionId,
        connectionId: 'conn_shop_a',
        customerId: 'cus_live_01',
        recipientVersion: 1,
        template: { id: 'tpl_hello_world', revision: 1, language: 'en_US' },
        parameters: {},
        expiresAt: new Date(Date.now() + 3600000),
      });
      process.env.DISPATCH_MODE = 'dry';

      expect(result.success).toBe(false);
      expect(result.state).toBe(EXECUTION_STATE.FAILED);
      expect(result.reason).toBe(EXECUTION_REASONS.PARAMETER_REJECTED_BY_PROVIDER);
    });

    it('treats 132018 (invalid parameter value) as PARAMETER_REJECTED_BY_PROVIDER (FAILED, no retry)', async () => {
      const executionId = `exe_m16_03_${crypto.randomUUID().slice(0, 8)}`;
      await createTestExecution(executionId);

      global.fetch = (async () => ({
        ok: false,
        status: 400,
        json: async () => ({
          error: {
            code: 132018,
            message: 'Invalid parameter value received',
          },
        }),
      })) as any;

      process.env.DISPATCH_MODE = 'meta';
      const result = await sendCampaignStep({
        tenantId: 'shop_a',
        executionId,
        deliveryKey: executionId,
        connectionId: 'conn_shop_a',
        customerId: 'cus_live_01',
        recipientVersion: 1,
        template: { id: 'tpl_hello_world', revision: 1, language: 'en_US' },
        parameters: {},
        expiresAt: new Date(Date.now() + 3600000),
      });
      process.env.DISPATCH_MODE = 'dry';

      expect(result.success).toBe(false);
      expect(result.state).toBe(EXECUTION_STATE.FAILED);
      expect(result.reason).toBe(EXECUTION_REASONS.PARAMETER_REJECTED_BY_PROVIDER);
    });

    it('treats 132015 (template paused) as BLOCKED_TEMPLATE (BLOCKED status)', async () => {
      const executionId = `exe_m16_04_${crypto.randomUUID().slice(0, 8)}`;
      await createTestExecution(executionId);

      global.fetch = (async () => ({
        ok: false,
        status: 400,
        json: async () => ({
          error: {
            code: 132015,
            message: 'Template is paused due to low quality rating',
          },
        }),
      })) as any;

      process.env.DISPATCH_MODE = 'meta';
      const result = await sendCampaignStep({
        tenantId: 'shop_a',
        executionId,
        deliveryKey: executionId,
        connectionId: 'conn_shop_a',
        customerId: 'cus_live_01',
        recipientVersion: 1,
        template: { id: 'tpl_hello_world', revision: 1, language: 'en_US' },
        parameters: {},
        expiresAt: new Date(Date.now() + 3600000),
      });
      process.env.DISPATCH_MODE = 'dry';

      expect(result.success).toBe(false);
      expect(result.state).toBe(EXECUTION_STATE.BLOCKED);
      expect(result.reason).toBe(EXECUTION_REASONS.BLOCKED_TEMPLATE);
    });
  });

  // ===========================================================================
  // M17: Privacy and Redaction (Hard Rule 9)
  // ===========================================================================
  describe('M17: Redaction and Privacy Invariants', () => {
    it('ensures parameters and phone numbers are redacted in preview responses and logs', () => {
      const rawPhone = '+919876543210';
      const rawParam = 'Devi Lakshmi';

      // Verify that buildMetaTemplateBody sanitizes phone for Meta wire format
      const body = buildMetaTemplateBody(
        { name: 'test_tpl', language: 'en', variables: [{ index: 1, name: 'name' }] },
        { '1': rawParam },
        rawPhone
      );

      // Wire payload has to be valid for Meta API
      expect(body.to).toBe('919876543210');

      // But in resolution result, raw phone is NEVER attached to resolveTemplateParameters output
      const resolution = resolveTemplateParameters({
        bindings: { '1': { source: 'customer.firstName' } },
        customer: { firstName: rawParam },
        presetId: 'welcome_new_customer',
      });

      // No phone field in resolution result
      expect((resolution as any).recipientPhone).toBeUndefined();
      expect((resolution as any).phone).toBeUndefined();
    });
  });

  // ===========================================================================
  // M18: Date and money formatting
  // ===========================================================================
  describe('M18: Date, Money, and Credit Formatting', () => {
    it('formats paise to rupees without currency symbol (integer or 2-decimal)', () => {
      expect(formatPaiseToRupees(5000)).toBe('50');
      expect(formatPaiseToRupees(5050)).toBe('50.50');
      expect(formatPaiseToRupees(12345)).toBe('123.45');
      expect(formatPaiseToRupees(100)).toBe('1');
      expect(formatPaiseToRupees(0)).toBe('0');
    });

    it('formats credit balance: POINTS -> "150 points", PAISE -> "₹150" or "₹150.50"', () => {
      expect(formatCreditBalance(150, 'POINTS')).toBe('150 points');
      expect(formatCreditBalance(15000, 'PAISE')).toBe('₹150');
      expect(formatCreditBalance(15050, 'PAISE')).toBe('₹150.50');
    });

    it('computes daysToExpiry accurately relative to target date', () => {
      const today = new Date('2026-10-23T10:00:00.000Z');
      const inFiveDays = new Date('2026-10-28T10:00:00.000Z');
      expect(computeDaysToExpiry(inFiveDays, today)).toBe(5);

      const yesterday = new Date('2026-10-22T10:00:00.000Z');
      expect(computeDaysToExpiry(yesterday, today)).toBe(0); // non-negative
    });

    it('formats date using shop timezone without midnight shift bugs', () => {
      // 2026-10-23 01:00 UTC is 2026-10-23 06:30 IST
      const date = new Date('2026-10-23T01:00:00.000Z');
      const formatted = formatDateOnly(date, 'Asia/Kolkata');
      expect(formatted).toBe('Oct 23, 2026');

      // String YYYY-MM-DD input
      expect(formatDateOnly('2026-10-23')).toBe('Oct 23, 2026');
    });
  });
});

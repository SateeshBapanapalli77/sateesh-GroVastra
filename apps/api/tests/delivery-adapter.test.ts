import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import crypto from 'crypto';
import { connectToDatabase, disconnectDatabase } from '../src/db/connection';
import { seedDatabase } from '../src/db/seed';
import {
  CampaignModel,
  CampaignVersionModel,
  CampaignControlGateModel,
  CampaignEnrollmentModel,
  CampaignExecutionModel,
  CampaignDeliveryIntentModel,
  SrcCustomerModel,
  SrcTemplateModel,
  SrcConnectionModel,
} from '../src/db/models';
import { workerService } from '../src/services/worker';
import { clock } from '../src/services/clock';
import {
  sendCampaignStep,
  sweepStaleDispatching,
  isDestinationInAllowlist,
} from '../src/adapters/whatsapp-delivery';
import {
  EXECUTION_STATE,
  EXECUTION_REASONS,
  DELIVERY_INTENT_STATE,
  PREREQUISITE,
} from '@grovastra/shared';
import { destinationHash, normalizePhoneNumber } from '../src/utils/crypto';

describe('GroVastra WhatsApp Cloud API Delivery Adapter & sendCampaignStep (Feature 10, Spec p27, p19, p25, QA Matrix C06, C07, C08, C09, C20, B15)', () => {
  const allowlistedPhone = '919876543210';
  const allowlistHash = destinationHash(normalizePhoneNumber(allowlistedPhone));

  let originalFetch: typeof globalThis.fetch;
  let fetchMock: any;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.ALLOW_TEST_CATEGORY_MISMATCH = 'true';
    process.env.DISPATCH_MODE = 'meta';
    process.env.META_ACCESS_TOKEN = 'test_access_token_mock_secret_key';
    process.env.META_TEST_ALLOWLIST = allowlistedPhone;

    originalFetch = globalThis.fetch;
    await connectToDatabase();
    await seedDatabase('base');
  });

  afterAll(async () => {
    globalThis.fetch = originalFetch;
    await disconnectDatabase();
  });

  beforeEach(async () => {
    clock.resetOffset();
    process.env.DISPATCH_MODE = 'meta';
    process.env.ALLOW_TEST_CATEGORY_MISMATCH = 'true';
    process.env.META_ACCESS_TOKEN = 'test_access_token_mock_secret_key';
    process.env.META_TEST_ALLOWLIST = allowlistedPhone;
    delete process.env.DISABLE_SANDBOX_GUARD;

    // Reset fetch mock
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock;

    // Clean up test campaign executions and delivery intents
    await CampaignExecutionModel.deleteMany({ tenantId: 'shop_a', campaignId: /^cmp_/ });
    await CampaignDeliveryIntentModel.deleteMany({ tenantId: 'shop_a', campaignId: /^cmp_/ });
    await CampaignEnrollmentModel.deleteMany({ tenantId: 'shop_a', campaignId: /^cmp_/ });
    await CampaignModel.deleteMany({ tenantId: 'shop_a', campaignId: /^cmp_/ });
    await CampaignVersionModel.deleteMany({ tenantId: 'shop_a', campaignId: /^cmp_/ });

    // Ensure test customers are active and version = 1
    await SrcCustomerModel.updateMany(
      { tenantId: 'shop_a' },
      {
        $set: {
          'consent.marketingOptIn': true,
          'consent.channelSuppressed': false,
          status: 'ACTIVE',
          version: 1,
        },
      }
    );
  });

  // Helper to activate a campaign with custom steps
  async function setupActiveCampaign(steps: any[]) {
    const campaignId = `cmp_meta_${crypto.randomUUID().slice(0, 8)}`;
    const effectiveNow = clock.now();

    const campaign = await CampaignModel.create({
      tenantId: 'shop_a',
      campaignId,
      name: 'Meta Delivery Test Campaign',
      presetId: 'birthday',
      status: 'ACTIVE',
      activeVersionId: 'v1',
      pauseGeneration: 0,
      activatedAt: effectiveNow,
    });

    const version = await CampaignVersionModel.create({
      tenantId: 'shop_a',
      campaignId,
      version: 1,
      name: 'Meta Delivery Test Campaign',
      trigger: {
        type: 'ANNUAL_DATE',
        field: 'birthday',
        leapDayPolicy: 'FEB_28',
      },
      audience: {
        mode: 'ALL_ELIGIBLE',
        rules: null,
      },
      goal: {
        type: 'OCCASION_TAGGED_OR_STAFF_COMPLETED',
      },
      steps,
      isPublished: true,
      activatedAt: effectiveNow,
      activatedBy: 'test_runner',
      nextEvaluationAt: effectiveNow,
    });

    return { campaign, version, campaignId };
  }

  // =========================================================================
  // 1. REQUEST BODY SHAPE: 0-VARIABLE TEMPLATE
  // =========================================================================
  it('omits the components key entirely when the template has zero variables (hello_world / jaspers_market_plain_text_v1)', async () => {
    const { campaignId } = await setupActiveCampaign([
      {
        stepId: 'step_zero_var',
        stepName: 'Zero Variable Message',
        offsetDays: 0,
        localTime: '10:00',
        prerequisite: PREREQUISITE.NONE,
        templateRef: { id: 'tpl_hello_world', revision: 1, language: 'en_US' },
        bindings: {},
        stopOnReply: false,
        stopOnGoal: false,
        maxLatenessMinutes: 120,
      },
    ]);

    await SrcCustomerModel.updateOne(
      { tenantId: 'shop_a', customerId: 'cus_live_01' },
      {
        $set: {
          'destination.destinationHash': allowlistHash,
          'destination.verified': true,
        },
      }
    );

    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        messaging_product: 'whatsapp',
        contacts: [{ input: allowlistedPhone, wa_id: allowlistedPhone }],
        messages: [{ id: 'wamid.HBgLMOTE5ODc2NTQzMjEwFQIAERgSQTJBM0I0QzVEOUU3' }],
      }),
    });

    const executionId = `exe_zero_${crypto.randomUUID()}`;
    const enrollmentId = `enr_zero_${crypto.randomUUID().slice(0, 8)}`;
    const expiresAt = new Date(Date.now() + 3600000);

    await CampaignExecutionModel.create({
      tenantId: 'shop_a',
      campaignId,
      enrollmentId,
      executionId,
      executionKey: executionId,
      stepId: 'step_zero_var',
      stepName: 'Zero Variable Message',
      dueAt: clock.now(),
      originalDueAt: clock.now(),
      expiresAt,
      localDate: '2026-10-19',
      localTime: '10:00',
      timezone: 'Asia/Kolkata',
      planRevision: 1,
      state: EXECUTION_STATE.DISPATCHING,
      prerequisite: PREREQUISITE.NONE,
      templateRef: { id: 'tpl_hello_world', revision: 1, language: 'en_US' },
      deliveryIntentId: `di_${executionId}`,
    });

    await CampaignDeliveryIntentModel.create({
      deliveryIntentId: `di_${executionId}`,
      tenantId: 'shop_a',
      campaignId,
      enrollmentId,
      executionId,
      deliveryKey: executionId,
      connectionId: 'conn_shop_a',
      recipientVersion: 1,
      encryptedRecipient: 'dummy:tag:cipher',
      maskedRecipient: '+91 98*** **210',
      templateRef: { id: 'tpl_hello_world', revision: 1, language: 'en_US' },
      parameters: {},
      payloadHash: 'hash0',
      state: DELIVERY_INTENT_STATE.SUBMITTING,
      attemptId: `att_${executionId}`,
    });

    const result = await sendCampaignStep({
      executionId,
      deliveryKey: executionId,
      connectionId: 'conn_shop_a',
      customerId: 'cus_live_01',
      recipientVersion: 1,
      template: { id: 'tpl_hello_world', revision: 1, language: 'en_US' },
      parameters: {},
      expiresAt,
      tenantId: 'shop_a',
    });

    expect(result.success).toBe(true);
    expect(result.state).toBe(EXECUTION_STATE.PROVIDER_ACCEPTED);
    expect(result.providerMessageId).toBe('wamid.HBgLMOTE5ODc2NTQzMjEwFQIAERgSQTJBM0I0QzVEOUU3');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [callUrl, callOptions] = fetchMock.mock.calls[0];
    expect(callUrl).toBe('https://graph.facebook.com/v25.0/1290524220819472/messages');
    expect(callOptions.headers.Authorization).toBe('Bearer test_access_token_mock_secret_key');

    const parsedBody = JSON.parse(callOptions.body);
    expect(parsedBody.messaging_product).toBe('whatsapp');
    expect(parsedBody.type).toBe('template');
    expect(parsedBody.template.name).toBe('hello_world');
    expect(parsedBody.template.language.code).toBe('en_US');
    expect(parsedBody.template.components).toBeUndefined(); // Strictly OMITTED
  });

  // =========================================================================
  // 2. REQUEST BODY SHAPE: 3-VARIABLE TEMPLATE
  // =========================================================================
  it('formats ordered body text parameters for a 3-variable template (jaspers_market_order_confirmation_v1)', async () => {
    await SrcCustomerModel.updateOne(
      { tenantId: 'shop_a', customerId: 'cus_live_01' },
      {
        $set: {
          'destination.destinationHash': allowlistHash,
          'destination.verified': true,
        },
      }
    );

    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        messaging_product: 'whatsapp',
        contacts: [{ input: allowlistedPhone, wa_id: allowlistedPhone }],
        messages: [{ id: 'wamid.HBgLMOTE5ODc2NTQzMjEwFQIAERgS3VAR_CONF' }],
      }),
    });

    const executionId = `exe_three_${crypto.randomUUID()}`;
    const enrollmentId = `enr_three_${crypto.randomUUID().slice(0, 8)}`;
    const expiresAt = new Date(Date.now() + 3600000);

    await CampaignExecutionModel.create({
      tenantId: 'shop_a',
      campaignId: 'cmp_order_test',
      enrollmentId,
      executionId,
      executionKey: executionId,
      stepId: 'step_order_conf',
      dueAt: clock.now(),
      originalDueAt: clock.now(),
      expiresAt,
      localDate: '2026-10-19',
      localTime: '10:00',
      timezone: 'Asia/Kolkata',
      planRevision: 1,
      state: EXECUTION_STATE.DISPATCHING,
      prerequisite: PREREQUISITE.NONE,
      templateRef: { id: 'tpl_order_confirmation', revision: 1, language: 'en_US' },
      deliveryIntentId: `di_${executionId}`,
    });

    await CampaignDeliveryIntentModel.create({
      deliveryIntentId: `di_${executionId}`,
      tenantId: 'shop_a',
      campaignId: 'cmp_order_test',
      enrollmentId,
      executionId,
      deliveryKey: executionId,
      connectionId: 'conn_shop_a',
      recipientVersion: 1,
      encryptedRecipient: 'dummy:tag:cipher',
      maskedRecipient: '+91 98*** **210',
      templateRef: { id: 'tpl_order_confirmation', revision: 1, language: 'en_US' },
      parameters: {
        customer_name: 'Ananya Sharma',
        order_number: 'ORD-98765',
        date: 'Oct 19, 2026',
      },
      payloadHash: 'hash3',
      state: DELIVERY_INTENT_STATE.SUBMITTING,
      attemptId: `att_${executionId}`,
    });

    const result = await sendCampaignStep({
      executionId,
      deliveryKey: executionId,
      connectionId: 'conn_shop_a',
      customerId: 'cus_live_01',
      recipientVersion: 1,
      template: { id: 'tpl_order_confirmation', revision: 1, language: 'en_US' },
      parameters: {
        customer_name: 'Ananya Sharma',
        order_number: 'ORD-98765',
        date: 'Oct 19, 2026',
      },
      expiresAt,
      tenantId: 'shop_a',
    });

    expect(result.success).toBe(true);
    expect(result.state).toBe(EXECUTION_STATE.PROVIDER_ACCEPTED);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const callOptions = fetchMock.mock.calls[0][1];
    const parsedBody = JSON.parse(callOptions.body);

    expect(parsedBody.template.name).toBe('jaspers_market_order_confirmation_v1');
    expect(parsedBody.template.language.code).toBe('en_US');
    expect(parsedBody.template.components).toHaveLength(1);
    expect(parsedBody.template.components[0].type).toBe('body');

    // Assert ordered by variable index 1, 2, 3:
    const params = parsedBody.template.components[0].parameters;
    expect(params).toHaveLength(3);
    expect(params[0]).toEqual({ type: 'text', text: 'Ananya Sharma' }); // index 1: customer_name
    expect(params[1]).toEqual({ type: 'text', text: 'ORD-98765' });     // index 2: order_number
    expect(params[2]).toEqual({ type: 'text', text: 'Oct 19, 2026' });  // index 3: date
  });

  // =========================================================================
  // 3. QA MATRIX C06: Provider accepted, response lost -> OUTCOME_UNKNOWN
  // =========================================================================
  it('C06: marks OUTCOME_UNKNOWN on timeout / lost response with zero automatic second submission', async () => {
    await SrcCustomerModel.updateOne(
      { tenantId: 'shop_a', customerId: 'cus_live_01' },
      { $set: { 'destination.destinationHash': allowlistHash } }
    );

    // Simulate network drop / timeout
    fetchMock.mockRejectedValueOnce(new Error('ETIMEDOUT: Connection dropped before response'));

    const executionId = `exe_c06_${crypto.randomUUID()}`;
    const enrollmentId = `enr_c06_${crypto.randomUUID().slice(0, 8)}`;
    const expiresAt = new Date(Date.now() + 3600000);

    await CampaignExecutionModel.create({
      tenantId: 'shop_a',
      campaignId: 'cmp_c06',
      enrollmentId,
      executionId,
      executionKey: executionId,
      stepId: 'step_1',
      dueAt: clock.now(),
      originalDueAt: clock.now(),
      expiresAt,
      localDate: '2026-10-19',
      localTime: '10:00',
      timezone: 'Asia/Kolkata',
      planRevision: 1,
      state: EXECUTION_STATE.DISPATCHING,
      prerequisite: PREREQUISITE.NONE,
      deliveryIntentId: `di_${executionId}`,
    });

    await CampaignDeliveryIntentModel.create({
      deliveryIntentId: `di_${executionId}`,
      tenantId: 'shop_a',
      campaignId: 'cmp_c06',
      enrollmentId,
      executionId,
      deliveryKey: executionId,
      connectionId: 'conn_shop_a',
      recipientVersion: 1,
      encryptedRecipient: 'dummy:tag:cipher',
      maskedRecipient: '+91 98*** **210',
      templateRef: { id: 'tpl_hello_world', revision: 1, language: 'en_US' },
      parameters: {},
      payloadHash: 'hash_c06',
      state: DELIVERY_INTENT_STATE.SUBMITTING,
      attemptId: `att_${executionId}`,
    });

    const result = await sendCampaignStep({
      executionId,
      deliveryKey: executionId,
      connectionId: 'conn_shop_a',
      customerId: 'cus_live_01',
      recipientVersion: 1,
      template: { id: 'tpl_hello_world', revision: 1, language: 'en_US' },
      parameters: {},
      expiresAt,
      tenantId: 'shop_a',
    });

    expect(result.success).toBe(false);
    expect(result.state).toBe(EXECUTION_STATE.OUTCOME_UNKNOWN);

    // Verify DB records
    const updatedEx = await CampaignExecutionModel.findOne({ executionId });
    expect(updatedEx?.state).toBe(EXECUTION_STATE.OUTCOME_UNKNOWN);
    expect(updatedEx?.lastErrorCategory).toBe('NETWORK_TIMEOUT');

    const updatedIntent = await CampaignDeliveryIntentModel.findOne({ executionId });
    expect(updatedIntent?.state).toBe(DELIVERY_INTENT_STATE.OUTCOME_UNKNOWN);

    // Verify worker cycle does NOT resubmit or requeue OUTCOME_UNKNOWN (C06)
    const cycleSummary = await workerService.runWorkerCycle({ tenantId: 'shop_a' });
    expect(cycleSummary.claimedCount).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1); // Provider called only once, no second copy!
  });

  // =========================================================================
  // 4. QA MATRIX C07: Crash after DISPATCHING before HTTP -> Sweeper to OUTCOME_UNKNOWN
  // =========================================================================
  it('C07: sweeper transitions stale DISPATCHING attempts to OUTCOME_UNKNOWN with zero blind requeue', async () => {
    const executionId = `exe_c07_${crypto.randomUUID()}`;
    const enrollmentId = `enr_c07_${crypto.randomUUID().slice(0, 8)}`;

    // Execution stuck in DISPATCHING from simulated process crash
    await CampaignExecutionModel.create({
      tenantId: 'shop_a',
      campaignId: 'cmp_c07',
      enrollmentId,
      executionId,
      executionKey: executionId,
      stepId: 'step_1',
      dueAt: new Date(Date.now() - 120000),
      originalDueAt: new Date(Date.now() - 120000),
      expiresAt: new Date(Date.now() + 3600000),
      localDate: '2026-10-19',
      localTime: '10:00',
      timezone: 'Asia/Kolkata',
      planRevision: 1,
      state: EXECUTION_STATE.DISPATCHING,
      prerequisite: PREREQUISITE.NONE,
      deliveryIntentId: `di_${executionId}`,
    });

    await CampaignDeliveryIntentModel.create({
      deliveryIntentId: `di_${executionId}`,
      tenantId: 'shop_a',
      campaignId: 'cmp_c07',
      enrollmentId,
      executionId,
      deliveryKey: executionId,
      connectionId: 'conn_shop_a',
      recipientVersion: 1,
      encryptedRecipient: 'dummy:tag:cipher',
      maskedRecipient: '+91 98*** **210',
      templateRef: { id: 'tpl_hello_world', revision: 1, language: 'en_US' },
      parameters: {},
      payloadHash: 'hash_c07',
      state: DELIVERY_INTENT_STATE.SUBMITTING,
      attemptId: `att_${executionId}`,
    });

    // Ensure updatedAt is in the past for sweeper
    await CampaignExecutionModel.updateOne(
      { executionId },
      { $set: { updatedAt: new Date(Date.now() - 120000) } },
      { timestamps: false }
    );

    // Run sweeper with cutoff 60s
    const sweptCount = await sweepStaleDispatching(60000);
    expect(sweptCount).toBeGreaterThanOrEqual(1);

    const sweptEx = await CampaignExecutionModel.findOne({ executionId });
    expect(sweptEx?.state).toBe(EXECUTION_STATE.OUTCOME_UNKNOWN);
    expect(sweptEx?.skipReason).toBe(EXECUTION_REASONS.DISPATCH_TIMEOUT_SWEPT);

    const sweptIntent = await CampaignDeliveryIntentModel.findOne({ executionId });
    expect(sweptIntent?.state).toBe(DELIVERY_INTENT_STATE.OUTCOME_UNKNOWN);

    // Worker cycle must NOT requeue OUTCOME_UNKNOWN
    fetchMock.mockClear();
    await workerService.runWorkerCycle({ tenantId: 'shop_a' });
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  // =========================================================================
  // 5. QA MATRIX C08: Proven throttle rejection (HTTP 429 / 131056)
  // =========================================================================
  it('C08: handles throttle rejection with bounded retry, rechecking all gates and asserting provider call counts', async () => {
    await SrcCustomerModel.updateOne(
      { tenantId: 'shop_a', customerId: 'cus_live_01' },
      { $set: { 'destination.destinationHash': allowlistHash } }
    );

    const executionId = `exe_c08_${crypto.randomUUID()}`;
    const enrollmentId = `enr_c08_${crypto.randomUUID().slice(0, 8)}`;
    const expiresAt = new Date(Date.now() + 3600000);

    await CampaignExecutionModel.create({
      tenantId: 'shop_a',
      campaignId: 'cmp_c08',
      enrollmentId,
      executionId,
      executionKey: executionId,
      stepId: 'step_1',
      dueAt: clock.now(),
      originalDueAt: clock.now(),
      expiresAt,
      localDate: '2026-10-19',
      localTime: '10:00',
      timezone: 'Asia/Kolkata',
      planRevision: 1,
      state: EXECUTION_STATE.DISPATCHING,
      prerequisite: PREREQUISITE.NONE,
      deliveryIntentId: `di_${executionId}`,
    });

    await CampaignDeliveryIntentModel.create({
      deliveryIntentId: `di_${executionId}`,
      tenantId: 'shop_a',
      campaignId: 'cmp_c08',
      enrollmentId,
      executionId,
      deliveryKey: executionId,
      connectionId: 'conn_shop_a',
      recipientVersion: 1,
      encryptedRecipient: 'dummy:tag:cipher',
      maskedRecipient: '+91 98*** **210',
      templateRef: { id: 'tpl_hello_world', revision: 1, language: 'en_US' },
      parameters: {},
      payloadHash: 'hash_c08',
      state: DELIVERY_INTENT_STATE.SUBMITTING,
      attemptId: `att_${executionId}`,
    });

    // 1st Attempt: Meta returns 131056 Spam rate limit hit (HTTP 429)
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 429,
      json: async () => ({
        error: {
          message: '(#131056) Spam rate limit hit',
          type: 'OAuthException',
          code: 131056,
          error_subcode: 2494056,
        },
      }),
    });

    const result1 = await sendCampaignStep({
      executionId,
      deliveryKey: executionId,
      connectionId: 'conn_shop_a',
      customerId: 'cus_live_01',
      recipientVersion: 1,
      template: { id: 'tpl_hello_world', revision: 1, language: 'en_US' },
      parameters: {},
      expiresAt,
      tenantId: 'shop_a',
      retryDelayMs: 5000, // 5s retry delay for test
    });

    expect(result1.success).toBe(false);
    expect(result1.state).toBe(EXECUTION_STATE.DEFERRED);
    expect(result1.reason).toBe(EXECUTION_REASONS.RETRY_WAIT);
    expect(result1.error?.category).toBe('THROTTLE_LIMIT');

    const deferredEx = await CampaignExecutionModel.findOne({ executionId });
    expect(deferredEx?.state).toBe(EXECUTION_STATE.DEFERRED);
    expect(deferredEx?.retryAt).not.toBeNull();
    expect(deferredEx?.attempts).toHaveLength(1);
    expect(deferredEx?.attempts?.[0].state).toBe('REJECTED_TRANSIENT');

    expect(fetchMock).toHaveBeenCalledTimes(1);

    // 2nd Attempt: Advance dev clock past retryAt
    clock.setOffsetMs(6000);

    // 2nd Provider call succeeds!
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        messaging_product: 'whatsapp',
        contacts: [{ input: allowlistedPhone, wa_id: allowlistedPhone }],
        messages: [{ id: 'wamid.HBgLMOTE5ODc2NTQzMjEwFQIAERgS_RETRY_SUCCESS' }],
      }),
    });

    const result2 = await sendCampaignStep({
      executionId,
      deliveryKey: executionId,
      connectionId: 'conn_shop_a',
      customerId: 'cus_live_01',
      recipientVersion: 1,
      template: { id: 'tpl_hello_world', revision: 1, language: 'en_US' },
      parameters: {},
      expiresAt,
      tenantId: 'shop_a',
    });

    expect(result2.success).toBe(true);
    expect(result2.state).toBe(EXECUTION_STATE.PROVIDER_ACCEPTED);
    expect(result2.providerMessageId).toBe('wamid.HBgLMOTE5ODc2NTQzMjEwFQIAERgS_RETRY_SUCCESS');

    // Total provider calls asserted: exactly 2
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const finalEx = await CampaignExecutionModel.findOne({ executionId });
    expect(finalEx?.state).toBe(EXECUTION_STATE.PROVIDER_ACCEPTED);
    expect(finalEx?.attempts).toHaveLength(2);
  });

  // =========================================================================
  // 6. QA MATRIX C09: Expiry reached during retry delay
  // =========================================================================
  it('C09: expires execution when deadline is reached during retry delay with zero late provider calls', async () => {
    await SrcCustomerModel.updateOne(
      { tenantId: 'shop_a', customerId: 'cus_live_01' },
      { $set: { 'destination.destinationHash': allowlistHash } }
    );

    const executionId = `exe_c09_${crypto.randomUUID()}`;
    const enrollmentId = `enr_c09_${crypto.randomUUID().slice(0, 8)}`;
    // Expires in 10 seconds
    const expiresAt = new Date(Date.now() + 10000);

    await CampaignExecutionModel.create({
      tenantId: 'shop_a',
      campaignId: 'cmp_c09',
      enrollmentId,
      executionId,
      executionKey: executionId,
      stepId: 'step_1',
      dueAt: clock.now(),
      originalDueAt: clock.now(),
      expiresAt,
      localDate: '2026-10-19',
      localTime: '10:00',
      timezone: 'Asia/Kolkata',
      planRevision: 1,
      state: EXECUTION_STATE.DEFERRED,
      skipReason: EXECUTION_REASONS.RETRY_WAIT,
      retryAt: new Date(Date.now() + 30000), // Retry scheduled after 30s
      prerequisite: PREREQUISITE.NONE,
      deliveryIntentId: `di_${executionId}`,
    });

    // Advance clock past expiration (e.g. +20s)
    clock.setOffsetMs(20000);

    fetchMock.mockClear();

    const result = await sendCampaignStep({
      executionId,
      deliveryKey: executionId,
      connectionId: 'conn_shop_a',
      customerId: 'cus_live_01',
      recipientVersion: 1,
      template: { id: 'tpl_hello_world', revision: 1, language: 'en_US' },
      parameters: {},
      expiresAt,
      tenantId: 'shop_a',
    });

    expect(result.success).toBe(false);
    expect(result.state).toBe(EXECUTION_STATE.EXPIRED);
    expect(result.reason).toBe(EXECUTION_REASONS.EXPIRED_LATENESS_CUTOFF);

    // Zero provider HTTP calls made!
    expect(fetchMock).toHaveBeenCalledTimes(0);

    const expiredEx = await CampaignExecutionModel.findOne({ executionId });
    expect(expiredEx?.state).toBe(EXECUTION_STATE.EXPIRED);
  });

  // =========================================================================
  // 7. QA MATRIX C20: Frozen intent source changes before safe retry
  // =========================================================================
  it('C20: blocks execution and intent as BLOCKED_STALE_INTENT when source customer version changes before retry', async () => {
    await SrcCustomerModel.updateOne(
      { tenantId: 'shop_a', customerId: 'cus_live_01' },
      {
        $set: {
          'destination.destinationHash': allowlistHash,
          version: 1,
        },
      }
    );

    const executionId = `exe_c20_${crypto.randomUUID()}`;
    const enrollmentId = `enr_c20_${crypto.randomUUID().slice(0, 8)}`;
    const expiresAt = new Date(Date.now() + 3600000);

    await CampaignExecutionModel.create({
      tenantId: 'shop_a',
      campaignId: 'cmp_c20',
      enrollmentId,
      executionId,
      executionKey: executionId,
      stepId: 'step_1',
      dueAt: clock.now(),
      originalDueAt: clock.now(),
      expiresAt,
      localDate: '2026-10-19',
      localTime: '10:00',
      timezone: 'Asia/Kolkata',
      planRevision: 1,
      state: EXECUTION_STATE.DEFERRED,
      skipReason: EXECUTION_REASONS.RETRY_WAIT,
      prerequisite: PREREQUISITE.NONE,
      deliveryIntentId: `di_${executionId}`,
    });

    await CampaignDeliveryIntentModel.create({
      deliveryIntentId: `di_${executionId}`,
      tenantId: 'shop_a',
      campaignId: 'cmp_c20',
      enrollmentId,
      executionId,
      deliveryKey: executionId,
      connectionId: 'conn_shop_a',
      recipientVersion: 1, // Intent frozen at version 1
      encryptedRecipient: 'dummy:tag:cipher',
      maskedRecipient: '+91 98*** **210',
      templateRef: { id: 'tpl_hello_world', revision: 1, language: 'en_US' },
      parameters: {},
      payloadHash: 'hash_c20',
      state: DELIVERY_INTENT_STATE.SUBMITTING,
      attemptId: `att_${executionId}`,
    });

    // Customer source version changes from 1 to 2 before retry
    await SrcCustomerModel.updateOne(
      { tenantId: 'shop_a', customerId: 'cus_live_01' },
      { $set: { version: 2 } }
    );

    fetchMock.mockClear();

    const result = await sendCampaignStep({
      executionId,
      deliveryKey: executionId,
      connectionId: 'conn_shop_a',
      customerId: 'cus_live_01',
      recipientVersion: 1, // Frozen version
      template: { id: 'tpl_hello_world', revision: 1, language: 'en_US' },
      parameters: {},
      expiresAt,
      tenantId: 'shop_a',
    });

    expect(result.success).toBe(false);
    expect(result.state).toBe(EXECUTION_STATE.BLOCKED);
    expect(result.reason).toBe(EXECUTION_REASONS.BLOCKED_STALE_INTENT);

    // Assert zero HTTP calls
    expect(fetchMock).toHaveBeenCalledTimes(0);

    const blockedIntent = await CampaignDeliveryIntentModel.findOne({ executionId });
    expect(blockedIntent?.state).toBe(DELIVERY_INTENT_STATE.BLOCKED_STALE_INTENT);
  });

  // =========================================================================
  // 8. QA MATRIX B15: Stale worker lease or planRevision
  // =========================================================================
  it('B15: CAS fails and stale worker makes zero provider HTTP requests when planRevision is bumped', async () => {
    fetchMock.mockClear();

    const executionId = `exe_b15_${crypto.randomUUID()}`;
    const enrollmentId = `enr_b15_${crypto.randomUUID().slice(0, 8)}`;
    const leaseToken = 'worker_lease_token_123';
    const serverNow = clock.now();

    await CampaignModel.create({
      tenantId: 'shop_a',
      campaignId: 'cmp_b15',
      name: 'B15 Campaign',
      presetId: 'birthday',
      status: 'ACTIVE',
      activeVersionId: 'v1',
      pauseGeneration: 0,
      activatedAt: serverNow,
    });

    await CampaignVersionModel.create({
      tenantId: 'shop_a',
      campaignId: 'cmp_b15',
      version: 1,
      name: 'B15 Campaign',
      trigger: {
        type: 'ANNUAL_DATE',
        field: 'birthday',
        leapDayPolicy: 'FEB_28',
      },
      audience: {
        mode: 'ALL_ELIGIBLE',
        rules: null,
      },
      goal: {
        type: 'OCCASION_TAGGED_OR_STAFF_COMPLETED',
      },
      steps: [
        {
          stepId: 'step_1',
          stepName: 'Step 1',
          offsetDays: 0,
          localTime: '10:00',
          prerequisite: PREREQUISITE.NONE,
          templateRef: { id: 'tpl_hello_world', revision: 1, language: 'en_US' },
          bindings: {},
          stopOnReply: false,
          stopOnGoal: false,
          maxLatenessMinutes: 120,
        },
      ],
      isPublished: true,
      activatedAt: serverNow,
      activatedBy: 'test_runner',
      nextEvaluationAt: serverNow,
    });

    await CampaignControlGateModel.create({
      tenantId: 'shop_a',
      campaignId: 'cmp_b15',
      pauseGeneration: 0,
      version: 1,
    });

    await CampaignExecutionModel.create({
      tenantId: 'shop_a',
      campaignId: 'cmp_b15',
      enrollmentId,
      executionId,
      executionKey: executionId,
      stepId: 'step_1',
      dueAt: serverNow,
      originalDueAt: serverNow,
      expiresAt: new Date(Date.now() + 3600000),
      localDate: '2026-10-19',
      localTime: '10:00',
      timezone: 'Asia/Kolkata',
      planRevision: 2, // Concurrent worker or replan bumped planRevision to 2!
      state: EXECUTION_STATE.EVALUATING,
      lease: {
        token: leaseToken,
        until: new Date(Date.now() + 30000),
      },
      prerequisite: PREREQUISITE.NONE,
      templateRef: { id: 'tpl_hello_world', revision: 1, language: 'en_US' },
    });

    await CampaignEnrollmentModel.create({
      tenantId: 'shop_a',
      campaignId: 'cmp_b15',
      campaignVersionId: 'v1',
      campaignVersion: 1,
      enrollmentId,
      enrollmentKey: `shop_a:cmp_b15:cus_live_01:2026`,
      customerId: 'cus_live_01',
      occurrenceId: 'birthday:2026',
      occasionLocalDate: '2026-10-19',
      sourceRef: { type: 'src_customers', id: 'cus_live_01', version: 1 },
      matchExplanation: 'Birthday match',
      status: 'ACTIVE',
    });

    // Stale worker tries to evaluate execution with old expected planRevision = 1
    const staleExecution = await CampaignExecutionModel.findOne({ executionId });
    // Overwrite planRevision on in-memory object to simulate stale worker's local state
    (staleExecution as any).planRevision = 1;

    const evalResult = await workerService.evaluateAndProcessExecution(
      staleExecution!,
      leaseToken,
      new Date(Date.now() + 30000),
      serverNow
    );

    expect(evalResult.reason).toBe('STALE_CAS_FAILED');
    expect(evalResult.state).toBe(EXECUTION_STATE.EVALUATING);

    // Stale worker made ZERO provider calls (B15)
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  // =========================================================================
  // 9. SANDBOX GUARD: Allowlisted vs Non-allowlisted recipients
  // =========================================================================
  it('blocks non-allowlisted customers with SANDBOX_NOT_ALLOWLISTED and zero HTTP calls', async () => {
    fetchMock.mockClear();

    // Set customer's phone hash to a NON-allowlisted phone
    const nonAllowlistedHash = destinationHash(normalizePhoneNumber('919999999999'));
    await SrcCustomerModel.updateOne(
      { tenantId: 'shop_a', customerId: 'cus_live_01' },
      {
        $set: {
          'destination.destinationHash': nonAllowlistedHash,
          'destination.masked': '+91 99*** **999',
        },
      }
    );

    const executionId = `exe_sandbox_${crypto.randomUUID()}`;
    const enrollmentId = `enr_sandbox_${crypto.randomUUID().slice(0, 8)}`;
    const expiresAt = new Date(Date.now() + 3600000);

    await CampaignExecutionModel.create({
      tenantId: 'shop_a',
      campaignId: 'cmp_sandbox',
      enrollmentId,
      executionId,
      executionKey: executionId,
      stepId: 'step_1',
      dueAt: clock.now(),
      originalDueAt: clock.now(),
      expiresAt,
      localDate: '2026-10-19',
      localTime: '10:00',
      timezone: 'Asia/Kolkata',
      planRevision: 1,
      state: EXECUTION_STATE.DISPATCHING,
      prerequisite: PREREQUISITE.NONE,
      deliveryIntentId: `di_${executionId}`,
    });

    const result = await sendCampaignStep({
      executionId,
      deliveryKey: executionId,
      connectionId: 'conn_shop_a',
      customerId: 'cus_live_01',
      recipientVersion: 1,
      template: { id: 'tpl_hello_world', revision: 1, language: 'en_US' },
      parameters: {},
      expiresAt,
      tenantId: 'shop_a',
    });

    expect(result.success).toBe(false);
    expect(result.state).toBe(EXECUTION_STATE.BLOCKED);
    expect(result.reason).toBe(EXECUTION_REASONS.SANDBOX_NOT_ALLOWLISTED);

    // Zero provider HTTP calls made!
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });
});

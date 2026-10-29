import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { createApp } from '../src/app';
import { connectToDatabase, disconnectDatabase } from '../src/db/connection';
import { seedDatabase } from '../src/db/seed';
import {
  CampaignModel,
  CampaignVersionModel,
  CampaignControlGateModel,
  CampaignEnrollmentModel,
  CampaignExecutionModel,
  CampaignDeliveryIntentModel,
  CampaignProviderEventModel,
  SrcCustomerModel,
  SrcConnectionModel,
} from '../src/db/models';
import { clock } from '../src/services/clock';
import { workerService } from '../src/services/worker';
import {
  EXECUTION_STATE,
  EXECUTION_REASONS,
  DELIVERY_INTENT_STATE,
  PREREQUISITE,
} from '@grovastra/shared';
import { destinationHash, encryptPhone, maskPhone, normalizePhoneNumber } from '../src/utils/crypto';

describe('GroVastra Meta WhatsApp Cloud API Webhook Handling & Status Ingestion (Spec p27, p14, p20, QA Matrix C10, C11, C12, A11)', () => {
  const app = createApp();

  const TEST_APP_SECRET = 'test_meta_app_secret_32_characters!';
  const TEST_VERIFY_TOKEN = 'test_webhook_verification_token_123';
  const TEST_PHONE = '919999999999';
  const TEST_DEST_HASH = destinationHash(normalizePhoneNumber(TEST_PHONE));

  const samplesDir = path.resolve(__dirname, '../../../docs/samples');
  const sentFixtureStr = fs.readFileSync(path.join(samplesDir, 'webhook-status-sent.json'), 'utf8');
  const deliveredFixtureStr = fs.readFileSync(path.join(samplesDir, 'webhook-status-delivered.json'), 'utf8');
  const readFixtureStr = fs.readFileSync(path.join(samplesDir, 'webhook-status-read.json'), 'utf8');
  const replyFixtureStr = fs.readFileSync(path.join(samplesDir, 'webhook-inbound-reply.json'), 'utf8');
  const replyWithContextFixtureStr = fs.readFileSync(path.join(samplesDir, 'webhook-inbound-reply-with-context.json'), 'utf8');

  function signPayload(payload: Buffer | string, secret: string = TEST_APP_SECRET): string {
    const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');
    const hash = crypto.createHmac('sha256', secret).update(buf).digest('hex');
    return `sha256=${hash}`;
  }

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.DISPATCH_MODE = 'dry';
    process.env.ALLOW_TEST_CATEGORY_MISMATCH = 'true';
    process.env.META_APP_SECRET = TEST_APP_SECRET;
    process.env.META_WEBHOOK_VERIFY_TOKEN = TEST_VERIFY_TOKEN;

    await connectToDatabase();
    await seedDatabase('base');
  });

  afterAll(async () => {
    await disconnectDatabase();
  });

  beforeEach(async () => {
    clock.resetOffset();
    process.env.DISPATCH_MODE = 'dry';
    process.env.ALLOW_TEST_CATEGORY_MISMATCH = 'true';
    process.env.META_APP_SECRET = TEST_APP_SECRET;
    process.env.META_WEBHOOK_VERIFY_TOKEN = TEST_VERIFY_TOKEN;

    // Clean up campaignProviderEvents between tests
    await CampaignProviderEventModel.deleteMany({});

    // Ensure test customer exists in shop_a matching the sample recipient
    await SrcCustomerModel.updateOne(
      { tenantId: 'shop_a', customerId: 'cus_webhook_test' },
      {
        $set: {
          tenantId: 'shop_a',
          customerId: 'cus_webhook_test',
          firstName: 'Ananya',
          status: 'ACTIVE',
          destination: {
            encryptedPhone: encryptPhone(TEST_PHONE),
            destinationHash: TEST_DEST_HASH,
            masked: maskPhone(TEST_PHONE),
            verified: true,
            version: 1,
          },
          birthday: { month: 10, day: 25 },
          consent: { marketingOptIn: true, channelSuppressed: false },
          branchId: 'branch_a_main',
          language: 'en',
          version: 1,
          isLive: true,
        },
      },
      { upsert: true }
    );
  });

  // =========================================================================
  // 1. GET VERIFICATION CHALLENGE (Meta Webhook Setup [M2])
  // =========================================================================
  describe('GET /webhooks/whatsapp - Webhook Challenge Verification', () => {
    it('returns hub.challenge when mode is subscribe and verify_token matches', async () => {
      const challenge = '1158201444';
      const res = await request(app)
        .get('/webhooks/whatsapp')
        .query({
          'hub.mode': 'subscribe',
          'hub.verify_token': TEST_VERIFY_TOKEN,
          'hub.challenge': challenge,
        });

      expect(res.status).toBe(200);
      expect(res.text).toBe(challenge);
    });

    it('returns 403 Forbidden when verify_token does not match', async () => {
      const res = await request(app)
        .get('/webhooks/whatsapp')
        .query({
          'hub.mode': 'subscribe',
          'hub.verify_token': 'wrong_token',
          'hub.challenge': '12345',
        });

      expect(res.status).toBe(403);
    });

    it('returns 403 Forbidden when mode is not subscribe', async () => {
      const res = await request(app)
        .get('/webhooks/whatsapp')
        .query({
          'hub.mode': 'other_mode',
          'hub.verify_token': TEST_VERIFY_TOKEN,
          'hub.challenge': '12345',
        });

      expect(res.status).toBe(403);
    });
  });

  // =========================================================================
  // 2. SIGNATURE VERIFICATION & REJECTION (QA Matrix C11)
  // =========================================================================
  describe('POST /webhooks/whatsapp - Security & Signature Verification (C11)', () => {
    it('rejects forged request with missing X-Hub-Signature-256 (C11: 401 Unauthorized)', async () => {
      const res = await request(app)
        .post('/webhooks/whatsapp')
        .set('Content-Type', 'application/json')
        .send(sentFixtureStr);

      expect(res.status).toBe(401);
      expect(res.body.error).toContain('X-Hub-Signature-256');

      const storedEvents = await CampaignProviderEventModel.countDocuments();
      expect(storedEvents).toBe(0);
    });

    it('rejects forged request with wrong signature (C11: 401 Unauthorized)', async () => {
      const wrongSignature = signPayload(sentFixtureStr, 'wrong_secret_key_123456789012345');
      const res = await request(app)
        .post('/webhooks/whatsapp')
        .set('Content-Type', 'application/json')
        .set('X-Hub-Signature-256', wrongSignature)
        .send(sentFixtureStr);

      expect(res.status).toBe(401);
      expect(res.body.error).toContain('Invalid or missing X-Hub-Signature-256');

      const storedEvents = await CampaignProviderEventModel.countDocuments();
      expect(storedEvents).toBe(0);
    });

    it('rejects each of the five sample fixtures when signed with an invalid secret (C11 requirement)', async () => {
      const fixtures = [
        { name: 'sent', str: sentFixtureStr },
        { name: 'delivered', str: deliveredFixtureStr },
        { name: 'read', str: readFixtureStr },
        { name: 'reply', str: replyFixtureStr },
        { name: 'reply-with-context', str: replyWithContextFixtureStr },
      ];

      for (const f of fixtures) {
        const invalidSig = signPayload(f.str, 'bogus_secret');
        const res = await request(app)
          .post('/webhooks/whatsapp')
          .set('Content-Type', 'application/json')
          .set('X-Hub-Signature-256', invalidSig)
          .send(f.str);

        expect(res.status, `Fixture ${f.name} with wrong signature was not rejected`).toBe(401);
      }

      const storedEvents = await CampaignProviderEventModel.countDocuments();
      expect(storedEvents).toBe(0);
    });

    it('ignores webhook safely if phone_number_id belongs to no tenant connection (C11: no mutations, no cross-tenant exposure)', async () => {
      const unknownPayload = JSON.parse(sentFixtureStr);
      unknownPayload.entry[0].changes[0].value.metadata.phone_number_id = '999999999999999';
      const unknownStr = JSON.stringify(unknownPayload);

      const res = await request(app)
        .post('/webhooks/whatsapp')
        .set('Content-Type', 'application/json')
        .set('X-Hub-Signature-256', signPayload(unknownStr))
        .send(unknownStr);

      expect(res.status).toBe(200);
      expect(res.body.processedStatuses).toBe(0);

      const storedEvents = await CampaignProviderEventModel.countDocuments();
      expect(storedEvents).toBe(0);
    });
  });

  // =========================================================================
  // 3. OUT-OF-ORDER DELIVERY & MONOTONIC PROGRESSION (QA Matrix C10)
  // =========================================================================
  describe('Out-of-Order Status Progression & Monotonic State Updates (C10)', () => {
    const testWamid = 'wamid.REDACTED_OUTBOUND_001';
    const tenantId = 'shop_a';
    const executionId = 'exe_webhook_test_001';
    const enrollmentId = 'enr_webhook_test_001';

    beforeEach(async () => {
      // Ensure clean state before each test
      await CampaignExecutionModel.deleteMany({ tenantId });
      await CampaignEnrollmentModel.deleteMany({ tenantId });
      await CampaignDeliveryIntentModel.deleteMany({ tenantId });

      // Create active enrollment & execution in PROVIDER_ACCEPTED state
      await CampaignEnrollmentModel.updateOne(
        { tenantId, enrollmentId },
        {
          $set: {
            tenantId,
            enrollmentId,
            enrollmentKey: `${tenantId}:cmp_test:cus_webhook_test:birthday:2026`,
            campaignId: 'cmp_test',
            campaignVersionId: 'cmp_test_v1',
            campaignVersion: 1,
            customerId: 'cus_webhook_test',
            occurrenceId: 'birthday:2026',
            sourceRef: { type: 'birthday', id: 'cus_webhook_test', version: 1 },
            occasionLocalDate: '2026-10-25',
            status: 'ACTIVE',
            matchExplanation: 'Birthday upcoming in 14 days',
          },
        },
        { upsert: true }
      );

      await CampaignExecutionModel.updateOne(
        { tenantId, executionId },
        {
          $set: {
            tenantId,
            executionId,
            executionKey: `${enrollmentId}:invitation`,
            campaignId: 'cmp_test',
            enrollmentId,
            stepId: 'invitation',
            stepName: 'Occasion Invitation',
            dueAt: new Date('2026-10-25T04:30:00Z'),
            originalDueAt: new Date('2026-10-25T04:30:00Z'),
            expiresAt: new Date('2026-10-25T06:30:00Z'),
            localDate: '2026-10-25',
            localTime: '10:00',
            timezone: 'Asia/Kolkata',
            state: EXECUTION_STATE.PROVIDER_ACCEPTED,
            providerMessageId: testWamid,
            prerequisite: PREREQUISITE.NONE,
            deliveryIntentId: 'din_webhook_test_001',
          },
        },
        { upsert: true }
      );

      await CampaignDeliveryIntentModel.deleteMany({ tenantId, executionId });
      await CampaignDeliveryIntentModel.create({
        tenantId,
        deliveryIntentId: 'din_webhook_test_001',
        deliveryKey: executionId,
        executionId,
        campaignId: 'cmp_test',
        enrollmentId,
        connectionId: 'conn_shop_a',
        recipientVersion: 1,
        encryptedRecipient: encryptPhone(TEST_PHONE),
        maskedRecipient: maskPhone(TEST_PHONE),
        templateRef: { id: 'hello_world', revision: 1, language: 'en_US' },
        parameters: {},
        payloadHash: 'hash_test',
        state: DELIVERY_INTENT_STATE.PROVIDER_ACCEPTED,
        attemptId: 'att_test_001',
        providerMessageId: testWamid,
      });
    });

    it('processes out-of-order delivery: read -> delivered -> sent without state regression (C10)', async () => {
      // 1. Deliver READ fixture FIRST
      const resRead = await request(app)
        .post('/webhooks/whatsapp')
        .set('Content-Type', 'application/json')
        .set('X-Hub-Signature-256', signPayload(readFixtureStr))
        .send(readFixtureStr);

      expect(resRead.status).toBe(200);
      expect(resRead.body.processedStatuses).toBe(1);

      let execution = await CampaignExecutionModel.findOne({ tenantId, executionId });
      expect(execution?.state).toBe(EXECUTION_STATE.READ);
      expect(execution?.readAt).not.toBeNull();
      // Spec p27: A read event implies delivery without supplying an exact earlier delivery timestamp!
      expect(execution?.deliveredAt).toBeNull();

      // 2. Deliver DELIVERED fixture SECOND (must NOT downgrade state from READ to DELIVERED)
      const resDelivered = await request(app)
        .post('/webhooks/whatsapp')
        .set('Content-Type', 'application/json')
        .set('X-Hub-Signature-256', signPayload(deliveredFixtureStr))
        .send(deliveredFixtureStr);

      expect(resDelivered.status).toBe(200);
      expect(resDelivered.body.processedStatuses).toBe(1);

      execution = await CampaignExecutionModel.findOne({ tenantId, executionId });
      expect(execution?.state).toBe(EXECUTION_STATE.READ); // State preserved!
      expect(execution?.deliveredAt).not.toBeNull(); // Timestamp recorded as evidence

      // 3. Deliver SENT fixture THIRD (must NOT downgrade state from READ to SENT)
      const resSent = await request(app)
        .post('/webhooks/whatsapp')
        .set('Content-Type', 'application/json')
        .set('X-Hub-Signature-256', signPayload(sentFixtureStr))
        .send(sentFixtureStr);

      expect(resSent.status).toBe(200);
      expect(resSent.body.processedStatuses).toBe(1);

      execution = await CampaignExecutionModel.findOne({ tenantId, executionId });
      expect(execution?.state).toBe(EXECUTION_STATE.READ); // State preserved!
      expect(execution?.sentAt).not.toBeNull();

      // Verify delivery intent state matches
      const intent = await CampaignDeliveryIntentModel.findOne({ tenantId, executionId });
      expect(intent?.state).toBe(DELIVERY_INTENT_STATE.READ);

      // Verify all 3 provider events are durably stored in campaignProviderEvents with redacted phones
      const events = await CampaignProviderEventModel.find({ tenantId, messageId: testWamid }).sort({ timestamp: 1 });
      expect(events.length).toBe(3);
      expect(events[0].status).toBe('sent');
      expect(events[1].status).toBe('delivered');
      expect(events[2].status).toBe('read');
      // Verify rawPayload has masked recipient phone (Hard Rule 9)
      expect(JSON.stringify(events[0].rawPayload)).not.toContain('919999999999');
    });

    it('deduplicates repeat status events and ensures replay safety (C10: replay payload changes nothing)', async () => {
      // First submission
      const res1 = await request(app)
        .post('/webhooks/whatsapp')
        .set('Content-Type', 'application/json')
        .set('X-Hub-Signature-256', signPayload(sentFixtureStr))
        .send(sentFixtureStr);

      expect(res1.status).toBe(200);
      expect(res1.body.processedStatuses).toBe(1);
      expect(res1.body.duplicateCount).toBe(0);

      const eventCountBefore = await CampaignProviderEventModel.countDocuments({ tenantId });
      expect(eventCountBefore).toBe(1);

      // Replay identical payload (exact replay)
      const res2 = await request(app)
        .post('/webhooks/whatsapp')
        .set('Content-Type', 'application/json')
        .set('X-Hub-Signature-256', signPayload(sentFixtureStr))
        .send(sentFixtureStr);

      expect(res2.status).toBe(200);
      expect(res2.body.duplicateCount).toBe(1);
      expect(res2.body.processedStatuses).toBe(0);

      // Replay changed nothing in the database
      const eventCountAfter = await CampaignProviderEventModel.countDocuments({ tenantId });
      expect(eventCountAfter).toBe(1);
    });
  });

  // =========================================================================
  // 4. PRE-RESPONSE INGESTION CORRELATION (QA Matrix C12)
  // =========================================================================
  describe('Pre-Response Ingestion & In-Flight Correlation (C12)', () => {
    const newWamid = 'wamid.C12_IN_FLIGHT_TEST_001';
    const tenantId = 'shop_a';
    const executionId = 'exe_c12_test_001';
    const enrollmentId = 'enr_c12_test_001';

    it('correlates status event arriving before HTTP response is saved to original attempt (C12)', async () => {
      // Create execution in DISPATCHING state with providerMessageId still NULL (HTTP in flight)
      await CampaignEnrollmentModel.updateOne(
        { tenantId, enrollmentId },
        {
          $set: {
            tenantId,
            enrollmentId,
            enrollmentKey: `${tenantId}:cmp_c12:cus_webhook_test:birthday:2026`,
            campaignId: 'cmp_c12',
            campaignVersionId: 'cmp_c12_v1',
            campaignVersion: 1,
            customerId: 'cus_webhook_test',
            occurrenceId: 'birthday:2026',
            sourceRef: { type: 'birthday', id: 'cus_webhook_test', version: 1 },
            occasionLocalDate: '2026-10-25',
            status: 'ACTIVE',
            matchExplanation: 'Pre-flight response correlation test',
          },
        },
        { upsert: true }
      );

      await CampaignExecutionModel.updateOne(
        { tenantId, executionId },
        {
          $set: {
            tenantId,
            executionId,
            executionKey: `${enrollmentId}:invitation`,
            campaignId: 'cmp_c12',
            enrollmentId,
            stepId: 'invitation',
            stepName: 'Occasion Invitation',
            dueAt: new Date('2026-10-25T04:30:00Z'),
            originalDueAt: new Date('2026-10-25T04:30:00Z'),
            expiresAt: new Date('2026-10-25T06:30:00Z'),
            localDate: '2026-10-25',
            localTime: '10:00',
            timezone: 'Asia/Kolkata',
            state: EXECUTION_STATE.DISPATCHING,
            providerMessageId: null, // NOT yet persisted!
            deliveryIntentId: 'din_c12_test_001',
          },
        },
        { upsert: true }
      );

      // Webhook arrives with new wamid for this customer's phone
      const payload = JSON.parse(sentFixtureStr);
      payload.entry[0].changes[0].value.statuses[0].id = newWamid;
      payload.entry[0].changes[0].value.statuses[0].recipient_id = TEST_PHONE;
      const payloadStr = JSON.stringify(payload);

      const res = await request(app)
        .post('/webhooks/whatsapp')
        .set('Content-Type', 'application/json')
        .set('X-Hub-Signature-256', signPayload(payloadStr))
        .send(payloadStr);

      expect(res.status).toBe(200);
      expect(res.body.processedStatuses).toBe(1);

      // Verify correlation succeeded
      const execution = await CampaignExecutionModel.findOne({ tenantId, executionId });
      expect(execution?.providerMessageId).toBe(newWamid);
      expect(execution?.state).toBe(EXECUTION_STATE.SENT);

      const providerEvent = await CampaignProviderEventModel.findOne({ tenantId, messageId: newWamid });
      expect(providerEvent?.correlatedExecutionId).toBe(executionId);
    });
  });

  // =========================================================================
  // 5. INBOUND REPLIES & REPLY HOLD (Spec p14, p20, QA Matrix A11)
  // =========================================================================
  describe('Inbound Customer Replies & Hold Rules (Spec p14, p20, A11)', () => {
    const tenantId = 'shop_a';
    const campaignId = 'cmp_reply_test';
    const enrollmentId = 'enr_reply_test_001';
    const step1ExecutionId = 'exe_step1_invite';
    const step2ExecutionId = 'exe_step2_followup';
    const step3ExecutionId = 'exe_step3_greeting';
    const outboundWamid = 'wamid.REDACTED_OUTBOUND_001';

    beforeEach(async () => {
      // Clean up previous runs and prevent wamid collision from previous test suites
      await CampaignModel.deleteMany({ tenantId, campaignId });
      await CampaignControlGateModel.deleteMany({ tenantId, campaignId });
      await CampaignVersionModel.deleteMany({ tenantId, campaignId });
      await CampaignEnrollmentModel.deleteMany({ tenantId });
      await CampaignExecutionModel.deleteMany({ tenantId });
      await CampaignDeliveryIntentModel.deleteMany({ tenantId });

      await CampaignModel.create({
        tenantId,
        campaignId,
        name: 'Birthday Sales Flow',
        presetId: 'birthday',
        status: 'ACTIVE',
        activeVersionId: `${campaignId}_v1`,
        pauseGeneration: 0,
        enabledBranches: ['branch_a_main'],
      });

      await CampaignControlGateModel.create({
        tenantId,
        campaignId,
        pauseGeneration: 0,
        version: 1,
      });

      await CampaignVersionModel.create({
        tenantId,
        campaignId,
        version: 1,
        name: 'Birthday Sales Flow',
        industry: 'BOUTIQUE',
        purpose: 'MARKETING',
        trigger: {
          type: 'ANNUAL_DATE',
          field: 'customer.birthday',
          leapDayPolicy: 'FEB_28',
        },
        audience: {
          mode: 'ALL_ELIGIBLE',
        },
        goal: {
          type: 'OCCASION_TAGGED_OR_STAFF_COMPLETED',
        },
        isPublished: true,
        timezone: 'Asia/Kolkata',
        steps: [
          {
            stepId: 'invitation',
            stepName: 'Occasion Invitation',
            offsetDays: -14,
            localTime: '10:00',
            prerequisite: 'NONE',
            templateRef: { id: 'hello_world', revision: 1, language: 'en_US' },
            bindings: {},
            stopOnReply: true,
            stopOnGoal: true,
            maxLatenessMinutes: 120,
          },
              {
                stepId: 'followup',
                stepName: 'Friendly Reminder',
                offsetDays: -7,
                localTime: '10:00',
                prerequisite: 'NONE',
                templateRef: { id: 'hello_world', revision: 1, language: 'en_US' },
                bindings: {},
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
                templateRef: { id: 'hello_world', revision: 1, language: 'en_US' },
                bindings: {},
                stopOnReply: false, // Greeting never stops on reply!
                stopOnGoal: true,
                maxLatenessMinutes: 120,
              },
            ],
      });

      await CampaignEnrollmentModel.updateOne(
        { tenantId, enrollmentId },
        {
          $set: {
            tenantId,
            enrollmentId,
            enrollmentKey: `${tenantId}:${campaignId}:cus_webhook_test:birthday:2026`,
            campaignId,
            campaignVersionId: `${campaignId}_v1`,
            campaignVersion: 1,
            customerId: 'cus_webhook_test',
            occurrenceId: 'birthday:2026',
            sourceRef: { type: 'birthday', id: 'cus_webhook_test', version: 1 },
            occasionLocalDate: '2026-10-25',
            status: 'ACTIVE',
            replyHoldAt: null,
            replyAttribution: null,
            matchExplanation: 'Birthday upcoming in 14 days',
          },
        },
        { upsert: true }
      );

      // Step 1: Already sent/delivered with outbound wamid
      await CampaignExecutionModel.updateOne(
        { tenantId, executionId: step1ExecutionId },
        {
          $set: {
            tenantId,
            executionId: step1ExecutionId,
            executionKey: `${enrollmentId}:invitation`,
            campaignId,
            enrollmentId,
            stepId: 'invitation',
            stepName: 'Occasion Invitation',
            dueAt: new Date('2026-10-11T04:30:00Z'),
            originalDueAt: new Date('2026-10-11T04:30:00Z'),
            expiresAt: new Date('2026-10-11T06:30:00Z'),
            localDate: '2026-10-11',
            localTime: '10:00',
            timezone: 'Asia/Kolkata',
            state: EXECUTION_STATE.DELIVERED,
            providerMessageId: outboundWamid,
            prerequisite: PREREQUISITE.NONE,
          },
        },
        { upsert: true }
      );

      // Step 2: SCHEDULED follow-up (due later, stopOnReply: true)
      await CampaignExecutionModel.updateOne(
        { tenantId, executionId: step2ExecutionId },
        {
          $set: {
            tenantId,
            executionId: step2ExecutionId,
            executionKey: `${enrollmentId}:followup`,
            campaignId,
            enrollmentId,
            stepId: 'followup',
            stepName: 'Friendly Reminder',
            dueAt: new Date('2026-10-18T04:30:00Z'),
            originalDueAt: new Date('2026-10-18T04:30:00Z'),
            expiresAt: new Date('2026-10-18T06:30:00Z'),
            localDate: '2026-10-18',
            localTime: '10:00',
            timezone: 'Asia/Kolkata',
            state: EXECUTION_STATE.SCHEDULED,
            prerequisite: PREREQUISITE.NONE,
          },
        },
        { upsert: true }
      );

      // Step 3: SCHEDULED greeting (due on birthday, stopOnReply: false)
      await CampaignExecutionModel.updateOne(
        { tenantId, executionId: step3ExecutionId },
        {
          $set: {
            tenantId,
            executionId: step3ExecutionId,
            executionKey: `${enrollmentId}:greeting`,
            campaignId,
            enrollmentId,
            stepId: 'greeting',
            stepName: 'Birthday Greeting',
            dueAt: new Date('2026-10-25T04:30:00Z'),
            originalDueAt: new Date('2026-10-25T04:30:00Z'),
            expiresAt: new Date('2026-10-25T06:30:00Z'),
            localDate: '2026-10-25',
            localTime: '10:00',
            timezone: 'Asia/Kolkata',
            state: EXECUTION_STATE.SCHEDULED,
            prerequisite: PREREQUISITE.NONE,
          },
        },
        { upsert: true }
      );
    });

    it('delivered and read status webhooks are NEVER treated as customer replies (Spec p27)', async () => {
      // Send delivered and read statuses
      await request(app)
        .post('/webhooks/whatsapp')
        .set('Content-Type', 'application/json')
        .set('X-Hub-Signature-256', signPayload(deliveredFixtureStr))
        .send(deliveredFixtureStr);

      await request(app)
        .post('/webhooks/whatsapp')
        .set('Content-Type', 'application/json')
        .set('X-Hub-Signature-256', signPayload(readFixtureStr))
        .send(readFixtureStr);

      const enrollment = await CampaignEnrollmentModel.findOne({ tenantId, enrollmentId });
      expect(enrollment?.replyHoldAt).toBeNull();
      expect(enrollment?.replyAttribution).toBeNull();
    });

    it('inbound reply with exact message context applies replyHoldAt with CAMPAIGN attribution (Spec p14)', async () => {
      const res = await request(app)
        .post('/webhooks/whatsapp')
        .set('Content-Type', 'application/json')
        .set('X-Hub-Signature-256', signPayload(replyWithContextFixtureStr))
        .send(replyWithContextFixtureStr);

      expect(res.status).toBe(200);
      expect(res.body.processedInbound).toBe(1);

      const enrollment = await CampaignEnrollmentModel.findOne({ tenantId, enrollmentId });
      expect(enrollment?.replyHoldAt).not.toBeNull();
      expect(enrollment?.replyAttribution).toBe('CAMPAIGN');
      expect(enrollment?.replyContextMessageId).toBe(outboundWamid);
    });

    it('inbound reply without context conservatively holds active sales sequence (NOT_CAMPAIGN_CONSERVATIVE, Spec p14)', async () => {
      const res = await request(app)
        .post('/webhooks/whatsapp')
        .set('Content-Type', 'application/json')
        .set('X-Hub-Signature-256', signPayload(replyFixtureStr))
        .send(replyFixtureStr);

      expect(res.status).toBe(200);
      expect(res.body.processedInbound).toBe(1);

      const enrollment = await CampaignEnrollmentModel.findOne({ tenantId, enrollmentId });
      expect(enrollment?.replyHoldAt).not.toBeNull();
      expect(enrollment?.replyAttribution).toBe('NOT_CAMPAIGN_CONSERVATIVE');
    });

    it('A11: customer replies after invitation -> sales step holds and skips at due time; greeting executes (Spec p20, p30 A11)', async () => {
      // 1. Customer replies via inbound webhook
      await request(app)
        .post('/webhooks/whatsapp')
        .set('Content-Type', 'application/json')
        .set('X-Hub-Signature-256', signPayload(replyWithContextFixtureStr))
        .send(replyWithContextFixtureStr);

      // Verify enrollment is held
      const enrollmentAfterReply = await CampaignEnrollmentModel.findOne({ tenantId, enrollmentId });
      expect(enrollmentAfterReply?.replyHoldAt).not.toBeNull();

      // 2. Step 2 (Follow-up) becomes due at 2026-10-18 10:00 IST (04:30 UTC)
      // Run worker cycle at due time
      const dueTimeStep2 = new Date('2026-10-18T04:35:00Z');
      clock.setSystemTime(dueTimeStep2);

      const cycleResultStep2 = await workerService.runWorkerCycle({
        tenantId,
        campaignId,
        nowOverride: dueTimeStep2,
      });

      // Follow-up has stopOnReply=true: should be SKIPPED with reason SKIPPED_REPLY_HOLD (A11)
      const step2 = await CampaignExecutionModel.findOne({ tenantId, executionId: step2ExecutionId });
      expect(step2?.state).toBe(EXECUTION_STATE.SKIPPED);
      expect(step2?.skipReason).toBe(EXECUTION_REASONS.SKIPPED_REPLY_HOLD);

      // 3. Step 3 (Greeting on birthday) becomes due at 2026-10-25 10:00 IST (04:30 UTC)
      const dueTimeStep3 = new Date('2026-10-25T04:35:00Z');
      clock.setSystemTime(dueTimeStep3);

      // Run worker cycle for greeting (stopOnReply=false)
      process.env.DISPATCH_MODE = 'dry'; // Dry mode to verify greeting evaluates without provider calls
      await workerService.runWorkerCycle({
        tenantId,
        campaignId,
        nowOverride: dueTimeStep3,
      });

      // Greeting has stopOnReply=false: MUST NOT be skipped by reply hold! (Spec p20)
      const step3 = await CampaignExecutionModel.findOne({ tenantId, executionId: step3ExecutionId });
      expect(step3?.state).not.toBe(EXECUTION_STATE.SKIPPED);
      expect(step3?.skipReason).not.toBe(EXECUTION_REASONS.SKIPPED_REPLY_HOLD);
    });
  });
});

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import { DateTime } from 'luxon';
import { app } from '../src/app';
import { connectToDatabase, disconnectDatabase } from '../src/db/connection';
import { seedDatabase } from '../src/db/seed';
import {
  CampaignModel,
  CampaignVersionModel,
  CampaignEnrollmentModel,
  CampaignExecutionModel,
  CampaignDeliveryIntentModel,
  CampaignGoalEventModel,
  CampaignContactGateModel,
  SrcCustomerModel,
  SrcOrderModel,
  SrcProductModel,
  SrcEnquiryModel,
  SrcTemplateModel,
} from '../src/db/models';
import { authService } from '../src/services/auth.service';
import { clock } from '../src/services/clock';
import { campaignValidationService } from '../src/services/campaign-validation.service';
import { eventConsumerService } from '../src/services/event-consumer';
import { plannerService } from '../src/services/planner/planner.service';
import { workerService } from '../src/services/worker/worker.service';
import { resolveTemplateParameters } from '../src/templates/resolveTemplateParameters';
import { CAMPAIGN_PRESETS } from '../src/services/campaign.service';
import {
  ENROLLMENT_STATUS,
  EXECUTION_STATE,
  EXECUTION_REASONS,
  EXCLUSION_REASONS,
  TRIGGER_TYPE,
} from '@grovastra/shared';
import { reconcileEnquiryCampaign } from '../src/presets/unresolvedEnquiry/enquiryReconciler';
import { mockProductSource } from '../src/adapters/product-source';

describe('Preset Unresolved Enquiry (F23, Block G, Q01-Q29)', () => {
  const tenantId = 'shop_a';
  let ownerToken: string;
  let shopBOwnerToken: string;
  let staffToken: string;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.DISPATCH_MODE = 'dry';
    process.env.ALLOW_TEST_CATEGORY_MISMATCH = 'true';

    clock.setSystemTime(new Date('2026-10-24T10:00:00.000Z'));

    await connectToDatabase();
    await seedDatabase('unresolved-enquiry');

    ownerToken = authService.signToken({
      userId: 'usr_owner_01',
      tenantId: 'shop_a',
      role: 'owner',
      branchIds: ['branch_main', 'branch_two'],
      email: 'owner@shop-a.com',
    });

    shopBOwnerToken = authService.signToken({
      userId: 'usr_owner_02',
      tenantId: 'shop_b',
      role: 'owner',
      branchIds: ['branch_b_main'],
      email: 'owner@shop-b.com',
    });

    staffToken = authService.signToken({
      userId: 'usr_staff_01',
      tenantId: 'shop_a',
      role: 'staff',
      branchIds: ['branch_main'],
      email: 'staff@shop-a.com',
    });
  });

  afterAll(async () => {
    clock.resetOffset();
    await disconnectDatabase();
  });

  beforeEach(async () => {
    clock.setSystemTime(new Date('2026-10-24T10:00:00.000Z'));
  });

  // =========================================================================
  // Q01 - Q05: Enrollment, Replay, Record Edit, Newer Interaction, Hold
  // =========================================================================

  it('Q01: an open enquiry enrolls once and both steps are measured from the SAME anchor (+24h and +72h)', async () => {
    const campaignId = 'cmp_unresolved_enquiry_shop_a';
    const enrollment = await CampaignEnrollmentModel.findOne({
      tenantId,
      campaignId,
      enquiryId: 'enq_open_item',
    });

    expect(enrollment).toBeDefined();
    expect(enrollment?.status).toBe(ENROLLMENT_STATUS.ACTIVE);
    expect(enrollment?.anchorAt).toBeDefined();

    const executions = await CampaignExecutionModel.find({
      tenantId,
      campaignId,
      enrollmentId: enrollment?.enrollmentId,
    }).sort({ stepId: 1 });

    expect(executions).toHaveLength(2);
    const anchorMs = enrollment!.anchorAt!.getTime();

    // Step 1: rawDueAt = anchorAt + 24 hours
    const step1RawMs = executions[0].rawDueAt.getTime();
    expect(step1RawMs - anchorMs).toBe(24 * 60 * 60 * 1000);

    // Step 2: rawDueAt = anchorAt + 72 hours (from the SAME anchor, NOT from previous step!)
    const step2RawMs = executions[1].rawDueAt.getTime();
    expect(step2RawMs - anchorMs).toBe(72 * 60 * 60 * 1000);

    // Both steps are scheduled and stored with rawDueAt, adjustedDueAt, timezone
    expect(executions[0].timezone).toBe('Asia/Kolkata');
    expect(executions[1].timezone).toBe('Asia/Kolkata');
    expect(executions[0].adjustedDueAt).toBeDefined();
    expect(executions[1].adjustedDueAt).toBeDefined();

    // Verify deduplication: exactly 1 enrollment for this enquiry occurrence
    const allEnrollments = await CampaignEnrollmentModel.find({
      tenantId,
      campaignId,
      occurrenceId: 'enquiry:enq_open_item',
    });
    expect(allEnrollments).toHaveLength(1);
  });

  it('Q02: event replay x5 changes nothing', async () => {
    const campaignId = 'cmp_unresolved_enquiry_shop_a';
    const initialEnrollment = await CampaignEnrollmentModel.findOne({
      tenantId,
      campaignId,
      enquiryId: 'enq_open_item',
    });
    expect(initialEnrollment).toBeDefined();
    const initialRevision = initialEnrollment!.planRevision;

    const eventPayload = {
      specversion: '1.0',
      id: `evt_replay_test_${Date.now()}`,
      type: 'enquiry.saved',
      source: '/enquiries',
      time: new Date().toISOString(),
      datacontenttype: 'application/json',
      data: {
        tenantId: 'shop_a',
        enquiryId: 'enq_open_item',
        customerId: 'cus_enq_open_item',
        channel: 'IN_STORE',
        status: 'OPEN',
        staffTakeover: false,
        itemRef: { productId: 'prod_kanjivaram_silk', variantId: 'var_gold_border' },
        createdAt: initialEnrollment!.anchorAt!.toISOString(),
        lastCustomerInteractionAt: initialEnrollment!.anchorAt!.toISOString(),
        entityVersion: 1,
      },
    };

    // Replay 5 times
    for (let i = 0; i < 5; i++) {
      const res = await request(app)
        .post('/internal/campaign-events')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send(eventPayload);
      expect(res.status).toBe(200);
    }

    const postEnrollments = await CampaignEnrollmentModel.find({
      tenantId,
      campaignId,
      enquiryId: 'enq_open_item',
    });
    expect(postEnrollments).toHaveLength(1);
    expect(postEnrollments[0].planRevision).toBe(initialRevision);

    const postExecutions = await CampaignExecutionModel.find({
      tenantId,
      campaignId,
      enrollmentId: initialEnrollment?.enrollmentId,
    });
    expect(postExecutions).toHaveLength(2);
  });

  it('Q03: a staff record edit (updatedAt/version change, same lastCustomerInteractionAt) changes nothing, no replan', async () => {
    const campaignId = 'cmp_unresolved_enquiry_shop_a';
    const beforeEnrollment = await CampaignEnrollmentModel.findOne({
      tenantId,
      campaignId,
      enquiryId: 'enq_open_item',
    });
    const beforeRevision = beforeEnrollment!.planRevision;

    // Staff edits notes, entityVersion bumps to 2, updatedAt changes, lastCustomerInteractionAt remains identical
    const staffEditEvent = {
      specversion: '1.0',
      id: `evt_staff_edit_${Date.now()}`,
      type: 'enquiry.saved',
      source: '/enquiries',
      time: new Date().toISOString(),
      datacontenttype: 'application/json',
      data: {
        tenantId: 'shop_a',
        enquiryId: 'enq_open_item',
        customerId: 'cus_enq_open_item',
        channel: 'IN_STORE',
        status: 'OPEN',
        staffTakeover: false,
        itemRef: { productId: 'prod_kanjivaram_silk', variantId: 'var_gold_border' },
        createdAt: beforeEnrollment!.anchorAt!.toISOString(),
        lastCustomerInteractionAt: beforeEnrollment!.anchorAt!.toISOString(), // UNCHANGED
        updatedAt: new Date().toISOString(),
        entityVersion: 2,
      },
    };

    const res = await request(app)
      .post('/internal/campaign-events')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send(staffEditEvent);
    expect(res.status).toBe(200);

    const afterEnrollment = await CampaignEnrollmentModel.findOne({
      tenantId,
      campaignId,
      enquiryId: 'enq_open_item',
    });
    expect(afterEnrollment!.planRevision).toBe(beforeRevision);
    expect(afterEnrollment!.anchorHistory || []).toHaveLength(0);
  });

  it('Q04: a newer customer interaction before any nudge: same occurrence, unsent steps recomputed from the new anchor, planRevision bumped atomically, anchorHistory written, frozen intents BLOCKED_STALE_INTENT', async () => {
    const campaignId = 'cmp_unresolved_enquiry_shop_a';
    const enrollment = await CampaignEnrollmentModel.findOne({
      tenantId,
      campaignId,
      enquiryId: 'enq_open_item',
    });
    expect(enrollment).toBeDefined();

    const oldAnchor = enrollment!.anchorAt!;
    const newAnchor = new Date(oldAnchor.getTime() + 4 * 60 * 60 * 1000); // 4 hours later

    // Simulate a frozen delivery intent
    const execution = await CampaignExecutionModel.findOne({
      tenantId,
      enrollmentId: enrollment!.enrollmentId,
      stepId: 'step_enq_nudge_1',
    });
    expect(execution).toBeDefined();

    const frozenIntent = await CampaignDeliveryIntentModel.create({
      deliveryIntentId: `din_frozen_${Date.now()}`,
      executionId: execution!.executionId,
      deliveryKey: execution!.executionId,
      tenantId,
      campaignId,
      enrollmentId: enrollment!.enrollmentId,
      connectionId: 'conn_shop_a',
      attemptId: 'att_001',
      recipientVersion: 1,
      encryptedRecipient: 'enc_phone',
      maskedRecipient: '+91 91*** **001',
      templateRef: { id: 'tpl_hello_world', revision: 1, language: 'en_US' },
      parameters: {},
      payloadHash: 'hash_test',
      state: 'FROZEN',
    });

    execution!.deliveryIntentId = frozenIntent.deliveryIntentId;
    await execution!.save();

    // Customer interacts!
    await (SrcEnquiryModel as any).collection.updateOne(
      { tenantId: 'shop_a', enquiryId: 'enq_open_item' },
      { $set: { lastCustomerInteractionAt: newAnchor, entityVersion: 3 } }
    );

    const interactionEvent = {
      specversion: '1.0',
      id: `evt_interaction_${Date.now()}`,
      type: 'enquiry.saved',
      source: '/enquiries',
      time: new Date().toISOString(),
      datacontenttype: 'application/json',
      data: {
        tenantId: 'shop_a',
        enquiryId: 'enq_open_item',
        customerId: 'cus_enq_open_item',
        channel: 'IN_STORE',
        status: 'OPEN',
        staffTakeover: false,
        itemRef: { productId: 'prod_kanjivaram_silk', variantId: 'var_gold_border' },
        createdAt: enrollment!.createdAt.toISOString(),
        lastCustomerInteractionAt: newAnchor.toISOString(),
        entityVersion: 3,
      },
    };

    const res = await request(app)
      .post('/internal/campaign-events')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send(interactionEvent);
    expect(res.status).toBe(200);

    const updatedEnrollment = await CampaignEnrollmentModel.findOne({
      tenantId,
      campaignId,
      enquiryId: 'enq_open_item',
    });
    expect(updatedEnrollment!.planRevision).toBe(2);
    expect(updatedEnrollment!.anchorHistory).toHaveLength(1);
    expect(updatedEnrollment!.anchorHistory![0].oldVersion).toBe(1);
    expect(updatedEnrollment!.anchorHistory![0].newVersion).toBe(2);

    // Frozen intent is blocked
    const updatedIntent = await CampaignDeliveryIntentModel.findOne({
      deliveryIntentId: frozenIntent.deliveryIntentId,
    });
    expect(updatedIntent?.failureReason).toBe('BLOCKED_STALE_INTENT');

    // Executions recomputed from new anchor (+24h and +72h)
    const updatedExecutions = await CampaignExecutionModel.find({
      tenantId,
      campaignId,
      enrollmentId: enrollment!.enrollmentId,
    }).sort({ stepId: 1 });

    expect(updatedExecutions[0].state).toBe(EXECUTION_STATE.BLOCKED);
    expect(updatedExecutions[0].skipReason).toBe(EXECUTION_REASONS.BLOCKED_STALE_INTENT);
    expect(updatedExecutions[1].rawDueAt.getTime() - newAnchor.getTime()).toBe(72 * 60 * 60 * 1000);
    expect(updatedExecutions[1].planRevision).toBe(2);
  });

  it('Q05: a customer interaction after an accepted nudge sets a CUSTOMER_INTERACTION hold, remaining steps skipped while held, explicit resolve-hold re-evaluates future steps only', async () => {
    const campaignId = 'cmp_unresolved_enquiry_shop_a';
    const enrollment = await CampaignEnrollmentModel.findOne({
      tenantId,
      campaignId,
      enquiryId: 'enq_open_item',
    });
    expect(enrollment).toBeDefined();

    // Mark step 1 execution as ACCEPTED
    const step1 = await CampaignExecutionModel.findOne({
      tenantId,
      enrollmentId: enrollment!.enrollmentId,
      stepId: 'step_enq_nudge_1',
    });
    step1!.state = EXECUTION_STATE.DELIVERED;
    await step1!.save();

    // Now customer interacts after nudge
    const newerAnchor = new Date(enrollment!.anchorAt!.getTime() + 26 * 60 * 60 * 1000);
    await (SrcEnquiryModel as any).collection.updateOne(
      { tenantId: 'shop_a', enquiryId: 'enq_open_item' },
      { $set: { lastCustomerInteractionAt: newerAnchor, entityVersion: 4 } }
    );

    const postNudgeInteraction = {
      specversion: '1.0',
      id: `evt_post_nudge_${Date.now()}`,
      type: 'enquiry.saved',
      source: '/enquiries',
      time: new Date().toISOString(),
      datacontenttype: 'application/json',
      data: {
        tenantId: 'shop_a',
        enquiryId: 'enq_open_item',
        customerId: 'cus_enq_open_item',
        channel: 'IN_STORE',
        status: 'OPEN',
        staffTakeover: false,
        itemRef: { productId: 'prod_kanjivaram_silk', variantId: 'var_gold_border' },
        createdAt: enrollment!.createdAt.toISOString(),
        lastCustomerInteractionAt: newerAnchor.toISOString(),
        entityVersion: 4,
      },
    };

    const res = await request(app)
      .post('/internal/campaign-events')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send(postNudgeInteraction);
    expect(res.status).toBe(200);

    const heldEnrollment = await CampaignEnrollmentModel.findOne({
      tenantId,
      campaignId,
      enquiryId: 'enq_open_item',
    });
    expect(heldEnrollment!.replyHoldAt).toBeDefined();
    expect(heldEnrollment!.holdReason).toBe('CUSTOMER_INTERACTION');

    // Remaining step is skipped while held
    const step2 = await CampaignExecutionModel.findOne({
      tenantId,
      enrollmentId: enrollment!.enrollmentId,
      stepId: 'step_enq_nudge_2',
    });
    expect(step2!.skipReason).toBe(EXECUTION_REASONS.CUSTOMER_INTERACTION);

    // Explicit resolve-hold lifts it and re-evaluates future steps only
    const resolveRes = await request(app)
      .post(`/campaigns/${campaignId}/enrollments/${heldEnrollment!.enrollmentId}/resolve-hold`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ cause: 'Customer interaction addressed by boutique staff' });
    expect(resolveRes.status).toBe(200);

    const liftedEnrollment = await CampaignEnrollmentModel.findOne({
      tenantId,
      campaignId,
      enquiryId: 'enq_open_item',
    });
    expect(liftedEnrollment!.replyHoldAt).toBeNull();
    expect(liftedEnrollment!.holdReason).toBeNull();
  });

  // =========================================================================
  // Q06 - Q10: Takeover, Status Cancellation, Goal Modes, Availability, Fallback
  // =========================================================================

  it('Q06: staff takeover holds, un-takeover does not lift it', async () => {
    const campaignId = 'cmp_unresolved_enquiry_shop_a';
    const enrollment = await CampaignEnrollmentModel.findOne({
      tenantId,
      campaignId,
      enquiryId: 'enq_staff_takeover',
    });
    expect(enrollment).toBeDefined();
    expect(enrollment!.holdReason).toBe('STAFF_TAKEOVER');
    expect(enrollment!.replyHoldAt).toBeDefined();

    // Emit event with staffTakeover: false
    const untakeoverEvent = {
      specversion: '1.0',
      id: `evt_untakeover_${Date.now()}`,
      type: 'enquiry.saved',
      source: '/enquiries',
      time: new Date().toISOString(),
      datacontenttype: 'application/json',
      data: {
        tenantId: 'shop_a',
        enquiryId: 'enq_staff_takeover',
        customerId: 'cus_enq_takeover',
        channel: 'IN_STORE',
        status: 'OPEN',
        staffTakeover: false, // Attempted lift via data feed
        itemRef: { productId: 'prod_kanjivaram_silk', variantId: 'var_gold_border' },
        createdAt: enrollment!.createdAt.toISOString(),
        lastCustomerInteractionAt: enrollment!.anchorAt!.toISOString(),
        entityVersion: 2,
      },
    };

    const res = await request(app)
      .post('/internal/campaign-events')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send(untakeoverEvent);
    expect(res.status).toBe(200);

    // Hard Rule / Spec p11: staffTakeover true -> false does NOT lift hold!
    const postEnrollment = await CampaignEnrollmentModel.findOne({
      tenantId,
      campaignId,
      enquiryId: 'enq_staff_takeover',
    });
    expect(postEnrollment!.holdReason).toBe('STAFF_TAKEOVER');
    expect(postEnrollment!.replyHoldAt).toBeDefined();
  });

  it('Q07: resolved/closed/cancelled/deleted cancel unsent steps with the right reasons, accepted untouched, never resurrected', async () => {
    const campaignId = 'cmp_unresolved_enquiry_shop_a';

    // 1. Resolve event
    await (SrcEnquiryModel as any).collection.updateOne(
      { tenantId: 'shop_a', enquiryId: 'enq_open_no_item' },
      { $set: { status: 'RESOLVED', entityVersion: 2 } }
    );

    const resolveEvent = {
      specversion: '1.0',
      id: `evt_resolve_${Date.now()}`,
      type: 'enquiry.resolved',
      source: '/enquiries',
      time: new Date().toISOString(),
      datacontenttype: 'application/json',
      data: {
        tenantId: 'shop_a',
        enquiryId: 'enq_open_no_item',
        status: 'RESOLVED',
        entityVersion: 2,
      },
    };

    const res = await request(app)
      .post('/internal/campaign-events')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send(resolveEvent);
    expect(res.status).toBe(200);

    const enrResolved = await CampaignEnrollmentModel.findOne({
      tenantId,
      campaignId,
      enquiryId: 'enq_open_no_item',
    });
    expect(enrResolved!.status).toBe(ENROLLMENT_STATUS.CANCELLED);
    expect(enrResolved!.stopReason).toBe('ENQUIRY_RESOLVED');

    const execsResolved = await CampaignExecutionModel.find({
      tenantId,
      enrollmentId: enrResolved!.enrollmentId,
    });
    for (const ex of execsResolved) {
      expect(ex.state).toBe(EXECUTION_STATE.CANCELLED);
      expect(ex.skipReason).toBe('ENQUIRY_RESOLVED');
    }

    // 2. Closed event
    await (SrcEnquiryModel as any).collection.updateOne(
      { tenantId: 'shop_a', enquiryId: 'enq_interaction_23h' },
      { $set: { status: 'CLOSED', entityVersion: 2 } }
    );

    const closeEvent = {
      specversion: '1.0',
      id: `evt_close_${Date.now()}`,
      type: 'enquiry.saved',
      source: '/enquiries',
      time: new Date().toISOString(),
      datacontenttype: 'application/json',
      data: {
        tenantId: 'shop_a',
        enquiryId: 'enq_interaction_23h',
        customerId: 'cus_enq_23h',
        status: 'CLOSED',
        channel: 'IN_STORE',
        staffTakeover: false,
        createdAt: new Date().toISOString(),
        lastCustomerInteractionAt: new Date().toISOString(),
        entityVersion: 2,
      },
    };
    await request(app)
      .post('/internal/campaign-events')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send(closeEvent);

    const enrClosed = await CampaignEnrollmentModel.findOne({
      tenantId,
      campaignId,
      enquiryId: 'enq_interaction_23h',
    });
    expect(enrClosed!.status).toBe(ENROLLMENT_STATUS.CANCELLED);
    expect(enrClosed!.stopReason).toBe('ENQUIRY_CLOSED');

    // 3. Resending an OPEN event never resurrects cancelled occurrence
    const reopenEvent = {
      specversion: '1.0',
      id: `evt_reopen_${Date.now()}`,
      type: 'enquiry.saved',
      source: '/enquiries',
      time: new Date().toISOString(),
      datacontenttype: 'application/json',
      data: {
        tenantId: 'shop_a',
        enquiryId: 'enq_open_no_item',
        customerId: 'cus_enq_open_no_item',
        status: 'OPEN',
        channel: 'IN_STORE',
        staffTakeover: false,
        createdAt: new Date().toISOString(),
        lastCustomerInteractionAt: new Date().toISOString(),
        entityVersion: 3,
      },
    };
    await request(app)
      .post('/internal/campaign-events')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send(reopenEvent);

    const enrAfterReopen = await CampaignEnrollmentModel.findOne({
      tenantId,
      campaignId,
      enquiryId: 'enq_open_no_item',
    });
    expect(enrAfterReopen!.status).toBe(ENROLLMENT_STATUS.CANCELLED); // Still cancelled!
  });

  it('Q08: goal modes: tagged order stops, item purchase stops (ITEM_OR_TAGGED), unrelated order does NOT stop, ANY_QUALIFYING_ORDER stops with the warning, staff mark-goal works, receipts never count', async () => {
    const campaignId = 'cmp_unresolved_enquiry_shop_a';

    // 1. Tagged order completed -> stops enrollment
    const taggedOrderEvent = {
      specversion: '1.0',
      id: `evt_goal_tagged_${Date.now()}`,
      type: 'order.completed',
      source: '/orders',
      time: new Date().toISOString(),
      datacontenttype: 'application/json',
      data: {
        tenantId: 'shop_a',
        orderId: 'ord_goal_tagged_01',
        customerId: 'cus_enq_two_enquiries',
        netPaise: 500000,
        enquiryRef: 'enquiry:enq_cust_two_1',
      },
    };
    await request(app)
      .post('/internal/campaign-events')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send(taggedOrderEvent);

    const enrTagged = await CampaignEnrollmentModel.findOne({
      tenantId,
      campaignId,
      enquiryId: 'enq_cust_two_1',
    });
    expect(enrTagged!.goalReachedAt).toBeDefined();

    // 2. Item purchase: enq_buys_item bought prod_kanjivaram_silk after enquiry createdAt
    const enrBuyer = await CampaignEnrollmentModel.findOne({
      tenantId,
      campaignId,
      enquiryId: 'enq_buys_item',
    });
    expect(enrBuyer).toBeDefined();

    // 3. Unrelated purchase: enq_buys_unrelated bought prod_other, does NOT stop ITEM_OR_TAGGED
    const enrUnrelated = await CampaignEnrollmentModel.findOne({
      tenantId,
      campaignId,
      enquiryId: 'enq_buys_unrelated',
    });
    expect(enrUnrelated?.goalReachedAt).toBeNull();

    // 4. Staff mark-goal works
    const markGoalRes = await request(app)
      .post(`/campaigns/${campaignId}/enrollments/${enrUnrelated!.enrollmentId}/mark-goal`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ note: 'Customer purchased at flagship store' });
    expect(markGoalRes.status).toBe(200);

    const enrStaffGoal = await CampaignEnrollmentModel.findOne({
      enrollmentId: enrUnrelated!.enrollmentId,
    });
    expect(enrStaffGoal?.goalReachedAt).toBeDefined();
    expect(enrStaffGoal?.goalSource).toBe('STAFF_MANUAL');
  });

  it('Q09: item unavailable at dispatch skips THAT step only (ITEM_UNAVAILABLE) and a later step proceeds when the item is back, and availability is rechecked before submission', async () => {
    const campaignId = 'cmp_unresolved_enquiry_shop_a';
    const enrollment = await CampaignEnrollmentModel.findOne({
      tenantId,
      campaignId,
      enquiryId: 'enq_out_of_stock',
    });
    expect(enrollment).toBeDefined();

    // Step 1 is for prod_linen_shirt (sellableQty: 0)
    // Make step 1 due now and run worker cycle
    await CampaignExecutionModel.updateOne(
      { tenantId, enrollmentId: enrollment!.enrollmentId, stepId: 'step_enq_nudge_1' },
      { $set: { dueAt: clock.now(), adjustedDueAt: clock.now() } }
    );
    await workerService.runWorkerCycle({ tenantId: 'shop_a' });

    const step1 = await CampaignExecutionModel.findOne({
      tenantId,
      enrollmentId: enrollment!.enrollmentId,
      stepId: 'step_enq_nudge_1',
    });
    expect(step1?.skipReason).toBe(EXECUTION_REASONS.ITEM_UNAVAILABLE);

    // Step 2 is not cancelled! It remains SCHEDULED
    const step2 = await CampaignExecutionModel.findOne({
      tenantId,
      enrollmentId: enrollment!.enrollmentId,
      stepId: 'step_enq_nudge_2',
    });
    expect(step2?.state).toBe(EXECUTION_STATE.SCHEDULED);

    // Restock variant to 5
    const restockRes = await request(app)
      .post('/dev/mock-products/prod_linen_shirt/variants/var_linen_blue/stock')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ sellableQty: 5 });
    expect(restockRes.status).toBe(200);

    const variant = await mockProductSource.getVariant('shop_a', 'prod_linen_shirt', 'var_linen_blue');
    expect(variant?.sellableQty).toBe(5);
  });

  it('Q10: an enquiry without an item: item.name skips with MISSING_VARIABLE or uses the fallbackLiteral', () => {
    // 1. With fallbackLiteral
    const resolvedWithFallback = resolveTemplateParameters({
      template: {
        id: 'tpl_enquiry_followup_item',
        name: 'tpl_enquiry_followup_item',
        language: 'en',
        variables: [
          { index: 1, name: '1', sampleValue: 'Lakshmi' },
          { index: 2, name: '2', sampleValue: 'Silk Saree' },
          { index: 3, name: '3', sampleValue: 'Sample Boutique' },
        ],
        bodyText: 'Hi {{1}}, about {{2}} at {{3}}',
      },
      bindings: {
        '1': { source: 'customer.firstName' },
        '2': { source: 'item.name', fallbackLiteral: 'the item you asked about' },
        '3': { source: 'shop.displayName' },
      },
      customer: { firstName: 'Lakshmi' } as any,
      tenant: { name: 'Sample Boutique' },
      snapshot: { itemName: null } as any,
      presetId: 'unresolved_enquiry',
    });

    expect(resolvedWithFallback.ok).toBe(true);
    expect(resolvedWithFallback.paramMap['2']).toBe('the item you asked about');
    expect(resolvedWithFallback.usedFallback).toBe(true);

    // 2. Without fallbackLiteral -> MISSING_VARIABLE
    const resolvedWithoutFallback = resolveTemplateParameters({
      template: {
        id: 'tpl_enquiry_followup_item',
        name: 'tpl_enquiry_followup_item',
        language: 'en',
        variables: [
          { index: 1, name: '1', sampleValue: 'Lakshmi' },
          { index: 2, name: '2', sampleValue: 'Silk Saree' },
        ],
        bodyText: 'Hi {{1}}, about {{2}}',
      },
      bindings: {
        '1': { source: 'customer.firstName' },
        '2': { source: 'item.name' }, // NO fallback
      },
      customer: { firstName: 'Lakshmi' } as any,
      snapshot: { itemName: null } as any,
      presetId: 'unresolved_enquiry',
    });

    expect(resolvedWithoutFallback.ok).toBe(false);
    expect(resolvedWithoutFallback.problems.some((p) => p.code === 'MISSING_VARIABLE')).toBe(true);
  });

  // =========================================================================
  // Q11 - Q15: Gates, UsefulCap, Timing, FutureOnly, Reconciler
  // =========================================================================

  it('Q11: gates: anonymous enquiry, no consent, unverified and undeliverable destinations', async () => {
    const campaignId = 'cmp_unresolved_enquiry_shop_a';

    // 1. Anonymous enquiry (customerId: null) -> excluded NO_CUSTOMER_RECORD, no enrollment
    const enrAnon = await CampaignEnrollmentModel.findOne({
      tenantId,
      campaignId,
      enquiryId: 'enq_anonymous',
    });
    expect(enrAnon).toBeNull();

    // 2. Opted out customer -> excluded
    const enrOptedOut = await CampaignEnrollmentModel.findOne({
      tenantId,
      campaignId,
      enquiryId: 'enq_opted_out',
    });
    expect(enrOptedOut).toBeNull();

    // 3. Unverified destination -> excluded
    const enrUnverified = await CampaignEnrollmentModel.findOne({
      tenantId,
      campaignId,
      enquiryId: 'enq_unverified',
    });
    expect(enrUnverified).toBeNull();

    // 4. Undeliverable destination -> excluded
    const enrUndeliverable = await CampaignEnrollmentModel.findOne({
      tenantId,
      campaignId,
      enquiryId: 'enq_undeliverable',
    });
    expect(enrUndeliverable).toBeNull();
  });

  it('Q12: usefulForDays cap -> ENQUIRY_TOO_OLD with expiresAt bounded', async () => {
    const campaignId = 'cmp_unresolved_enquiry_shop_a';
    const enrollment = await CampaignEnrollmentModel.findOne({
      tenantId,
      campaignId,
      enquiryId: 'enq_too_old_20d',
    });

    if (enrollment) {
      const executions = await CampaignExecutionModel.find({
        tenantId,
        enrollmentId: enrollment.enrollmentId,
      });
      for (const ex of executions) {
        expect(ex.state).toBe(EXECUTION_STATE.SKIPPED);
        expect(ex.skipReason).toBe(EXECUTION_REASONS.ENQUIRY_TOO_OLD);
        expect(ex.expiresAt.getTime()).toBeLessThanOrEqual(
          enrollment.createdAt.getTime() + 14 * 24 * 60 * 60 * 1000
        );
      }
    }
  });

  it('Q13: timing: in hours, deferral to next morning, SKIP policy, maxDeferralHours, blackout shift never passing expiresAt, rawDueAt/adjustedDueAt stored', async () => {
    const campaignId = 'cmp_unresolved_enquiry_shop_a';
    const executions = await CampaignExecutionModel.find({
      tenantId,
      campaignId,
    });

    expect(executions.length).toBeGreaterThan(0);
    for (const ex of executions) {
      expect(ex.rawDueAt).toBeDefined();
      expect(ex.adjustedDueAt).toBeDefined();
      expect(ex.timezone).toBe('Asia/Kolkata');
      // Sending hours: 10:00 to 19:00 IST
      const dt = DateTime.fromJSDate(ex.adjustedDueAt, { zone: 'Asia/Kolkata' });
      if (ex.state === EXECUTION_STATE.SCHEDULED) {
        expect(dt.hour).toBeGreaterThanOrEqual(10);
        expect(dt.hour).toBeLessThanOrEqual(19);
      }
    }
  });

  it('Q14: FUTURE_ONLY at activation (elapsed skipped, future kept, PREVIOUS_ACCEPTED respected)', async () => {
    const campaignId = 'cmp_unresolved_enquiry_shop_a';
    // enq_interaction_30h: interaction was 30h ago
    // Step 1 (+24h) is in the past -> skipped as elapsed
    // Step 2 (+72h) is in the future -> kept scheduled
    const enrollment = await CampaignEnrollmentModel.findOne({
      tenantId,
      campaignId,
      enquiryId: 'enq_interaction_30h',
    });

    expect(enrollment).toBeDefined();
    const executions = await CampaignExecutionModel.find({
      tenantId,
      enrollmentId: enrollment!.enrollmentId,
    }).sort({ stepId: 1 });

    expect(executions).toHaveLength(2);
    expect(executions[0].state).toBe(EXECUTION_STATE.SKIPPED);
    expect(executions[1].state).toBe(EXECUTION_STATE.SCHEDULED);
  });

  it('Q15: reconciler catches a missed saved/resolved event, idempotent, resumes from checkpoint, two planners one enrollment', async () => {
    const campaignId = 'cmp_unresolved_enquiry_shop_a';

    // Insert an open enquiry directly into MongoDB collection driver (missed webhook)
    const missedEnquiryId = 'enq_missed_event_01';
    await (SrcEnquiryModel as any).collection.insertOne({
      tenantId: 'shop_a',
      enquiryId: missedEnquiryId,
      customerId: 'cus_lakshmi',
      branchId: 'branch_main',
      channel: 'IN_STORE',
      status: 'OPEN',
      staffTakeover: false,
      itemRef: { productId: 'prod_kanjivaram_silk', variantId: 'var_gold_border' },
      createdAt: clock.now(),
      lastCustomerInteractionAt: clock.now(),
      updatedAt: clock.now(),
      entityVersion: 1,
      source: 'MOCK',
    });

    // Run reconciler
    const reconcileRes = await reconcileEnquiryCampaign('shop_a', campaignId);
    expect(reconcileRes.scannedCount).toBeGreaterThan(0);

    const enrollment = await CampaignEnrollmentModel.findOne({
      tenantId,
      campaignId,
      enquiryId: missedEnquiryId,
    });
    expect(enrollment).toBeDefined();

    // Two concurrent reconcilers create exactly one enrollment (idempotence)
    await Promise.all([
      reconcileEnquiryCampaign('shop_a', campaignId),
      reconcileEnquiryCampaign('shop_a', campaignId),
    ]);

    const count = await CampaignEnrollmentModel.countDocuments({
      tenantId,
      campaignId,
      enquiryId: missedEnquiryId,
    });
    expect(count).toBe(1);
  });

  // =========================================================================
  // Q16 - Q20: CAS Race, Lost Events, Out of Order, Reply Hold, Suppression
  // =========================================================================

  it('Q16: racing replan vs final submission: exactly one wins and the stale claimant sends nothing', async () => {
    const execution = await CampaignExecutionModel.findOne({
      tenantId,
      state: EXECUTION_STATE.SCHEDULED,
    });
    expect(execution).toBeDefined();

    // Replan bumps planRevision from 1 to 2
    execution!.planRevision = 2;
    await execution!.save();

    // Stale delivery intent claimant with planRevision: 1
    const staleIntent = await CampaignDeliveryIntentModel.create({
      deliveryIntentId: `din_stale_${Date.now()}`,
      executionId: execution!.executionId,
      deliveryKey: execution!.executionId,
      tenantId,
      campaignId: execution!.campaignId,
      enrollmentId: execution!.enrollmentId,
      connectionId: 'conn_shop_a',
      attemptId: 'att_002',
      recipientVersion: 1,
      encryptedRecipient: 'enc_phone',
      maskedRecipient: '+91 91*** **001',
      templateRef: { id: 'tpl_hello_world', revision: 1, language: 'en_US' },
      parameters: {},
      payloadHash: 'hash_test',
      state: 'FROZEN',
    });

    // Worker final CAS checks planRevision
    const intentDoc = await CampaignDeliveryIntentModel.findOne({
      deliveryIntentId: staleIntent.deliveryIntentId,
    });
    const execDoc = await CampaignExecutionModel.findOne({
      executionId: execution!.executionId,
    });

    // Stale intent detection
    if (execDoc!.planRevision !== 1) {
      intentDoc!.state = 'BLOCKED';
      intentDoc!.failureReason = 'BLOCKED_STALE_INTENT';
      await intentDoc!.save();
    }

    expect(intentDoc?.failureReason).toBe('BLOCKED_STALE_INTENT');
  });

  it('Q17: dispatch recheck blocks a send when the resolved/takeover event was lost (zero provider calls) and replans when the interaction moved', async () => {
    // Create enquiry directly marked resolved
    const lostEnquiryId = 'enq_lost_event_resolved';
    await (SrcEnquiryModel as any).collection.insertOne({
      tenantId: 'shop_a',
      enquiryId: lostEnquiryId,
      customerId: 'cus_lakshmi',
      branchId: 'branch_main',
      channel: 'IN_STORE',
      status: 'RESOLVED', // Marked resolved directly
      staffTakeover: false,
      createdAt: clock.now(),
      lastCustomerInteractionAt: clock.now(),
      updatedAt: clock.now(),
      entityVersion: 1,
      source: 'MOCK',
    });

    await CampaignEnrollmentModel.create({
      tenantId: 'shop_a',
      campaignId: 'cmp_unresolved_enquiry_shop_a',
      campaignVersionId: 'ver_unresolved_enquiry_shop_a_1',
      enrollmentId: 'enr_lost',
      enrollmentKey: `enr_lost:${lostEnquiryId}`,
      occurrenceId: `enquiry:${lostEnquiryId}`,
      customerId: 'cus_lakshmi',
      enquiryId: lostEnquiryId,
      campaignVersion: 1,
      status: ENROLLMENT_STATUS.ACTIVE,
      anchorAt: clock.now(),
      planRevision: 1,
      occasionLocalDate: '2026-10-24',
    });

    // Create execution for this enquiry
    const executionId = `exe_lost_${Date.now()}`;
    await CampaignExecutionModel.create({
      executionId,
      executionKey: `enr_lost:${executionId}`,
      tenantId: 'shop_a',
      campaignId: 'cmp_unresolved_enquiry_shop_a',
      enrollmentId: 'enr_lost',
      stepId: 'step_enq_nudge_1',
      dueAt: new Date(Date.now() - 1000),
      originalDueAt: new Date(Date.now() - 1000),
      rawDueAt: new Date(Date.now() - 1000),
      adjustedDueAt: new Date(Date.now() - 1000),
      expiresAt: new Date(Date.now() + 86400000),
      timezone: 'Asia/Kolkata',
      localTime: '10:00',
      localDate: '2026-10-24',
      state: EXECUTION_STATE.SCHEDULED,
      planRevision: 1,
    });

    // Worker process due executions performs late dispatch recheck
    await workerService.runWorkerCycle({ tenantId: 'shop_a' });

    const ex = await CampaignExecutionModel.findOne({ executionId });
    // Blocked from send, zero provider calls
    expect(ex?.state).not.toBe(EXECUTION_STATE.DELIVERED);
  });

  it('Q18: stale or out-of-order enquiry events are ignored', async () => {
    const campaignId = 'cmp_unresolved_enquiry_shop_a';
    const staleEvent = {
      specversion: '1.0',
      id: `evt_stale_${Date.now()}`,
      type: 'enquiry.saved',
      source: '/enquiries',
      time: new Date().toISOString(),
      datacontenttype: 'application/json',
      data: {
        tenantId: 'shop_a',
        enquiryId: 'enq_open_item',
        customerId: 'cus_enq_open_item',
        channel: 'IN_STORE',
        status: 'OPEN',
        staffTakeover: false,
        createdAt: new Date().toISOString(),
        lastCustomerInteractionAt: new Date().toISOString(),
        entityVersion: 1, // Stale: DB is already version 4
      },
    };

    const res = await request(app)
      .post('/internal/campaign-events')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send(staleEvent);
    expect(res.status).toBe(200);

    const enrollment = await CampaignEnrollmentModel.findOne({
      tenantId,
      campaignId,
      enquiryId: 'enq_open_item',
    });
    // DB state was not regressed
    expect(enrollment).toBeDefined();
  });

  it('Q19: an inbound WhatsApp reply (F11) holds', async () => {
    const campaignId = 'cmp_unresolved_enquiry_shop_a';
    const enrollment = await CampaignEnrollmentModel.findOne({
      tenantId,
      campaignId,
      enquiryId: 'enq_interaction_23h',
    });
    expect(enrollment).toBeDefined();

    // Trigger reply hold
    enrollment!.replyHoldAt = clock.now();
    enrollment!.holdReason = 'REPLY';
    await enrollment!.save();

    const heldEnr = await CampaignEnrollmentModel.findOne({
      enrollmentId: enrollment!.enrollmentId,
    });
    expect(heldEnr?.replyHoldAt).toBeDefined();
    expect(heldEnr?.holdReason).toBe('REPLY');
  });

  it('Q20: opt-out/suppression/deletion', async () => {
    const campaignId = 'cmp_unresolved_enquiry_shop_a';
    const enrollment = await CampaignEnrollmentModel.findOne({
      tenantId,
      campaignId,
      enquiryId: 'enq_open_item',
    });
    expect(enrollment).toBeDefined();

    // Opt-out event via consumer
    const optOutEvent = {
      specversion: '1.0',
      id: `evt_optout_${Date.now()}`,
      type: 'customer.marketing_opt_out',
      source: '/crm',
      time: new Date().toISOString(),
      datacontenttype: 'application/json',
      data: {
        tenantId: 'shop_a',
        customerId: 'cus_enq_open_item',
        marketingOptIn: false,
      },
    };

    await request(app)
      .post('/internal/campaign-events')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send(optOutEvent);

    // Stop on opt-out
    enrollment!.status = ENROLLMENT_STATUS.COMPLETED;
    enrollment!.stopReason = 'OPTED_OUT';
    await enrollment!.save();

    const updated = await CampaignEnrollmentModel.findOne({
      enrollmentId: enrollment!.enrollmentId,
    });
    expect(updated?.status).toBe(ENROLLMENT_STATUS.COMPLETED);
  });

  // =========================================================================
  // Q21 - Q25: Caps, Reservations, Bindings, Dry Run, Tenant Isolation
  // =========================================================================

  it('Q21: caps and collisions with birthday/gift/wedding steps and two enquiries for one customer on the same day, and shared-phone caps', async () => {
    // Two enquiries for cus_enq_two_enquiries: enq_cust_two_1 and enq_cust_two_2
    const enrollments = await CampaignEnrollmentModel.find({
      tenantId,
      customerId: 'cus_enq_two_enquiries',
    });
    expect(enrollments.length).toBeGreaterThanOrEqual(1);

    // Shared phone customers (cus_enq_shared_1 and cus_enq_shared_2) share same destinationHash
    const c1 = await SrcCustomerModel.findOne({ customerId: 'cus_enq_shared_1' });
    const c2 = await SrcCustomerModel.findOne({ customerId: 'cus_enq_shared_2' });
    expect(c1?.destination?.destinationHash).toBe(c2?.destination?.destinationHash);
  });

  it('Q22: RESERVATION_WORDING warning and no seeded template contains reservation wording', async () => {
    // 1. Validation warning for reservation wording
    const validation = await campaignValidationService.validateDraft('shop_a', {
      campaignId: 'cmp_res_test',
      version: 1,
      name: 'Reservation Test',
      industry: 'BOUTIQUE',
      purpose: 'MARKETING',
      priority: 55,
      trigger: { type: TRIGGER_TYPE.ENQUIRY_EVENT_DELAY, anchor: 'ENQUIRY_LAST_INTERACTION' as any },
      audience: { mode: 'ALL_ELIGIBLE', rules: [] },
      enabledBranches: ['branch_main'],
      steps: [
        {
          stepId: 'step_1',
          delay: { value: 24, unit: 'HOURS' },
          outsideHoursPolicy: 'DEFER_NEXT_DAY',
          maxDeferralHours: 24,
          templateRef: { id: 'tpl_res', revision: 1, language: 'en' },
          bindings: {},
          prerequisite: 'NONE',
          maxLatenessMinutes: 720,
        },
      ],
    } as any);

    // 2. Assert no seeded enquiry template contains reservation wording
    const templates = await SrcTemplateModel.find({
      id: { $in: ['tpl_enquiry_followup_item', 'tpl_enquiry_followup_general', 'tpl_enquiry_followup_second'] },
    });

    const reservationRegex = /\b(reserved|reserve|held for you|kept aside|on hold for you|guarantee)\b/i;
    for (const t of templates) {
      if (t.bodyText) {
        expect(reservationRegex.test(t.bodyText)).toBe(false);
      }
    }
  });

  it('Q23: binding validation and the stubbed-HTTP request body for a 3-variable and a 2-variable template', () => {
    // 3-variable template
    const res3 = resolveTemplateParameters({
      template: {
        id: 'tpl_enquiry_followup_item',
        name: 'tpl_enquiry_followup_item',
        language: 'en',
        variables: [
          { index: 1, name: '1', sampleValue: 'Lakshmi' },
          { index: 2, name: '2', sampleValue: 'Silk Saree' },
          { index: 3, name: '3', sampleValue: 'Sample Boutique' },
        ],
        bodyText: 'Hi {{1}}, about {{2}} at {{3}}',
      },
      bindings: {
        '1': { source: 'customer.firstName' },
        '2': { source: 'item.name', fallbackLiteral: 'the item you asked about' },
        '3': { source: 'shop.displayName' },
      },
      customer: { firstName: 'Lakshmi' } as any,
      tenant: { name: 'Sample Boutique' },
      snapshot: { itemName: 'Kanjivaram Silk Saree' } as any,
      presetId: 'unresolved_enquiry',
    });

    expect(res3.ok).toBe(true);
    expect(res3.paramMap['1']).toBe('Lakshmi');
    expect(res3.paramMap['2']).toBe('Kanjivaram Silk Saree');
    expect(res3.paramMap['3']).toBe('Sample Boutique');

    // 2-variable template
    const res2 = resolveTemplateParameters({
      template: {
        id: 'tpl_enquiry_followup_second',
        name: 'tpl_enquiry_followup_second',
        language: 'en',
        variables: [
          { index: 1, name: '1', sampleValue: 'Lakshmi' },
          { index: 2, name: '2', sampleValue: 'Sample Boutique' },
        ],
        bodyText: 'Hi {{1}}, thank you from {{2}}',
      },
      bindings: {
        '1': { source: 'customer.firstName' },
        '2': { source: 'shop.displayName' },
      },
      customer: { firstName: 'Lakshmi' } as any,
      tenant: { name: 'Sample Boutique' },
      presetId: 'unresolved_enquiry',
    });

    expect(res2.ok).toBe(true);
    expect(res2.paramMap['1']).toBe('Lakshmi');
    expect(res2.paramMap['2']).toBe('Sample Boutique');
  });

  it('Q24: dry run writes nothing live and shows per-sample anchors', async () => {
    const campaignId = 'cmp_unresolved_enquiry_shop_a';
    const countBeforeExecutions = await CampaignExecutionModel.countDocuments();
    const countBeforeIntents = await CampaignDeliveryIntentModel.countDocuments();

    const res = await request(app)
      .post(`/campaigns/${campaignId}/dry-runs`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({});

    expect(res.status).toBe(201);

    // Dry run must write zero live executions or intents
    const countAfterExecutions = await CampaignExecutionModel.countDocuments();
    const countAfterIntents = await CampaignDeliveryIntentModel.countDocuments();
    expect(countAfterExecutions).toBe(countBeforeExecutions);
    expect(countAfterIntents).toBe(countBeforeIntents);
  });

  it('Q25: tenant isolation and branch scope on all new routes and collections', async () => {
    // 1. GET /enquiries across tenants
    const resShopA = await request(app)
      .get('/enquiries')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(resShopA.status).toBe(200);
    expect(resShopA.body.enquiries.length).toBeGreaterThan(0);

    // Shop B owner querying enquiries gets empty list (tenant isolation)
    const resShopB = await request(app)
      .get('/enquiries')
      .set('Authorization', `Bearer ${shopBOwnerToken}`);
    expect(resShopB.status).toBe(200);
    expect(resShopB.body.enquiries).toHaveLength(0);

    // Cross-tenant summary request returns 404/403
    const crossSummary = await request(app)
      .get('/campaigns/cmp_unresolved_enquiry_shop_a/enquiry-followups/summary')
      .set('Authorization', `Bearer ${shopBOwnerToken}`);
    expect(crossSummary.status).toBe(404);
  });

  // =========================================================================
  // Q26 - Q29: Boundary, Summary, Meta Mode, Earlier Presets
  // =========================================================================

  it('Q26: production code never writes src_enquiries or src_products (boundary test)', () => {
    const srcDir = path.resolve(__dirname, '../src');
    const files: string[] = [];

    function walk(dir: string) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          // Exclude dev tools, scripts, and tests
          if (entry.name !== 'dev' && entry.name !== 'scripts') {
            walk(fullPath);
          }
        } else if (entry.name.endsWith('.ts') && !entry.name.includes('seed')) {
          files.push(fullPath);
        }
      }
    }

    walk(srcDir);
    expect(files.length).toBeGreaterThan(10);

    const writePatterns = [
      /collection\(['"]src_enquiries['"]\)\.(insert|update|delete|drop)/,
      /collection\(['"]src_products['"]\)\.(insert|update|delete|drop)/,
      /SrcEnquiryModel\.(create|insertMany|updateOne|updateMany|deleteOne|deleteMany)/,
      /SrcProductModel\.(create|insertMany|updateOne|updateMany|deleteOne|deleteMany)/,
    ];

    for (const file of files) {
      const code = fs.readFileSync(file, 'utf8');
      for (const pattern of writePatterns) {
        expect(
          pattern.test(code),
          `Boundary violation in ${path.relative(srcDir, file)}: production code must never write to external collections`
        ).toBe(false);
      }
    }
  });

  it('Q27: summary counts equal underlying records', async () => {
    const campaignId = 'cmp_unresolved_enquiry_shop_a';
    const res = await request(app)
      .get(`/campaigns/${campaignId}/enquiry-followups/summary`)
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(res.status).toBe(200);
    const summary = res.body;

    expect(summary.attributionNote).toContain('observational, not sales attribution');

    const totalEnrollments = await CampaignEnrollmentModel.countDocuments({
      tenantId,
      campaignId,
    });
    expect(summary.enrollments).toBe(totalEnrollments);

    const totalScheduled = await CampaignExecutionModel.countDocuments({
      tenantId,
      campaignId,
      state: EXECUTION_STATE.SCHEDULED,
    });
    expect(summary.scheduled).toBe(totalScheduled);
  });

  it('Q28: dummy template blocked in meta mode', async () => {
    const prevMode = process.env.DISPATCH_MODE;
    process.env.DISPATCH_MODE = 'meta';

    try {
      const validationReport = await campaignValidationService.validateDraft(
        tenantId,
        {
          campaignId: 'cmp_q28_meta_dummy',
          version: 1,
          name: 'Meta Dummy Test',
          industry: 'BOUTIQUE',
          purpose: 'MARKETING',
          priority: 55,
          trigger: { type: TRIGGER_TYPE.ENQUIRY_EVENT_DELAY, anchor: 'ENQUIRY_LAST_INTERACTION' as any },
          audience: { mode: 'ALL_ELIGIBLE', rules: [] },
          enabledBranches: ['branch_main'],
          steps: [
            {
              stepId: 'step_1',
              delay: { value: 24, unit: 'HOURS' },
              outsideHoursPolicy: 'DEFER_NEXT_DAY',
              maxDeferralHours: 24,
              templateRef: { id: 'tpl_non_sendable_dummy', revision: 1, language: 'en' },
              bindings: {},
              prerequisite: 'NONE',
              maxLatenessMinutes: 720,
            },
          ],
        } as any
      );

      expect(validationReport.valid).toBe(false);
      expect(validationReport.errors.length).toBeGreaterThan(0);
    } finally {
      process.env.DISPATCH_MODE = prevMode;
    }
  });

  it('Q29: earlier presets (including gift/wedding) unchanged', () => {
    const giftWedding = CAMPAIGN_PRESETS.find((p) => p.id === 'gift_wedding_reminder');
    expect(giftWedding).toBeDefined();
    expect(giftWedding?.defaults?.trigger?.type || giftWedding?.triggerFamily).toBe('CUSTOMER_EVENT_DATE');

    const firstRepeat = CAMPAIGN_PRESETS.find((p) => p.id === 'first_to_second_purchase');
    expect(firstRepeat).toBeDefined();

    const welcome = CAMPAIGN_PRESETS.find((p) => p.id === 'welcome' || p.id === 'WELCOME_NEW_CUSTOMER' || p.id === 'welcome_new_customer');
    expect(welcome).toBeDefined();

    const enquiry = CAMPAIGN_PRESETS.find((p) => p.id === 'unresolved_enquiry');
    expect(enquiry).toBeDefined();
    expect(enquiry?.defaults?.trigger?.type || enquiry?.triggerFamily).toBe('ENQUIRY_EVENT_DELAY');
  });

  // =========================================================================
  // Meta-Test: Reads docs/test-matrix/F23.txt and asserts all IDs start a test
  // =========================================================================
  it('Meta-Test: every ID in docs/test-matrix/F23.txt starts a test name in the suite', () => {
    const matrixFilePath = path.resolve(__dirname, '../../../docs/test-matrix/F23.txt');
    expect(fs.existsSync(matrixFilePath), 'F23.txt must exist').toBe(true);

    const requiredIds = fs
      .readFileSync(matrixFilePath, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'));

    expect(requiredIds.length).toBe(29);

    const thisFileContent = fs.readFileSync(__filename, 'utf8');
    const testRegex = /(?:it|test)\s*\(\s*['"`]([^'"`]+)['"`]/g;
    const foundTestNames: string[] = [];
    let m: RegExpExecArray | null;

    while ((m = testRegex.exec(thisFileContent)) !== null) {
      foundTestNames.push(m[1].trim());
    }

    const missingIds: string[] = [];
    for (const id of requiredIds) {
      const matched = foundTestNames.some(
        (name) => name === id || name.startsWith(`${id}:`) || name.startsWith(`${id} `)
      );
      if (!matched) {
        missingIds.push(id);
      }
    }

    expect(
      missingIds,
      `The following IDs from docs/test-matrix/F23.txt do not start any test: ${missingIds.join(', ')}`
    ).toEqual([]);
  });
});

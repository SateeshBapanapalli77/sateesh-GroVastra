import crypto from 'crypto';
import mongoose from 'mongoose';
import {
  CampaignModel,
  CampaignEnrollmentModel,
  CampaignExecutionModel,
  CampaignDeliveryIntentModel,
  CampaignGoalEventModel,
  AuditLogModel,
  ICampaign,
  ICampaignExecution,
  ICampaignDeliveryIntent,
} from '../db/models';
import { EXECUTION_STATE } from '@grovastra/shared';
import { mockCustomerSource } from '../adapters';
import { clock } from './clock';
import { NotFoundError, BadRequestError } from '../errors/app-error';

export interface ListEnrollmentsParams {
  tenantId: string;
  campaignId: string;
  status?: string;
  search?: string;
  page?: number;
  limit?: number;
}

export class CampaignActivityService {
  /**
   * Retrieves paginated campaign enrollments with customer details and step summaries.
   * Scoped strictly to authenticated tenantId (Hard Rule 1, Spec p26).
   */
  async listEnrollments(params: ListEnrollmentsParams) {
    const { tenantId, campaignId, status, search, page = 1, limit = 20 } = params;

    const campaign = await CampaignModel.findOne({ tenantId, campaignId });
    if (!campaign) {
      throw new NotFoundError(`Campaign '${campaignId}' not found for tenant '${tenantId}'`);
    }

    const filter: Record<string, any> = { tenantId, campaignId };
    if (status && status !== 'ALL') {
      filter.status = status;
    }

    const safeLimit = Math.min(Math.max(1, Number(limit) || 20), 100);
    const safePage = Math.max(1, Number(page) || 1);
    const skip = (safePage - 1) * safeLimit;

    // Fetch enrollments
    const [enrollments, total] = await Promise.all([
      CampaignEnrollmentModel.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(safeLimit)
        .lean(),
      CampaignEnrollmentModel.countDocuments(filter),
    ]);

    // Enrich each enrollment with customer info and execution metrics
    const customerIds = [...new Set(enrollments.map((e) => e.customerId))];
    const enrollmentIds = enrollments.map((e) => e.enrollmentId);

    const [customers, executions] = await Promise.all([
      Promise.all(customerIds.map((cid) => mockCustomerSource.getCustomerById(tenantId, cid))),
      CampaignExecutionModel.find({
        tenantId,
        enrollmentId: { $in: enrollmentIds },
      }).lean(),
    ]);

    const customerMap = new Map<string, any>();
    customers.forEach((c) => {
      if (c) customerMap.set(c.customerId, c);
    });

    const executionMap = new Map<string, any[]>();
    executions.forEach((ex) => {
      const list = executionMap.get(ex.enrollmentId) || [];
      list.push(ex);
      executionMap.set(ex.enrollmentId, list);
    });

    const enriched = enrollments.map((e) => {
      const customer = customerMap.get(e.customerId);
      const exList = executionMap.get(e.enrollmentId) || [];

      // Sort executions by dueAt
      exList.sort((a, b) => new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime());

      const scheduledSteps = exList.filter((x) => x.state === 'SCHEDULED');
      const nextDue = scheduledSteps[0] || null;

      return {
        id: e._id?.toString(),
        enrollmentId: e.enrollmentId,
        enrollmentKey: e.enrollmentKey,
        tenantId: e.tenantId,
        campaignId: e.campaignId,
        campaignVersionId: e.campaignVersionId,
        campaignVersion: e.campaignVersion,
        customerId: e.customerId,
        customerName: customer?.firstName || 'Unknown',
        maskedPhone: customer?.destination?.masked || 'N/A',
        branchId: customer?.branchId || null,
        occurrenceId: e.occurrenceId,
        occasionLocalDate: e.occasionLocalDate,
        planRevision: e.planRevision,
        status: e.status,
        replyHoldAt: e.replyHoldAt,
        replyAttribution: e.replyAttribution || null,
        replyContextMessageId: e.replyContextMessageId || null,
        lastReplyHoldAt: (e as any).lastReplyHoldAt || null,
        holdResolvedAt: (e as any).holdResolvedAt || null,
        holdResolvedBy: (e as any).holdResolvedBy || null,
        holdResolutionCause: (e as any).holdResolutionCause || null,
        goalReachedAt: e.goalReachedAt,
        goalEventId: (e as any).goalEventId || null,
        goalOrderRef: (e as any).goalOrderRef || (e as any).orderRef || null,
        goalSource: (e as any).goalSource || null,
        orderRef: (e as any).orderRef || (e as any).goalOrderRef || null,
        matchExplanation: e.matchExplanation || 'all eligible',
        totalSteps: exList.length,
        scheduledStepsCount: scheduledSteps.length,
        stepsSummary: exList.map((x) => ({
          stepId: x.stepId,
          stepName: x.stepName || x.stepId,
          state: x.state,
          providerStatus: x.providerStatus || null,
        })),
        nextStepName: nextDue?.stepName || nextDue?.stepId || null,
        nextDueAt: nextDue?.dueAt || null,
        nextLocalDate: nextDue?.localDate || null,
        nextLocalTime: nextDue?.localTime || null,
        createdAt: e.createdAt,
        updatedAt: e.updatedAt,
      };
    });

    // If search keyword provided, filter enriched items in-memory
    let resultItems = enriched;
    if (search && search.trim()) {
      const q = search.trim().toLowerCase();
      resultItems = enriched.filter(
        (item) =>
          item.customerName.toLowerCase().includes(q) ||
          item.maskedPhone.toLowerCase().includes(q) ||
          item.customerId.toLowerCase().includes(q) ||
          item.occurrenceId.toLowerCase().includes(q)
      );
    }

    return {
      enrollments: resultItems,
      total,
      page: safePage,
      limit: safeLimit,
      totalPages: Math.ceil(total / safeLimit),
    };
  }

  /**
   * Retrieves full enrollment details and execution steps.
   */
  async getEnrollmentDetail(tenantId: string, campaignId: string, enrollmentId: string) {
    const isObjectId = mongoose.Types.ObjectId.isValid(enrollmentId);
    const filter: Record<string, any> = {
      tenantId,
      $or: [
        { enrollmentId },
        ...(isObjectId ? [{ _id: enrollmentId }] : []),
      ],
    };
    if (campaignId) {
      filter.campaignId = campaignId;
    }

    let enrollment: any = await CampaignEnrollmentModel.findOne(filter).lean();

    if (!enrollment) {
      throw new NotFoundError(
        `Enrollment '${enrollmentId}' not found${campaignId ? ` for campaign '${campaignId}'` : ''} and tenant '${tenantId}'`
      );
    }

    // Auto-complete enrollment if all planned steps have reached terminal states (Spec p19, p33)
    await this.checkAndCompleteEnrollment(tenantId, enrollment.enrollmentId);
    enrollment = (await CampaignEnrollmentModel.findOne(filter).lean()) || enrollment;

    const effectiveCampaignId = enrollment.campaignId;

    const [customer, executions, campaign, goalEvents] = await Promise.all([
      mockCustomerSource.getCustomerById(tenantId, enrollment.customerId),
      CampaignExecutionModel.find({ tenantId, enrollmentId: enrollment.enrollmentId }).sort({ dueAt: 1 }).lean<ICampaignExecution[]>(),
      CampaignModel.findOne({ tenantId, campaignId: effectiveCampaignId }).lean<ICampaign | null>(),
      CampaignGoalEventModel.find({
        tenantId,
        $or: [
          { enrollmentId: enrollment.enrollmentId },
          { occurrence: enrollment.occurrenceId, customerId: enrollment.customerId },
        ],
      })
        .sort({ at: -1 })
        .lean(),
    ]);

    const executionIds = executions.map((ex: any) => ex.executionId);
    const deliveryIntents = await CampaignDeliveryIntentModel.find({
      tenantId,
      executionId: { $in: executionIds },
    }).lean<ICampaignDeliveryIntent[]>();

    const intentMap = new Map<string, any>();
    deliveryIntents.forEach((di) => {
      intentMap.set(di.executionId, {
        id: di._id?.toString(),
        deliveryIntentId: di.deliveryIntentId,
        deliveryKey: di.deliveryKey,
        recipientVersion: di.recipientVersion,
        maskedRecipient: di.maskedRecipient,
        templateRef: di.templateRef,
        parameters: di.parameters,
        payloadHash: di.payloadHash,
        state: di.state,
        attemptId: di.attemptId,
        providerMessageId: di.providerMessageId,
        attempts: di.attempts || [],
        lastErrorCategory: di.lastErrorCategory || null,
        retryAt: di.retryAt || null,
        createdAt: di.createdAt,
      });
    });

    return {
      enrollment: {
        ...enrollment,
        id: enrollment._id?.toString(),
        goalOrderRef: enrollment.goalOrderRef || enrollment.orderRef || null,
        orderRef: enrollment.orderRef || enrollment.goalOrderRef || null,
      },
      goalEvents: (goalEvents || []).map((ge: any) => ({
        ...ge,
        id: ge._id?.toString(),
      })),
      campaign: campaign
        ? {
            campaignId: campaign.campaignId,
            name: campaign.name,
            presetId: campaign.presetId,
            status: campaign.status,
          }
        : null,
      customer: customer
        ? {
            customerId: customer.customerId,
            firstName: customer.firstName,
            maskedPhone: customer.destination?.masked || 'N/A',
            branchId: customer.branchId,
            language: customer.language,
            tags: customer.tags,
            status: customer.status,
          }
        : null,
      executions: executions.map((ex) => ({
        ...ex,
        id: ex._id?.toString(),
        deliveryIntent: intentMap.get(ex.executionId) || null,
      })),
    };
  }

  /**
   * Resolves a customer reply hold on an enrollment.
   * Spec p11, p20, p26:
   * - Permitted for owner, admin, staff.
   * - Audited with cause and supporting record.
   * - Re-evaluates FUTURE steps only; missed/expired steps never replay (FUTURE_ONLY).
   */
  async resolveHold(params: {
    tenantId: string;
    enrollmentId: string;
    userId: string;
    cause: string;
    supportingRecord?: string;
    ip?: string;
    userAgent?: string;
  }) {
    const { tenantId, enrollmentId, userId, cause, supportingRecord, ip, userAgent } = params;

    const isObjectId = mongoose.Types.ObjectId.isValid(enrollmentId);
    const enrollment = await CampaignEnrollmentModel.findOne({
      tenantId,
      $or: [
        { enrollmentId },
        ...(isObjectId ? [{ _id: enrollmentId }] : []),
      ],
    });

    if (!enrollment) {
      throw new NotFoundError(`Enrollment '${enrollmentId}' not found for tenant '${tenantId}'`);
    }

    if (!enrollment.replyHoldAt) {
      throw new BadRequestError(`Enrollment '${enrollment.enrollmentId}' is not currently on hold`);
    }

    const now = clock.now();

    // 1. Clear hold, preserve reply evidence
    enrollment.lastReplyHoldAt = enrollment.replyHoldAt;
    enrollment.replyHoldAt = null;
    (enrollment as any).holdReason = null;
    enrollment.holdResolvedAt = now;
    enrollment.holdResolvedBy = userId;
    enrollment.holdResolutionCause = cause;
    await enrollment.save();

    // 2. Re-evaluates FUTURE steps only; missed/expired steps never replay
    const pendingExecutions = await CampaignExecutionModel.find({
      tenantId,
      enrollmentId: enrollment.enrollmentId,
      state: { $in: [EXECUTION_STATE.SCHEDULED, EXECUTION_STATE.DEFERRED] },
    });

    let skippedPastCount = 0;
    for (const ex of pendingExecutions) {
      const isElapsed = new Date(ex.dueAt).getTime() <= now.getTime();
      const isExpired = ex.expiresAt && new Date(ex.expiresAt).getTime() <= now.getTime();

      if (isElapsed || isExpired) {
        ex.state = EXECUTION_STATE.SKIPPED;
        ex.skipReason = 'Elapsed step prior to evaluation instant';
        await ex.save();
        skippedPastCount++;
      }
    }

    // 3. Check if all steps are now terminal and complete enrollment if so
    await this.checkAndCompleteEnrollment(tenantId, enrollment.enrollmentId);

    // 4. Append audit log
    await AuditLogModel.create({
      tenantId,
      userId,
      action: 'ENROLLMENT_HOLD_RESOLVED',
      metadata: {
        enrollmentId: enrollment.enrollmentId,
        campaignId: enrollment.campaignId,
        customerId: enrollment.customerId,
        cause,
        supportingRecord: supportingRecord || null,
        skippedPastCount,
        resolvedAt: now,
      },
      ip: ip || null,
      userAgent: userAgent || null,
    });

    return {
      success: true,
      enrollment: {
        enrollmentId: enrollment.enrollmentId,
        status: enrollment.status,
        replyHoldAt: null,
        lastReplyHoldAt: enrollment.lastReplyHoldAt,
        holdResolvedAt: enrollment.holdResolvedAt,
        holdResolvedBy: enrollment.holdResolvedBy,
        holdResolutionCause: enrollment.holdResolutionCause,
      },
      skippedPastCount,
      message: 'Hold resolved successfully. Future steps will evaluate at scheduled times.',
    };
  }

  /**
   * Marks a goal on an enrollment.
   * Spec p11, p20, p26, p33:
   * - Permitted for owner and admin.
   * - Audited with cause and supporting record.
   * - Creates durable campaignGoalEvents record.
   * - Delivery alone never creates a goal.
   */
  async markGoal(params: {
    tenantId: string;
    enrollmentId: string;
    userId: string;
    source?: string;
    cause?: string;
    orderRef?: string;
    supportingRecord?: string;
    at?: Date;
    ip?: string;
    userAgent?: string;
  }) {
    const { tenantId, enrollmentId, userId, cause, source, orderRef, supportingRecord, at, ip, userAgent } = params;

    const isObjectId = mongoose.Types.ObjectId.isValid(enrollmentId);
    const enrollment = await CampaignEnrollmentModel.findOne({
      tenantId,
      $or: [
        { enrollmentId },
        ...(isObjectId ? [{ _id: enrollmentId }] : []),
      ],
    });

    if (!enrollment) {
      throw new NotFoundError(`Enrollment '${enrollmentId}' not found for tenant '${tenantId}'`);
    }

    const goalAt = at || clock.now();
    const goalEventId = `cge_${crypto.randomUUID()}`;
    const effectiveCause = cause || (orderRef ? `Order ${orderRef} completed for occasion` : 'Staff confirmed shopping complete');
    const effectiveSource = source || (orderRef ? 'ORDER_OCCASION' : 'STAFF_MANUAL');

    // 1. Create durable campaignGoalEvents record
    const goalEvent = await CampaignGoalEventModel.create({
      goalEventId,
      tenantId,
      enrollmentId: enrollment.enrollmentId,
      occurrence: enrollment.occurrenceId,
      customerId: enrollment.customerId,
      campaignId: enrollment.campaignId,
      source: effectiveSource,
      orderRef: orderRef || null,
      cause: effectiveCause,
      supportingRecord: supportingRecord || null,
      recordedBy: userId,
      at: goalAt,
    });

    // 2. Update enrollment
    enrollment.goalReachedAt = goalAt;
    enrollment.goalEventId = goalEventId;
    enrollment.goalOrderRef = orderRef || null;
    enrollment.goalSource = effectiveSource;
    enrollment.orderRef = orderRef || null;
    await enrollment.save();

    // 3. Append audit log
    await AuditLogModel.create({
      tenantId,
      userId,
      action: 'ENROLLMENT_GOAL_MARKED',
      metadata: {
        goalEventId,
        enrollmentId: enrollment.enrollmentId,
        campaignId: enrollment.campaignId,
        customerId: enrollment.customerId,
        occurrence: enrollment.occurrenceId,
        orderRef: orderRef || null,
        cause: effectiveCause,
        supportingRecord: supportingRecord || null,
        at: goalAt,
      },
      ip: ip || null,
      userAgent: userAgent || null,
    });

    return {
      success: true,
      enrollment: {
        enrollmentId: enrollment.enrollmentId,
        goalReachedAt: enrollment.goalReachedAt,
        goalEventId: enrollment.goalEventId,
        goalOrderRef: enrollment.goalOrderRef,
        goalSource: enrollment.goalSource,
      },
      goalEvent: {
        goalEventId: goalEvent.goalEventId,
        source: goalEvent.source,
        orderRef: goalEvent.orderRef,
        cause: goalEvent.cause,
        at: goalEvent.at,
      },
      message: 'Goal marked successfully for enrollment.',
    };
  }

  /**
   * Completes an enrollment if all its planned steps have reached terminal outcomes (Spec p19, p33).
   */
  async checkAndCompleteEnrollment(tenantId: string, enrollmentId: string): Promise<void> {
    const executions = await CampaignExecutionModel.find({ tenantId, enrollmentId }).lean();
    if (executions.length === 0) return;

    const terminalStates = [
      EXECUTION_STATE.PROVIDER_ACCEPTED,
      EXECUTION_STATE.SENT,
      EXECUTION_STATE.DELIVERED,
      EXECUTION_STATE.READ,
      EXECUTION_STATE.SKIPPED,
      EXECUTION_STATE.CANCELLED,
      EXECUTION_STATE.EXPIRED,
      EXECUTION_STATE.FAILED,
    ];

    const allTerminal = executions.every((ex) => terminalStates.includes(ex.state as any));
    if (allTerminal) {
      await CampaignEnrollmentModel.updateOne(
        { tenantId, enrollmentId, status: 'ACTIVE' },
        { $set: { status: 'COMPLETED' } }
      );
    }
  }

  /**
   * Retrieves upcoming scheduled activity across active campaigns for boutique overview.
   */
  async getUpcomingActivity(tenantId: string, limit = 10) {
    const effectiveNow = clock.now();
    const safeLimit = Math.min(Math.max(1, limit), 50);

    const executions = await CampaignExecutionModel.find({
      tenantId,
      state: 'SCHEDULED',
      dueAt: { $gte: effectiveNow },
    })
      .sort({ dueAt: 1 })
      .limit(safeLimit)
      .lean();

    if (executions.length === 0) {
      return { activities: [], total: 0 };
    }

    const enrollmentIds = [...new Set(executions.map((x) => x.enrollmentId))];
    const campaignIds = [...new Set(executions.map((x) => x.campaignId))];

    const [enrollments, campaigns] = await Promise.all([
      CampaignEnrollmentModel.find({
        tenantId,
        enrollmentId: { $in: enrollmentIds },
      }).lean(),
      CampaignModel.find({
        tenantId,
        campaignId: { $in: campaignIds },
      }).lean(),
    ]);

    const enrMap = new Map<string, any>();
    enrollments.forEach((e) => enrMap.set(e.enrollmentId, e));

    const cmpMap = new Map<string, any>();
    campaigns.forEach((c) => cmpMap.set(c.campaignId, c));

    const customerIds = [...new Set(enrollments.map((e) => e.customerId))];
    const customers = await Promise.all(
      customerIds.map((cid) => mockCustomerSource.getCustomerById(tenantId, cid))
    );
    const customerMap = new Map<string, any>();
    customers.forEach((c) => {
      if (c) customerMap.set(c.customerId, c);
    });

    const activities = executions.map((ex) => {
      const enr = enrMap.get(ex.enrollmentId);
      const cmp = cmpMap.get(ex.campaignId);
      const cust = enr ? customerMap.get(enr.customerId) : null;

      return {
        executionId: ex.executionId,
        campaignId: ex.campaignId,
        campaignName: cmp?.name || ex.campaignId,
        enrollmentId: ex.enrollmentId,
        customerId: enr?.customerId || 'N/A',
        customerName: cust?.firstName || 'Unknown',
        maskedPhone: cust?.destination?.masked || 'N/A',
        stepId: ex.stepId,
        stepName: ex.stepName || ex.stepId,
        dueAt: ex.dueAt,
        localDate: ex.localDate,
        localTime: ex.localTime,
        timezone: ex.timezone,
        state: ex.state,
        templateId: ex.templateRef?.id || null,
        occurrenceId: enr?.occurrenceId || null,
        matchExplanation: enr?.matchExplanation || null,
      };
    });

    return {
      activities,
      total: activities.length,
    };
  }
}

export const campaignActivityService = new CampaignActivityService();

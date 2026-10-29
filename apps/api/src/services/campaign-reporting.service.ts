import {
  CampaignModel,
  CampaignEnrollmentModel,
  CampaignExecutionModel,
  CampaignDeliveryIntentModel,
  CampaignGoalEventModel,
  CampaignDryRunModel,
  SrcOrderModel,
  ICampaignExecution,
} from '../db/models';
import {
  EXECUTION_STATE,
  ENROLLMENT_STATUS,
  CampaignReport,
  CustomerTimelineReport,
  CustomerTimelineStep,
  AttributedOrder,
  StepFunnelItem,
  DelayReasonItem,
  PrimaryReasonItem,
} from '@grovastra/shared';
import { mockCustomerSource } from '../adapters';
import { clock } from './clock';
import { NotFoundError } from '../errors/app-error';
import { logger } from '../logger';

// Priority map for campaign presets to resolve multi-campaign collision precedence (Spec p18, p28)
const PRESET_PRIORITIES: Record<string, number> = {
  birthday: 80,
  anniversary: 50,
  winback: 40,
  default: 10,
};

export class CampaignReportingService {
  /**
   * Generates a comprehensive per-campaign report adhering to Spec p28.
   * Scoped strictly to authenticated tenantId (Hard Rule 1).
   */
  async getCampaignReport(tenantId: string, campaignId: string): Promise<CampaignReport> {
    const campaign: any = await CampaignModel.findOne({ tenantId, campaignId }).lean();
    if (!campaign) {
      throw new NotFoundError(`Campaign '${campaignId}' not found for tenant '${tenantId}'`);
    }

    const statedAtInstant = clock.now().toISOString();

    // 1. Eligible Customers (Spec p28: "Customers matching evaluated rules at a stated time. Changing estimate, not guaranteed send count")
    const latestDryRun: any = await CampaignDryRunModel.findOne({ tenantId, campaignId })
      .sort({ createdAt: -1 })
      .lean();

    const eligible = {
      count: latestDryRun?.counts?.eligible ?? 0,
      statedAt: latestDryRun?.evaluatedAt ? new Date(latestDryRun.evaluatedAt).toISOString() : null,
    };

    // 2. Enrollments (Spec p28: "Unique customer/occurrence records; multiple steps do not multiply customer count")
    const enrollments = await CampaignEnrollmentModel.find({ tenantId, campaignId }).lean();
    const uniqueCustomers = new Set(enrollments.map((e) => e.customerId)).size;

    // 3. Executions: Pending (Scheduled/Deferred), Business Stops (Skipped/Cancelled/Expired) & Delivery Evidence
    const executions = await CampaignExecutionModel.find({ tenantId, campaignId }).lean<ICampaignExecution[]>();

    const scheduled = executions.filter((x) => x.state === EXECUTION_STATE.SCHEDULED);
    const deferred = executions.filter((x) => x.state === EXECUTION_STATE.DEFERRED);
    const skipped = executions.filter((x) => x.state === EXECUTION_STATE.SKIPPED);
    const cancelled = executions.filter((x) => x.state === EXECUTION_STATE.CANCELLED);
    const expired = executions.filter((x) => x.state === EXECUTION_STATE.EXPIRED);
    const failed = executions.filter((x) => x.state === EXECUTION_STATE.FAILED);
    const outcomeUnknown = executions.filter((x) => x.state === EXECUTION_STATE.OUTCOME_UNKNOWN);

    // Next scheduled date
    const sortedScheduled = [...scheduled].sort(
      (a, b) => new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime()
    );
    const nextScheduledDueAt = sortedScheduled[0]?.dueAt
      ? new Date(sortedScheduled[0].dueAt).toISOString()
      : null;

    // Delay reasons breakdown for deferred
    const delayReasonsMap = new Map<string, number>();
    deferred.forEach((x) => {
      const reason = x.skipReason || 'Deferred by contact gate spacing or quiet hours';
      delayReasonsMap.set(reason, (delayReasonsMap.get(reason) || 0) + 1);
    });
    const delayReasons: DelayReasonItem[] = Array.from(delayReasonsMap.entries()).map(([reason, count]) => ({
      reason,
      count,
    }));

    // Primary business-rule stop reasons breakdown (Spec p28, p29: "visible to owners")
    const primaryReasonsMap = new Map<string, { count: number; category: 'SKIPPED' | 'CANCELLED' | 'EXPIRED' }>();
    const registerReason = (reason: string, category: 'SKIPPED' | 'CANCELLED' | 'EXPIRED') => {
      const key = `${category}:${reason}`;
      const existing = primaryReasonsMap.get(key);
      if (existing) {
        existing.count++;
      } else {
        primaryReasonsMap.set(key, { count: 1, category });
      }
    };

    skipped.forEach((x) => registerReason(x.skipReason || 'Skipped by eligibility rule', 'SKIPPED'));
    cancelled.forEach((x) => registerReason(x.skipReason || 'Cancelled by event or manual action', 'CANCELLED'));
    expired.forEach((x) => registerReason(x.skipReason || 'Expired beyond useful window', 'EXPIRED'));

    const primaryReasons: PrimaryReasonItem[] = Array.from(primaryReasonsMap.entries())
      .map(([key, val]) => ({
        reason: key.split(':').slice(1).join(':'),
        count: val.count,
        category: val.category,
      }))
      .sort((a, b) => b.count - a.count);

    // Delivery Evidence (Spec p28: "Accepted / delivered / read: Separate evidence counts per execution. Do not show accepted as delivered")
    // Accepted: provider accepted submission
    const acceptedCount = executions.filter(
      (x) =>
        x.state === EXECUTION_STATE.PROVIDER_ACCEPTED ||
        x.providerStatus === 'accepted' ||
        Boolean(x.providerMessageId && !['SKIPPED', 'CANCELLED', 'EXPIRED', 'BLOCKED', 'FAILED'].includes(x.state))
    ).length;

    // Sent: dispatch completed
    const sentCount = executions.filter((x) => x.sentAt != null || x.state === EXECUTION_STATE.SENT).length;

    // Delivered: provider confirmed delivery webhook
    const deliveredCount = executions.filter(
      (x) => x.deliveredAt != null || x.state === EXECUTION_STATE.DELIVERED
    ).length;

    // Read: customer opened/read WhatsApp message
    const readCount = executions.filter((x) => x.readAt != null || x.state === EXECUTION_STATE.READ).length;

    const deliveryEvidence = {
      accepted: acceptedCount,
      sent: sentCount,
      delivered: deliveredCount,
      read: readCount,
      notice:
        'Separate evidence counts per execution. Accepted is not delivered; delivered is not a sale.',
    };

    // 4. Replies & Holds (Spec p28: "distinguish exact reply context from conservative customer-wide hold")
    const exactReplies = enrollments.filter((e) => e.replyAttribution === 'CAMPAIGN').length;
    const conservativeHolds = enrollments.filter((e) => e.replyAttribution === 'NOT_CAMPAIGN_CONSERVATIVE').length;
    const currentlyOnHold = enrollments.filter((e) => e.replyHoldAt != null).length;
    const resolvedHolds = enrollments.filter((e) => (e as any).holdResolvedAt != null).length;
    const totalHeldOrReplied = enrollments.filter(
      (e) => e.replyHoldAt != null || (e as any).lastReplyHoldAt != null || e.replyAttribution != null
    ).length;

    const repliesAndHolds = {
      totalHeldOrReplied,
      exactCampaignReplies: exactReplies,
      conservativeHolds,
      currentlyOnHold,
      resolvedHolds,
    };

    // 5. Goal Completions (Spec p28: "Explicit tagged purchase or staff/domain completion, with supporting record and configured rule")
    const goalEvents = await CampaignGoalEventModel.find({ tenantId, campaignId }).sort({ at: -1 }).lean();
    const completedGoals = enrollments.filter((e) => e.goalReachedAt != null);

    let orderOccasionGoals = 0;
    let staffManualGoals = 0;

    completedGoals.forEach((e) => {
      const src = (e as any).goalSource;
      if (src === 'ORDER_OCCASION' || src === 'ORDER_OCCASION_MATCH') {
        orderOccasionGoals++;
      } else {
        staffManualGoals++;
      }
    });

    const goalCompletions = {
      total: completedGoals.length,
      orderOccasion: orderOccasionGoals,
      staffManual: staffManualGoals,
      details: goalEvents.map((ge: any) => ({
        goalEventId: ge.goalEventId,
        source: ge.source,
        orderRef: ge.orderRef || null,
        cause: ge.cause || null,
        at: new Date(ge.at).toISOString(),
      })),
    };

    // 6. Attribution Engine (Spec p28: ONLY explicitly linked orders. One order is counted once; define precedence; show unassigned orders separately; refunds reduce net)
    const attributionResult = await this.evaluateTenantAttribution(tenantId, campaignId);

    // 7. Step Funnel
    const stepFunnel = this.buildStepFunnel(executions, campaign);

    return {
      campaignId: campaign.campaignId,
      campaignName: campaign.name,
      status: campaign.status,
      presetId: campaign.presetId,
      statedAt: statedAtInstant,
      eligible,
      enrollments: {
        total: enrollments.length,
        uniqueCustomers,
      },
      executionCounts: {
        total: executions.length,
        scheduled: scheduled.length,
        deferred: deferred.length,
        nextScheduledDueAt,
        delayReasons,
        skipped: skipped.length,
        cancelled: cancelled.length,
        expired: expired.length,
        failed: failed.length,
        outcomeUnknown: outcomeUnknown.length,
        primaryReasons,
      },
      deliveryEvidence,
      repliesAndHolds,
      goalCompletions,
      attribution: attributionResult.campaignAttribution,
      unassignedStoreOrders: attributionResult.unassignedStoreOrders,
      stepFunnel,
    };
  }

  /**
   * Evaluates tenant orders and attributes them under strict Spec p28 rules:
   * - ONLY explicitly linked orders (occasionRef or goal events)
   * - One order is counted once across all campaigns
   * - Precedence:
   *     1. Explicit Goal Event matching orderRef and campaignId
   *     2. Explicit Enrollment Link: enrollment.goalOrderRef or enrollment.orderRef
   *     3. Exact occasionRef match on customer's enrollment occurrenceId (with preset priority tie-breaker)
   * - Unassigned orders shown separately
   * - Cancellations / refunds reduce net sales
   */
  async evaluateTenantAttribution(
    tenantId: string,
    targetCampaignId?: string
  ): Promise<{
    campaignAttribution: {
      model: string;
      assumptionNotice?: string;
      orderCount: number;
      totalNetSalesPaise: number;
      totalNetSalesRupees: number;
      refundsCount: number;
      refundedPaise: number;
      orders: AttributedOrder[];
    };
    unassignedStoreOrders: {
      orderCount: number;
      netSalesPaise: number;
      netSalesRupees: number;
    };
  }> {
    const [orders, allGoalEvents, allEnrollments, allCampaigns] = await Promise.all([
      SrcOrderModel.find({ tenantId }).lean(),
      CampaignGoalEventModel.find({ tenantId }).lean(),
      CampaignEnrollmentModel.find({ tenantId }).lean(),
      CampaignModel.find({ tenantId }).lean(),
    ]);

    // Build lookup maps
    const campaignPriorityMap = new Map<string, number>();
    allCampaigns.forEach((c) => {
      const priority = PRESET_PRIORITIES[c.presetId] || PRESET_PRIORITIES.default;
      campaignPriorityMap.set(c.campaignId, priority);
    });

    // Map goal events by orderRef
    const goalEventsByOrderRef = new Map<string, any[]>();
    allGoalEvents.forEach((ge) => {
      if (ge.orderRef) {
        const list = goalEventsByOrderRef.get(ge.orderRef) || [];
        list.push(ge);
        goalEventsByOrderRef.set(ge.orderRef, list);
      }
    });

    // Map enrollments by goalOrderRef / orderRef
    const enrollmentsByOrderRef = new Map<string, any[]>();
    allEnrollments.forEach((e) => {
      const ref = (e as any).goalOrderRef || (e as any).orderRef;
      if (ref) {
        const list = enrollmentsByOrderRef.get(ref) || [];
        list.push(e);
        enrollmentsByOrderRef.set(ref, list);
      }
    });

    // Map enrollments by customerId + occurrenceId
    const enrollmentsByCustomerOccurrence = new Map<string, any[]>();
    allEnrollments.forEach((e) => {
      const key = `${e.customerId}::${e.occurrenceId}`;
      const list = enrollmentsByCustomerOccurrence.get(key) || [];
      list.push(e);
      enrollmentsByCustomerOccurrence.set(key, list);
    });

    // Per-campaign attributed orders bucket
    const campaignOrders = new Map<string, AttributedOrder[]>();
    const unassignedOrders: any[] = [];

    // Evaluate each store order ONCE to guarantee single-attribution (Spec p28)
    for (const order of orders) {
      let winningCampaignId: string | null = null;
      let attributionSource: 'GOAL_EVENT' | 'ENROLLMENT_LINK' | 'OCCASION_REF' | null = null;
      let supportingRecord: string | null = null;

      // 1. Precedence 1: Explicit Goal Event (STAFF_ATTRIBUTED or ORDER_OCCASION_MATCH)
      const matchingGoalEvents = goalEventsByOrderRef.get(order.orderId);
      if (matchingGoalEvents && matchingGoalEvents.length > 0) {
        // Pick matching goal event with explicit campaignId (earliest at)
        const sorted = [...matchingGoalEvents].sort(
          (a, b) => new Date(a.at).getTime() - new Date(b.at).getTime()
        );
        const ge = sorted[0];
        if (ge.campaignId) {
          winningCampaignId = ge.campaignId;
          attributionSource = 'GOAL_EVENT';
          supportingRecord = ge.supportingRecord || ge.cause || `Goal event ${ge.goalEventId}`;
        }
      }

      // 2. Precedence 2: Explicit Enrollment Link
      if (!winningCampaignId) {
        const matchingEnrollments = enrollmentsByOrderRef.get(order.orderId);
        if (matchingEnrollments && matchingEnrollments.length > 0) {
          const sorted = [...matchingEnrollments].sort(
            (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
          );
          const enr = sorted[0];
          winningCampaignId = enr.campaignId;
          attributionSource = 'ENROLLMENT_LINK';
          supportingRecord = `Linked on enrollment ${enr.enrollmentId}`;
        }
      }

      // 3. Precedence 3: Exact occasionRef match on enrollment occurrenceId
      if (!winningCampaignId && order.occasionRef) {
        const key = `${order.customerId}::${order.occasionRef}`;
        const candidateEnrollments = enrollmentsByCustomerOccurrence.get(key);

        if (candidateEnrollments && candidateEnrollments.length > 0) {
          // If multiple campaigns enrolled the customer for the occasion, pick by preset priority
          const sorted = [...candidateEnrollments].sort((a, b) => {
            const prioA = campaignPriorityMap.get(a.campaignId) || 0;
            const prioB = campaignPriorityMap.get(b.campaignId) || 0;
            if (prioB !== prioA) return prioB - prioA;
            return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
          });
          const winner = sorted[0];
          winningCampaignId = winner.campaignId;
          attributionSource = 'OCCASION_REF';
          supportingRecord = `Occasion reference ${order.occasionRef}`;
        }
      }

      // Assign to winner or mark unassigned
      if (winningCampaignId && attributionSource) {
        const attributedItem: AttributedOrder = {
          orderId: order.orderId,
          customerId: order.customerId,
          status: order.status,
          paid: Boolean(order.paid),
          netPaise: order.netPaise || 0,
          netRupees: (order.netPaise || 0) / 100,
          occasionRef: order.occasionRef || null,
          attributionSource,
          supportingRecord,
          completedAt: order.completedAt ? new Date(order.completedAt).toISOString() : null,
        };

        const list = campaignOrders.get(winningCampaignId) || [];
        list.push(attributedItem);
        campaignOrders.set(winningCampaignId, list);
      } else {
        unassignedOrders.push(order);
      }
    }

    // Target campaign metrics
    const targetOrders = targetCampaignId ? campaignOrders.get(targetCampaignId) || [] : [];

    // Calculate net sales: refunds reduce net (Spec p28, QA Matrix C18)
    // Only completed, paid orders contribute to positive net sales; cancelled orders contribute 0
    let totalNetSalesPaise = 0;
    let refundsCount = 0;
    let refundedPaise = 0;

    targetOrders.forEach((o) => {
      if (o.status === 'CANCELLED') {
        refundsCount++;
        // cancelled order net contribution is zero
      } else if (o.paid) {
        if (o.netPaise <= 0 || o.status === 'REFUNDED') {
          refundsCount++;
        }
        totalNetSalesPaise += o.netPaise;
      }
    });

    // Unassigned store orders calculation
    let unassignedNetSalesPaise = 0;
    unassignedOrders.forEach((o) => {
      if (o.paid && o.status !== 'CANCELLED') {
        unassignedNetSalesPaise += o.netPaise || 0;
      }
    });

    return {
      campaignAttribution: {
        model: 'EXPLICIT_LINK_ONLY',
        assumptionNotice:
          'Attribution Model: Explicit Link Only (occasionRef or goal events). One order counted once with strict precedence. Delivery alone is never counted as sales; refunds reduce net sales.',
        orderCount: targetOrders.length,
        totalNetSalesPaise,
        totalNetSalesRupees: totalNetSalesPaise / 100,
        refundsCount,
        refundedPaise,
        orders: targetOrders,
      },
      unassignedStoreOrders: {
        orderCount: unassignedOrders.length,
        netSalesPaise: unassignedNetSalesPaise,
        netSalesRupees: unassignedNetSalesPaise / 100,
      },
    };
  }

  /**
   * Builds the step funnel for a campaign.
   */
  private buildStepFunnel(executions: ICampaignExecution[], campaign: any): StepFunnelItem[] {
    const stepsMap = new Map<
      string,
      {
        stepName: string;
        scheduled: number;
        accepted: number;
        delivered: number;
        read: number;
        skipped: number;
        cancelled: number;
      }
    >();

    executions.forEach((ex) => {
      const stepId = ex.stepId;
      const stepName = ex.stepName || stepId;
      const existing = stepsMap.get(stepId) || {
        stepName,
        scheduled: 0,
        accepted: 0,
        delivered: 0,
        read: 0,
        skipped: 0,
        cancelled: 0,
      };

      if (ex.state === EXECUTION_STATE.SCHEDULED) existing.scheduled++;
      if (
        ex.state === EXECUTION_STATE.PROVIDER_ACCEPTED ||
        ex.providerStatus === 'accepted' ||
        Boolean(ex.providerMessageId && !['SKIPPED', 'CANCELLED', 'EXPIRED', 'BLOCKED', 'FAILED'].includes(ex.state))
      ) {
        existing.accepted++;
      }
      if (ex.deliveredAt != null || ex.state === EXECUTION_STATE.DELIVERED) existing.delivered++;
      if (ex.readAt != null || ex.state === EXECUTION_STATE.READ) existing.read++;
      if (ex.state === EXECUTION_STATE.SKIPPED) existing.skipped++;
      if (ex.state === EXECUTION_STATE.CANCELLED) existing.cancelled++;

      stepsMap.set(stepId, existing);
    });

    return Array.from(stepsMap.entries()).map(([stepId, data]) => ({
      stepId,
      stepName: data.stepName,
      scheduled: data.scheduled,
      accepted: data.accepted,
      delivered: data.delivered,
      read: data.read,
      skipped: data.skipped,
      cancelled: data.cancelled,
    }));
  }

  /**
   * Generates a Customer Timeline report for a specific customer in a campaign (Spec p28).
   * Explains: why selected, occurrence, planned vs actual dates, template revision,
   * status events, and stop reasons.
   */
  async getCustomerTimeline(
    tenantId: string,
    campaignId: string,
    customerId: string
  ): Promise<CustomerTimelineReport> {
    const [campaign, customer, enrollment]: [any, any, any] = await Promise.all([
      CampaignModel.findOne({ tenantId, campaignId }).lean(),
      mockCustomerSource.getCustomerById(tenantId, customerId),
      CampaignEnrollmentModel.findOne({ tenantId, campaignId, customerId })
        .sort({ createdAt: -1 })
        .lean(),
    ]);

    if (!campaign) {
      throw new NotFoundError(`Campaign '${campaignId}' not found for tenant '${tenantId}'`);
    }
    if (!enrollment) {
      throw new NotFoundError(
        `Enrollment for customer '${customerId}' not found in campaign '${campaignId}'`
      );
    }

    // Executions and Delivery Intents
    const executions = await CampaignExecutionModel.find({
      tenantId,
      enrollmentId: enrollment.enrollmentId,
    })
      .sort({ dueAt: 1 })
      .lean<ICampaignExecution[]>();

    const executionIds = executions.map((x) => x.executionId);
    const deliveryIntents = await CampaignDeliveryIntentModel.find({
      tenantId,
      executionId: { $in: executionIds },
    }).lean();

    const intentMap = new Map<string, any>();
    deliveryIntents.forEach((di) => intentMap.set(di.executionId, di));

    // Map each execution to a detailed customer timeline step
    const steps: CustomerTimelineStep[] = executions.map((ex) => {
      const intent = intentMap.get(ex.executionId);

      // Build chronological status history
      const statusHistory: Array<{ state: string; timestamp: string; details?: string }> = [];

      // Initial planned instant
      statusHistory.push({
        state: 'SCHEDULED',
        timestamp: new Date(ex.createdAt || ex.dueAt).toISOString(),
        details: `Planned for local date ${ex.localDate} at ${ex.localTime} (${ex.timezone})`,
      });

      // Provider Accepted
      if (ex.sentAt || ex.providerMessageId || ex.state === EXECUTION_STATE.PROVIDER_ACCEPTED) {
        statusHistory.push({
          state: 'PROVIDER_ACCEPTED',
          timestamp: new Date(ex.sentAt || ex.updatedAt).toISOString(),
          details: ex.providerMessageId ? `Provider Message ID (wamid): ${ex.providerMessageId}` : undefined,
        });
      }

      // Delivered
      if (ex.deliveredAt || ex.state === EXECUTION_STATE.DELIVERED) {
        statusHistory.push({
          state: 'DELIVERED',
          timestamp: new Date(ex.deliveredAt || ex.updatedAt).toISOString(),
          details: 'Confirmed delivered to recipient WhatsApp destination',
        });
      }

      // Read
      if (ex.readAt || ex.state === EXECUTION_STATE.READ) {
        statusHistory.push({
          state: 'READ',
          timestamp: new Date(ex.readAt || ex.updatedAt).toISOString(),
          details: 'Customer opened and read message',
        });
      }

      // Skipped / Cancelled / Expired / Blocked
      if (
        [
          EXECUTION_STATE.SKIPPED,
          EXECUTION_STATE.CANCELLED,
          EXECUTION_STATE.EXPIRED,
          EXECUTION_STATE.BLOCKED,
          EXECUTION_STATE.FAILED,
        ].includes(ex.state as any)
      ) {
        statusHistory.push({
          state: ex.state,
          timestamp: new Date(ex.updatedAt).toISOString(),
          details: ex.skipReason ? `Stop reason: ${ex.skipReason}` : `Transitioned to ${ex.state}`,
        });
      }

      return {
        executionId: ex.executionId,
        stepId: ex.stepId,
        stepName: ex.stepName || ex.stepId,
        state: ex.state,
        skipReason: ex.skipReason || null,
        plannedDueAt: new Date(ex.dueAt).toISOString(),
        plannedLocalDate: ex.localDate,
        plannedLocalTime: ex.localTime,
        timezone: ex.timezone,
        actualDispatchedAt: ex.sentAt ? new Date(ex.sentAt).toISOString() : null,
        actualDeliveredAt: ex.deliveredAt ? new Date(ex.deliveredAt).toISOString() : null,
        actualReadAt: ex.readAt ? new Date(ex.readAt).toISOString() : null,
        template: ex.templateRef
          ? {
              id: ex.templateRef.id,
              revision: ex.templateRef.revision,
              language: ex.templateRef.language,
            }
          : intent?.templateRef
          ? {
              id: intent.templateRef.id,
              revision: intent.templateRef.revision,
              language: intent.templateRef.language,
            }
          : null,
        statusHistory,
        providerMessageId: ex.providerMessageId || intent?.providerMessageId || null,
        lastErrorCategory: ex.lastErrorCategory || intent?.lastErrorCategory || null,
        attemptsCount: ex.attempts?.length || intent?.attempts?.length || 0,
      };
    });

    // Linked orders for this customer attributed to this campaign
    const attributionResult = await this.evaluateTenantAttribution(tenantId, campaignId);
    const customerOrders = attributionResult.campaignAttribution.orders.filter(
      (o) => o.customerId === customerId
    );

    return {
      customerId,
      customerName: customer?.firstName || 'Unknown Customer',
      maskedPhone: customer?.destination?.masked || 'N/A',
      tenantId,
      campaignId,
      campaignName: campaign.name,
      enrollment: {
        enrollmentId: enrollment.enrollmentId,
        occurrenceId: enrollment.occurrenceId,
        occasionLocalDate: enrollment.occasionLocalDate,
        status: enrollment.status,
        matchExplanation: enrollment.matchExplanation || 'all eligible',
        createdAt: new Date(enrollment.createdAt).toISOString(),
        replyHoldAt: enrollment.replyHoldAt ? new Date(enrollment.replyHoldAt).toISOString() : null,
        replyAttribution: enrollment.replyAttribution || null,
        lastReplyHoldAt: (enrollment as any).lastReplyHoldAt
          ? new Date((enrollment as any).lastReplyHoldAt).toISOString()
          : null,
        holdResolvedAt: (enrollment as any).holdResolvedAt
          ? new Date((enrollment as any).holdResolvedAt).toISOString()
          : null,
        holdResolutionCause: (enrollment as any).holdResolutionCause || null,
        goalReachedAt: enrollment.goalReachedAt ? new Date(enrollment.goalReachedAt).toISOString() : null,
        goalSource: (enrollment as any).goalSource || null,
        goalOrderRef: (enrollment as any).goalOrderRef || (enrollment as any).orderRef || null,
      },
      steps,
      linkedOrders: customerOrders,
    };
  }

  /**
   * Generates a sanitized CSV export for a campaign (Spec p28, Hard Rule 9).
   * Guarantees:
   * - Phones are strictly masked (+91 98*** **321)
   * - No message text bodies are present
   * - All records and stop reasons are cleanly escaped
   */
  async generateCampaignCsvExport(tenantId: string, campaignId: string): Promise<string> {
    const campaign: any = await CampaignModel.findOne({ tenantId, campaignId }).lean();
    if (!campaign) {
      throw new NotFoundError(`Campaign '${campaignId}' not found for tenant '${tenantId}'`);
    }

    const [enrollments, executions, attributionResult] = await Promise.all([
      CampaignEnrollmentModel.find({ tenantId, campaignId }).lean(),
      CampaignExecutionModel.find({ tenantId, campaignId }).lean(),
      this.evaluateTenantAttribution(tenantId, campaignId),
    ]);

    const customerIds = [...new Set(enrollments.map((e) => e.customerId))];
    const customers = await Promise.all(
      customerIds.map((cid) => mockCustomerSource.getCustomerById(tenantId, cid))
    );
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

    const ordersByCustomer = new Map<string, AttributedOrder[]>();
    attributionResult.campaignAttribution.orders.forEach((o) => {
      const list = ordersByCustomer.get(o.customerId) || [];
      list.push(o);
      ordersByCustomer.set(o.customerId, list);
    });

    // Helper to sanitize CSV field
    const escapeCsv = (val: any): string => {
      if (val === null || val === undefined) return '""';
      const str = String(val).replace(/"/g, '""');
      return `"${str}"`;
    };

    const headers = [
      'Enrollment ID',
      'Customer ID',
      'Masked Phone',
      'Occurrence',
      'Occasion Date',
      'Status',
      'Why Selected',
      'Total Steps',
      'Scheduled Steps',
      'Accepted Steps',
      'Delivered Steps',
      'Read Steps',
      'Skipped Steps',
      'Primary Skip Reason',
      'Reply Hold Active',
      'Reply Attribution',
      'Goal Reached',
      'Goal Source',
      'Attributed Order ID',
      'Net Sales (INR)',
      'Created At',
    ];

    const rows: string[] = [headers.join(',')];

    for (const e of enrollments) {
      const cust = customerMap.get(e.customerId);
      const exList = executionMap.get(e.enrollmentId) || [];
      const custOrders = ordersByCustomer.get(e.customerId) || [];

      const scheduledCount = exList.filter((x) => x.state === EXECUTION_STATE.SCHEDULED).length;
      const acceptedCount = exList.filter(
        (x) =>
          x.state === EXECUTION_STATE.PROVIDER_ACCEPTED ||
          x.providerStatus === 'accepted' ||
          Boolean(x.providerMessageId && !['SKIPPED', 'CANCELLED', 'EXPIRED', 'BLOCKED', 'FAILED'].includes(x.state))
      ).length;
      const deliveredCount = exList.filter(
        (x) => x.deliveredAt != null || x.state === EXECUTION_STATE.DELIVERED
      ).length;
      const readCount = exList.filter((x) => x.readAt != null || x.state === EXECUTION_STATE.READ).length;
      const skippedCount = exList.filter((x) => x.state === EXECUTION_STATE.SKIPPED).length;

      const firstSkipped = exList.find((x) => x.state === EXECUTION_STATE.SKIPPED && x.skipReason);
      const primarySkipReason = firstSkipped?.skipReason || (skippedCount > 0 ? 'Eligibility criteria' : 'N/A');

      const linkedOrder = custOrders[0] || null;

      const row = [
        escapeCsv(e.enrollmentId),
        escapeCsv(e.customerId),
        escapeCsv(cust?.destination?.masked || 'N/A'), // STRICTLY MASKED (Hard Rule 9)
        escapeCsv(e.occurrenceId),
        escapeCsv(e.occasionLocalDate || 'N/A'),
        escapeCsv(e.status),
        escapeCsv(e.matchExplanation || 'all eligible'),
        escapeCsv(exList.length),
        escapeCsv(scheduledCount),
        escapeCsv(acceptedCount),
        escapeCsv(deliveredCount),
        escapeCsv(readCount),
        escapeCsv(skippedCount),
        escapeCsv(primarySkipReason),
        escapeCsv(e.replyHoldAt ? 'YES' : 'NO'),
        escapeCsv(e.replyAttribution || 'NONE'),
        escapeCsv(e.goalReachedAt ? 'YES' : 'NO'),
        escapeCsv((e as any).goalSource || 'NONE'),
        escapeCsv(linkedOrder?.orderId || (e as any).goalOrderRef || (e as any).orderRef || 'NONE'),
        escapeCsv(linkedOrder ? linkedOrder.netRupees.toFixed(2) : '0.00'),
        escapeCsv(new Date(e.createdAt).toISOString()),
      ];

      rows.push(row.join(','));
    }

    return rows.join('\r\n');
  }
}

export const campaignReportingService = new CampaignReportingService();

import crypto from 'crypto';
import mongoose from 'mongoose';
import { DateTime } from 'luxon';
import {
  EXECUTION_STATE,
  ExecutionState,
  EXECUTION_REASONS,
  ExecutionReason,
  DELIVERY_INTENT_STATE,
  SourceCustomer,
  SourceTemplate,
  isDestinationVerified,
} from '@grovastra/shared';
import {
  CampaignModel,
  CampaignVersionModel,
  CampaignControlGateModel,
  CampaignEnrollmentModel,
  CampaignExecutionModel,
  CampaignDeliveryIntentModel,
  CampaignContactGateModel,
  ICampaignExecution,
  ICampaignDeliveryIntent,
  SrcCustomerModel,
  SrcTemplateModel,
  SrcConnectionModel,
  TenantModel,
  TenantControlGateModel,
} from '../../db/models';
import { mockCustomerSource, mockOccasionSource, mockEnquirySource, mockProductSource, mockRequestSource } from '../../adapters';
import { campaignSettingsService } from '../campaign-settings.service';
import { contactGateService } from '../contact-gate';
import { clock } from '../clock';
import { config } from '../../config/env';
import { logger } from '../../logger';
import { getDispatchPort } from '../dispatch/dispatch-port';
import { isDestinationInAllowlist, sweepStaleDispatching } from '../../adapters/whatsapp-delivery';
import { dispatchRecheck } from '../../presets/_shared/eventDelay/dispatchRecheck';
import {
  formatCreditBalance,
  computeDaysToExpiry,
  resolveForStep,
  computePayloadHash,
} from '../../templates';


export interface WorkerCycleOptions {
  tenantId?: string;
  campaignId?: string;
  batchSize?: number;
  nowOverride?: Date;
}

export interface WorkerCycleResult {
  claimedCount: number;
  dispatchedCount: number;
  skippedCount: number;
  cancelledCount: number;
  blockedCount: number;
  deferredCount: number;
  expiredCount: number;
  staleCasCount: number;
  results: Array<{
    executionId: string;
    stepId: string;
    state: ExecutionState;
    reason?: string | null;
    deliveryIntentId?: string | null;
  }>;
}

export class WorkerService {
  /**
   * Executes one full evaluation cycle for due campaign executions.
   * Conforms strictly to Spec p19, p20, p25, p33:
   * 1. Claims due SCHEDULED/DEFERRED executions with findOneAndUpdate into EVALUATING with expiring unique lease token.
   * 2. Evaluates pinned campaign version and all gates in Reason Precedence order (Spec p33).
   * 3. Late-binds template parameters ordered by variable index.
   * 4. Executes final CAS before handing off: matches lease token, expected planRevision, state, lease not expired, expiresAt > server now.
   * 5. Atomically freezes immutable campaignDeliveryIntent and marks DISPATCHING.
   * 6. Hands off to DispatchPort outside the transaction.
   */
  async runWorkerCycle(options: WorkerCycleOptions = {}): Promise<WorkerCycleResult> {
    if (!clock.isProduction() && process.env.NODE_ENV !== 'test' && mongoose.connection.readyState === 1) {
      try {
        const offsetDoc = await mongoose.connection.db
          ?.collection('devClockOffsets')
          .findOne({ key: 'global' });
        if (offsetDoc && typeof offsetDoc.offsetMs === 'number') {
          clock.setOffsetMs(offsetDoc.offsetMs);
        }
      } catch {}
    }

    const serverNow = options.nowOverride || clock.now();
    const batchSize = Math.min(Math.max(1, options.batchSize || 20), 100);

    // Spec p27 (C07): Sweeper moves stale DISPATCHING attempts to OUTCOME_UNKNOWN
    await sweepStaleDispatching(60000);

    const summary: WorkerCycleResult = {
      claimedCount: 0,
      dispatchedCount: 0,
      skippedCount: 0,
      cancelledCount: 0,
      blockedCount: 0,
      deferredCount: 0,
      expiredCount: 0,
      staleCasCount: 0,
      results: [],
    };

    // Claim and process candidates one by one up to batchSize
    for (let i = 0; i < batchSize; i++) {
      const claimResult = await this.claimNextDueExecution(options.tenantId, options.campaignId, serverNow);
      if (!claimResult) {
        // No more due executions to claim
        break;
      }

      summary.claimedCount++;
      const { execution, leaseToken, leaseUntil } = claimResult;

      try {
        const evalResult = await this.evaluateAndProcessExecution(execution, leaseToken, leaseUntil, serverNow);
        summary.results.push(evalResult);

        switch (evalResult.state) {
          case EXECUTION_STATE.DISPATCHING:
          case EXECUTION_STATE.PROVIDER_ACCEPTED:
            summary.dispatchedCount++;
            break;
          case EXECUTION_STATE.SKIPPED:
            summary.skippedCount++;
            break;
          case EXECUTION_STATE.CANCELLED:
            summary.cancelledCount++;
            break;
          case EXECUTION_STATE.BLOCKED:
            summary.blockedCount++;
            break;
          case EXECUTION_STATE.DEFERRED:
            summary.deferredCount++;
            break;
          case EXECUTION_STATE.EXPIRED:
            summary.expiredCount++;
            break;
          default:
            if (evalResult.reason === 'STALE_CAS_FAILED') {
              summary.staleCasCount++;
            }
            break;
        }
      } catch (err: any) {
        logger.error(
          { executionId: execution.executionId, err: err?.message || err },
          'Error during execution evaluation'
        );
      }
    }

    return summary;
  }

  /**
   * Atomically claims one due SCHEDULED/DEFERRED execution with findOneAndUpdate
   * into EVALUATING with an expiring unique lease token (Spec p25).
   * Also reclaims expired pre-submission leases.
   */
  async claimNextDueExecution(
    tenantId?: string,
    campaignId?: string,
    serverNow: Date = clock.now()
  ): Promise<{ execution: ICampaignExecution; leaseToken: string; leaseUntil: Date } | null> {
    const leaseToken = crypto.randomUUID();
    const leaseDurationMs = 30 * 1000; // 30-second expiring lease
    const leaseUntil = new Date(serverNow.getTime() + leaseDurationMs);

    const query: Record<string, any> = {
      $or: [
        // 1. Normal due work in SCHEDULED or DEFERRED
        {
          state: { $in: [EXECUTION_STATE.SCHEDULED, EXECUTION_STATE.DEFERRED] },
          dueAt: { $lte: serverNow },
          $or: [{ 'lease.until': null }, { 'lease.until': { $lte: serverNow } }],
        },
        // 2. Reclaim expired pre-submission lease stuck in EVALUATING (Spec p25)
        {
          state: EXECUTION_STATE.EVALUATING,
          'lease.until': { $lte: serverNow },
        },
      ],
    };

    if (tenantId) query.tenantId = tenantId;
    if (campaignId) query.campaignId = campaignId;

    const claimed = await CampaignExecutionModel.findOneAndUpdate(
      query,
      {
        $set: {
          state: EXECUTION_STATE.EVALUATING,
          lease: {
            token: leaseToken,
            until: leaseUntil,
          },
        },
      },
      {
        sort: { dueAt: 1, _id: 1 },
        new: true,
      }
    );

    if (!claimed) {
      return null;
    }

    return {
      execution: claimed,
      leaseToken,
      leaseUntil,
    };
  }

  /**
   * Evaluates a claimed execution against the pinned campaign version, current customer,
   * connection, template, and contact rules using the Spec p33 Reason Precedence.
   */
  async evaluateAndProcessExecution(
    execution: ICampaignExecution,
    leaseToken: string,
    leaseUntil: Date,
    serverNow: Date
  ): Promise<{
    executionId: string;
    stepId: string;
    state: ExecutionState;
    reason?: string | null;
    deliveryIntentId?: string | null;
  }> {
    const tenantId = execution.tenantId;
    const campaignId = execution.campaignId;
    const enrollmentId = execution.enrollmentId;

    // 1. Load Enrollment
    const enrollment = await CampaignEnrollmentModel.findOne({ tenantId, enrollmentId });
    if (!enrollment) {
      return this.rejectExecution(
        execution,
        leaseToken,
        EXECUTION_STATE.SKIPPED,
        EXECUTION_REASONS.CUSTOMER_NOT_FOUND
      );
    }

    // 2. Load PINNED Campaign Version for this enrollment (Spec p17, p20, Hard Rule 6)
    const version: any = await CampaignVersionModel.findOne({
      tenantId,
      campaignId,
      version: enrollment.campaignVersion,
    }).lean();

    if (!version) {
      return this.rejectExecution(
        execution,
        leaseToken,
        EXECUTION_STATE.BLOCKED,
        EXECUTION_REASONS.CAMPAIGN_NOT_ACTIVE
      );
    }

    // 3. Locate Step Configuration in Pinned Version
    const stepConfig = version.steps?.find((s: any) => s.stepId === execution.stepId);
    if (!stepConfig) {
      return this.rejectExecution(
        execution,
        leaseToken,
        EXECUTION_STATE.SKIPPED,
        EXECUTION_REASONS.TEMPLATE_NOT_FOUND
      );
    }

    // 4. Load Customer Authoritative State
    const customer = await mockCustomerSource.getCustomerById(tenantId, enrollment.customerId);

    // 5. Load Campaign Settings, Campaign Document, Control Gate, and Tenant info
    const [settings, campaign, controlGate, tenantControlGate, tenant]: [any, any, any, any, any] = await Promise.all([
      campaignSettingsService.getSettings(tenantId),
      CampaignModel.findOne({ tenantId, campaignId }).lean(),
      CampaignControlGateModel.findOne({ tenantId, campaignId }).lean(),
      TenantControlGateModel.findOne({ tenantId }).lean(),
      TenantModel.findOne({ tenantId }).lean(),
    ]);

    // =========================================================================
    // REASON PRECEDENCE EVALUATION (Spec p33)
    // 1. Customer deletion / channel suppression
    // 2. Campaign / global stop
    // 3. Invalid source / destination
    // 4. Expiry
    // 5. Configured goal / reply stop
    // 6. Content / readiness
    // 7. Prerequisite
    // 8. Contact cap
    // =========================================================================

    // PRECEDENCE 1: Customer deletion / channel suppression
    if (!customer || customer.deletedAt != null || customer.status === 'DELETED') {
      await this.cancelRemainingEnrollmentSteps(tenantId, enrollmentId, EXECUTION_REASONS.CUSTOMER_DELETED);
      return this.rejectExecution(
        execution,
        leaseToken,
        EXECUTION_STATE.CANCELLED,
        EXECUTION_REASONS.CUSTOMER_DELETED
      );
    }

    if (customer.consent?.channelSuppressed === true) {
      await this.cancelRemainingEnrollmentSteps(tenantId, enrollmentId, EXECUTION_REASONS.CHANNEL_SUPPRESSED);
      return this.rejectExecution(
        execution,
        leaseToken,
        EXECUTION_STATE.CANCELLED,
        EXECUTION_REASONS.CHANNEL_SUPPRESSED
      );
    }

    if (customer.consent?.marketingOptIn === false || customer.status === 'OPTED_OUT') {
      await this.cancelRemainingEnrollmentSteps(tenantId, enrollmentId, EXECUTION_REASONS.MARKETING_OPT_OUT);
      return this.rejectExecution(
        execution,
        leaseToken,
        EXECUTION_STATE.CANCELLED,
        EXECUTION_REASONS.MARKETING_OPT_OUT
      );
    }

    // PRECEDENCE 2: Campaign / global stop
    if (settings?.isPaused === true || tenantControlGate?.isPaused === true) {
      return this.rejectExecution(
        execution,
        leaseToken,
        EXECUTION_STATE.DEFERRED,
        EXECUTION_REASONS.GLOBAL_PAUSED
      );
    }

    if (!campaign || campaign.status !== 'ACTIVE') {
      const isPaused = campaign?.status === 'PAUSED';
      return this.rejectExecution(
        execution,
        leaseToken,
        isPaused ? EXECUTION_STATE.DEFERRED : EXECUTION_STATE.CANCELLED,
        isPaused ? EXECUTION_REASONS.CAMPAIGN_PAUSED : EXECUTION_REASONS.CAMPAIGN_NOT_ACTIVE
      );
    }

    if (campaign?.endAt && serverNow.getTime() >= new Date(campaign.endAt).getTime()) {
      return this.rejectExecution(
        execution,
        leaseToken,
        EXECUTION_STATE.EXPIRED,
        EXECUTION_REASONS.EXPIRED_LATENESS_CUTOFF
      );
    }

    if (controlGate && campaign && controlGate.pauseGeneration !== campaign.pauseGeneration) {
      return this.rejectExecution(
        execution,
        leaseToken,
        EXECUTION_STATE.DEFERRED,
        EXECUTION_REASONS.PAUSE_GENERATION_MISMATCH
      );
    }

    // PRECEDENCE 3: Invalid source / destination
    if (!customer.destination || !customer.destination.encryptedPhone) {
      return this.rejectExecution(
        execution,
        leaseToken,
        EXECUTION_STATE.SKIPPED,
        EXECUTION_REASONS.INVALID_DESTINATION
      );
    }

    const minVerification = settings?.minDestinationVerification || 'CONFIRMED_BY_STAFF';
    if (!isDestinationVerified(customer.destination, minVerification)) {
      return this.rejectExecution(
        execution,
        leaseToken,
        EXECUTION_STATE.SKIPPED,
        EXECUTION_REASONS.DESTINATION_NOT_VERIFIED
      );
    }

    // Destination Health Check (Spec p20)
    const destGate = await contactGateService.getGate(tenantId, customer.destination.destinationHash);
    if (contactGateService.isHealthUndeliverable(destGate, customer.destination.verifiedAt)) {
      return this.rejectExecution(
        execution,
        leaseToken,
        EXECUTION_STATE.CANCELLED,
        EXECUTION_REASONS.DESTINATION_UNDELIVERABLE
      );
    }

    // Dev sandbox allowlist check (Spec p3, p7, p27)
    // Matched by destinationHash. Controlled by dev-only flag, off in production.
    const isProduction = process.env.NODE_ENV === 'production';
    const isSandboxGuardDisabled = process.env.DISABLE_SANDBOX_GUARD === 'true';
    const isSandboxGuardActive = !isProduction && !isSandboxGuardDisabled;
    const dispatchMode = (process.env.DISPATCH_MODE || config.DISPATCH_MODE || 'dry').toLowerCase();

    if (dispatchMode === 'meta' && isSandboxGuardActive) {
      const isAllowlisted = isDestinationInAllowlist(customer.destination.destinationHash);
      if (!isAllowlisted) {
        return this.rejectExecution(
          execution,
          leaseToken,
          EXECUTION_STATE.BLOCKED,
          EXECUTION_REASONS.SANDBOX_NOT_ALLOWLISTED
        );
      }
    }

    // PRECEDENCE 4: Expiry (Spec p19, p33)
    if (execution.latestUsefulAt && serverNow.getTime() >= new Date(execution.latestUsefulAt).getTime()) {
      return this.rejectExecution(
        execution,
        leaseToken,
        EXECUTION_STATE.SKIPPED,
        EXECUTION_REASONS.INSUFFICIENT_LEAD_TIME
      );
    }

    if (execution.expiresAt && serverNow.getTime() >= new Date(execution.expiresAt).getTime()) {
      return this.rejectExecution(
        execution,
        leaseToken,
        EXECUTION_STATE.EXPIRED,
        EXECUTION_REASONS.EXPIRED_LATENESS_CUTOFF
      );
    }

    const maxLatenessMin = stepConfig.maxLatenessMinutes || 120;
    const latenessCutoff = new Date(new Date(execution.dueAt).getTime() + maxLatenessMin * 60 * 1000);
    if (serverNow.getTime() > latenessCutoff.getTime()) {
      return this.rejectExecution(
        execution,
        leaseToken,
        EXECUTION_STATE.EXPIRED,
        EXECUTION_REASONS.EXPIRED_LATENESS_CUTOFF
      );
    }

    // PRECEDENCE 5: Configured goal / reply stop (goal precedes reply hold per Spec p33)
    if (stepConfig.stopOnGoal === true && enrollment.goalReachedAt != null) {
      return this.rejectExecution(
        execution,
        leaseToken,
        EXECUTION_STATE.SKIPPED,
        EXECUTION_REASONS.SKIPPED_GOAL_REACHED
      );
    }

    if ((stepConfig.stopOnReply === true || (enrollment as any).holdReason != null) && enrollment.replyHoldAt != null) {
      return this.rejectExecution(
        execution,
        leaseToken,
        EXECUTION_STATE.SKIPPED,
        (enrollment as any).holdReason || EXECUTION_REASONS.SKIPPED_REPLY_HOLD
      );
    }

    // PRECEDENCE 6: Content / readiness
    const templateRef = stepConfig.templateRef;
    if (!templateRef?.id) {
      return this.rejectExecution(
        execution,
        leaseToken,
        EXECUTION_STATE.BLOCKED,
        EXECUTION_REASONS.TEMPLATE_NOT_FOUND
      );
    }

    const template: any = await SrcTemplateModel.findOne({ id: templateRef.id }).lean();
    if (!template) {
      return this.rejectExecution(
        execution,
        leaseToken,
        EXECUTION_STATE.BLOCKED,
        EXECUTION_REASONS.TEMPLATE_NOT_FOUND
      );
    }

    // Template check at dispatch: catalogue id + revision + language must equal pinned templateRef (Spec p8, F19c)
    if (template.revision !== templateRef.revision || template.language !== templateRef.language) {
      logger.warn(
        {
          executionId: execution.executionId,
          pinnedTemplateRef: templateRef,
          catalogueTemplate: { id: template.id, revision: template.revision, language: template.language },
        },
        'Template check at dispatch: catalogue revision/language mismatch -> BLOCKED_TEMPLATE.'
      );
      return this.rejectExecution(
        execution,
        leaseToken,
        EXECUTION_STATE.BLOCKED,
        EXECUTION_REASONS.TEMPLATE_REVISION_CHANGED
      );
    }

    const isDispatchMeta = dispatchMode === 'meta';
    const isStatusUsable = template.status === 'APPROVED' || (!isDispatchMeta && template.status === 'DUMMY');

    if (!isStatusUsable) {
      return this.rejectExecution(
        execution,
        leaseToken,
        EXECUTION_STATE.BLOCKED,
        EXECUTION_REASONS.TEMPLATE_NOT_USABLE
      );
    }

    if (isDispatchMeta && template.sendable === false) {
      return this.rejectExecution(
        execution,
        leaseToken,
        EXECUTION_STATE.BLOCKED,
        EXECUTION_REASONS.DUMMY_TEMPLATE_BLOCKED
      );
    }

    // WhatsApp Connection Usability
    const connection: any = await SrcConnectionModel.findOne({ tenantId }).lean();
    if (!connection) {
      return this.rejectExecution(
        execution,
        leaseToken,
        EXECUTION_STATE.BLOCKED,
        EXECUTION_REASONS.CONNECTION_NOT_FOUND
      );
    }

    if (connection.status !== 'ACTIVE') {
      return this.rejectExecution(
        execution,
        leaseToken,
        EXECUTION_STATE.BLOCKED,
        EXECUTION_REASONS.CONNECTION_NOT_USABLE
      );
    }

    // Live dispatch recheck for EVENT_DELAY / Welcome / Purchase Delay executions (Spec p19, p20, F19 & F20 Contract)
    const isEventDelayStep =
      Boolean((execution as any).delaySpec) ||
      Boolean((execution as any).offerRef) ||
      Boolean((execution as any).creditRef) ||
      Boolean((execution as any).adjustedDueAt) ||
      Boolean((execution as any).latestUsefulAt) ||
      Boolean(enrollment.firstOrderId) ||
      Boolean(enrollment.creditId) ||
      Boolean(enrollment.eventId) ||
      Boolean((enrollment as any).enquiryId) ||
      enrollment.occurrenceId.startsWith('enquiry:') ||
      enrollment.occurrenceId.startsWith('welcome:') ||
      enrollment.occurrenceId.startsWith('repeat:') ||
      enrollment.occurrenceId.startsWith('credit:') ||
      enrollment.occurrenceId.startsWith('cashbackconfirm:') ||
      enrollment.occurrenceId.startsWith('gift:') ||
      enrollment.occurrenceId.startsWith('wedding:') ||
      enrollment.occurrenceId.startsWith('outfit:') ||
      (stepConfig as any).delay !== undefined;

    let recheckData: {
      offerAmountRupees?: string;
      order?: any;
      credit?: any;
      serverNow?: Date;
      timezone?: string;
    } = {};

    if (isEventDelayStep) {
      const recheck = await dispatchRecheck(
        execution,
        enrollment,
        customer,
        template
      );

      if (!recheck.proceed) {
        return this.rejectExecution(
          execution,
          leaseToken,
          (recheck.terminalState as any) || EXECUTION_STATE.CANCELLED,
          (recheck.stopReason as any) || EXECUTION_REASONS.PREREQUISITE_NOT_MET
        );
      }

      recheckData = {
        offerAmountRupees: recheck.offerAmountRupees,
        order: recheck.order,
        credit: recheck.credit,
        serverNow,
        timezone: (execution as any).timezone || tenant?.timezone || 'Asia/Kolkata',
      };
    }

    // Parameter binding resolution & validation (Spec p8, p19, p29, C05)
    const stepResolution = await resolveForStep({
      tenantId,
      template,
      step: stepConfig,
      customer,
      tenant,
      campaignVersion: version,
      enrollment,
      order: recheckData?.order,
      offerAmountRupees: recheckData?.offerAmountRupees,
      credit: recheckData?.credit,
      timezone: (execution as any).timezone || tenant?.timezone || 'Asia/Kolkata',
      serverNow,
      clock,
      overrides: {
        bookingLinkUrl: settings?.bookingLinkUrl || null,
      },
    });

    if (stepResolution.snapshot.outfit?.insufficient) {
      logger.info(
        { executionId: execution.executionId },
        'Step skipped: Insufficient matching complements in stock (NO_COMPLEMENT_AVAILABLE).'
      );
      return this.rejectExecution(
        execution,
        leaseToken,
        EXECUTION_STATE.SKIPPED,
        EXECUTION_REASONS.NO_COMPLEMENT_AVAILABLE
      );
    }

    if (!stepResolution.ok) {
      const firstProblem = stepResolution.resolution.problems[0];
      const skipReason =
        firstProblem.code === 'VARIABLE_TOO_LONG'
          ? EXECUTION_REASONS.VARIABLE_TOO_LONG
          : EXECUTION_REASONS.MISSING_VARIABLE_BINDING;

      logger.info(
        {
          executionId: execution.executionId,
          skipReason,
          problem: firstProblem,
        },
        'Step skipped: Template parameter resolution problem.'
      );

      return this.rejectExecution(
        execution,
        leaseToken,
        EXECUTION_STATE.SKIPPED,
        skipReason,
        {
          variableIndex: firstProblem.variableIndex,
          variableName: firstProblem.variableName,
          source: firstProblem.source,
        }
      );
    }

    const canonicalParameters = stepResolution.canonicalParameters;

    // PRECEDENCE 7: Prerequisite (Spec p19, p32, p33)
    if (stepConfig.prerequisite === 'PREVIOUS_ACCEPTED') {
      const stepIndex = version.steps.findIndex((s: any) => s.stepId === execution.stepId);
      if (stepIndex > 0) {
        const priorStepConfig = version.steps[stepIndex - 1];
        const priorExecution: any = await CampaignExecutionModel.findOne({
          tenantId,
          enrollmentId,
          stepId: priorStepConfig.stepId,
        }).lean();

        if (!priorExecution) {
          return this.rejectExecution(
            execution,
            leaseToken,
            EXECUTION_STATE.SKIPPED,
            EXECUTION_REASONS.PREREQUISITE_NOT_MET
          );
        }

        const acceptedStates = [
          EXECUTION_STATE.PROVIDER_ACCEPTED,
          'DELIVERED',
          'READ',
        ];

        if (acceptedStates.includes(priorExecution.state)) {
          // Prerequisite is satisfied!
        } else if (
          priorExecution.state === EXECUTION_STATE.FAILED ||
          priorExecution.state === EXECUTION_STATE.SKIPPED ||
          priorExecution.state === EXECUTION_STATE.CANCELLED ||
          priorExecution.state === EXECUTION_STATE.EXPIRED ||
          priorExecution.state === EXECUTION_STATE.OUTCOME_UNKNOWN
        ) {
          // Spec p19: "Unknown or failed prior submission never counts as accepted."
          // Spec p32 (C13): "Dependent reminder after unknown invitation -> No advancement without acceptance evidence."
          return this.rejectExecution(
            execution,
            leaseToken,
            EXECUTION_STATE.SKIPPED,
            EXECUTION_REASONS.PREREQUISITE_NOT_MET
          );
        } else {
          // Prior step is still in progress / pending (SCHEDULED, DEFERRED, EVALUATING, DISPATCHING)
          if (execution.expiresAt && serverNow.getTime() >= new Date(execution.expiresAt).getTime()) {
            return this.rejectExecution(
              execution,
              leaseToken,
              EXECUTION_STATE.SKIPPED,
              EXECUTION_REASONS.PREREQUISITE_DEADLINE_UNMET
            );
          }

          // Defer until prior step reaches terminal outcome
          return this.rejectExecution(
            execution,
            leaseToken,
            EXECUTION_STATE.DEFERRED,
            EXECUTION_REASONS.WAITING_PREREQUISITE
          );
        }
      }
    }

    // =========================================================================
    // PRECEDENCE 8: Contact Cap & Deterministic Collision Arbitration (Spec p18, p25, p33)
    // =========================================================================
    const destinationHash = customer.destination.destinationHash;
    const effectivePurpose = contactGateService.resolveEffectivePurpose(
      template.category,
      campaign?.presetId,
      version?.purpose
    );

    // 1. Find all CRM customer records sharing this destination (Spec p18, B10)
    // "Caps are tenant-wide, count all campaigns AND customer records sharing one destination, and never merge customer identities."
    const sharedCustomers: any[] = await SrcCustomerModel.find({
      tenantId,
      'destination.destinationHash': destinationHash,
    }).lean();
    const sharedCustomerIds = sharedCustomers.map((c) => c.customerId);

    // 2. Find active enrollments for all shared customer records
    const sharedEnrollments: any[] = await CampaignEnrollmentModel.find({
      tenantId,
      customerId: { $in: sharedCustomerIds },
      status: 'ACTIVE',
    }).lean();
    const sharedEnrollmentIds = sharedEnrollments.map((e) => e.enrollmentId);

    // 3. Find all due executions across these enrollments
    // 3. Find all competing due eligible marketing executions across these enrollments
    // Competing candidates must be for another campaign/enrollment sharing destination,
    // due, unexpired, and in an active status (SCHEDULED, DEFERRED, or valid EVALUATING).
    const competingExecutions: any[] = await CampaignExecutionModel.find({
      tenantId,
      enrollmentId: { $in: sharedEnrollmentIds, $ne: execution.enrollmentId },
      executionId: { $ne: execution.executionId },
      state: { $in: [EXECUTION_STATE.SCHEDULED, EXECUTION_STATE.DEFERRED, EXECUTION_STATE.EVALUATING] },
      dueAt: { $lte: serverNow },
      expiresAt: { $gt: serverNow },
      $or: [{ 'lease.until': null }, { 'lease.until': { $gt: serverNow } }],
    }).lean();

    if (competingExecutions.length > 0) {
      // Rank current execution and all competing executions deterministically:
      // priority desc, then earliest expiry, then stable creation time/ID
      const myRanking = {
        executionId: execution.executionId,
        priority: version?.priority ?? (campaign?.presetId && settings?.priorityAllowlistRanges?.[campaign.presetId]) ?? 80,
        expiresAt: new Date(execution.expiresAt).getTime(),
        createdAt: new Date((execution as any).createdAt || serverNow).getTime(),
      };

      const competitorRankings = await Promise.all(
        competingExecutions.map(async (dueEx) => {
          const enr = sharedEnrollments.find((e) => e.enrollmentId === dueEx.enrollmentId);
          let exPriority = 50;
          if (enr) {
            const camp: any = await CampaignModel.findOne({ tenantId, campaignId: dueEx.campaignId }).lean();
            const ver: any = await CampaignVersionModel.findOne({
              tenantId,
              campaignId: dueEx.campaignId,
              version: enr.campaignVersion,
            }).lean();
            exPriority = ver?.priority ?? (camp?.presetId && settings?.priorityAllowlistRanges?.[camp.presetId]) ?? 50;
          }
          return {
            executionId: dueEx.executionId,
            priority: exPriority,
            expiresAt: new Date(dueEx.expiresAt).getTime(),
            createdAt: new Date(dueEx.createdAt).getTime(),
          };
        })
      );

      const allRankings = [myRanking, ...competitorRankings];
      allRankings.sort((a, b) => {
        if (b.priority !== a.priority) return b.priority - a.priority;
        if (a.expiresAt !== b.expiresAt) return a.expiresAt - b.expiresAt;
        if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
        return a.executionId.localeCompare(b.executionId);
      });

      const winner = allRankings[0];
      if (winner.executionId !== execution.executionId) {
        // Current execution lost collision arbitration to a higher-ranked step!
        logger.info(
          {
            losingExecutionId: execution.executionId,
            winningExecutionId: winner.executionId,
            losingPriority: myRanking.priority,
            winningPriority: winner.priority,
          },
          'Deterministic collision resolution: Execution lost to higher priority/earlier expiry step.'
        );

        const nextSlot = contactGateService.calculateNextAvailableSlot(
          null,
          serverNow,
          settings,
          execution
        );

        if (nextSlot.shouldSkip) {
          return this.rejectExecution(
            execution,
            leaseToken,
            EXECUTION_STATE.SKIPPED,
            EXECUTION_REASONS.SKIPPED_CONTACT_CAP,
            { originalDueAt: nextSlot.originalDueAt }
          );
        }

        const zone = settings?.timezone || 'Asia/Kolkata';
        const dt = DateTime.fromJSDate(nextSlot.nextDueAt!, { zone });

        return this.rejectExecution(
          execution,
          leaseToken,
          EXECUTION_STATE.DEFERRED,
          'Deferred: another campaign contacted this customer',
          {
            dueAt: nextSlot.nextDueAt,
            originalDueAt: nextSlot.originalDueAt,
            localDate: dt.toISODate(),
            localTime: dt.toFormat('HH:mm'),
          }
        );
      }
    }

    // 4. Capacity check against campaignContactGates
    const capCheck = await contactGateService.checkCapacity(
      tenantId,
      destinationHash,
      serverNow,
      settings,
      execution.executionId,
      effectivePurpose
    );

    if (!capCheck.allowed) {
      logger.info(
        {
          executionId: execution.executionId,
          destinationHash,
          reason: capCheck.reason,
          dailyCount: capCheck.dailyCount,
          weeklyCount: capCheck.weeklyCount,
        },
        'Contact cap limit reached: Step deferred or skipped.'
      );

      const nextSlot = contactGateService.calculateNextAvailableSlot(
        capCheck.gate,
        serverNow,
        settings,
        execution,
        capCheck.earliestAvailableAt
      );

      if (nextSlot.shouldSkip) {
        return this.rejectExecution(
          execution,
          leaseToken,
          EXECUTION_STATE.SKIPPED,
          EXECUTION_REASONS.SKIPPED_CONTACT_CAP,
          { originalDueAt: nextSlot.originalDueAt }
        );
      }

      const zone = settings?.timezone || 'Asia/Kolkata';
      const dt = DateTime.fromJSDate(nextSlot.nextDueAt!, { zone });

      return this.rejectExecution(
        execution,
        leaseToken,
        EXECUTION_STATE.DEFERRED,
        'Deferred: another campaign contacted this customer',
        {
          dueAt: nextSlot.nextDueAt,
          originalDueAt: nextSlot.originalDueAt,
          localDate: dt.toISODate(),
          localTime: dt.toFormat('HH:mm'),
        }
      );
    }

    // =========================================================================
    // LATE BINDING & INTENT FREEZING (Spec p19, p23, p25)
    // All gates passed! Prepare immutable delivery intent or reuse existing intent on retry.
    // =========================================================================
    let existingIntent = await CampaignDeliveryIntentModel.findOne({
      tenantId,
      executionId: execution.executionId,
    });

    if (existingIntent) {
      // C20: Frozen intent source changes before safe retry -> Intent blocked as stale (Spec p19, p20)
      if (customer.version !== existingIntent.recipientVersion) {
        logger.warn(
          {
            executionId: execution.executionId,
            recipientVersion: existingIntent.recipientVersion,
            currentCustomerVersion: customer.version,
          },
          'C20: Frozen intent source changed before retry -> BLOCKED_STALE_INTENT.'
        );

        await CampaignDeliveryIntentModel.updateOne(
          { tenantId, executionId: execution.executionId },
          { $set: { state: DELIVERY_INTENT_STATE.BLOCKED_STALE_INTENT } }
        );

        return this.rejectExecution(
          execution,
          leaseToken,
          EXECUTION_STATE.BLOCKED,
          EXECUTION_REASONS.BLOCKED_STALE_INTENT
        );
      }
    }

    const deliveryIntentId = existingIntent?.deliveryIntentId || `di_${crypto.randomUUID()}`;
    const attemptId = `attempt_${crypto.randomUUID()}`;
    const deliveryKey = execution.executionId; // Spec p18, p23: deliveryKey = executionId

    const payloadHash = existingIntent?.payloadHash || stepResolution.payloadHash;

    const deliveryIntentData = {
      deliveryIntentId,
      tenantId,
      campaignId,
      enrollmentId,
      executionId: execution.executionId,
      deliveryKey,
      connectionId: connection.id || connection._id?.toString() || 'conn_shop_a',
      recipientVersion: customer.version || 1,
      encryptedRecipient: customer.destination.encryptedPhone,
      maskedRecipient: customer.destination.masked,
      templateRef: {
        id: template.id,
        revision: template.revision,
        language: template.language,
      },
      parameters: canonicalParameters,
      payloadHash,
      hashVersion: existingIntent ? (existingIntent.hashVersion || 1) : 2,
      selectionSnapshot: stepResolution.snapshot.outfit
        ? {
            anchor: stepResolution.snapshot.outfit.anchor,
            complements: stepResolution.snapshot.outfit.complements,
            matchReasons: stepResolution.snapshot.outfit.matchReasons,
            excludedCount: stepResolution.snapshot.outfit.excluded?.length || 0,
          }
        : ((existingIntent as any)?.selectionSnapshot || null),
      state:
        (process.env.DISPATCH_MODE || config.DISPATCH_MODE || 'dry').toLowerCase() === 'dry'
          ? DELIVERY_INTENT_STATE.PREPARED_DRY
          : DELIVERY_INTENT_STATE.SUBMITTING,
      attemptId,
      providerMessageId: null,
    };

    // Pre-submission availability re-check for enquiry items (spec p13)
    if (enrollment.occurrenceId.startsWith('enquiry:') || (enrollment as any).enquiryId) {
      const enquiryId = (enrollment as any).enquiryId || enrollment.occurrenceId.split(':')[1];
      if (enquiryId) {
        const liveEnquiry = await mockEnquirySource.getEnquiry(tenantId, enquiryId);
        if (!liveEnquiry || liveEnquiry.status !== 'OPEN') {
          const reason =
            !liveEnquiry || liveEnquiry.status === 'DELETED'
              ? EXECUTION_REASONS.ENQUIRY_DELETED
              : liveEnquiry.status === 'RESOLVED'
              ? EXECUTION_REASONS.ENQUIRY_RESOLVED
              : liveEnquiry.status === 'CLOSED'
              ? EXECUTION_REASONS.ENQUIRY_CLOSED
              : EXECUTION_REASONS.ENQUIRY_CANCELLED;
          return this.rejectExecution(
            execution,
            leaseToken,
            EXECUTION_STATE.CANCELLED,
            reason
          );
        }
        if (liveEnquiry.staffTakeover) {
          return this.rejectExecution(
            execution,
            leaseToken,
            EXECUTION_STATE.SKIPPED,
            EXECUTION_REASONS.STAFF_TAKEOVER
          );
        }
        const itemRef = liveEnquiry.itemRef || (enrollment as any).itemRef;
        if (itemRef?.productId) {
          const variant = await mockProductSource.getVariant(tenantId, itemRef.productId, itemRef.variantId || null);
          if (!variant || variant.status !== 'ACTIVE' || variant.sellableQty <= 0) {
            return this.rejectExecution(
              execution,
              leaseToken,
              EXECUTION_STATE.SKIPPED,
              EXECUTION_REASONS.ITEM_UNAVAILABLE
            );
          }
        }
      }
    }

    // Pre-submission availability re-check for requested items (F25)
    if (enrollment.occurrenceId.startsWith('request:') || (enrollment as any).requestId) {
      const requestId = (enrollment as any).requestId || enrollment.occurrenceId.split(':')[1];
      if (requestId) {
        const liveRequest = await mockRequestSource.getRequest(tenantId, requestId);
        if (!liveRequest || liveRequest.status !== 'OPEN') {
          const reason =
            !liveRequest
              ? 'Request deleted'
              : liveRequest.status === 'FULFILLED'
              ? 'Request fulfilled'
              : 'Request cancelled';
          return this.rejectExecution(
            execution,
            leaseToken,
            EXECUTION_STATE.CANCELLED,
            reason
          );
        }
        const itemRef = liveRequest.itemRef || (enrollment as any).itemRef;
        if (itemRef?.productId) {
          const variant = await mockProductSource.getVariant(tenantId, itemRef.productId, itemRef.variantId || null);
          if (!variant || variant.status !== 'ACTIVE' || variant.sellableQty <= 0) {
            return this.rejectExecution(
              execution,
              leaseToken,
              EXECUTION_STATE.SKIPPED,
              EXECUTION_REASONS.ITEM_UNAVAILABLE
            );
          }
        }
      }
    }

    // =========================================================================
    // FINAL CAS & ATOMIC CAPACITY RESERVATION (Spec p25)
    // Consistent lock order: Tenant -> Campaign -> Destination -> Execution
    // Matches: lease token, expected planRevision, state, lease not expired, expiresAt > server now.
    // A stale worker must change nothing.
    // =========================================================================
    const session = await mongoose.startSession();
    let casPassed = false;
    let frozenIntentDoc: any = null;

    try {
      await session.withTransaction(async () => {
        // 1. Reserve contact capacity atomically in consistent lock order (Spec p25)
        await contactGateService.reserveContactCapacityAtomic(
          session,
          tenantId,
          campaignId,
          destinationHash,
          execution.executionId,
          effectivePurpose,
          serverNow,
          settings,
          campaign?.pauseGeneration,
          tenantControlGate?.pauseGeneration
        );

        // 2. Final CAS on execution state
        const updatedExecution = await CampaignExecutionModel.findOneAndUpdate(
          {
            tenantId,
            executionId: execution.executionId,
            'lease.token': leaseToken,
            planRevision: execution.planRevision, // expected planRevision (B15, B20)
            state: EXECUTION_STATE.EVALUATING,
            'lease.until': { $gt: serverNow },
            expiresAt: { $gt: serverNow },
          },
          {
            $set: {
              state: EXECUTION_STATE.DISPATCHING,
              deliveryIntentId,
              'lease.token': null,
              'lease.until': null,
            },
          },
          { session, new: true }
        );

        if (!updatedExecution) {
          logger.warn(
            {
              executionId: execution.executionId,
              leaseToken,
              expectedPlanRevision: execution.planRevision,
            },
            'Final CAS failed: lease expired, plan revision bumped, or state modified by racing replan/worker. Stale worker aborts.'
          );
          throw new Error('STALE_WORKER_CAS_FAILED');
        }

        if (existingIntent) {
          // Reusing existing frozen intent for retry (Spec p19 line 905)
          frozenIntentDoc = existingIntent;
        } else {
          // Freeze immutable delivery intent with unique index (tenantId, executionId)
          const [createdIntent] = await CampaignDeliveryIntentModel.create([deliveryIntentData], { session });
          frozenIntentDoc = createdIntent;
        }
        casPassed = true;
      });
    } catch (err: any) {
      if (err.message === 'PAUSE_GENERATION_MISMATCH') {
        logger.info(
          { executionId: execution.executionId, campaignId },
          'B11: Pause during evaluation detected in submission CAS. Stale worker submission invalidated.'
        );
        return this.rejectExecution(
          execution,
          leaseToken,
          EXECUTION_STATE.DEFERRED,
          EXECUTION_REASONS.CAMPAIGN_PAUSED
        );
      }
      if (err.message === 'TENANT_GLOBAL_PAUSED' || err.message === 'TENANT_GLOBAL_PAUSED_OR_GATE_MISMATCH') {
        logger.info(
          { executionId: execution.executionId, tenantId },
          'Tenant global pause detected in submission CAS. Stale worker submission invalidated.'
        );
        return this.rejectExecution(
          execution,
          leaseToken,
          EXECUTION_STATE.DEFERRED,
          EXECUTION_REASONS.GLOBAL_PAUSED
        );
      }
      if (err.message?.startsWith('CONTACT_CAP_EXCEEDED')) {
        const nextSlot = contactGateService.calculateNextAvailableSlot(
          null,
          serverNow,
          settings,
          execution
        );
        const zone = settings?.timezone || 'Asia/Kolkata';
        const dt = nextSlot.nextDueAt ? DateTime.fromJSDate(nextSlot.nextDueAt, { zone }) : null;

        return this.rejectExecution(
          execution,
          leaseToken,
          nextSlot.shouldSkip ? EXECUTION_STATE.SKIPPED : EXECUTION_STATE.DEFERRED,
          nextSlot.shouldSkip
            ? EXECUTION_REASONS.SKIPPED_CONTACT_CAP
            : 'Deferred: another campaign contacted this customer',
          nextSlot.shouldSkip
            ? { originalDueAt: nextSlot.originalDueAt }
            : {
                dueAt: nextSlot.nextDueAt,
                originalDueAt: nextSlot.originalDueAt,
                localDate: dt?.toISODate(),
                localTime: dt?.toFormat('HH:mm'),
              }
        );
      }
      if (err.message === 'STALE_WORKER_CAS_FAILED') {
        return {
          executionId: execution.executionId,
          stepId: execution.stepId,
          state: EXECUTION_STATE.EVALUATING,
          reason: 'STALE_CAS_FAILED',
        };
      }
      throw err;
    } finally {
      await session.endSession();
    }

    // =========================================================================
    // PROVIDER DISPATCH OUTSIDE TRANSACTION (Hard Rule 4, Spec p25, p27)
    // =========================================================================
    if (casPassed && frozenIntentDoc) {
      // Pre-submission availability re-check for outfit complements (Spec p13)
      const complementsToCheck =
        (frozenIntentDoc as any).selectionSnapshot?.complements ||
        stepResolution.snapshot.outfit?.complements;

      if (
        (enrollment.occurrenceId.startsWith('outfit:') || stepResolution.snapshot.outfit) &&
        Array.isArray(complementsToCheck) &&
        complementsToCheck.length > 0
      ) {
        let soldOut = false;
        for (const comp of complementsToCheck) {
          const prod = await mockProductSource.getProduct(tenantId, comp.productId);
          if (!prod || prod.status !== 'ACTIVE') {
            soldOut = true;
            break;
          }
          const variant = (prod.variants || []).find((v: any) => v.variantId === comp.variantId);
          if (!variant || (variant.sellableQty ?? 0) <= 0) {
            soldOut = true;
            break;
          }
        }

        if (soldOut) {
          logger.warn(
            { executionId: execution.executionId, deliveryIntentId: frozenIntentDoc.deliveryIntentId },
            'Complement item sold out before submission -> BLOCKED_STALE_INTENT / COMPLEMENT_UNAVAILABLE'
          );
          await CampaignDeliveryIntentModel.updateOne(
            { tenantId, executionId: execution.executionId },
            { $set: { state: DELIVERY_INTENT_STATE.BLOCKED_STALE_INTENT } }
          );
          await CampaignExecutionModel.updateOne(
            { tenantId, executionId: execution.executionId },
            {
              $set: {
                state: EXECUTION_STATE.BLOCKED,
                stopReason: EXECUTION_REASONS.COMPLEMENT_UNAVAILABLE,
                lastEvaluatedAt: serverNow,
              },
            }
          );
          return {
            executionId: execution.executionId,
            stepId: execution.stepId,
            state: EXECUTION_STATE.BLOCKED,
            reason: EXECUTION_REASONS.COMPLEMENT_UNAVAILABLE,
            deliveryIntentId: frozenIntentDoc.deliveryIntentId,
          };
        }
      }

      const dispatchPort = getDispatchPort();
      await dispatchPort.dispatch(frozenIntentDoc);

      const refreshed: any = await CampaignExecutionModel.findOne({
        tenantId,
        executionId: execution.executionId,
      }).lean();

      // Synchronize contact gate ledger status based on dispatch outcome
      if (
        refreshed?.state === EXECUTION_STATE.PROVIDER_ACCEPTED ||
        refreshed?.state === 'SENT' ||
        refreshed?.state === 'DELIVERED' ||
        refreshed?.state === 'READ' ||
        (refreshed?.state === EXECUTION_STATE.DISPATCHING &&
          (process.env.DISPATCH_MODE || config.DISPATCH_MODE || 'dry').toLowerCase() === 'dry')
      ) {
        await contactGateService.markAccepted(tenantId, destinationHash, execution.executionId);
      } else if (refreshed?.state === EXECUTION_STATE.FAILED) {
        await contactGateService.releaseReservation(
          tenantId,
          destinationHash,
          execution.executionId,
          'PROVEN_NON_ACCEPTANCE_PERMANENT'
        );
      } else if (
        refreshed?.state === EXECUTION_STATE.DEFERRED &&
        refreshed?.skipReason === EXECUTION_REASONS.RETRY_WAIT
      ) {
        await contactGateService.releaseReservation(
          tenantId,
          destinationHash,
          execution.executionId,
          'PROVEN_NON_ACCEPTANCE_TRANSIENT_RETRY'
        );
      } else if (refreshed?.state === EXECUTION_STATE.OUTCOME_UNKNOWN) {
        await contactGateService.markOutcomeUnknown(tenantId, destinationHash, execution.executionId);
      }

      await this.checkAndCompleteEnrollment(execution.tenantId, execution.enrollmentId);

      return {
        executionId: execution.executionId,
        stepId: execution.stepId,
        state: (refreshed?.state as ExecutionState) || EXECUTION_STATE.DISPATCHING,
        reason: refreshed?.skipReason,
        deliveryIntentId: (refreshed as any)?.deliveryIntentId || deliveryIntentId,
      };
    }

    return {
      executionId: execution.executionId,
      stepId: execution.stepId,
      state: EXECUTION_STATE.EVALUATING,
      reason: 'STALE_CAS_FAILED',
    };
  }

  /**
   * Helper to reject or defer a candidate execution with a specified state and reason,
   * releasing the lease and optionally updating due times.
   */
  private async rejectExecution(
    execution: ICampaignExecution,
    leaseToken: string,
    state: ExecutionState,
    reason: ExecutionReason | string,
    extraUpdates?: Record<string, any>
  ): Promise<{
    executionId: string;
    stepId: string;
    state: ExecutionState;
    reason: string;
  }> {
    const updatePayload: Record<string, any> = {
      state,
      skipReason: reason,
      'lease.token': null,
      'lease.until': null,
      ...extraUpdates,
    };

    await CampaignExecutionModel.findOneAndUpdate(
      {
        tenantId: execution.tenantId,
        executionId: execution.executionId,
        'lease.token': leaseToken,
        state: EXECUTION_STATE.EVALUATING,
      },
      {
        $set: updatePayload,
      }
    );

    // Check if all steps for enrollment are terminal
    await this.checkAndCompleteEnrollment(execution.tenantId, execution.enrollmentId);

    return {
      executionId: execution.executionId,
      stepId: execution.stepId,
      state,
      reason,
    };
  }

  /**
   * Cancels remaining pending steps for an enrollment when customer permission/identity is revoked.
   */
  private async cancelRemainingEnrollmentSteps(
    tenantId: string,
    enrollmentId: string,
    reason: string
  ): Promise<void> {
    await CampaignExecutionModel.updateMany(
      {
        tenantId,
        enrollmentId,
        state: { $in: [EXECUTION_STATE.SCHEDULED, EXECUTION_STATE.DEFERRED] },
      },
      {
        $set: {
          state: EXECUTION_STATE.CANCELLED,
          skipReason: reason,
        },
      }
    );

    await CampaignEnrollmentModel.updateOne(
      { tenantId, enrollmentId },
      { $set: { status: 'CANCELLED' } }
    );
  }

  /**
   * Completes an enrollment if all its planned steps have reached terminal outcomes (Spec p19).
   */
  private async checkAndCompleteEnrollment(tenantId: string, enrollmentId: string): Promise<void> {
    const executions = await CampaignExecutionModel.find({ tenantId, enrollmentId }).lean();
    if (executions.length === 0) return;

    const terminalStates = [
      EXECUTION_STATE.PROVIDER_ACCEPTED,
      EXECUTION_STATE.SKIPPED,
      EXECUTION_STATE.CANCELLED,
      EXECUTION_STATE.EXPIRED,
      EXECUTION_STATE.FAILED,
    ];

    const allTerminal = executions.every((ex) => terminalStates.includes(ex.state as any));
    if (allTerminal) {
      const enrollment = await CampaignEnrollmentModel.findOne({ tenantId, enrollmentId });
      if (enrollment && enrollment.status === 'ACTIVE') {
        const hasAccepted = executions.some((ex) => ex.state === EXECUTION_STATE.PROVIDER_ACCEPTED);
        enrollment.status = hasAccepted ? 'COMPLETED' : 'COMPLETED';
        await enrollment.save();
      }
    }
  }
}

export const workerService = new WorkerService();

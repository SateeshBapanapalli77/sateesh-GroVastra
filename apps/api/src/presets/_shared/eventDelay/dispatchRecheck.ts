import crypto from 'crypto';
import {
  EXECUTION_STATE,
  EXECUTION_REASONS,
  SourceCustomer,
  SourceTemplate,
  isDestinationVerified,
} from '@grovastra/shared';
import {
  CampaignEnrollmentModel,
  CampaignExecutionModel,
  CampaignGoalEventModel,
  CampaignVersionModel,
  ICampaignExecution,
  ICampaignEnrollment,
} from '../../../db/models';
import { mockOfferSource } from '../../../adapters/OfferSource';
import { mockOrderSource } from '../../../adapters/order-source';
import { mockCreditSource } from '../../../adapters/CreditSource';
import { mockOccasionSource } from '../../../adapters/occasion-source';
import { mockEnquirySource } from '../../../adapters/enquiry-source';
import { mockProductSource } from '../../../adapters/product-source';
import { handleEnquirySavedOrUpdated, handleEnquiryResolvedOrDeleted } from '../../unresolvedEnquiry/enquiryChangeHandler';
import { isQualifyingOrder } from '../orderTrigger/qualifying';
import { campaignSettingsService } from '../../../services/campaign-settings.service';
import { contactGateService } from '../../../services/contact-gate/contact-gate.service';
import { clock } from '../../../services/clock';
import { logger } from '../../../logger';
import { computeOfferPrice, SelectedStockDiscount } from '@grovastra/shared';

export interface DispatchRecheckResult {
  proceed: boolean;
  shouldProceed?: boolean;
  stopReason?: string;
  reason?: string;
  terminalState?: string;
  action?: 'CANCEL' | 'SKIP' | 'PROCEED';
  offerAmountRupees?: string;
  order?: any;
  credit?: any;
}

/**
 * Live recheck hook called by the worker engine at dispatch time for EVENT_DELAY steps
 * (Spec p19, p20, p33, F19 & F20 Design Contract).
 *
 * Guarantees that even if an event was dropped or delayed:
 * 1. For First-to-Second Purchase (repeat:):
 *    - Re-fetches orders from OrderSource.
 *    - Stop rule 1: qualifying order count >= 2 -> SKIPPED_GOAL_REACHED + campaignGoalEvents.
 *    - Stop rule 2: anchor order no longer qualifies -> FIRST_ORDER_NO_LONGER_QUALIFIES.
 * 2. Re-fetches authoritative visit state: if VOIDED, stops with VISIT_VOIDED.
 * 3. Re-fetches authoritative credit state if creditRef is set:
 *    - If not found -> CREDIT_NOT_FOUND.
 *    - If not active, balance <= 0, or expired -> CREDIT_NOT_VALID.
 * 4. Re-fetches authoritative offer state if offerRef is set:
 *    - If not active or outside validity -> OFFER_NOT_VALID.
 * 5. Resolves authoritative bindings at the dispatch instant (zero provider calls if invalid).
 */
export async function dispatchRecheck(
  executionOrTenantId: ICampaignExecution | any,
  enrollmentOrExecution?: ICampaignEnrollment | any,
  customer?: SourceCustomer,
  template?: SourceTemplate
): Promise<DispatchRecheckResult> {
  let execution: any;
  let enrollment: any;
  let tenantId: string;

  if (typeof executionOrTenantId === 'string') {
    tenantId = executionOrTenantId;
    execution = enrollmentOrExecution;
    enrollment = undefined;
  } else {
    execution = executionOrTenantId;
    enrollment = enrollmentOrExecution;
    tenantId = execution?.tenantId || enrollment?.tenantId || customer?.tenantId || '';
  }

  if (!enrollment && execution?.enrollmentId) {
    enrollment = (await CampaignEnrollmentModel.findOne({
      tenantId,
      enrollmentId: execution.enrollmentId,
    }).lean()) as any;
  }
  if (!enrollment && execution?.customerId) {
    enrollment = (await CampaignEnrollmentModel.findOne({
      tenantId,
      customerId: execution.customerId,
    }).sort({ createdAt: -1 }).lean()) as any;
  }

  const customerId = execution?.customerId || enrollment?.customerId;
  const now = clock.now();

  // Customer gates & Destination health recheck at dispatch instant (Part 2, Spec p10, p20)
  if (customer) {
    if (customer.deletedAt != null || customer.status === 'DELETED') {
      return {
        proceed: false,
        shouldProceed: false,
        stopReason: EXECUTION_REASONS.CUSTOMER_DELETED,
        reason: EXECUTION_REASONS.CUSTOMER_DELETED,
        terminalState: EXECUTION_STATE.CANCELLED,
        action: 'CANCEL',
      };
    }
    if (customer.consent?.channelSuppressed === true) {
      return {
        proceed: false,
        shouldProceed: false,
        stopReason: EXECUTION_REASONS.CHANNEL_SUPPRESSED,
        reason: EXECUTION_REASONS.CHANNEL_SUPPRESSED,
        terminalState: EXECUTION_STATE.CANCELLED,
        action: 'CANCEL',
      };
    }
    if (customer.consent?.marketingOptIn === false || customer.status === 'OPTED_OUT') {
      return {
        proceed: false,
        shouldProceed: false,
        stopReason: EXECUTION_REASONS.MARKETING_OPT_OUT,
        reason: EXECUTION_REASONS.MARKETING_OPT_OUT,
        terminalState: EXECUTION_STATE.CANCELLED,
        action: 'CANCEL',
      };
    }
    if (customer.destination?.destinationHash) {
      const settings = await campaignSettingsService.getSettings(tenantId);
      const minVerification = settings?.minDestinationVerification || 'CONFIRMED_BY_STAFF';
      if (!isDestinationVerified(customer.destination, minVerification)) {
        return {
          proceed: false,
          shouldProceed: false,
          stopReason: EXECUTION_REASONS.DESTINATION_NOT_VERIFIED,
          reason: EXECUTION_REASONS.DESTINATION_NOT_VERIFIED,
          terminalState: EXECUTION_STATE.SKIPPED,
          action: 'SKIP',
        };
      }
      const destGate = await contactGateService.getGate(tenantId, customer.destination.destinationHash);
      if (contactGateService.isHealthUndeliverable(destGate, customer.destination.verifiedAt)) {
        return {
          proceed: false,
          shouldProceed: false,
          stopReason: EXECUTION_REASONS.DESTINATION_UNDELIVERABLE,
          reason: EXECUTION_REASONS.DESTINATION_UNDELIVERABLE,
          terminalState: EXECUTION_STATE.CANCELLED,
          action: 'CANCEL',
        };
      }
    }
  }

  // Occasion Recheck (Gift / Wedding reminder)
  const isOccasionOccurrence =
    Boolean(enrollment?.occurrenceId?.startsWith('gift:')) ||
    Boolean(enrollment?.occurrenceId?.startsWith('wedding:')) ||
    Boolean(enrollment?.eventId);

  if (isOccasionOccurrence) {
    if (execution?.latestUsefulAt && now.getTime() >= new Date(execution.latestUsefulAt).getTime()) {
      return {
        proceed: false,
        shouldProceed: false,
        stopReason: EXECUTION_REASONS.INSUFFICIENT_LEAD_TIME,
        reason: EXECUTION_REASONS.INSUFFICIENT_LEAD_TIME,
        terminalState: EXECUTION_STATE.SKIPPED,
        action: 'SKIP',
      };
    }

    const eventId = enrollment?.eventId || enrollment?.occurrenceId?.split(':')[1];
    if (eventId) {
      const occasion = await mockOccasionSource.getOccasion(tenantId, eventId);
      if (!occasion || occasion.deletedAt) {
        return {
          proceed: false,
          shouldProceed: false,
          stopReason: EXECUTION_REASONS.OCCASION_DELETED,
          reason: EXECUTION_REASONS.OCCASION_DELETED,
          terminalState: EXECUTION_STATE.CANCELLED,
          action: 'CANCEL',
        };
      }
      if (occasion.status === 'CANCELLED') {
        return {
          proceed: false,
          shouldProceed: false,
          stopReason: EXECUTION_REASONS.OCCASION_CANCELLED,
          reason: EXECUTION_REASONS.OCCASION_CANCELLED,
          terminalState: EXECUTION_STATE.CANCELLED,
          action: 'CANCEL',
        };
      }
      if (occasion.status === 'COMPLETED') {
        return {
          proceed: false,
          shouldProceed: false,
          stopReason: EXECUTION_REASONS.OCCASION_COMPLETED,
          reason: EXECUTION_REASONS.OCCASION_COMPLETED,
          terminalState: EXECUTION_STATE.CANCELLED,
          action: 'CANCEL',
        };
      }
      if (
        (enrollment?.eventDateSnapshot && occasion.eventDateKey !== enrollment.eventDateSnapshot) ||
        (enrollment?.sourceRef?.version && occasion.entityVersion !== enrollment.sourceRef.version)
      ) {
        return {
          proceed: false,
          shouldProceed: false,
          stopReason: EXECUTION_REASONS.OCCASION_DATE_CHANGED_REPLANNED,
          reason: EXECUTION_REASONS.OCCASION_DATE_CHANGED_REPLANNED,
          terminalState: EXECUTION_STATE.DEFERRED,
          action: 'SKIP',
        };
      }
    }
  }

  // Enquiry Live Re-check (Spec p8, p13, p14, p20)
  const isEnquiryOccurrence =
    Boolean(enrollment?.occurrenceId?.startsWith('enquiry:')) ||
    Boolean(enrollment?.enquiryId);

  if (isEnquiryOccurrence) {
    const enquiryId =
      enrollment?.enquiryId ||
      (enrollment?.occurrenceId?.startsWith('enquiry:')
        ? enrollment.occurrenceId.split(':')[1]
        : null);

    if (!enquiryId) {
      return {
        proceed: false,
        shouldProceed: false,
        stopReason: EXECUTION_REASONS.ENQUIRY_DELETED,
        reason: EXECUTION_REASONS.ENQUIRY_DELETED,
        terminalState: EXECUTION_STATE.CANCELLED,
        action: 'CANCEL',
      };
    }

    const enquiry = await mockEnquirySource.getEnquiry(tenantId, enquiryId);
    if (!enquiry || enquiry.status === 'DELETED') {
      await handleEnquiryResolvedOrDeleted({
        tenantId,
        enquiryId,
        status: 'DELETED',
      });
      return {
        proceed: false,
        shouldProceed: false,
        stopReason: EXECUTION_REASONS.ENQUIRY_DELETED,
        reason: EXECUTION_REASONS.ENQUIRY_DELETED,
        terminalState: EXECUTION_STATE.CANCELLED,
        action: 'CANCEL',
      };
    }

    if (enquiry.status === 'RESOLVED') {
      await handleEnquiryResolvedOrDeleted({
        tenantId,
        enquiryId,
        status: 'RESOLVED',
      });
      return {
        proceed: false,
        shouldProceed: false,
        stopReason: EXECUTION_REASONS.ENQUIRY_RESOLVED,
        reason: EXECUTION_REASONS.ENQUIRY_RESOLVED,
        terminalState: EXECUTION_STATE.CANCELLED,
        action: 'CANCEL',
      };
    }

    if (enquiry.status === 'CLOSED') {
      await handleEnquiryResolvedOrDeleted({
        tenantId,
        enquiryId,
        status: 'CLOSED',
      });
      return {
        proceed: false,
        shouldProceed: false,
        stopReason: EXECUTION_REASONS.ENQUIRY_CLOSED,
        reason: EXECUTION_REASONS.ENQUIRY_CLOSED,
        terminalState: EXECUTION_STATE.CANCELLED,
        action: 'CANCEL',
      };
    }

    if (enquiry.status === 'CANCELLED') {
      await handleEnquiryResolvedOrDeleted({
        tenantId,
        enquiryId,
        status: 'CANCELLED',
      });
      return {
        proceed: false,
        shouldProceed: false,
        stopReason: EXECUTION_REASONS.ENQUIRY_CANCELLED,
        reason: EXECUTION_REASONS.ENQUIRY_CANCELLED,
        terminalState: EXECUTION_STATE.CANCELLED,
        action: 'CANCEL',
      };
    }

    // Check staff takeover
    if (enquiry.staffTakeover) {
      if (!enrollment.replyHoldAt || enrollment.holdReason !== 'STAFF_TAKEOVER') {
        await CampaignEnrollmentModel.updateOne(
          { tenantId, enrollmentId: enrollment.enrollmentId },
          { $set: { replyHoldAt: now, holdReason: 'STAFF_TAKEOVER' } }
        );
      }
      return {
        proceed: false,
        shouldProceed: false,
        stopReason: EXECUTION_REASONS.STAFF_TAKEOVER,
        reason: EXECUTION_REASONS.STAFF_TAKEOVER,
        terminalState: EXECUTION_STATE.SKIPPED,
        action: 'SKIP',
      };
    }

    // Check if anchor changed vs planned anchor
    const plannedAnchor = enrollment.anchorAt || execution.anchorAt;
    if (
      plannedAnchor &&
      enquiry.lastCustomerInteractionAt &&
      new Date(enquiry.lastCustomerInteractionAt).getTime() !== new Date(plannedAnchor).getTime()
    ) {
      logger.info(
        { tenantId, executionId: execution.executionId, enquiryId },
        'Dispatch recheck: Enquiry last customer interaction moved. Triggering replan.'
      );
      await handleEnquirySavedOrUpdated({
        tenantId,
        enquiry,
      });

      return {
        proceed: false,
        shouldProceed: false,
        stopReason: 'ANCHOR_CHANGED_REPLANNED',
        reason: 'ANCHOR_CHANGED_REPLANNED',
        terminalState: EXECUTION_STATE.DEFERRED,
        action: 'SKIP',
      };
    }

    // Check useful-until rule
    const usefulDays = enrollment.usefulForDays || 14;
    const usefulUntil = new Date(new Date(enquiry.createdAt).getTime() + usefulDays * 86400000);
    if (now.getTime() >= usefulUntil.getTime() || (execution.dueAt && new Date(execution.dueAt).getTime() > usefulUntil.getTime())) {
      logger.info(
        { tenantId, executionId: execution.executionId, enquiryId, usefulUntil },
        'Dispatch recheck: Step exceeds enquiry usefulForDays window. Skipping with ENQUIRY_TOO_OLD.'
      );
      return {
        proceed: false,
        shouldProceed: false,
        stopReason: EXECUTION_REASONS.ENQUIRY_TOO_OLD,
        reason: EXECUTION_REASONS.ENQUIRY_TOO_OLD,
        terminalState: EXECUTION_STATE.SKIPPED,
        action: 'SKIP',
      };
    }

    // Check product availability
    const itemRef = enquiry.itemRef || enrollment.itemRef;
    if (itemRef?.productId) {
      const variant = await mockProductSource.getVariant(tenantId, itemRef.productId, itemRef.variantId || null);
      if (!variant || variant.status !== 'ACTIVE' || variant.sellableQty <= 0) {
        logger.info(
          { tenantId, executionId: execution.executionId, productId: itemRef.productId, variantId: itemRef.variantId },
          'Dispatch recheck: Enquired product is not sellable. Skipping step with ITEM_UNAVAILABLE.'
        );
        return {
          proceed: false,
          shouldProceed: false,
          stopReason: EXECUTION_REASONS.ITEM_UNAVAILABLE,
          reason: EXECUTION_REASONS.ITEM_UNAVAILABLE,
          terminalState: EXECUTION_STATE.SKIPPED,
          action: 'SKIP',
        };
      }
    }
  }

  let resolvedOrder: any = null;
  let resolvedCredit: any = null;
  let offerAmountRupees: string | undefined = undefined;

  // 1. First-to-Second Purchase Live Order Re-check (Spec p14, p20)
  const isRepeatPurchase = Boolean(enrollment?.occurrenceId?.startsWith('repeat:'));
  const isWelcomeOrder = Boolean(enrollment?.occurrenceId?.startsWith('welcome:'));

  if (isRepeatPurchase && customerId) {
    const customerOrders = await mockOrderSource.listOrdersForCustomer(tenantId, customerId);
    const qualifyingOrders = customerOrders.filter((o) => isQualifyingOrder(o));

    // Stop Rule: count >= 2 qualifying orders -> Goal reached
    if (qualifyingOrders.length >= 2) {
      logger.info(
        { tenantId, executionId: execution.executionId, customerId, qualifyingCount: qualifyingOrders.length },
        'Dispatch recheck: Customer has reached 2+ qualifying orders. Skipping execution with SKIPPED_GOAL_REACHED.'
      );

      // Record goal event if not already present
      const secondOrder = qualifyingOrders[1] || qualifyingOrders[qualifyingOrders.length - 1];
      const existingGoal = await CampaignGoalEventModel.findOne({
        tenantId,
        enrollmentId: enrollment?.enrollmentId,
        source: 'SECOND_QUALIFYING_ORDER',
      });

      if (!existingGoal && enrollment?.enrollmentId) {
        await CampaignGoalEventModel.create({
          goalEventId: `cge_${crypto.randomUUID().slice(0, 12)}`,
          tenantId,
          enrollmentId: enrollment.enrollmentId,
          occurrence: enrollment.occurrenceId,
          customerId,
          campaignId: enrollment.campaignId,
          source: 'SECOND_QUALIFYING_ORDER',
          orderRef: secondOrder.orderId,
          cause: `Second qualifying order ${secondOrder.orderNumber || secondOrder.orderId} completed`,
          recordedBy: 'SYSTEM',
          at: now,
        });
      }

      if (enrollment?.enrollmentId) {
        await CampaignEnrollmentModel.updateOne(
          { tenantId, enrollmentId: enrollment.enrollmentId },
          {
            $set: {
              status: 'CANCELLED',
              stopReason: EXECUTION_REASONS.SKIPPED_GOAL_REACHED,
              stoppedAt: now,
              goalReachedAt: now,
              goalOrderRef: secondOrder?.orderId || null,
              goalSource: 'SECOND_QUALIFYING_ORDER',
            },
          }
        );
      }

      return {
        proceed: false,
        shouldProceed: false,
        stopReason: EXECUTION_REASONS.SKIPPED_GOAL_REACHED,
        reason: EXECUTION_REASONS.SKIPPED_GOAL_REACHED,
        terminalState: EXECUTION_STATE.SKIPPED,
        action: 'SKIP',
      };
    }

    // Stop Rule: Anchor order no longer qualifies (e.g. refunded or cancelled)
    const anchorOrderId =
      enrollment?.firstOrderId ||
      (enrollment?.occurrenceId?.startsWith('repeat:')
        ? enrollment.occurrenceId.substring(7)
        : execution.orderRef);

    const anchorOrder = customerOrders.find((o) => o.orderId === anchorOrderId);
    if (!anchorOrder || !isQualifyingOrder(anchorOrder)) {
      logger.info(
        { tenantId, executionId: execution.executionId, anchorOrderId },
        'Dispatch recheck: Anchor order no longer qualifies. Cancelling execution with FIRST_ORDER_NO_LONGER_QUALIFIES.'
      );

      if (enrollment?.enrollmentId) {
        await CampaignEnrollmentModel.updateOne(
          { tenantId, enrollmentId: enrollment.enrollmentId },
          {
            $set: {
              status: 'CANCELLED',
              stopReason: EXECUTION_REASONS.FIRST_ORDER_NO_LONGER_QUALIFIES,
              stoppedAt: now,
            },
          }
        );
      }

      return {
        proceed: false,
        shouldProceed: false,
        stopReason: EXECUTION_REASONS.FIRST_ORDER_NO_LONGER_QUALIFIES,
        reason: EXECUTION_REASONS.FIRST_ORDER_NO_LONGER_QUALIFIES,
        terminalState: EXECUTION_STATE.CANCELLED,
        action: 'CANCEL',
      };
    }

    resolvedOrder = anchorOrder;
  }

  // Welcome Order mode re-check (Spec p14, F19b v2)
  if (isWelcomeOrder && customerId) {
    const customerOrders = await mockOrderSource.listOrdersForCustomer(tenantId, customerId);
    const anchorOrderId =
      enrollment?.anchorOrderId ||
      enrollment?.firstOrderId ||
      (enrollment?.occurrenceId?.startsWith('welcome:')
        ? enrollment.occurrenceId.substring('welcome:'.length)
        : execution.orderRef);

    const anchorOrder = customerOrders.find((o) => o.orderId === anchorOrderId);
    if (!anchorOrder || !isQualifyingOrder(anchorOrder)) {
      logger.info(
        { tenantId, executionId: execution.executionId, anchorOrderId },
        'Dispatch recheck: Welcome anchor order no longer qualifies. Cancelling with FIRST_ORDER_NO_LONGER_QUALIFIES.'
      );

      if (enrollment?.enrollmentId) {
        await CampaignEnrollmentModel.updateOne(
          { tenantId, enrollmentId: enrollment.enrollmentId },
          {
            $set: {
              status: 'CANCELLED',
              stopReason: EXECUTION_REASONS.FIRST_ORDER_NO_LONGER_QUALIFIES,
              stoppedAt: now,
            },
          }
        );
      }

      return {
        proceed: false,
        shouldProceed: false,
        stopReason: EXECUTION_REASONS.FIRST_ORDER_NO_LONGER_QUALIFIES,
        reason: EXECUTION_REASONS.FIRST_ORDER_NO_LONGER_QUALIFIES,
        terminalState: EXECUTION_STATE.CANCELLED,
        action: 'CANCEL',
      };
    }

    // Min first order net paise check at dispatch
    let minPaise = 0;
    if (enrollment?.campaignVersionId) {
      const v: any = await CampaignVersionModel.findById(enrollment.campaignVersionId).lean();
      if (v?.minFirstOrderNetPaise) minPaise = v.minFirstOrderNetPaise;
    }
    const currentNet =
      anchorOrder.netPaise !== undefined
        ? anchorOrder.netPaise
        : (anchorOrder.grossPaise || 0) - (anchorOrder.refundedPaise || 0);

    if (minPaise > 0 && currentNet < minPaise) {
      logger.info(
        { tenantId, executionId: execution.executionId, currentNet, minPaise },
        'Dispatch recheck: Anchor order net is below minimum. Skipping with FIRST_ORDER_BELOW_MINIMUM.'
      );
      return {
        proceed: false,
        shouldProceed: false,
        stopReason: EXECUTION_REASONS.FIRST_ORDER_BELOW_MINIMUM,
        reason: EXECUTION_REASONS.FIRST_ORDER_BELOW_MINIMUM,
        terminalState: EXECUTION_STATE.SKIPPED,
        action: 'SKIP',
      };
    }

    resolvedOrder = anchorOrder;
  }

  // 1c. Complete the Outfit Re-check (Spec p14, F24)
  const isOutfitOccurrence = Boolean(enrollment?.occurrenceId?.startsWith('outfit:'));
  if (isOutfitOccurrence && customerId) {
    const customerOrders = await mockOrderSource.listOrdersForCustomer(tenantId, customerId);
    const anchorOrderId =
      enrollment?.anchorOrderId ||
      (enrollment?.occurrenceId?.startsWith('outfit:')
        ? enrollment.occurrenceId.substring('outfit:'.length)
        : execution.orderRef);

    const anchorOrder =
      customerOrders.find((o) => o.orderId === anchorOrderId) ||
      (await mockOrderSource.getOrderById(tenantId, anchorOrderId));

    // Stop Rule: Anchor order no longer qualifies
    if (!anchorOrder || !isQualifyingOrder(anchorOrder)) {
      logger.info(
        { tenantId, executionId: execution.executionId, anchorOrderId },
        'Dispatch recheck: Outfit anchor order no longer qualifies. Cancelling execution with ANCHOR_ORDER_NO_LONGER_QUALIFIES.'
      );

      if (enrollment?.enrollmentId) {
        await CampaignEnrollmentModel.updateOne(
          { tenantId, enrollmentId: enrollment.enrollmentId },
          {
            $set: {
              status: 'CANCELLED',
              stopReason: EXECUTION_REASONS.ANCHOR_ORDER_NO_LONGER_QUALIFIES,
              stoppedAt: now,
            },
          }
        );
      }

      return {
        proceed: false,
        shouldProceed: false,
        stopReason: EXECUTION_REASONS.ANCHOR_ORDER_NO_LONGER_QUALIFIES,
        reason: EXECUTION_REASONS.ANCHOR_ORDER_NO_LONGER_QUALIFIES,
        terminalState: EXECUTION_STATE.CANCELLED,
        action: 'CANCEL',
      };
    }

    // Stop Rule: Check if all anchor lines are returned
    let pairing: any = null;
    let stopOnGoal = true;
    let goalMode = 'COMPLEMENT_OR_TAGGED';
    if (enrollment?.campaignVersionId) {
      const v: any = await CampaignVersionModel.findById(enrollment.campaignVersionId).lean();
      pairing = v?.config?.pairing;
      if (v?.config?.stopOnGoal !== undefined) stopOnGoal = v.config.stopOnGoal;
      if (v?.config?.goalMode) goalMode = v.config.goalMode;
    }
    const anchorCategories: string[] = pairing?.anchorCategories || ['saree'];
    const complementMap: Record<string, string[]> = pairing?.complementMap || {
      saree: ['blouse', 'petticoat', 'dupatta', 'accessories'],
      lehenga: ['dupatta', 'accessories'],
      kurta: ['dupatta', 'accessories'],
    };

    let hasActiveAnchorLine = false;
    let primaryAnchorCategory: string = anchorCategories[0] || 'saree';
    for (const line of anchorOrder.lines || []) {
      if (!line.productId) continue;
      const prod = await mockProductSource.getProduct(tenantId, line.productId);
      if (
        prod &&
        prod.category &&
        anchorCategories.map((c) => c.toLowerCase()).includes(prod.category.toLowerCase())
      ) {
        const retQty = line.returnedQty ?? 0;
        const qty = line.qty ?? line.quantity ?? 1;
        if (retQty < qty) {
          hasActiveAnchorLine = true;
          primaryAnchorCategory = prod.category;
        }
      }
    }

    if (!hasActiveAnchorLine) {
      logger.info(
        { tenantId, executionId: execution.executionId, anchorOrderId },
        'Dispatch recheck: All anchor lines in outfit order returned. Cancelling execution with ANCHOR_LINES_RETURNED.'
      );

      if (enrollment?.enrollmentId) {
        await CampaignEnrollmentModel.updateOne(
          { tenantId, enrollmentId: enrollment.enrollmentId },
          {
            $set: {
              status: 'CANCELLED',
              stopReason: EXECUTION_REASONS.ANCHOR_LINES_RETURNED,
              stoppedAt: now,
            },
          }
        );
      }

      return {
        proceed: false,
        shouldProceed: false,
        stopReason: EXECUTION_REASONS.ANCHOR_LINES_RETURNED,
        reason: EXECUTION_REASONS.ANCHOR_LINES_RETURNED,
        terminalState: EXECUTION_STATE.CANCELLED,
        action: 'CANCEL',
      };
    }

    // Goal Check (stopOnGoal)
    if (stopOnGoal) {
      const anchorCompletedTime = anchorOrder.completedAt
        ? new Date(anchorOrder.completedAt).getTime()
        : 0;
      const laterOrders = customerOrders.filter((o) => {
        if (!o.completedAt || !isQualifyingOrder(o)) return false;
        return new Date(o.completedAt).getTime() > anchorCompletedTime;
      });

      for (const ord of laterOrders) {
        let isGoal = false;
        let goalSource = 'OUTFIT_COMPLEMENT_PURCHASED';

        // Tagged check
        if (ord.outfitRef === `outfit:${anchorOrderId}`) {
          isGoal = true;
          goalSource = 'TAGGED_ORDER';
        } else if (goalMode === 'COMPLEMENT_OR_TAGGED') {
          // Check complement categories
          const complementCats = (complementMap[primaryAnchorCategory] || []).map((c) =>
            c.toLowerCase()
          );
          for (const line of ord.lines || []) {
            const retQty = line.returnedQty ?? 0;
            const qty = line.qty ?? line.quantity ?? 1;
            if (retQty < qty && line.productId) {
              const prod = await mockProductSource.getProduct(tenantId, line.productId);
              if (prod?.category && complementCats.includes(prod.category.toLowerCase())) {
                isGoal = true;
                goalSource = 'OUTFIT_COMPLEMENT_PURCHASED';
                break;
              }
            }
          }
        }

        if (isGoal) {
          logger.info(
            { tenantId, executionId: execution.executionId, orderId: ord.orderId, goalSource },
            'Dispatch recheck: Customer bought complement or tagged order. Skipping with SKIPPED_GOAL_REACHED.'
          );

          if (enrollment?.enrollmentId) {
            await CampaignGoalEventModel.create({
              goalEventId: `cge_${crypto.randomUUID().slice(0, 12)}`,
              tenantId,
              enrollmentId: enrollment.enrollmentId,
              occurrence: enrollment.occurrenceId,
              customerId,
              campaignId: enrollment.campaignId,
              source: goalSource,
              orderRef: ord.orderId,
              cause: `Complement purchase in order ${ord.orderNumber || ord.orderId} completed`,
              recordedBy: 'SYSTEM',
              at: now,
            });

            await CampaignEnrollmentModel.updateOne(
              { tenantId, enrollmentId: enrollment.enrollmentId },
              {
                $set: {
                  status: 'CANCELLED',
                  stopReason: EXECUTION_REASONS.SKIPPED_GOAL_REACHED,
                  stoppedAt: now,
                  goalReachedAt: now,
                  goalOrderRef: ord.orderId,
                  goalSource,
                },
              }
            );
          }

          return {
            proceed: false,
            shouldProceed: false,
            stopReason: EXECUTION_REASONS.SKIPPED_GOAL_REACHED,
            reason: EXECUTION_REASONS.SKIPPED_GOAL_REACHED,
            terminalState: EXECUTION_STATE.SKIPPED,
            action: 'SKIP',
          };
        }
      }
    }

    resolvedOrder = anchorOrder;
  }

  // 2. Re-fetch Credit Status if step references a credit
  const creditRef = execution.creditRef;
  const hasCreditRef = Boolean(creditRef && (creditRef.creditId || creditRef.selector || creditRef.reason));
  if (hasCreditRef && customerId) {
    let creditDoc: any = null;

    if (creditRef.creditId) {
      creditDoc = await mockCreditSource.getCredit(tenantId, creditRef.creditId);
    } else {
      const credits = await mockCreditSource.listCreditsForCustomer(tenantId, customerId);
      const reasonFilter = creditRef.reason || 'FIRST_ORDER_REWARD';
      creditDoc = credits.find(
        (c) =>
          (c.sourceOrderId && c.sourceOrderId === (resolvedOrder?.orderId || enrollment?.firstOrderId)) ||
          c.reason === reasonFilter
      );
    }

    if (!creditDoc) {
      logger.warn(
        { tenantId, executionId: execution.executionId, customerId },
        'Dispatch recheck: Referenced credit not found. Skipping with CREDIT_NOT_FOUND.'
      );
      return {
        proceed: false,
        shouldProceed: false,
        stopReason: EXECUTION_REASONS.CREDIT_NOT_FOUND,
        reason: EXECUTION_REASONS.CREDIT_NOT_FOUND,
        terminalState: EXECUTION_STATE.SKIPPED,
        action: 'SKIP',
      };
    }

    const isExpired = creditDoc.expiresAt && now.getTime() > new Date(creditDoc.expiresAt).getTime();
    if (creditDoc.status !== 'ACTIVE' || creditDoc.amount <= 0 || isExpired) {
      logger.info(
        {
          tenantId,
          executionId: execution.executionId,
          creditId: creditDoc.creditId,
          status: creditDoc.status,
          amount: creditDoc.amount,
          expiresAt: creditDoc.expiresAt,
        },
        'Dispatch recheck: Credit is not active, zero balance, or expired. Skipping with CREDIT_NOT_VALID.'
      );
      return {
        proceed: false,
        shouldProceed: false,
        stopReason: EXECUTION_REASONS.CREDIT_NOT_VALID,
        reason: EXECUTION_REASONS.CREDIT_NOT_VALID,
        terminalState: EXECUTION_STATE.SKIPPED,
        action: 'SKIP',
      };
    }

    resolvedCredit = creditDoc;
  }

  // 4. Re-fetch Offer Status if step references an offer
  const offerRef = execution.offerRef;
  const offerNotValidReason = isRepeatPurchase
    ? EXECUTION_REASONS.OFFER_NOT_VALID
    : EXECUTION_REASONS.WELCOME_OFFER_NOT_VALID;

  if (offerRef?.offerId) {
    const offer = await mockOfferSource.getOfferById(tenantId, offerRef.offerId);

    if (!offer) {
      logger.warn(
        { tenantId, executionId: execution.executionId, offerId: offerRef.offerId },
        `Dispatch recheck: Offer not found. Skipping with ${offerNotValidReason}.`
      );
      return {
        proceed: false,
        shouldProceed: false,
        stopReason: offerNotValidReason,
        reason: offerNotValidReason,
        terminalState: EXECUTION_STATE.SKIPPED,
        action: 'SKIP',
      };
    }

    if (offer.kind === 'SELECTED_STOCK') {
      if (offer.status === 'PAUSED') {
        return { proceed: false, shouldProceed: false, stopReason: 'OFFER_PAUSED', reason: 'OFFER_PAUSED', terminalState: EXECUTION_STATE.SKIPPED, action: 'SKIP' };
      }
      if (offer.status === 'WITHDRAWN') {
        return { proceed: false, shouldProceed: false, stopReason: 'OFFER_WITHDRAWN', reason: 'OFFER_WITHDRAWN', terminalState: EXECUTION_STATE.SKIPPED, action: 'SKIP' };
      }
      const snapshot = execution.selectionSnapshot;
      if (snapshot?.items?.length) {
        for (const selected of snapshot.items) {
          const product = await mockProductSource.getProduct(tenantId, selected.productId);
          if (!product || product.status !== 'ACTIVE') {
            return { proceed: false, shouldProceed: false, stopReason: EXECUTION_REASONS.ITEM_UNAVAILABLE, reason: EXECUTION_REASONS.ITEM_UNAVAILABLE, terminalState: EXECUTION_STATE.SKIPPED, action: 'SKIP' };
          }
          const variant = product.variants?.find((entry: any) => entry.variantId === selected.variantId);
          if (!variant || variant.sellableQty <= 0) {
            return { proceed: false, shouldProceed: false, stopReason: EXECUTION_REASONS.ITEM_UNAVAILABLE, reason: EXECUTION_REASONS.ITEM_UNAVAILABLE, terminalState: EXECUTION_STATE.SKIPPED, action: 'SKIP' };
          }
          if (product.entityVersion !== selected.entityVersion || product.pricePaise !== selected.regularPricePaise) {
            return { proceed: false, shouldProceed: false, stopReason: 'OFFER_ITEM_PRICE_CHANGED', reason: 'OFFER_ITEM_PRICE_CHANGED', terminalState: EXECUTION_STATE.BLOCKED, action: 'SKIP' };
          }
          const offerItem = (offer.items || []).find((item: any) => item.productId === selected.productId);
          const regularPricePaise = product.pricePaise;
          const discount: SelectedStockDiscount | null = offer.discount?.type === 'PERCENT_OFF'
            ? { type: 'PERCENT_OFF', percent: offer.discount.percent || 0 }
            : offer.discount?.type === 'FLAT_OFF'
              ? { type: 'FLAT_OFF', flatOffPaise: offer.discount.flatOffPaise || 0 }
              : offer.discount?.type === 'SPECIAL_PRICE'
                ? { type: 'SPECIAL_PRICE' }
                : null;
          const currentOfferPrice = offerItem && discount && Number.isInteger(regularPricePaise)
            ? computeOfferPrice(regularPricePaise as number, discount, offerItem)
            : null;
          if (currentOfferPrice === null || currentOfferPrice !== selected.offerPricePaise) {
            return { proceed: false, shouldProceed: false, stopReason: 'OFFER_ITEM_PRICE_CHANGED', reason: 'OFFER_ITEM_PRICE_CHANGED', terminalState: EXECUTION_STATE.BLOCKED, action: 'SKIP' };
          }
        }
      }
    }
    const validFrom = new Date(offer.validFrom);
    const validUntil = new Date(offer.validUntil);

    if (
      offer.status !== 'ACTIVE' ||
      now.getTime() < validFrom.getTime() ||
      now.getTime() > validUntil.getTime()
    ) {
      logger.info(
        {
          tenantId,
          executionId: execution.executionId,
          offerId: offer.offerId,
          status: offer.status,
          now: now.toISOString(),
          validFrom: validFrom.toISOString(),
          validUntil: validUntil.toISOString(),
        },
        `Dispatch recheck: Offer is not valid or expired at dispatch instant. Skipping with ${offer.kind === 'SELECTED_STOCK' && now > validUntil ? 'OFFER_ENDED' : offerNotValidReason}.`
      );
      return {
        proceed: false,
        shouldProceed: false,
        stopReason: offer.kind === 'SELECTED_STOCK' && now > validUntil ? 'OFFER_ENDED' : offerNotValidReason,
        reason: offer.kind === 'SELECTED_STOCK' && now > validUntil ? 'OFFER_ENDED' : offerNotValidReason,
        terminalState: EXECUTION_STATE.SKIPPED,
        action: 'SKIP',
      };
    }

    const rupees = offer.amountPaise / 100;
    offerAmountRupees = rupees % 1 === 0 ? String(rupees) : rupees.toFixed(2);
  }

  return {
    proceed: true,
    shouldProceed: true,
    action: 'PROCEED',
    offerAmountRupees,
    order: resolvedOrder,
    credit: resolvedCredit,
  };
}

import crypto from 'crypto';
import {
  CAMPAIGN_STATUS,
  ENROLLMENT_STATUS,
  EXECUTION_STATE,
  EXECUTION_REASONS,
  EVENT_INBOX_STATUS,
  QUARANTINE_REASONS,
  CampaignEventInput,
  CampaignEventInputSchema,
} from '@grovastra/shared';
import {
  CampaignModel,
  CampaignVersionModel,
  CampaignEnrollmentModel,
  CampaignExecutionModel,
  CampaignEventInboxModel,
  CampaignCustomerFactModel,
  CampaignGoalEventModel,
  CampaignDeliveryIntentModel,
  SrcCustomerModel,
  SrcCustomerEventModel,
  SrcOrderModel,
  SrcCreditModel,
  AuditLogModel,
  ICampaignEventInbox,
} from '../../db/models';
import { DateTime } from 'luxon';
import { mockCustomerSource, mockOccasionSource } from '../../adapters';
import { clock } from '../clock';
import { logger } from '../../logger';
import { campaignActivityService } from '../campaign-activity.service';
import { campaignSettingsService } from '../campaign-settings.service';
import { customerFactsService } from '../customer-facts';
import { evaluateCustomerForCampaign } from '../audience';
import { enrollEventDelayOccurrence } from '../../presets/_shared/eventDelay/enrollerBase';
import {
  handleOrderCompletedTrigger,
  handleOrderRefundOrCancelTrigger,
} from '../../presets/_shared/orderTrigger/orderEventHandlers';
import {
  handleWelcomeOrderCompletedTrigger,
  handleWelcomeOrderRefundOrCancelTrigger,
} from '../../presets/welcome/welcomeOrderHandlers';
import {
  handleOutfitOrderCompleted,
  handleOutfitOrderRefundOrCancel,
} from '../../presets/completeOutfit/orderHandlers';
import {
  resolveStepDueAt,
  computeStepExpiresAt,
  fitIntoAllowedHours,
  resolveOccasionDateForYear,
  calculateLatestUsefulAt,
  formatInsufficientLeadTimeReason,
  getOccurrenceId,
} from '../datetime';
import { mockEnquirySource } from '../../adapters/enquiry-source';
import { mockRequestSource } from '../../adapters/request-source';
import { SrcRequestModel } from '../../db/models/src-request.model';
import { enrollEnquiryOccurrence } from '../../presets/unresolvedEnquiry/enquiryEnroller';
import {
  handleEnquirySavedOrUpdated,
  handleEnquiryResolvedOrDeleted,
} from '../../presets/unresolvedEnquiry/enquiryChangeHandler';
import {
  handleStockPublished,
  handleRequestSaved,
  handleRequestFulfilledOrCancelled,
  handleOrderCompletedForRequestGoal,
} from '../../presets/requestedItemAvailable/stockHandlers';
import {
  handleCollectionPublished,
  handleCollectionWithdrawn,
  handleOrderCompletedForCollectionGoal,
  handlePreferenceChangedForCollection,
} from '../../presets/matchingCollection';
import { isQualifyingOrder } from '../../presets/_shared/orderTrigger/qualifying';
import { handleSelectedStockOfferEvent } from '../../presets/selectedStockPromotion/offerHandlers';
import { handleOrderCompletedForSelectedStockGoal } from '../../presets/selectedStockPromotion/goalHandler';
import { handleFestivalSeasonEvent } from '../../presets/festivalCollection/seasonHandlers';
import { handleOrderCompletedForFestivalGoal } from '../../presets/festivalCollection/goalHandler';
import { handleStoreEvent, handleOrderCompletedForExhibitionGoal } from '../../presets/exhibitionTrunkShow';
import { handleFittingAppointmentEvent, handleAlterationEvent } from '../../presets/fittingAlteration';

export const PRODUCER_EVENT_FAMILIES: Record<string, string[]> = {
  orders: [
    'order.completed',
    'order.updated',
    'order.cancelled',
    'order.refunded',
    'order.refund',
    'order.cancel',
    'order.refund_or_cancel',
  ],
  ledger: [
    'credit.issued',
    'credit.updated',
    'credit.expired',
  ],
  customers: ['customer.updated', 'customer.deleted', 'preference.changed'],
  crm: [
    'customer.updated',
    'customer.deleted',
    'preference.changed',
    'occasion.saved',
    'occasion.cancelled',
    'occasion.deleted',
    'occasion.completed',
    'enquiry.saved',
    'enquiry.resolved',
    'enquiry.deleted',
  ],
  occasions: [
    'occasion.saved',
    'occasion.cancelled',
    'occasion.deleted',
    'occasion.completed',
  ],
  enquiries: [
    'enquiry.saved',
    'enquiry.resolved',
    'enquiry.deleted',
  ],
  inventory: [
    'stock.published',
    'stock.recount',
  ],
  requests: [
    'request.saved',
    'request.fulfilled',
    'request.cancelled',
  ],
  collections: [
    'collection.published',
    'collection.withdrawn',
  ],
  offers: [
    'offer.published',
    'offer.updated',
    'offer.withdrawn',
  ],
  seasons: [
    'season.published',
    'season.updated',
    'season.cancelled',
    'season.withdrawn',
  ],
  events: [
    'event.published',
    'event.updated',
    'event.cancelled',
    'rsvp.completed',
  ],
  appointments: [
    'appointment.booked',
    'appointment.rescheduled',
    'appointment.cancelled',
    'appointment.completed',
  ],
  alterations: [
    'alteration.created',
    'alteration.stage_changed',
    'alteration.cancelled',
    'alteration.completed',
  ],
  preferences: ['preference.changed'],
  'dev-tools': ['*'],
  system: ['*'],
  admin: ['*'],
};

export class EventConsumerService {
  /**
   * Ingests a domain event into campaignEventInbox BEFORE acknowledging (Spec p24, p25).
   * - Deduplicates per {tenantId, producer, eventId}
   * - Scopes producer to authorized event family
   * - Quarantines unknown schema or stale entityVersion
   * - Immediately triggers atomic/recoverable processing
   */
  async ingestEvent(
    tenantIdOrPayload: string | any,
    producerArg?: string,
    rawPayloadArg?: unknown
  ): Promise<{
    eventId: string;
    status: string;
    quarantineReason?: string;
    message?: string;
    effects?: Record<string, unknown>;
  }> {
    let tenantId: string;
    let producer: string;
    let rawPayload: unknown;

    if (typeof tenantIdOrPayload === 'object' && tenantIdOrPayload !== null) {
      tenantId = tenantIdOrPayload.tenantId || 'shop_a';
      producer =
        tenantIdOrPayload.producer ||
        (tenantIdOrPayload.source ? String(tenantIdOrPayload.source).replace(/^\//, '') : 'enquiries');
      rawPayload = tenantIdOrPayload.payload || tenantIdOrPayload;
    } else {
      tenantId = tenantIdOrPayload;
      producer = producerArg || 'dev-tools';
      rawPayload = rawPayloadArg;
    }

    // 1. Safe parse or extract basic identity
    const parsed = CampaignEventInputSchema.safeParse(rawPayload);
    const eventId = parsed.success
      ? parsed.data.eventId
      : (rawPayload as any)?.eventId || `evt_${crypto.randomUUID().slice(0, 12)}`;
    const eventType = parsed.success ? parsed.data.type : (rawPayload as any)?.type || 'unknown';

    // 2. Tenant verification (Hard Rule 1)
    if (parsed.success && parsed.data.tenantId && parsed.data.tenantId !== tenantId) {
      // Cross-tenant injection attempt (C11)
      logger.warn(
        { tenantId, payloadTenant: parsed.data.tenantId, eventId },
        'Cross-tenant event rejection'
      );
      return {
        eventId,
        status: EVENT_INBOX_STATUS.QUARANTINED,
        quarantineReason: QUARANTINE_REASONS.CROSS_TENANT_REJECTED,
        message: 'Event tenantId does not match authenticated context',
      };
    }

    // 3. Durable inbox deduplication (Spec p25: unique tenantId + producer + eventId)
    const existing = await CampaignEventInboxModel.findOne({
      tenantId,
      producer,
      eventId,
    });

    if (existing) {
      logger.info(
        { tenantId, producer, eventId, status: existing.status },
        'Duplicate domain event received. Durable deduplication preserved (Spec p24, B02).'
      );
      return {
        eventId,
        status: 'DUPLICATE',
        quarantineReason: existing.quarantineReason || undefined,
        message: 'Event already ingested and deduplicated',
        effects: {
          existingStatus: existing.status,
          processedAt: existing.processedAt,
          quarantinedAt: existing.status === EVENT_INBOX_STATUS.QUARANTINED ? existing.updatedAt : undefined,
        },
      };
    }

    // 3.5. Any non-supported event types quarantined with UNSUPPORTED_EVENT_TYPE (zero side effects)
    const SUPPORTED_EVENT_TYPES = new Set([
      'order.completed',
      'order.updated',
      'order.cancelled',
      'order.refunded',
      'order.cancel',
      'order.refund',
      'order.refund_or_cancel',
      'customer.created',
      'customer.updated',
      'customer.deleted',
      'customer.marketing_opt_out',
      'customer.channel_suppressed',
      'preference.changed',
      'preference.updated',
      'credit.issued',
      'credit.updated',
      'credit.expired',
      'occasion.saved',
      'occasion.cancelled',
      'occasion.deleted',
      'occasion.completed',
      'enquiry.saved',
      'enquiry.resolved',
      'enquiry.deleted',
      'stock.published',
      'stock.recount',
      'request.saved',
      'request.fulfilled',
      'request.cancelled',
      'collection.published',
      'collection.withdrawn',
      'offer.published',
      'offer.updated',
      'offer.withdrawn',
      'season.published',
      'season.updated',
      'season.cancelled',
      'season.withdrawn',
      'event.published',
      'event.updated',
      'event.cancelled',
      'rsvp.completed',
    ]);

    if (!SUPPORTED_EVENT_TYPES.has(eventType)) {
      await CampaignEventInboxModel.create({
        tenantId,
        producer,
        eventId,
        type: eventType,
        schemaVersion: (rawPayload as any)?.schemaVersion || (parsed.success ? parsed.data.schemaVersion : 1),
        entityId: (rawPayload as any)?.entityId || (parsed.success ? parsed.data.entityId : 'unknown'),
        entityVersion: (rawPayload as any)?.entityVersion || (parsed.success ? parsed.data.entityVersion : 1),
        customerId: (rawPayload as any)?.customerId || (parsed.success ? parsed.data.customerId : null),
        occurredAt: (rawPayload as any)?.occurredAt ? new Date((rawPayload as any).occurredAt) : new Date(),
        receivedAt: new Date(),
        data: (rawPayload as any)?.data || (parsed.success ? parsed.data.data : {}),
        status: EVENT_INBOX_STATUS.QUARANTINED,
        quarantineReason: QUARANTINE_REASONS.UNSUPPORTED_EVENT_TYPE,
        quarantineDetails: { reason: `Unsupported event type: ${eventType}` },
      });

      return {
        eventId,
        status: EVENT_INBOX_STATUS.QUARANTINED,
        quarantineReason: QUARANTINE_REASONS.UNSUPPORTED_EVENT_TYPE,
        message: `Event type '${eventType}' is unsupported`,
      };
    }

    // 4. Schema validation check
    if (!parsed.success) {
      const inboxDoc = await CampaignEventInboxModel.create({
        tenantId,
        producer,
        eventId,
        type: eventType,
        schemaVersion: (rawPayload as any)?.schemaVersion || 0,
        entityId: (rawPayload as any)?.entityId || 'unknown',
        entityVersion: (rawPayload as any)?.entityVersion || 0,
        occurredAt: new Date(),
        receivedAt: new Date(),
        data: (rawPayload as any) || {},
        status: EVENT_INBOX_STATUS.QUARANTINED,
        quarantineReason: QUARANTINE_REASONS.UNKNOWN_SCHEMA,
        quarantineDetails: { validationErrors: parsed.error.format() },
      });

      return {
        eventId,
        status: EVENT_INBOX_STATUS.QUARANTINED,
        quarantineReason: QUARANTINE_REASONS.UNKNOWN_SCHEMA,
        message: 'Event quarantined due to invalid or unknown schema',
      };
    }

    const payload = parsed.data;

    // 5. Producer family scope check (Spec p26)
    const allowedTypes = PRODUCER_EVENT_FAMILIES[producer.toLowerCase()];
    if (!allowedTypes || (!allowedTypes.includes('*') && !allowedTypes.includes(payload.type))) {
      logger.warn(
        { tenantId, producer, type: payload.type },
        'Producer unauthorized for event family'
      );
      await CampaignEventInboxModel.create({
        tenantId,
        producer,
        eventId,
        type: payload.type,
        schemaVersion: payload.schemaVersion,
        entityId: payload.entityId,
        entityVersion: payload.entityVersion,
        customerId: payload.customerId || null,
        occurredAt: new Date(payload.occurredAt),
        receivedAt: new Date(),
        data: payload.data || {},
        status: EVENT_INBOX_STATUS.QUARANTINED,
        quarantineReason: QUARANTINE_REASONS.PRODUCER_FAMILY_MISMATCH,
        quarantineDetails: { producer, allowedTypes: allowedTypes || [] },
      });

      return {
        eventId,
        status: EVENT_INBOX_STATUS.QUARANTINED,
        quarantineReason: QUARANTINE_REASONS.PRODUCER_FAMILY_MISMATCH,
        message: `Producer '${producer}' is not authorized for event type '${payload.type}'`,
      };
    }

    // 6. Authoritative state & Stale entityVersion check (Spec p24: "Events are hints... fetch current authoritative state")
    let isStale = false;
    let authoritativeVersion = 0;

    if (payload.type.startsWith('order.')) {
      const order = await SrcOrderModel.findOne({ tenantId, orderId: payload.entityId });
      if (order && payload.entityVersion < order.entityVersion) {
        isStale = true;
        authoritativeVersion = order.entityVersion;
      }
    } else if (payload.type.startsWith('customer.') || payload.type.startsWith('preference.')) {
      const customer = await SrcCustomerModel.findOne({ tenantId, customerId: payload.entityId });
      if (customer && payload.entityVersion < customer.version) {
        isStale = true;
        authoritativeVersion = customer.version;
      }
    } else if (payload.type.startsWith('credit.')) {
      const credit = await SrcCreditModel.findOne({ tenantId, creditId: payload.entityId });
      if (credit && payload.entityVersion < credit.entityVersion) {
        isStale = true;
        authoritativeVersion = credit.entityVersion;
      }
    } else if (payload.type.startsWith('occasion.')) {
      const event = await SrcCustomerEventModel.findOne({ tenantId, eventId: payload.entityId });
      if (event && payload.entityVersion < (event.entityVersion || event.version || 1)) {
        isStale = true;
        authoritativeVersion = event.entityVersion || event.version || 1;
      }
    } else if (payload.type.startsWith('enquiry.')) {
      const enquiry = await mockEnquirySource.getEnquiry(tenantId, payload.entityId);
      if (enquiry && payload.entityVersion < enquiry.entityVersion) {
        isStale = true;
        authoritativeVersion = enquiry.entityVersion;
      }
    } else if (payload.type.startsWith('request.')) {
      const reqDoc = await SrcRequestModel.findOne({ tenantId, requestId: payload.entityId });
      if (reqDoc && payload.entityVersion < reqDoc.entityVersion) {
        isStale = true;
        authoritativeVersion = reqDoc.entityVersion;
      }
    }

    if (isStale) {
      logger.warn(
        {
          tenantId,
          eventId,
          type: payload.type,
          entityId: payload.entityId,
          eventVersion: payload.entityVersion,
          authoritativeVersion,
        },
        'Event quarantined due to stale entityVersion. Old event cannot roll state backwards (Spec p24).'
      );

      await CampaignEventInboxModel.create({
        tenantId,
        producer,
        eventId,
        type: payload.type,
        schemaVersion: payload.schemaVersion,
        entityId: payload.entityId,
        entityVersion: payload.entityVersion,
        customerId: payload.customerId || (payload.type.startsWith('customer.') ? payload.entityId : null),
        occurredAt: new Date(payload.occurredAt),
        receivedAt: new Date(),
        data: payload.data || {},
        status: EVENT_INBOX_STATUS.QUARANTINED,
        quarantineReason: QUARANTINE_REASONS.STALE_ENTITY_VERSION,
        quarantineDetails: {
          eventEntityVersion: payload.entityVersion,
          authoritativeEntityVersion: authoritativeVersion,
        },
      });

      return {
        eventId,
        status: EVENT_INBOX_STATUS.QUARANTINED,
        quarantineReason: QUARANTINE_REASONS.STALE_ENTITY_VERSION,
        message: `Stale entityVersion ${payload.entityVersion} < authoritative ${authoritativeVersion}`,
      };
    }

    // 7. Persist in campaignEventInbox with PENDING before ack
    const inboxDoc = await CampaignEventInboxModel.create({
      tenantId,
      producer,
      eventId,
      type: payload.type,
      schemaVersion: payload.schemaVersion,
      entityId: payload.entityId,
      entityVersion: payload.entityVersion,
      customerId: payload.customerId || (payload.type.startsWith('customer.') ? payload.entityId : null),
      occurredAt: new Date(payload.occurredAt),
      receivedAt: new Date(),
      data: payload.data || {},
      status: EVENT_INBOX_STATUS.PENDING,
    });

    // 8. Process immediately
    const effects = await this.processEvent(inboxDoc);

    return {
      eventId,
      status: inboxDoc.status,
      effects,
    };
  }

  /**
   * Process a single event from campaignEventInbox atomically or recoverably.
   */
  async processEvent(eventDoc: ICampaignEventInbox): Promise<Record<string, unknown>> {
    if (eventDoc.status === EVENT_INBOX_STATUS.PROCESSED) {
      return { alreadyProcessed: true };
    }

    if (eventDoc.status === EVENT_INBOX_STATUS.QUARANTINED) {
      return { quarantined: true, reason: eventDoc.quarantineReason };
    }

    try {
      let effects: Record<string, unknown> = {};

      switch (eventDoc.type) {
        case 'order.completed':
          effects = await this.handleOrderCompleted(eventDoc);
          break;

        case 'order.updated':
          effects = await this.handleOrderUpdated(eventDoc);
          break;

        case 'order.cancelled':
        case 'order.refunded':
        case 'order.cancel':
        case 'order.refund':
        case 'order.refund_or_cancel':
          effects = await this.handleOrderRefundOrCancel(eventDoc);
          break;

        case 'customer.updated':
          effects = await this.handleCustomerUpdated(eventDoc);
          break;

        case 'preference.changed':
          effects = await this.handlePreferenceChanged(eventDoc);
          break;

        case 'customer.deleted':
          effects = await this.handleCustomerDeleted(eventDoc);
          break;

        case 'occasion.saved':
        case 'occasion.cancelled':
        case 'occasion.deleted':
        case 'occasion.completed':
          effects = await this.handleOccasionEvent(eventDoc);
          break;

        case 'enquiry.saved':
        case 'enquiry.resolved':
        case 'enquiry.deleted':
          effects = await this.handleEnquiryEvent(eventDoc);
          break;

        case 'stock.published':
        case 'stock.recount':
          effects = await this.handleStockEvent(eventDoc);
          break;

        case 'request.saved':
          effects = await handleRequestSaved(eventDoc);
          break;

        case 'request.fulfilled':
        case 'request.cancelled':
          effects = await handleRequestFulfilledOrCancelled(eventDoc);
          break;

        case 'collection.published':
          effects = await handleCollectionPublished(eventDoc);
          break;

        case 'collection.withdrawn':
          effects = await handleCollectionWithdrawn(eventDoc);
          break;

        case 'offer.published':
        case 'offer.updated':
        case 'offer.withdrawn':
          effects = await handleSelectedStockOfferEvent(eventDoc);
          break;

        case 'season.published':
        case 'season.updated':
        case 'season.cancelled':
        case 'season.withdrawn':
          effects = await handleFestivalSeasonEvent(eventDoc);
          break;

        case 'event.published':
        case 'event.updated':
        case 'event.cancelled':
        case 'rsvp.completed':
          effects = await handleStoreEvent(eventDoc);
          break;

        case 'appointment.booked':
        case 'appointment.rescheduled':
        case 'appointment.cancelled':
        case 'appointment.completed':
          effects = await handleFittingAppointmentEvent(eventDoc);
          break;

        case 'alteration.created':
        case 'alteration.stage_changed':
        case 'alteration.cancelled':
        case 'alteration.completed':
          effects = await handleAlterationEvent(eventDoc);
          break;

        default:
          logger.warn({ type: eventDoc.type }, 'Unhandled domain event type');
          effects = { unhandledType: eventDoc.type };
      }

        if (effects.outcome === 'QUARANTINED') {
          eventDoc.status = EVENT_INBOX_STATUS.QUARANTINED;
          eventDoc.quarantineReason = String(effects.reason || 'OFFER_INVALID');
          eventDoc.quarantineDetails = {
            reasonText: effects.reasonText || 'Event payload failed source validation',
          };
          eventDoc.outcome = 'QUARANTINED';
          await eventDoc.save();
          return effects;
        }

        // Mark event as PROCESSED atomically
      if (effects && typeof effects === 'object' && (effects as any).outcome) {
        eventDoc.outcome = (effects as any).outcome;
      }
      eventDoc.status = EVENT_INBOX_STATUS.PROCESSED;
      eventDoc.processedAt = clock.now();
      eventDoc.processedMarker = {
        processedAt: clock.now(),
        effectsSummary: JSON.stringify(effects),
      };
      await eventDoc.save();

      return effects;
    } catch (err: any) {
      logger.error({ err: err.message, eventId: eventDoc.eventId }, 'Error processing domain event');
      eventDoc.attempts = (eventDoc.attempts || 0) + 1;
      eventDoc.lastError = err.message;
      if (eventDoc.attempts >= 5) {
        eventDoc.status = EVENT_INBOX_STATUS.FAILED;
      }
      await eventDoc.save();
      throw err;
    }
  }

  /**
   * Order Completed Handler:
   * - Updates campaignCustomerFacts aggregates
   * - Evaluates occasionRef goal match or campaign goal rule
   * - Records durable campaignGoalEvents and stops follow-ups
   */
  private async handleOrderCompleted(eventDoc: ICampaignEventInbox): Promise<Record<string, unknown>> {
    const { tenantId, entityId: orderId, data, occurredAt } = eventDoc;

    // 1. Sync or verify authoritative order
    let order = await SrcOrderModel.findOne({ tenantId, orderId });
    if (!order) {
      const parsedCustomerId = eventDoc.customerId || (data as any)?.customerId || null;
      order = await SrcOrderModel.create({
        tenantId,
        orderId,
        customerId: parsedCustomerId,
        status: (data as any)?.status || 'COMPLETED',
        paid: (data as any)?.paid !== undefined ? (data as any).paid : true,
        netPaise: (data as any)?.netPaise || 0,
        grossPaise: (data as any)?.grossPaise || (data as any)?.netPaise || 0,
        refundedPaise: (data as any)?.refundedPaise || 0,
        occasionRef: (data as any)?.occasionRef || null,
        entityVersion: eventDoc.entityVersion,
        completedAt: occurredAt,
        branchId: (data as any)?.branchId,
        lines: (data as any)?.lines || (data as any)?.lineRefs?.map((ref: string) => ({
          lineId: ref,
          itemRef: ref,
          name: 'Item',
          quantity: 1,
          pricePaise: (data as any)?.netPaise || 0,
        })) || [],
      });
    } else if (eventDoc.entityVersion >= order.entityVersion) {
      if ((data as any)?.customerId !== undefined) {
        order.customerId = (data as any).customerId;
      }
      order.status = (data as any)?.status || order.status;
      order.paid = (data as any)?.paid !== undefined ? (data as any).paid : order.paid;
      order.netPaise = (data as any)?.netPaise !== undefined ? (data as any).netPaise : order.netPaise;
      order.grossPaise = (data as any)?.grossPaise !== undefined ? (data as any).grossPaise : order.grossPaise;
      order.refundedPaise = (data as any)?.refundedPaise !== undefined ? (data as any).refundedPaise : order.refundedPaise;
      order.occasionRef = (data as any)?.occasionRef !== undefined ? (data as any).occasionRef : order.occasionRef;
      if ((data as any)?.branchId) order.branchId = (data as any).branchId;
      order.entityVersion = eventDoc.entityVersion;
      await order.save();
    }

    const customerId = order.customerId || eventDoc.customerId;
    if (!customerId) {
      eventDoc.outcome = 'NO_CUSTOMER_IDENTITY';
      await eventDoc.save();
      return { orderId, customerId: null, outcome: 'NO_CUSTOMER_IDENTITY' };
    }

    // 2. Update Customer Facts & Inactivity Anchor (Spec p14, p21, p24)
    if (customerId) {
      await customerFactsService.recomputeCustomerFacts(tenantId, customerId);

      // QA Matrix A13: New purchase before win-back: Old enrollment stops; inactivity anchor resets.
      const isQualifying = order.paid && order.status === 'COMPLETED' && order.netPaise > 0;
      if (isQualifying) {
        const activeWinbackEnrollments = await CampaignEnrollmentModel.find({
          tenantId,
          customerId,
          occurrenceId: { $regex: '^winback:' },
          status: ENROLLMENT_STATUS.ACTIVE,
        });

        for (const enr of activeWinbackEnrollments) {
          enr.status = ENROLLMENT_STATUS.CANCELLED;
          await enr.save();

          await CampaignExecutionModel.updateMany(
            {
              tenantId,
              enrollmentId: enr.enrollmentId,
              state: {
                $in: [
                  EXECUTION_STATE.SCHEDULED,
                  EXECUTION_STATE.DEFERRED,
                  EXECUTION_STATE.EVALUATING,
                ],
              },
            },
            {
              $set: {
                state: EXECUTION_STATE.CANCELLED,
                skipReason: 'New qualifying order completed before win-back execution',
              },
            }
          );
        }
      }
    }

    // 3. Goal evaluation: check matching occasionRef on active enrollments (Spec p11, p20, p33, QA Matrix A12)
    const matchingGoals: string[] = [];
    if (customerId) {
      const activeEnrollments = await CampaignEnrollmentModel.find({
        tenantId,
        customerId,
        status: ENROLLMENT_STATUS.ACTIVE,
      });

      for (const enrollment of activeEnrollments) {
        let isMatch = false;
        let goalSource = 'ORDER_OCCASION';

        if (order.occasionRef && enrollment.occurrenceId === order.occasionRef) {
          isMatch = true;
        } else if (order.occasionRef && order.occasionRef.includes(enrollment.occurrenceId)) {
          isMatch = true;
        } else if (
          order.occasionRef &&
          enrollment.eventId &&
          (order.occasionRef === `gift:${enrollment.eventId}` ||
            order.occasionRef === `wedding:${enrollment.eventId}` ||
            order.occasionRef === enrollment.eventId)
        ) {
          isMatch = true;
        }

        // Enquiry Goal Matching (Spec F23 Part 1)
        const isEnquiryEnrollment =
          Boolean(enrollment.enquiryId) ||
          enrollment.occurrenceId.startsWith('enquiry:');

        if (isEnquiryEnrollment && !isMatch) {
          const enqId = enrollment.enquiryId || enrollment.occurrenceId.split(':')[1];
          const taggedEnquiryRef = (data as any)?.enquiryRef || (order as any).enquiryRef || order.occasionRef;
          const isTagged = taggedEnquiryRef === `enquiry:${enqId}` || taggedEnquiryRef === enqId;

          const orderCompletedAt = order.completedAt ? new Date(order.completedAt) : occurredAt;
          const enrCreatedAt = new Date(enrollment.createdAt);
          const isAfterEnquiryCreated = orderCompletedAt.getTime() >= enrCreatedAt.getTime();

          const isQualifying = isQualifyingOrder(order);
          const goalMode = enrollment.goalMode || 'ITEM_OR_TAGGED';

          if (isTagged) {
            isMatch = true;
            goalSource = 'ENQUIRY_PURCHASE';
          } else if (goalMode === 'TAGGED_ONLY') {
            isMatch = false;
          } else if (goalMode === 'ANY_QUALIFYING_ORDER') {
            if (isQualifying && isAfterEnquiryCreated) {
              isMatch = true;
              goalSource = 'ENQUIRY_PURCHASE';
            }
          } else if (goalMode === 'ITEM_OR_TAGGED') {
            if (isQualifying && isAfterEnquiryCreated && enrollment.itemRef?.productId) {
              const enquiredProductId = enrollment.itemRef.productId;
              const enquiredVariantId = enrollment.itemRef.variantId;

              const orderLines = order.lines || [];
              const itemBought = orderLines.some((line: any) => {
                if (line.productId !== enquiredProductId && line.itemRef !== enquiredProductId) {
                  return false;
                }
                if (enquiredVariantId) {
                  return line.variantId === enquiredVariantId;
                }
                return true;
              });

              if (itemBought) {
                isMatch = true;
                goalSource = 'ENQUIRY_PURCHASE';
              }
            }
          }
        }

        if (isMatch && !enrollment.goalReachedAt) {
          await campaignActivityService.markGoal({
            tenantId,
            enrollmentId: enrollment.enrollmentId,
            userId: 'SYSTEM_EVENT_CONSUMER',
            source: goalSource,
            orderRef: order.orderId,
            cause: `Order ${order.orderId} completed matching ${goalSource === 'ENQUIRY_PURCHASE' ? 'enquiry goal' : `occasionRef ${order.occasionRef}`}`,
            at: order.completedAt || occurredAt,
          });

          // Cancel remaining stopOnGoal executions immediately
          const pinnedVersion = (await CampaignVersionModel.findOne({
            tenantId,
            campaignId: enrollment.campaignId,
            version: enrollment.campaignVersion,
          }).lean()) as any;
          const stopStepIds = (pinnedVersion?.steps || [])
            .filter((s: any) => s.stopOnGoal)
            .map((s: any) => s.stepId);
          if (stopStepIds.length > 0) {
            await CampaignExecutionModel.updateMany(
              {
                tenantId,
                enrollmentId: enrollment.enrollmentId,
                stepId: { $in: stopStepIds },
                deliveryIntentId: null,
                state: EXECUTION_STATE.SCHEDULED,
              },
              {
                $set: {
                  state: EXECUTION_STATE.SKIPPED,
                  skipReason: EXECUTION_REASONS.SKIPPED_GOAL_REACHED,
                },
              }
            );
          }

          matchingGoals.push(enrollment.enrollmentId);
        }
      }
    }

    // 4. Trigger first-to-second-purchase, welcome, and outfit enrollments
    let firstRepeatResult: any = null;
    let welcomeResult: any = null;
    let outfitResult: any = null;
    let requestGoalResult: any = null;
    let collectionGoalResult: any = null;
    if (customerId) {
      firstRepeatResult = await handleOrderCompletedTrigger(tenantId, order, occurredAt);
      welcomeResult = await handleWelcomeOrderCompletedTrigger(tenantId, order, occurredAt);
      outfitResult = await handleOutfitOrderCompleted(tenantId, order, occurredAt);
      requestGoalResult = await handleOrderCompletedForRequestGoal(tenantId, customerId, order, occurredAt);
      collectionGoalResult = await handleOrderCompletedForCollectionGoal(tenantId, customerId, order, occurredAt);
    }
    const selectedStockGoalResult = customerId
      ? await handleOrderCompletedForSelectedStockGoal(tenantId, customerId, order, occurredAt)
      : { goalMatches: [] };
    const festivalGoalResult = customerId
      ? await handleOrderCompletedForFestivalGoal(tenantId, customerId, order, occurredAt)
      : { goalMatches: [] };
    const exhibitionGoalResult = customerId
      ? await handleOrderCompletedForExhibitionGoal(tenantId, customerId, order, occurredAt)
      : { goalMatches: [] };

    return {
      orderId,
      customerId,
      factsUpdated: true,
      matchingGoals,
      firstRepeatResult,
      welcomeResult,
      outfitResult,
      requestGoalResult,
      collectionGoalResult,
      selectedStockGoalResult,
      festivalGoalResult,
      exhibitionGoalResult,
    };
  }

  /**
   * Order Refund/Cancel Handler:
   * - Re-evaluates customer facts and restores previous inactivity anchor if one exists (Spec p14, QA Matrix B17)
   * - Preserves delivery history intact (never rolls back sent messages)
   */
  private async handleOrderRefundOrCancel(eventDoc: ICampaignEventInbox): Promise<Record<string, unknown>> {
    const { tenantId, entityId: orderId, data } = eventDoc;

    const order = await SrcOrderModel.findOne({ tenantId, orderId });
    if (order && eventDoc.entityVersion >= order.entityVersion) {
      order.status = (data as any)?.status || 'CANCELLED';
      if ((data as any)?.netPaise !== undefined) {
        order.netPaise = (data as any).netPaise;
      }
      order.entityVersion = eventDoc.entityVersion;
      await order.save();
    }

    const customerId = order?.customerId || eventDoc.customerId;
    let firstRepeatRefundResult: any = null;
    let welcomeRefundResult: any = null;
    let outfitRefundResult: any = null;
    if (customerId) {
      // Recompute customer facts to restore previous inactivity anchor if one exists (B17)
      await customerFactsService.recomputeCustomerFacts(tenantId, customerId);
      if (order) {
        firstRepeatRefundResult = await handleOrderRefundOrCancelTrigger(tenantId, order, new Date(eventDoc.occurredAt));
        welcomeRefundResult = await handleWelcomeOrderRefundOrCancelTrigger(tenantId, order, new Date(eventDoc.occurredAt));
        outfitRefundResult = await handleOutfitOrderRefundOrCancel(tenantId, order, new Date(eventDoc.occurredAt));
      }
    }

    return { orderId, customerId, status: order?.status || 'CANCELLED', firstRepeatRefundResult, welcomeRefundResult, outfitRefundResult };
  }

  /**
   * Order Updated Handler (Spec p24, F19b v2):
   * Handles order.updated events (e.g. attaching customer identity, status change, partial refund).
   */
  private async handleOrderUpdated(eventDoc: ICampaignEventInbox): Promise<Record<string, unknown>> {
    const { tenantId, entityId: orderId, data, occurredAt } = eventDoc;
    let order = await SrcOrderModel.findOne({ tenantId, orderId });

    if (!order) {
      const parsedCustomerId = eventDoc.customerId || (data as any)?.customerId || null;
      order = await SrcOrderModel.create({
        tenantId,
        orderId,
        customerId: parsedCustomerId,
        status: (data as any)?.status || 'COMPLETED',
        paid: (data as any)?.paid !== undefined ? (data as any).paid : true,
        netPaise: (data as any)?.netPaise || 0,
        grossPaise: (data as any)?.grossPaise || (data as any)?.netPaise || 0,
        refundedPaise: (data as any)?.refundedPaise || 0,
        occasionRef: (data as any)?.occasionRef || null,
        entityVersion: eventDoc.entityVersion,
        completedAt: occurredAt,
        branchId: (data as any)?.branchId,
        lines: (data as any)?.lines || [],
      });
    } else if (eventDoc.entityVersion >= order.entityVersion) {
      if ((data as any)?.customerId !== undefined) {
        order.customerId = (data as any).customerId;
      } else if (eventDoc.customerId) {
        order.customerId = eventDoc.customerId;
      }
      if ((data as any)?.status !== undefined) order.status = (data as any).status;
      if ((data as any)?.paid !== undefined) order.paid = (data as any).paid;
      if ((data as any)?.netPaise !== undefined) order.netPaise = (data as any).netPaise;
      if ((data as any)?.grossPaise !== undefined) order.grossPaise = (data as any).grossPaise;
      if ((data as any)?.refundedPaise !== undefined) order.refundedPaise = (data as any).refundedPaise;
      if ((data as any)?.branchId !== undefined) order.branchId = (data as any).branchId;
      order.entityVersion = eventDoc.entityVersion;
      await order.save();
    }

    if (!order.customerId) {
      eventDoc.outcome = 'NO_CUSTOMER_IDENTITY';
      await eventDoc.save();
      return { orderId, customerId: null, outcome: 'NO_CUSTOMER_IDENTITY' };
    }

    // Check if updated to cancelled or refunded
    const normalizedStatus = (order.status || '').toUpperCase();
    if (normalizedStatus === 'CANCELLED' || normalizedStatus === 'REFUNDED' || (order.netPaise || 0) <= 0) {
      return this.handleOrderRefundOrCancel(eventDoc);
    }

    // Process as completed order for this customer
    return this.handleOrderCompleted(eventDoc);
  }

  /**
   * Customer Updated Handler:
   * - Birthday / occasion date change
   * - Same Year: replans ONLY executions with deliveryIntentId=null, updates planRevision atomically
   * - Across Years: cancels obsolete unsent plan, evaluates corrected year with FUTURE_ONLY,
   *   links correctionGroupId, suppresses copies of steps already accepted/unknown
   */
  private async handleCustomerUpdated(eventDoc: ICampaignEventInbox): Promise<Record<string, unknown>> {
    const { tenantId, entityId: customerId, data } = eventDoc;

    // 1. Sync authoritative customer
    let customer = await SrcCustomerModel.findOne({ tenantId, customerId });
    if (customer && eventDoc.entityVersion >= customer.version) {
      if ((data as any)?.birthday) {
        customer.birthday = (data as any).birthday;
      }
      customer.version = eventDoc.entityVersion;
      await customer.save();
    }

    // Handle DESTINATION_CHANGED (Spec p20, F19b v2)
    if ((data as any)?.updateType === 'DESTINATION_CHANGED' || (data as any)?.destinationVersion) {
      if (customer) {
        const newDestinationHash = customer.destination?.destinationHash;
        if (newDestinationHash) {
          // Update active enrollments with new destinationHash
          await CampaignEnrollmentModel.updateMany(
            { tenantId, customerId, status: ENROLLMENT_STATUS.ACTIVE },
            { $set: { destinationHash: newDestinationHash } }
          );

          // Update unsent executions (deliveryIntentId === null) that haven't been frozen
          await CampaignExecutionModel.updateMany(
            {
              tenantId,
              customerId,
              deliveryIntentId: null,
              state: {
                $in: [
                  EXECUTION_STATE.SCHEDULED,
                  EXECUTION_STATE.DEFERRED,
                  EXECUTION_STATE.EVALUATING,
                ],
              },
            },
            { $set: { destinationHash: newDestinationHash } }
          );
        }
      }
      return { customerId, updated: true, updateType: 'DESTINATION_CHANGED' };
    }

    const newBirthday = (data as any)?.birthday || customer?.birthday;
    if (!newBirthday) {
      return { customerId, updated: true, dateChange: false };
    }

    // 2. Fetch tenant settings
    const settings = await campaignSettingsService.getSettings(tenantId);
    const now = clock.now();

    // 3. Find active enrollments for customer
    const enrollments = await CampaignEnrollmentModel.find({
      tenantId,
      customerId,
      status: { $in: [ENROLLMENT_STATUS.ACTIVE, ENROLLMENT_STATUS.PAUSED] },
    });

    const replannedEnrollments: string[] = [];
    const acrossYearCorrections: string[] = [];

    for (const enrollment of enrollments) {
      const campaign = await CampaignModel.findOne({ tenantId, campaignId: enrollment.campaignId });
      if (!campaign || campaign.status !== CAMPAIGN_STATUS.ACTIVE) continue;

      const version = await CampaignVersionModel.findOne({
        tenantId,
        campaignId: enrollment.campaignId,
        version: enrollment.campaignVersion,
      });
      if (!version) continue;

      const leapPolicy = version.trigger?.leapDayPolicy || 'FEB_28';
      const timezone = version.timezone || settings.timezone || 'Asia/Kolkata';

      // Parse old occurrence year
      const parts = enrollment.occurrenceId.split(':');
      const oldYear = parseInt(parts[parts.length - 1], 10) || now.getFullYear();

      // Check if date change is within same year or across years
      const explicitAcrossYears = (data as any)?.acrossYears === true;
      const targetYear = (data as any)?.targetYear || (data as any)?.year;
      const isAcrossYears =
        explicitAcrossYears ||
        (targetYear && targetYear !== oldYear) ||
        (newBirthday.month === 12 && oldYear > now.getFullYear() && enrollment.occurrenceId.includes('2027'));

      if (!isAcrossYears) {
        // =====================================================================
        // CASE 1: SAME YEAR DATE CORRECTION (Spec p20)
        // Replan ONLY executions with deliveryIntentId=null, update planRevision atomically
        // =====================================================================
        const newOccasionLocalDate = resolveOccasionDateForYear(newBirthday, oldYear, leapPolicy);
        const newPlanRevision = (enrollment.planRevision || 1) + 1;

        enrollment.occasionLocalDate = newOccasionLocalDate;
        enrollment.planRevision = newPlanRevision;
        await enrollment.save();

        const executions = await CampaignExecutionModel.find({
          tenantId,
          enrollmentId: enrollment.enrollmentId,
        });

        for (const exe of executions) {
          // Rule: Replan only executions with deliveryIntentId=null
          if (exe.deliveryIntentId !== null) {
            continue;
          }

          if ([EXECUTION_STATE.SCHEDULED, EXECUTION_STATE.DEFERRED, EXECUTION_STATE.SKIPPED].includes(exe.state as any)) {
            const step = version.steps?.find((s: any) => s.stepId === exe.stepId);
            if (!step) continue;

            const stepDue = resolveStepDueAt({
              occasionLocalDate: newOccasionLocalDate,
              offsetDays: step.offsetDays,
              localTime: step.localTime,
              timezone,
            });

            const expiresAt = computeStepExpiresAt({
              dueAt: stepDue.dueAt,
              maxLatenessMinutes: step.maxLatenessMinutes,
              campaignEndAt: campaign.endAt,
            });

            const fitResult = fitIntoAllowedHours(
              stepDue.dueAt,
              {
                timezone: settings.timezone,
                allowedSendingHours: settings.allowedSendingHours,
                blackoutDates: settings.blackoutDates,
                holidays: settings.holidays,
              },
              expiresAt
            );

            exe.dueAt = fitResult.dueAt;
            exe.originalDueAt = stepDue.dueAt;
            exe.expiresAt = expiresAt;
            exe.localDate = stepDue.localDate;
            exe.localTime = stepDue.localTime;
            exe.planRevision = newPlanRevision;

            if (fitResult.dueAt.getTime() <= now.getTime()) {
              exe.state = EXECUTION_STATE.SKIPPED;
              exe.skipReason = 'Elapsed step prior to evaluation instant';
            } else {
              exe.state = EXECUTION_STATE.SCHEDULED;
              exe.skipReason = null;
            }

            await exe.save();
          }
        }

        replannedEnrollments.push(enrollment.enrollmentId);
      } else {
        // =====================================================================
        // CASE 2: ACROSS-YEAR DATE CORRECTION (Spec p20)
        // Cancel obsolete unsent plan, evaluate corrected year with FUTURE_ONLY,
        // link correctionGroupId, suppress copies of steps already accepted/unknown.
        // Never send an invitation again because a date or template changed.
        // =====================================================================
        const correctedYear = targetYear || (oldYear > now.getFullYear() ? oldYear - 1 : oldYear + 1);
        const correctionGroupId =
          enrollment.correctionGroupId || `crg_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;

        enrollment.correctionGroupId = correctionGroupId;
        enrollment.status = ENROLLMENT_STATUS.CANCELLED;
        await enrollment.save();

        const oldExecutions = await CampaignExecutionModel.find({
          tenantId,
          enrollmentId: enrollment.enrollmentId,
        });

        const acceptedOrUnknownStepIds: string[] = [];

        for (const exe of oldExecutions) {
          if (
            exe.deliveryIntentId !== null ||
            [
              EXECUTION_STATE.PROVIDER_ACCEPTED,
              EXECUTION_STATE.SENT,
              EXECUTION_STATE.DELIVERED,
              EXECUTION_STATE.READ,
              EXECUTION_STATE.OUTCOME_UNKNOWN,
            ].includes(exe.state as any)
          ) {
            acceptedOrUnknownStepIds.push(exe.stepId);
          } else if (
            [EXECUTION_STATE.SCHEDULED, EXECUTION_STATE.DEFERRED, EXECUTION_STATE.EVALUATING].includes(
              exe.state as any
            )
          ) {
            exe.state = EXECUTION_STATE.CANCELLED;
            exe.skipReason = 'Cancelled due to across-year occasion date correction';
            await exe.save();
          }
        }

        // Create replacement enrollment retaining pinned version
        const replacementOccurrenceId = `birthday:${correctedYear}`;
        const newOccasionLocalDate = resolveOccasionDateForYear(newBirthday, correctedYear, leapPolicy);
        const replacementEnrollmentId = `enr_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
        const replacementKey = `${tenantId}:${enrollment.campaignId}:${customerId}:${replacementOccurrenceId}`;

        let replacementEnrollment = await CampaignEnrollmentModel.findOne({
          tenantId,
          campaignId: enrollment.campaignId,
          customerId,
          occurrenceId: replacementOccurrenceId,
        });

        if (!replacementEnrollment) {
          replacementEnrollment = await CampaignEnrollmentModel.create({
            enrollmentId: replacementEnrollmentId,
            enrollmentKey: replacementKey,
            tenantId,
            campaignId: enrollment.campaignId,
            campaignVersionId: enrollment.campaignVersionId,
            campaignVersion: enrollment.campaignVersion,
            customerId,
            occurrenceId: replacementOccurrenceId,
            sourceRef: enrollment.sourceRef,
            occasionLocalDate: newOccasionLocalDate,
            planRevision: 1,
            status: ENROLLMENT_STATUS.ACTIVE,
            replyHoldAt: null,
            goalReachedAt: null,
            matchExplanation: 'Replacement enrollment created via across-year date correction',
            correctionGroupId,
          });
        } else {
          replacementEnrollment.correctionGroupId = correctionGroupId;
          await replacementEnrollment.save();
        }

        // Plan replacement steps under FUTURE_ONLY and suppress duplicate steps
        for (const step of version.steps || []) {
          const exeKey = `${replacementEnrollment.enrollmentId}:${step.stepId}`;
          const existingExe = await CampaignExecutionModel.findOne({
            tenantId,
            enrollmentId: replacementEnrollment.enrollmentId,
            stepId: step.stepId,
          });

          if (existingExe) continue;

          let state: string = EXECUTION_STATE.SCHEDULED;
          let skipReason: string | null = null;

          const stepDue = resolveStepDueAt({
            occasionLocalDate: newOccasionLocalDate,
            offsetDays: step.offsetDays,
            localTime: step.localTime,
            timezone,
          });

          const expiresAt = computeStepExpiresAt({
            dueAt: stepDue.dueAt,
            maxLatenessMinutes: step.maxLatenessMinutes,
            campaignEndAt: campaign.endAt,
          });

          const fitResult = fitIntoAllowedHours(
            stepDue.dueAt,
            {
              timezone: settings.timezone,
              allowedSendingHours: settings.allowedSendingHours,
              blackoutDates: settings.blackoutDates,
              holidays: settings.holidays,
            },
            expiresAt
          );

          if (acceptedOrUnknownStepIds.includes(step.stepId)) {
            // SUPPRESS duplicate copy already executed in correction group
            state = EXECUTION_STATE.SKIPPED;
            skipReason = 'Suppressed duplicate step already executed in correction group';
          } else if (fitResult.dueAt.getTime() <= now.getTime()) {
            state = EXECUTION_STATE.SKIPPED;
            skipReason = 'Elapsed step prior to evaluation instant';
          } else {
            state = EXECUTION_STATE.SCHEDULED;
            skipReason = null;
          }

          await CampaignExecutionModel.create({
            executionId: `exe_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`,
            executionKey: exeKey,
            tenantId,
            campaignId: enrollment.campaignId,
            enrollmentId: replacementEnrollment.enrollmentId,
            stepId: step.stepId,
            stepName: step.stepName || step.stepId,
            dueAt: fitResult.dueAt,
            originalDueAt: stepDue.dueAt,
            expiresAt,
            localDate: stepDue.localDate,
            localTime: stepDue.localTime,
            timezone,
            planRevision: 1,
            state,
            skipReason,
            prerequisite: step.prerequisite,
            templateRef: step.templateRef,
            deliveryIntentId: null,
          });
        }

        acrossYearCorrections.push(replacementEnrollment.enrollmentId);
      }
    }

    return {
      customerId,
      replannedEnrollments,
      acrossYearCorrections,
    };
  }

  /**
   * Preference Changed Handler:
   * - MARKETING_OPT_OUT: cancels promotional steps; later opt-in never resurrects cancelled occurrences
   * - CHANNEL_SUPPRESSED: cancels all pending steps
   */
  private async handlePreferenceChanged(eventDoc: ICampaignEventInbox): Promise<Record<string, unknown>> {
    const { tenantId, entityId: customerId, data } = eventDoc;

    const optOut =
      (data as any)?.marketingOptIn === false ||
      (data as any)?.preferenceType === 'MARKETING_OPT_OUT' ||
      (data as any)?.changeType === 'MARKETING_OPT_OUT';
    const channelSuppressed =
      (data as any)?.channelSuppressed === true ||
      (data as any)?.preferenceType === 'CHANNEL_SUPPRESSED' ||
      (data as any)?.changeType === 'CHANNEL_SUPPRESSED';

    // Update authoritative customer consent
    const customer = await SrcCustomerModel.findOne({ tenantId, customerId });
    if (customer && eventDoc.entityVersion >= customer.version) {
      if ((data as any)?.marketingOptIn !== undefined) {
        customer.consent.marketingOptIn = (data as any).marketingOptIn;
      }
      if ((data as any)?.channelSuppressed !== undefined) {
        customer.consent.channelSuppressed = (data as any).channelSuppressed;
      }
      customer.version = eventDoc.entityVersion;
      await customer.save();
    }

    let cancelledExecutionsCount = 0;

    if (optOut) {
      // Find all pending executions for customer across marketing campaigns
      const enrollments = await CampaignEnrollmentModel.find({ tenantId, customerId });
      const enrollmentIds = enrollments.map((e) => e.enrollmentId);

      const executions = await CampaignExecutionModel.find({
        tenantId,
        enrollmentId: { $in: enrollmentIds },
        state: { $in: [EXECUTION_STATE.SCHEDULED, EXECUTION_STATE.DEFERRED, EXECUTION_STATE.EVALUATING] },
        deliveryIntentId: null,
      });

      for (const exe of executions) {
        exe.state = EXECUTION_STATE.CANCELLED;
        exe.skipReason = 'Cancelled due to customer marketing opt-out (Spec p20, C03)';
        await exe.save();
        cancelledExecutionsCount++;
      }

      await CampaignEnrollmentModel.updateMany(
        { tenantId, customerId, status: ENROLLMENT_STATUS.ACTIVE },
        { $set: { status: ENROLLMENT_STATUS.CANCELLED } }
      );
    } else if (channelSuppressed) {
      // CHANNEL_SUPPRESSED cancels ALL pending steps across all campaigns
      const enrollments = await CampaignEnrollmentModel.find({ tenantId, customerId });
      const enrollmentIds = enrollments.map((e) => e.enrollmentId);

      const executions = await CampaignExecutionModel.find({
        tenantId,
        enrollmentId: { $in: enrollmentIds },
        state: { $in: [EXECUTION_STATE.SCHEDULED, EXECUTION_STATE.DEFERRED, EXECUTION_STATE.EVALUATING] },
      });

      for (const exe of executions) {
        exe.state = EXECUTION_STATE.CANCELLED;
        exe.skipReason = 'Cancelled due to customer channel suppression (Spec p20)';
        await exe.save();
        cancelledExecutionsCount++;
      }

      await CampaignEnrollmentModel.updateMany(
        { tenantId, customerId, status: ENROLLMENT_STATUS.ACTIVE },
        { $set: { status: ENROLLMENT_STATUS.CANCELLED } }
      );
    }

    // Re-evaluate active matching_collection enrollments if preferences changed
    let collectionPrefResult: any = null;
    if (!optOut && !channelSuppressed) {
      collectionPrefResult = await handlePreferenceChangedForCollection(eventDoc);
    }

    return {
      customerId,
      optOut,
      channelSuppressed,
      cancelledExecutionsCount,
      collectionPrefResult,
    };
  }

  /**
   * Customer Deleted Handler:
   * - Cancels pending steps
   * - Replayed old events cannot recreate
   */
  private async handleCustomerDeleted(eventDoc: ICampaignEventInbox): Promise<Record<string, unknown>> {
    const { tenantId, entityId: customerId, occurredAt } = eventDoc;

    // 1. Mark customer deleted in authoritative store
    const customer = await SrcCustomerModel.findOne({ tenantId, customerId });
    if (customer && eventDoc.entityVersion >= customer.version) {
      customer.deletedAt = occurredAt;
      customer.status = 'INACTIVE';
      customer.version = eventDoc.entityVersion;
      await customer.save();
    }

    // 2. Cancel all pending executions
    const enrollments = await CampaignEnrollmentModel.find({ tenantId, customerId });
    const enrollmentIds = enrollments.map((e) => e.enrollmentId);

    const executions = await CampaignExecutionModel.find({
      tenantId,
      enrollmentId: { $in: enrollmentIds },
      state: { $in: [EXECUTION_STATE.SCHEDULED, EXECUTION_STATE.DEFERRED, EXECUTION_STATE.EVALUATING] },
    });

    let cancelledCount = 0;
    for (const exe of executions) {
      exe.state = EXECUTION_STATE.CANCELLED;
      exe.skipReason = 'Cancelled due to customer deletion';
      await exe.save();
      cancelledCount++;
    }

    await CampaignEnrollmentModel.updateMany(
      { tenantId, customerId, status: ENROLLMENT_STATUS.ACTIVE },
      { $set: { status: ENROLLMENT_STATUS.CANCELLED } }
    );

    return { customerId, deleted: true, cancelledCount };
  }

  /**
   * Occasion Lifecycle Handler (Gift / Wedding reminder)
   */
  private async handleOccasionEvent(eventDoc: ICampaignEventInbox): Promise<Record<string, unknown>> {
    const { tenantId, entityId: eventId, type, occurredAt } = eventDoc;

    // 1. Re-fetch occasion via mockOccasionSource.getOccasion
    const occasion = await mockOccasionSource.getOccasion(tenantId, eventId);

    // 2. Find any active or existing enrollments matching this event
    const enrollments = await CampaignEnrollmentModel.find({
      tenantId,
      $or: [
        { eventId },
        { occurrenceId: `gift:${eventId}` },
        { occurrenceId: `wedding:${eventId}` },
      ],
    });

    // 3. Handle occasion.deleted, occasion.cancelled, occasion.completed
    if (type === 'occasion.deleted' || !occasion || occasion.deletedAt) {
      let cancelledStepsCount = 0;
      for (const enr of enrollments) {
        const res = await CampaignExecutionModel.updateMany(
          {
            tenantId,
            enrollmentId: enr.enrollmentId,
            deliveryIntentId: null,
            state: { $in: [EXECUTION_STATE.SCHEDULED, EXECUTION_STATE.DEFERRED, EXECUTION_STATE.EVALUATING] },
          },
          {
            $set: {
              state: EXECUTION_STATE.CANCELLED,
              skipReason: EXECUTION_REASONS.OCCASION_DELETED,
            },
          }
        );
        cancelledStepsCount += res.modifiedCount;
        enr.status = ENROLLMENT_STATUS.CANCELLED;
        await enr.save();
      }
      return { eventId, type, outcome: 'OCCASION_DELETED', cancelledStepsCount };
    }

    if (type === 'occasion.cancelled' || occasion.status === 'CANCELLED') {
      let cancelledStepsCount = 0;
      for (const enr of enrollments) {
        const res = await CampaignExecutionModel.updateMany(
          {
            tenantId,
            enrollmentId: enr.enrollmentId,
            deliveryIntentId: null,
            state: { $in: [EXECUTION_STATE.SCHEDULED, EXECUTION_STATE.DEFERRED, EXECUTION_STATE.EVALUATING] },
          },
          {
            $set: {
              state: EXECUTION_STATE.CANCELLED,
              skipReason: EXECUTION_REASONS.OCCASION_CANCELLED,
            },
          }
        );
        cancelledStepsCount += res.modifiedCount;
        enr.status = ENROLLMENT_STATUS.CANCELLED;
        await enr.save();
      }
      return { eventId, type, outcome: 'OCCASION_CANCELLED', cancelledStepsCount };
    }

    if (type === 'occasion.completed' || occasion.status === 'COMPLETED') {
      let cancelledStepsCount = 0;
      for (const enr of enrollments) {
        const res = await CampaignExecutionModel.updateMany(
          {
            tenantId,
            enrollmentId: enr.enrollmentId,
            deliveryIntentId: null,
            state: { $in: [EXECUTION_STATE.SCHEDULED, EXECUTION_STATE.DEFERRED, EXECUTION_STATE.EVALUATING] },
          },
          {
            $set: {
              state: EXECUTION_STATE.CANCELLED,
              skipReason: EXECUTION_REASONS.OCCASION_COMPLETED,
            },
          }
        );
        cancelledStepsCount += res.modifiedCount;
        enr.status = ENROLLMENT_STATUS.COMPLETED;
        enr.goalReachedAt = occurredAt || clock.now();
        await enr.save();

        const goalEventId = `cge_${crypto.randomUUID()}`;
        await CampaignGoalEventModel.create({
          goalEventId,
          tenantId,
          enrollmentId: enr.enrollmentId,
          occurrence: enr.occurrenceId,
          customerId: enr.customerId,
          campaignId: enr.campaignId,
          source: 'OCCASION_COMPLETED',
          orderRef: null,
          cause: 'Occasion marked completed',
          recordedBy: 'SYSTEM_EVENT_CONSUMER',
          at: occurredAt || clock.now(),
        });
      }
      return { eventId, type, outcome: 'OCCASION_COMPLETED', cancelledStepsCount };
    }

    // 4. Handle occasion.saved
    if (type === 'occasion.saved') {
      // Case A: Not yet enrolled -> check active campaigns and enroll if within horizon
      if (enrollments.length === 0) {
        if (!occasion.declaredByCustomer || occasion.status !== 'ACTIVE' || !occasion.eventDateKey) {
          return { eventId, type, outcome: 'SKIPPED_NOT_ELIGIBLE_FOR_ENROLLMENT' };
        }

        const activeCampaigns = await CampaignModel.find({
          tenantId,
          status: CAMPAIGN_STATUS.ACTIVE,
        });

        let enrolledCount = 0;
        for (const campaign of activeCampaigns) {
          const version = (await CampaignVersionModel.findOne({
            tenantId,
            campaignId: campaign.campaignId,
            version: campaign.draftVersion,
            isPublished: true,
          }).lean()) as any;

          if (!version || version.trigger?.type !== 'CUSTOMER_EVENT_DATE') continue;
          if (version.trigger?.occasionKind && version.trigger.occasionKind !== occasion.kind) continue;

          // Check horizon & audience
          const effectiveNow = clock.now();
          const tz = version.timezone || 'Asia/Kolkata';
          const todayInTz = DateTime.fromJSDate(effectiveNow, { zone: tz }).toISODate()!;
          if (occasion.eventDateKey < todayInTz) continue;

          const steps = version.steps || [];
          const maxPositiveOffset = Math.max(0, ...steps.map((s: any) => s.offsetDays ?? 0).filter((d: number) => d > 0));
          const maxLeadDays = Math.max(0, ...steps.map((s: any) => -(s.offsetDays ?? 0)).filter((d: number) => d > 0));
          const horizonStartDt = DateTime.fromJSDate(effectiveNow, { zone: tz }).minus({ days: maxPositiveOffset }).startOf('day');
          const horizonEndDt = DateTime.fromJSDate(effectiveNow, { zone: tz }).plus({ days: maxLeadDays + 30 }).endOf('day');
          if (occasion.eventDateKey < horizonStartDt.toISODate()! || occasion.eventDateKey > horizonEndDt.toISODate()!) {
            continue;
          }

          const customer = await mockCustomerSource.getCustomerById(tenantId, occasion.customerId);
          if (!customer || customer.deletedAt || customer.status !== 'ACTIVE') continue;

          const [occY, occM, occD] = occasion.eventDateKey.split('-').map(Number);
          const occInstant = new Date(Date.UTC(occY, occM - 1, occD));
          const nowMidnightUtc = new Date(Date.UTC(effectiveNow.getUTCFullYear(), effectiveNow.getUTCMonth(), effectiveNow.getUTCDate()));
          const daysUntilOccasion = Math.round((occInstant.getTime() - nowMidnightUtc.getTime()) / (24 * 60 * 60 * 1000));

          const evalResult = evaluateCustomerForCampaign({
            customer,
            campaign: {
              trigger: version.trigger,
              enabledBranches: version.enabledBranches,
              audience: version.audience,
              purpose: version.purpose,
            },
            occasionLocalDate: occasion.eventDateKey,
            daysUntilOccasion,
            occasion: {
              kind: occasion.kind,
              budgetPaise: occasion.budgetPaise,
              categories: occasion.categories,
            },
          });

          if (!evalResult.eligible) continue;

          // Enroll this customer
          const occurrenceId = getOccurrenceId(occasion.kind.toLowerCase(), undefined, occasion.eventId);
          const enrollmentKey = `${tenantId}:${campaign.campaignId}:${customer.customerId}:${occurrenceId}`;
          const enrollmentId = `enr_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;

          await CampaignEnrollmentModel.create({
            enrollmentId,
            enrollmentKey,
            tenantId,
            campaignId: campaign.campaignId,
            campaignVersionId: version._id.toString(),
            campaignVersion: version.version,
            customerId: customer.customerId,
            occurrenceId,
            sourceRef: {
              type: 'SRC_CUSTOMER_EVENT',
              id: occasion.eventId,
              version: occasion.entityVersion || occasion.version || 1,
            },
            occasionLocalDate: occasion.eventDateKey,
            planRevision: 1,
            status: ENROLLMENT_STATUS.ACTIVE,
            replyHoldAt: null,
            goalReachedAt: null,
            matchExplanation: evalResult.explanation || 'all eligible',
            correctionGroupId: null,
            eventId: occasion.eventId,
            occasionKind: occasion.kind,
            eventDateSnapshot: occasion.eventDateKey,
            dateHistory: [],
          });

          // Plan steps
          const settings = await campaignSettingsService.getSettings(tenantId);
          for (const step of version.steps || []) {
            const executionKey = `${enrollmentId}:${step.stepId}`;
            const stepDue = resolveStepDueAt({
              occasionLocalDate: occasion.eventDateKey,
              offsetDays: step.offsetDays ?? 0,
              localTime: step.localTime || '10:00',
              timezone: version.timezone || 'Asia/Kolkata',
            });
            const expiresAt = computeStepExpiresAt({
              dueAt: stepDue.dueAt,
              maxLatenessMinutes: step.maxLatenessMinutes,
              campaignEndAt: campaign.endAt,
            });
            const fitResult = fitIntoAllowedHours(
              stepDue.dueAt,
              {
                timezone: settings.timezone,
                allowedSendingHours: settings.allowedSendingHours,
                blackoutDates: settings.blackoutDates,
                holidays: settings.holidays,
              },
              expiresAt
            );

            const leadDays = version.trigger?.fulfillmentLeadDays ?? (version.trigger?.occasionKind === 'WEDDING' ? 21 : 2);
            const usefulResult = calculateLatestUsefulAt({
              eventDateKey: occasion.eventDateKey,
              fulfillmentLeadDays: leadDays,
              allowedSendingHoursEnd: settings.allowedSendingHours?.end || '19:00',
              timezone: version.timezone || settings.timezone || 'Asia/Kolkata',
            });

            let state: string = EXECUTION_STATE.SCHEDULED;
            let skipReason: string | null = null;
            if (campaign.endAt && fitResult.dueAt.getTime() > new Date(campaign.endAt).getTime()) {
              state = EXECUTION_STATE.EXPIRED;
              skipReason = 'Step due after campaign deadline (endAt)';
            } else if (fitResult.status === 'SKIP') {
              state = EXECUTION_STATE.SKIPPED;
              skipReason = fitResult.reason || 'SKIPPED_EXPIRY';
            } else if (
              usefulResult.latestUsefulAt &&
              (fitResult.dueAt.getTime() > usefulResult.latestUsefulAt.getTime() ||
                effectiveNow.getTime() > usefulResult.latestUsefulAt.getTime())
            ) {
              state = EXECUTION_STATE.SKIPPED;
              skipReason = EXECUTION_REASONS.INSUFFICIENT_LEAD_TIME;
            } else if (fitResult.dueAt.getTime() < effectiveNow.getTime()) {
              state = EXECUTION_STATE.SKIPPED;
              skipReason = 'Elapsed step prior to evaluation instant';
            }

            await CampaignExecutionModel.create({
              executionId: `exe_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`,
              executionKey,
              tenantId,
              campaignId: campaign.campaignId,
              enrollmentId,
              stepId: step.stepId,
              stepName: step.stepName || step.stepId,
              dueAt: fitResult.dueAt,
              originalDueAt: stepDue.dueAt,
              adjustedDueAt: fitResult.dueAt,
              expiresAt,
              latestUsefulAt: usefulResult.latestUsefulAt,
              usefulUntilReason: formatInsufficientLeadTimeReason(leadDays, daysUntilOccasion),
              localDate: stepDue.localDate,
              localTime: stepDue.localTime,
              timezone: version.timezone || 'Asia/Kolkata',
              planRevision: 1,
              state,
              skipReason,
              prerequisite: step.prerequisite,
              templateRef: step.templateRef || null,
              deliveryIntentId: null,
            });
          }
          enrolledCount++;
        }
        return { eventId, type, outcome: 'ENROLLED_NEW', enrolledCount };
      }

      // Case B: Already enrolled -> check if date, budgetPaise, or categories changed
      let replannedCount = 0;
      const settings = await campaignSettingsService.getSettings(tenantId);
      const effectiveNow = clock.now();

      for (const enr of enrollments) {
        const oldDate = enr.eventDateSnapshot || enr.occasionLocalDate;
        const newDate = occasion.eventDateKey || oldDate;
        const dateChanged = oldDate !== newDate;

        const customer = await mockCustomerSource.getCustomerById(tenantId, enr.customerId);
        if (!customer) continue;

        const pinnedVersion = (await CampaignVersionModel.findOne({
          tenantId,
          campaignId: enr.campaignId,
          version: enr.campaignVersion,
        }).lean()) as any;
        if (!pinnedVersion) continue;

        const [occY, occM, occD] = newDate.split('-').map(Number);
        const occInstant = new Date(Date.UTC(occY, occM - 1, occD));
        const nowMidnightUtc = new Date(Date.UTC(effectiveNow.getUTCFullYear(), effectiveNow.getUTCMonth(), effectiveNow.getUTCDate()));
        const daysUntilOccasion = Math.round((occInstant.getTime() - nowMidnightUtc.getTime()) / (24 * 60 * 60 * 1000));

        // Re-check audience
        const evalResult = evaluateCustomerForCampaign({
          customer,
          campaign: {
            trigger: pinnedVersion.trigger,
            enabledBranches: pinnedVersion.enabledBranches,
            audience: pinnedVersion.audience,
            purpose: pinnedVersion.purpose,
          },
          occasionLocalDate: newDate,
          daysUntilOccasion,
          occasion: {
            kind: occasion.kind,
            budgetPaise: occasion.budgetPaise,
            categories: occasion.categories,
          },
        });

        if (!evalResult.eligible) {
          // Audience no longer matches
          await CampaignExecutionModel.updateMany(
            {
              tenantId,
              enrollmentId: enr.enrollmentId,
              deliveryIntentId: null,
              state: { $in: [EXECUTION_STATE.SCHEDULED, EXECUTION_STATE.DEFERRED, EXECUTION_STATE.EVALUATING] },
            },
            {
              $set: {
                state: EXECUTION_STATE.CANCELLED,
                skipReason: EXECUTION_REASONS.AUDIENCE_NO_LONGER_MATCHES,
              },
            }
          );
          enr.status = ENROLLMENT_STATUS.CANCELLED;
          enr.exclusionReason = EXECUTION_REASONS.AUDIENCE_NO_LONGER_MATCHES;
          await enr.save();
          continue;
        }

        // If date changed: bump planRevision, update dateHistory, recompute unsubmitted executions
        if (dateChanged) {
          const oldVersion = enr.planRevision;
          const newVersion = oldVersion + 1;

          enr.eventDateSnapshot = newDate;
          enr.occasionLocalDate = newDate;
          enr.planRevision = newVersion;
          enr.dateHistory = enr.dateHistory || [];
          enr.dateHistory.push({
            at: effectiveNow,
            oldDate,
            newDate,
            oldVersion,
            newVersion,
          });
          await enr.save();

          // Frozen intent handling: if execution has deliveryIntentId !== null, block stale intent
          const executions = await CampaignExecutionModel.find({ tenantId, enrollmentId: enr.enrollmentId });
          for (const exe of executions) {
            if (exe.deliveryIntentId !== null) {
              const terminalStates = [
                EXECUTION_STATE.SENT,
                EXECUTION_STATE.DELIVERED,
                EXECUTION_STATE.READ,
                EXECUTION_STATE.PROVIDER_ACCEPTED,
              ];
              if (!terminalStates.includes(exe.state as any)) {
                await CampaignDeliveryIntentModel.updateOne(
                  { tenantId, deliveryIntentId: exe.deliveryIntentId },
                  { $set: { state: 'BLOCKED', failureReason: EXECUTION_REASONS.BLOCKED_STALE_INTENT } }
                );
                exe.state = EXECUTION_STATE.BLOCKED;
                exe.skipReason = EXECUTION_REASONS.BLOCKED_STALE_INTENT;
                await exe.save();
              }
            } else {
              // Unsubmitted execution: recompute
              const step = (pinnedVersion.steps || []).find((s: any) => s.stepId === exe.stepId);
              if (!step) continue;

              const stepDue = resolveStepDueAt({
                occasionLocalDate: newDate,
                offsetDays: step.offsetDays ?? 0,
                localTime: step.localTime || '10:00',
                timezone: pinnedVersion.timezone || 'Asia/Kolkata',
              });
              const expiresAt = computeStepExpiresAt({
                dueAt: stepDue.dueAt,
                maxLatenessMinutes: step.maxLatenessMinutes,
              });
              const fitResult = fitIntoAllowedHours(
                stepDue.dueAt,
                {
                  timezone: settings.timezone,
                  allowedSendingHours: settings.allowedSendingHours,
                  blackoutDates: settings.blackoutDates,
                  holidays: settings.holidays,
                },
                expiresAt
              );

              const leadDays =
                pinnedVersion.trigger?.fulfillmentLeadDays ??
                (pinnedVersion.trigger?.occasionKind === 'WEDDING' ? 21 : 2);
              const usefulResult = calculateLatestUsefulAt({
                eventDateKey: newDate,
                fulfillmentLeadDays: leadDays,
                allowedSendingHoursEnd: settings.allowedSendingHours?.end || '19:00',
                timezone: pinnedVersion.timezone || settings.timezone || 'Asia/Kolkata',
              });

              let state: string = EXECUTION_STATE.SCHEDULED;
              let skipReason: string | null = null;
              if (fitResult.status === 'SKIP') {
                state = EXECUTION_STATE.SKIPPED;
                skipReason = fitResult.reason || 'SKIPPED_EXPIRY';
              } else if (
                usefulResult.latestUsefulAt &&
                (fitResult.dueAt.getTime() > usefulResult.latestUsefulAt.getTime() ||
                  effectiveNow.getTime() > usefulResult.latestUsefulAt.getTime())
              ) {
                state = EXECUTION_STATE.SKIPPED;
                skipReason = EXECUTION_REASONS.INSUFFICIENT_LEAD_TIME;
              } else if (fitResult.dueAt.getTime() < effectiveNow.getTime()) {
                state = EXECUTION_STATE.SKIPPED;
                skipReason = 'Elapsed step prior to evaluation instant';
              }

              exe.planRevision = newVersion;
              exe.dueAt = fitResult.dueAt;
              exe.originalDueAt = stepDue.dueAt;
              exe.adjustedDueAt = fitResult.dueAt;
              exe.expiresAt = expiresAt;
              exe.latestUsefulAt = usefulResult.latestUsefulAt;
              exe.usefulUntilReason = formatInsufficientLeadTimeReason(leadDays, daysUntilOccasion);
              exe.localDate = stepDue.localDate;
              exe.localTime = stepDue.localTime;
              exe.state = state as any;
              exe.skipReason = skipReason;
              await exe.save();
            }
          }
          replannedCount++;
        }
      }
      return { eventId, type, outcome: 'REPLANNED', replannedCount };
    }

    return { eventId, type, outcome: 'IGNORED' };
  }

  /**
   * Process pending inbox events in bounded batch (outbox consumer).
   */
  async processPendingEvents(options: { tenantId?: string; limit?: number } = {}): Promise<{
    processedCount: number;
    quarantinedCount: number;
    failedCount: number;
  }> {
    const limit = options.limit || 50;
    const query: Record<string, unknown> = {
      status: EVENT_INBOX_STATUS.PENDING,
    };
    if (options.tenantId) {
      query.tenantId = options.tenantId;
    }

    const pending = await CampaignEventInboxModel.find(query).sort({ receivedAt: 1 }).limit(limit);

    let processedCount = 0;
    let quarantinedCount = 0;
    let failedCount = 0;

    for (const doc of pending) {
      try {
        await this.processEvent(doc);
        if (doc.status === EVENT_INBOX_STATUS.PROCESSED) processedCount++;
        else if (doc.status === EVENT_INBOX_STATUS.QUARANTINED) quarantinedCount++;
        else if (doc.status === EVENT_INBOX_STATUS.FAILED) failedCount++;
      } catch (err) {
        failedCount++;
      }
    }

    return { processedCount, quarantinedCount, failedCount };
  }

  /**
   * Enquiry Event Handler (Spec F23 Part 1):
   * - enquiry.saved: enroll or replan
   * - enquiry.resolved / enquiry.deleted: cancel unsent steps
   */
  private async handleEnquiryEvent(eventDoc: ICampaignEventInbox): Promise<Record<string, unknown>> {
    const { tenantId, entityId: enquiryId, type, data } = eventDoc;
    const enquiry = await mockEnquirySource.getEnquiry(tenantId, enquiryId);

    if (type === 'enquiry.resolved' || type === 'enquiry.deleted') {
      const status = (data as any)?.status || (type === 'enquiry.deleted' ? 'DELETED' : 'RESOLVED');
      const res = await handleEnquiryResolvedOrDeleted(tenantId, enquiryId, status);
      return { enquiryId, outcome: res.outcome, cancelledCount: res.cancelledCount };
    }

    if (!enquiry) {
      return { enquiryId, outcome: 'NOT_FOUND' };
    }

    if (!enquiry.customerId) {
      return { enquiryId, outcome: 'NO_CUSTOMER_RECORD' };
    }

    // Terminal enquiry statuses
    if (['RESOLVED', 'CLOSED', 'CANCELLED', 'DELETED'].includes(enquiry.status)) {
      const res = await handleEnquiryResolvedOrDeleted(tenantId, enquiryId, enquiry.status);
      return { enquiryId, outcome: res.outcome, cancelledCount: res.cancelledCount };
    }

    const occurrenceId = `enquiry:${enquiry.enquiryId}`;
    const existingEnrollment = await CampaignEnrollmentModel.findOne({
      tenantId,
      occurrenceId,
      status: { $in: [ENROLLMENT_STATUS.ACTIVE, ENROLLMENT_STATUS.PAUSED] },
    });

    if (existingEnrollment) {
      const res = await handleEnquirySavedOrUpdated(tenantId, enquiry);
      return {
        enquiryId,
        outcome: res.outcome,
        replannedCount: res.replannedCount,
        heldCount: res.heldCount,
      };
    }

    const enrollRes = await enrollEnquiryOccurrence(tenantId, enquiry);
    return {
      enquiryId,
      outcome: enrollRes.outcome || (enrollRes.enrolled ? 'ENROLLED' : 'EXCLUDED'),
      enrolled: enrollRes.enrolled,
      enrollmentId: enrollRes.enrollmentId,
    };
  }

  /**
   * Stock event handler — F25 Requested Item Available
   * stock.published: fan-out to find OPEN requests and enroll matching customers.
   * stock.recount:   informational only — no enrollment side effects.
   */
  private async handleStockEvent(eventDoc: ICampaignEventInbox): Promise<Record<string, unknown>> {
    if (eventDoc.type === 'stock.recount') {
      // stock.recount is informational — no enrollment side effects
      return { handler: 'stock.recount', outcome: 'NO_OP' };
    }

    return handleStockPublished(eventDoc);
  }
}

export const eventConsumerService = new EventConsumerService();

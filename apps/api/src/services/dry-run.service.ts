import crypto from 'crypto';
import {
  CampaignVersion,
  DryRunStepPlan,
  SampleRecipientPlan,
  ExcludedSample,
  SourceTemplate,
  SourceCustomer,
  EXCLUSION_REASONS,
  isValidISODate,
} from '@grovastra/shared';
import { CampaignModel } from '../db/models/campaign.model';
import { CampaignVersionModel, ICampaignVersion } from '../db/models/campaign-version.model';
import { CampaignDryRunModel, ICampaignDryRun } from '../db/models/campaign-dry-run.model';
import { TenantModel } from '../db/models/tenant.model';
import { campaignSettingsService } from './campaign-settings.service';
import { campaignValidationService } from './campaign-validation.service';
import { clock } from './clock';
import { auditService } from './audit.service';
import { mockCustomerSource, mockTemplateSource, mockOrderSource, mockOccasionSource, mockEnquirySource, mockProductSource } from '../adapters';
import { isQualifyingOrder } from '../presets/_shared/orderTrigger/qualifying';
import { DEFAULT_OUTFIT_PAIRING } from '../presets/completeOutfit/definition';
import { DateTime } from 'luxon';
import {
  nextOccurrence,
  getOccurrenceId,
  resolveStepDueAt,
  computeStepExpiresAt,
  fitIntoAllowedHours,
  evaluateStepFutureOnly,
  calculateLatestUsefulAt,
  formatInsufficientLeadTimeReason,
} from './datetime';
import { evaluateCustomerForCampaign } from './audience';
import { customerFactsService } from './customer-facts';
import { CampaignCustomerFactModel } from '../db/models/campaign-customer-fact.model';
import { computeDueTimes } from '../presets/_shared/eventDelay/delayTiming';
import { NotFoundError, ValidationError } from '../errors/app-error';
import { resolveForStep } from '../templates';

/**
 * Computes a deterministic SHA-256 fingerprint for a campaign draft version.
 * Any modification to trigger, audience, steps, timing, branches, or policies
 * causes the fingerprint to change (Spec p8, p26, A03).
 */
export function computeDraftFingerprint(draft: CampaignVersion | ICampaignVersion): string {
  const canonicalData = {
    campaignId: draft.campaignId,
    name: draft.name,
    industry: draft.industry,
    purpose: draft.purpose,
    trigger: {
      type: draft.trigger?.type,
      field: draft.trigger?.field,
      occasionKind: draft.trigger?.occasionKind,
      fulfillmentLeadDays: draft.trigger?.fulfillmentLeadDays,
      leapDayPolicy: draft.trigger?.leapDayPolicy,
      thresholdDays: draft.trigger?.thresholdDays,
      category: draft.trigger?.category,
      ruleId: draft.trigger?.ruleId,
      anchor: (draft.trigger as any)?.anchor,
    },
    timezone: draft.timezone,
    audience: {
      mode: draft.audience?.mode,
      rules: draft.audience?.rules
        ? {
            all: (draft.audience.rules.all || []).map((r) => ({
              field: r.field,
              op: r.op,
              value: r.value,
            })),
            any: (draft.audience.rules.any || []).map((r) => ({
              field: r.field,
              op: r.op,
              value: r.value,
            })),
            none: (draft.audience.rules.none || []).map((r) => ({
              field: r.field,
              op: r.op,
              value: r.value,
            })),
          }
        : null,
    },
    goal: {
      type: draft.goal?.type,
    },
    steps: (draft.steps || []).map((s) => ({
      stepId: s.stepId,
      stepName: s.stepName,
      offsetDays: s.offsetDays,
      localTime: s.localTime,
      delay: (s as any).delay,
      outsideHoursPolicy: (s as any).outsideHoursPolicy,
      maxDeferralHours: (s as any).maxDeferralHours,
      offerRef: (s as any).offerRef,
      prerequisite: s.prerequisite,
      templateRef: s.templateRef
        ? {
            id: s.templateRef.id,
            revision: s.templateRef.revision,
            language: s.templateRef.language,
          }
        : null,
      bindings: s.bindings,
      stopOnReply: s.stopOnReply,
      stopOnGoal: s.stopOnGoal,
      maxLatenessMinutes: s.maxLatenessMinutes,
    })),
    priority: draft.priority,
    resumePolicy: draft.resumePolicy,
    importPolicy: draft.importPolicy,
    enabledBranches: [...(draft.enabledBranches || [])].sort(),
  };

  const jsonStr = JSON.stringify(canonicalData, Object.keys(canonicalData).sort());
  return crypto.createHash('sha256').update(jsonStr).digest('hex');
}

/**
 * Renders sample message text using the ONE shared template parameter resolver.
 */
async function renderMessageText(
  tenantId: string,
  template: SourceTemplate | null,
  bindings: Record<string, any>,
  customer: SourceCustomer,
  shopName: string,
  context?: any
): Promise<{ renderedMessage: string; resolution: any; canonicalParameters?: any[]; payloadHash?: string }> {
  if (!template) {
    return { renderedMessage: 'Template missing or unresolved', resolution: null };
  }

  const stepRes = await resolveForStep({
    tenantId,
    template,
    bindings,
    customer,
    overrides: {
      customer,
      shopName,
      occasionLocalDate: context?.occasionLocalDate,
      eventDate: context?.eventDate || context?.occasionLocalDate,
      recipientLabel: context?.recipientLabel || null,
      bookingLinkUrl: context?.bookingLinkUrl || null,
      occasionKind: context?.occasionKind || null,
      offerAmountRupees: context?.offerAmountRupees || '50',
      order: {
        orderId: context?.orderNumber || 'ORD-000001',
        orderNumber: context?.orderNumber || 'ORD-000001',
        completedAt: context?.orderDate || context?.occasionLocalDate,
      },
      credit: {
        amount: 15000,
        unit: 'PAISE',
        expiresAt: new Date(Date.now() + 14 * 86400000),
      },
    },
  });

  return {
    renderedMessage: stepRes.resolution.renderedPreview,
    resolution: stepRes.resolution,
    canonicalParameters: stepRes.canonicalParameters,
    payloadHash: stepRes.payloadHash,
  };
}

export class DryRunService {
  /**
   * Executes a read-only campaign dry run report.
   * Strictly guarantees:
   * - ZERO writes to campaignEnrollments or campaignExecutions (Hard Rule, Spec p8, C01).
   * - Evaluates full draft configuration against live customer data.
   * - Records accurate count breakdown, sample plan schedules, and rendered messages.
   * - Persists report in campaignDryRuns collection.
   */
  async executeDryRun(params: {
    tenantId: string;
    userId: string;
    campaignId: string;
    nowOverride?: Date;
    ip?: string;
    userAgent?: string;
  }) {
    const { tenantId, userId, campaignId, nowOverride, ip, userAgent } = params;

    // 1. Locate Campaign
    const campaign = await CampaignModel.findOne({ tenantId, campaignId });
    if (!campaign) {
      throw new NotFoundError(`Campaign '${campaignId}' not found for tenant '${tenantId}'`);
    }

    // 2. Locate Active Draft
    const draft = await CampaignVersionModel.findOne({
      tenantId,
      campaignId,
      version: campaign.draftVersion,
    }).lean<ICampaignVersion | null>();

    if (!draft) {
      throw new NotFoundError(
        `Campaign draft version ${campaign.draftVersion} not found for campaign '${campaignId}'`
      );
    }

    // 3. Pre-flight Validation check (draft must be free of blocking errors)
    const validationReport = await campaignValidationService.validateDraft(
      tenantId,
      draft as unknown as CampaignVersion
    );
    if (!validationReport.valid) {
      throw new ValidationError(
        `Cannot execute dry run on invalid campaign draft: ${validationReport.errors[0].message}`,
        validationReport as unknown as Record<string, unknown>
      );
    }

    // 4. Calculate deterministic Draft Fingerprint
    const draftFingerprint = computeDraftFingerprint(draft);

    // 5. Determine Current Engine Time (respects dev time-travel / injected clock)
    const effectiveNow = nowOverride || clock.now();

    // 6. Load Tenant Campaign Settings & Shop Info
    const [settings, tenantDoc] = await Promise.all([
      campaignSettingsService.getSettings(tenantId),
      TenantModel.findOne({ tenantId }).lean<any>(),
    ]);

    const shopName = (tenantDoc && typeof tenantDoc === 'object' && 'name' in tenantDoc) ? tenantDoc.name : 'Sample Boutique';

    // 7. Pre-load Templates for Steps
    const templateMap = new Map<string, SourceTemplate>();
    for (const step of draft.steps || []) {
      if (step.templateRef?.id) {
        const tpl = await mockTemplateSource.getTemplateById(step.templateRef.id);
        if (tpl) {
          templateMap.set(step.templateRef.id, tpl);
        }
      }
    }

    // 8. Fetch All Candidates from Customer Source Adapter
    const { customers: allCustomers } = await mockCustomerSource.listCustomers(
      tenantId,
      { includeDeleted: true },
      { limit: 200 }
    );

    let scannedCount = 0;
    let eligibleCount = 0;
    let excludedCount = 0;

    const reasonBreakdown: Record<string, number> = {};
    const variableBreakdown = {
      ok: 0,
      usedFallback: 0,
      skippedMissing: 0,
      skippedTooLong: 0,
    };
    const samplePlans: SampleRecipientPlan[] = [];
    const excludedSamples: ExcludedSample[] = [];

    const incrementReason = (reason: string) => {
      reasonBreakdown[reason] = (reasonBreakdown[reason] || 0) + 1;
    };

    // 9. Process Each Customer Candidate
    for (const customer of allCustomers) {
      scannedCount++;

      let targetLocalDate: string;
      let occurrenceId: string;
      let daysUntilOccasion: number | undefined = undefined;
      let anchorInstant: Date | undefined;
      let occasionRecord: any = null;

      if (draft.trigger.type === 'INACTIVITY_THRESHOLD') {
        const fact: any =
          (await CampaignCustomerFactModel.findOne({ tenantId, customerId: customer.customerId }).lean()) ||
          (await customerFactsService.recomputeCustomerFacts(tenantId, customer.customerId));

        if (!fact || !fact.lastQualifyingOrderId || !fact.lastQualifyingPurchaseAt) {
          excludedCount++;
          incrementReason(EXCLUSION_REASONS.NO_PURCHASE_HISTORY);
          if (excludedSamples.length < 50) {
            excludedSamples.push({
              customerId: customer.customerId,
              customerName: customer.firstName,
              primaryReason: EXCLUSION_REASONS.NO_PURCHASE_HISTORY,
              details: 'No qualifying purchase history found for win-back audience (Spec p14)',
            });
          }
          continue;
        }

        const thresholdDays = draft.trigger.thresholdDays || 90;
        const lastPurchaseTime = new Date(fact.lastQualifyingPurchaseAt).getTime();
        const daysInactive = Math.floor((effectiveNow.getTime() - lastPurchaseTime) / (24 * 60 * 60 * 1000));

        if (daysInactive < thresholdDays) {
          excludedCount++;
          incrementReason(EXCLUSION_REASONS.INACTIVE_THRESHOLD_NOT_MET);
          if (excludedSamples.length < 50) {
            excludedSamples.push({
              customerId: customer.customerId,
              customerName: customer.firstName,
              primaryReason: EXCLUSION_REASONS.INACTIVE_THRESHOLD_NOT_MET,
              details: `Customer inactive for ${daysInactive} days (threshold is ${thresholdDays} days)`,
            });
          }
          continue;
        }

        targetLocalDate = DateTime.fromJSDate(effectiveNow, { zone: draft.timezone }).toISODate()!;
        const ruleId = draft.trigger.ruleId || 'default';
        occurrenceId = `winback:${fact.lastQualifyingOrderId}:${ruleId}`;
      } else if (draft.trigger.type === 'EVENT_DELAY') {
        const fact: any =
          (await CampaignCustomerFactModel.findOne({ tenantId, customerId: customer.customerId }).lean()) ||
          (await customerFactsService.recomputeCustomerFacts(tenantId, customer.customerId));

        const isWelcomeOrder =
          ['WELCOME_NEW_CUSTOMER', 'welcome_new_customer'].includes((draft as any).presetId || '') ||
          (draft as any).name?.toLowerCase().includes('welcome');

        const isRepeatPurchase =
          !isWelcomeOrder &&
          (draft.trigger.anchor === 'FIRST_QUALIFYING_ORDER' ||
            ['FIRST_TO_SECOND_PURCHASE', 'first_to_second_purchase', 'second_purchase', 'first-repeat'].includes(
              (draft as any).presetId || ''
            ));

        if (isWelcomeOrder) {
          const allOrders = await mockOrderSource.listOrdersForCustomer(tenantId, customer.customerId);
          const scope = (draft as any).scope || 'PER_CUSTOMER';
          let scopedOrders = allOrders;
          if (scope === 'PER_CUSTOMER_PER_BRANCH' && (draft as any).enabledBranches?.length === 1) {
            scopedOrders = allOrders.filter((o: any) => o.branchId === (draft as any).enabledBranches[0]);
          }

          const qualifyingOrders = scopedOrders.filter((o: any) => isQualifyingOrder(o));
          if (qualifyingOrders.length === 0) {
            excludedCount++;
            incrementReason(EXCLUSION_REASONS.NO_CUSTOMER_RECORD);
            if (excludedSamples.length < 50) {
              excludedSamples.push({
                customerId: customer.customerId,
                customerName: customer.firstName,
                primaryReason: EXCLUSION_REASONS.NO_CUSTOMER_RECORD,
                details: 'No qualifying store purchases found for welcome audience',
              });
            }
            continue;
          }

          qualifyingOrders.sort((a: any, b: any) => {
            const timeA = new Date(a.completedAt || a.createdAt || 0).getTime();
            const timeB = new Date(b.completedAt || b.createdAt || 0).getTime();
            if (timeA !== timeB) return timeA - timeB;
            return (a.orderId || '').localeCompare(b.orderId || '');
          });

          const anchorOrder = qualifyingOrders[0];
          const anchorCompletedAt = new Date(anchorOrder.completedAt || anchorOrder.createdAt || effectiveNow);

          // Check if older than startAt or all steps elapsed (existing customers aggregate)
          const startAt = (draft as any).startAt;
          if (startAt && anchorCompletedAt.getTime() < new Date(startAt).getTime()) {
            excludedCount++;
            incrementReason('EXISTING_CUSTOMERS');
            if (excludedSamples.length < 50) {
              excludedSamples.push({
                customerId: customer.customerId,
                customerName: customer.firstName,
                primaryReason: 'EXISTING_CUSTOMERS',
                details: 'First qualifying order occurred before campaign startAt',
              });
            }
            continue;
          }

          // Check if all steps elapsed
          const steps = draft.steps || [];
          let anyStepFuture = false;
          for (const step of steps) {
            const delay = (step as any).delay || { unit: 'HOURS', value: 1 };
            const maxLatenessMinutes = (step as any).maxLatenessMinutes ?? 180;
            let delayMs = 0;
            if (delay.unit === 'MINUTES') delayMs = (delay.value || 0) * 60 * 1000;
            else if (delay.unit === 'DAYS') delayMs = (delay.value || 0) * 24 * 60 * 60 * 1000;
            else delayMs = (delay.value || 0) * 60 * 60 * 1000;

            const rawDueAtMs = anchorCompletedAt.getTime() + delayMs;
            const latenessMs = maxLatenessMinutes * 60 * 1000;
            if (rawDueAtMs + latenessMs > effectiveNow.getTime()) {
              anyStepFuture = true;
              break;
            }
          }

          if (!anyStepFuture) {
            excludedCount++;
            incrementReason('EXISTING_CUSTOMERS');
            if (excludedSamples.length < 50) {
              excludedSamples.push({
                customerId: customer.customerId,
                customerName: customer.firstName,
                primaryReason: 'EXISTING_CUSTOMERS',
                details: 'Customer is an existing customer whose welcome steps have already elapsed',
              });
            }
            continue;
          }

          // Min first order net paise check
          const minPaise = (draft as any).minFirstOrderNetPaise || 0;
          const currentNet =
            anchorOrder.netPaise !== undefined
              ? anchorOrder.netPaise
              : (anchorOrder.grossPaise || 0) - (anchorOrder.refundedPaise || 0);

          if (minPaise > 0 && currentNet < minPaise) {
            excludedCount++;
            incrementReason(EXCLUSION_REASONS.FIRST_ORDER_BELOW_MINIMUM);
            if (excludedSamples.length < 50) {
              excludedSamples.push({
                customerId: customer.customerId,
                customerName: customer.firstName,
                primaryReason: EXCLUSION_REASONS.FIRST_ORDER_BELOW_MINIMUM,
                details: `First order net (${currentNet}) is below minimum (${minPaise})`,
              });
            }
            continue;
          }

          anchorInstant = anchorCompletedAt;
          targetLocalDate = DateTime.fromJSDate(anchorInstant, { zone: draft.timezone }).toISODate()!;
          occurrenceId = `welcome:${anchorOrder.orderId}`;
        } else if (isRepeatPurchase) {
          if (!fact || fact.qualifyingOrderCount === 0) {
            excludedCount++;
            incrementReason(EXCLUSION_REASONS.NO_CUSTOMER_RECORD);
            if (excludedSamples.length < 50) {
              excludedSamples.push({
                customerId: customer.customerId,
                customerName: customer.firstName,
                primaryReason: EXCLUSION_REASONS.NO_CUSTOMER_RECORD,
                details: 'No qualifying orders found for bring-back audience',
              });
            }
            continue;
          }

          if ((fact.maxQualifyingOrderCountSeen ?? 0) >= 2 || fact.qualifyingOrderCount >= 2) {
            excludedCount++;
            incrementReason(EXCLUSION_REASONS.ALREADY_REPEAT_CUSTOMER);
            if (excludedSamples.length < 50) {
              excludedSamples.push({
                customerId: customer.customerId,
                customerName: customer.firstName,
                primaryReason: EXCLUSION_REASONS.ALREADY_REPEAT_CUSTOMER,
                details: 'Customer has completed 2 or more qualifying orders',
              });
            }
            continue;
          }

          anchorInstant = fact.firstQualifyingAt ? new Date(fact.firstQualifyingAt) : effectiveNow;
          targetLocalDate = fact.firstQualifyingAt
            ? DateTime.fromJSDate(anchorInstant, { zone: draft.timezone }).toISODate()!
            : DateTime.fromJSDate(effectiveNow, { zone: draft.timezone }).toISODate()!;
          occurrenceId = `repeat:${fact.firstQualifyingOrderId || 'ord_1'}`;
        } else {
          anchorInstant = effectiveNow;
          targetLocalDate = DateTime.fromJSDate(effectiveNow, { zone: draft.timezone }).toISODate()!;
          occurrenceId = `event:${customer.customerId}`;
        }
      } else if (draft.trigger?.type === 'CUSTOMER_EVENT_DATE') {
        const occasions = await mockOccasionSource.listForCustomer(tenantId, customer.customerId);
        const targetKind = draft.trigger.occasionKind;
        const todayInTz = DateTime.fromJSDate(effectiveNow, { zone: draft.timezone || 'Asia/Kolkata' }).toISODate()!;
        const validOccasions = occasions.filter((occ) => {
          if (occ.deletedAt || occ.status !== 'ACTIVE') return false;
          if (targetKind && occ.kind !== targetKind) return false;
          if (!occ.declaredByCustomer) return false;
          if (!occ.eventDateKey || !isValidISODate(occ.eventDateKey)) return false;
          if (occ.eventDateKey < todayInTz) return false;
          return true;
        });

        if (validOccasions.length === 0) {
          excludedCount++;
          incrementReason(EXCLUSION_REASONS.MISSING_TRIGGER_DATE);
          if (excludedSamples.length < 50) {
            excludedSamples.push({
              customerId: customer.customerId,
              customerName: customer.firstName,
              primaryReason: EXCLUSION_REASONS.MISSING_TRIGGER_DATE,
              details: 'No active occasion found for customer',
            });
          }
          continue;
        }

        const occ = validOccasions[0];
        targetLocalDate = occ.eventDateKey!;
        occurrenceId = getOccurrenceId(occ.kind.toLowerCase(), undefined, occ.eventId);

        const [occY, occM, occD] = targetLocalDate.split('-').map(Number);
        const occInstant = new Date(Date.UTC(occY, occM - 1, occD));
        const nowMidnightUtc = new Date(
          Date.UTC(effectiveNow.getUTCFullYear(), effectiveNow.getUTCMonth(), effectiveNow.getUTCDate())
        );
      } else if (
        (draft.trigger as any)?.type === 'ENQUIRY_EVENT_DELAY' ||
        ((draft.trigger as any)?.type === 'EVENT_DELAY' && (draft.trigger as any)?.anchor === 'ENQUIRY_LAST_INTERACTION')
      ) {
        const enquiries = await mockEnquirySource.listByCustomerId(tenantId, customer.customerId);
        const openEnquiries = enquiries.filter((e: any) => e.status === 'OPEN');
        if (openEnquiries.length === 0) {
          excludedCount++;
          incrementReason(EXCLUSION_REASONS.NO_CUSTOMER_RECORD);
          if (excludedSamples.length < 50) {
            excludedSamples.push({
              customerId: customer.customerId,
              customerName: customer.firstName,
              primaryReason: EXCLUSION_REASONS.NO_CUSTOMER_RECORD,
              details: 'No open enquiries found for enquiry audience',
            });
          }
          continue;
        }

        const enquiry = openEnquiries[0];
        anchorInstant = enquiry.lastCustomerInteractionAt ? new Date(enquiry.lastCustomerInteractionAt) : effectiveNow;
        targetLocalDate = DateTime.fromJSDate(anchorInstant, { zone: draft.timezone || 'Asia/Kolkata' }).toISODate()!;
        occurrenceId = `enquiry:${enquiry.enquiryId}`;
        occasionRecord = {
          enquiryId: enquiry.enquiryId,
          itemRef: enquiry.itemRef,
          channel: enquiry.channel,
        };
      } else if ((draft.trigger as any)?.type === 'ORDER_EVENT_DELAY') {
        const orders = await mockOrderSource.listOrdersForCustomer(tenantId, customer.customerId);
        const qualifyingOrders = orders.filter((o: any) => isQualifyingOrder(o));
        if (qualifyingOrders.length === 0) {
          excludedCount++;
          incrementReason(EXCLUSION_REASONS.NO_PURCHASE_HISTORY);
          if (excludedSamples.length < 50) {
            excludedSamples.push({
              customerId: customer.customerId,
              customerName: customer.firstName,
              primaryReason: EXCLUSION_REASONS.NO_PURCHASE_HISTORY,
              details: 'No qualifying completed orders found',
            });
          }
          continue;
        }

        qualifyingOrders.sort(
          (a: any, b: any) => new Date(b.completedAt!).getTime() - new Date(a.completedAt!).getTime()
        );
        const targetOrder = qualifyingOrders[0];
        const pairing = (draft as any).pairing || DEFAULT_OUTFIT_PAIRING;
        const anchorCategories = pairing.anchorCategories || ['saree'];
        let bestAnchorLine: any = null;

        for (const line of targetOrder.lines || []) {
          if ((line.returnedQty || 0) >= (line.qty || 1)) continue;
          if (!line.productId) continue;
          const prod = await mockProductSource.getProduct(tenantId, line.productId);
          if (prod && anchorCategories.includes(prod.category)) {
            if (!bestAnchorLine || (line.lineNetPaise || 0) > (bestAnchorLine.lineNetPaise || 0)) {
              bestAnchorLine = { ...line, product: prod };
            }
          }
        }

        if (!bestAnchorLine) {
          excludedCount++;
          incrementReason(EXCLUSION_REASONS.NO_ANCHOR_LINE);
          if (excludedSamples.length < 50) {
            excludedSamples.push({
              customerId: customer.customerId,
              customerName: customer.firstName,
              primaryReason: EXCLUSION_REASONS.NO_ANCHOR_LINE,
              details: `Order contains no eligible anchor line in categories: ${anchorCategories.join(', ')}`,
            });
          }
          continue;
        }

        anchorInstant = new Date(targetOrder.completedAt!);
        targetLocalDate = DateTime.fromJSDate(anchorInstant, { zone: draft.timezone || 'Asia/Kolkata' }).toISODate()!;
        occurrenceId = `outfit:${targetOrder.orderId}`;
        occasionRecord = {
          orderId: targetOrder.orderId,
          anchorLineId: bestAnchorLine.lineId,
          anchorProductId: bestAnchorLine.productId,
          anchorItemName: bestAnchorLine.product?.name,
        };
      } else {
        // ANNUAL_DATE Trigger Branch
        // Check Customer Events if trigger is anniversary
        let anniversaryEvent: any = null;
        if (draft.trigger.field === 'customer.event') {
          const events = await mockCustomerSource.getCustomerEvents(tenantId, customer.customerId);
          anniversaryEvent = events.find((e) => e.type === 'anniversary') || events[0];
        }

        // Resolve Next Occasion Date
        let occasionMonthDay: { month: number; day: number } | null = null;
        let eventId: string | undefined;

        if (draft.trigger.field === 'customer.birthday') {
          if (customer.birthday) {
            occasionMonthDay = { month: customer.birthday.month, day: customer.birthday.day };
          }
        } else if (draft.trigger.field === 'customer.event') {
          if (anniversaryEvent) {
            occasionMonthDay = { month: anniversaryEvent.month, day: anniversaryEvent.day };
            eventId = anniversaryEvent.eventId;
          }
        }

        // If missing trigger occasion date, record exclusion immediately
        if (!occasionMonthDay) {
          excludedCount++;
          incrementReason(EXCLUSION_REASONS.MISSING_TRIGGER_DATE);
          if (excludedSamples.length < 50) {
            excludedSamples.push({
              customerId: customer.customerId,
              customerName: customer.firstName,
              primaryReason: EXCLUSION_REASONS.MISSING_TRIGGER_DATE,
              details: 'No verified occasion date found',
            });
          }
          continue;
        }

        // Compute Next Occurrence
        const occResult = nextOccurrence(
          occasionMonthDay,
          effectiveNow,
          draft.trigger.leapDayPolicy || 'FEB_28',
          draft.timezone
        );

        occurrenceId = getOccurrenceId(
          draft.trigger.field === 'customer.birthday' ? 'birthday' : 'anniversary',
          occResult.year,
          eventId
        );

        targetLocalDate = occResult.localDate;

        // Compute days until occasion
        const [occY, occM, occD] = occResult.localDate.split('-').map(Number);
        const occInstant = new Date(Date.UTC(occY, occM - 1, occD));
        const nowMidnightUtc = new Date(
          Date.UTC(effectiveNow.getUTCFullYear(), effectiveNow.getUTCMonth(), effectiveNow.getUTCDate())
        );
        daysUntilOccasion = Math.round(
          (occInstant.getTime() - nowMidnightUtc.getTime()) / (24 * 60 * 60 * 1000)
        );
      }

      // Evaluate Mandatory Gates & Audience Rules
      const evalResult = evaluateCustomerForCampaign({
        customer,
        campaign: {
          trigger: draft.trigger,
          enabledBranches: draft.enabledBranches,
          audience: draft.audience,
          purpose: draft.purpose,
        },
        occasionLocalDate: targetLocalDate,
        daysUntilOccasion,
        occasion: occasionRecord?.kind
          ? {
              kind: occasionRecord.kind,
              budgetPaise: occasionRecord.budgetPaise,
              categories: occasionRecord.categories,
            }
          : undefined,
        enquiry: occasionRecord?.enquiryId
          ? {
              channel: occasionRecord.channel,
              hasItem: Boolean(occasionRecord.itemRef?.productId),
              itemRef: occasionRecord.itemRef,
            }
          : undefined,
      });

      if (!evalResult.eligible) {
        excludedCount++;
        const reason = evalResult.primaryReason || 'EXCLUDED';
        incrementReason(reason);
        if (excludedSamples.length < 50) {
          excludedSamples.push({
            customerId: customer.customerId,
            customerName: customer.firstName,
            primaryReason: reason,
            details: evalResult.details,
          });
        }
        continue;
      }

      // Customer is Eligible! Plan message steps
      eligibleCount++;

      const plannedSteps: DryRunStepPlan[] = [];

      for (const step of draft.steps) {
        let stepDueAt: Date;
        let localDateStr: string;
        let localTimeStr: string;
        let expiresAt: Date;
        let status: 'SCHEDULED' | 'SKIPPED_ELAPSED' | 'SKIPPED_EXPIRY' = 'SCHEDULED';
        let skipReason: string | undefined;

        if (
          (draft.trigger.type === 'EVENT_DELAY' ||
            draft.trigger.type === 'ENQUIRY_EVENT_DELAY' ||
            (draft.trigger as any).type === 'ORDER_EVENT_DELAY') &&
          (step as any).delay
        ) {
          const timing = computeDueTimes(
            anchorInstant || (targetLocalDate ? new Date(targetLocalDate) : effectiveNow),
            (step as any).delay,
            {
              allowedSendingHours: settings.allowedSendingHours,
              timezone: draft.timezone,
              blackoutDates: settings.blackoutDates,
              holidays: settings.holidays,
            },
            {
              outsideHoursPolicy: (step as any).outsideHoursPolicy || 'DEFER_NEXT_DAY',
              maxDeferralHours: (step as any).maxDeferralHours ?? 24,
              maxLatenessMinutes: step.maxLatenessMinutes || 180,
            },
            {
              campaignEndAt: campaign.endAt,
              now: effectiveNow,
            }
          );

          stepDueAt = timing.adjustedDueAt;
          expiresAt = timing.expiresAt;
          localDateStr = timing.adjustedLocalDate;
          localTimeStr = timing.adjustedLocalTime;
          if (timing.skipReason) {
            status = 'SKIPPED_EXPIRY';
            skipReason = timing.skipReason;
          } else if (stepDueAt.getTime() < effectiveNow.getTime() || timing.isElapsed) {
            status = 'SKIPPED_ELAPSED';
            skipReason = 'Elapsed step prior to evaluation instant';
          }
        } else {
          const stepDue = resolveStepDueAt({
            occasionLocalDate: targetLocalDate,
            offsetDays: step.offsetDays ?? 0,
            localTime: step.localTime || '10:00',
            timezone: draft.timezone,
          });

          expiresAt = computeStepExpiresAt({
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

          localDateStr = stepDue.localDate;
          localTimeStr = stepDue.localTime;
          stepDueAt = fitResult.dueAt;

          let latestUsefulAt: Date | null = null;
          if (draft.trigger?.type === 'CUSTOMER_EVENT_DATE') {
            const leadDays =
              draft.trigger.fulfillmentLeadDays ??
              (draft.trigger.occasionKind === 'WEDDING' ? 21 : 2);
            const usefulResult = calculateLatestUsefulAt({
              eventDateKey: targetLocalDate,
              fulfillmentLeadDays: leadDays,
              allowedSendingHoursEnd: settings.allowedSendingHours?.end || '19:00',
              timezone: draft.timezone || settings.timezone || 'Asia/Kolkata',
            });
            latestUsefulAt = usefulResult.latestUsefulAt;
          }

          if (fitResult.status === 'SKIP') {
            status = 'SKIPPED_EXPIRY';
            skipReason = fitResult.reason;
          } else if (
            latestUsefulAt &&
            (fitResult.dueAt.getTime() > latestUsefulAt.getTime() ||
              effectiveNow.getTime() > latestUsefulAt.getTime())
          ) {
            status = 'SKIPPED_EXPIRY';
            skipReason = 'INSUFFICIENT_LEAD_TIME';
          } else {
            const futureCheck = evaluateStepFutureOnly(fitResult.dueAt, effectiveNow);
            status = futureCheck;
            if (futureCheck === 'SKIPPED_ELAPSED') {
              skipReason = 'Elapsed step prior to evaluation instant';
            }
          }
        }

        const template = step.templateRef ? templateMap.get(step.templateRef.id) || null : null;
        const rendered = await renderMessageText(
          tenantId,
          template,
          step.bindings || {},
          customer,
          shopName,
          {
            occasionLocalDate: targetLocalDate,
            offerAmountRupees: '50',
            orderNumber: 'ORD-1001',
            orderDate: targetLocalDate,
            creditBalance: '₹150',
            creditExpiry: '31 Dec 2026',
            creditDays: '14',
          } as any
        );

        if (rendered.resolution) {
          const res = rendered.resolution;
          if (res.ok) {
            variableBreakdown.ok += res.parameters.length;
            if (res.usedFallback) {
              variableBreakdown.usedFallback += res.parameters.filter((p: any) => p.usedFallback).length;
            }
          } else {
            const probIndices = new Set(res.problems.map((p: any) => p.variableIndex));
            variableBreakdown.ok += res.parameters.filter((p: any) => !probIndices.has(p.index)).length;
            if (res.usedFallback) {
              variableBreakdown.usedFallback += res.parameters.filter(
                (p: any) => !probIndices.has(p.index) && p.usedFallback
              ).length;
            }
            for (const prob of res.problems) {
              if (prob.code === 'MISSING_VARIABLE') variableBreakdown.skippedMissing += 1;
              else if (prob.code === 'VARIABLE_TOO_LONG') variableBreakdown.skippedTooLong += 1;
            }
          }
        }

        plannedSteps.push({
          stepId: step.stepId,
          stepName: step.stepName || step.stepId,
          offsetDays: step.offsetDays ?? 0,
          localDate: localDateStr,
          localTime: localTimeStr,
          timezone: draft.timezone,
          dueAtUtc: stepDueAt.toISOString(),
          expiresAtUtc: expiresAt.toISOString(),
          status,
          skipReason,
          renderedMessage: rendered.renderedMessage,
          templateId: step.templateRef?.id || 'none',
          templateName: template?.name || 'none',
        });
      }

      if (samplePlans.length < 50) {
        samplePlans.push({
          customerId: customer.customerId,
          customerName: customer.firstName,
          maskedPhone: customer.destination.masked,
          occurrenceId,
          occasionLocalDate: targetLocalDate,
          matchExplanation: evalResult.explanation || 'all eligible',
          firstLocalDate: plannedSteps[0]?.localDate || targetLocalDate,
          firstDueAtUtc: plannedSteps[0]?.dueAtUtc || effectiveNow.toISOString(),
          steps: plannedSteps,
        });
      }
    }

    // 10. Persist Dry Run Report (ZERO live enrollments or executions created!)
    const dryRunId = `dry_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

    const dryRunDoc = new CampaignDryRunModel({
      dryRunId,
      tenantId,
      campaignId,
      draftVersion: draft.version,
      draftFingerprint,
      counts: {
        scanned: scannedCount,
        eligible: eligibleCount,
        excluded: excludedCount,
      },
      reasonBreakdown,
      variableBreakdown,
      samplePlans,
      excludedSamples,
      evaluatedAt: effectiveNow,
      evaluatedBy: userId,
    });

    await dryRunDoc.save();

    // 11. Log append-only audit trail
    await auditService.logEvent({
      tenantId,
      userId,
      action: 'CAMPAIGN_DRY_RUN_EXECUTED',
      metadata: {
        campaignId,
        dryRunId,
        draftVersion: draft.version,
        draftFingerprint,
        scannedCount,
        eligibleCount,
        excludedCount,
      },
      ip,
      userAgent,
    });

    return {
      ...dryRunDoc.toObject(),
      isStale: false,
    };
  }

  /**
   * Retrieves the latest dry run report for a campaign draft.
   * Compares the stored review fingerprint with the current draft fingerprint
   * to mark stale evaluations (Spec p8, p26, A03).
   */
  async getLatestDryRun(tenantId: string, campaignId: string) {
    const campaign = await CampaignModel.findOne({ tenantId, campaignId });
    if (!campaign) {
      throw new NotFoundError(`Campaign '${campaignId}' not found for tenant '${tenantId}'`);
    }

    const draft = await CampaignVersionModel.findOne({
      tenantId,
      campaignId,
      version: campaign.draftVersion,
    }).lean<ICampaignVersion | null>();

    if (!draft) {
      throw new NotFoundError(
        `Campaign draft version ${campaign.draftVersion} not found for campaign '${campaignId}'`
      );
    }

    const currentFingerprint = computeDraftFingerprint(draft);

    const latestDryRun = await CampaignDryRunModel.findOne({ tenantId, campaignId })
      .sort({ evaluatedAt: -1 })
      .lean<ICampaignDryRun | null>();

    if (!latestDryRun) {
      return null;
    }

    const isStale = latestDryRun.draftFingerprint !== currentFingerprint;

    return {
      ...latestDryRun,
      currentFingerprint,
      isStale,
    };
  }
}

export const dryRunService = new DryRunService();

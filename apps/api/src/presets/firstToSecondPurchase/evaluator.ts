import { PresetEvaluator, registerPresetEvaluator } from '../types';
import { FIRST_TO_SECOND_PURCHASE_ID, FIRST_TO_SECOND_PURCHASE_ALIAS } from './definition';
import { enrollEventDelayOccurrence } from '../_shared/eventDelay/enrollerBase';
import { dispatchRecheck } from '../_shared/eventDelay/dispatchRecheck';
import { mockOrderSource } from '../../adapters/order-source';
import { mockOfferSource } from '../../adapters/OfferSource';
import { mockCreditSource } from '../../adapters/CreditSource';
import { SrcTemplateModel, CampaignModel, CampaignCustomerFactModel } from '../../db/models';
import { isQualifyingOrder } from '../_shared/orderTrigger/qualifying';
import { logger } from '../../logger';

export class FirstToSecondPurchaseEvaluator implements PresetEvaluator {
  key = FIRST_TO_SECOND_PURCHASE_ID;

  async validateConfigAsync(
    config: any,
    templatesById?: Map<string, any>
  ): Promise<{ valid: boolean; errors: any[]; warnings: any[] }> {
    const errors: any[] = [];
    const warnings: any[] = [];

    const steps = config.steps || [];

    if (!Array.isArray(steps) || steps.length < 1 || steps.length > 3) {
      errors.push({
        fieldPath: 'steps',
        message: 'Campaign must contain between 1 and 3 steps',
        resolutionOwner: 'BOUTIQUE_OWNER',
      });
      return { valid: false, errors, warnings };
    }

    const seenStepIds = new Set<string>();
    let previousTotalHours = -1;

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const stepIndex = i;

      // Unique stepId check
      if (!step.stepId || typeof step.stepId !== 'string' || !step.stepId.trim()) {
        errors.push({
          fieldPath: `steps[${stepIndex}].stepId`,
          message: 'stepId is required for every step',
          resolutionOwner: 'INTEGRATION_DEVELOPER',
        });
      } else if (seenStepIds.has(step.stepId)) {
        errors.push({
          fieldPath: `steps[${stepIndex}].stepId`,
          message: `Duplicate stepId '${step.stepId}' found across steps`,
          resolutionOwner: 'INTEGRATION_DEVELOPER',
        });
      } else {
        seenStepIds.add(step.stepId);
      }

      // Delay bounds: DAYS 1-365, HOURS 1-8760
      const delay = step.delay;
      if (!delay || typeof delay !== 'object') {
        errors.push({
          fieldPath: `steps[${stepIndex}].delay`,
          message: 'Delay specification is required (unit and value)',
          resolutionOwner: 'BOUTIQUE_OWNER',
        });
      } else {
        if (!['HOURS', 'DAYS'].includes(delay.unit)) {
          errors.push({
            fieldPath: `steps[${stepIndex}].delay.unit`,
            message: 'Delay unit must be either HOURS or DAYS',
            resolutionOwner: 'BOUTIQUE_OWNER',
          });
        }
        if (typeof delay.value !== 'number' || delay.value < 1) {
          errors.push({
            fieldPath: `steps[${stepIndex}].delay.value`,
            message: 'Delay value must be at least 1',
            resolutionOwner: 'BOUTIQUE_OWNER',
          });
        } else {
          if (delay.unit === 'HOURS' && delay.value > 8760) {
            errors.push({
              fieldPath: `steps[${stepIndex}].delay.value`,
              message: 'Delay in hours cannot exceed 8760 hours (365 days)',
              resolutionOwner: 'BOUTIQUE_OWNER',
            });
          }
          if (delay.unit === 'DAYS' && delay.value > 365) {
            errors.push({
              fieldPath: `steps[${stepIndex}].delay.value`,
              message: 'Delay in days cannot exceed 365 days',
              resolutionOwner: 'BOUTIQUE_OWNER',
            });
          }

          // Strictly increasing total delay measured from anchor
          const currentTotalHours = delay.unit === 'DAYS' ? delay.value * 24 : delay.value;
          if (currentTotalHours <= previousTotalHours) {
            errors.push({
              fieldPath: `steps[${stepIndex}].delay`,
              message: `Step ${stepIndex + 1} delay (${currentTotalHours}h) must be strictly greater than step ${stepIndex} delay (${previousTotalHours}h)`,
              resolutionOwner: 'BOUTIQUE_OWNER',
            });
          }
          previousTotalHours = currentTotalHours;
        }
      }

      // maxDeferralHours bounds (0-48)
      if (step.maxDeferralHours !== undefined) {
        if (typeof step.maxDeferralHours !== 'number' || step.maxDeferralHours < 0 || step.maxDeferralHours > 48) {
          errors.push({
            fieldPath: `steps[${stepIndex}].maxDeferralHours`,
            message: 'maxDeferralHours must be between 0 and 48 hours',
            resolutionOwner: 'BOUTIQUE_OWNER',
          });
        }
      }

      // maxLatenessMinutes
      if (step.maxLatenessMinutes !== undefined) {
        if (typeof step.maxLatenessMinutes !== 'number' || step.maxLatenessMinutes <= 0) {
          errors.push({
            fieldPath: `steps[${stepIndex}].maxLatenessMinutes`,
            message: 'maxLatenessMinutes must be positive',
            resolutionOwner: 'BOUTIQUE_OWNER',
          });
        }
      }

      // Load template if referenced to inspect variables and bindings
      let template: any = null;
      if (step.templateRef?.id) {
        if (templatesById && templatesById.has(step.templateRef.id)) {
          template = templatesById.get(step.templateRef.id);
        } else {
          template = await SrcTemplateModel.findOne({ id: step.templateRef.id }).lean();
        }
      }

      // 1. Offer reference check
      const hasOfferBinding = Object.values(step.bindings || {}).some(
        (b: any) => b === 'offer.amountRupees' || b?.source === 'offer.amountRupees'
      );
      const hasOfferVariable = (template?.variables || []).some(
        (v: any) => v.name?.includes('offer') || v.name?.includes('discount')
      );

      if (hasOfferBinding || hasOfferVariable) {
        if (!step.offerRef || !step.offerRef.offerId) {
          errors.push({
            fieldPath: `steps[${stepIndex}].offerRef`,
            message: 'offerRef is required because the selected template includes an offer variable',
            resolutionOwner: 'BOUTIQUE_OWNER',
          });
        }
      }

      // 2. Credit reference check
      const hasCreditBinding = Object.values(step.bindings || {}).some((b: any) => {
        const src = typeof b === 'string' ? b : b?.source;
        return src?.startsWith('credit.');
      });
      const hasCreditVariable = (template?.variables || []).some((v: any) => {
        const name = v.name?.toLowerCase() || '';
        return name.includes('credit') || name.includes('reward') || name.includes('point') || name.includes('cashback') || name.includes('expiry');
      });

      if (hasCreditBinding || hasCreditVariable) {
        if (!step.creditRef || (!step.creditRef.selector && !step.creditRef.creditId)) {
          errors.push({
            fieldPath: `steps[${stepIndex}].creditRef`,
            message: 'creditRef is required when credit.* variables or bindings are used',
            resolutionOwner: 'BOUTIQUE_OWNER',
          });
        }
      }

      // Warning when bodyText contains "today" or "tonight" with DEFER_NEXT_DAY
      const outsideHoursPolicy = step.outsideHoursPolicy || 'DEFER_NEXT_DAY';
      if (outsideHoursPolicy === 'DEFER_NEXT_DAY' && template?.bodyText) {
        const bodyLower = template.bodyText.toLowerCase();
        if (bodyLower.includes('today') || bodyLower.includes('tonight')) {
          warnings.push({
            fieldPath: `steps[${stepIndex}].templateRef`,
            message: "Template text contains 'today' or 'tonight', which may be inaccurate when messages are deferred to the next day",
            resolutionOwner: 'BOUTIQUE_OWNER',
          });
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  validateConfig(config: any): { valid: boolean; errors: any[]; warnings: any[] } {
    const errors: any[] = [];
    const warnings: any[] = [];

    const steps = config.steps || [];
    if (!Array.isArray(steps) || steps.length < 1 || steps.length > 3) {
      errors.push({
        fieldPath: 'steps',
        message: 'Campaign must contain between 1 and 3 steps',
        resolutionOwner: 'BOUTIQUE_OWNER',
      });
      return { valid: false, errors, warnings };
    }

    let previousTotalHours = -1;
    const seenStepIds = new Set<string>();

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      if (seenStepIds.has(step.stepId)) {
        errors.push({
          fieldPath: `steps[${i}].stepId`,
          message: `Duplicate stepId '${step.stepId}'`,
          resolutionOwner: 'INTEGRATION_DEVELOPER',
        });
      }
      seenStepIds.add(step.stepId);

      const delay = step.delay;
      if (delay) {
        const currentTotalHours = delay.unit === 'DAYS' ? delay.value * 24 : delay.value;
        if (currentTotalHours <= previousTotalHours) {
          errors.push({
            fieldPath: `steps[${i}].delay`,
            message: `Step ${i + 1} delay must be strictly greater than step ${i}`,
            resolutionOwner: 'BOUTIQUE_OWNER',
          });
        }
        previousTotalHours = currentTotalHours;

        if (delay.unit === 'HOURS' && (delay.value < 1 || delay.value > 8760)) {
          errors.push({
            fieldPath: `steps[${i}].delay.value`,
            message: 'Delay in hours must be between 1 and 8760 hours',
            resolutionOwner: 'BOUTIQUE_OWNER',
          });
        }
        if (delay.unit === 'DAYS' && (delay.value < 1 || delay.value > 365)) {
          errors.push({
            fieldPath: `steps[${i}].delay.value`,
            message: 'Delay in days cannot exceed 365 days',
            resolutionOwner: 'BOUTIQUE_OWNER',
          });
        }
      }

      if (step.maxDeferralHours !== undefined && (step.maxDeferralHours < 0 || step.maxDeferralHours > 48)) {
        errors.push({
          fieldPath: `steps[${i}].maxDeferralHours`,
          message: 'maxDeferralHours must be between 0 and 48',
          resolutionOwner: 'BOUTIQUE_OWNER',
        });
      }

      const hasOfferBinding = Object.values(step.bindings || {}).some(
        (b: any) => b === 'offer.amountRupees' || b?.source === 'offer.amountRupees'
      );
      if (hasOfferBinding && (!step.offerRef || !step.offerRef.offerId)) {
        errors.push({
          fieldPath: `steps[${i}].offerRef`,
          message: 'offerRef is required when offer.amountRupees binding is used',
          resolutionOwner: 'BOUTIQUE_OWNER',
        });
      }

      const hasCreditBinding = Object.values(step.bindings || {}).some((b: any) => {
        const src = typeof b === 'string' ? b : b?.source;
        return src?.startsWith('credit.');
      });
      if (hasCreditBinding && (!step.creditRef || (!step.creditRef.selector && !step.creditRef.creditId))) {
        errors.push({
          fieldPath: `steps[${i}].creditRef`,
          message: 'creditRef is required when credit.* binding is used',
          resolutionOwner: 'BOUTIQUE_OWNER',
        });
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  async planFromFacts(context: {
    tenantId: string;
    customerId: string;
    facts: any;
    order?: any;
  }): Promise<void> {
    const { tenantId, customerId, facts, order } = context;

    if (facts.qualifyingOrderCount !== 1 || (facts.maxQualifyingOrderCountSeen ?? 0) > 1) {
      return;
    }

    const activeCampaigns = await CampaignModel.find({
      tenantId,
      status: 'ACTIVE',
      presetId: { $in: [FIRST_TO_SECOND_PURCHASE_ID, FIRST_TO_SECOND_PURCHASE_ALIAS] },
    }).lean();

    for (const campaign of activeCampaigns) {
      const occurrenceId = `repeat:${facts.firstQualifyingOrderId}`;
      await enrollEventDelayOccurrence(
        tenantId,
        campaign.campaignId,
        customerId,
        occurrenceId,
        order || {
          orderId: facts.firstQualifyingOrderId,
          orderNumber: facts.firstQualifyingOrderNumber,
          netPaise: facts.firstQualifyingNetPaise,
          completedAt: facts.firstQualifyingAt,
          occurredAt: facts.firstQualifyingAt,
        }
      );
    }
  }

  async checkStopAtDispatch(context: any): Promise<{ stop: boolean; reason?: string }> {
    const res = await dispatchRecheck(
      context.execution,
      context.enrollment,
      context.customer,
      context.template
    );
    return {
      stop: !res.proceed,
      reason: res.stopReason,
    };
  }
}

export const firstToSecondPurchaseEvaluator = new FirstToSecondPurchaseEvaluator();
registerPresetEvaluator(firstToSecondPurchaseEvaluator);

export const firstToSecondPurchaseAliasEvaluator = new FirstToSecondPurchaseEvaluator();
firstToSecondPurchaseAliasEvaluator.key = FIRST_TO_SECOND_PURCHASE_ALIAS;
registerPresetEvaluator(firstToSecondPurchaseAliasEvaluator);

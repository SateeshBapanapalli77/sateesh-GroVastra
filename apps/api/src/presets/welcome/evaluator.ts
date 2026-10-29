import { PresetEvaluator, registerPresetEvaluator } from '../types';
import {
  WELCOME_NEW_CUSTOMER_ID,
  WELCOME_NEW_CUSTOMER_ALIAS,
} from './definition';
import { dispatchRecheck } from '../_shared/eventDelay/dispatchRecheck';
import { mockOfferSource } from '../../adapters/OfferSource';
import { SrcTemplateModel, CampaignModel } from '../../db/models';
import { logger } from '../../logger';

export class WelcomePresetEvaluator implements PresetEvaluator {
  key = WELCOME_NEW_CUSTOMER_ID;

  /**
   * Validates configuration for Welcome Campaign draft according to Spec & Design Contract:
   * - 1 to 3 steps allowed
   * - Delay bounds: MINUTES 0-1440, HOURS 0-168, DAYS 0-30
   * - Strictly increasing total delay across steps
   * - Stable unique stepIds
   * - maxDeferralHours bounds: 0-48
   * - maxLatenessMinutes positive
   * - offerRef required when template has offer variable or binding
   * - Warning when bodyText contains "today" or "tonight" while outsideHoursPolicy is DEFER_NEXT_DAY
   * - Warning WELCOME_CONTAINS_ORDER_DETAILS if order.* binding is used
   */
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
        message: 'Welcome campaign must contain between 1 and 3 steps',
        resolutionOwner: 'BOUTIQUE_OWNER',
      });
      return { valid: errors.length === 0, errors, warnings };
    }

    const seenStepIds = new Set<string>();
    let previousTotalMinutes = -1;

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

      // Delay bounds
      const delay = step.delay;
      if (!delay || typeof delay !== 'object') {
        errors.push({
          fieldPath: `steps[${stepIndex}].delay`,
          message: 'Delay specification is required (unit and value)',
          resolutionOwner: 'BOUTIQUE_OWNER',
        });
      } else {
        if (!['MINUTES', 'HOURS', 'DAYS'].includes(delay.unit)) {
          errors.push({
            fieldPath: `steps[${stepIndex}].delay.unit`,
            message: 'Delay unit must be MINUTES, HOURS, or DAYS',
            resolutionOwner: 'BOUTIQUE_OWNER',
          });
        }
        if (typeof delay.value !== 'number' || isNaN(delay.value) || delay.value < 0) {
          errors.push({
            fieldPath: `steps[${stepIndex}].delay.value`,
            message: 'Delay value must be a non-negative number',
            resolutionOwner: 'BOUTIQUE_OWNER',
          });
        } else {
          if (delay.unit === 'MINUTES' && delay.value > 1440) {
            errors.push({
              fieldPath: `steps[${stepIndex}].delay.value`,
              message: 'Delay in minutes cannot exceed 1440 minutes (24 hours)',
              resolutionOwner: 'BOUTIQUE_OWNER',
            });
          }
          if (delay.unit === 'HOURS' && delay.value > 168) {
            errors.push({
              fieldPath: `steps[${stepIndex}].delay.value`,
              message: 'Delay in hours cannot exceed 168 hours (7 days)',
              resolutionOwner: 'BOUTIQUE_OWNER',
            });
          }
          if (delay.unit === 'DAYS' && delay.value > 30) {
            errors.push({
              fieldPath: `steps[${stepIndex}].delay.value`,
              message: 'Delay in days cannot exceed 30 days',
              resolutionOwner: 'BOUTIQUE_OWNER',
            });
          }
        }

        // Strictly increasing total delay across steps
        const totalMinutes =
          delay.unit === 'MINUTES'
            ? delay.value
            : delay.unit === 'DAYS'
            ? delay.value * 24 * 60
            : delay.value * 60;

        if (totalMinutes <= previousTotalMinutes) {
          errors.push({
            fieldPath: `steps[${stepIndex}].delay`,
            message: `Step ${stepIndex + 1} delay must be strictly greater than step ${stepIndex}`,
            resolutionOwner: 'BOUTIQUE_OWNER',
          });
        }
        previousTotalMinutes = totalMinutes;
      }

      // maxDeferralHours bounds (0 to 48)
      if (step.maxDeferralHours !== undefined && (step.maxDeferralHours < 0 || step.maxDeferralHours > 48)) {
        errors.push({
          fieldPath: `steps[${stepIndex}].maxDeferralHours`,
          message: 'maxDeferralHours must be between 0 and 48',
          resolutionOwner: 'BOUTIQUE_OWNER',
        });
      }

      // maxLatenessMinutes
      if (step.maxLatenessMinutes !== undefined && step.maxLatenessMinutes <= 0) {
        errors.push({
          fieldPath: `steps[${stepIndex}].maxLatenessMinutes`,
          message: 'maxLatenessMinutes must be positive',
          resolutionOwner: 'BOUTIQUE_OWNER',
        });
      }

      // Template & Offer validation
      const templateId = step.templateRef?.id;
      let template: any = null;
      if (templateId) {
        if (templatesById && templatesById.has(templateId)) {
          template = templatesById.get(templateId);
        } else {
          template = await SrcTemplateModel.findOne({ id: templateId }).lean();
        }
      }

      const bindings = step.bindings || {};
      const hasOfferBinding = Object.values(bindings).some(
        (b: any) => b === 'offer.amountRupees' || (b as any)?.source === 'offer.amountRupees'
      );
      const templateHasOfferVariable =
        template?.variables?.some((v: any) => v.name?.toLowerCase().includes('offer')) ?? false;

      if (hasOfferBinding || templateHasOfferVariable) {
        if (!step.offerRef || !step.offerRef.offerId) {
          errors.push({
            fieldPath: `steps[${stepIndex}].offerRef`,
            message: 'offerRef is required when step bindings or template variables reference an offer',
            resolutionOwner: 'BOUTIQUE_OWNER',
          });
        } else {
          // Verify offer exists
          const tenantId = config.tenantId || 'shop_a';
          const offer = await mockOfferSource.getOfferById(tenantId, step.offerRef.offerId);
          if (!offer) {
            errors.push({
              fieldPath: `steps[${stepIndex}].offerRef.offerId`,
              message: `Referenced offer '${step.offerRef.offerId}' not found`,
              resolutionOwner: 'BOUTIQUE_OWNER',
            });
          }
        }
      }

      // Order details warning
      for (const [key, b] of Object.entries(bindings)) {
        const source = typeof b === 'string' ? b : (b as any)?.source;
        if (source && typeof source === 'string' && source.startsWith('order.')) {
          warnings.push({
            fieldPath: `steps[${stepIndex}].bindings.${key}`,
            message: 'Welcome message should not contain order details to avoid exposing purchase details (WELCOME_CONTAINS_ORDER_DETAILS)',
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
        message: 'Welcome campaign must contain between 1 and 3 steps',
        resolutionOwner: 'BOUTIQUE_OWNER',
      });
      return { valid: false, errors, warnings };
    }

    let previousTotalMinutes = -1;
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
        if (!['MINUTES', 'HOURS', 'DAYS'].includes(delay.unit)) {
          errors.push({
            fieldPath: `steps[${i}].delay.unit`,
            message: 'Delay unit must be MINUTES, HOURS, or DAYS',
            resolutionOwner: 'BOUTIQUE_OWNER',
          });
        }
        const currentTotalMinutes =
          delay.unit === 'MINUTES'
            ? delay.value
            : delay.unit === 'DAYS'
            ? delay.value * 24 * 60
            : delay.value * 60;

        if (currentTotalMinutes <= previousTotalMinutes) {
          errors.push({
            fieldPath: `steps[${i}].delay`,
            message: `Step ${i + 1} delay must be strictly greater than step ${i}`,
            resolutionOwner: 'BOUTIQUE_OWNER',
          });
        }
        previousTotalMinutes = currentTotalMinutes;

        if (delay.unit === 'MINUTES' && delay.value > 1440) {
          errors.push({
            fieldPath: `steps[${i}].delay.value`,
            message: 'Delay in minutes cannot exceed 1440 minutes',
            resolutionOwner: 'BOUTIQUE_OWNER',
          });
        }
        if (delay.unit === 'HOURS' && delay.value > 168) {
          errors.push({
            fieldPath: `steps[${i}].delay.value`,
            message: 'Delay in hours cannot exceed 168 hours',
            resolutionOwner: 'BOUTIQUE_OWNER',
          });
        }
        if (delay.unit === 'DAYS' && delay.value > 30) {
          errors.push({
            fieldPath: `steps[${i}].delay.value`,
            message: 'Delay in days cannot exceed 30 days',
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

      // Check for order details binding warning
      for (const [key, b] of Object.entries(step.bindings || {})) {
        const source = typeof b === 'string' ? b : (b as any)?.source;
        if (source && typeof source === 'string' && source.startsWith('order.')) {
          warnings.push({
            fieldPath: `steps[${i}].bindings.${key}`,
            message: 'Welcome message should not contain order details to avoid exposing purchase details (WELCOME_CONTAINS_ORDER_DETAILS)',
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

  /**
   * Live dispatch stop recheck.
   */
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

export const welcomeNewCustomerEvaluator = new WelcomePresetEvaluator();
registerPresetEvaluator(welcomeNewCustomerEvaluator);

export const welcomeNewCustomerAliasEvaluator = new WelcomePresetEvaluator();
welcomeNewCustomerAliasEvaluator.key = WELCOME_NEW_CUSTOMER_ALIAS;
registerPresetEvaluator(welcomeNewCustomerAliasEvaluator);

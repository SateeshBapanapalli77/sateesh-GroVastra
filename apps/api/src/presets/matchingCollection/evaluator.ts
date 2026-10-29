/**
 * Matching Collection Preset Evaluator — F26
 *
 * Implements PresetEvaluator interface for matching_collection.
 * Registered via registerPresetEvaluator so that the preset is fully functional
 * and passes the platform rule: "no preset appears functional in UI until its evaluator is implemented".
 */

import { PresetEvaluator, registerPresetEvaluator } from '../types';
import { MATCHING_COLLECTION_ID, MATCHING_COLLECTION_ALIAS } from './definition';
import { dispatchRecheck } from '../_shared/eventDelay/dispatchRecheck';
import { SrcCollectionModel } from '../../db/models/src-collection.model';
import { SrcOrderModel } from '../../db/models/src-order.model';
import { scoreAffinityForCollection, evaluateAffinityEligibility } from './matching';
import { normalizePreferences } from '@grovastra/shared';

export class MatchingCollectionEvaluator implements PresetEvaluator {
  key = MATCHING_COLLECTION_ID;

  validateConfig(config: any): { valid: boolean; errors: any[]; warnings: any[] } {
    const errors: any[] = [];
    const warnings: any[] = [];

    // minAffinityScore validation: must be number between 0.0 and 1.0 if present
    if (config.minAffinityScore !== undefined) {
      if (
        typeof config.minAffinityScore !== 'number' ||
        config.minAffinityScore < 0.0 ||
        config.minAffinityScore > 1.0
      ) {
        errors.push({
          fieldPath: 'minAffinityScore',
          message: 'minAffinityScore must be a number between 0.0 and 1.0',
          resolutionOwner: 'BOUTIQUE_OWNER',
        });
      }
    }

    const steps = config.steps || [];
    if (!Array.isArray(steps) || steps.length < 1 || steps.length > 3) {
      errors.push({
        fieldPath: 'steps',
        message: 'Campaign must contain between 1 and 3 steps',
        resolutionOwner: 'BOUTIQUE_OWNER',
      });
      return { valid: errors.length === 0, errors, warnings };
    }

    const seenStepIds = new Set<string>();
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      if (!step.stepId || typeof step.stepId !== 'string' || !step.stepId.trim()) {
        errors.push({
          fieldPath: `steps[${i}].stepId`,
          message: 'stepId is required for every step',
          resolutionOwner: 'INTEGRATION_DEVELOPER',
        });
      } else if (seenStepIds.has(step.stepId)) {
        errors.push({
          fieldPath: `steps[${i}].stepId`,
          message: `Duplicate stepId '${step.stepId}' found across steps`,
          resolutionOwner: 'INTEGRATION_DEVELOPER',
        });
      } else {
        seenStepIds.add(step.stepId);
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  async checkStopAtDispatch(context: any): Promise<{ stop: boolean; reason?: string }> {
    const tenantId = context.execution.tenantId;
    const releaseId =
      context.enrollment?.releaseId ||
      (context.enrollment?.occurrenceId?.startsWith('collection:')
        ? context.enrollment.occurrenceId.split(':')[1]
        : null);

    // 1. Check collection status FIRST — COLLECTION_WITHDRAWN takes highest priority
    if (releaseId) {
      const collection = (await SrcCollectionModel.findOne({ tenantId, releaseId }).lean()) as any;
      if (!collection || collection.status === 'WITHDRAWN') {
        return { stop: true, reason: 'COLLECTION_WITHDRAWN' };
      }

      // 2. Recheck preference affinity if campaign defines a minAffinityScore > 0
      const minAffinityScore = (context.campaignVersion as any)?.minAffinityScore ?? 0.0;
      if (minAffinityScore > 0.0 && context.customer?.preferences) {
        const normalized = normalizePreferences(context.customer.preferences);
        const affinity = scoreAffinityForCollection(normalized, collection.items as any, minAffinityScore);
        const eligibility = evaluateAffinityEligibility(affinity, minAffinityScore);
        if (!eligibility.eligible) {
          return { stop: true, reason: 'PREFERENCE_MISMATCH' };
        }
      }

      // 3. Recheck goal: if customer already bought an item from this collection, stop dispatch
      if (context.customer?.customerId) {
        const collectionProductIds = new Set(
          (collection.items || []).map((it: any) => it.productId)
        );
        const orders = await SrcOrderModel.find({
          tenantId,
          customerId: context.customer.customerId,
          status: 'COMPLETED',
          completedAt: { $gte: collection.publishedAt },
        }).lean();

        for (const ord of orders) {
          if (
            (ord as any).collectionRef === `collection:${releaseId}` ||
            (ord as any).collectionRef === releaseId
          ) {
            return { stop: true, reason: 'GOAL_REACHED' };
          }
          const boughtMatch = ((ord as any).lines || []).some((l: any) =>
            collectionProductIds.has(l.productId || l.itemRef)
          );
          if (boughtMatch) {
            return { stop: true, reason: 'GOAL_REACHED' };
          }
        }
      }
    }

    // 4. Standard event-delay dispatch recheck (opt-out, channel suppression, undeliverable, etc.)
    const res = await dispatchRecheck(
      context.execution,
      context.enrollment,
      context.customer,
      context.template
    );
    if (!res.proceed) {
      return { stop: true, reason: res.stopReason };
    }

    return { stop: false };
  }
}

export const matchingCollectionEvaluator = new MatchingCollectionEvaluator();
registerPresetEvaluator(matchingCollectionEvaluator);

export const matchingCollectionAliasEvaluator = new MatchingCollectionEvaluator();
matchingCollectionAliasEvaluator.key = MATCHING_COLLECTION_ALIAS;
registerPresetEvaluator(matchingCollectionAliasEvaluator);

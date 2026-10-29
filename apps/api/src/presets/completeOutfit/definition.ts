import { CompleteOutfitPairingConfig } from '@grovastra/shared';

export const COMPLETE_THE_OUTFIT_ID = 'complete_the_outfit';
export const COMPLETE_THE_OUTFIT_ALIAS = 'outfit_completion';

export const DEFAULT_OUTFIT_PAIRING: CompleteOutfitPairingConfig = {
  anchorCategories: ['saree'],
  complementMap: {
    saree: ['blouse', 'petticoat', 'dupatta', 'accessories'],
    lehenga: ['dupatta', 'accessories'],
    kurta: ['dupatta', 'accessories'],
  },
  colourMatch: 'NEUTRAL_OR_SAME',
  requireSameWeave: false,
  budgetAware: false,
  alreadyOwnedLookbackDays: 180,
  suppressIfCategoryInOrder: true,
};

export const DEFAULT_OUTFIT_CONFIG = {
  name: 'Complete the Outfit Follow-up',
  industry: 'BOUTIQUE',
  purpose: 'MARKETING' as const,
  timezone: 'Asia/Kolkata',
  trigger: {
    type: 'ORDER_EVENT_DELAY' as const,
    anchor: 'ORDER_COMPLETED_AT' as const,
  },
  pairing: DEFAULT_OUTFIT_PAIRING,
  minDaysBetweenEnrollments: 30,
  goalMode: 'COMPLEMENT_OR_TAGGED' as const,
  audience: { mode: 'ALL_ELIGIBLE' as const },
  goal: { type: 'COMPLEMENT_OR_TAGGED' as const },
  steps: [
    {
      stepId: 'step_1',
      stepName: 'Outfit Suggestions',
      delay: { unit: 'DAYS' as const, value: 5 },
      outsideHoursPolicy: 'DEFER_NEXT_DAY' as const,
      maxDeferralHours: 24,
      maxLatenessMinutes: 1440,
      stopOnReply: true,
      stopOnGoal: true,
      prerequisite: 'NONE' as const,
      templateRef: {
        id: 'tpl_outfit_complete_one',
        language: 'en',
        revision: 1,
      },
      bindings: {
        '1': { source: 'customer.firstName' },
        '2': { source: 'shop.displayName' },
        '3': { source: 'anchor.itemName' },
        '4': { source: 'complement.1.name' },
      },
    },
  ],
  priority: 35,
  resumePolicy: 'FUTURE_ONLY' as const,
  importPolicy: 'FUTURE_ONLY' as const,
};

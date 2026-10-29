export const SELECTED_STOCK_PROMOTION_ID = 'selected_stock_promotion';
export const SELECTED_STOCK_PROMOTION_ALIAS = 'SELECTED_STOCK_PROMOTION';

export const DEFAULT_SELECTED_STOCK_PROMOTION_CONFIG = {
  name: 'Selected-stock Promotion',
  industry: 'BOUTIQUE',
  purpose: 'MARKETING' as const,
  timezone: 'Asia/Kolkata',
  trigger: {
    type: 'OFFER_PUBLICATION' as const,
    anchor: 'OFFER_ACTIVE_FROM' as const,
  },
  audience: { mode: 'PREFERENCE_MATCH' as const },
  matchMode: 'STRICT' as const,
  maxItemsInMessage: 3,
  maxRecipientsPerOffer: 1000,
  offerTags: [],
  goalMode: 'OFFER_ITEM_OR_TAGGED' as const,
  steps: [
    {
      stepId: 'step_1',
      stepName: 'Offer announcement',
      delay: { unit: 'HOURS' as const, value: 1 },
      outsideHoursPolicy: 'DEFER_NEXT_DAY' as const,
      maxDeferralHours: 24,
      maxLatenessMinutes: 720,
      prerequisite: 'NONE' as const,
      templateRef: { id: 'tpl_stock_offer_items', language: 'en', revision: 1 },
      bindings: {},
      stopOnReply: true,
      stopOnGoal: true,
    },
    {
      stepId: 'step_2',
      stepName: 'Offer follow-up',
      delay: { unit: 'DAYS' as const, value: 3 },
      outsideHoursPolicy: 'DEFER_NEXT_DAY' as const,
      maxDeferralHours: 24,
      maxLatenessMinutes: 720,
      prerequisite: 'NONE' as const,
      templateRef: { id: 'tpl_stock_offer_followup', language: 'en', revision: 1 },
      bindings: {},
      stopOnReply: true,
      stopOnGoal: true,
    },
  ],
  priority: 45,
  resumePolicy: 'FUTURE_ONLY' as const,
  importPolicy: 'FUTURE_ONLY' as const,
};

export const SELECTED_STOCK_PROMOTION_DEFINITION = {
  id: SELECTED_STOCK_PROMOTION_ID,
  name: 'Selected-stock Promotion',
  description: 'Owner-published offer matched to suitable customers and in-stock items.',
  triggerFamily: 'OFFER_PUBLICATION' as const,
  implemented: true,
  category: 'MARKETING' as const,
  defaults: DEFAULT_SELECTED_STOCK_PROMOTION_CONFIG,
};

export const FESTIVAL_COLLECTION_ID = 'festival_collection';
export const FESTIVAL_COLLECTION_ALIAS = 'FESTIVAL_COLLECTION';

export const DEFAULT_FESTIVAL_COLLECTION_CONFIG = {
  name: 'Festival Collection Launch',
  industry: 'BOUTIQUE',
  purpose: 'MARKETING',
  timezone: 'Asia/Kolkata',
  trigger: {
    type: 'OWNER_DATED_EVENT',
    anchor: 'FESTIVAL_DATE',
  },
  audience: {
    mode: 'ALL_ELIGIBLE',
  },
  goal: {
    type: 'COLLECTION_ITEM_OR_TAGGED',
  },
  matchMode: 'STRICT',
  maxItemsInMessage: 3,
  steps: [
    {
      stepId: 'step_launch',
      stepName: 'Festival Collection Launch',
      offsetDays: -21,
      localTime: '10:00',
      outsideHoursPolicy: 'DEFER_NEXT_DAY',
      maxDeferralHours: 24,
      maxLatenessMinutes: 720,
      stopOnReply: true,
      stopOnGoal: true,
      prerequisite: 'NONE',
      templateRef: {
        id: 'tpl_collection_new_items',
        revision: 1,
        language: 'en',
      },
      bindings: {
        '1': { source: 'customer.firstName' },
        '2': { source: 'shop.displayName' },
        '3': { source: 'festival.name', fallbackLiteral: 'Festival Edit' },
        '4': { source: 'match.itemList', fallbackLiteral: 'our festive handloom sarees' },
      },
    },
    {
      stepId: 'step_followup',
      stepName: 'Festival Preparation Follow-up',
      offsetDays: -7,
      localTime: '10:00',
      outsideHoursPolicy: 'DEFER_NEXT_DAY',
      maxDeferralHours: 24,
      maxLatenessMinutes: 720,
      stopOnReply: true,
      stopOnGoal: true,
      prerequisite: 'PREVIOUS_ACCEPTED',
      templateRef: {
        id: 'tpl_collection_followup',
        revision: 1,
        language: 'en',
      },
      bindings: {
        '1': { source: 'customer.firstName' },
        '2': { source: 'shop.displayName' },
        '3': { source: 'festival.name', fallbackLiteral: 'Festival Edit' },
        '4': { source: 'match.itemList', fallbackLiteral: 'festive handloom pieces' },
      },
    },
  ],
  priority: 50,
  resumePolicy: 'FUTURE_ONLY',
  importPolicy: 'FUTURE_ONLY',
};

export const FESTIVAL_COLLECTION_DEFINITION = {
  id: FESTIVAL_COLLECTION_ID,
  name: 'Festival Collection',
  description: 'Owner-approved dated event. Seasonal shopping and store visits.',
  triggerFamily: 'OWNER_DATED_EVENT',
  implemented: true,
  category: 'MARKETING',
  defaults: DEFAULT_FESTIVAL_COLLECTION_CONFIG,
};

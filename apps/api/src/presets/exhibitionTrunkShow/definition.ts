export const EXHIBITION_TRUNK_SHOW_ID = 'exhibition_trunk_show';
export const EXHIBITION_TRUNK_SHOW_ALIASES = [
  'EXHIBITION_TRUNK_SHOW',
  'exhibition_trunk_show',
  'exhibition',
  'trunk_show',
  'store_event',
] as const;

export const DEFAULT_EXHIBITION_TRUNK_SHOW_CONFIG = {
  name: 'Exhibition / Trunk Show',
  industry: 'BOUTIQUE',
  purpose: 'MARKETING',
  timezone: 'Asia/Kolkata',
  trigger: {
    type: 'OWNER_DATED_EVENT',
    anchor: 'EVENT_START_DATE',
  },
  audience: {
    mode: 'ALL_ELIGIBLE',
  },
  goal: {
    type: 'STORE_EVENT_VISIT_OR_PURCHASE',
  },
  matchMode: 'STRICT',
  steps: [
    {
      stepId: 'step_invite',
      stepName: 'Exhibition Invitation',
      offsetDays: -14,
      localTime: '10:00',
      outsideHoursPolicy: 'DEFER_NEXT_DAY',
      maxDeferralHours: 24,
      maxLatenessMinutes: 720,
      stopOnReply: true,
      stopOnGoal: true,
      prerequisite: 'NONE',
      templateRef: {
        id: 'tpl_exhibition_invite',
        revision: 1,
        language: 'en',
      },
      bindings: {
        '1': { source: 'customer.firstName' },
        '2': { source: 'shop.displayName' },
        '3': { source: 'event.name', fallbackLiteral: 'Exclusive Boutique Showcase' },
        '4': { source: 'event.date', fallbackLiteral: 'Upcoming' },
        '5': { source: 'event.venue', fallbackLiteral: 'Our Main Boutique' },
        '6': { source: 'event.rsvpLink', fallbackLiteral: '' },
      },
    },
    {
      stepId: 'step_reminder',
      stepName: 'Exhibition Reminder',
      offsetDays: -3,
      localTime: '10:00',
      outsideHoursPolicy: 'DEFER_NEXT_DAY',
      maxDeferralHours: 24,
      maxLatenessMinutes: 720,
      stopOnReply: true,
      stopOnGoal: true,
      prerequisite: 'PREVIOUS_ACCEPTED',
      templateRef: {
        id: 'tpl_exhibition_reminder',
        revision: 1,
        language: 'en',
      },
      bindings: {
        '1': { source: 'customer.firstName' },
        '2': { source: 'shop.displayName' },
        '3': { source: 'event.name', fallbackLiteral: 'Exclusive Boutique Showcase' },
        '4': { source: 'event.date', fallbackLiteral: 'Upcoming' },
        '5': { source: 'event.venue', fallbackLiteral: 'Our Main Boutique' },
      },
    },
  ],
  priority: 45,
  resumePolicy: 'FUTURE_ONLY',
  importPolicy: 'FUTURE_ONLY',
};

export const EXHIBITION_TRUNK_SHOW_DEFINITION = {
  id: EXHIBITION_TRUNK_SHOW_ID,
  name: 'Exhibition / Trunk Show',
  description: 'Owner-approved dated event. Trunk shows, pop-ups, and boutique exhibitions.',
  triggerFamily: 'OWNER_DATED_EVENT',
  implemented: true,
  category: 'MARKETING',
  defaults: DEFAULT_EXHIBITION_TRUNK_SHOW_CONFIG,
};

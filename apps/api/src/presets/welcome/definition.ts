import { CampaignPreset } from '@grovastra/shared';

export const WELCOME_NEW_CUSTOMER_ID = 'WELCOME_NEW_CUSTOMER';
export const WELCOME_NEW_CUSTOMER_ALIAS = 'welcome_new_customer';

export const WELCOME_NEW_CUSTOMER_DEFINITION: CampaignPreset = {
  id: WELCOME_NEW_CUSTOMER_ID,
  name: 'Welcome New Customer',
  description: 'First qualifying store order check-in. Send warm welcome WhatsApp message after 1 hour.',
  triggerFamily: 'EVENT_DELAY',
  implemented: true,
  category: 'MARKETING',
  defaults: {
    name: 'New Customer Welcome',
    industry: 'BOUTIQUE',
    purpose: 'MARKETING',
    timezone: 'Asia/Kolkata',
    schemaVersion: 2,
    scope: 'PER_CUSTOMER',
    minFirstOrderNetPaise: 0,
    trigger: {
      type: 'EVENT_DELAY',
      anchor: 'FIRST_QUALIFYING_ORDER',
    } as any,
    audience: { mode: 'ALL_ELIGIBLE' },
    goal: { type: 'OCCASION_TAGGED_OR_STAFF_COMPLETED' },
    steps: [
      {
        stepId: 'welcome_step_1',
        stepName: 'First Order Welcome',
        delay: { unit: 'HOURS', value: 1 },
        outsideHoursPolicy: 'DEFER_NEXT_DAY',
        maxDeferralHours: 24,
        maxLatenessMinutes: 180,
        prerequisite: 'NONE',
        templateRef: {
          id: 'tpl_welcome_new_customer',
          revision: 1,
          language: 'en',
        },
        bindings: {
          '1': { source: 'customer.firstName' },
          '2': { source: 'shop.displayName' },
        },
        stopOnReply: true,
        stopOnGoal: false,
      } as any,
    ],
    priority: 45,
    resumePolicy: 'FUTURE_ONLY',
    importPolicy: 'FUTURE_ONLY',
  },
};

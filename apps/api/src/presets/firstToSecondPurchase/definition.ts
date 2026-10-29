import { CampaignPreset } from '@grovastra/shared';

export const FIRST_TO_SECOND_PURCHASE_ID = 'FIRST_TO_SECOND_PURCHASE';
export const FIRST_TO_SECOND_PURCHASE_ALIAS = 'first_to_second_purchase';

export const FIRST_TO_SECOND_PURCHASE_DEFINITION: CampaignPreset = {
  id: FIRST_TO_SECOND_PURCHASE_ID,
  name: 'First to Second Purchase',
  description: 'Encourage a useful repeat visit after the first qualifying order.',
  triggerFamily: 'EVENT_DELAY',
  implemented: true,
  category: 'MARKETING',
  defaults: {
    name: 'First-to-Second Purchase Bring Back',
    industry: 'BOUTIQUE',
    purpose: 'MARKETING',
    timezone: 'Asia/Kolkata',
    trigger: {
      type: 'EVENT_DELAY',
      anchor: 'FIRST_QUALIFYING_ORDER',
    } as any,
    audience: { mode: 'ALL_ELIGIBLE' },
    goal: { type: 'OCCASION_TAGGED_OR_STAFF_COMPLETED' },
    steps: [
      {
        stepId: 'bring_back_step_1',
        stepName: 'Bring Back Reminder',
        delay: { unit: 'DAYS', value: 30 },
        outsideHoursPolicy: 'DEFER_NEXT_DAY',
        maxDeferralHours: 48,
        maxLatenessMinutes: 1440,
        prerequisite: 'NONE',
        templateRef: {
          id: 'tpl_repeat_visit_invite',
          name: 'repeat_visit_invite',
          language: 'en',
          revision: 1,
        },
        bindings: {
          '1': { source: 'customer.firstName' },
          '2': { source: 'shop.displayName' },
          '3': { source: 'order.firstOrderDate' },
        },
        stopOnReply: true,
        stopOnGoal: true,
      } as any,
    ],
    priority: 40,
    resumePolicy: 'FUTURE_ONLY',
    importPolicy: 'FUTURE_ONLY',
  },
};

import { CampaignPreset } from '@grovastra/shared';

export const OUTFIT_COLLECTION_DELIVERY_ID = 'outfit_collection_delivery';

export const OUTFIT_COLLECTION_DELIVERY_ALIASES = [
  'OUTFIT_COLLECTION_DELIVERY',
  'outfit_fulfilment',
  'fulfilment_milestone',
] as const;

export const OUTFIT_COLLECTION_DELIVERY_CONFIG = {
  defaultPriority: 60,
  defaultUncollectedReminderDays: 3,
  defaultUsefulForDays: 14,
  maxLatenessMinutesReady: 360,
  maxLatenessMinutesShipment: 240,
  maxDeferralHours: 16,
} as const;

export const OUTFIT_COLLECTION_DELIVERY_DEFINITION: CampaignPreset & { defaultSteps?: any[] } = {
  id: OUTFIT_COLLECTION_DELIVERY_ID,
  name: 'Outfit Collection / Delivery',
  description:
    'Actual fulfillment milestone. Keep customers notified when orders are ready for pickup or dispatched/delivered via courier.',
  triggerFamily: 'PRODUCTION_MILESTONE',
  implemented: true,
  category: 'SERVICE',
  get defaultSteps() {
    return this.defaults?.steps;
  },
  defaults: {
    name: 'Outfit Collection / Delivery',
    industry: 'BOUTIQUE',
    purpose: 'SERVICE' as any,
    timezone: 'Asia/Kolkata',
    schemaVersion: 2,
    scope: 'PER_CUSTOMER',
    trigger: {
      type: 'FULFILMENT_MILESTONE' as any,
      anchor: 'FULFILMENT_READY_AT',
    } as any,
    audience: { mode: 'ALL_ELIGIBLE' },
    goal: { type: 'OCCASION_TAGGED_OR_STAFF_COMPLETED' as any },
    steps: [
      {
        stepId: 'ready_notice',
        stepName: 'Ready for Collection Notice',
        offsetDays: 0,
        localTime: '10:00',
        templateRef: {
          id: 'tpl_fulfil_ready',
          revision: 1,
          language: 'en',
        },
        bindings: {
          '1': { source: 'customer.firstName' },
          '2': { source: 'order.number' },
          '3': { source: 'shop.displayName' },
        } as any,
        stopOnReply: false,
        stopOnGoal: true,
        maxLatenessMinutes: 360,
      } as any,
      {
        stepId: 'uncollected_reminder',
        stepName: 'Uncollected Reminder (3 Days)',
        offsetDays: 3,
        localTime: '10:00',
        templateRef: {
          id: 'tpl_fulfil_reminder',
          revision: 1,
          language: 'en',
        },
        bindings: {
          '1': { source: 'customer.firstName' },
          '2': { source: 'order.number' },
          '3': { source: 'shop.displayName' },
        } as any,
        stopOnReply: true,
        stopOnGoal: true,
        maxLatenessMinutes: 360,
      } as any,
    ],
    priority: 60,
    resumePolicy: 'FUTURE_ONLY',
    importPolicy: 'FUTURE_ONLY',
  },
};

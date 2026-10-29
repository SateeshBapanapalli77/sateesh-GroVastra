/**
 * Requested Item Available Preset — F25
 *
 * Fires when an item a customer previously requested (via request.saved) comes back
 * into stock (stock.published with sellableQtyAfter > 0). Also stops the campaign if
 * the customer purchases the requested item (order.completed with requestRef or matching
 * itemRef in order lines).
 *
 * Trigger family: STOCK_EVENT (custom — maps to REQUEST_STOCK_AVAILABLE)
 * Goal: Customer purchases the requested item.
 * Stop conditions: goal reached, request fulfilled, request cancelled.
 */

export const REQUESTED_ITEM_AVAILABLE_ID = 'requested_item_available';
export const REQUESTED_ITEM_AVAILABLE_ALIAS = 'request_stock_available';

export const DEFAULT_REQUESTED_ITEM_AVAILABLE_CONFIG = {
  name: 'Requested Item Available',
  industry: 'BOUTIQUE',
  purpose: 'MARKETING' as const,
  timezone: 'Asia/Kolkata',
  enabledBranches: ['branch_main', 'branch_two'],
  trigger: {
    type: 'REQUEST_STOCK_AVAILABLE' as const,
    anchor: 'STOCK_PUBLISHED_AT' as const,
  },
  // How long a request remains eligible for dispatch after stock arrives (days)
  stockAvailabilityWindowDays: 14,
  // Goal: customer buys the requested item
  goalMode: 'ITEM_OR_TAGGED' as const,
  audience: { mode: 'ALL_ELIGIBLE' as const },
  steps: [
    {
      stepId: 'step_1',
      stepName: 'Item Back In Stock',
      // Immediate-ish dispatch: 1 hour after stock.published
      delay: { unit: 'HOURS' as const, value: 1 },
      outsideHoursPolicy: 'DEFER_NEXT_DAY' as const,
      maxDeferralHours: 24,
      maxLatenessMinutes: 1440,
      stopOnReply: true,
      stopOnGoal: true,
      prerequisite: 'NONE' as const,
      templateRef: {
        id: 'tpl_request_available_one',
        language: 'en',
        revision: 1,
      },
      bindings: {
        '1': { source: 'customer.firstName' },
        '2': { source: 'shop.displayName' },
        '3': { source: 'request.1.nameWithVariant' },
      },
    },
  ],
  priority: 60,
  resumePolicy: 'FUTURE_ONLY' as const,
  importPolicy: 'FUTURE_ONLY' as const,
};

export const REQUESTED_ITEM_AVAILABLE_DEFINITION = {
  id: REQUESTED_ITEM_AVAILABLE_ID,
  name: 'Requested Item Available',
  description: 'Item requested by customer is back in stock. Real stock event trigger.',
  triggerFamily: 'STOCK_EVENT' as const,
  implemented: true,
  category: 'MARKETING' as const,
  defaults: DEFAULT_REQUESTED_ITEM_AVAILABLE_CONFIG,
};

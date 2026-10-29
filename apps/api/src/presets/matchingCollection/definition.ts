/**
 * Matching Collection Preset — F26
 *
 * Fires when an owner publishes a collection (collection.published event with
 * sellableQtyAfter > 0 for at least one item). The system fans out to ALL
 * eligible opted-in customers, filters by preference affinity score, and sends
 * ONE approved WhatsApp template per step.
 *
 * Stops on:
 *   - Customer reply (any reply → REPLY_HOLD)
 *   - Customer purchase of any item in the collection (order.completed goal match)
 *   - Customer opt-out / channel suppression
 *   - Collection withdrawn (collection.withdrawn event)
 *
 * Trigger family: COLLECTION_PUBLICATION
 * Goal: Customer purchases any item in the collection.
 * Enrollment key: collection:{releaseId}:{customerId}
 *   (One enrollment per customer per release. One release can have many campaigns.)
 */

export const MATCHING_COLLECTION_ID = 'matching_collection';
export const MATCHING_COLLECTION_ALIAS = 'MATCHING_COLLECTION';

/**
 * Minimum preference affinity score (0.0–1.0) required to include a customer
 * in the campaign fan-out.  Customers with score < this value are EXCLUDED with
 * reason NO_PREFERENCE_MATCH.  0.0 means no filtering (send to all opted-in).
 */
export const DEFAULT_MIN_AFFINITY_SCORE = 0.0;

/**
 * Default collection campaign configuration.
 * Template refs use the 3 real Meta test templates for this preset.
 */
export const DEFAULT_MATCHING_COLLECTION_CONFIG = {
  name: 'Matching Collection',
  industry: 'BOUTIQUE',
  purpose: 'MARKETING' as const,
  timezone: 'Asia/Kolkata',
  trigger: {
    type: 'COLLECTION_PUBLICATION' as const,
    anchor: 'COLLECTION_PUBLISHED_AT' as const,
  },
  /** Maximum days a collection enrollment can remain active without goal. */
  collectionUsefulForDays: 30,
  goalMode: 'ANY_COLLECTION_ITEM' as const,
  audience: { mode: 'ALL_ELIGIBLE' as const },
  steps: [
    {
      stepId: 'step_1',
      stepName: 'New Collection Announcement',
      delay: { unit: 'HOURS' as const, value: 2 },
      outsideHoursPolicy: 'DEFER_NEXT_DAY' as const,
      maxDeferralHours: 24,
      maxLatenessMinutes: 1440,
      stopOnReply: true,
      stopOnGoal: true,
      prerequisite: 'NONE' as const,
      templateRef: {
        id: 'tpl_collection_new_items',
        language: 'en',
        revision: 1,
      },
      bindings: {
        '1': { source: 'customer.firstName' },
        '2': { source: 'collection.title' },
        '3': { source: 'shop.displayName' },
      },
    },
    {
      stepId: 'step_2',
      stepName: 'Collection Follow-up',
      delay: { unit: 'DAYS' as const, value: 3 },
      outsideHoursPolicy: 'DEFER_NEXT_DAY' as const,
      maxDeferralHours: 24,
      maxLatenessMinutes: 1440,
      stopOnReply: true,
      stopOnGoal: true,
      prerequisite: 'NONE' as const,
      templateRef: {
        id: 'tpl_collection_followup',
        language: 'en',
        revision: 1,
      },
      bindings: {
        '1': { source: 'customer.firstName' },
        '2': { source: 'collection.title' },
        '3': { source: 'shop.displayName' },
      },
    },
  ],
  priority: 50,
  resumePolicy: 'FUTURE_ONLY' as const,
  importPolicy: 'FUTURE_ONLY' as const,
};

export const MATCHING_COLLECTION_DEFINITION = {
  id: MATCHING_COLLECTION_ID,
  name: 'Matching Collection',
  description: 'Published collection + preferences. Show relevant new arrivals.',
  triggerFamily: 'COLLECTION_PUBLICATION' as const,
  implemented: true,
  category: 'MARKETING' as const,
  defaults: DEFAULT_MATCHING_COLLECTION_CONFIG,
};

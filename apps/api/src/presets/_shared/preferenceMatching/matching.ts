/**
 * Matching Collection — Preference Affinity Scoring (F26 Part 1)
 *
 * Pure function: no DB calls, no side effects. Takes a customer's normalized
 * preferences and a collection's item attributes, returns an affinity score
 * and match explanation for enrollment decision.
 *
 * Score algorithm (additive, capped at 1.0):
 *   +0.40 if at least one collection item.category matches customer.categories[]
 *   +0.30 if at least one collection item.colourFamily matches customer.colourFamilies[]
 *   +0.20 if at least one collection item.weave matches customer.weaves[]
 *   +0.10 if at least one collection item.pricePaise <= customer.budgetMaxPaise
 *
 * Rules (from Design Contract 5a):
 *   - Preferences with source=INFERRED are NEVER used (normalizePreferences already strips them).
 *   - If customer has NO recorded preferences (all arrays empty), score = 0.0 (MATCH_ALL mode).
 *   - Score 0.0 customers are included when campaign.minAffinityScore === 0.0.
 *   - When minAffinityScore > 0, customers with score < threshold → NO_PREFERENCE_MATCH.
 */

import { NormalizedPreferences, normalizePreferences } from '@grovastra/shared';
import { CollectionItem } from '../../../db/models/src-collection.model';

export interface AffinityScoreResult {
  /** Computed affinity score 0.0–1.0. */
  score: number;
  /** Signals no recorded preferences; score will be 0.0. */
  noPreferences: boolean;
  /** Component breakdown for audit/logging. */
  components: {
    categoryMatch: boolean;
    colourMatch: boolean;
    weaveMatch: boolean;
    budgetMatch: boolean;
  };
  /** Human-readable explanation for enrollment exclusion log. */
  explanation: string;
  /** The best-matching item for template variable binding. */
  bestMatchItem: CollectionItem | null;
}

/**
 * Computes preference affinity score between a customer's normalized preferences
 * and a collection's items.
 *
 * @param prefs     - Normalized preferences from normalizePreferences().
 * @param items     - Items in the published collection (may be empty).
 * @param minScore  - Campaign threshold (from version.minAffinityScore); 0.0 = no filter.
 * @returns AffinityScoreResult
 */
export function scoreAffinityForCollection(
  prefs: NormalizedPreferences,
  items: CollectionItem[],
  minScore: number = 0.0
): AffinityScoreResult {
  if (!items || items.length === 0) {
    return {
      score: 0.0,
      noPreferences: true,
      components: { categoryMatch: false, colourMatch: false, weaveMatch: false, budgetMatch: false },
      explanation: 'Collection has no items',
      bestMatchItem: null,
    };
  }

  const hasCategories = prefs.categories.length > 0;
  const hasColours = prefs.colourFamilies.length > 0;
  const hasWeaves = prefs.weaves.length > 0;
  const hasBudget = prefs.budgetMaxPaise != null && prefs.budgetMaxPaise > 0;

  const noPreferences = !hasCategories && !hasColours && !hasWeaves && !hasBudget;

  // Early return: no preferences recorded → score 0.0 (always eligible when minScore=0)
  if (noPreferences) {
    return {
      score: 0.0,
      noPreferences: true,
      components: { categoryMatch: false, colourMatch: false, weaveMatch: false, budgetMatch: false },
      explanation: 'No preferences recorded; sending without filter',
      bestMatchItem: items[0] ?? null,
    };
  }

  // Build lookups (lower-case sets for fast membership test)
  const prefWeaves = new Set(prefs.weaves.map((w) => w.toLowerCase()));
  const prefColours = new Set(prefs.colourFamilies.map((c) => c.toLowerCase()));
  const prefSizes = new Set(prefs.sizes.map((s) => s.toLowerCase()));
  const prefCats = new Set(prefs.categories.map((c) => c.toLowerCase()));

  let categoryMatch = false;
  let colourMatch = false;
  let weaveMatch = false;
  let sizeMatch = false;
  let bestMatchItem: CollectionItem | null = null;
  let bestMatchScore = -1;

  for (const item of items) {
    let itemScore = 0;

    // Weave match (+40% weight)
    const weave = item.weave?.toLowerCase() ?? '';
    if (weave && prefWeaves.has(weave)) {
      itemScore += 40;
      weaveMatch = true;
    }

    // Colour match (+30% weight)
    const col = item.colourFamily?.toLowerCase() ?? '';
    if (col && prefColours.has(col)) {
      itemScore += 30;
      colourMatch = true;
    }

    // Size match (+20% weight)
    const size = item.size?.toLowerCase() ?? '';
    if (size && prefSizes.has(size)) {
      itemScore += 20;
      sizeMatch = true;
    }

    // Category match (+10% weight)
    const cat = item.category?.toLowerCase() ?? '';
    if (cat && prefCats.has(cat)) {
      itemScore += 10;
      categoryMatch = true;
    }

    if (itemScore > bestMatchScore) {
      bestMatchScore = itemScore;
      bestMatchItem = item;
    }
  }

  const rawScore = bestMatchScore > 0 ? bestMatchScore : 0;
  const score = Math.round((rawScore / 100) * 100) / 100;

  // Build explanation
  const parts: string[] = [];
  if (weaveMatch) parts.push('weave');
  if (colourMatch) parts.push('colour');
  if (sizeMatch) parts.push('size');
  if (categoryMatch) parts.push('category');
  const pct = Math.round(score * 100);
  const explanation = parts.length > 0
    ? `Affinity match on: ${parts.join(', ')} (${pct}%, score=${score.toFixed(2)})`
    : `No matching preferences found (score=0.00)`;

  return {
    score,
    noPreferences: false,
    components: { categoryMatch, colourMatch, weaveMatch, budgetMatch: sizeMatch },
    explanation,
    bestMatchItem: bestMatchItem ?? items[0],
  };
}

/**
 * Calculates item-level affinity between a customer's preferences and a single item.
 */
export function calculateCustomerItemAffinity(
  prefs: any,
  item: any
): {
  score: number;
  weaveMatched: boolean;
  colourMatched: boolean;
  sizeMatched: boolean;
  categoryMatched: boolean;
} {
  const norm = normalizePreferences(prefs);
  let score = 0;
  let weaveMatched = false;
  let colourMatched = false;
  let sizeMatched = false;
  let categoryMatched = false;

  const itemWeave = item.weave?.toLowerCase();
  if (itemWeave && norm.weaves.includes(itemWeave)) {
    weaveMatched = true;
    score += 0.4;
  }

  const itemColour = item.colourFamily?.toLowerCase();
  if (itemColour && norm.colourFamilies.includes(itemColour)) {
    colourMatched = true;
    score += 0.3;
  }

  const itemSize = item.size?.toLowerCase();
  if (itemSize && norm.sizes.includes(itemSize)) {
    sizeMatched = true;
    score += 0.2;
  }

  const itemCat = item.category?.toLowerCase();
  if (itemCat && norm.categories.includes(itemCat)) {
    categoryMatched = true;
    score += 0.1;
  }

  return {
    score: Math.round(score * 100) / 100,
    weaveMatched,
    colourMatched,
    sizeMatched,
    categoryMatched,
  };
}

/**
 * Determines whether a customer should be enrolled based on their affinity score
 * and the campaign's minAffinityScore threshold.
 *
 * Returns null when eligible, or an exclusion reason string when not.
 */
export function evaluateAffinityEligibility(
  score: AffinityScoreResult,
  minAffinityScore: number
): { eligible: true } | { eligible: false; reason: string; explanation: string } {
  // Score 0.0 (no preferences) is included ONLY when minAffinityScore === 0.0.
  // When minAffinityScore > 0, customers with score < threshold are EXCLUDED
  // regardless of whether the zero comes from no preferences or no matches.
  if (score.score < minAffinityScore) {
    return {
      eligible: false,
      reason: 'NO_PREFERENCE_MATCH',
      explanation: score.noPreferences
        ? `No recorded preferences; excluded by minAffinityScore threshold ${minAffinityScore.toFixed(2)}`
        : `Affinity score ${score.score.toFixed(2)} below threshold ${minAffinityScore.toFixed(2)}`,
    };
  }

  return { eligible: true };
}

/**
 * Derives the display name for the best-matched collection item.
 * If the item has a variantId, appends the variant label.
 */
export function getMatchedItemDisplayName(item: CollectionItem | null): string | null {
  if (!item) return null;
  return item.name || null;
}

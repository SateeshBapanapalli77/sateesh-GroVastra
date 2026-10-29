import { scoreAffinityForCollection } from '../_shared/preferenceMatching/matching';
import { CollectionItem } from '../../db/models/src-collection.model';

export interface FestivalCustomerPreferenceProfile {
  customerId: string;
  firstName?: string | null;
  preferences?: {
    weaves?: string[];
    budgetMaxPaise?: number;
    size?: string;
    colours?: string[];
    source?: string;
  } | null;
}

export interface FestivalMatchItem {
  productId: string;
  variantId?: string | null;
  name: string;
  pricePaise: number;
  category?: string | null;
  colourFamily?: string | null;
  weave?: string | null;
  size?: string | null;
  matchScore: number;
  reason?: string;
}

export interface FestivalMatchResult {
  matched: boolean;
  score: number;
  items: FestivalMatchItem[];
  matchReasons: string[];
  excluded: Array<{ productId: string; reason: string }>;
}

export interface FestivalMatchOptions {
  mode?: 'STRICT' | 'LENIENT';
  audienceMode?: 'PREFERENCE_MATCH' | 'ALL_ELIGIBLE';
  maxItems?: number;
}

/**
 * Pure preference matcher for Festival Collection (F28).
 *
 * HARD RULE 8: Never infer religion, relationships, birthdays or partner contacts.
 * Never inspect customer names or guess cultural background from names.
 * Operates purely on declared/recorded customer preferences and catalog metadata.
 */
export function matchFestivalCollection(
  customer: FestivalCustomerPreferenceProfile,
  collectionItems: CollectionItem[],
  options: FestivalMatchOptions = {}
): FestivalMatchResult {
  const mode = options.mode || 'STRICT';
  const audienceMode = options.audienceMode || 'PREFERENCE_MATCH';
  const maxItems = Math.max(1, options.maxItems ?? 3);

  // Safety check: ignore inferred preferences
  const prefs = customer.preferences?.source === 'INFERRED' ? null : customer.preferences;

  const excluded: Array<{ productId: string; reason: string }> = [];
  const candidateItems: FestivalMatchItem[] = [];
  const matchReasons: string[] = [];

  // Filter out inactive or unsellable items
  const validItems = (collectionItems || []).filter((item) => {
    if (!item.productId) return false;
    if (typeof item.sellableQtyAfter === 'number' && item.sellableQtyAfter <= 0) {
      excluded.push({ productId: item.productId, reason: 'ITEM_UNAVAILABLE' });
      return false;
    }
    return true;
  });

  if (validItems.length === 0) {
    return {
      matched: false,
      score: 0,
      items: [],
      matchReasons: ['No sellable stock in festival collection'],
      excluded,
    };
  }

  // Evaluate each item against customer preferences
  for (const item of validItems) {
    const itemPrice = item.pricePaise ?? 0;

    // 1. Budget check
    if (prefs?.budgetMaxPaise && itemPrice > prefs.budgetMaxPaise) {
      excluded.push({ productId: item.productId, reason: 'BUDGET_EXCEEDED' });
      continue;
    }

    // 2. Size check
    if (prefs?.size && item.size && prefs.size.toLowerCase() !== item.size.toLowerCase()) {
      excluded.push({ productId: item.productId, reason: 'SIZE_MISMATCH' });
      continue;
    }

    // Compute preference score (weave, colour, budget)
    let score = 0;
    const reasons: string[] = [];

    // Extract normalized weaves and colours (accepts arrays or single values)
    const customerWeaves = Array.isArray(prefs?.weaves)
      ? prefs.weaves
      : (prefs as any)?.weave
      ? [(prefs as any).weave]
      : [];
    const customerColours = Array.isArray(prefs?.colours)
      ? prefs.colours
      : (prefs as any)?.colour
      ? [(prefs as any).colour]
      : [];

    // Weave affinity (40% weight)
    if (customerWeaves.length > 0 && item.weave) {
      const weaveMatch = customerWeaves.some(
        (w: string) => w.toLowerCase() === item.weave?.toLowerCase()
      );
      if (weaveMatch) {
        score += 40;
        reasons.push(`matches weave preference (${item.weave})`);
      }
    }

    // Colour affinity (30% weight)
    if (customerColours.length > 0 && item.colourFamily) {
      const colourMatch = customerColours.some(
        (c: string) => c.toLowerCase() === item.colourFamily?.toLowerCase()
      );
      if (colourMatch) {
        score += 30;
        reasons.push(`matches colour preference (${item.colourFamily})`);
      }
    }

    // Budget fit (30% weight)
    if (prefs?.budgetMaxPaise && itemPrice <= prefs.budgetMaxPaise) {
      score += 30;
      reasons.push(`within budget (₹${(itemPrice / 100).toFixed(0)} ≤ ₹${(prefs.budgetMaxPaise / 100).toFixed(0)})`);
    }

    // In STRICT mode, if preferences exist but score is 0, exclude
    if (mode === 'STRICT' && prefs && (customerWeaves.length || customerColours.length) && score === 0) {
      excluded.push({ productId: item.productId, reason: 'NO_PREFERENCE_MATCH' });
      continue;
    }

    candidateItems.push({
      productId: item.productId,
      variantId: item.variantId,
      name: item.name,
      pricePaise: itemPrice,
      category: item.category,
      colourFamily: item.colourFamily,
      weave: item.weave,
      size: item.size,
      matchScore: score,
      reason: reasons.join(', ') || 'Featured festival item',
    });
  }

  // If no candidates matched
  if (candidateItems.length === 0) {
    if (audienceMode === 'ALL_ELIGIBLE' && validItems.length > 0) {
      // In ALL_ELIGIBLE mode, fall back to top sellable items
      const fallback = validItems.slice(0, maxItems).map((item) => ({
        productId: item.productId,
        variantId: item.variantId,
        name: item.name,
        pricePaise: item.pricePaise ?? 0,
        category: item.category,
        colourFamily: item.colourFamily,
        weave: item.weave,
        size: item.size,
        matchScore: 10,
        reason: 'Selected for festival season collection',
      }));
      return {
        matched: true,
        score: 0.1,
        items: fallback,
        matchReasons: ['All eligible audience: included with collection stock'],
        excluded,
      };
    }

    return {
      matched: false,
      score: 0,
      items: [],
      matchReasons: ['No festival items matched customer preferences'],
      excluded,
    };
  }

  // Sort candidate items by matchScore descending, then pricePaise descending, then productId ascending
  candidateItems.sort((a, b) => {
    if (b.matchScore !== a.matchScore) return b.matchScore - a.matchScore;
    if (b.pricePaise !== a.pricePaise) return b.pricePaise - a.pricePaise;
    return a.productId.localeCompare(b.productId);
  });

  const selected = candidateItems.slice(0, maxItems);
  const avgScore = selected.reduce((sum, i) => sum + i.matchScore, 0) / (selected.length * 100);

  return {
    matched: true,
    score: avgScore,
    items: selected,
    matchReasons: selected.map((i) => `${i.name}: ${i.reason}`),
    excluded,
  };
}

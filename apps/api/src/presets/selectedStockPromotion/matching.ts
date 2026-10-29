import { computeOfferPrice, formatPaiseInr, SelectedStockDiscount } from '@grovastra/shared';
import { calculateCustomerItemAffinity } from '../_shared/preferenceMatching/matching';

export type StockMatchMode = 'STRICT' | 'BROAD';
export type StockAudienceMode = 'PREFERENCE_MATCH' | 'ALL_ELIGIBLE';

export interface StockCustomer {
  customerId: string;
  preferences?: {
    source?: string;
    weaves?: string[];
    weave?: string;
    colourFamilies?: string[];
    colour?: string;
    categories?: string[];
    budgetMaxPaise?: number;
    sizes?: string[];
    size?: string;
  } | null;
}

export interface StockProduct {
  productId: string;
  name: string;
  category?: string | null;
  colourFamily?: string | null;
  weave?: string | null;
  pricePaise?: number;
  status: string;
  entityVersion: number;
  variants?: Array<{ variantId: string; sellableQty: number; attributes?: { size?: string; colourFamily?: string } }>;
}

export interface StockOffer {
  items: Array<{ productId: string; variantIds?: string[] | null; offerPricePaise?: number | null; position: number }>;
  discount: { type: 'PERCENT_OFF' | 'FLAT_OFF' | 'SPECIAL_PRICE'; percent?: number; flatOffPaise?: number };
}

export interface StockMatch {
  matched: boolean;
  items: Array<{
    productId: string;
    variantId: string | null;
    name: string;
    regularPricePaise: number;
    offerPricePaise: number;
    entityVersion: number;
  }>;
  matchReasons: string[];
  excluded: Array<{ productId: string; reason: string }>;
}

function values(preferences: StockCustomer['preferences'], arrayKey: 'weaves' | 'colourFamilies' | 'categories', scalarKey: 'weave' | 'colour'): string[] {
  if (!preferences || preferences.source === 'INFERRED') return [];
  const arrayValues = preferences[arrayKey];
  const scalar = preferences[scalarKey];
  return [...(arrayValues || []), ...(scalar ? [scalar] : [])].map((value) => value.toLowerCase());
}

export function matchSelectedStock(
  customer: StockCustomer,
  products: StockProduct[],
  offer: StockOffer,
  options: { mode?: StockMatchMode; audienceMode?: StockAudienceMode; maxItems?: number } = {}
): StockMatch {
  const mode = options.mode || 'STRICT';
  const audienceMode = options.audienceMode || 'PREFERENCE_MATCH';
  const maxItems = Math.max(1, Math.min(3, options.maxItems || 3));
  const prefs = customer.preferences;
  const weaves = values(prefs, 'weaves', 'weave');
  const colours = values(prefs, 'colourFamilies', 'colour');
  const categories = values(prefs, 'categories', 'colour');
  const budget = prefs?.budgetMaxPaise;
  const sizes = [...(prefs?.sizes || []), ...(prefs?.size ? [prefs.size] : [])].map((v) => v.toLowerCase());
  const hasPreference = weaves.length + colours.length + categories.length + (budget ? 1 : 0) + sizes.length > 0;
  const excluded: Array<{ productId: string; reason: string }> = [];
  const candidates: Array<StockMatch['items'][number] & { score: number; position: number }> = [];

  for (const offerItem of [...offer.items].sort((a, b) => a.position - b.position || a.productId.localeCompare(b.productId))) {
    const product = products.find((candidate) => candidate.productId === offerItem.productId);
    if (!product || product.status !== 'ACTIVE') {
      excluded.push({ productId: offerItem.productId, reason: product ? 'ATTRIBUTE_UNKNOWN' : 'ITEM_UNAVAILABLE' });
      continue;
    }
    const regularPricePaise = product.pricePaise;
    if (typeof regularPricePaise !== 'number' || !Number.isInteger(regularPricePaise) || regularPricePaise <= 0) {
      excluded.push({ productId: offerItem.productId, reason: 'ATTRIBUTE_UNKNOWN' });
      continue;
    }
    const discount: SelectedStockDiscount =
      offer.discount.type === 'PERCENT_OFF'
        ? { type: 'PERCENT_OFF', percent: offer.discount.percent || 0 }
        : offer.discount.type === 'FLAT_OFF'
          ? { type: 'FLAT_OFF', flatOffPaise: offer.discount.flatOffPaise || 0 }
          : { type: 'SPECIAL_PRICE' };
    const offerPricePaise = computeOfferPrice(regularPricePaise, discount, offerItem);
    if (offerPricePaise === null) {
      excluded.push({ productId: product.productId, reason: 'OFFER_INVALID' });
      continue;
    }
    const variants = (product.variants || []).filter((variant) =>
      variant.sellableQty > 0 && (!offerItem.variantIds || offerItem.variantIds.includes(variant.variantId))
    );
    if (variants.length === 0) {
      excluded.push({ productId: product.productId, reason: 'ITEM_UNAVAILABLE' });
      continue;
    }
    const affinity = calculateCustomerItemAffinity(prefs, {
      category: product.category,
      weave: product.weave,
      colourFamily: product.colourFamily,
      size: variants[0]?.attributes?.size,
    });
    const categoryMatch = affinity.categoryMatched;
    const weaveMatch = affinity.weaveMatched;
    const colourMatch = affinity.colourMatched;
    const budgetMatch = budget === undefined || offerPricePaise <= budget;
    const sizeMatch = sizes.length === 0 || variants.some((variant) => !variant.attributes?.size || sizes.includes(variant.attributes.size.toLowerCase()));
    if (!budgetMatch) {
      excluded.push({ productId: product.productId, reason: 'EXCLUDED_BUDGET' });
      continue;
    }
    if (!sizeMatch) {
      excluded.push({ productId: product.productId, reason: 'EXCLUDED_SIZE' });
      continue;
    }
    if (audienceMode === 'PREFERENCE_MATCH' && (!hasPreference || mode === 'STRICT') && !(categoryMatch || weaveMatch || colourMatch)) {
      excluded.push({ productId: product.productId, reason: hasPreference ? 'NO_PREFERENCE_MATCH' : 'NO_PREFERENCES' });
      continue;
    }
    const score = (categoryMatch ? 3 : 0) + (weaveMatch ? 2 : 0) + (colourMatch ? 1 : 0);
    candidates.push({
      productId: product.productId,
      variantId: variants[0].variantId,
      name: product.name,
      regularPricePaise,
      offerPricePaise,
      entityVersion: product.entityVersion,
      score,
      position: offerItem.position,
    });
  }
  candidates.sort((a, b) => b.score - a.score || a.position - b.position || a.productId.localeCompare(b.productId));
  const items = candidates.slice(0, maxItems).map(({ score: _score, position: _position, ...item }) => item);
  return {
    matched: items.length > 0,
    items,
    matchReasons: items.length ? ['PREFERENCE_MATCH', ...(['STRICT', 'BROAD'].includes(mode) ? [mode] : [])] : [],
    excluded,
  };
}

export function describeStockMatch(match: StockMatch): string {
  return match.items.map((item) => `${item.name} (${formatPaiseInr(item.offerPricePaise)})`).join(', ');
}

import {
  SourceProduct,
  SourceOrder,
  OrderLine,
  ProductCategory,
  ColourFamily,
  Weave,
  ColourMatchMode,
  NEUTRAL_COLOUR_FAMILIES,
  CompleteOutfitPairingConfig,
} from '@grovastra/shared';

export interface ComplementCandidate {
  product: SourceProduct;
  selectedVariantId: string;
  score: number;
  colourNote: string;
  weaveNote: string;
}

export interface ExcludedCandidate {
  productId: string;
  reason: string;
}

export interface SelectedComplement {
  productId: string;
  variantId: string;
  name: string;
  category: ProductCategory;
}

export interface SelectComplementsOutput {
  anchor: {
    orderId: string;
    lineId: string;
    productId: string;
    name: string;
  };
  complements: SelectedComplement[];
  matchReasons: string[];
  excluded: ExcludedCandidate[];
  available: number;
  insufficient: boolean;
}

export interface MatchingCustomerInput {
  customerId: string;
  preferences?: {
    budgetMaxPaise?: number | null;
    weave?: string | null;
    colour?: string | null;
    size?: string | null;
  } | null;
}

export interface SelectComplementsParams {
  anchorOrder: SourceOrder;
  primaryAnchorLine: OrderLine;
  anchorProduct: SourceProduct;
  customer: MatchingCustomerInput;
  candidateProducts: SourceProduct[];
  productCategoryMap?: Record<string, ProductCategory> | Map<string, string>;
  orderHistory: SourceOrder[];
  pairing: CompleteOutfitPairingConfig;
  k: number;
  now?: Date;
}

/**
 * Pure, deterministic function to match and rank complements for an anchor purchase.
 *
 * HARD RULE: Uses ONLY product, order, and recorded-preference data.
 * NEVER reads customer name, gender, religion, or inferred personal traits.
 */
export function selectComplements(params: SelectComplementsParams): SelectComplementsOutput {
  const {
    anchorOrder,
    primaryAnchorLine,
    anchorProduct,
    customer,
    candidateProducts,
    productCategoryMap = {},
    orderHistory,
    pairing,
    k,
    now = new Date(),
  } = params;

  const anchorName = anchorProduct.name || primaryAnchorLine.name || 'Purchased Item';
  const anchorOutput = {
    orderId: anchorOrder.orderId,
    lineId: primaryAnchorLine.lineId,
    productId: anchorProduct.productId,
    name: anchorName,
  };

  const anchorCategory = anchorProduct.category;
  if (!anchorCategory) {
    return {
      anchor: anchorOutput,
      complements: [],
      matchReasons: [],
      excluded: [],
      available: 0,
      insufficient: true,
    };
  }

  const allowedComplementCategories = pairing.complementMap[anchorCategory] || [];
  const excluded: ExcludedCandidate[] = [];
  const eligibleCandidates: ComplementCandidate[] = [];

  // Determine lookback start for already owned items
  const lookbackDays = Math.max(0, pairing.alreadyOwnedLookbackDays ?? 180);
  const anchorCompletedTime = anchorOrder.completedAt ? new Date(anchorOrder.completedAt).getTime() : now.getTime();
  const lookbackStartMs = anchorCompletedTime - lookbackDays * 24 * 60 * 60 * 1000;

  // Build a set of productIds the customer already purchased within lookback window
  const alreadyPurchasedProductIds = new Set<string>();
  for (const ord of orderHistory) {
    if (!ord.completedAt) continue;
    const ordTime = new Date(ord.completedAt).getTime();
    if (ordTime < lookbackStartMs || ordTime > anchorCompletedTime) continue;
    // Qualifying order lines that are not fully returned
    for (const line of ord.lines || []) {
      const q = line.qty ?? line.quantity ?? 1;
      const ret = line.returnedQty ?? 0;
      if (ret < q && line.productId) {
        alreadyPurchasedProductIds.add(line.productId);
      }
    }
  }

  // Also include non-returned lines from this anchor order itself
  for (const line of anchorOrder.lines || []) {
    const q = line.qty ?? line.quantity ?? 1;
    const ret = line.returnedQty ?? 0;
    if (ret < q && line.productId) {
      alreadyPurchasedProductIds.add(line.productId);
    }
  }

  // Categories present in non-returned lines in this anchor order
  const categoriesInOrder = new Set<string>();
  const getProductCategory = (pid?: string): string | undefined => {
    if (!pid) return undefined;
    if (productCategoryMap instanceof Map) {
      return (productCategoryMap as Map<string, string>).get(pid);
    }
    return (productCategoryMap as Record<string, string>)[pid];
  };

  if (pairing.suppressIfCategoryInOrder) {
    for (const line of anchorOrder.lines || []) {
      const q = line.qty ?? line.quantity ?? 1;
      const ret = line.returnedQty ?? 0;
      if (ret < q && line.productId) {
        const cat = getProductCategory(line.productId);
        if (cat) {
          categoriesInOrder.add(cat.toLowerCase());
        }
      }
    }
  }

  const anchorColour = anchorProduct.colourFamily ? anchorProduct.colourFamily.toLowerCase() : null;
  const anchorWeave = anchorProduct.weave ? anchorProduct.weave.toLowerCase() : null;
  const colourMatchMode = pairing.colourMatch || 'NEUTRAL_OR_SAME';
  const requireSameWeave = !!pairing.requireSameWeave;
  const budgetAware = !!pairing.budgetAware;
  const budgetMaxPaise = customer.preferences?.budgetMaxPaise ?? null;

  for (const prod of candidateProducts) {
    // Never suggest the anchor product itself
    if (prod.productId === anchorProduct.productId) {
      continue;
    }

    // 1. Category check
    if (!prod.category) {
      excluded.push({ productId: prod.productId, reason: 'CATEGORY_UNKNOWN' });
      continue;
    }
    const prodCategory = prod.category.toLowerCase() as ProductCategory;
    if (!allowedComplementCategories.map((c) => c.toLowerCase()).includes(prodCategory)) {
      excluded.push({ productId: prod.productId, reason: 'CATEGORY_UNKNOWN' });
      continue;
    }

    // 2. Sellable check
    if (prod.status !== 'ACTIVE') {
      const reason = prod.status === 'DISCONTINUED' ? 'DISCONTINUED' : 'NOT_SELLABLE';
      excluded.push({ productId: prod.productId, reason });
      continue;
    }

    const sellableVariants = (prod.variants || []).filter(
      (v) => (v.sellableQty ?? 0) > 0
    );
    if (sellableVariants.length === 0) {
      excluded.push({ productId: prod.productId, reason: 'NOT_SELLABLE' });
      continue;
    }
    // Choose lowest variantId that is sellable
    sellableVariants.sort((a, b) => a.variantId.localeCompare(b.variantId));
    const selectedVariantId = sellableVariants[0].variantId;

    // 3. Category in order check
    if (pairing.suppressIfCategoryInOrder && categoriesInOrder.has(prodCategory)) {
      excluded.push({ productId: prod.productId, reason: 'CATEGORY_IN_ORDER' });
      continue;
    }

    // 4. Already purchased check
    if (alreadyPurchasedProductIds.has(prod.productId)) {
      excluded.push({ productId: prod.productId, reason: 'ALREADY_PURCHASED' });
      continue;
    }

    // 5. Budget check (only when budgetAware AND customer has a budget preference)
    if (budgetAware && budgetMaxPaise != null && budgetMaxPaise > 0) {
      const price = prod.pricePaise || 0;
      if (price > budgetMaxPaise) {
        excluded.push({ productId: prod.productId, reason: 'OVER_BUDGET' });
        continue;
      }
    }

    // 6. Weave check
    const prodWeave = prod.weave ? prod.weave.toLowerCase() : null;
    if (requireSameWeave) {
      if (!prodWeave || !anchorWeave || prodWeave !== anchorWeave) {
        excluded.push({ productId: prod.productId, reason: 'WEAVE_MISMATCH' });
        continue;
      }
    }

    // 7. Colour check
    const prodColour = prod.colourFamily ? prod.colourFamily.toLowerCase() : null;
    let colourScore = 0;
    let colourNote = '';

    if (colourMatchMode === 'ANY') {
      colourScore = 0;
      colourNote = 'complement suggestion';
    } else if (colourMatchMode === 'SAME_FAMILY') {
      if (!anchorColour || !prodColour) {
        // Passes with note COLOUR_UNKNOWN
        colourScore = 0;
        colourNote = 'colour compatibility unchecked';
      } else if (prodColour === anchorColour) {
        colourScore = 2;
        colourNote = `same ${prodColour} colour`;
      } else {
        excluded.push({ productId: prod.productId, reason: 'COLOUR_INCOMPATIBLE' });
        continue;
      }
    } else {
      // NEUTRAL_OR_SAME
      if (!anchorColour || !prodColour) {
        // Passes with note COLOUR_UNKNOWN
        colourScore = 0;
        colourNote = 'colour compatibility unchecked';
      } else if (prodColour === anchorColour) {
        colourScore = 2;
        colourNote = `same ${prodColour} colour`;
      } else if (NEUTRAL_COLOUR_FAMILIES.includes(prodColour as any)) {
        colourScore = 1;
        colourNote = `neutral ${prodColour} colour for ${anchorColour} ${anchorCategory}`;
      } else {
        excluded.push({ productId: prod.productId, reason: 'COLOUR_INCOMPATIBLE' });
        continue;
      }
    }

    // Weave score
    let weaveScore = 0;
    let weaveNote = '';
    if (anchorWeave && prodWeave && anchorWeave === prodWeave) {
      weaveScore = 1;
      weaveNote = `; matching ${prodWeave} weave`;
    }

    const totalScore = colourScore + weaveScore;
    eligibleCandidates.push({
      product: prod,
      selectedVariantId,
      score: totalScore,
      colourNote,
      weaveNote,
    });
  }

  const available = eligibleCandidates.length;


  // Sort candidates by score desc, pricePaise asc, productId asc
  eligibleCandidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const priceA = a.product.pricePaise || 0;
    const priceB = b.product.pricePaise || 0;
    if (priceA !== priceB) return priceA - priceB;
    return a.product.productId.localeCompare(b.product.productId);
  });

  // Selection algorithm:
  // 1. Take the best candidate of each complement category in configured priority order first
  const selectedList: ComplementCandidate[] = [];
  const selectedProductIds = new Set<string>();

  for (const cat of allowedComplementCategories) {
    if (selectedList.length >= k) break;
    const match = eligibleCandidates.find(
      (c) =>
        c.product.category?.toLowerCase() === cat.toLowerCase() &&
        !selectedProductIds.has(c.product.productId)
    );
    if (match) {
      selectedList.push(match);
      selectedProductIds.add(match.product.productId);
    }
  }

  // 2. Fill remaining slots by rank
  if (selectedList.length < k) {
    for (const c of eligibleCandidates) {
      if (selectedList.length >= k) break;
      if (!selectedProductIds.has(c.product.productId)) {
        selectedList.push(c);
        selectedProductIds.add(c.product.productId);
      }
    }
  }

  const complements: SelectedComplement[] = selectedList.map((c) => ({
    productId: c.product.productId,
    variantId: c.selectedVariantId,
    name: c.product.name,
    category: c.product.category as ProductCategory,
  }));

  const matchReasons = selectedList.map((c) => {
    const cat = c.product.category || 'item';
    const reasonParts = [`${cat} in stock`];
    if (c.colourNote) {
      reasonParts.push(c.colourNote);
    }
    const main = reasonParts.join('; ');
    return `${main}${c.weaveNote}`;
  });

  const insufficient = selectedList.length < k;

  return {
    anchor: anchorOutput,
    complements,
    matchReasons,
    excluded,
    available,
    insufficient,
  };
}

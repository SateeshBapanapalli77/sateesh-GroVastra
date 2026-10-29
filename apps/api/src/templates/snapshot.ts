import crypto from 'crypto';
import {
  SourceCustomer,
  SourceOffer,
  SourceOrder,
  SourceCredit,
  SourceTemplate,
} from '@grovastra/shared';
import { formatPaiseInr } from '@grovastra/shared';
import {
  BINDING_SOURCES,
  BindingResolutionContext,
  sanitizeRecipientLabel,
  formatDateOnly,
} from './bindingSources';
import {
  resolveTemplateParameters,
  TemplateResolutionResult,
  ResolvedParameterItem,
} from './resolveTemplateParameters';
import { mockCustomerSource } from '../adapters/customer-source';
import { mockOccasionSource, OccasionRecord } from '../adapters/occasion-source';
import { mockOrderSource } from '../adapters/order-source';
import { mockOfferSource } from '../adapters/OfferSource';
import { mockCreditSource } from '../adapters/CreditSource';
import { mockEnquirySource } from '../adapters/enquiry-source';
import { mockProductSource } from '../adapters/product-source';
import { campaignSettingsService } from '../services/campaign-settings.service';
import { TenantModel } from '../db/models/tenant.model';
import { clock as defaultClock } from '../services/clock';
import { selectComplements } from '../presets/completeOutfit/matching';
import { SrcCollectionModel } from '../db/models/src-collection.model';
import { matchSelectedStock } from '../presets/selectedStockPromotion/matching';

export interface CanonicalParameter {
  index: number;
  text: string;
}

/**
 * Produces an ordered list of [{ index, text }] sorted strictly by ascending index (1, 2, 3...).
 * Used identically for both the Meta provider message body and the immutable payload hash.
 */
export function canonicalizeParameters(
  parameters:
    | ResolvedParameterItem[]
    | Array<{ index?: number; name?: string; text: string | number }>
    | Record<string, string | number>
    | undefined
    | null
): CanonicalParameter[] {
  if (!parameters) return [];

  const items: CanonicalParameter[] = [];

  if (Array.isArray(parameters)) {
    for (const p of parameters) {
      if (typeof p.index === 'number') {
        items.push({ index: p.index, text: String(p.text ?? '') });
      }
    }
  } else if (typeof parameters === 'object') {
    for (const [key, val] of Object.entries(parameters)) {
      const idx = Number(key);
      if (Number.isInteger(idx) && idx > 0) {
        items.push({ index: idx, text: String(val ?? '') });
      }
    }
  }

  return items.sort((a, b) => a.index - b.index);
}

/**
 * Computes deterministic SHA-256 payload hash over canonical JSON of
 * { templateId, revision, language, parameters: canonicalizeParameters(...) }
 * with strictly stable key order.
 */
export function computePayloadHash(input: {
  templateId: string;
  revision: number;
  language: string;
  parameters:
    | ResolvedParameterItem[]
    | Array<{ index?: number; name?: string; text: string | number }>
    | Record<string, string | number>;
}): string {
  const canonical = {
    templateId: String(input.templateId),
    revision: Number(input.revision),
    language: String(input.language),
    parameters: canonicalizeParameters(input.parameters),
  };
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

export interface BuildSnapshotContext {
  tenantId: string;
  step?: {
    bindings?: any;
    offerRef?: any;
    creditRef?: any;
    templateRef?: any;
  } | null;
  bindings?: any;
  customerId?: string | null;
  customer?: SourceCustomer | null;
  enrollment?: {
    enrollmentId?: string;
    customerId?: string;
    eventId?: string;
    occurrenceId?: string;
    occasionLocalDate?: string;
    eventDateSnapshot?: string;
    occasionKind?: any;
    recipientLabel?: string | null;
    orderId?: string;
    anchorOrderId?: string;
  } | null;
  tenant?: { name?: string; timezone?: string } | null;
  campaignVersion?: { timezone?: string } | null;
  order?: SourceOrder | any;
  offer?: SourceOffer | any;
  credit?: SourceCredit | any;
  offerAmountRupees?: string | null;
  timezone?: string;
  now?: Date;
  serverNow?: Date;
  clock?: { now: () => Date };
  overrides?: Partial<BindingResolutionContext>;
}

/**
 * Dynamically assembles the BindingResolutionContext for a step,
 * inspecting step.bindings to load ONLY what the declared binding sources require.
 */
export async function buildResolutionSnapshot(
  ctx: BuildSnapshotContext
): Promise<BindingResolutionContext> {
  const rawBindings = ctx.bindings !== undefined ? ctx.bindings : ctx.step?.bindings;
  const neededDeps = new Set<string>();

  if (rawBindings && typeof rawBindings === 'object') {
    for (const val of Object.values(rawBindings)) {
      const source = (val as any)?.source;
      if (source && BINDING_SOURCES[source]?.needs) {
        for (const dep of BINDING_SOURCES[source].needs) {
          neededDeps.add(dep);
        }
      }
    }
  } else {
    // If no bindings provided, prepare standard customer & shop dependencies
    neededDeps.add('customer');
    neededDeps.add('shop');
  }

  const effectiveNow = ctx.now || ctx.serverNow || (ctx.clock ? ctx.clock.now() : defaultClock.now());
  const effectiveTimezone =
    ctx.timezone ||
    ctx.campaignVersion?.timezone ||
    ctx.tenant?.timezone ||
    'Asia/Kolkata';

  // 1. Customer
  let customer: SourceCustomer | null = ctx.customer || null;
  const targetCustomerId = ctx.customerId || ctx.enrollment?.customerId;
  if (!customer && targetCustomerId && (neededDeps.has('customer') || neededDeps.size === 0)) {
    try {
      customer = await mockCustomerSource.getCustomerById(ctx.tenantId, targetCustomerId);
    } catch {}
  }

  // 2. Shop
  let shopName = ctx.tenant?.name || ctx.overrides?.shopName;
  let bookingLinkUrl = ctx.overrides?.bookingLinkUrl;
  if (neededDeps.has('shop') || !shopName || bookingLinkUrl === undefined) {
    const promises: Promise<any>[] = [];
    if (bookingLinkUrl === undefined) {
      promises.push(campaignSettingsService.getSettings(ctx.tenantId).catch(() => null));
    }
    if (!shopName) {
      promises.push(TenantModel.findOne({ tenantId: ctx.tenantId }).lean().catch(() => null));
    }
    const results = await Promise.all(promises);
    if (bookingLinkUrl === undefined) {
      const settings = results[0];
      bookingLinkUrl = settings?.bookingLinkUrl || null;
    }
    if (!shopName) {
      const tenantDoc = bookingLinkUrl === undefined ? results[1] : results[0];
      shopName = (tenantDoc as any)?.name || 'Sample Boutique';
    }
  }

  // 3. Occasion
  let occasionRecord: OccasionRecord | null = null;
  let recipientLabel: string | null = ctx.overrides?.recipientLabel ?? null;
  let occasionKind: any = ctx.overrides?.occasionKind ?? null;
  let occasionLocalDate: string | undefined = ctx.overrides?.occasionLocalDate;
  let eventDate: any = ctx.overrides?.eventDate;

  if (neededDeps.has('occasion') || ctx.enrollment?.occurrenceId?.startsWith('gift:') || ctx.enrollment?.occurrenceId?.startsWith('wedding:')) {
    const eventId =
      ctx.enrollment?.eventId ||
      (ctx.enrollment?.occurrenceId && (ctx.enrollment.occurrenceId.startsWith('gift:') || ctx.enrollment.occurrenceId.startsWith('wedding:'))
        ? ctx.enrollment.occurrenceId.split(':')[1]
        : null);

    if (eventId) {
      try {
        occasionRecord = await mockOccasionSource.getOccasion(ctx.tenantId, eventId);
      } catch {}
    }

    if (!recipientLabel) {
      recipientLabel = occasionRecord?.recipientLabel || ctx.enrollment?.recipientLabel || null;
    }
    if (!occasionKind) {
      occasionKind = ctx.enrollment?.occasionKind || occasionRecord?.kind || null;
    }
    if (!occasionLocalDate) {
      occasionLocalDate = ctx.enrollment?.occasionLocalDate || occasionRecord?.eventDateKey || undefined;
    }
    if (!eventDate) {
      eventDate = ctx.enrollment?.eventDateSnapshot || occasionRecord?.eventDate || occasionLocalDate;
    }
  }

  // 4. Order
  let order: any = ctx.order || ctx.overrides?.order || null;
  if (!order && neededDeps.has('order')) {
    const orderId = ctx.enrollment?.orderId || ctx.enrollment?.anchorOrderId;
    if (orderId) {
      try {
        order = await mockOrderSource.getOrderById(ctx.tenantId, orderId);
      } catch {}
    }
  }

  // 5. Offer
  let offer: any = ctx.offer || ctx.overrides?.offer || null;
  let offerAmountRupees: string | null = ctx.offerAmountRupees || ctx.overrides?.offerAmountRupees || null;
  if (!offer && (neededDeps.has('offer') || neededDeps.has('stockoffer')) && ctx.step?.offerRef) {
    try {
      offer = await mockOfferSource.getOfferById(ctx.tenantId, ctx.step.offerRef);
    } catch {}
  }

  let stockMatch: any = null;
  if (offer?.kind === 'SELECTED_STOCK' && (neededDeps.has('stockoffer') || neededDeps.has('product'))) {
    const products = await Promise.all((offer.items || []).map((item: any) =>
      mockProductSource.getProduct(ctx.tenantId, item.productId)
    ));
    stockMatch = matchSelectedStock(
      { customerId: targetCustomerId || '', preferences: customer?.preferences },
      products.filter(Boolean) as any,
      offer,
      { mode: (ctx.campaignVersion as any)?.matchMode || 'STRICT', audienceMode: (ctx.campaignVersion as any)?.audience?.mode || 'PREFERENCE_MATCH' }
    );
  }

  // 6. Credit
  let credit: any = ctx.credit || ctx.overrides?.credit || null;
  if (!credit && neededDeps.has('credit') && ctx.step?.creditRef) {
    try {
      credit = await mockCreditSource.getCredit(ctx.tenantId, ctx.step.creditRef);
    } catch {}
  }

  // 7. Enquiry & Product
  let enquiry: any = (ctx.overrides as any)?.enquiry || null;
  let itemName: string | null = (ctx.overrides as any)?.itemName ?? null;

  if (
    neededDeps.has('enquiry') ||
    neededDeps.has('product') ||
    (ctx.enrollment as any)?.enquiryId ||
    ctx.enrollment?.occurrenceId?.startsWith('enquiry:')
  ) {
    const enquiryId =
      (ctx.enrollment as any)?.enquiryId ||
      (ctx.enrollment?.occurrenceId && ctx.enrollment.occurrenceId.startsWith('enquiry:')
        ? ctx.enrollment.occurrenceId.split(':')[1]
        : null);

    if (enquiryId && !enquiry) {
      try {
        enquiry = await mockEnquirySource.getEnquiry(ctx.tenantId, enquiryId);
      } catch {}
    }

    if (!itemName && (neededDeps.has('product') || enquiry?.itemRef?.productId)) {
      const itemRef = enquiry?.itemRef || (ctx.enrollment as any)?.itemRef;
      if (itemRef?.productId) {
        try {
          const variant = await mockProductSource.getVariant(
            ctx.tenantId,
            itemRef.productId,
            itemRef.variantId || null
          );
          itemName = variant?.displayName || null;
        } catch {}
      }
    }

    if (!itemName && (ctx.enrollment?.occurrenceId?.startsWith('request:') || (ctx.enrollment as any)?.requestId)) {
      const itemRef = (ctx.enrollment as any)?.itemRef;
      if (itemRef?.productId) {
        try {
          const variant = await mockProductSource.getVariant(
            ctx.tenantId,
            itemRef.productId,
            itemRef.variantId || null
          );
          itemName = variant?.displayName || null;
        } catch {}
      }
    }
  }

  // 8. Outfit
  let outfit: any = (ctx.overrides as any)?.outfit || null;
  let anchorItemName: string | null = (ctx.overrides as any)?.anchorItemName ?? null;
  let complement1Name: string | null = (ctx.overrides as any)?.complement1Name ?? null;
  let complement2Name: string | null = (ctx.overrides as any)?.complement2Name ?? null;
  let complement3Name: string | null = (ctx.overrides as any)?.complement3Name ?? null;

  if (outfit) {
    if (!anchorItemName) anchorItemName = outfit.anchor?.name || null;
    if (!complement1Name) complement1Name = outfit.complements?.[0]?.name || null;
    if (!complement2Name) complement2Name = outfit.complements?.[1]?.name || null;
    if (!complement3Name) complement3Name = outfit.complements?.[2]?.name || null;
  } else if (
    neededDeps.has('outfit') ||
    (ctx.enrollment?.occurrenceId && ctx.enrollment.occurrenceId.startsWith('outfit:'))
  ) {
    const orderId =
      (ctx.enrollment as any)?.anchorOrderId ||
      ctx.enrollment?.orderId ||
      (ctx.enrollment?.occurrenceId && ctx.enrollment.occurrenceId.startsWith('outfit:')
        ? ctx.enrollment.occurrenceId.split(':')[1]
        : null) ||
      (order as any)?.orderId ||
      null;

    if (orderId) {
      try {
        const anchorOrder =
          order && (order as any).orderId === orderId
            ? order
            : await mockOrderSource.getOrderById(ctx.tenantId, orderId);

        if (anchorOrder && Array.isArray(anchorOrder.lines) && anchorOrder.lines.length > 0) {
          const pairing =
            (ctx.campaignVersion as any)?.pairing ||
            (ctx.campaignVersion as any)?.config?.pairing || {
            anchorCategories: ['saree'],
            complementMap: {
              saree: ['blouse', 'petticoat', 'dupatta', 'accessories'],
              lehenga: ['dupatta', 'accessories'],
              kurta: ['dupatta', 'accessories'],
            },
            colourMatch: 'NEUTRAL_OR_SAME',
            requireSameWeave: false,
            budgetAware: false,
            alreadyOwnedLookbackDays: 180,
            suppressIfCategoryInOrder: true,
          };

          const productCategoryMap: Record<string, any> = {};
          const candidateAnchorLines: Array<{ line: any; product: any; netPaise: number }> = [];

          for (const line of anchorOrder.lines) {
            if (line.productId) {
              try {
                const prod = await mockProductSource.getProduct(ctx.tenantId, line.productId);
                if (prod && prod.category) {
                  productCategoryMap[line.productId] = prod.category;
                  const retQty = line.returnedQty ?? 0;
                  const qty = line.qty ?? line.quantity ?? 1;
                  if (retQty < qty) {
                    const normCat = prod.category.toLowerCase();
                    const isAnchorCat = (pairing.anchorCategories || []).some(
                      (ac: string) => ac.toLowerCase() === normCat
                    );
                    if (isAnchorCat) {
                      const netPaise =
                        line.lineNetPaise ??
                        ((line.pricePaise || prod.pricePaise || 0) * (qty - retQty));
                      candidateAnchorLines.push({ line, product: prod, netPaise });
                    }
                  }
                }
              } catch {}
            }
          }

          if (candidateAnchorLines.length > 0) {
            candidateAnchorLines.sort((a, b) => {
              if (b.netPaise !== a.netPaise) return b.netPaise - a.netPaise;
              return String(a.line.lineId || '').localeCompare(String(b.line.lineId || ''));
            });

            const primary = candidateAnchorLines[0];
            const primaryAnchorLine = primary.line;
            const anchorProduct = primary.product;

            const customerId = targetCustomerId || anchorOrder.customerId;
            let orderHistory: any[] = [];
            if (customerId) {
              try {
                orderHistory = await mockOrderSource.listOrdersForCustomer(ctx.tenantId, customerId);
              } catch {}
            }

            const allowedCats = pairing.complementMap?.[anchorProduct.category] || [];
            let candidateProducts: any[] = [];
            if (allowedCats.length > 0) {
              try {
                const res = await mockProductSource.listByCategories(
                  ctx.tenantId,
                  allowedCats,
                  undefined,
                  100,
                  'ACTIVE'
                );
                candidateProducts = res.products;
              } catch {}
            }

            const rawBindings = ctx.step?.bindings;
            let k = 1;
            if (rawBindings && typeof rawBindings === 'object') {
              let maxSlot = 0;
              for (const val of Object.values(rawBindings)) {
                const src = (val as any)?.source;
                if (src === 'complement.1.name') maxSlot = Math.max(maxSlot, 1);
                if (src === 'complement.2.name') maxSlot = Math.max(maxSlot, 2);
                if (src === 'complement.3.name') maxSlot = Math.max(maxSlot, 3);
              }
              if (maxSlot > 0) k = maxSlot;
            }

            const selection = selectComplements({
              anchorOrder,
              primaryAnchorLine,
              anchorProduct,
              customer: {
                customerId: customerId || '',
                preferences: customer?.preferences || null,
              },
              candidateProducts,
              productCategoryMap,
              orderHistory,
              pairing,
              k,
              now: effectiveNow,
            });

            outfit = selection;
            anchorItemName = selection.anchor.name;
            complement1Name = selection.complements[0]?.name || null;
            complement2Name = selection.complements[1]?.name || null;
            complement3Name = selection.complements[2]?.name || null;
          }
        }
      } catch {}
    }

    if (!outfit) {
      outfit = {
        anchor: { orderId: orderId || '', lineId: '', productId: '', name: 'Purchased Item' },
        complements: [],
        matchReasons: [],
        excluded: [],
        available: 0,
        insufficient: true,
      };
    }
  }

  // 9. Collection
  let collection: any = (ctx.overrides as any)?.collection || null;
  let collectionName: string | null = (ctx.overrides as any)?.collectionName ?? null;
  let matchItemList: string | null = (ctx.overrides as any)?.matchItemList ?? null;
  if (stockMatch) {
    matchItemList = stockMatch.items.map((item: any) => item.name).join(', ');
  }

  if (
    neededDeps.has('collection') ||
    (ctx.enrollment?.occurrenceId && ctx.enrollment.occurrenceId.startsWith('collection:')) ||
    (ctx.enrollment as any)?.releaseId
  ) {
    const releaseId =
      (ctx.enrollment as any)?.releaseId ||
      (ctx.enrollment?.occurrenceId && ctx.enrollment.occurrenceId.startsWith('collection:')
        ? ctx.enrollment.occurrenceId.split(':')[1]
        : null);

    if (releaseId && !collection) {
      try {
        collection = await SrcCollectionModel.findOne({ tenantId: ctx.tenantId, releaseId }).lean();
      } catch {}
    }

    if (!collectionName) {
      collectionName = collection?.title || 'New Arrivals';
    }

    if (!matchItemList) {
      const bestMatchName = (ctx.enrollment as any)?.matchSnapshot?.bestMatchItem?.name;
      if (bestMatchName) {
        matchItemList = bestMatchName;
      } else if (collection?.items && collection.items.length > 0) {
        matchItemList = collection.items.slice(0, 3).map((it: any) => it.name).filter(Boolean).join(', ');
      }
    }
  }

  const snapshot: BindingResolutionContext = {
    customer,
    shopName,
    occasionLocalDate,
    eventDate,
    recipientLabel,
    bookingLinkUrl,
    occasionKind,
    order,
    credit,
    offer,
    offerAmountRupees,
    enquiry,
    itemName,
    requestItemName: (ctx.overrides as any)?.requestItemName || itemName,
    outfit,
    anchorItemName,
    complement1Name,
    complement2Name,
    complement3Name,
    collection,
    collectionName,
    matchItemList,
    match: stockMatch
      ? {
          itemList: matchItemList,
          items: stockMatch.items.map((item: any) => ({
            name: item.name,
            priceDisplay: formatPaiseInr(item.regularPricePaise),
            offerPriceDisplay: formatPaiseInr(item.offerPricePaise),
          })),
        }
      : undefined,
    timezone: effectiveTimezone,
    now: effectiveNow,
    ...ctx.overrides,
  };

  return snapshot;
}

export interface ResolveForStepParams extends BuildSnapshotContext {
  template: Pick<SourceTemplate, 'id' | 'name' | 'language' | 'variables' | 'bodyText'>;
}

export interface ResolveForStepResult {
  ok: boolean;
  resolution: TemplateResolutionResult;
  canonicalParameters: CanonicalParameter[];
  payloadHash: string;
  snapshot: BindingResolutionContext;
}

/**
 * Exactly ONE function to resolve all parameters, build canonical parameter list,
 * and compute stable payload hash for a campaign step.
 */
export async function resolveForStep(
  params: ResolveForStepParams
): Promise<ResolveForStepResult> {
  const snapshot = await buildResolutionSnapshot(params);

  const resolution = resolveTemplateParameters({
    template: params.template,
    step: params.step,
    bindings: params.bindings,
    customer: snapshot.customer,
    tenant: params.tenant,
    campaignVersion: params.campaignVersion,
    snapshot,
    clock: params.clock || { now: () => snapshot.now || defaultClock.now() },
  });

  const canonicalParameters = canonicalizeParameters(resolution.parameters);

  const payloadHash = computePayloadHash({
    templateId: params.template.id,
    revision: (params.template as any).revision ?? 1,
    language: params.template.language,
    parameters: canonicalParameters,
  });

  return {
    ok: resolution.ok,
    resolution,
    canonicalParameters,
    payloadHash,
    snapshot,
  };
}

/**
 * Resolves a single binding value using the canonical snapshot and BINDING_SOURCES registry.
 * Provided for backwards compatibility and tests without any synthetic templates.
 */
export function resolveBindingValue(
  binding: any,
  customer?: SourceCustomer | null,
  shopName?: string,
  occasionLocalDate?: string,
  context?: {
    offerAmountRupees?: string;
    order?: any;
    credit?: any;
    timezone?: string;
    serverNow?: Date;
    recipientLabel?: string | null;
    bookingLinkUrl?: string | null;
    occasionKind?: 'GIFT' | 'WEDDING' | null;
  }
): string | null {
  if (binding === undefined || binding === null) {
    return null;
  }

  if (binding.source === 'literal') {
    return typeof binding.value === 'string' ? binding.value : null;
  }

  const def = BINDING_SOURCES[binding.source];
  if (!def) {
    return null;
  }

  const snapshot: BindingResolutionContext = {
    customer: customer || null,
    shopName: shopName || 'Sample Boutique',
    occasionLocalDate: occasionLocalDate,
    eventDate: occasionLocalDate,
    recipientLabel: context?.recipientLabel || null,
    bookingLinkUrl: context?.bookingLinkUrl || null,
    occasionKind: context?.occasionKind || null,
    offerAmountRupees: context?.offerAmountRupees,
    order: context?.order,
    credit: context?.credit,
    timezone: context?.timezone || 'Asia/Kolkata',
    now: context?.serverNow || new Date(),
  };

  const val = def.resolve(snapshot);
  if (val === null || val === undefined) {
    if (def.allowFallback && typeof binding.fallbackLiteral === 'string' && binding.fallbackLiteral.trim()) {
      return binding.fallbackLiteral.trim();
    }
    return null;
  }

  return val;
}

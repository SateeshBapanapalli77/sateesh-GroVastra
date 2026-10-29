import { computeOfferPrice, SelectedStockDiscount } from '@grovastra/shared';

export interface SelectedStockOfferInput {
  offerId: string;
  kind: string;
  name?: string;
  status: string;
  publishedAt?: Date | null;
  validFrom: Date;
  validUntil: Date;
  discount?: { type: 'PERCENT_OFF' | 'FLAT_OFF' | 'SPECIAL_PRICE'; percent?: number; flatOffPaise?: number };
  items?: Array<{ productId: string; offerPricePaise?: number | null; position: number }>;
}

export interface SelectedStockProductInput {
  productId: string;
  pricePaise?: number;
}

export function validateSelectedStockOffer(
  offer: SelectedStockOfferInput,
  products: SelectedStockProductInput[],
  now: Date
): { valid: true } | { valid: false; reason: string } {
  if (offer.kind !== 'SELECTED_STOCK') return { valid: false, reason: 'kind must be SELECTED_STOCK' };
  if (!offer.name?.trim()) return { valid: false, reason: 'name is required' };
  if (!offer.items?.length) return { valid: false, reason: 'at least one item is required' };
  if (offer.validUntil.getTime() <= offer.validFrom.getTime()) return { valid: false, reason: 'validUntil must be after validFrom' };
  if (offer.validUntil.getTime() <= now.getTime()) return { valid: false, reason: 'validUntil must be in the future' };
  if (!offer.discount) return { valid: false, reason: 'discount is required' };
  const productIds = new Set<string>();
  for (const item of offer.items) {
    if (productIds.has(item.productId)) return { valid: false, reason: `duplicate productId: ${item.productId}` };
    productIds.add(item.productId);
    const product = products.find((candidate) => candidate.productId === item.productId);
    if (!product || !Number.isInteger(product.pricePaise) || (product.pricePaise || 0) <= 0) {
      return { valid: false, reason: `unknown price for productId: ${item.productId}` };
    }
    const discount: SelectedStockDiscount =
      offer.discount.type === 'PERCENT_OFF'
        ? { type: 'PERCENT_OFF', percent: offer.discount.percent || 0 }
        : offer.discount.type === 'FLAT_OFF'
          ? { type: 'FLAT_OFF', flatOffPaise: offer.discount.flatOffPaise || 0 }
          : { type: 'SPECIAL_PRICE' };
    const regularPricePaise = product.pricePaise;
    if (regularPricePaise === undefined || computeOfferPrice(regularPricePaise, discount, item) === null) {
      return { valid: false, reason: `invalid computed price for productId: ${item.productId}` };
    }
  }
  return { valid: true };
}

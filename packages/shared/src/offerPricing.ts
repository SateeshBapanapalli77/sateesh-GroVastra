export type SelectedStockDiscount =
  | { type: 'PERCENT_OFF'; percent: number }
  | { type: 'FLAT_OFF'; flatOffPaise: number }
  | { type: 'SPECIAL_PRICE' };

export interface SelectedStockItem {
  offerPricePaise?: number | null;
}

export function computeOfferPrice(
  pricePaise: number,
  discount: SelectedStockDiscount,
  item: SelectedStockItem = {}
): number | null {
  if (!Number.isInteger(pricePaise) || pricePaise <= 0) return null;
  let offerPrice: number;
  if (discount.type === 'PERCENT_OFF') {
    if (!Number.isInteger(discount.percent) || discount.percent < 1 || discount.percent > 90) return null;
    offerPrice = pricePaise - Math.floor((pricePaise * discount.percent) / 100);
  } else if (discount.type === 'FLAT_OFF') {
    if (!Number.isInteger(discount.flatOffPaise) || discount.flatOffPaise <= 0 || discount.flatOffPaise >= pricePaise) {
      return null;
    }
    offerPrice = pricePaise - discount.flatOffPaise;
  } else {
    const specialPrice = item.offerPricePaise;
    if (typeof specialPrice !== 'number' || !Number.isInteger(specialPrice) || specialPrice <= 0 || specialPrice >= pricePaise) {
      return null;
    }
    offerPrice = specialPrice;
  }
  return offerPrice > 0 && offerPrice <= pricePaise ? offerPrice : null;
}

export function formatPaiseInr(paise: number): string {
  if (!Number.isInteger(paise) || paise < 0) return '₹0';
  const rupees = Math.floor(paise / 100);
  const remainder = paise % 100;
  const grouped = rupees.toLocaleString('en-IN');
  return `₹${grouped}${remainder === 0 ? '' : `.${String(remainder).padStart(2, '0')}`}`;
}

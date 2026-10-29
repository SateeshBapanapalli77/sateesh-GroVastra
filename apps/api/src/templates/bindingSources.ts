import { DateTime } from 'luxon';
import {
  SourceCustomer,
  SourceOffer,
  SourceOrder,
  SourceCredit,
} from '@grovastra/shared';

export interface BindingResolutionContext {
  customer?: SourceCustomer | null;
  shopName?: string;
  occasionLocalDate?: string;
  eventDate?: string | { year: number; month: number; day: number } | null;
  recipientLabel?: string | null;
  bookingLinkUrl?: string | null;
  occasionKind?: 'GIFT' | 'WEDDING' | null;
  order?: SourceOrder | { orderId?: string; orderNumber?: string; completedAt?: Date | string } | null;
  credit?: SourceCredit | { amount: number; unit: 'POINTS' | 'PAISE'; expiresAt: Date } | null;
  offerAmountRupees?: string | null;
  offer?: SourceOffer | null;
  enquiry?: {
    enquiryId?: string;
    createdAt?: Date | string;
    itemRef?: { productId: string; variantId?: string | null } | null;
  } | null;
  itemName?: string | null;
  requestItemName?: string | null;
  outfit?: {
    anchor: { orderId: string; lineId: string; productId: string; name: string };
    complements: Array<{ productId: string; variantId: string; name: string; category: string }>;
    matchReasons: string[];
    excluded: Array<{ productId: string; reason: string }>;
    available: number;
    insufficient: boolean;
  } | null;
  anchorItemName?: string | null;
  complement1Name?: string | null;
  complement2Name?: string | null;
  complement3Name?: string | null;
  collection?: {
    releaseId?: string;
    title?: string | null;
    items?: Array<{ name?: string; productId?: string }>;
  } | null;
  collectionName?: string | null;
  match?: {
    itemList?: string | null;
    items?: Array<{
      name: string;
      priceDisplay: string;
      offerPriceDisplay: string;
    }>;
  } | null;
  matchItemList?: string | null;
  festivalName?: string | null;
  festivalDate?: string | null;
  seasonName?: string | null;
  eventName?: string | null;
  eventVenue?: string | null;
  eventCity?: string | null;
  eventRsvpLink?: string | null;
  appointmentServiceType?: string | null;
  appointmentDate?: string | null;
  appointmentTime?: string | null;
  appointmentBranch?: string | null;
  appointmentStylistName?: string | null;
  alterationJobId?: string | null;
  alterationGarment?: string | null;
  alterationStage?: string | null;
  alterationTrialDate?: string | null;
  alterationNotes?: string | null;
  fulfilmentOrderNumber?: string | null;
  shipmentCarrierName?: string | null;
  shipmentTrackingRef?: string | null;
  now?: Date;
  timezone?: string;
}

export function sanitizeRecipientLabel(label: string | null | undefined): string | null {
  if (!label || typeof label !== 'string') return null;
  const cleaned = label.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!cleaned) return null;
  return cleaned.slice(0, 40);
}

export interface BindingSourceDefinition {
  path: string;
  label: string;
  valueType: 'text';
  allowedPresets: string[]; // preset keys or '*'
  sampleValue: string;
  formatNote?: string;
  requiresRef?: 'offerRef' | 'creditRef';
  allowFallback: boolean; // only customer.firstName allows fallback
  needs: Array<'customer' | 'shop' | 'occasion' | 'order' | 'offer' | 'stockoffer' | 'credit' | 'enquiry' | 'product' | 'outfit' | 'collection' | 'festival' | 'event' | 'appointment' | 'alteration' | 'fulfilment'>;
  resolve: (ctx: BindingResolutionContext) => string | null;
}

/**
 * Formats paise integer minor units to rupees string:
 * 5000 -> "50"
 * 5050 -> "50.50"
 * (no currency symbol)
 */
export function formatPaiseToRupees(amountPaise: number): string {
  const rupees = amountPaise / 100;
  return rupees % 1 === 0 ? String(rupees) : rupees.toFixed(2);
}

export function formatPaiseInr(amountPaise: number): string {
  const rupees = Math.floor(amountPaise / 100);
  const remainder = amountPaise % 100;
  return `₹${rupees.toLocaleString('en-IN')}${remainder === 0 ? '' : `.${String(remainder).padStart(2, '0')}`}`;
}

/**
 * Formats credit balance display:
 * POINTS -> "150 points"
 * PAISE -> "₹150" or "₹150.50"
 */
export function formatCreditBalance(amount: number, unit: 'POINTS' | 'PAISE'): string {
  if (unit === 'POINTS') {
    return `${amount} points`;
  }
  const rupees = amount / 100;
  const isWhole = rupees % 1 === 0;
  const rupeeString = isWhole ? rupees.toFixed(0) : rupees.toFixed(2);
  return `₹${rupeeString}`;
}

/**
 * Computes calendar-day difference in campaign timezone, min 0 (Spec p16).
 */
export function computeDaysToExpiry(expiresAt: Date, now: Date, timezone = 'Asia/Kolkata'): number {
  const today = DateTime.fromJSDate(now, { zone: timezone }).startOf('day');
  const expiry = DateTime.fromJSDate(new Date(expiresAt), { zone: timezone }).startOf('day');
  const diff = expiry.diff(today, 'days').days;
  return Math.max(0, Math.floor(diff));
}

/**
 * Formats date to 'MMM d, yyyy' in campaign timezone (e.g. "Oct 18, 2026").
 * Date-only values (birthday, anniversary) never go through UTC midnight.
 */
export function formatDateOnly(dateOrIso: Date | string, timezone = 'Asia/Kolkata'): string {
  if (typeof dateOrIso === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateOrIso)) {
    const dt = DateTime.fromISO(dateOrIso, { zone: timezone });
    return dt.isValid ? dt.toFormat('MMM d, yyyy') : dateOrIso;
  }
  const dt = DateTime.fromJSDate(new Date(dateOrIso), { zone: timezone });
  return dt.isValid ? dt.toFormat('MMM d, yyyy') : '';
}

/**
 * Master Registry of all allowed template binding sources.
 * Derived from existing code in F5, F6, F9, F19b, F20.
 */
export const BINDING_SOURCES: Record<string, BindingSourceDefinition> = {
  'customer.firstName': {
    path: 'customer.firstName',
    label: 'Customer First Name',
    valueType: 'text',
    allowedPresets: ['*'],
    sampleValue: 'Lakshmi',
    formatNote: 'Cleaned text; only source permitting fallbackLiteral',
    allowFallback: true,
    needs: ['customer'],
    resolve: (ctx) => ctx.customer?.firstName || null,
  },
  'offer.name': {
    path: 'offer.name', label: 'Offer Name', valueType: 'text',
    allowedPresets: ['selected_stock_promotion', 'SELECTED_STOCK_PROMOTION'],
    sampleValue: 'Festive edit', allowFallback: false, needs: ['stockoffer'],
    resolve: (ctx) => sanitizeRecipientLabel(ctx.offer?.name) ,
  },
  'offer.discountText': {
    path: 'offer.discountText', label: 'Offer Discount', valueType: 'text',
    allowedPresets: ['selected_stock_promotion', 'SELECTED_STOCK_PROMOTION'],
    sampleValue: '20% off', allowFallback: false, needs: ['stockoffer'],
    resolve: (ctx) => {
      const discount = (ctx.offer as any)?.discount;
      if (!discount) return null;
      if (discount.type === 'PERCENT_OFF') return `${discount.percent}% off`;
      if (discount.type === 'FLAT_OFF') return `${formatPaiseInr(discount.flatOffPaise)} off`;
      return 'special prices';
    },
  },
  'offer.validUntilDate': {
    path: 'offer.validUntilDate', label: 'Offer Valid Until', valueType: 'text',
    allowedPresets: ['selected_stock_promotion', 'SELECTED_STOCK_PROMOTION'],
    sampleValue: 'Oct 31, 2026', allowFallback: false, needs: ['stockoffer'],
    resolve: (ctx) => ctx.offer?.validUntil ? formatDateOnly(ctx.offer.validUntil, ctx.timezone) : null,
  },
  'offer.terms': {
    path: 'offer.terms', label: 'Offer Terms', valueType: 'text',
    allowedPresets: ['selected_stock_promotion', 'SELECTED_STOCK_PROMOTION'],
    sampleValue: 'While stocks last', allowFallback: false, needs: ['stockoffer'],
    resolve: (ctx) => ctx.offer?.terms ? sanitizeRecipientLabel(ctx.offer.terms) : null,
  },
  'match.item.1.name': {
    path: 'match.item.1.name', label: 'First Matched Item', valueType: 'text',
    allowedPresets: ['selected_stock_promotion', 'SELECTED_STOCK_PROMOTION'],
    sampleValue: 'Red Silk Saree', allowFallback: false, needs: ['stockoffer', 'product'],
    resolve: (ctx) => ctx.match?.items?.[0]?.name || null,
  },
  'match.item.1.priceDisplay': {
    path: 'match.item.1.priceDisplay', label: 'First Regular Price', valueType: 'text',
    allowedPresets: ['selected_stock_promotion', 'SELECTED_STOCK_PROMOTION'],
    sampleValue: '₹20,000', allowFallback: false, needs: ['stockoffer', 'product'],
    resolve: (ctx) => ctx.match?.items?.[0]?.priceDisplay || null,
  },
  'match.item.1.offerPriceDisplay': {
    path: 'match.item.1.offerPriceDisplay', label: 'First Offer Price', valueType: 'text',
    allowedPresets: ['selected_stock_promotion', 'SELECTED_STOCK_PROMOTION'],
    sampleValue: '₹16,000', allowFallback: false, needs: ['stockoffer', 'product'],
    resolve: (ctx) => ctx.match?.items?.[0]?.offerPriceDisplay || null,
  },
  'shop.displayName': {
    path: 'shop.displayName',
    label: 'Shop Display Name',
    valueType: 'text',
    allowedPresets: ['*'],
    sampleValue: 'Sample Boutique',
    formatNote: 'Tenant display name',
    allowFallback: false,
    needs: ['shop'],
    resolve: (ctx) => ctx.shopName || null,
  },
  'occasion.localDate': {
    path: 'occasion.localDate',
    label: 'Occasion Date',
    allowedPresets: ['birthday', 'BIRTHDAY', 'anniversary', 'ANNIVERSARY', 'gift_wedding', 'festival'],
    sampleValue: 'Oct 18, 2026',
    formatNote: 'Formatted as MMM d, yyyy in campaign timezone',
    allowFallback: false,
    valueType: 'text',
    needs: ['occasion'],
    resolve: (ctx) => {
      if (!ctx.occasionLocalDate) return null;
      return formatDateOnly(ctx.occasionLocalDate, ctx.timezone);
    },
  },
  'event.localDate': {
    path: 'event.localDate',
    label: 'Event Local Date',
    valueType: 'text',
    allowedPresets: ['gift_wedding_reminder', 'GIFT_WEDDING_REMINDER', 'gift_wedding', 'GIFT_WEDDING'],
    sampleValue: 'Nov 20, 2026',
    formatNote: "Formatted as 'MMM d, yyyy' from date-only eventDate without timezone math",
    allowFallback: false,
    needs: ['occasion'],
    resolve: (ctx) => {
      const rawDate = typeof ctx.eventDate === 'string' ? ctx.eventDate : ctx.occasionLocalDate;
      if (!rawDate) return null;
      const match = rawDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (match) {
        const [, y, m, d] = match;
        const dt = DateTime.utc(Number(y), Number(m), Number(d));
        return dt.isValid ? dt.toFormat('MMM d, yyyy') : rawDate;
      }
      return null;
    },
  },
  'event.recipientLabel': {
    path: 'event.recipientLabel',
    label: 'Gift Recipient Label',
    valueType: 'text',
    allowedPresets: ['gift_wedding_reminder', 'GIFT_WEDDING_REMINDER', 'gift_wedding', 'GIFT_WEDDING'],
    sampleValue: 'Mom',
    formatNote: 'Customer-volunteered gift recipient label (sanitized, <=40 chars; permits fallbackLiteral)',
    allowFallback: true,
    needs: ['occasion'],
    resolve: (ctx) => {
      if (ctx.occasionKind && ctx.occasionKind !== 'GIFT') return null;
      return sanitizeRecipientLabel(ctx.recipientLabel);
    },
  },
  'shop.bookingLink': {
    path: 'shop.bookingLink',
    label: 'Booking Link URL',
    valueType: 'text',
    allowedPresets: ['gift_wedding_reminder', 'GIFT_WEDDING_REMINDER', 'gift_wedding', 'GIFT_WEDDING'],
    sampleValue: 'https://example.com/book',
    formatNote: 'Booking link URL from campaign settings (allowed only in WEDDING kind)',
    allowFallback: false,
    needs: ['shop', 'occasion'],
    resolve: (ctx) => {
      if (ctx.occasionKind && ctx.occasionKind !== 'WEDDING') return null;
      return ctx.bookingLinkUrl || null;
    },
  },
  'offer.amountRupees': {
    path: 'offer.amountRupees',
    label: 'Offer Amount (₹)',
    valueType: 'text',
    allowedPresets: [
      'WELCOME_NEW_CUSTOMER',
      'first_to_second_purchase',
      'FIRST_TO_SECOND_PURCHASE',
      'stock_promotion',
    ],
    sampleValue: '50',
    formatNote: 'Integer or 2-decimal rupees without currency symbol ("50", "50.50")',
    requiresRef: 'offerRef',
    allowFallback: false,
    needs: ['offer'],
    resolve: (ctx) => {
      if (ctx.offerAmountRupees !== undefined && ctx.offerAmountRupees !== null) {
        return ctx.offerAmountRupees;
      }
      if (ctx.offer?.amountPaise !== undefined && ctx.offer?.amountPaise !== null) {
        return formatPaiseToRupees(ctx.offer.amountPaise);
      }
      return null;
    },
  },
  'order.firstOrderNumber': {
    path: 'order.firstOrderNumber',
    label: 'First Order Number',
    valueType: 'text',
    allowedPresets: [
      'first_to_second_purchase',
      'FIRST_TO_SECOND_PURCHASE',
      'WELCOME_NEW_CUSTOMER',
    ],
    sampleValue: 'ORD-123456',
    formatNote: 'Order identifier / bill number',
    allowFallback: false,
    needs: ['order'],
    resolve: (ctx) => (ctx.order as any)?.orderNumber || (ctx.order as any)?.orderId || null,
  },
  'order.firstOrderDate': {
    path: 'order.firstOrderDate',
    label: 'First Order Date',
    valueType: 'text',
    allowedPresets: [
      'first_to_second_purchase',
      'FIRST_TO_SECOND_PURCHASE',
      'WELCOME_NEW_CUSTOMER',
    ],
    sampleValue: 'Oct 18, 2026',
    formatNote: 'Formatted as MMM d, yyyy in campaign timezone',
    allowFallback: false,
    needs: ['order'],
    resolve: (ctx) => {
      const completedAt = (ctx.order as any)?.completedAt;
      if (!completedAt) return null;
      return formatDateOnly(completedAt, ctx.timezone);
    },
  },
  'credit.balanceDisplay': {
    path: 'credit.balanceDisplay',
    label: 'Credit Balance',
    valueType: 'text',
    allowedPresets: [
      'first_to_second_purchase',
      'FIRST_TO_SECOND_PURCHASE',
      'REWARD_EXPIRY_ALERT',
      'REWARD_CASHBACK_CONFIRMATION',
      'vip_loyalty',
    ],
    sampleValue: '₹150',
    formatNote: '"150 points" or "₹150" / "₹150.50"',
    requiresRef: 'creditRef',
    allowFallback: false,
    needs: ['credit'],
    resolve: (ctx) => {
      if (!ctx.credit) return null;
      return formatCreditBalance(ctx.credit.amount, ctx.credit.unit);
    },
  },
  'credit.expiryDate': {
    path: 'credit.expiryDate',
    label: 'Credit Expiry Date',
    valueType: 'text',
    allowedPresets: [
      'first_to_second_purchase',
      'FIRST_TO_SECOND_PURCHASE',
      'REWARD_EXPIRY_ALERT',
      'REWARD_CASHBACK_CONFIRMATION',
      'vip_loyalty',
    ],
    sampleValue: 'Feb 20, 2027',
    formatNote: 'Formatted as MMM d, yyyy in campaign timezone',
    requiresRef: 'creditRef',
    allowFallback: false,
    needs: ['credit'],
    resolve: (ctx) => {
      if (!ctx.credit?.expiresAt) return null;
      return formatDateOnly(ctx.credit.expiresAt, ctx.timezone);
    },
  },
  'credit.daysToExpiry': {
    path: 'credit.daysToExpiry',
    label: 'Days to Expiry',
    valueType: 'text',
    allowedPresets: [
      'first_to_second_purchase',
      'FIRST_TO_SECOND_PURCHASE',
      'REWARD_EXPIRY_ALERT',
      'REWARD_CASHBACK_CONFIRMATION',
      'vip_loyalty',
    ],
    sampleValue: '14',
    formatNote: 'Non-negative integer string calculated at dispatch in campaign timezone',
    requiresRef: 'creditRef',
    allowFallback: false,
    needs: ['credit'],
    resolve: (ctx) => {
      if (!ctx.credit?.expiresAt) return null;
      const days = computeDaysToExpiry(new Date(ctx.credit.expiresAt), ctx.now || new Date(), ctx.timezone);
      return String(days);
    },
  },
  literal: {
    path: 'literal',
    label: 'Literal Text',
    valueType: 'text',
    allowedPresets: ['*'],
    sampleValue: 'Special Gift',
    formatNote: 'Owner-provided static text; required value; no newlines or tabs',
    allowFallback: false,
    needs: [],
    resolve: () => null, // literal is resolved directly from binding.value
  },
  'enquiry.localDate': {
    path: 'enquiry.localDate',
    label: 'Enquiry Date',
    valueType: 'text',
    allowedPresets: ['unresolved_enquiry', 'UNRESOLVED_ENQUIRY', 'enquiry', 'ENQUIRY'],
    sampleValue: 'Oct 18, 2026',
    formatNote: "Formatted as 'MMM d, yyyy' in campaign timezone",
    allowFallback: false,
    needs: ['enquiry'],
    resolve: (ctx) => {
      if (!ctx.enquiry?.createdAt) return null;
      return formatDateOnly(ctx.enquiry.createdAt, ctx.timezone);
    },
  },
  'item.name': {
    path: 'item.name',
    label: 'Item Name',
    valueType: 'text',
    allowedPresets: ['unresolved_enquiry', 'UNRESOLVED_ENQUIRY', 'enquiry', 'ENQUIRY'],
    sampleValue: 'Kanchipuram Silk Saree',
    formatNote: 'Display name from ProductSource at dispatch; allows fallbackLiteral',
    allowFallback: true,
    needs: ['product', 'enquiry'],
    resolve: (ctx) => ctx.itemName || null,
  },
  'anchor.itemName': {
    path: 'anchor.itemName',
    label: 'Anchor Item Name',
    valueType: 'text',
    allowedPresets: ['complete_the_outfit', 'COMPLETE_THE_OUTFIT', 'outfit_completion', 'OUTFIT_COMPLETION'],
    sampleValue: 'Kanchipuram Silk Saree',
    formatNote: 'Product display name of primary anchor; sanitized; never price or order number',
    allowFallback: false,
    needs: ['outfit'],
    resolve: (ctx) => ctx.anchorItemName || ctx.outfit?.anchor?.name || null,
  },
  'complement.1.name': {
    path: 'complement.1.name',
    label: 'Complement 1 Name',
    valueType: 'text',
    allowedPresets: ['complete_the_outfit', 'COMPLETE_THE_OUTFIT', 'outfit_completion', 'OUTFIT_COMPLETION'],
    sampleValue: 'Contrast Brocade Blouse',
    formatNote: 'Display name of first selected complement item',
    allowFallback: false,
    needs: ['outfit'],
    resolve: (ctx) => ctx.complement1Name || ctx.outfit?.complements?.[0]?.name || null,
  },
  'complement.2.name': {
    path: 'complement.2.name',
    label: 'Complement 2 Name',
    valueType: 'text',
    allowedPresets: ['complete_the_outfit', 'COMPLETE_THE_OUTFIT', 'outfit_completion', 'OUTFIT_COMPLETION'],
    sampleValue: 'Gold Plated Jhumkas',
    formatNote: 'Display name of second selected complement item',
    allowFallback: false,
    needs: ['outfit'],
    resolve: (ctx) => ctx.complement2Name || ctx.outfit?.complements?.[1]?.name || null,
  },
  'complement.3.name': {
    path: 'complement.3.name',
    label: 'Complement 3 Name',
    valueType: 'text',
    allowedPresets: ['complete_the_outfit', 'COMPLETE_THE_OUTFIT', 'outfit_completion', 'OUTFIT_COMPLETION'],
    sampleValue: 'Silk Potli Bag',
    formatNote: 'Display name of third selected complement item',
    allowFallback: false,
    needs: ['outfit'],
    resolve: (ctx) => ctx.complement3Name || ctx.outfit?.complements?.[2]?.name || null,
  },
  'request.1.name': {
    path: 'request.1.name',
    label: 'Requested Item Name',
    valueType: 'text',
    allowedPresets: [
      'requested_item_available',
      'REQUESTED_ITEM_AVAILABLE',
      'request_stock_available',
      'REQUEST_STOCK_AVAILABLE',
    ],
    sampleValue: 'Kanchipuram Silk Saree',
    formatNote: 'Display name of requested item from catalogue at dispatch',
    allowFallback: true,
    needs: ['product'],
    resolve: (ctx) => ctx.requestItemName || ctx.itemName || null,
  },
  'request.itemName': {
    path: 'request.itemName',
    label: 'Requested Item Name',
    valueType: 'text',
    allowedPresets: [
      'requested_item_available',
      'REQUESTED_ITEM_AVAILABLE',
      'request_stock_available',
      'REQUEST_STOCK_AVAILABLE',
    ],
    sampleValue: 'Kanchipuram Silk Saree',
    formatNote: 'Display name of requested item from catalogue at dispatch',
    allowFallback: true,
    needs: ['product'],
    resolve: (ctx) => ctx.requestItemName || ctx.itemName || null,
  },
  'request.1.nameWithVariant': {
    path: 'request.1.nameWithVariant',
    label: 'Requested Item Name with Variant',
    valueType: 'text',
    allowedPresets: [
      'requested_item_available',
      'REQUESTED_ITEM_AVAILABLE',
      'request_stock_available',
      'REQUEST_STOCK_AVAILABLE',
    ],
    sampleValue: 'Kanchipuram Silk Saree, Crimson / Medium',
    formatNote: 'Display name of requested item with variant from catalogue at dispatch',
    allowFallback: true,
    needs: ['product'],
    resolve: (ctx) => ctx.requestItemName || ctx.itemName || null,
  },
  'request.2.nameWithVariant': {
    path: 'request.2.nameWithVariant',
    label: 'Second Requested Item Name with Variant',
    valueType: 'text',
    allowedPresets: [
      'requested_item_available',
      'REQUESTED_ITEM_AVAILABLE',
      'request_stock_available',
      'REQUEST_STOCK_AVAILABLE',
    ],
    sampleValue: 'Gold Zari Blouse, Size 38',
    formatNote: 'Display name of second requested item with variant from catalogue at dispatch',
    allowFallback: true,
    needs: ['product'],
    resolve: (ctx) => null,
  },
  'collection.name': {
    path: 'collection.name',
    label: 'Collection Name',
    valueType: 'text',
    allowedPresets: [
      'matching_collection',
      'MATCHING_COLLECTION',
      'festival_collection',
      'FESTIVAL_COLLECTION',
      'festival',
    ],
    sampleValue: 'Diwali Festive Silk Collection 2026',
    formatNote: 'Title or name of the published collection',
    allowFallback: true,
    needs: ['collection'],
    resolve: (ctx) => ctx.collectionName || ctx.collection?.title || (ctx.collection as any)?.name || ctx.seasonName || null,
  },
  'match.itemList': {
    path: 'match.itemList',
    label: 'Matching Items List',
    valueType: 'text',
    allowedPresets: [
      'matching_collection',
      'MATCHING_COLLECTION',
      'selected_stock_promotion',
      'SELECTED_STOCK_PROMOTION',
      'festival_collection',
      'FESTIVAL_COLLECTION',
      'festival',
    ],
    sampleValue: 'Pure Kanjivaram Silk Saree, Banarasi Georgette',
    formatNote: 'Comma-separated names of matching items from the collection',
    needs: ['collection'],
    allowFallback: false,
    resolve: (ctx) => ctx.match?.itemList || ctx.matchItemList || (ctx.collection?.items?.[0] as any)?.name || null,
  },
  'festival.name': {
    path: 'festival.name',
    label: 'Festival Name',
    valueType: 'text',
    allowedPresets: [
      'festival_collection',
      'FESTIVAL_COLLECTION',
      'festival',
    ],
    sampleValue: 'Diwali Festive Collection 2026',
    formatNote: 'Name of the festival season',
    allowFallback: true,
    needs: ['festival'],
    resolve: (ctx) => ctx.festivalName || ctx.seasonName || ctx.collectionName || null,
  },
  'festival.date': {
    path: 'festival.date',
    label: 'Festival Date',
    valueType: 'text',
    allowedPresets: [
      'festival_collection',
      'FESTIVAL_COLLECTION',
      'festival',
    ],
    sampleValue: 'Nov 1, 2026',
    formatNote: 'Formatted date of the festival',
    allowFallback: false,
    needs: ['festival'],
    resolve: (ctx) => ctx.festivalDate || null,
  },
  'event.name': {
    path: 'event.name',
    label: 'Event Name',
    valueType: 'text',
    allowedPresets: [
      'exhibition_trunk_show',
      'EXHIBITION_TRUNK_SHOW',
      'exhibition',
      'trunk_show',
      'store_event',
    ],
    sampleValue: 'Mumbai Silk Trunk Show 2026',
    formatNote: 'Title or name of the exhibition/trunk show',
    allowFallback: true,
    needs: ['event'],
    resolve: (ctx) => ctx.eventName || (ctx as any).storeEventName || null,
  },
  'event.date': {
    path: 'event.date',
    label: 'Event Date',
    valueType: 'text',
    allowedPresets: [
      'exhibition_trunk_show',
      'EXHIBITION_TRUNK_SHOW',
      'exhibition',
      'trunk_show',
      'store_event',
    ],
    sampleValue: 'Nov 20, 2026',
    formatNote: 'Formatted date of the store event',
    allowFallback: false,
    needs: ['event'],
    resolve: (ctx) => {
      if (!ctx.eventDate) return null;
      return typeof ctx.eventDate === 'string' ? ctx.eventDate : formatDateOnly(ctx.eventDate as any, ctx.timezone);
    },
  },
  'event.venue': {
    path: 'event.venue',
    label: 'Event Venue',
    valueType: 'text',
    allowedPresets: [
      'exhibition_trunk_show',
      'EXHIBITION_TRUNK_SHOW',
      'exhibition',
      'trunk_show',
      'store_event',
    ],
    sampleValue: 'The Taj Mahal Palace, Mumbai',
    formatNote: 'Venue name and city of the exhibition',
    allowFallback: false,
    needs: ['event'],
    resolve: (ctx) => ctx.eventVenue || null,
  },
  'event.city': {
    path: 'event.city',
    label: 'Event City',
    valueType: 'text',
    allowedPresets: [
      'exhibition_trunk_show',
      'EXHIBITION_TRUNK_SHOW',
      'exhibition',
      'trunk_show',
      'store_event',
    ],
    sampleValue: 'Mumbai',
    formatNote: 'Host city of the exhibition',
    allowFallback: false,
    needs: ['event'],
    resolve: (ctx) => ctx.eventCity || null,
  },
  'event.rsvpLink': {
    path: 'event.rsvpLink',
    label: 'Event RSVP Link',
    valueType: 'text',
    allowedPresets: [
      'exhibition_trunk_show',
      'EXHIBITION_TRUNK_SHOW',
      'exhibition',
      'trunk_show',
      'store_event',
    ],
    sampleValue: 'https://rsvp.example.com/trunk-show',
    formatNote: 'RSVP link URL for the event',
    allowFallback: true,
    needs: ['event'],
    resolve: (ctx) => ctx.eventRsvpLink || null,
  },
  'appointment.serviceType': {
    path: 'appointment.serviceType',
    label: 'Appointment Service Type',
    valueType: 'text',
    allowedPresets: [
      'fitting_alteration',
      'FITTING_ALTERATION',
      'fitting',
      'alteration',
      'fitting_appointment',
      'alteration_milestone',
    ],
    sampleValue: 'Bridal Trial Fitting',
    formatNote: 'Service type of appointment',
    allowFallback: false,
    needs: ['appointment'],
    resolve: (ctx) => ctx.appointmentServiceType || null,
  },
  'appointment.date': {
    path: 'appointment.date',
    label: 'Appointment Date',
    valueType: 'text',
    allowedPresets: [
      'fitting_alteration',
      'FITTING_ALTERATION',
      'fitting',
      'alteration',
      'fitting_appointment',
      'alteration_milestone',
    ],
    sampleValue: 'Nov 15, 2026',
    formatNote: 'Local date of the appointment',
    allowFallback: false,
    needs: ['appointment'],
    resolve: (ctx) => ctx.appointmentDate || null,
  },
  'appointment.time': {
    path: 'appointment.time',
    label: 'Appointment Time',
    valueType: 'text',
    allowedPresets: [
      'fitting_alteration',
      'FITTING_ALTERATION',
      'fitting',
      'alteration',
      'fitting_appointment',
      'alteration_milestone',
    ],
    sampleValue: '03:30 PM',
    formatNote: 'Local time of the appointment',
    allowFallback: false,
    needs: ['appointment'],
    resolve: (ctx) => ctx.appointmentTime || null,
  },
  'appointment.branch': {
    path: 'appointment.branch',
    label: 'Appointment Branch',
    valueType: 'text',
    allowedPresets: [
      'fitting_alteration',
      'FITTING_ALTERATION',
      'fitting',
      'alteration',
      'fitting_appointment',
      'alteration_milestone',
    ],
    sampleValue: 'Boutique Main',
    formatNote: 'Store branch for the appointment',
    allowFallback: true,
    needs: ['appointment'],
    resolve: (ctx) => ctx.appointmentBranch || null,
  },
  'appointment.stylistName': {
    path: 'appointment.stylistName',
    label: 'Stylist Name',
    valueType: 'text',
    allowedPresets: [
      'fitting_alteration',
      'FITTING_ALTERATION',
      'fitting',
      'alteration',
      'fitting_appointment',
      'alteration_milestone',
    ],
    sampleValue: 'Pooja',
    formatNote: 'Assigned stylist or master tailor',
    allowFallback: true,
    needs: ['appointment'],
    resolve: (ctx) => ctx.appointmentStylistName || null,
  },
  'alteration.jobId': {
    path: 'alteration.jobId',
    label: 'Alteration Job ID',
    valueType: 'text',
    allowedPresets: [
      'fitting_alteration',
      'FITTING_ALTERATION',
      'fitting',
      'alteration',
      'fitting_appointment',
      'alteration_milestone',
    ],
    sampleValue: 'ALT-2026-001',
    formatNote: 'Job reference identifier',
    allowFallback: false,
    needs: ['alteration'],
    resolve: (ctx) => ctx.alterationJobId || null,
  },
  'alteration.garment': {
    path: 'alteration.garment',
    label: 'Alteration Garment',
    valueType: 'text',
    allowedPresets: [
      'fitting_alteration',
      'FITTING_ALTERATION',
      'fitting',
      'alteration',
      'fitting_appointment',
      'alteration_milestone',
    ],
    sampleValue: 'Bridal Lehenga Blouse',
    formatNote: 'Garment or piece undergoing alteration',
    allowFallback: false,
    needs: ['alteration'],
    resolve: (ctx) => ctx.alterationGarment || null,
  },
  'alteration.stage': {
    path: 'alteration.stage',
    label: 'Alteration Stage',
    valueType: 'text',
    allowedPresets: [
      'fitting_alteration',
      'FITTING_ALTERATION',
      'fitting',
      'alteration',
      'fitting_appointment',
      'alteration_milestone',
    ],
    sampleValue: 'ready for trial fitting',
    formatNote: 'Current production stage (e.g. stitching, ready for trial)',
    allowFallback: false,
    needs: ['alteration'],
    resolve: (ctx) => ctx.alterationStage || null,
  },
  'alteration.trialDate': {
    path: 'alteration.trialDate',
    label: 'Trial Date',
    valueType: 'text',
    allowedPresets: [
      'fitting_alteration',
      'FITTING_ALTERATION',
      'fitting',
      'alteration',
      'fitting_appointment',
      'alteration_milestone',
    ],
    sampleValue: 'Nov 18, 2026',
    formatNote: 'Scheduled or suggested trial date',
    allowFallback: true,
    needs: ['alteration'],
    resolve: (ctx) => ctx.alterationTrialDate || null,
  },
  'alteration.notes': {
    path: 'alteration.notes',
    label: 'Alteration Notes',
    valueType: 'text',
    allowedPresets: [
      'fitting_alteration',
      'FITTING_ALTERATION',
      'fitting',
      'alteration',
      'fitting_appointment',
      'alteration_milestone',
    ],
    sampleValue: 'Please visit our store for your trial',
    formatNote: 'Specific instructions or tailor notes',
    allowFallback: true,
    needs: ['alteration'],
    resolve: (ctx) => ctx.alterationNotes || null,
  },
  'order.number': {
    path: 'order.number',
    label: 'Order Number',
    valueType: 'text',
    allowedPresets: [
      'outfit_collection_delivery',
      'OUTFIT_COLLECTION_DELIVERY',
      'outfit_fulfilment',
      'fulfilment_milestone',
      'outfit_collection',
    ],
    sampleValue: 'ORD-9824',
    formatNote: "The fulfilment order's own number, sanitized",
    allowFallback: false,
    needs: ['fulfilment'],
    resolve: (ctx) => {
      const val = ctx.fulfilmentOrderNumber || (ctx.order as any)?.orderNumber;
      if (!val || typeof val !== 'string') return null;
      const cleaned = val.replace(/[\r\n\t]+/g, ' ').trim();
      return cleaned || null;
    },
  },
  'shipment.carrierName': {
    path: 'shipment.carrierName',
    label: 'Carrier / Courier Name',
    valueType: 'text',
    allowedPresets: [
      'outfit_collection_delivery',
      'OUTFIT_COLLECTION_DELIVERY',
      'outfit_fulfilment',
      'fulfilment_milestone',
      'outfit_collection',
    ],
    sampleValue: 'BlueDart Express',
    formatNote: 'Courier or delivery carrier name, sanitized',
    allowFallback: false,
    needs: ['fulfilment'],
    resolve: (ctx) => {
      const val = ctx.shipmentCarrierName;
      if (!val || typeof val !== 'string') return null;
      const cleaned = val.replace(/[\r\n\t]+/g, ' ').trim();
      return cleaned || null;
    },
  },
  'shipment.trackingRef': {
    path: 'shipment.trackingRef',
    label: 'Shipment Tracking Reference',
    valueType: 'text',
    allowedPresets: [
      'outfit_collection_delivery',
      'OUTFIT_COLLECTION_DELIVERY',
      'outfit_fulfilment',
      'fulfilment_milestone',
      'outfit_collection',
    ],
    sampleValue: 'BD123456789IN',
    formatNote: 'Tracking number or tracking URL, sanitized',
    allowFallback: false,
    needs: ['fulfilment'],
    resolve: (ctx) => {
      const val = ctx.shipmentTrackingRef;
      if (!val || typeof val !== 'string') return null;
      const cleaned = val.replace(/[\r\n\t]+/g, ' ').trim();
      return cleaned || null;
    },
  },
};

/**
 * Checks if a given binding source is allowed for a given campaign preset.
 */
export function isSourceAllowedForPreset(sourcePath: string, presetId?: string): boolean {
  const def = BINDING_SOURCES[sourcePath];
  if (!def) return false;
  if (def.allowedPresets.includes('*')) return true;
  if (!presetId) return false;

  const normalizedPreset = presetId.toUpperCase().replace(/-/g, '_');
  return def.allowedPresets.some((p) => {
    if (p === '*') return true;
    const norm = p.toUpperCase().replace(/-/g, '_');
    return norm === normalizedPreset;
  });
}

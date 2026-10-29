import { describe, expect, it } from 'vitest';
import { computeOfferPrice, formatPaiseInr } from '@grovastra/shared';
import { matchSelectedStock } from '../src/presets/selectedStockPromotion/matching';
import { validateSelectedStockOffer } from '../src/presets/selectedStockPromotion/offerValidation';
import { computeDueTimes } from '../src/presets/_shared/eventDelay/delayTiming';

describe('Selected-stock promotion foundations (F27)', () => {
  it('SP01: rejects a published selected-stock offer with no items', () => {
    const result = validateSelectedStockOffer({
      offerId: 'off_invalid',
      kind: 'SELECTED_STOCK',
      name: 'Invalid',
      status: 'ACTIVE',
      validFrom: new Date('2026-10-01T00:00:00Z'),
      validUntil: new Date('2026-11-01T00:00:00Z'),
      discount: { type: 'PERCENT_OFF', percent: 20 },
      items: [],
    }, [], new Date('2026-10-02T00:00:00Z'));
    expect(result).toEqual({ valid: false, reason: 'at least one item is required' });
  });

  it('SP02: rejects a selected-stock item whose computed offer price is invalid', () => {
    const result = validateSelectedStockOffer({
      offerId: 'off_invalid_price',
      kind: 'SELECTED_STOCK',
      name: 'Invalid price',
      status: 'ACTIVE',
      validFrom: new Date('2026-10-01T00:00:00Z'),
      validUntil: new Date('2026-11-01T00:00:00Z'),
      discount: { type: 'FLAT_OFF', flatOffPaise: 10001 },
      items: [{ productId: 'prd_1', position: 0 }],
    }, [{ productId: 'prd_1', pricePaise: 10000 }], new Date('2026-10-02T00:00:00Z'));
    expect(result).toEqual({ valid: false, reason: 'invalid computed price for productId: prd_1' });
  });

  it('SP04: computes integer paise prices and Indian display values', () => {
    expect(computeOfferPrice(10001, { type: 'PERCENT_OFF', percent: 20 })).toBe(8001);
    expect(computeOfferPrice(10000, { type: 'FLAT_OFF', flatOffPaise: 500 })).toBe(9500);
    expect(computeOfferPrice(10000, { type: 'SPECIAL_PRICE' }, { offerPricePaise: 7500 })).toBe(7500);
    expect(formatPaiseInr(125050)).toBe('₹1,250.50');
  });

  it('SP05: uses the computed offer price for budget matching', () => {
    const result = matchSelectedStock(
      { customerId: 'cus_1', preferences: { weaves: ['silk'], budgetMaxPaise: 1600000, source: 'MOCK' } },
      [{
        productId: 'prd_1', name: 'Silk Saree', category: 'saree', weave: 'silk', colourFamily: 'red',
        pricePaise: 2000000, status: 'ACTIVE', entityVersion: 1,
        variants: [{ variantId: 'v1', sellableQty: 1 }],
      }],
      { items: [{ productId: 'prd_1', position: 0 }], discount: { type: 'PERCENT_OFF', percent: 20 } },
    );
    expect(result.matched).toBe(true);
    expect(result.items[0].offerPricePaise).toBe(1600000);
  });

  it('SP06: caps selected-stock execution expiry at offer validUntil', () => {
    const timing = computeDueTimes({
      anchorAt: new Date('2026-10-28T08:00:00Z'),
      delay: { unit: 'HOURS', value: 1 },
      settings: {
        allowedSendingHours: { start: '10:00', end: '19:00' },
        timezone: 'Asia/Kolkata',
      },
      outsideHoursPolicy: 'DEFER_NEXT_DAY',
      maxDeferralHours: 24,
      maxLatenessMinutes: 720,
      offerValidUntil: new Date('2026-10-28T10:30:00Z'),
      now: new Date('2026-10-28T08:00:00Z'),
    });
    expect(timing.expiresAt.getTime()).toBeLessThanOrEqual(new Date('2026-10-28T10:30:00Z').getTime());
  });

  it('SP03: rejects duplicate products and invalid discount prices', () => {
    const result = validateSelectedStockOffer({
      offerId: 'off_1', kind: 'SELECTED_STOCK', name: 'Offer', status: 'DRAFT',
      validFrom: new Date('2026-10-01T00:00:00Z'), validUntil: new Date('2026-11-01T00:00:00Z'),
      discount: { type: 'PERCENT_OFF', percent: 20 },
      items: [{ productId: 'prd_1', position: 0 }, { productId: 'prd_1', position: 1 }],
    }, [{ productId: 'prd_1', pricePaise: 10000 }], new Date('2026-10-02T00:00:00Z'));
    expect(result).toEqual({ valid: false, reason: 'duplicate productId: prd_1' });
  });

  it('SP07: ignores inferred preferences when matching selected stock', () => {
    const result = matchSelectedStock(
      { customerId: 'cus_1', preferences: { weave: 'silk', source: 'INFERRED', budgetMaxPaise: 2000000 } },
      [{ productId: 'prd_1', name: 'Silk Saree', category: 'saree', weave: 'silk', pricePaise: 1000000, status: 'ACTIVE', entityVersion: 1, variants: [{ variantId: 'v1', sellableQty: 1 }] }],
      { items: [{ productId: 'prd_1', position: 0 }], discount: { type: 'PERCENT_OFF', percent: 10 } },
    );
    expect(result.matchReasons).not.toContain('weave');
  });

  it('SP08: excludes inactive and unsellable selected-stock items', () => {
    const result = matchSelectedStock(
      { customerId: 'cus_1', preferences: { budgetMaxPaise: 2000000 } },
      [
        { productId: 'prd_inactive', name: 'Inactive', pricePaise: 1000000, status: 'DISCONTINUED', entityVersion: 1, variants: [{ variantId: 'v1', sellableQty: 2 }] },
        { productId: 'prd_empty', name: 'Empty', pricePaise: 1000000, status: 'ACTIVE', entityVersion: 1, variants: [{ variantId: 'v1', sellableQty: 0 }] },
      ],
      { items: [{ productId: 'prd_inactive', position: 0 }, { productId: 'prd_empty', position: 1 }], discount: { type: 'PERCENT_OFF', percent: 10 } },
    );
    expect(result.matched).toBe(false);
    expect(result.items).toHaveLength(0);
  });

  it('SP09: ranks matching items by preference score then offer position', () => {
    const result = matchSelectedStock(
      { customerId: 'cus_1', preferences: { weave: 'silk', budgetMaxPaise: 2000000 } },
      [
        { productId: 'prd_later', name: 'Later', weave: 'silk', pricePaise: 1000000, status: 'ACTIVE', entityVersion: 1, variants: [{ variantId: 'v1', sellableQty: 1 }] },
        { productId: 'prd_first', name: 'First', weave: 'silk', pricePaise: 1000000, status: 'ACTIVE', entityVersion: 1, variants: [{ variantId: 'v1', sellableQty: 1 }] },
      ],
      { items: [{ productId: 'prd_later', position: 1 }, { productId: 'prd_first', position: 0 }], discount: { type: 'PERCENT_OFF', percent: 10 } },
    );
    expect(result.items[0].productId).toBe('prd_first');
  });
});

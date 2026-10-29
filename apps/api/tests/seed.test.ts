import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { connectToDatabase, disconnectDatabase } from '../src/db/connection';
import { seedDatabase, seedReset } from '../src/db/seed';
import { SrcCustomerModel } from '../src/db/models/src-customer.model';
import { SrcCustomerEventModel } from '../src/db/models/src-customer-event.model';
import { SrcOrderModel } from '../src/db/models/src-order.model';

describe('Seed Repeatability & Edge Cases (Spec p24, p29)', () => {
  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    await connectToDatabase();
    await seedReset(true);
  });

  afterAll(async () => {
    await disconnectDatabase();
  });

  it('runs seedDatabase cleanly on first execution', async () => {
    const summary1 = await seedDatabase('base');
    expect(summary1.shopACount).toBeGreaterThanOrEqual(38);
    expect(summary1.shopBCount).toBe(5);
    expect(summary1.eventsCount).toBeGreaterThanOrEqual(4);
    expect(summary1.ordersCount).toBeGreaterThanOrEqual(5);
  });

  it('seed is repeatable: running a second time produces identical counts without errors', async () => {
    const summary2 = await seedDatabase('base');
    expect(summary2.shopACount).toBeGreaterThanOrEqual(38);
    expect(summary2.shopBCount).toBe(5);

    // Verify database document counts match summary exactly
    const dbCustomersA = await SrcCustomerModel.countDocuments({ tenantId: 'shop_a' });
    const dbCustomersB = await SrcCustomerModel.countDocuments({ tenantId: 'shop_b' });
    expect(dbCustomersA).toBe(summary2.shopACount);
    expect(dbCustomersB).toBe(summary2.shopBCount);

    // Running a 3rd time also succeeds (strictly idempotent & repeatable)
    const summary3 = await seedDatabase('base');
    expect(summary3.shopACount).toBe(summary2.shopACount);
  });

  it('includes all required customer edge cases in seeded data', async () => {
    // 1. Birthday Jan 5
    const jan05 = await SrcCustomerModel.findOne({ tenantId: 'shop_a', customerId: 'cus_bday_jan05' }).lean();
    expect(jan05).not.toBeNull();
    expect(jan05?.birthday).toEqual({ month: 1, day: 5 });

    // 2. Birthday Feb 29 (Leap Year)
    const feb29 = await SrcCustomerModel.findOne({ tenantId: 'shop_a', customerId: 'cus_bday_feb29' }).lean();
    expect(feb29).not.toBeNull();
    expect(feb29?.birthday).toEqual({ month: 2, day: 29 });

    // 3. Birthday Dec 31 (Year End)
    const dec31 = await SrcCustomerModel.findOne({ tenantId: 'shop_a', customerId: 'cus_bday_dec31' }).lean();
    expect(dec31).not.toBeNull();
    expect(dec31?.birthday).toEqual({ month: 12, day: 31 });

    // 4. Opted out
    const optedOut = await SrcCustomerModel.findOne({ tenantId: 'shop_a', customerId: 'cus_opted_out' }).lean();
    expect(optedOut?.consent.marketingOptIn).toBe(false);

    // 5. Channel suppressed
    const suppressed = await SrcCustomerModel.findOne({ tenantId: 'shop_a', customerId: 'cus_channel_suppressed' });
    expect(suppressed?.consent.channelSuppressed).toBe(true);

    // 6. Deleted
    const deleted = await SrcCustomerModel.findOne({ tenantId: 'shop_a', customerId: 'cus_deleted' });
    expect(deleted?.deletedAt).not.toBeNull();
    expect(deleted?.status).toBe('DELETED');

    // 7. No birthday
    const noBday = await SrcCustomerModel.findOne({ tenantId: 'shop_a', customerId: 'cus_no_birthday' });
    expect(noBday?.birthday).toBeNull();

    // 8. Two records sharing one phone (household phone collision)
    const h1 = await SrcCustomerModel.findOne({ tenantId: 'shop_a', customerId: 'cus_household_1' });
    const h2 = await SrcCustomerModel.findOne({ tenantId: 'shop_a', customerId: 'cus_household_2' });
    expect(h1).not.toBeNull();
    expect(h2).not.toBeNull();
    expect(h1?.destination.destinationHash).toBe(h2?.destination.destinationHash);
    expect(h1?.customerId).not.toBe(h2?.customerId);

    // 9. Two with an anniversary
    const ev1 = await SrcCustomerEventModel.findOne({ tenantId: 'shop_a', eventId: 'evt_anniv_001' });
    const ev2 = await SrcCustomerEventModel.findOne({ tenantId: 'shop_a', eventId: 'evt_anniv_002' });
    expect(ev1).not.toBeNull();
    expect(ev2).not.toBeNull();

    // 10. One with multiple saved anniversaries
    const multiEvs = await SrcCustomerEventModel.find({ tenantId: 'shop_a', customerId: 'cus_multi_anniv' });
    expect(multiEvs.length).toBeGreaterThanOrEqual(2);

    // 11. Orders with different statuses
    const paidOrder = await SrcOrderModel.findOne({ tenantId: 'shop_a', status: 'COMPLETED', paid: true });
    const pendingOrder = await SrcOrderModel.findOne({ tenantId: 'shop_a', status: 'PENDING', paid: false });
    const cancelledOrder = await SrcOrderModel.findOne({ tenantId: 'shop_a', status: 'CANCELLED' });
    const partiallyRefunded = await SrcOrderModel.findOne({ tenantId: 'shop_a', status: 'PARTIALLY_REFUNDED' });
    const taggedOccasion = await SrcOrderModel.findOne({ tenantId: 'shop_a', occasionRef: 'birthday:2027' });

    expect(paidOrder).not.toBeNull();
    expect(pendingOrder).not.toBeNull();
    expect(cancelledOrder).not.toBeNull();
    expect(partiallyRefunded).not.toBeNull();
    expect(taggedOccasion).not.toBeNull();
    expect(taggedOccasion?.netPaise).toBe(580000);
  });
});

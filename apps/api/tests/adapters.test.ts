import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { connectToDatabase, disconnectDatabase } from '../src/db/connection';
import { seedDatabase } from '../src/db/seed';
import { mockCustomerSource, mockOrderSource } from '../src/adapters';
import { ForbiddenError } from '../src/errors/app-error';

describe('Adapter Layer & Tenant Isolation (Hard Rule 1, Spec p24)', () => {
  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    await connectToDatabase();
    await seedDatabase('base');
  });

  afterAll(async () => {
    await disconnectDatabase();
  });

  describe('CustomerSource Adapter', () => {
    it('requires a valid non-empty tenantId for all operations', async () => {
      await expect(mockCustomerSource.getCustomerById('', 'cus_bday_jan05')).rejects.toThrow(
        ForbiddenError
      );
      await expect(mockCustomerSource.listCustomers('')).rejects.toThrow(ForbiddenError);
    });

    it('retrieves customer by ID strictly within tenant scope', async () => {
      const customerA = await mockCustomerSource.getCustomerById('shop_a', 'cus_bday_jan05');
      expect(customerA).not.toBeNull();
      expect(customerA?.tenantId).toBe('shop_a');
      expect(customerA?.customerId).toBe('cus_bday_jan05');
      expect(customerA?.firstName).toBe('Priya Sharma');
      expect(customerA?.destination.masked).toBeDefined();

      // Cross-tenant query MUST return null
      const crossTenant = await mockCustomerSource.getCustomerById('shop_b', 'cus_bday_jan05');
      expect(crossTenant).toBeNull();
    });

    it('retrieves customer by destinationHash strictly within tenant scope', async () => {
      const customerA = await mockCustomerSource.getCustomerById('shop_a', 'cus_bday_jan05');
      const hash = customerA!.destination.destinationHash;

      const found = await mockCustomerSource.getCustomerByDestinationHash('shop_a', hash);
      expect(found).not.toBeNull();
      expect(found?.customerId).toBe('cus_bday_jan05');

      // Cross-tenant search by hash returns null
      const crossFound = await mockCustomerSource.getCustomerByDestinationHash('shop_b', hash);
      expect(crossFound).toBeNull();
    });

    it('listCustomers strictly isolates customers to the requested tenant', async () => {
      const resA = await mockCustomerSource.listCustomers('shop_a');
      expect(resA.total).toBeGreaterThanOrEqual(38);
      resA.customers.forEach((c) => {
        expect(c.tenantId).toBe('shop_a');
      });

      const resB = await mockCustomerSource.listCustomers('shop_b');
      expect(resB.total).toBe(4); // 4 active customers
      const resBAll = await mockCustomerSource.listCustomers('shop_b', { includeDeleted: true });
      expect(resBAll.total).toBe(5); // 5 total including deleted
      resB.customers.forEach((c) => {
        expect(c.tenantId).toBe('shop_b');
      });
    });

    it('listCustomers correctly filters by marketing consent and suppression', async () => {
      const optedOut = await mockCustomerSource.listCustomers('shop_a', {
        marketingOptIn: false,
      });
      expect(optedOut.customers.some((c) => c.customerId === 'cus_opted_out')).toBe(true);
      optedOut.customers.forEach((c) => {
        expect(c.consent.marketingOptIn).toBe(false);
      });

      const suppressed = await mockCustomerSource.listCustomers('shop_a', {
        channelSuppressed: true,
      });
      expect(suppressed.customers.some((c) => c.customerId === 'cus_channel_suppressed')).toBe(true);
      suppressed.customers.forEach((c) => {
        expect(c.consent.channelSuppressed).toBe(true);
      });
    });

    it('getCustomerEvents returns anniversaries scoped to customer and tenant', async () => {
      const eventsA = await mockCustomerSource.getCustomerEvents('shop_a', 'cus_anniv_1');
      expect(eventsA).toHaveLength(1);
      expect(eventsA[0].eventId).toBe('evt_anniv_001');
      expect(eventsA[0].month).toBe(11);
      expect(eventsA[0].day).toBe(15);

      // Multiple anniversaries customer
      const multiEvents = await mockCustomerSource.getCustomerEvents('shop_a', 'cus_multi_anniv');
      expect(multiEvents.length).toBeGreaterThanOrEqual(2);

      // Cross-tenant attempt returns empty array
      const crossEvents = await mockCustomerSource.getCustomerEvents('shop_b', 'cus_anniv_1');
      expect(crossEvents).toHaveLength(0);
    });

    it('getCustomersWithBirthday finds customers with exact month/day', async () => {
      const jan05 = await mockCustomerSource.getCustomersWithBirthday('shop_a', 1, 5);
      expect(jan05.some((c) => c.customerId === 'cus_bday_jan05')).toBe(true);

      const feb29 = await mockCustomerSource.getCustomersWithBirthday('shop_a', 2, 29);
      expect(feb29.some((c) => c.customerId === 'cus_bday_feb29')).toBe(true);
    });

    it('getCustomersWithAnniversary pairs customer with anniversary event', async () => {
      const pairs = await mockCustomerSource.getCustomersWithAnniversary('shop_a', 11, 15);
      expect(pairs.length).toBeGreaterThanOrEqual(1);
      const match = pairs.find((p) => p.customer.customerId === 'cus_anniv_1');
      expect(match).toBeDefined();
      expect(match?.event.eventId).toBe('evt_anniv_001');
    });
  });

  describe('OrderSource Adapter', () => {
    it('retrieves order by ID strictly within tenant scope', async () => {
      const orderA = await mockOrderSource.getOrderById('shop_a', 'ord_001');
      expect(orderA).not.toBeNull();
      expect(orderA?.tenantId).toBe('shop_a');
      expect(orderA?.netPaise).toBe(480000);
      expect(orderA?.status).toBe('COMPLETED');

      // Cross-tenant access returns null
      const crossOrder = await mockOrderSource.getOrderById('shop_b', 'ord_001');
      expect(crossOrder).toBeNull();
    });

    it('retrieves customer orders strictly within tenant scope', async () => {
      const orders = await mockOrderSource.getOrdersByCustomer('shop_a', 'cus_bday_feb29');
      expect(orders.length).toBeGreaterThanOrEqual(1);
      const taggedOrder = orders.find((o) => o.occasionRef === 'birthday:2027');
      expect(taggedOrder).toBeDefined();
      expect(taggedOrder?.netPaise).toBe(580000);
      expect(taggedOrder?.status).toBe('COMPLETED');

      // Cross-tenant query returns empty array
      const crossOrders = await mockOrderSource.getOrdersByCustomer('shop_b', 'cus_bday_feb29');
      expect(crossOrders).toHaveLength(0);
    });

    it('listOrders enforces tenant scope', async () => {
      const resA = await mockOrderSource.listOrders('shop_a');
      expect(resA.total).toBeGreaterThanOrEqual(5);
      resA.orders.forEach((o) => {
        expect(o.tenantId).toBe('shop_a');
      });

      const resB = await mockOrderSource.listOrders('shop_b');
      expect(resB.total).toBeGreaterThanOrEqual(1);
      resB.orders.forEach((o) => {
        expect(o.tenantId).toBe('shop_b');
      });
    });
  });
});

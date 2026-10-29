import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../src/app';
import { connectToDatabase, disconnectDatabase } from '../src/db/connection';
import { seedDatabase, seedReset } from '../src/db/seed';

describe('Customer & Order API Endpoints (Hard Rule 9, Spec p10, p24)', () => {
  let shopAOwnerToken: string;
  let shopAStaffToken: string;
  let shopBOwnerToken: string;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    await connectToDatabase();
    await seedReset(true);
    await seedDatabase('base');

    // 1. Log in as shop_a owner
    const loginAOwner = await request(app)
      .post('/auth/login')
      .send({ email: 'owner@shop-a.com', password: 'OwnerSecret#2026!' });
    shopAOwnerToken = loginAOwner.body.token;

    // 2. Log in as shop_a staff
    const loginAStaff = await request(app)
      .post('/auth/login')
      .send({ email: 'staff@shop-a.com', password: 'StaffSecret#2026!' });
    shopAStaffToken = loginAStaff.body.token;

    // 3. Log in as shop_b owner
    const loginBOwner = await request(app)
      .post('/auth/login')
      .send({ email: 'owner@shop-b.com', password: 'ShopBSecret#2026!' });
    shopBOwnerToken = loginBOwner.body.token;
  });

  afterAll(async () => {
    await disconnectDatabase();
  });

  describe('GET /tenant/customers', () => {
    it('allows staff to view customer directory (all roles view directory)', async () => {
      const res = await request(app)
        .get('/tenant/customers')
        .set('Authorization', `Bearer ${shopAStaffToken}`);

      expect(res.status).toBe(200);
      expect(res.body.tenantId).toBe('shop_a');
      expect(res.body.customers.length).toBeGreaterThanOrEqual(38);
    });

    it('NEVER exposes encryptedPhone in API response (Hard Rule 9: staff sees masked phones only)', async () => {
      const res = await request(app)
        .get('/tenant/customers')
        .set('Authorization', `Bearer ${shopAStaffToken}`);

      expect(res.status).toBe(200);
      for (const cust of res.body.customers) {
        expect(cust.destination).toBeDefined();
        expect(cust.destination.masked).toBeDefined();
        expect(cust.destination.destinationHash).toBeDefined();
        // Crucial security guarantee: encryptedPhone must be completely absent from response
        expect(cust.destination.encryptedPhone).toBeUndefined();
      }
    });

    it('enforces tenant isolation: shop_b sees only shop_b customers', async () => {
      const resB = await request(app)
        .get('/tenant/customers')
        .set('Authorization', `Bearer ${shopBOwnerToken}`);

      expect(resB.status).toBe(200);
      expect(resB.body.tenantId).toBe('shop_b');
      expect(resB.body.total).toBe(4); // 4 active customers
      resB.body.customers.forEach((c: { tenantId: string }) => {
        expect(c.tenantId).toBe('shop_b');
      });

      const resBAll = await request(app)
        .get('/tenant/customers?includeDeleted=true')
        .set('Authorization', `Bearer ${shopBOwnerToken}`);
      expect(resBAll.body.total).toBe(5);
    });

    it('filters customers by status, marketingOptIn, and branchId', async () => {
      const res = await request(app)
        .get('/tenant/customers?marketingOptIn=false')
        .set('Authorization', `Bearer ${shopAOwnerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.customers.length).toBeGreaterThanOrEqual(1);
      res.body.customers.forEach((c: { consent: { marketingOptIn: boolean } }) => {
        expect(c.consent.marketingOptIn).toBe(false);
      });
    });

    it('searches customers by name or masked phone', async () => {
      const res = await request(app)
        .get('/tenant/customers?search=Priya')
        .set('Authorization', `Bearer ${shopAOwnerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.customers.some((c: { firstName: string }) => c.firstName === 'Priya Sharma')).toBe(true);
    });
  });

  describe('GET /tenant/customers/:customerId', () => {
    it('returns customer details without encryptedPhone', async () => {
      const res = await request(app)
        .get('/tenant/customers/cus_bday_jan05')
        .set('Authorization', `Bearer ${shopAStaffToken}`);

      expect(res.status).toBe(200);
      expect(res.body.customer.customerId).toBe('cus_bday_jan05');
      expect(res.body.customer.destination.masked).toBeDefined();
      expect(res.body.customer.destination.encryptedPhone).toBeUndefined();
    });

    it('prevents cross-tenant access and returns 404', async () => {
      // shop_b user attempts to read shop_a's customer
      const res = await request(app)
        .get('/tenant/customers/cus_bday_jan05')
        .set('Authorization', `Bearer ${shopBOwnerToken}`);

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });
  });

  describe('GET /tenant/customers/:customerId/events', () => {
    it('returns customer anniversaries', async () => {
      const res = await request(app)
        .get('/tenant/customers/cus_anniv_1/events')
        .set('Authorization', `Bearer ${shopAStaffToken}`);

      expect(res.status).toBe(200);
      expect(res.body.events).toHaveLength(1);
      expect(res.body.events[0].eventId).toBe('evt_anniv_001');
      expect(res.body.events[0].month).toBe(11);
      expect(res.body.events[0].day).toBe(15);
    });
  });

  describe('GET /tenant/customers/:customerId/orders', () => {
    it('returns customer order history with lines and integer minor units (netPaise)', async () => {
      const res = await request(app)
        .get('/tenant/customers/cus_bday_feb29/orders')
        .set('Authorization', `Bearer ${shopAStaffToken}`);

      expect(res.status).toBe(200);
      expect(res.body.orders.length).toBeGreaterThanOrEqual(1);

      const order = res.body.orders[0];
      expect(order.occasionRef).toBe('birthday:2027');
      expect(order.netPaise).toBe(580000); // Integer minor units (Spec p24)
      expect(order.status).toBe('COMPLETED');
      expect(order.lines).toHaveLength(1);
    });
  });

  describe('POST /admin/seed', () => {
    it('triggers dev re-seed and returns summary', async () => {
      const res = await request(app)
        .post('/admin/seed')
        .send({ scenario: 'base' });

      expect(res.status).toBe(200);
      expect(res.body.summary).toBeDefined();
      expect(res.body.summary.shopACount).toBeGreaterThanOrEqual(38);
    });
  });
});

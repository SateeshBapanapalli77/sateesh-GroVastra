import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { createApp } from '../src/app';
import { connectToDatabase, disconnectDatabase } from '../src/db/connection';
import { config } from '../src/config/env';
import { TenantModel } from '../src/db/models/tenant.model';
import { BranchModel } from '../src/db/models/branch.model';
import { UserModel } from '../src/db/models/user.model';
import { AuditLogModel } from '../src/db/models/audit-log.model';
import { createTenantRepository } from '../src/db/tenant-repository';
import { loginRateLimiter } from '../src/middleware/rate-limiter';
import { AUTH_COOKIE_NAME, ERROR_CODES } from '@grovastra/shared';

describe('GroVastra Auth, RBAC, Multi-Tenancy & Audit Tests', () => {
  const app = createApp();

  let shopAOwnerToken: string;
  let shopAAdminToken: string;
  let shopAStaffToken: string;
  let shopBOwnerToken: string;

  let staffUserId: string;
  let shopBBranchId: string;

  beforeAll(async () => {
    // Connect to test database
    await connectToDatabase(config.MONGODB_URI, config.MONGODB_TEST_DB);

    // Clean up test collections
    await TenantModel.deleteMany({ tenantId: { $in: ['test_shop_a', 'test_shop_b'] } });
    await BranchModel.deleteMany({ tenantId: { $in: ['test_shop_a', 'test_shop_b'] } });
    await UserModel.deleteMany({ tenantId: { $in: ['test_shop_a', 'test_shop_b'] } });
    await mongoose.connection.collection('auditLog').deleteMany({
      tenantId: { $in: ['test_shop_a', 'test_shop_b', 'unauthenticated'] },
    });

    // 1. Seed Tenants
    await TenantModel.insertMany([
      { tenantId: 'test_shop_a', name: 'Test Boutique A', status: 'active' },
      { tenantId: 'test_shop_b', name: 'Test Boutique B', status: 'active' },
    ]);

    // 2. Seed Branches
    const branches = await BranchModel.insertMany([
      { tenantId: 'test_shop_a', branchId: 'test_branch_a1', name: 'Shop A Main', isMain: true },
      { tenantId: 'test_shop_a', branchId: 'test_branch_a2', name: 'Shop A Second', isMain: false },
      { tenantId: 'test_shop_b', branchId: 'test_branch_b1', name: 'Shop B Main', isMain: true },
    ]);
    shopBBranchId = 'test_branch_b1';

    // 3. Seed Users
    const passwordHash = await bcrypt.hash('TestPass#123', 10);
    const users = await UserModel.insertMany([
      {
        tenantId: 'test_shop_a',
        email: 'owner@test-shop-a.com',
        passwordHash,
        role: 'owner',
        branchIds: ['test_branch_a1', 'test_branch_a2'],
        name: 'Shop A Owner',
      },
      {
        tenantId: 'test_shop_a',
        email: 'admin@test-shop-a.com',
        passwordHash,
        role: 'admin',
        branchIds: ['test_branch_a1'],
        name: 'Shop A Admin',
      },
      {
        tenantId: 'test_shop_a',
        email: 'staff@test-shop-a.com',
        passwordHash,
        role: 'staff',
        branchIds: ['test_branch_a1'],
        name: 'Shop A Staff',
      },
      {
        tenantId: 'test_shop_b',
        email: 'owner@test-shop-b.com',
        passwordHash,
        role: 'owner',
        branchIds: ['test_branch_b1'],
        name: 'Shop B Owner',
      },
    ]);

    staffUserId = users.find((u) => u.email === 'staff@test-shop-a.com')!._id.toString();

    // Log in each user to obtain auth tokens & session cookies
    const ownerRes = await request(app)
      .post('/auth/login')
      .send({ email: 'owner@test-shop-a.com', password: 'TestPass#123' });
    shopAOwnerToken = ownerRes.body.token;

    const adminRes = await request(app)
      .post('/auth/login')
      .send({ email: 'admin@test-shop-a.com', password: 'TestPass#123' });
    shopAAdminToken = adminRes.body.token;

    const staffRes = await request(app)
      .post('/auth/login')
      .send({ email: 'staff@test-shop-a.com', password: 'TestPass#123' });
    shopAStaffToken = staffRes.body.token;

    const shopBRes = await request(app)
      .post('/auth/login')
      .send({ email: 'owner@test-shop-b.com', password: 'TestPass#123' });
    shopBOwnerToken = shopBRes.body.token;
  });

  afterAll(async () => {
    // Cleanup test data
    await TenantModel.deleteMany({ tenantId: { $in: ['test_shop_a', 'test_shop_b'] } });
    await BranchModel.deleteMany({ tenantId: { $in: ['test_shop_a', 'test_shop_b'] } });
    await UserModel.deleteMany({ tenantId: { $in: ['test_shop_a', 'test_shop_b'] } });
    await mongoose.connection.collection('auditLog').deleteMany({
      tenantId: { $in: ['test_shop_a', 'test_shop_b', 'unauthenticated'] },
    });

    await disconnectDatabase();
  });

  beforeEach(() => {
    loginRateLimiter.resetAll();
  });

  // ============================================================================
  // 1. Role Matrix Tests
  // ============================================================================
  describe('Role Matrix (RBAC)', () => {
    it('owner can access campaigns, settings, and staff routes', async () => {
      // Campaigns
      const campaignsRes = await request(app)
        .get('/campaigns')
        .set('Authorization', `Bearer ${shopAOwnerToken}`);
      expect(campaignsRes.status).toBe(200);

      // Settings
      const settingsRes = await request(app)
        .get('/settings')
        .set('Authorization', `Bearer ${shopAOwnerToken}`);
      expect(settingsRes.status).toBe(200);

      // Branches (Staff route)
      const branchesRes = await request(app)
        .get('/tenant/branches')
        .set('Authorization', `Bearer ${shopAOwnerToken}`);
      expect(branchesRes.status).toBe(200);
      expect(branchesRes.body.branches).toHaveLength(2);
    });

    it('admin can access campaigns and settings', async () => {
      const campaignsRes = await request(app)
        .get('/campaigns')
        .set('Authorization', `Bearer ${shopAAdminToken}`);
      expect(campaignsRes.status).toBe(200);

      const settingsRes = await request(app)
        .get('/settings')
        .set('Authorization', `Bearer ${shopAAdminToken}`);
      expect(settingsRes.status).toBe(200);
    });

    it('staff CANNOT access campaigns (returns 403 Forbidden)', async () => {
      const campaignsRes = await request(app)
        .get('/campaigns')
        .set('Authorization', `Bearer ${shopAStaffToken}`);

      expect(campaignsRes.status).toBe(403);
      expect(campaignsRes.body.error.code).toBe(ERROR_CODES.FORBIDDEN);
    });

    it('staff CANNOT access settings (returns 403 Forbidden)', async () => {
      const settingsRes = await request(app)
        .get('/settings')
        .set('Authorization', `Bearer ${shopAStaffToken}`);

      expect(settingsRes.status).toBe(403);
      expect(settingsRes.body.error.code).toBe(ERROR_CODES.FORBIDDEN);
    });

    it('staff CAN access staff-allowed routes (activity & branches)', async () => {
      const branchesRes = await request(app)
        .get('/tenant/branches')
        .set('Authorization', `Bearer ${shopAStaffToken}`);
      expect(branchesRes.status).toBe(200);

      const activityRes = await request(app)
        .get('/tenant/activity')
        .set('Authorization', `Bearer ${shopAStaffToken}`);
      expect(activityRes.status).toBe(200);
    });

    it('staff CANNOT change user roles (returns 403 Forbidden)', async () => {
      const roleRes = await request(app)
        .post(`/tenant/users/${staffUserId}/role`)
        .set('Authorization', `Bearer ${shopAStaffToken}`)
        .send({ role: 'admin' });

      expect(roleRes.status).toBe(403);
      expect(roleRes.body.error.code).toBe(ERROR_CODES.FORBIDDEN);
    });

    it('admin CANNOT promote a user to owner (returns 403 Forbidden)', async () => {
      const roleRes = await request(app)
        .post(`/tenant/users/${staffUserId}/role`)
        .set('Authorization', `Bearer ${shopAAdminToken}`)
        .send({ role: 'owner' });

      expect(roleRes.status).toBe(403);
      expect(roleRes.body.error.code).toBe(ERROR_CODES.FORBIDDEN);
    });

    it('owner CAN update staff to admin', async () => {
      const roleRes = await request(app)
        .post(`/tenant/users/${staffUserId}/role`)
        .set('Authorization', `Bearer ${shopAOwnerToken}`)
        .send({ role: 'admin' });

      expect(roleRes.status).toBe(200);
      expect(roleRes.body.user.role).toBe('admin');
    });
  });

  // ============================================================================
  // 2. Multi-Tenancy & Cross-Tenant Access Protection
  // ============================================================================
  describe('Multi-Tenancy & Cross-Tenant Isolation', () => {
    it('shop_a user cannot read shop_b branch by guessing ID (returns 404)', async () => {
      const res = await request(app)
        .get(`/tenant/branches/${shopBBranchId}`)
        .set('Authorization', `Bearer ${shopAOwnerToken}`);

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe(ERROR_CODES.NOT_FOUND);
    });

    it('shop_b user CAN read shop_b branch', async () => {
      const res = await request(app)
        .get(`/tenant/branches/${shopBBranchId}`)
        .set('Authorization', `Bearer ${shopBOwnerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.branchId).toBe(shopBBranchId);
      expect(res.body.tenantId).toBe('test_shop_b');
    });

    it('TenantRepository helper forces tenantId on all queries', async () => {
      const repoA = createTenantRepository('test_shop_a', BranchModel);
      const branchesA = await repoA.find();
      expect(branchesA.length).toBe(2);
      expect(branchesA.every((b) => b.tenantId === 'test_shop_a')).toBe(true);

      const repoB = createTenantRepository('test_shop_b', BranchModel);
      const branchesB = await repoB.find();
      expect(branchesB.length).toBe(1);
      expect(branchesB[0].tenantId).toBe('test_shop_b');
    });

    it('TenantRepository throws ForbiddenError if caller supplies a conflicting tenantId', async () => {
      const repoA = createTenantRepository('test_shop_a', BranchModel);
      expect(() => repoA.find({ tenantId: 'test_shop_b' })).toThrowError(/Cross-tenant access violation/);
    });
  });

  // ============================================================================
  // 3. Audit Log Entries & Immutability Tests
  // ============================================================================
  describe('Audit Log Append-Only Guarantees', () => {
    it('writes audit entry on successful login', async () => {
      await request(app)
        .post('/auth/login')
        .send({ email: 'owner@test-shop-a.com', password: 'TestPass#123' });

      const logs = await AuditLogModel.find({
        tenantId: 'test_shop_a',
        action: 'auth.login_success',
      });
      expect(logs.length).toBeGreaterThan(0);
      expect(logs[0].tenantId).toBe('test_shop_a');
    });

    it('writes audit entry on failed login', async () => {
      await request(app)
        .post('/auth/login')
        .send({ email: 'owner@test-shop-a.com', password: 'WrongPassword!' });

      const logs = await AuditLogModel.find({
        tenantId: 'test_shop_a',
        action: 'auth.login_failed',
      });
      expect(logs.length).toBeGreaterThan(0);
    });

    it('writes audit entry on user role change', async () => {
      await request(app)
        .post(`/tenant/users/${staffUserId}/role`)
        .set('Authorization', `Bearer ${shopAOwnerToken}`)
        .send({ role: 'staff' });

      const logs = await AuditLogModel.find({
        tenantId: 'test_shop_a',
        action: 'user.role_changed',
      });
      expect(logs.length).toBeGreaterThan(0);
      expect(logs[logs.length - 1].metadata?.newRole).toBe('staff');
    });

    it('rejects update operations on auditLog model through app code', async () => {
      await expect(
        AuditLogModel.updateOne({ tenantId: 'test_shop_a' }, { action: 'hacked.action' })
      ).rejects.toThrow(/AuditLog is strictly append-only/);

      await expect(
        AuditLogModel.findOneAndUpdate({ tenantId: 'test_shop_a' }, { action: 'hacked.action' })
      ).rejects.toThrow(/AuditLog is strictly append-only/);
    });

    it('rejects delete operations on auditLog model through app code', async () => {
      await expect(
        AuditLogModel.deleteOne({ tenantId: 'test_shop_a' })
      ).rejects.toThrow(/AuditLog is strictly append-only/);

      await expect(
        AuditLogModel.deleteMany({ tenantId: 'test_shop_a' })
      ).rejects.toThrow(/AuditLog is strictly append-only/);
    });
  });

  // ============================================================================
  // 4. Rate Limiting Tests
  // ============================================================================
  describe('Login Rate Limiter', () => {
    it('blocks login after 5 failed attempts with 429 RATE_LIMIT_EXCEEDED', async () => {
      const email = 'rate-limit-test@shop-a.com';

      // 5 failed attempts
      for (let i = 0; i < 5; i++) {
        const res = await request(app)
          .post('/auth/login')
          .send({ email, password: 'WrongPassword' });
        expect(res.status).toBe(401);
      }

      // 6th attempt should be blocked with 429
      const blockedRes = await request(app)
        .post('/auth/login')
        .send({ email, password: 'WrongPassword' });

      expect(blockedRes.status).toBe(429);
      expect(blockedRes.body.error.code).toBe(ERROR_CODES.RATE_LIMIT_EXCEEDED);
      expect(blockedRes.headers['retry-after']).toBeDefined();
    });
  });
});

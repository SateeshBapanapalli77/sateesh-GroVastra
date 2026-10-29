import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../src/app';
import { connectToDatabase, disconnectDatabase } from '../src/db/connection';
import { seedDatabase } from '../src/db/seed';
import { AuditLogModel } from '../src/db/models/audit-log.model';
import { CampaignSettingsModel } from '../src/db/models/campaign-settings.model';

describe('Campaign Settings & Tenant Policy (Spec p7, p17, p18, p26, C16)', () => {
  let shopAOwnerToken: string;
  let shopAAdminToken: string;
  let shopAStaffToken: string;
  let shopBOwnerToken: string;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    await connectToDatabase();
    await seedDatabase('base');

    // 1. Log in as shop_a owner
    const loginAOwner = await request(app)
      .post('/auth/login')
      .send({ email: 'owner@shop-a.com', password: 'OwnerSecret#2026!' });
    shopAOwnerToken = loginAOwner.body.token;

    // 2. Log in as shop_a admin
    const loginAAdmin = await request(app)
      .post('/auth/login')
      .send({ email: 'admin@shop-a.com', password: 'AdminSecret#2026!' });
    shopAAdminToken = loginAAdmin.body.token;

    // 3. Log in as shop_a staff
    const loginAStaff = await request(app)
      .post('/auth/login')
      .send({ email: 'staff@shop-a.com', password: 'StaffSecret#2026!' });
    shopAStaffToken = loginAStaff.body.token;

    // 4. Log in as shop_b owner
    const loginBOwner = await request(app)
      .post('/auth/login')
      .send({ email: 'owner@shop-b.com', password: 'ShopBSecret#2026!' });
    shopBOwnerToken = loginBOwner.body.token;
  });

  afterAll(async () => {
    await disconnectDatabase();
  });

  // ==========================================================================
  // 1. Role-Based Access Controls
  // ==========================================================================
  describe('RBAC & Route Permissions (Owner/Admin write; Staff read)', () => {
    it('allows staff to READ campaign settings (GET /campaign-settings)', async () => {
      const res = await request(app)
        .get('/campaign-settings')
        .set('Authorization', `Bearer ${shopAStaffToken}`);

      expect(res.status).toBe(200);
      expect(res.body.tenantId).toBe('shop_a');
      expect(res.body.version).toBeGreaterThanOrEqual(1);
      expect(res.body.timezone).toBe('Asia/Kolkata');
      expect(res.body.allowedSendingHours).toEqual({ start: '10:00', end: '19:00' });
      expect(res.body.marketingCaps).toEqual({ daily: 1, weekly: 3 });
      expect(res.body.resumePolicy).toBe('FUTURE_ONLY');
      expect(res.body.importPolicy).toBe('FUTURE_ONLY');
    });

    it('supports alias /api/v1/campaign-settings for GET', async () => {
      const res = await request(app)
        .get('/api/v1/campaign-settings')
        .set('Authorization', `Bearer ${shopAStaffToken}`);

      expect(res.status).toBe(200);
      expect(res.body.tenantId).toBe('shop_a');
    });

    it('rejects unauthenticated requests to GET /campaign-settings with 401', async () => {
      const res = await request(app).get('/campaign-settings');
      expect(res.status).toBe(401);
      expect(res.body.error?.code).toBe('UNAUTHORIZED');
    });

    it('FORBIDS staff from updating campaign settings (PATCH /campaign-settings -> 403 Forbidden)', async () => {
      const res = await request(app)
        .patch('/campaign-settings')
        .set('Authorization', `Bearer ${shopAStaffToken}`)
        .set('Idempotency-Key', 'idem-staff-attempt-1')
        .send({
          expectedVersion: 1,
          timezone: 'Asia/Kolkata',
        });

      expect(res.status).toBe(403);
      expect(res.body.error?.code).toBe('FORBIDDEN');
    });

    it('rejects unauthenticated requests to PATCH /campaign-settings with 401', async () => {
      const res = await request(app)
        .patch('/campaign-settings')
        .set('Idempotency-Key', 'idem-unauth-attempt')
        .send({ expectedVersion: 1 });

      expect(res.status).toBe(401);
      expect(res.body.error?.code).toBe('UNAUTHORIZED');
    });

    it('allows admin to update campaign settings', async () => {
      // First get current settings
      const getRes = await request(app)
        .get('/campaign-settings')
        .set('Authorization', `Bearer ${shopAAdminToken}`);
      const currentVersion = getRes.body.version;

      const patchRes = await request(app)
        .patch('/campaign-settings')
        .set('Authorization', `Bearer ${shopAAdminToken}`)
        .set('Idempotency-Key', `idem-admin-update-${Date.now()}`)
        .send({
          expectedVersion: currentVersion,
          serviceContactSpacingHours: 36,
        });

      expect(patchRes.status).toBe(200);
      expect(patchRes.body.serviceContactSpacingHours).toBe(36);
      expect(patchRes.body.version).toBe(currentVersion + 1);
    });
  });

  // ==========================================================================
  // 2. Optimistic Concurrency (409 Conflict) & Idempotency
  // ==========================================================================
  describe('Optimistic Concurrency & Version Conflict Handling (Spec p26, C16)', () => {
    it('returns 409 Conflict when expectedVersion does not match current database version', async () => {
      const getRes = await request(app)
        .get('/campaign-settings')
        .set('Authorization', `Bearer ${shopAOwnerToken}`);
      const currentVersion = getRes.body.version;

      // Provide a stale expectedVersion (e.g. currentVersion - 1 or 999)
      const staleVersion = currentVersion + 5;
      const res = await request(app)
        .patch('/campaign-settings')
        .set('Authorization', `Bearer ${shopAOwnerToken}`)
        .set('Idempotency-Key', `idem-stale-${Date.now()}`)
        .send({
          expectedVersion: staleVersion,
          timezone: 'Asia/Kolkata',
        });

      expect(res.status).toBe(409);
      expect(res.body.error?.code).toBe('CONFLICT');
      expect(res.body.error?.message).toContain('version conflict');
      expect(res.body.error?.details).toEqual({
        expectedVersion: staleVersion,
        currentVersion,
      });
    });

    it('rejects PATCH when Idempotency-Key header is missing with 400', async () => {
      const getRes = await request(app)
        .get('/campaign-settings')
        .set('Authorization', `Bearer ${shopAOwnerToken}`);

      const res = await request(app)
        .patch('/campaign-settings')
        .set('Authorization', `Bearer ${shopAOwnerToken}`)
        .send({
          expectedVersion: getRes.body.version,
          timezone: 'Asia/Kolkata',
        });

      expect(res.status).toBe(400);
      expect(res.body.error?.code).toBe('VALIDATION_ERROR');
      expect(res.body.error?.message).toContain('Idempotency-Key');
    });

    it('rejects PATCH when expectedVersion is missing with 400', async () => {
      const res = await request(app)
        .patch('/campaign-settings')
        .set('Authorization', `Bearer ${shopAOwnerToken}`)
        .set('Idempotency-Key', `idem-no-ver-${Date.now()}`)
        .send({
          timezone: 'Asia/Kolkata',
        });

      expect(res.status).toBe(400);
      expect(res.body.error?.code).toBe('VALIDATION_ERROR');
      expect(res.body.error?.message).toContain('expectedVersion');
    });

    it('repeating the same Idempotency-Key returns cached response without incrementing version or re-auditing', async () => {
      const getRes = await request(app)
        .get('/campaign-settings')
        .set('Authorization', `Bearer ${shopAOwnerToken}`);
      const currentVersion = getRes.body.version;

      const stableIdemKey = `idem-repeatable-${Date.now()}`;

      // First call
      const firstRes = await request(app)
        .patch('/campaign-settings')
        .set('Authorization', `Bearer ${shopAOwnerToken}`)
        .set('Idempotency-Key', stableIdemKey)
        .send({
          expectedVersion: currentVersion,
          serviceContactSpacingHours: 48,
        });

      expect(firstRes.status).toBe(200);
      const newVersion = firstRes.body.version;
      expect(newVersion).toBe(currentVersion + 1);

      // Audit count before replay
      const auditCountBefore = await AuditLogModel.countDocuments({
        tenantId: 'shop_a',
        action: 'campaign_settings.updated',
      });

      // Second call with same idempotency key and original expectedVersion
      const secondRes = await request(app)
        .patch('/campaign-settings')
        .set('Authorization', `Bearer ${shopAOwnerToken}`)
        .set('Idempotency-Key', stableIdemKey)
        .send({
          expectedVersion: currentVersion,
          serviceContactSpacingHours: 48,
        });

      expect(secondRes.status).toBe(200);
      expect(secondRes.body.version).toBe(newVersion);
      expect(secondRes.body.serviceContactSpacingHours).toBe(48);

      // Verify no duplicate audit event was appended
      const auditCountAfter = await AuditLogModel.countDocuments({
        tenantId: 'shop_a',
        action: 'campaign_settings.updated',
      });
      expect(auditCountAfter).toBe(auditCountBefore);
    });
  });

  // ==========================================================================
  // 3. Validation Edge Cases
  // ==========================================================================
  describe('Validation Edge Cases (Spec p7, p17, p18)', () => {
    it('rejects invalid IANA timezone with 400', async () => {
      const getRes = await request(app)
        .get('/campaign-settings')
        .set('Authorization', `Bearer ${shopAOwnerToken}`);

      const res = await request(app)
        .patch('/campaign-settings')
        .set('Authorization', `Bearer ${shopAOwnerToken}`)
        .set('Idempotency-Key', `idem-inv-tz-${Date.now()}`)
        .send({
          expectedVersion: getRes.body.version,
          timezone: 'Mars/Phobos_Crater',
        });

      expect(res.status).toBe(400);
      expect(res.body.error?.code).toBe('VALIDATION_ERROR');
    });

    it('accepts valid IANA timezones (e.g. UTC, Asia/Kolkata, Europe/London)', async () => {
      const getRes = await request(app)
        .get('/campaign-settings')
        .set('Authorization', `Bearer ${shopAOwnerToken}`);

      const res = await request(app)
        .patch('/campaign-settings')
        .set('Authorization', `Bearer ${shopAOwnerToken}`)
        .set('Idempotency-Key', `idem-val-tz-${Date.now()}`)
        .send({
          expectedVersion: getRes.body.version,
          timezone: 'Europe/London',
        });

      expect(res.status).toBe(200);
      expect(res.body.timezone).toBe('Europe/London');
    });

    it('rejects equal sending start and end hours with 400 (spec p7 requires non-zero window)', async () => {
      const getRes = await request(app)
        .get('/campaign-settings')
        .set('Authorization', `Bearer ${shopAOwnerToken}`);

      const res = await request(app)
        .patch('/campaign-settings')
        .set('Authorization', `Bearer ${shopAOwnerToken}`)
        .set('Idempotency-Key', `idem-equal-hours-${Date.now()}`)
        .send({
          expectedVersion: getRes.body.version,
          allowedSendingHours: { start: '10:00', end: '10:00' },
        });

      expect(res.status).toBe(400);
      expect(res.body.error?.code).toBe('VALIDATION_ERROR');
    });

    it('rejects overnight sending hours with 400 (spec p7 rejects overnight hours in v1)', async () => {
      const getRes = await request(app)
        .get('/campaign-settings')
        .set('Authorization', `Bearer ${shopAOwnerToken}`);

      const res = await request(app)
        .patch('/campaign-settings')
        .set('Authorization', `Bearer ${shopAOwnerToken}`)
        .set('Idempotency-Key', `idem-overnight-${Date.now()}`)
        .send({
          expectedVersion: getRes.body.version,
          allowedSendingHours: { start: '20:00', end: '06:00' },
        });

      expect(res.status).toBe(400);
      expect(res.body.error?.code).toBe('VALIDATION_ERROR');
    });

    it('accepts valid sending window where start is strictly before end (e.g. 09:30 to 18:30)', async () => {
      const getRes = await request(app)
        .get('/campaign-settings')
        .set('Authorization', `Bearer ${shopAOwnerToken}`);

      const res = await request(app)
        .patch('/campaign-settings')
        .set('Authorization', `Bearer ${shopAOwnerToken}`)
        .set('Idempotency-Key', `idem-valid-hours-${Date.now()}`)
        .send({
          expectedVersion: getRes.body.version,
          allowedSendingHours: { start: '09:30', end: '18:30' },
        });

      expect(res.status).toBe(200);
      expect(res.body.allowedSendingHours).toEqual({ start: '09:30', end: '18:30' });
    });

    it('rejects loosening marketing caps beyond tenant maximum (daily > 1 per 24h) with 400', async () => {
      const getRes = await request(app)
        .get('/campaign-settings')
        .set('Authorization', `Bearer ${shopAOwnerToken}`);

      const res = await request(app)
        .patch('/campaign-settings')
        .set('Authorization', `Bearer ${shopAOwnerToken}`)
        .set('Idempotency-Key', `idem-loosen-daily-${Date.now()}`)
        .send({
          expectedVersion: getRes.body.version,
          marketingCaps: { daily: 2, weekly: 3 },
        });

      expect(res.status).toBe(400);
      expect(res.body.error?.code).toBe('VALIDATION_ERROR');
    });

    it('rejects loosening marketing caps beyond tenant maximum (weekly > 3 per 7d) with 400', async () => {
      const getRes = await request(app)
        .get('/campaign-settings')
        .set('Authorization', `Bearer ${shopAOwnerToken}`);

      const res = await request(app)
        .patch('/campaign-settings')
        .set('Authorization', `Bearer ${shopAOwnerToken}`)
        .set('Idempotency-Key', `idem-loosen-weekly-${Date.now()}`)
        .send({
          expectedVersion: getRes.body.version,
          marketingCaps: { daily: 1, weekly: 5 },
        });

      expect(res.status).toBe(400);
      expect(res.body.error?.code).toBe('VALIDATION_ERROR');
    });

    it('allows tightening marketing caps (e.g. weekly: 2, or weekly: 1)', async () => {
      const getRes = await request(app)
        .get('/campaign-settings')
        .set('Authorization', `Bearer ${shopAOwnerToken}`);

      const res = await request(app)
        .patch('/campaign-settings')
        .set('Authorization', `Bearer ${shopAOwnerToken}`)
        .set('Idempotency-Key', `idem-tighten-weekly-${Date.now()}`)
        .send({
          expectedVersion: getRes.body.version,
          marketingCaps: { daily: 1, weekly: 2 },
        });

      expect(res.status).toBe(200);
      expect(res.body.marketingCaps).toEqual({ daily: 1, weekly: 2 });
    });

    it('rejects invalid calendar dates in blackout dates (e.g. 2026-02-30) with 400', async () => {
      const getRes = await request(app)
        .get('/campaign-settings')
        .set('Authorization', `Bearer ${shopAOwnerToken}`);

      const res = await request(app)
        .patch('/campaign-settings')
        .set('Authorization', `Bearer ${shopAOwnerToken}`)
        .set('Idempotency-Key', `idem-inv-date-${Date.now()}`)
        .send({
          expectedVersion: getRes.body.version,
          blackoutDates: ['2026-02-30'],
        });

      expect(res.status).toBe(400);
      expect(res.body.error?.code).toBe('VALIDATION_ERROR');
    });

    it('accepts valid calendar blackout dates and holiday objects', async () => {
      const getRes = await request(app)
        .get('/campaign-settings')
        .set('Authorization', `Bearer ${shopAOwnerToken}`);

      const res = await request(app)
        .patch('/campaign-settings')
        .set('Authorization', `Bearer ${shopAOwnerToken}`)
        .set('Idempotency-Key', `idem-valid-dates-${Date.now()}`)
        .send({
          expectedVersion: getRes.body.version,
          blackoutDates: ['2026-11-15', '2026-12-31'],
          holidays: [
            { date: '2026-11-01', name: 'Diwali Celebration' },
            { date: '2026-12-25', name: 'Christmas Day' },
          ],
        });

      expect(res.status).toBe(200);
      expect(res.body.blackoutDates).toEqual(['2026-11-15', '2026-12-31']);
      expect(res.body.holidays).toHaveLength(2);
      expect(res.body.holidays[0]).toEqual({ date: '2026-11-01', name: 'Diwali Celebration' });
    });

    it('rejects unauthorized resumePolicy or importPolicy alterations (must be FUTURE_ONLY)', async () => {
      const getRes = await request(app)
        .get('/campaign-settings')
        .set('Authorization', `Bearer ${shopAOwnerToken}`);

      const res = await request(app)
        .patch('/campaign-settings')
        .set('Authorization', `Bearer ${shopAOwnerToken}`)
        .set('Idempotency-Key', `idem-inv-policy-${Date.now()}`)
        .send({
          expectedVersion: getRes.body.version,
          resumePolicy: 'CATCH_UP',
        });

      expect(res.status).toBe(400);
      expect(res.body.error?.code).toBe('VALIDATION_ERROR');
    });

    it('rejects out-of-bounds priority ranges (< 1 or > 100) with 400', async () => {
      const getRes = await request(app)
        .get('/campaign-settings')
        .set('Authorization', `Bearer ${shopAOwnerToken}`);

      const res = await request(app)
        .patch('/campaign-settings')
        .set('Authorization', `Bearer ${shopAOwnerToken}`)
        .set('Idempotency-Key', `idem-inv-pri-${Date.now()}`)
        .send({
          expectedVersion: getRes.body.version,
          priorityAllowlistRanges: { birthday: 105 },
        });

      expect(res.status).toBe(400);
      expect(res.body.error?.code).toBe('VALIDATION_ERROR');
    });

    it('accepts custom priorities within bounded 1-100 range', async () => {
      const getRes = await request(app)
        .get('/campaign-settings')
        .set('Authorization', `Bearer ${shopAOwnerToken}`);

      const res = await request(app)
        .patch('/campaign-settings')
        .set('Authorization', `Bearer ${shopAOwnerToken}`)
        .set('Idempotency-Key', `idem-val-pri-${Date.now()}`)
        .send({
          expectedVersion: getRes.body.version,
          priorityAllowlistRanges: { birthday: 85, wedding: 75, winBack: 40 },
        });

      expect(res.status).toBe(200);
      expect(res.body.priorityAllowlistRanges.birthday).toBe(85);
      expect(res.body.priorityAllowlistRanges.wedding).toBe(75);
      expect(res.body.priorityAllowlistRanges.winBack).toBe(40);
    });
  });

  // ==========================================================================
  // 4. Tenant Isolation (Hard Rule 1)
  // ==========================================================================
  describe('Tenant Isolation (Hard Rule 1)', () => {
    it('isolates campaign settings between shop_a and shop_b strictly', async () => {
      // 1. Get shop_b settings
      const resBBefore = await request(app)
        .get('/campaign-settings')
        .set('Authorization', `Bearer ${shopBOwnerToken}`);
      expect(resBBefore.body.tenantId).toBe('shop_b');
      const bOriginalSpacing = resBBefore.body.serviceContactSpacingHours;

      // 2. Modify shop_a settings
      const resA = await request(app)
        .get('/campaign-settings')
        .set('Authorization', `Bearer ${shopAOwnerToken}`);

      await request(app)
        .patch('/campaign-settings')
        .set('Authorization', `Bearer ${shopAOwnerToken}`)
        .set('Idempotency-Key', `idem-shopa-iso-${Date.now()}`)
        .send({
          expectedVersion: resA.body.version,
          serviceContactSpacingHours: 72,
        });

      // 3. Verify shop_b settings are unaffected
      const resBAfter = await request(app)
        .get('/campaign-settings')
        .set('Authorization', `Bearer ${shopBOwnerToken}`);
      expect(resBAfter.body.tenantId).toBe('shop_b');
      expect(resBAfter.body.serviceContactSpacingHours).toBe(bOriginalSpacing);
    });
  });

  // ==========================================================================
  // 5. Audit Log Entry Verification
  // ==========================================================================
  describe('Audit Log Entries (Spec p3, p26)', () => {
    it('appends an immutable audit log entry with old/new snapshots upon successful patch', async () => {
      const getRes = await request(app)
        .get('/campaign-settings')
        .set('Authorization', `Bearer ${shopAOwnerToken}`);
      const currentVersion = getRes.body.version;

      const patchRes = await request(app)
        .patch('/campaign-settings')
        .set('Authorization', `Bearer ${shopAOwnerToken}`)
        .set('Idempotency-Key', `idem-audit-verify-${Date.now()}`)
        .send({
          expectedVersion: currentVersion,
          outageGraceHours: 4,
        });

      expect(patchRes.status).toBe(200);

      // Verify audit log has campaign_settings.updated
      const auditLog = await AuditLogModel.findOne({
        tenantId: 'shop_a',
        action: 'campaign_settings.updated',
      }).sort({ createdAt: -1 });

      expect(auditLog).not.toBeNull();
      expect(auditLog?.metadata).toBeDefined();
      expect(auditLog?.metadata?.expectedVersion).toBe(currentVersion);
      expect(auditLog?.metadata?.newVersion).toBe(currentVersion + 1);
      expect((auditLog?.metadata?.new as any)?.outageGraceHours).toBe(4);
      expect((auditLog?.metadata?.old as any)?.outageGraceHours).toBe(getRes.body.outageGraceHours);
    });
  });
});

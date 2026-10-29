import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import mongoose from 'mongoose';
import { connectToDatabase, disconnectDatabase } from '../src/db/connection';
import {
  seedReset,
  seedBase,
  seedScenario,
  seedDemo,
  seedPurgeMock,
  seedStatus,
  seedDatabase,
  verifySeedEnvironment,
  DEV_COLLECTIONS_LIST,
} from '../src/db/seed';
import { CampaignModel } from '../src/db/models/campaign.model';
import { CampaignVersionModel } from '../src/db/models/campaign-version.model';
import { SrcCustomerModel } from '../src/db/models/src-customer.model';
import { SrcCustomerEventModel } from '../src/db/models/src-customer-event.model';
import { SrcOrderModel } from '../src/db/models/src-order.model';
import { SrcTemplateModel } from '../src/db/models/src-template.model';
import { SrcConnectionModel } from '../src/db/models/src-connection.model';
import { SrcOfferModel } from '../src/db/models/src-offer.model';
import { SrcEnquiryModel } from '../src/db/models/src-enquiry.model';
import { SrcProductModel } from '../src/db/models/src-product.model';
import { TenantModel } from '../src/db/models/tenant.model';
import { BranchModel } from '../src/db/models/branch.model';
import { UserModel } from '../src/db/models/user.model';
import { CampaignSettingsModel } from '../src/db/models/campaign-settings.model';
import { AuditLogModel } from '../src/db/models/audit-log.model';
import { DevSeedStateModel } from '../src/db/models/dev-seed-state.model';
import { auditService } from '../src/services/audit.service';
import { dryRunService } from '../src/services/dry-run.service';
import { config } from '../src/config/env';
import { logger } from '../src/logger/logger';

describe('Seed Policy Cleanup & Additive Architecture (F24b, SD01-SD12)', () => {
  const originalEnv = { ...process.env };

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    (config as any).LIVE_CUSTOMER_PHONES = '+919876543210';
    process.env.LIVE_CUSTOMER_PHONES = '+919876543210';
    await connectToDatabase();
  });

  afterAll(async () => {
    process.env = originalEnv;
    await disconnectDatabase();
  });

  // SD01: Applying scenario A then B keeps A's rows intact; only additive writes occur
  it('SD01: Applying scenario A then scenario B leaves scenario A rows intact (additive isolation)', async () => {
    await seedReset(true);
    await seedBase();

    // 1. Seed Scenario A (welcome)
    await seedScenario('welcome');
    const welcomeCampaign = await CampaignModel.findOne({ campaignId: 'cmp_wel_order_mode' }).lean();
    expect(welcomeCampaign).not.toBeNull();
    expect(welcomeCampaign?.seedGroup).toBe('welcome');

    const welcomeOrdersCountBefore = await SrcOrderModel.countDocuments({ seedGroup: 'welcome' });
    const welcomeEventsCountBefore = await SrcCustomerEventModel.countDocuments({ seedGroup: 'welcome' });
    expect(welcomeOrdersCountBefore).toBeGreaterThan(0);

    const totalCampaignsBefore = await CampaignModel.countDocuments();
    expect(totalCampaignsBefore).toBe(1);

    // 2. Seed Scenario B (gift-wedding)
    await seedScenario('gift-wedding');

    // 3. Verify Scenario A documents were untouched
    const welcomeCampaignAfter = await CampaignModel.findOne({ campaignId: 'cmp_wel_order_mode' }).lean();
    expect(welcomeCampaignAfter).not.toBeNull();
    expect(welcomeCampaignAfter?.name).toBe(welcomeCampaign?.name);

    const welcomeOrdersCountAfter = await SrcOrderModel.countDocuments({ seedGroup: 'welcome' });
    const welcomeEventsCountAfter = await SrcCustomerEventModel.countDocuments({ seedGroup: 'welcome' });
    expect(welcomeOrdersCountAfter).toBe(welcomeOrdersCountBefore);
    expect(welcomeEventsCountAfter).toBe(welcomeEventsCountBefore);

    // 4. Verify Scenario B documents exist and total campaigns increased
    const weddingCampaign = await CampaignModel.findOne({ campaignId: 'cmp_gift_wedding_shop_a' }).lean();
    expect(weddingCampaign).not.toBeNull();
    expect(weddingCampaign?.seedGroup).toBe('gift-wedding');

    const totalCampaignsAfter = await CampaignModel.countDocuments();
    expect(totalCampaignsAfter).toBeGreaterThan(totalCampaignsBefore);
  });

  // SD02: Applying every scenario twice leaves collection document counts unchanged (idempotence)
  it('SD02: Each scenario applied twice leaves collection document counts unchanged (idempotence)', async () => {
    await seedReset(true);
    await seedBase();

    const scenarios = ['welcome', 'gift-wedding', 'first-repeat', 'unresolved-enquiry', 'complete-outfit'];

    for (const sc of scenarios) {
      // First application
      await seedScenario(sc);
      const counts1 = {
        campaigns: await CampaignModel.countDocuments(),
        versions: await CampaignVersionModel.countDocuments(),
        customers: await SrcCustomerModel.countDocuments(),
        orders: await SrcOrderModel.countDocuments(),
        events: await SrcCustomerEventModel.countDocuments(),
        enquiries: await SrcEnquiryModel.countDocuments(),
        products: await SrcProductModel.countDocuments(),
      };

      // Second application
      await seedScenario(sc);
      const counts2 = {
        campaigns: await CampaignModel.countDocuments(),
        versions: await CampaignVersionModel.countDocuments(),
        customers: await SrcCustomerModel.countDocuments(),
        orders: await SrcOrderModel.countDocuments(),
        events: await SrcCustomerEventModel.countDocuments(),
        enquiries: await SrcEnquiryModel.countDocuments(),
        products: await SrcProductModel.countDocuments(),
      };

      expect(counts2).toEqual(counts1);
    }
  });

  // SD03: seed:scenario <name> --reset removes only that scenario's rows and dependents, then reapplies
  it('SD03: seed:scenario <name> --reset removes only that scenario rows and reapplies cleanly without touching other scenarios or platform data', async () => {
    await seedReset(true);
    await seedBase();
    await seedScenario('welcome');
    await seedScenario('gift-wedding');

    const platformUsersCountBefore = await UserModel.countDocuments({ seedGroup: 'core' });
    const platformTemplatesCountBefore = await SrcTemplateModel.countDocuments({ seedGroup: 'core' });
    const weddingCampaignsBefore = await CampaignModel.countDocuments({ seedGroup: 'gift-wedding' });
    const weddingEventsBefore = await SrcCustomerEventModel.countDocuments({ seedGroup: 'gift-wedding' });

    expect(weddingCampaignsBefore).toBeGreaterThan(0);
    expect(weddingEventsBefore).toBeGreaterThan(0);

    // Reset Scenario A (welcome)
    await seedScenario('welcome', { reset: true });

    // Verify Scenario B (gift-wedding) is 100% untouched
    const weddingCampaignsAfter = await CampaignModel.countDocuments({ seedGroup: 'gift-wedding' });
    const weddingEventsAfter = await SrcCustomerEventModel.countDocuments({ seedGroup: 'gift-wedding' });
    expect(weddingCampaignsAfter).toBe(weddingCampaignsBefore);
    expect(weddingEventsAfter).toBe(weddingEventsBefore);

    // Verify Platform data is 100% untouched
    const platformUsersCountAfter = await UserModel.countDocuments({ seedGroup: 'core' });
    const platformTemplatesCountAfter = await SrcTemplateModel.countDocuments({ seedGroup: 'core' });
    expect(platformUsersCountAfter).toBe(platformUsersCountBefore);
    expect(platformTemplatesCountAfter).toBe(platformTemplatesCountBefore);

    // Verify Welcome scenario re-applied cleanly
    const welcomeCampaign = await CampaignModel.findOne({ campaignId: 'cmp_wel_order_mode' });
    expect(welcomeCampaign).not.toBeNull();
    expect(welcomeCampaign?.seedGroup).toBe('welcome');
  });

  // SD04: seed:base creates zero campaigns; every document has seedGroup and source: "MOCK"
  it('SD04: seed:base creates zero campaigns; every document has seedGroup: "core" and source: "MOCK" on mock documents', async () => {
    await seedReset(true);
    await seedBase();

    // 1. Exactly 0 campaigns created
    const campaignCount = await CampaignModel.countDocuments();
    expect(campaignCount).toBe(0);

    const versionCount = await CampaignVersionModel.countDocuments();
    expect(versionCount).toBe(0);

    // 2. Platform documents have seedGroup: 'core'
    const tenants = await TenantModel.find().lean();
    expect(tenants.length).toBeGreaterThan(0);
    expect(tenants.every((t) => t.seedGroup === 'core')).toBe(true);

    const branches = await BranchModel.find().lean();
    expect(branches.length).toBeGreaterThan(0);
    expect(branches.every((b) => b.seedGroup === 'core')).toBe(true);

    const users = await UserModel.find().lean();
    expect(users.length).toBeGreaterThan(0);
    expect(users.every((u) => u.seedGroup === 'core')).toBe(true);

    const settings = await CampaignSettingsModel.find().lean();
    expect(settings.length).toBeGreaterThan(0);
    expect(settings.every((s) => s.seedGroup === 'core')).toBe(true);

    const templates = await SrcTemplateModel.find().lean();
    expect(templates.length).toBeGreaterThan(0);
    expect(templates.every((t) => t.seedGroup === 'core')).toBe(true);

    const connections = await SrcConnectionModel.find().lean();
    expect(connections.length).toBeGreaterThan(0);
    expect(connections.every((c) => c.seedGroup === 'core')).toBe(true);

    // 3. Mock source documents have source: 'MOCK' and seedGroup: 'core'
    const mockCustomers = await SrcCustomerModel.find({ isLive: { $ne: true } }).lean();
    expect(mockCustomers.length).toBeGreaterThan(0);
    expect(mockCustomers.every((c) => c.source === 'MOCK' && c.seedGroup === 'core')).toBe(true);

    const mockOrders = await SrcOrderModel.find().lean();
    expect(mockOrders.length).toBeGreaterThan(0);
    expect(mockOrders.every((o) => o.source === 'MOCK' && o.seedGroup === 'core')).toBe(true);

    const mockEvents = await SrcCustomerEventModel.find().lean();
    expect(mockEvents.length).toBeGreaterThan(0);
    expect(mockEvents.every((e) => e.source === 'MOCK' && e.seedGroup === 'core')).toBe(true);
  });

  // SD05: Live customer handover removes previous owner's live state; without --live live customer is untouched
  it('SD05: Live customer handover removes previous owner live state and applies new owner; without --live live customer is untouched', async () => {
    (config as any).LIVE_CUSTOMER_PHONES = '+919876543210';
    process.env.LIVE_CUSTOMER_PHONES = '+919876543210';

    await seedReset(true);
    await seedBase({ live: true });

    const liveCustomer = await SrcCustomerModel.findOne({ tenantId: 'shop_a', isLive: true }).lean();
    expect(liveCustomer).not.toBeNull();
    expect(liveCustomer?.source).toBe('LIVE');

    // Initially liveOwner is null
    const initialState = await DevSeedStateModel.findOne({ tenantId: 'shop_a' }).lean();
    expect(initialState?.liveOwner).toBeNull();

    // 1. Apply Scenario A (welcome) with --live
    // The welcome scenario creates cus_live_welcome_01 with its own order
    await seedScenario('welcome', { live: true });
    const stateAfterWelcome = await DevSeedStateModel.findOne({ tenantId: 'shop_a' }).lean();
    expect(stateAfterWelcome?.liveOwner).toBe('welcome');

    const liveWelcomeCustomer = await SrcCustomerModel.findOne({ tenantId: 'shop_a', customerId: 'cus_live_welcome_01' }).lean();
    expect(liveWelcomeCustomer).not.toBeNull();
    expect(liveWelcomeCustomer?.isLive).toBe(true);
    const liveWelcomeOrders = await SrcOrderModel.find({ tenantId: 'shop_a', customerId: 'cus_live_welcome_01' });
    expect(liveWelcomeOrders.length).toBeGreaterThan(0);

    // 2. Apply Scenario B (gift-wedding) with --live -> Handover occurs
    await seedScenario('gift-wedding', { live: true });
    const stateAfterWedding = await DevSeedStateModel.findOne({ tenantId: 'shop_a' }).lean();
    expect(stateAfterWedding?.liveOwner).toBe('gift-wedding');

    // Handover must wipe cus_live_welcome_01 and their orders
    const liveWelcomeCustomerAfterHandover = await SrcCustomerModel.findOne({ tenantId: 'shop_a', customerId: 'cus_live_welcome_01' }).lean();
    expect(liveWelcomeCustomerAfterHandover).toBeNull();
    const liveWelcomeOrdersAfterHandover = await SrcOrderModel.find({ tenantId: 'shop_a', customerId: 'cus_live_welcome_01' });
    expect(liveWelcomeOrdersAfterHandover.length).toBe(0);

    // Wedding live records for the base live customer should now exist
    const liveEventsWedding = await SrcCustomerEventModel.find({
      tenantId: 'shop_a',
      customerId: liveCustomer?.customerId,
      seedGroup: 'gift-wedding',
    });
    expect(liveEventsWedding.length).toBeGreaterThan(0);

    // 3. Apply Scenario C (complete-outfit) WITHOUT --live -> Live customer state unchanged
    await seedScenario('complete-outfit', { live: false });
    const stateAfterOutfit = await DevSeedStateModel.findOne({ tenantId: 'shop_a' }).lean();
    expect(stateAfterOutfit?.liveOwner).toBe('gift-wedding'); // Still gift-wedding

    const liveEventsWeddingStillPresent = await SrcCustomerEventModel.find({
      tenantId: 'shop_a',
      customerId: liveCustomer?.customerId,
      seedGroup: 'gift-wedding',
    });
    expect(liveEventsWeddingStillPresent.length).toBe(liveEventsWedding.length);
  });

  // SD06: seed:purge-mock --yes removes mock data and scenario campaigns, preserves platform data & auditLog, and is idempotent
  it('SD06: seed:purge-mock --yes removes mock data and scenario campaigns, preserves platform data and auditLog, and is idempotent', async () => {
    await seedReset(true);
    await seedDemo();

    // Add an audit log entry to ensure it survives
    await auditService.logEvent({
      tenantId: 'shop_a',
      userId: 'usr_owner_a',
      action: 'PLATFORM_INITIALIZED',
      metadata: { purpose: 'Audit preservation test' },
    });

    const tenantsCountBefore = await TenantModel.countDocuments();
    const usersCountBefore = await UserModel.countDocuments();
    const branchesCountBefore = await BranchModel.countDocuments();
    const templatesCountBefore = await SrcTemplateModel.countDocuments();
    const connectionsCountBefore = await SrcConnectionModel.countDocuments();
    const auditLogsCountBefore = await AuditLogModel.countDocuments();

    expect(tenantsCountBefore).toBeGreaterThan(0);
    expect(auditLogsCountBefore).toBeGreaterThan(0);

    // Calling seedPurgeMock without --yes should throw
    await expect(seedPurgeMock(false)).rejects.toThrow('seed:purge-mock requires --yes');

    // First purge
    const purgeResult1 = await seedPurgeMock(true);
    expect(purgeResult1.mockDocumentsPurged).toBeGreaterThan(0);
    expect(purgeResult1.scenarioCampaignsPurged).toBeGreaterThan(0);

    // All mock source data is wiped
    const mockCustomers = await SrcCustomerModel.countDocuments({ source: 'MOCK' });
    const mockOrders = await SrcOrderModel.countDocuments({ source: 'MOCK' });
    const mockEvents = await SrcCustomerEventModel.countDocuments({ source: 'MOCK' });
    const mockEnquiries = await SrcEnquiryModel.countDocuments({ source: 'MOCK' });
    const mockProducts = await SrcProductModel.countDocuments({ source: 'MOCK' });
    expect(mockCustomers).toBe(0);
    expect(mockOrders).toBe(0);
    expect(mockEvents).toBe(0);
    expect(mockEnquiries).toBe(0);
    expect(mockProducts).toBe(0);

    // All scenario campaigns are wiped
    const scenarioCampaigns = await CampaignModel.countDocuments();
    expect(scenarioCampaigns).toBe(0);

    // Platform data & audit logs are preserved!
    expect(await TenantModel.countDocuments()).toBe(tenantsCountBefore);
    expect(await UserModel.countDocuments()).toBe(usersCountBefore);
    expect(await BranchModel.countDocuments()).toBe(branchesCountBefore);
    expect(await SrcTemplateModel.countDocuments()).toBe(templatesCountBefore);
    expect(await SrcConnectionModel.countDocuments()).toBe(connectionsCountBefore);
    expect(await AuditLogModel.countDocuments()).toBe(auditLogsCountBefore);

    // Second purge (idempotence)
    const purgeResult2 = await seedPurgeMock(true);
    expect(purgeResult2.mockDocumentsPurged).toBe(0);
    expect(purgeResult2.scenarioCampaignsPurged).toBe(0);

    // Counts still preserved
    expect(await TenantModel.countDocuments()).toBe(tenantsCountBefore);
    expect(await AuditLogModel.countDocuments()).toBe(auditLogsCountBefore);
  });

  // SD07: seed:reset needs --yes and only wipes development collections
  it('SD07: seed:reset needs --yes and only wipes development collections', async () => {
    // Calling seedReset without confirmation throws
    await expect(seedReset(false)).rejects.toThrow('seed:reset requires --yes');

    // Seed some data first
    await seedBase();
    await seedScenario('welcome');

    expect(await CampaignModel.countDocuments()).toBeGreaterThan(0);
    expect(await SrcCustomerModel.countDocuments()).toBeGreaterThan(0);

    // Reset with confirmation
    await seedReset(true);

    // All development collections in DEV_COLLECTIONS_LIST should now be empty
    for (const collName of DEV_COLLECTIONS_LIST) {
      const count = await mongoose.connection.collection(collName).countDocuments();
      expect(count).toBe(0);
    }
  });

  // SD08: Every seed command refuses NODE_ENV=production, non-dev database name, and missing replica set
  it('SD08: verifySeedEnvironment refuses NODE_ENV=production, non-dev database name, and missing replica set', async () => {
    // 1. Refuse NODE_ENV=production
    process.env.NODE_ENV = 'production';
    await expect(verifySeedEnvironment()).rejects.toThrow('NODE_ENV is "production"');
    process.env.NODE_ENV = 'test';

    // 2. Refuse non-dev database name
    const db = mongoose.connection.db;
    if (db) {
      const originalDbName = db.databaseName;
      Object.defineProperty(db, 'databaseName', { value: 'grovastra_production', configurable: true });
      await expect(verifySeedEnvironment()).rejects.toThrow('is not an allowed development or test database');
      Object.defineProperty(db, 'databaseName', { value: originalDbName, configurable: true });
    }

    // 3. Refuse missing replica set
    if (db) {
      const adminSpy = vi.spyOn(db, 'admin').mockReturnValue({
        command: async () => {
          throw new Error('not running with --replSet');
        },
      } as any);

      await expect(verifySeedEnvironment()).rejects.toThrow('replica set verification failed');
      adminSpy.mockRestore();
    }

    // 4. Verify clean environment succeeds
    await expect(verifySeedEnvironment()).resolves.toBeUndefined();
  });

  // SD09: seed:demo twice is idempotent and leaves live customer's owner unchanged
  it('SD09: seed:demo twice is idempotent and leaves live customer owner unchanged', async () => {
    await seedReset(true);
    await seedDemo();

    const campaignsCount1 = await CampaignModel.countDocuments();
    const customersCount1 = await SrcCustomerModel.countDocuments();
    const ordersCount1 = await SrcOrderModel.countDocuments();
    const state1 = await DevSeedStateModel.findOne({ tenantId: 'shop_a' }).lean();

    expect(campaignsCount1).toBeGreaterThanOrEqual(5);

    // Run seed:demo second time
    await seedDemo();

    const campaignsCount2 = await CampaignModel.countDocuments();
    const customersCount2 = await SrcCustomerModel.countDocuments();
    const ordersCount2 = await SrcOrderModel.countDocuments();
    const state2 = await DevSeedStateModel.findOne({ tenantId: 'shop_a' }).lean();

    expect(campaignsCount2).toBe(campaignsCount1);
    expect(customersCount2).toBe(customersCount1);
    expect(ordersCount2).toBe(ordersCount1);
    expect(state2?.liveOwner).toBe(state1?.liveOwner);
  }, 60000);

  // SD10: Old command aliases (seed:welcome, seed:gift-wedding) still work and print deprecation notice
  it('SD10: Old command aliases print deprecation notice and delegate correctly', async () => {
    await seedReset(true);
    await seedBase();

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Call seedDatabase with 'welcome'
    await seedDatabase('welcome');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('DEPRECATED: seed:welcome and seed:gift-wedding are deprecated. Use seed:scenario welcome instead.')
    );
    const welcomeCampaign = await CampaignModel.findOne({ campaignId: 'cmp_wel_order_mode' });
    expect(welcomeCampaign).not.toBeNull();

    // Call seedDatabase with 'gift-wedding'
    await seedDatabase('gift-wedding');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('DEPRECATED: seed:welcome and seed:gift-wedding are deprecated. Use seed:scenario gift-wedding instead.')
    );
    const weddingCampaign = await CampaignModel.findOne({ campaignId: 'cmp_gift_wedding_shop_a' });
    expect(weddingCampaign).not.toBeNull();

    warnSpy.mockRestore();
  });

  // SD11: Applying an unrelated scenario does not alter the existing campaign's structural data
  it('SD11: Applying an unrelated scenario leaves the existing campaign version and fingerprint unchanged (additive structural isolation)', async () => {
    await seedReset(true);
    await seedBase();
    await seedScenario('welcome');

    // Capture campaign version and fingerprint before
    const campaignBefore = await CampaignModel.findOne({ tenantId: 'shop_a', campaignId: 'cmp_wel_order_mode' }).lean();
    const versionBefore = await CampaignVersionModel.findOne({
      tenantId: 'shop_a',
      campaignId: 'cmp_wel_order_mode',
      version: campaignBefore?.draftVersion,
    }).lean();
    expect(campaignBefore).not.toBeNull();
    expect(versionBefore).not.toBeNull();
    const welcomeCampaignCount = await CampaignModel.countDocuments({ seedGroup: 'welcome' });
    expect(welcomeCampaignCount).toBeGreaterThan(0);

    // Apply unrelated scenario (unresolved-enquiry)
    await seedScenario('unresolved-enquiry');

    // Campaign version and fingerprint must be unchanged
    const campaignAfter = await CampaignModel.findOne({ tenantId: 'shop_a', campaignId: 'cmp_wel_order_mode' }).lean();
    const versionAfter = await CampaignVersionModel.findOne({
      tenantId: 'shop_a',
      campaignId: 'cmp_wel_order_mode',
      version: campaignAfter?.draftVersion,
    }).lean();

    expect(campaignAfter?.activeVersionId).toBe(campaignBefore?.activeVersionId);
    expect(campaignAfter?.status).toBe(campaignBefore?.status);
    expect(campaignAfter?.enabledBranches).toEqual(campaignBefore?.enabledBranches);
    expect(versionAfter?.seedGroup).toBe(versionBefore?.seedGroup);
    expect(versionAfter?.trigger).toEqual(versionBefore?.trigger);
    expect(versionAfter?.steps?.length).toBe(versionBefore?.steps?.length);

    // Welcome campaign count unchanged; enquiry campaign added separately
    const welcomeCampaignCountAfter = await CampaignModel.countDocuments({ seedGroup: 'welcome' });
    expect(welcomeCampaignCountAfter).toBe(welcomeCampaignCount);
    const enquiryCampaign = await CampaignModel.findOne({ seedGroup: 'unresolved-enquiry' });
    expect(enquiryCampaign).not.toBeNull();
  });

  // SD12: No secret or full phone number in captured log output
  it('SD12: No secret or unmasked phone number is logged during any seed command', async () => {
    const rawLivePhone = '+919876543210';
    (config as any).LIVE_CUSTOMER_PHONES = rawLivePhone;
    process.env.LIVE_CUSTOMER_PHONES = rawLivePhone;

    const loggedMessages: string[] = [];
    const collectLog = (...args: any[]) => {
      loggedMessages.push(args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' '));
    };

    const spyLog = vi.spyOn(console, 'log').mockImplementation(collectLog);
    const spyWarn = vi.spyOn(console, 'warn').mockImplementation(collectLog);
    const spyError = vi.spyOn(console, 'error').mockImplementation(collectLog);
    const spyInfo = vi.spyOn(logger, 'info').mockImplementation(collectLog as any);
    const spyLogWarn = vi.spyOn(logger, 'warn').mockImplementation(collectLog as any);
    const spyLogError = vi.spyOn(logger, 'error').mockImplementation(collectLog as any);

    try {
      await seedReset(true);
      await seedBase({ live: true });
      await seedScenario('welcome', { live: true });
      await seedStatus();

      const combinedLogs = loggedMessages.join('\n');

      // 1. Raw unmasked phone must never appear
      expect(combinedLogs).not.toContain(rawLivePhone);
      expect(combinedLogs).not.toContain('9876543210');

      // 2. Raw passwords must never appear
      expect(combinedLogs).not.toContain('OwnerSecret#2026!');
      expect(combinedLogs).not.toContain('AdminSecret#2026!');
      expect(combinedLogs).not.toContain('StaffSecret#2026!');
      expect(combinedLogs).not.toContain('ShopBSecret#2026!');

      // 3. Masked phone should appear where live customer is reported
      expect(combinedLogs).toContain('+91 98*** **210');
    } finally {
      spyLog.mockRestore();
      spyWarn.mockRestore();
      spyError.mockRestore();
      spyInfo.mockRestore();
      spyLogWarn.mockRestore();
      spyLogError.mockRestore();
    }
  });
});

import fs from 'fs';
import path from 'path';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { DateTime } from 'luxon';
import { connectToDatabase, disconnectDatabase } from './connection';
import { TenantModel } from './models/tenant.model';
import { BranchModel } from './models/branch.model';
import { UserModel } from './models/user.model';
import { SrcCustomerModel } from './models/src-customer.model';
import { SrcCustomerEventModel } from './models/src-customer-event.model';
import { SrcOrderModel } from './models/src-order.model';
import { SrcTemplateModel } from './models/src-template.model';
import { SrcConnectionModel } from './models/src-connection.model';
import { CampaignSettingsModel } from './models/campaign-settings.model';
import { CampaignModel } from './models/campaign.model';
import { CampaignVersionModel } from './models/campaign-version.model';
import { CampaignControlGateModel } from './models/campaign-control-gate.model';
import { CampaignEnrollmentModel } from './models/campaign-enrollment.model';
import { CampaignExecutionModel } from './models/campaign-execution.model';
import { CampaignDeliveryIntentModel } from './models/campaign-delivery-intent.model';
import { SrcOfferModel } from './models/src-offer.model';
import { IdempotencyRecordModel } from './models/idempotency-record.model';
import { CampaignEventInboxModel } from './models/campaign-event-inbox.model';
import { CampaignContactGateModel } from './models/campaign-contact-gate.model';
import { CampaignProviderEventModel } from './models/campaign-provider-event.model';
import { CampaignCustomerFactModel } from './models/campaign-customer-fact.model';
import { DevSeedStateModel } from './models/dev-seed-state.model';
import { DEFAULT_CAMPAIGN_SETTINGS, OCCASION_KIND, OCCASION_STATUS } from '@grovastra/shared';
import { auditService } from '../services/audit.service';
import { customerFactsService } from '../services/customer-facts';
import { logger } from '../logger/logger';
import { generateSeedData, CustomerSeedRecord } from './seed-data';
import { encryptPhone, decryptPhone, destinationHash, maskPhone } from '../utils/crypto';
import { config } from '../config/env';
import { clock } from '../services/clock';

// Standard developer credentials for local environment
const SEED_CREDENTIALS = [
  {
    tenantId: 'shop_a',
    tenantName: 'Sample Boutique',
    email: 'owner@shop-a.com',
    role: 'owner' as const,
    branchIds: ['branch_main', 'branch_two'],
    name: 'Aditi Rao (Owner)',
    password: 'OwnerSecret#2026!',
  },
  {
    tenantId: 'shop_a',
    tenantName: 'Sample Boutique',
    email: 'admin@shop-a.com',
    role: 'admin' as const,
    branchIds: ['branch_main'],
    name: 'Kavita Sharma (Admin)',
    password: 'AdminSecret#2026!',
  },
  {
    tenantId: 'shop_a',
    tenantName: 'Sample Boutique',
    email: 'staff@shop-a.com',
    role: 'staff' as const,
    branchIds: ['branch_main'],
    name: 'Rahul Verma (Staff)',
    password: 'StaffSecret#2026!',
  },
  {
    tenantId: 'shop_b',
    tenantName: 'Second Boutique',
    email: 'owner@shop-b.com',
    role: 'owner' as const,
    branchIds: ['branch_b_main'],
    name: 'Vikram Patel (Owner B)',
    password: 'ShopBSecret#2026!',
  },
];

export interface SeedSummary {
  shopACount: number;
  shopBCount: number;
  liveCount: number;
  eventsCount: number;
  ordersCount: number;
  templatesCount: number;
  connectionsCount: number;
  offersCount: number;
}

function loadMetaTemplatesFile() {
  const candidatePaths = [
    path.resolve(process.cwd(), 'docs/meta-templates.json'),
    path.resolve(__dirname, '../../../../docs/meta-templates.json'),
    path.resolve(__dirname, '../../../docs/meta-templates.json'),
  ];
  for (const p of candidatePaths) {
    if (fs.existsSync(p)) {
      return JSON.parse(fs.readFileSync(p, 'utf-8'));
    }
  }
  throw new Error('docs/meta-templates.json not found');
}

export interface SeedOptions {
  live?: boolean;
  reset?: boolean;
}

export const DEV_COLLECTIONS_LIST = [
  'tenants',
  'branches',
  'users',
  'campaignSettings',
  'tenantControlGates',
  'campaigns',
  'campaignVersions',
  'campaignControlGates',
  'campaignEnrollments',
  'campaignExecutions',
  'campaignDeliveryIntents',
  'campaignProviderEvents',
  'campaignGoalEvents',
  'campaignContactGates',
  'campaignEventInbox',
  'campaignEventInboxes',
  'campaignCheckpoints',
  'campaignTombstones',
  'campaignDryRuns',
  'campaignCustomerFacts',
  'idempotencyRecords',
  'auditLog',
  'dev_seedState',
  'src_customers',
  'src_customerEvents',
  'src_customer_events',
  'src_orders',
  'src_offers',
  'src_enquiries',
  'src_products',
  'src_templates',
  'src_connections',
  'src_credits',
  'src_collections',
  'src_appointments',
  'src_alterations',
  'src_fulfilments',
];

export function applySeedLabels<T extends Record<string, any>>(
  docOrDocs: T | T[],
  seedGroup: string,
  isSrcOrMock: boolean = true
): any {
  if (Array.isArray(docOrDocs)) {
    return docOrDocs.map((d) => applySeedLabels(d, seedGroup, isSrcOrMock));
  }
  const result: any = { ...docOrDocs };
  if (!result.seedGroup) {
    result.seedGroup = seedGroup;
  }
  if (isSrcOrMock && !result.source) {
    result.source = 'MOCK';
  } else if (!result.source && result.isLive) {
    result.source = 'LIVE';
  }
  return result;
}

export async function verifySeedEnvironment(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to seed: NODE_ENV is "production"!');
  }
  if (mongoose.connection.readyState !== 1) {
    await connectToDatabase();
  }
  const db = mongoose.connection.db;
  if (!db) {
    throw new Error('Refusing to seed: MongoDB is not connected!');
  }
  const currentDbName = db.databaseName;
  const allowedDbs = [
    process.env.MONGODB_DB,
    process.env.MONGODB_TEST_DB,
    'grovastra_dev',
    'grovastra_test',
  ].filter(Boolean);

  if (!allowedDbs.includes(currentDbName)) {
    throw new Error(`Refusing to seed: Database "${currentDbName}" is not an allowed development or test database!`);
  }

  try {
    const admin = db.admin();
    const status = await admin.command({ replSetGetStatus: 1 });
    if (!status || !status.ok) {
      throw new Error('Refusing to seed: MongoDB is not running as a replica set!');
    }
  } catch (err: any) {
    throw new Error(`Refusing to seed: MongoDB replica set verification failed: ${err.message}`);
  }
}

export async function upsertMany(
  collectionName: string,
  filterKeys: string[],
  docs: any[],
  session?: mongoose.mongo.ClientSession
): Promise<number> {
  if (!docs || docs.length === 0) return 0;
  const col = mongoose.connection.collection(collectionName);
  const ops = docs.map((doc) => {
    const filter: Record<string, any> = {};
    for (const key of filterKeys) {
      if (doc[key] !== undefined) {
        filter[key] = doc[key];
      }
    }
    return {
      updateOne: {
        filter,
        update: { $set: doc },
        upsert: true,
      },
    };
  });
  const res = await col.bulkWrite(ops, { session });
  return (res.upsertedCount || 0) + (res.modifiedCount || 0) + (res.matchedCount || 0);
}

export async function handleLiveCustomerHandover(
  scenario: string,
  session?: mongoose.mongo.ClientSession
): Promise<void> {
  const seedState = await DevSeedStateModel.findOne({ tenantId: 'shop_a' }).session(session || null);
  const prevOwner = seedState?.liveOwner;

  const liveCusts = await SrcCustomerModel.find({ tenantId: 'shop_a', isLive: true }).session(session || null).lean();
  const liveCustIds = liveCusts.map((c: any) => c.customerId);
  const welcomeLiveCusts = await SrcCustomerModel.find({
    tenantId: 'shop_a',
    customerId: { $regex: /^cus_live_welcome_/ },
  }).session(session || null).lean();
  const allLiveCustIds = Array.from(new Set([...liveCustIds, ...welcomeLiveCusts.map((c: any) => c.customerId)]));

  if (allLiveCustIds.length > 0) {
    await SrcOrderModel.deleteMany({ tenantId: 'shop_a', customerId: { $in: allLiveCustIds } }, { session });
    await mongoose.connection.collection('src_fulfilments').deleteMany({ tenantId: 'shop_a', customerId: { $in: allLiveCustIds } }, { session });
    await SrcCustomerEventModel.deleteMany({ tenantId: 'shop_a', customerId: { $in: allLiveCustIds } }, { session });
    await mongoose.connection.collection('src_enquiries').deleteMany({ tenantId: 'shop_a', customerId: { $in: allLiveCustIds } }, { session });
    await CampaignEnrollmentModel.deleteMany({ tenantId: 'shop_a', customerId: { $in: allLiveCustIds } }, { session });
    await CampaignExecutionModel.deleteMany({ tenantId: 'shop_a', customerId: { $in: allLiveCustIds } }, { session });
    await CampaignDeliveryIntentModel.deleteMany({ tenantId: 'shop_a', customerId: { $in: allLiveCustIds } }, { session });
    await SrcCustomerModel.deleteMany({ tenantId: 'shop_a', customerId: { $regex: /^cus_live_welcome_/ } }, { session });
  }

  await DevSeedStateModel.updateOne(
    { tenantId: 'shop_a' },
    {
      $set: { liveOwner: scenario, appliedAt: new Date() },
      $addToSet: { appliedScenarios: scenario },
    },
    { upsert: true, session }
  );

  let maskedNumber = 'unknown';
  if (liveCusts[0]?.destination?.encryptedPhone) {
    try {
      maskedNumber = maskPhone(decryptPhone(liveCusts[0].destination.encryptedPhone));
    } catch {
      maskedNumber = 'encrypted';
    }
  } else if (config.LIVE_CUSTOMER_PHONES) {
    maskedNumber = maskPhone(config.LIVE_CUSTOMER_PHONES.split(',')[0]);
  }
  console.log(`[LIVE HANDOVER] Live customer (${maskedNumber}) handed over from "${prevOwner || 'none'}" to "${scenario}".`);
}

export async function resetScenario(scenario: string): Promise<void> {
  await connectToDatabase();
  await verifySeedEnvironment();

  console.log(`\n[RESET SCENARIO] Resetting scenario "${scenario}"...`);

  const campaigns = await CampaignModel.find({ seedGroup: scenario }).lean();
  const campaignIds = campaigns.map((c: any) => c.campaignId);

  if (campaignIds.length > 0) {
    await CampaignModel.deleteMany({ seedGroup: scenario });
    await mongoose.connection.collection('campaignVersions').deleteMany({ seedGroup: scenario });
    await CampaignControlGateModel.deleteMany({ seedGroup: scenario });

    await CampaignEnrollmentModel.deleteMany({ campaignId: { $in: campaignIds } });
    await CampaignExecutionModel.deleteMany({ campaignId: { $in: campaignIds } });
    await CampaignDeliveryIntentModel.deleteMany({ campaignId: { $in: campaignIds } });
    await CampaignProviderEventModel.deleteMany({ campaignId: { $in: campaignIds } });
    await CampaignContactGateModel.deleteMany({ 'ledger.campaignId': { $in: campaignIds } });
    await CampaignEventInboxModel.deleteMany({ campaignId: { $in: campaignIds } });
  }

  const scenarioCustomers = await SrcCustomerModel.find({ seedGroup: scenario }).lean();
  const customerIds = scenarioCustomers.map((c: any) => c.customerId);
  if (customerIds.length > 0) {
    await CampaignEnrollmentModel.deleteMany({ customerId: { $in: customerIds } });
    await CampaignCustomerFactModel.deleteMany({ customerId: { $in: customerIds } });
  }

  const srcCols = ['src_customers', 'src_customer_events', 'src_orders', 'src_offers', 'src_enquiries', 'src_products', 'src_appointments', 'src_alterations', 'src_fulfilments'];
  for (const collName of srcCols) {
    await mongoose.connection.collection(collName).deleteMany({ seedGroup: scenario });
  }

  const seedState = await DevSeedStateModel.findOne({ tenantId: 'shop_a' });
  if (seedState && seedState.liveOwner === scenario) {
    const liveCusts = await SrcCustomerModel.find({ tenantId: 'shop_a', isLive: true }).lean();
    const liveCustIds = liveCusts.map((c: any) => c.customerId);
    if (liveCustIds.length > 0) {
      await SrcOrderModel.deleteMany({ tenantId: 'shop_a', customerId: { $in: liveCustIds } });
      await mongoose.connection.collection('src_fulfilments').deleteMany({ tenantId: 'shop_a', customerId: { $in: liveCustIds } });
      await SrcCustomerEventModel.deleteMany({ tenantId: 'shop_a', customerId: { $in: liveCustIds } });
      await mongoose.connection.collection('src_enquiries').deleteMany({ tenantId: 'shop_a', customerId: { $in: liveCustIds } });
      await CampaignEnrollmentModel.deleteMany({ tenantId: 'shop_a', customerId: { $in: liveCustIds } });
      await CampaignDeliveryIntentModel.deleteMany({ tenantId: 'shop_a', customerId: { $in: liveCustIds } });
    }
    await DevSeedStateModel.updateOne({ tenantId: 'shop_a' }, { $set: { liveOwner: null } });
  }

  await DevSeedStateModel.updateOne(
    { tenantId: 'shop_a' },
    { $pull: { appliedScenarios: scenario } }
  );

  await customerFactsService.rebuildAllCustomerFacts('shop_a');
  console.log(`✅ Scenario "${scenario}" reset complete.\n`);
}

export async function seedReset(confirmed: boolean = false): Promise<void> {
  if (!confirmed) {
    throw new Error('seed:reset requires --yes to confirm full wipe of development database collections.');
  }
  await connectToDatabase();
  await verifySeedEnvironment();

  console.log('\n[RESET] Wiping all development collections...');
  for (const collName of DEV_COLLECTIONS_LIST) {
    try {
      await mongoose.connection.collection(collName).deleteMany({});
    } catch {
      // Collection might not exist yet; ignore
    }
  }
  console.log('✅ Development database wiped successfully.\n');
}

export async function seedPurgeMock(confirmed: boolean = false): Promise<{
  mockDocumentsPurged: number;
  scenarioCampaignsPurged: number;
}> {
  if (!confirmed) {
    throw new Error('seed:purge-mock requires --yes to confirm removal of mock data.');
  }
  await connectToDatabase();
  await verifySeedEnvironment();

  console.log('\n[PURGE-MOCK] Purging all mock source data and scenario campaigns...');

  const scenarioCampaigns = await CampaignModel.find({
    seedGroup: { $exists: true, $nin: ['core', null] },
  }).lean();
  const campaignIds = scenarioCampaigns.map((c: any) => c.campaignId);

  const scenarioCampaignsPurged = scenarioCampaigns.length;

  if (campaignIds.length > 0) {
    await CampaignModel.deleteMany({ campaignId: { $in: campaignIds } });
    await mongoose.connection.collection('campaignVersions').deleteMany({ campaignId: { $in: campaignIds } });
    await CampaignControlGateModel.deleteMany({ campaignId: { $in: campaignIds } });

    await CampaignEnrollmentModel.deleteMany({ campaignId: { $in: campaignIds } });
    await CampaignExecutionModel.deleteMany({ campaignId: { $in: campaignIds } });
    await CampaignDeliveryIntentModel.deleteMany({ campaignId: { $in: campaignIds } });
    await CampaignProviderEventModel.deleteMany({ campaignId: { $in: campaignIds } });
    await CampaignContactGateModel.deleteMany({ 'ledger.campaignId': { $in: campaignIds } });
    await CampaignEventInboxModel.deleteMany({ campaignId: { $in: campaignIds } });
  }

  let mockDocumentsPurged = 0;
  const mockCollections = [
    'src_customers',
    'src_customerEvents',
    'src_customer_events',
    'src_orders',
    'src_offers',
    'src_enquiries',
    'src_products',
    'src_credits',
    'src_appointments',
    'src_alterations',
    'src_fulfilments',
  ];

  for (const collName of mockCollections) {
    const res = await mongoose.connection.collection(collName).deleteMany({ source: 'MOCK' });
    mockDocumentsPurged += res.deletedCount || 0;
  }

  await CampaignCustomerFactModel.deleteMany({});
  await DevSeedStateModel.updateMany({}, {
    $set: { appliedScenarios: ['base'], liveOwner: null, appliedAt: new Date() },
  });

  console.log(`✅ Purged ${mockDocumentsPurged} mock documents and ${scenarioCampaignsPurged} scenario campaigns.`);
  console.log('Platform data (tenants, branches, users, settings, templates, connections) and auditLog are preserved.\n');

  return {
    mockDocumentsPurged,
    scenarioCampaignsPurged,
  };
}

export async function seedStatus(): Promise<{
  appliedScenarios: string[];
  liveOwner: string | null;
  countsBySeedGroup: Record<string, Record<string, number>>;
}> {
  await connectToDatabase();
  const state: any = await DevSeedStateModel.findOne({ tenantId: 'shop_a' }).lean();
  const appliedScenarios = state?.appliedScenarios || [];
  const liveOwner = state?.liveOwner || null;

  const collections = [
    { name: 'campaigns', col: mongoose.connection.collection('campaigns') },
    { name: 'src_customers', col: mongoose.connection.collection('src_customers') },
    { name: 'src_orders', col: mongoose.connection.collection('src_orders') },
    { name: 'src_customerEvents', col: mongoose.connection.collection('src_customerEvents') },
    { name: 'src_enquiries', col: mongoose.connection.collection('src_enquiries') },
    { name: 'src_products', col: mongoose.connection.collection('src_products') },
    { name: 'src_fulfilments', col: mongoose.connection.collection('src_fulfilments') },
  ];

  const countsBySeedGroup: Record<string, Record<string, number>> = {};

  for (const c of collections) {
    const pipeline = [{ $group: { _id: '$seedGroup', count: { $sum: 1 } } }];
    const results = await c.col.aggregate(pipeline).toArray();
    for (const r of results) {
      const grp = r._id || 'unattributed';
      if (!countsBySeedGroup[grp]) countsBySeedGroup[grp] = {};
      countsBySeedGroup[grp][c.name] = r.count;
    }
  }

  const liveCust: any = await SrcCustomerModel.findOne({ tenantId: 'shop_a', isLive: true }).lean();
  let livePhoneMasked = 'None';
  if (liveCust?.destination?.encryptedPhone) {
    try {
      livePhoneMasked = maskPhone(decryptPhone(liveCust.destination.encryptedPhone));
    } catch {
      livePhoneMasked = 'encrypted';
    }
  }

  console.log('\n================================================================================');
  console.log('                            GROVASTRA SEED STATUS');
  console.log('================================================================================\n');
  console.log(`Applied Scenarios:   ${appliedScenarios.length ? appliedScenarios.join(', ') : 'none'}`);
  console.log(`Live Customer Owner: ${liveOwner || 'none'}`);
  console.log(`Live Customer Phone: ${livePhoneMasked}`);
  console.log('\nDocument counts by seedGroup:');
  console.table(countsBySeedGroup);
  console.log('================================================================================\n');

  return {
    appliedScenarios,
    liveOwner,
    countsBySeedGroup,
  };
}

export async function seedDemo(): Promise<{ liveOwner: string | null }> {
  console.log('\n================================================================================');
  console.log('                          GROVASTRA SEED DEMO (ALL SCENARIOS)');
  console.log('================================================================================\n');

  await seedBase();

  const scenarios = ['welcome', 'first-repeat', 'gift-wedding', 'unresolved-enquiry', 'complete-outfit', 'selected-stock-promotion', 'festival-collection', 'exhibition-trunk-show', 'fitting-alteration', 'outfit-fulfilment'];
  for (const sc of scenarios) {
    console.log(`\n--- Applying Scenario: ${sc} (without --live) ---`);
    await seedScenario(sc, { live: false });
  }

  const state: any = await DevSeedStateModel.findOne({ tenantId: 'shop_a' }).lean();
  const liveOwner = state?.liveOwner || null;
  console.log('\n================================================================================');
  console.log(`✅ Demo seed complete! All campaigns active.`);
  console.log(`Live Customer Owner: ${liveOwner || 'none'}`);
  console.log('================================================================================\n');

  return { liveOwner };
}

async function insertCustomerBatch(
  tenantId: string,
  records: CustomerSeedRecord[],
  defaultSeedGroup: string = 'core',
  session?: mongoose.mongo.ClientSession
) {
  const customerDocs = [];
  const eventDocs = [];
  const orderDocs = [];

  for (const r of records) {
    let docSeedGroup = defaultSeedGroup;
    if (r.customerId.startsWith('cus_wel_')) docSeedGroup = 'welcome';
    else if (r.customerId.startsWith('cus_fr_')) docSeedGroup = 'first-repeat';
    else if (r.customerId.startsWith('cus_gw_')) docSeedGroup = 'gift-wedding';
    else if (r.customerId.startsWith('cus_enq_')) docSeedGroup = 'unresolved-enquiry';
    else if (defaultSeedGroup === 'outfit-fulfilment' || r.customerId.startsWith('cus_of_ful_')) docSeedGroup = 'outfit-fulfilment';
    else if (r.customerId.startsWith('cus_of_')) docSeedGroup = 'complete-outfit';
    else if (r.customerId.startsWith('cus_sp_')) docSeedGroup = 'selected-stock-promotion';
    else if (r.customerId.startsWith('cus_fc_')) docSeedGroup = 'festival-collection';
    else if (r.customerId.startsWith('cus_ex_')) docSeedGroup = 'exhibition-trunk-show';
    else if (r.customerId.startsWith('cus_fa_')) docSeedGroup = 'fitting-alteration';

    const rec = r as any;
    const hasPhone = Boolean(r.rawPhone && r.rawPhone.trim());
    const encPhone = hasPhone ? encryptPhone(r.rawPhone) : '';
    const destHash = hasPhone ? destinationHash(r.rawPhone) : '';
    const masked = hasPhone ? maskPhone(r.rawPhone) : '';

    customerDocs.push(
      applySeedLabels(
        {
          tenantId,
          customerId: r.customerId,
          firstName: r.firstName,
          destination: hasPhone
            ? {
                encryptedPhone: encPhone,
                destinationHash: destHash,
                masked,
                verified: rec.destination?.verified !== undefined ? rec.destination.verified : (rec.verified !== undefined ? rec.verified : true),
                version: 1,
                verificationLevel: rec.destination?.verificationLevel || (rec.verificationLevel || ((rec.destination?.verified === false || rec.verified === false) ? 'UNVERIFIED' : 'CONFIRMED_BY_STAFF')),
                verifiedAt: rec.destination?.verifiedAt || (rec.verifiedAt || ((rec.destination?.verified === false || rec.verified === false) ? null : clock.now())),
                verificationMethod: rec.destination?.verificationMethod || (rec.verificationMethod || ((rec.destination?.verified === false || rec.verified === false) ? null : 'MOCK')),
              }
            : {
                encryptedPhone: '',
                destinationHash: '',
                masked: '',
                verified: false,
                version: 1,
                verificationLevel: 'UNVERIFIED',
                verifiedAt: null,
                verificationMethod: null,
              },
          birthday: r.birthday,
          consent: {
            marketingOptIn: r.marketingOptIn,
            channelSuppressed: r.channelSuppressed,
            consentCapturedAt: (r as any).consent?.consentCapturedAt || ((r as any).consentCapturedAt || (r.marketingOptIn ? clock.now() : null)),
            consentSource: (r as any).consent?.consentSource || ((r as any).consentSource || (r.marketingOptIn ? 'MOCK' : null)),
          },
          preferences: r.preferences,
          tags: r.tags,
          status: r.status,
          branchId: r.branchId,
          city: rec.city || null,
          deletedAt: r.deletedAt || null,
          version: 1,
          language: r.language,
          isLive: r.isLive,
        },
        docSeedGroup,
        !r.isLive
      )
    );

    if (r.events && r.events.length > 0) {
      for (const ev of r.events) {
        eventDocs.push(
          applySeedLabels(
            {
              tenantId,
              customerId: r.customerId,
              eventId: ev.eventId,
              type: ev.type,
              kind: (ev as any).kind || (ev.type === 'anniversary' ? OCCASION_KIND.ANNIVERSARY : OCCASION_KIND.GIFT),
              eventDate: (ev as any).eventDate,
              eventDateKey: (ev as any).eventDateKey || ((ev as any).eventDate ? `${(ev as any).eventDate.year}-${String((ev as any).eventDate.month).padStart(2, '0')}-${String((ev as any).eventDate.day).padStart(2, '0')}` : undefined),
              month: ev.month,
              day: ev.day,
              label: ev.label,
              recipientLabel: (ev as any).recipientLabel || null,
              budgetPaise: (ev as any).budgetPaise !== undefined ? (ev as any).budgetPaise : null,
              categories: (ev as any).categories || [],
              status: (ev as any).status || OCCASION_STATUS.ACTIVE,
              declaredByCustomer: (ev as any).declaredByCustomer !== undefined ? (ev as any).declaredByCustomer : true,
              declaredAt: (ev as any).declaredAt || clock.now(),
              source: (ev as any).source || 'MOCK',
              entityVersion: 1,
              version: 1,
              deletedAt: null,
            },
            docSeedGroup,
            true
          )
        );
      }
    }

    if (r.orders && r.orders.length > 0) {
      for (const ord of r.orders) {
        orderDocs.push(
          applySeedLabels(
            {
              tenantId,
              orderId: ord.orderId,
              customerId: r.customerId,
              status: ord.status,
              paid: ord.paid,
              netPaise: ord.netPaise,
              occasionRef: ord.occasionRef || null,
              lines: ord.lines,
              entityVersion: 1,
              completedAt: ord.completedAt || null,
              branchId: ord.branchId || r.branchId,
            },
            docSeedGroup,
            true
          )
        );
      }
    }
  }

  if (customerDocs.length > 0) {
    await upsertMany('src_customers', ['tenantId', 'customerId'], customerDocs, session);
  }
  if (eventDocs.length > 0) {
    await upsertMany('src_customerEvents', ['tenantId', 'eventId'], eventDocs, session);
  }
  if (orderDocs.length > 0) {
    await upsertMany('src_orders', ['tenantId', 'orderId'], orderDocs, session);
  }

  return {
    customerCount: customerDocs.length,
    eventCount: eventDocs.length,
    orderCount: orderDocs.length,
    liveCount: customerDocs.filter((c) => c.isLive).length,
  };
}

export async function seedBase(options: { live?: boolean } = {}): Promise<SeedSummary> {
  console.log('\n================================================================================');
  console.log('         GROVASTRA SEED ENGINE: PLATFORM LAYER (seed:base)');
  console.log('================================================================================\n');

  await connectToDatabase();
  await verifySeedEnvironment();

  const { shopACustomers, shopBCustomers } = generateSeedData('base', { live: false });
  const metaData = loadMetaTemplatesFile();

  const session = await mongoose.startSession();
  try {
    let shopACount = 0;
    let shopBCount = 0;
    let liveCount = 0;
    let eventsCount = 0;
    let ordersCount = 0;
    let templatesCount = 0;
    let connectionsCount = 0;
    let offersCount = 0;

    await session.withTransaction(async () => {
      // 1. Seed Templates
      const templateDocs = metaData.templates.map((t: any) =>
        applySeedLabels(
          {
            id: t.id,
            name: t.name,
            language: t.language,
            category: t.category,
            status: t.status,
            bodyText: t.bodyText ?? null,
            variables: t.variables || [],
            revision: t.revision,
            sendable: t.source === 'DUMMY' ? false : Boolean(t.sendable),
            source: t.source,
          },
          'core',
          false
        )
      );
      templatesCount = await upsertMany('src_templates', ['id'], templateDocs, session);

      // 2. Seed Connection
      const connectionDoc = applySeedLabels(
        {
          id: metaData.connection.connectionId,
          tenantId: 'shop_a',
          phoneNumberId: metaData.connection.phoneNumberId,
          wabaId: metaData.connection.wabaId,
          secretRef: metaData.connection.secretRefEnvKey,
          graphApiVersion: metaData.graphApiVersion,
          status: 'ACTIVE',
        },
        'core',
        false
      );
      connectionsCount = await upsertMany('src_connections', ['id'], [connectionDoc], session);

      // 3. Seed Offers
      const offerDocs = [
        {
          offerId: 'off_welcome_50',
          tenantId: 'shop_a',
          kind: 'FLAT_AMOUNT_OFF_NEXT_PURCHASE',
          amountPaise: 5000,
          validFrom: new Date('2026-01-01T00:00:00Z'),
          validUntil: new Date('2026-12-31T23:59:59Z'),
          status: 'ACTIVE',
          version: 1,
        },
        {
          offerId: 'off_welcome_expired',
          tenantId: 'shop_a',
          kind: 'FLAT_AMOUNT_OFF_NEXT_PURCHASE',
          amountPaise: 5000,
          validFrom: new Date('2025-01-01T00:00:00Z'),
          validUntil: new Date('2026-01-01T00:00:00Z'),
          status: 'EXPIRED',
          version: 1,
        },
        {
          offerId: 'off_welcome_paused',
          tenantId: 'shop_a',
          kind: 'FLAT_AMOUNT_OFF_NEXT_PURCHASE',
          amountPaise: 10000,
          validFrom: new Date('2026-01-01T00:00:00Z'),
          validUntil: new Date('2026-12-31T23:59:59Z'),
          status: 'PAUSED',
          version: 1,
        },
      ].map((o) => applySeedLabels(o, 'core', true));
      offersCount = await upsertMany('src_offers', ['tenantId', 'offerId'], offerDocs, session);

      // 4. Seed Tenants
      const tenantDocs = [
        { tenantId: 'shop_a', name: 'Sample Boutique', status: 'active' },
        { tenantId: 'shop_b', name: 'Second Boutique', status: 'active' },
      ].map((t) => applySeedLabels(t, 'core', false));
      await upsertMany('tenants', ['tenantId'], tenantDocs, session);

      // 5. Seed Branches
      const branchDocs = [
        { tenantId: 'shop_a', branchId: 'branch_main', name: 'Main Flagship Showroom', isMain: true, status: 'active' },
        { tenantId: 'shop_a', branchId: 'branch_two', name: 'Heritage Silk Lane', isMain: false, status: 'active' },
        { tenantId: 'shop_b', branchId: 'branch_b_main', name: 'Boutique B Flagship', isMain: true, status: 'active' },
      ].map((b) => applySeedLabels(b, 'core', false));
      await upsertMany('branches', ['tenantId', 'branchId'], branchDocs, session);

      // 6. Seed Users
      const userDocs = [];
      for (const cred of SEED_CREDENTIALS) {
        const passwordHash = await bcrypt.hash(cred.password, 10);
        userDocs.push(
          applySeedLabels(
            {
              tenantId: cred.tenantId,
              email: cred.email,
              passwordHash,
              role: cred.role,
              branchIds: cred.branchIds,
              name: cred.name,
              status: 'active',
            },
            'core',
            false
          )
        );
      }
      await upsertMany('users', ['tenantId', 'email'], userDocs, session);

      // 7. Seed Settings
      const settingsDocs = [
        {
          tenantId: 'shop_a',
          version: 1,
          timezone: DEFAULT_CAMPAIGN_SETTINGS.timezone,
          allowedSendingHours: { ...DEFAULT_CAMPAIGN_SETTINGS.allowedSendingHours },
          blackoutDates: [],
          holidays: [...DEFAULT_CAMPAIGN_SETTINGS.holidays],
          marketingCaps: { ...DEFAULT_CAMPAIGN_SETTINGS.marketingCaps },
          serviceContactSpacingHours: DEFAULT_CAMPAIGN_SETTINGS.serviceContactSpacingHours,
          outageGraceHours: DEFAULT_CAMPAIGN_SETTINGS.outageGraceHours,
          resumePolicy: 'FUTURE_ONLY',
          importPolicy: 'FUTURE_ONLY',
          priorityAllowlistRanges: { ...DEFAULT_CAMPAIGN_SETTINGS.priorityAllowlistRanges },
          bookingLinkUrl: 'https://sample-boutique.com/book',
          isPaused: false,
        },
        {
          tenantId: 'shop_b',
          version: 1,
          timezone: DEFAULT_CAMPAIGN_SETTINGS.timezone,
          allowedSendingHours: { ...DEFAULT_CAMPAIGN_SETTINGS.allowedSendingHours },
          blackoutDates: [],
          holidays: [],
          marketingCaps: { ...DEFAULT_CAMPAIGN_SETTINGS.marketingCaps },
          serviceContactSpacingHours: DEFAULT_CAMPAIGN_SETTINGS.serviceContactSpacingHours,
          outageGraceHours: DEFAULT_CAMPAIGN_SETTINGS.outageGraceHours,
          resumePolicy: 'FUTURE_ONLY',
          importPolicy: 'FUTURE_ONLY',
          priorityAllowlistRanges: { ...DEFAULT_CAMPAIGN_SETTINGS.priorityAllowlistRanges },
          isPaused: false,
        },
      ].map((s) => applySeedLabels(s, 'core', false));
      await upsertMany('campaignSettings', ['tenantId'], settingsDocs, session);

      // 8. Seed Core Customers
      const resA = await insertCustomerBatch('shop_a', shopACustomers, 'core', session);
      const resB = await insertCustomerBatch('shop_b', shopBCustomers, 'core', session);

      shopACount = resA.customerCount;
      shopBCount = resB.customerCount;
      liveCount = resA.liveCount;
      eventsCount = resA.eventCount + resB.eventCount;
      ordersCount = resA.orderCount + resB.orderCount;

      // 9. Update dev_seedState
      await DevSeedStateModel.updateOne(
        { tenantId: 'shop_a' },
        {
          $setOnInsert: { liveOwner: null },
          $addToSet: { appliedScenarios: 'base' },
          $set: { appliedAt: new Date() },
        },
        { upsert: true, session }
      );
    });

    // 10. Rebuild facts
    await customerFactsService.rebuildAllCustomerFacts('shop_a');
    await customerFactsService.rebuildAllCustomerFacts('shop_b');

    // 11. Audit log
    await auditService.logEvent({
      tenantId: 'shop_a',
      action: 'system.seed_initial_data',
      metadata: {
        scenario: 'base',
        tenant: 'Sample Boutique',
        customersSeeded: shopACount,
        liveCustomers: liveCount,
      },
    });

    console.log('✅ Platform layer (seed:base) seeded successfully! ZERO campaigns created.\n');

    return {
      shopACount,
      shopBCount,
      liveCount,
      eventsCount,
      ordersCount,
      templatesCount,
      connectionsCount,
      offersCount,
    };
  } finally {
    await session.endSession();
  }
}

export async function executeScenarioData(
  scenario: string,
  options: SeedOptions = {},
  session: mongoose.mongo.ClientSession
): Promise<SeedSummary> {
  const { shopACustomers, shopBCustomers } = generateSeedData(scenario, { live: options.live });
  const metaData = loadMetaTemplatesFile();

  const resA = await insertCustomerBatch('shop_a', shopACustomers, scenario, session);
  const resB = await insertCustomerBatch('shop_b', shopBCustomers, scenario, session);

  let shopACount = resA.customerCount;
  let shopBCount = resB.customerCount;
  let liveCount = resA.liveCount;
  let eventsCount = resA.eventCount + resB.eventCount;
  let ordersCount = resA.orderCount + resB.orderCount;
  let templatesCount = 0;
  let connectionsCount = 0;
  let offersCount = 0;

      if (scenario === 'welcome') {
        const isMetaMode = (config.DISPATCH_MODE || '').toLowerCase() === 'meta';
        // 2. Order Mode Campaign (Default F19b v2 Welcome)
        const orderWelcomeCampaignId = 'cmp_wel_order_mode';
        const orderWelcomeVersionId = 'ver_wel_order_mode_1';
        const orderSeedTemplateRef = isMetaMode
          ? {
              id: 'tpl_hello_world',
              name: 'hello_world',
              language: 'en_US',
              revision: 1,
            }
          : {
              id: 'tpl_welcome_new_customer',
              name: 'welcome_new_customer',
              language: 'en',
              revision: 1,
            };
        const orderSeedBindings = isMetaMode
          ? {}
          : {
              '1': { source: 'customer.firstName' },
              '2': { source: 'shop.displayName' },
            };

        await upsertMany(
          'campaigns',
          ['tenantId', 'campaignId'],
          [
            applySeedLabels(
              {
                campaignId: orderWelcomeCampaignId,
                tenantId: 'shop_a',
                name: 'New Customer Welcome Campaign (Order Mode)',
                presetId: 'WELCOME_NEW_CUSTOMER',
                status: 'ACTIVE',
                activeVersionId: orderWelcomeVersionId,
                draftVersion: 1,
                pauseGeneration: 0,
                enabledBranches: ['branch_main', 'branch_two'],
                activatedAt: new Date(clock.now().getTime() - 90 * 60 * 1000), // Activated 90 min ago
              },
              'welcome',
              false
            ),
          ],
          session
        );

        await upsertMany(
          'campaignVersions',
          ['tenantId', 'campaignId', 'version'],
          [
            applySeedLabels(
              {
                campaignId: orderWelcomeCampaignId,
                tenantId: 'shop_a',
                version: 1,
                name: 'New Customer Welcome Campaign (Order Mode)',
                enabledBranches: ['branch_main', 'branch_two'],
                industry: 'BOUTIQUE',
                purpose: 'MARKETING',
                priority: 45,
                trigger: {
                  type: 'EVENT_DELAY',
                  anchor: 'FIRST_QUALIFYING_ORDER',
                },
                minFirstOrderNetPaise: 100000, // Rs 1,000 minimum
                audience: {
                  mode: 'ALL_ELIGIBLE',
                  rules: null,
                },
                goal: {
                  type: 'OCCASION_TAGGED_OR_STAFF_COMPLETED',
                },
                steps: [
                  {
                    stepId: 'step_welcome_ord_1',
                    stepName: 'Welcome New Customer',
                    offsetDays: 0,
                    localTime: '10:00',
                    prerequisite: 'NONE',
                    delay: { value: 1, unit: 'HOURS' },
                    outsideHoursPolicy: 'DEFER_NEXT_DAY',
                    maxDeferralHours: 24,
                    templateRef: orderSeedTemplateRef,
                    bindings: orderSeedBindings,
                    stopOnReply: true,
                    stopOnGoal: true,
                    maxLatenessMinutes: 180,
                  },
                ],
                timezone: 'Asia/Kolkata',
                bindingsSchemaVersion: 2,
                isPublished: true,
                activatedBy: 'owner@shop-a.com',
                activatedAt: new Date(clock.now().getTime() - 90 * 60 * 1000),
              },
              'welcome',
              false
            ),
          ],
          session
        );

        await upsertMany(
          'campaignControlGates',
          ['tenantId', 'campaignId'],
          [
            applySeedLabels(
              {
                campaignId: orderWelcomeCampaignId,
                tenantId: 'shop_a',
                pauseGeneration: 0,
                version: 1,
              },
              'welcome',
              false
            ),
          ],
          session
        );

        // 3. Seed Order-mode Specific Customers & Orders relative to Clock
        const nowMs = clock.now().getTime();
        const now = clock.now();

        const orderModeCustomers: any[] = [
          // 1. New customer with one paid order 30 minutes ago
          {
            tenantId: 'shop_a',
            customerId: 'cus_ord_30m',
            firstName: 'Aditi',
            rawPhone: '+91 98000 00001',
            status: 'ACTIVE',
            branchId: 'branch_main',
            marketingOptIn: true,
            channelSuppressed: false,
            verified: true,
            verificationLevel: 'CONFIRMED_BY_STAFF',
            verificationMethod: 'COUNTER_READBACK',
            consentSource: 'MOCK',
            orders: [
              {
                orderId: 'ord_wel_30m',
                status: 'COMPLETED',
                paid: true,
                netPaise: 250000,
                completedAt: new Date(nowMs - 30 * 60 * 1000),
                branchId: 'branch_main',
                lines: [{ lineId: 'l1', itemRef: 'item_1', name: 'Cotton Kurta', quantity: 1, pricePaise: 250000 }],
              },
            ],
          },
          // 2. Customer with ONE order having FIVE lines
          {
            tenantId: 'shop_a',
            customerId: 'cus_ord_5lines',
            firstName: 'Vikram',
            rawPhone: '+91 98000 00002',
            status: 'ACTIVE',
            branchId: 'branch_main',
            marketingOptIn: true,
            channelSuppressed: false,
            verified: true,
            verificationLevel: 'CONFIRMED_BY_STAFF',
            verificationMethod: 'COUNTER_READBACK',
            consentSource: 'MOCK',
            orders: [
              {
                orderId: 'ord_wel_5lines',
                status: 'COMPLETED',
                paid: true,
                netPaise: 500000,
                completedAt: new Date(nowMs - 45 * 60 * 1000),
                branchId: 'branch_main',
                lines: [
                  { lineId: 'l1', itemRef: 'item_1', name: 'Saree 1', quantity: 1, pricePaise: 100000 },
                  { lineId: 'l2', itemRef: 'item_2', name: 'Saree 2', quantity: 1, pricePaise: 100000 },
                  { lineId: 'l3', itemRef: 'item_3', name: 'Saree 3', quantity: 1, pricePaise: 100000 },
                  { lineId: 'l4', itemRef: 'item_4', name: 'Saree 4', quantity: 1, pricePaise: 100000 },
                  { lineId: 'l5', itemRef: 'item_5', name: 'Saree 5', quantity: 1, pricePaise: 100000 },
                ],
              },
            ],
          },
          // 3. Customer with FIVE bills the same day (3 minutes apart)
          {
            tenantId: 'shop_a',
            customerId: 'cus_ord_5bills',
            firstName: 'Meera',
            rawPhone: '+91 98000 00003',
            status: 'ACTIVE',
            branchId: 'branch_main',
            marketingOptIn: true,
            channelSuppressed: false,
            verified: true,
            verificationLevel: 'CONFIRMED_BY_STAFF',
            verificationMethod: 'COUNTER_READBACK',
            consentSource: 'MOCK',
            orders: [
              {
                orderId: 'ord_wel_5bills_1',
                status: 'COMPLETED',
                paid: true,
                netPaise: 120000,
                completedAt: new Date(nowMs - 50 * 60 * 1000), // Earliest anchor!
                branchId: 'branch_main',
                lines: [{ lineId: 'l1', itemRef: 'it_1', name: 'Dupatta', quantity: 1, pricePaise: 120000 }],
              },
              {
                orderId: 'ord_wel_5bills_2',
                status: 'COMPLETED',
                paid: true,
                netPaise: 150000,
                completedAt: new Date(nowMs - 47 * 60 * 1000),
                branchId: 'branch_main',
                lines: [{ lineId: 'l1', itemRef: 'it_2', name: 'Stole', quantity: 1, pricePaise: 150000 }],
              },
              {
                orderId: 'ord_wel_5bills_3',
                status: 'COMPLETED',
                paid: true,
                netPaise: 200000,
                completedAt: new Date(nowMs - 44 * 60 * 1000),
                branchId: 'branch_main',
                lines: [{ lineId: 'l1', itemRef: 'it_3', name: 'Skirt', quantity: 1, pricePaise: 200000 }],
              },
              {
                orderId: 'ord_wel_5bills_4',
                status: 'COMPLETED',
                paid: true,
                netPaise: 180000,
                completedAt: new Date(nowMs - 41 * 60 * 1000),
                branchId: 'branch_main',
                lines: [{ lineId: 'l1', itemRef: 'it_4', name: 'Top', quantity: 1, pricePaise: 180000 }],
              },
              {
                orderId: 'ord_wel_5bills_5',
                status: 'COMPLETED',
                paid: true,
                netPaise: 220000,
                completedAt: new Date(nowMs - 38 * 60 * 1000),
                branchId: 'branch_main',
                lines: [{ lineId: 'l1', itemRef: 'it_5', name: 'Scarf', quantity: 1, pricePaise: 220000 }],
              },
            ],
          },
          // 4. Long-time customer (first order 200 days ago, new order today)
          {
            tenantId: 'shop_a',
            customerId: 'cus_ord_longtime',
            firstName: 'Kavita',
            rawPhone: '+91 98000 00004',
            status: 'ACTIVE',
            branchId: 'branch_main',
            marketingOptIn: true,
            channelSuppressed: false,
            verified: true,
            verificationLevel: 'CONFIRMED_BY_STAFF',
            verificationMethod: 'COUNTER_READBACK',
            consentSource: 'MOCK',
            orders: [
              {
                orderId: 'ord_wel_lt_1',
                status: 'COMPLETED',
                paid: true,
                netPaise: 350000,
                completedAt: new Date(nowMs - 200 * 24 * 3600 * 1000), // 200 days ago
                branchId: 'branch_main',
                lines: [{ lineId: 'l1', itemRef: 'it_old', name: 'Old Saree', quantity: 1, pricePaise: 350000 }],
              },
              {
                orderId: 'ord_wel_lt_2',
                status: 'COMPLETED',
                paid: true,
                netPaise: 200000,
                completedAt: new Date(nowMs - 20 * 60 * 1000), // Today
                branchId: 'branch_main',
                lines: [{ lineId: 'l1', itemRef: 'it_new', name: 'New Dress', quantity: 1, pricePaise: 200000 }],
              },
            ],
          },
          // 5. First order before activation (step still future)
          {
            tenantId: 'shop_a',
            customerId: 'cus_ord_preact_future',
            firstName: 'Deepak',
            rawPhone: '+91 98000 00005',
            status: 'ACTIVE',
            branchId: 'branch_main',
            marketingOptIn: true,
            channelSuppressed: false,
            verified: true,
            verificationLevel: 'CONFIRMED_BY_STAFF',
            verificationMethod: 'COUNTER_READBACK',
            consentSource: 'MOCK',
            orders: [
              {
                orderId: 'ord_wel_pact_fut',
                status: 'COMPLETED',
                paid: true,
                netPaise: 180000,
                completedAt: new Date(nowMs - 100 * 60 * 1000), // 100m ago (before 90m activation)
                branchId: 'branch_main',
                lines: [{ lineId: 'l1', itemRef: 'it_p', name: 'Kurta', quantity: 1, pricePaise: 180000 }],
              },
            ],
          },
          // 6. First order before activation (step already elapsed)
          {
            tenantId: 'shop_a',
            customerId: 'cus_ord_preact_elapsed',
            firstName: 'Sunita',
            rawPhone: '+91 98000 00006',
            status: 'ACTIVE',
            branchId: 'branch_main',
            marketingOptIn: true,
            channelSuppressed: false,
            verified: true,
            verificationLevel: 'CONFIRMED_BY_STAFF',
            verificationMethod: 'COUNTER_READBACK',
            consentSource: 'MOCK',
            orders: [
              {
                orderId: 'ord_wel_pact_elap',
                status: 'COMPLETED',
                paid: true,
                netPaise: 180000,
                completedAt: new Date(nowMs - 10 * 24 * 3600 * 1000), // 10 days ago (elapsed)
                branchId: 'branch_main',
                lines: [{ lineId: 'l1', itemRef: 'it_e', name: 'Stole', quantity: 1, pricePaise: 180000 }],
              },
            ],
          },
          // 7. Customer with anonymous order later attached
          {
            tenantId: 'shop_a',
            customerId: 'cus_ord_attached',
            firstName: 'Ananya',
            rawPhone: '+91 98000 00007',
            status: 'ACTIVE',
            branchId: 'branch_main',
            marketingOptIn: true,
            channelSuppressed: false,
            verified: true,
            verificationLevel: 'CONFIRMED_BY_STAFF',
            verificationMethod: 'COUNTER_READBACK',
            consentSource: 'MOCK',
            orders: [
              {
                orderId: 'ord_wel_attached_bill',
                status: 'COMPLETED',
                paid: true,
                netPaise: 220000,
                completedAt: new Date(nowMs - 25 * 60 * 1000),
                branchId: 'branch_main',
                lines: [{ lineId: 'l1', itemRef: 'it_att', name: 'Anarkali', quantity: 1, pricePaise: 220000 }],
              },
            ],
          },
          // 8. First order fully refunded before send
          {
            tenantId: 'shop_a',
            customerId: 'cus_ord_full_refund',
            firstName: 'Rajesh',
            rawPhone: '+91 98000 00008',
            status: 'ACTIVE',
            branchId: 'branch_main',
            marketingOptIn: true,
            channelSuppressed: false,
            verified: true,
            verificationLevel: 'CONFIRMED_BY_STAFF',
            verificationMethod: 'COUNTER_READBACK',
            consentSource: 'MOCK',
            orders: [
              {
                orderId: 'ord_wel_fr_1',
                status: 'REFUNDED',
                paid: true,
                netPaise: 0,
                grossPaise: 250000,
                refundedPaise: 250000,
                completedAt: new Date(nowMs - 40 * 60 * 1000),
                branchId: 'branch_main',
                lines: [{ lineId: 'l1', itemRef: 'it_fr1', name: 'Jacket', quantity: 1, pricePaise: 250000 }],
              },
              {
                orderId: 'ord_wel_fr_2',
                status: 'COMPLETED',
                paid: true,
                netPaise: 300000,
                completedAt: new Date(nowMs - 15 * 60 * 1000),
                branchId: 'branch_main',
                lines: [{ lineId: 'l1', itemRef: 'it_fr2', name: 'Shawl', quantity: 1, pricePaise: 300000 }],
              },
            ],
          },
          // 9. Partially refunded (keeps net > minimum)
          {
            tenantId: 'shop_a',
            customerId: 'cus_ord_part_refund',
            firstName: 'Sanjay',
            rawPhone: '+91 98000 00009',
            status: 'ACTIVE',
            branchId: 'branch_main',
            marketingOptIn: true,
            channelSuppressed: false,
            verified: true,
            verificationLevel: 'CONFIRMED_BY_STAFF',
            verificationMethod: 'COUNTER_READBACK',
            consentSource: 'MOCK',
            orders: [
              {
                orderId: 'ord_wel_pr_1',
                status: 'COMPLETED',
                paid: true,
                netPaise: 200000,
                grossPaise: 300000,
                refundedPaise: 100000,
                completedAt: new Date(nowMs - 35 * 60 * 1000),
                branchId: 'branch_main',
                lines: [{ lineId: 'l1', itemRef: 'it_pr', name: 'Silk Shirt', quantity: 1, pricePaise: 300000 }],
              },
            ],
          },
          // 10. Customer with pending / unpaid / cancelled orders
          {
            tenantId: 'shop_a',
            customerId: 'cus_ord_unpaid_cancelled',
            firstName: 'Karan',
            rawPhone: '+91 98000 00010',
            status: 'ACTIVE',
            branchId: 'branch_main',
            marketingOptIn: true,
            channelSuppressed: false,
            verified: true,
            verificationLevel: 'CONFIRMED_BY_STAFF',
            verificationMethod: 'COUNTER_READBACK',
            consentSource: 'MOCK',
            orders: [
              {
                orderId: 'ord_wel_pending',
                status: 'PENDING',
                paid: false,
                netPaise: 150000,
                completedAt: new Date(nowMs - 50 * 60 * 1000),
                branchId: 'branch_main',
                lines: [{ lineId: 'l1', itemRef: 'it_pen', name: 'Item', quantity: 1, pricePaise: 150000 }],
              },
              {
                orderId: 'ord_wel_unpaid',
                status: 'COMPLETED',
                paid: false,
                netPaise: 150000,
                completedAt: new Date(nowMs - 40 * 60 * 1000),
                branchId: 'branch_main',
                lines: [{ lineId: 'l1', itemRef: 'it_unp', name: 'Item', quantity: 1, pricePaise: 150000 }],
              },
              {
                orderId: 'ord_wel_cancelled',
                status: 'CANCELLED',
                paid: true,
                netPaise: 150000,
                completedAt: new Date(nowMs - 30 * 60 * 1000),
                branchId: 'branch_main',
                lines: [{ lineId: 'l1', itemRef: 'it_cnl', name: 'Item', quantity: 1, pricePaise: 150000 }],
              },
            ],
          },
          // 11. First order below minimum (netPaise 50,000 < min 100,000)
          {
            tenantId: 'shop_a',
            customerId: 'cus_ord_below_min',
            firstName: 'Neelam',
            rawPhone: '+91 98000 00011',
            status: 'ACTIVE',
            branchId: 'branch_main',
            marketingOptIn: true,
            channelSuppressed: false,
            verified: true,
            verificationLevel: 'CONFIRMED_BY_STAFF',
            verificationMethod: 'COUNTER_READBACK',
            consentSource: 'MOCK',
            orders: [
              {
                orderId: 'ord_wel_bm_1',
                status: 'COMPLETED',
                paid: true,
                netPaise: 50000, // Rs 500 < Rs 1000 minimum
                completedAt: new Date(nowMs - 30 * 60 * 1000),
                branchId: 'branch_main',
                lines: [{ lineId: 'l1', itemRef: 'it_bm', name: 'Hankies', quantity: 1, pricePaise: 50000 }],
              },
            ],
          },
          // 12. First order at branch A then branch B
          {
            tenantId: 'shop_a',
            customerId: 'cus_ord_branches',
            firstName: 'Ritu',
            rawPhone: '+91 98000 00012',
            status: 'ACTIVE',
            branchId: 'branch_main',
            marketingOptIn: true,
            channelSuppressed: false,
            verified: true,
            verificationLevel: 'CONFIRMED_BY_STAFF',
            verificationMethod: 'COUNTER_READBACK',
            consentSource: 'MOCK',
            orders: [
              {
                orderId: 'ord_wel_br_1',
                status: 'COMPLETED',
                paid: true,
                netPaise: 200000,
                completedAt: new Date(nowMs - 50 * 60 * 1000),
                branchId: 'branch_main',
                lines: [{ lineId: 'l1', itemRef: 'it_br1', name: 'Scarf A', quantity: 1, pricePaise: 200000 }],
              },
              {
                orderId: 'ord_wel_br_2',
                status: 'COMPLETED',
                paid: true,
                netPaise: 250000,
                completedAt: new Date(nowMs - 20 * 60 * 1000),
                branchId: 'branch_two',
                lines: [{ lineId: 'l1', itemRef: 'it_br2', name: 'Scarf B', quantity: 1, pricePaise: 250000 }],
              },
            ],
          },
          // 13. First order at 20:30 local (outside hours 10-19, deferred to next morning)
          {
            tenantId: 'shop_a',
            customerId: 'cus_ord_night',
            firstName: 'Alok',
            rawPhone: '+91 98000 00013',
            status: 'ACTIVE',
            branchId: 'branch_main',
            marketingOptIn: true,
            channelSuppressed: false,
            verified: true,
            verificationLevel: 'CONFIRMED_BY_STAFF',
            verificationMethod: 'COUNTER_READBACK',
            consentSource: 'MOCK',
            orders: [
              {
                orderId: 'ord_wel_night_1',
                status: 'COMPLETED',
                paid: true,
                netPaise: 250000,
                completedAt: new Date('2026-10-23T15:00:00.000Z'), // 20:30 IST
                branchId: 'branch_main',
                lines: [{ lineId: 'l1', itemRef: 'it_ngt', name: 'Evening Kurta', quantity: 1, pricePaise: 250000 }],
              },
            ],
          },
          // 14. Customer with delay 0
          {
            tenantId: 'shop_a',
            customerId: 'cus_ord_delay0',
            firstName: 'Tina',
            rawPhone: '+91 98000 00014',
            status: 'ACTIVE',
            branchId: 'branch_main',
            marketingOptIn: true,
            channelSuppressed: false,
            verified: true,
            verificationLevel: 'CONFIRMED_BY_STAFF',
            verificationMethod: 'COUNTER_READBACK',
            consentSource: 'MOCK',
            orders: [
              {
                orderId: 'ord_wel_d0_1',
                status: 'COMPLETED',
                paid: true,
                netPaise: 300000,
                completedAt: new Date(nowMs - 5 * 60 * 1000), // 5 min ago
                branchId: 'branch_main',
                lines: [{ lineId: 'l1', itemRef: 'it_d0', name: 'Palazzo', quantity: 1, pricePaise: 300000 }],
              },
            ],
          },
          // 15. Phone quality: UNVERIFIED
          {
            tenantId: 'shop_a',
            customerId: 'cus_ord_phone_unverified',
            firstName: 'Manish',
            rawPhone: '+91 98000 00015',
            status: 'ACTIVE',
            branchId: 'branch_main',
            marketingOptIn: true,
            channelSuppressed: false,
            verified: false,
            verificationLevel: 'UNVERIFIED',
            verificationMethod: null,
            consentSource: 'MOCK',
            orders: [
              {
                orderId: 'ord_wel_unv_1',
                status: 'COMPLETED',
                paid: true,
                netPaise: 200000,
                completedAt: new Date(nowMs - 30 * 60 * 1000),
                branchId: 'branch_main',
                lines: [{ lineId: 'l1', itemRef: 'it_u1', name: 'Item', quantity: 1, pricePaise: 200000 }],
              },
            ],
          },
          // 16. Phone quality: FORMAT_VALID only
          {
            tenantId: 'shop_a',
            customerId: 'cus_ord_phone_format_valid',
            firstName: 'Gaurav',
            rawPhone: '+91 98000 00016',
            status: 'ACTIVE',
            branchId: 'branch_main',
            marketingOptIn: true,
            channelSuppressed: false,
            verified: true,
            verificationLevel: 'FORMAT_VALID',
            verificationMethod: 'DOUBLE_ENTRY',
            consentSource: 'MOCK',
            orders: [
              {
                orderId: 'ord_wel_fv_1',
                status: 'COMPLETED',
                paid: true,
                netPaise: 200000,
                completedAt: new Date(nowMs - 30 * 60 * 1000),
                branchId: 'branch_main',
                lines: [{ lineId: 'l1', itemRef: 'it_fv1', name: 'Item', quantity: 1, pricePaise: 200000 }],
              },
            ],
          },
          // 17. Two customers sharing one phone
          {
            tenantId: 'shop_a',
            customerId: 'cus_ord_shared_phone_1',
            firstName: 'Amit Family 1',
            rawPhone: '+91 98000 00088',
            status: 'ACTIVE',
            branchId: 'branch_main',
            marketingOptIn: true,
            channelSuppressed: false,
            verified: true,
            verificationLevel: 'CONFIRMED_BY_STAFF',
            verificationMethod: 'COUNTER_READBACK',
            consentSource: 'MOCK',
            orders: [
              {
                orderId: 'ord_wel_sh1_1',
                status: 'COMPLETED',
                paid: true,
                netPaise: 250000,
                completedAt: new Date(nowMs - 30 * 60 * 1000),
                branchId: 'branch_main',
                lines: [{ lineId: 'l1', itemRef: 'it_s1', name: 'Family Shirt', quantity: 1, pricePaise: 250000 }],
              },
            ],
          },
          {
            tenantId: 'shop_a',
            customerId: 'cus_ord_shared_phone_2',
            firstName: 'Sneha Family 2',
            rawPhone: '+91 98000 00088', // Identical phone!
            status: 'ACTIVE',
            branchId: 'branch_main',
            marketingOptIn: true,
            channelSuppressed: false,
            verified: true,
            verificationLevel: 'CONFIRMED_BY_STAFF',
            verificationMethod: 'COUNTER_READBACK',
            consentSource: 'MOCK',
            orders: [
              {
                orderId: 'ord_wel_sh2_1',
                status: 'COMPLETED',
                paid: true,
                netPaise: 250000,
                completedAt: new Date(nowMs - 28 * 60 * 1000),
                branchId: 'branch_main',
                lines: [{ lineId: 'l1', itemRef: 'it_s2', name: 'Family Dress', quantity: 1, pricePaise: 250000 }],
              },
            ],
          },
          // 18. Destination already UNDELIVERABLE
          {
            tenantId: 'shop_a',
            customerId: 'cus_ord_dest_undeliverable',
            firstName: 'Mohit',
            rawPhone: '+91 98000 00018',
            status: 'ACTIVE',
            branchId: 'branch_main',
            marketingOptIn: true,
            channelSuppressed: false,
            verified: true,
            verificationLevel: 'CONFIRMED_BY_STAFF',
            verificationMethod: 'COUNTER_READBACK',
            consentSource: 'MOCK',
            orders: [
              {
                orderId: 'ord_wel_undeliv_1',
                status: 'COMPLETED',
                paid: true,
                netPaise: 250000,
                completedAt: new Date(nowMs - 30 * 60 * 1000),
                branchId: 'branch_main',
                lines: [{ lineId: 'l1', itemRef: 'it_u18', name: 'Item', quantity: 1, pricePaise: 250000 }],
              },
            ],
          },
          // 19. Customer whose phone was corrected
          {
            tenantId: 'shop_a',
            customerId: 'cus_ord_phone_corrected',
            firstName: 'Pooja',
            rawPhone: '+91 98000 00019',
            status: 'ACTIVE',
            branchId: 'branch_main',
            marketingOptIn: true,
            channelSuppressed: false,
            verified: true,
            verificationLevel: 'CONFIRMED_BY_STAFF',
            verificationMethod: 'COUNTER_READBACK',
            consentSource: 'MOCK',
            orders: [
              {
                orderId: 'ord_wel_corr_1',
                status: 'COMPLETED',
                paid: true,
                netPaise: 250000,
                completedAt: new Date(nowMs - 30 * 60 * 1000),
                branchId: 'branch_main',
                lines: [{ lineId: 'l1', itemRef: 'it_cor', name: 'Item', quantity: 1, pricePaise: 250000 }],
              },
            ],
          },
          // 20. Opted-out customer
          {
            tenantId: 'shop_a',
            customerId: 'cus_ord_opted_out',
            firstName: 'Tarun',
            rawPhone: '+91 98000 00020',
            status: 'OPTED_OUT',
            branchId: 'branch_main',
            marketingOptIn: false,
            channelSuppressed: false,
            verified: true,
            verificationLevel: 'CONFIRMED_BY_STAFF',
            verificationMethod: 'COUNTER_READBACK',
            consentSource: 'MOCK',
            orders: [
              {
                orderId: 'ord_wel_opt_1',
                status: 'COMPLETED',
                paid: true,
                netPaise: 200000,
                completedAt: new Date(nowMs - 30 * 60 * 1000),
                branchId: 'branch_main',
                lines: [{ lineId: 'l1', itemRef: 'it_opt', name: 'Item', quantity: 1, pricePaise: 200000 }],
              },
            ],
          },
          // 21. Channel suppressed customer
          {
            tenantId: 'shop_a',
            customerId: 'cus_ord_suppressed',
            firstName: 'Harish',
            rawPhone: '+91 98000 00021',
            status: 'ACTIVE',
            branchId: 'branch_main',
            marketingOptIn: true,
            channelSuppressed: true,
            verified: true,
            verificationLevel: 'CONFIRMED_BY_STAFF',
            verificationMethod: 'COUNTER_READBACK',
            consentSource: 'MOCK',
            orders: [
              {
                orderId: 'ord_wel_sup_1',
                status: 'COMPLETED',
                paid: true,
                netPaise: 200000,
                completedAt: new Date(nowMs - 30 * 60 * 1000),
                branchId: 'branch_main',
                lines: [{ lineId: 'l1', itemRef: 'it_sup', name: 'Item', quantity: 1, pricePaise: 200000 }],
              },
            ],
          },
          // 22. Deleted customer
          {
            tenantId: 'shop_a',
            customerId: 'cus_ord_deleted',
            firstName: 'Deleted Customer',
            rawPhone: '+91 98000 00022',
            status: 'DELETED',
            deletedAt: new Date(nowMs - 10 * 24 * 3600 * 1000),
            branchId: 'branch_main',
            marketingOptIn: true,
            channelSuppressed: false,
            verified: true,
            verificationLevel: 'CONFIRMED_BY_STAFF',
            verificationMethod: 'COUNTER_READBACK',
            consentSource: 'MOCK',
            orders: [
              {
                orderId: 'ord_wel_del_1',
                status: 'COMPLETED',
                paid: true,
                netPaise: 200000,
                completedAt: new Date(nowMs - 30 * 60 * 1000),
                branchId: 'branch_main',
                lines: [{ lineId: 'l1', itemRef: 'it_del', name: 'Item', quantity: 1, pricePaise: 200000 }],
              },
            ],
          },
        ];

        // 23. Live customer(s) from LIVE_CUSTOMER_PHONES
        let rawPhones = (config.LIVE_CUSTOMER_PHONES || config.META_TEST_ALLOWLIST || '').trim();
        const liveList = rawPhones
          .split(',')
          .map((p) => p.trim())
          .filter((p) => p.replace(/\D/g, '').length >= 8);

        if (options.live) {
          liveList.slice(0, 3).forEach((phone, idx) => {
            orderModeCustomers.push({
              tenantId: 'shop_a',
              customerId: `cus_live_welcome_0${idx + 1}`,
              firstName: idx === 0 ? 'Verified Owner (Welcome)' : `Live Welcome Customer ${idx + 1}`,
              rawPhone: phone,
              status: 'ACTIVE',
              branchId: 'branch_main',
              marketingOptIn: true,
              channelSuppressed: false,
              verified: true,
              verificationLevel: 'CONFIRMED_BY_STAFF',
              verificationMethod: 'COUNTER_READBACK',
              consentSource: 'MOCK',
              isLive: true,
              orders: [
                {
                  orderId: `ord_live_welcome_0${idx + 1}`,
                  status: 'COMPLETED',
                  paid: true,
                  netPaise: 280000,
                  completedAt: new Date(nowMs - 61 * 60 * 1000), // Exactly 61 minutes before now!
                  branchId: 'branch_main',
                  lines: [
                    {
                      lineId: `line_live_wel_0${idx + 1}`,
                      itemRef: 'item_handloom_silk',
                      name: 'Handloom Pure Silk Saree',
                      quantity: 1,
                      pricePaise: 280000,
                    },
                  ],
                },
              ],
            });
          });
        }

        // Insert orderModeCustomers
        await insertCustomerBatch('shop_a', orderModeCustomers, 'welcome', session);

        // Pre-seed the UNDELIVERABLE contact gate for cus_wel_dest_undeliverable
        const undelivHash = destinationHash('919800000018');
        await upsertMany(
          'campaignContactGates',
          ['tenantId', 'destinationHash'],
          [
            applySeedLabels(
              {
                tenantId: 'shop_a',
                destinationHash: undelivHash,
                health: {
                  status: 'UNDELIVERABLE',
                  reason: 'RECIPIENT_NOT_ON_WHATSAPP (131026)',
                  lastFailureAt: new Date(nowMs - 2 * 3600 * 1000),
                  failureCount: 1,
                  source: 'PROVIDER_STATUS',
                  clearedAt: null,
                },
                version: 1,
                ledger: [],
              },
              'welcome',
              false
            ),
          ],
          session
        );

        // Seed Anonymous order (no customerId)
        await upsertMany(
          'src_orders',
          ['tenantId', 'orderId'],
          [
            applySeedLabels(
              {
                tenantId: 'shop_a',
                orderId: 'ord_wel_anon',
                customerId: null,
                status: 'COMPLETED',
                paid: true,
                netPaise: 150000,
                completedAt: new Date(nowMs - 30 * 60 * 1000),
                branchId: 'branch_main',
                lines: [{ lineId: 'l1', itemRef: 'it_anon', name: 'Anonymous Cash Sale', quantity: 1, pricePaise: 150000 }],
                entityVersion: 1,
              },
              'welcome',
              true
            ),
          ],
          session
        );
      }

      if (scenario === 'first-repeat') {
        const firstRepeatCampaignId = 'cmp_first_repeat';
        const firstRepeatVersionId = 'ver_first_repeat_1';

        const isMetaMode = (config.DISPATCH_MODE || '').toLowerCase() === 'meta';
        const seedTemplateRef = isMetaMode
          ? {
              id: 'tpl_jaspers_order_conf',
              name: 'jaspers_market_order_confirmation_v1',
              language: 'en_US',
              revision: 1,
            }
          : {
              id: 'tpl_repeat_bring_back',
              name: 'repeat_bring_back',
              language: 'en',
              revision: 1,
            };

        const seedBindings = isMetaMode
          ? {
              '1': 'customer.firstName',
              '2': 'order.firstOrderNumber',
            }
          : {
              '1': 'customer.firstName',
              '2': 'shop.displayName',
              '3': 'order.firstOrderNumber',
            };

        await upsertMany(
          'campaigns',
          ['tenantId', 'campaignId'],
          [
            applySeedLabels(
              {
                tenantId: 'shop_a',
                campaignId: firstRepeatCampaignId,
                name: 'First to Second Purchase Bring-Back',
                status: 'ACTIVE',
                presetId: 'first_to_second_purchase',
                draftVersion: 1,
                activeVersionId: firstRepeatVersionId,
                createdAt: clock.now(),
                updatedAt: clock.now(),
              },
              'first-repeat',
              false
            ),
          ],
          session
        );

        await upsertMany(
          'campaignVersions',
          ['tenantId', 'campaignId', 'version'],
          [
            applySeedLabels(
              {
                tenantId: 'shop_a',
                campaignId: firstRepeatCampaignId,
                version: 1,
                isPublished: true,
                publishedAt: clock.now(),
                name: 'First to Second Purchase Bring-Back',
                category: 'MARKETING',
                purpose: 'MARKETING',
                industry: 'BOUTIQUE',
                timezone: 'Asia/Kolkata',
                presetId: 'first_to_second_purchase',
                trigger: {
                  type: 'EVENT_DELAY',
                  anchor: 'FIRST_QUALIFYING_ORDER',
                },
                audience: {
                  mode: 'ALL_ELIGIBLE',
                  rules: null,
                },
                goal: {
                  type: 'OCCASION_TAGGED_OR_STAFF_COMPLETED',
                },
                enabledBranches: ['branch_main', 'branch_two'],
                steps: [
                  {
                    stepId: 'step_1',
                    stepName: 'Bring Back Reminder',
                    delay: { unit: 'DAYS', value: 30 },
                    outsideHoursPolicy: 'DEFER_NEXT_DAY',
                    maxDeferralHours: 48,
                    maxLatenessMinutes: 1440,
                    stopOnReply: true,
                    stopOnGoal: true,
                    prerequisite: 'NONE',
                    templateRef: seedTemplateRef,
                    bindings: seedBindings,
                  },
                  {
                    stepId: 'step_2',
                    stepName: 'Second Chance Follow-up',
                    delay: { unit: 'DAYS', value: 45 },
                    outsideHoursPolicy: 'DEFER_NEXT_DAY',
                    maxDeferralHours: 48,
                    maxLatenessMinutes: 1440,
                    stopOnReply: true,
                    stopOnGoal: true,
                    prerequisite: 'NONE',
                    templateRef: seedTemplateRef,
                    bindings: seedBindings,
                  },
                ],
                priority: 40,
                resumePolicy: 'FUTURE_ONLY',
                importPolicy: 'FUTURE_ONLY',
              },
              'first-repeat',
              false
            ),
          ],
          session
        );

        await upsertMany(
          'campaignControlGates',
          ['tenantId', 'campaignId'],
          [
            applySeedLabels(
              {
                campaignId: firstRepeatCampaignId,
                tenantId: 'shop_a',
                pauseGeneration: 0,
                version: 1,
              },
              'first-repeat',
              false
            ),
          ],
          session
        );
      }

      if (scenario === 'gift-wedding') {
        const isMetaMode = (config.DISPATCH_MODE || '').toLowerCase() === 'meta';
        const weddingCampaignId = 'cmp_gift_wedding_shop_a';
        const weddingVersionId = 'ver_gift_wedding_shop_a_1';

        const tplInviteRef = isMetaMode
          ? { id: 'tpl_hello_world', name: 'hello_world', language: 'en_US', revision: 1 }
          : { id: 'tpl_wedding_invite', name: 'wedding_invite', language: 'en', revision: 1 };
        const tplFollowupRef = isMetaMode
          ? { id: 'tpl_hello_world', name: 'hello_world', language: 'en_US', revision: 1 }
          : { id: 'tpl_wedding_followup', name: 'wedding_followup', language: 'en', revision: 1 };

        const inviteBindings = isMetaMode
          ? {}
          : {
              '1': { source: 'customer.firstName' },
              '2': { source: 'event.localDate' },
              '3': { source: 'shop.displayName' },
            };
        const followupBindings = isMetaMode
          ? {}
          : {
              '1': { source: 'customer.firstName' },
              '2': { source: 'shop.displayName' },
              '3': { source: 'event.localDate' },
            };

        await upsertMany(
          'campaigns',
          ['tenantId', 'campaignId'],
          [
            applySeedLabels(
              {
                campaignId: weddingCampaignId,
                tenantId: 'shop_a',
                name: 'Wedding Reminder Campaign',
                presetId: 'gift_wedding_reminder',
                status: 'ACTIVE',
                activeVersionId: weddingVersionId,
                draftVersion: 1,
                pauseGeneration: 0,
                enabledBranches: ['branch_main', 'branch_two'],
                activatedAt: new Date(clock.now().getTime() - 60 * 60 * 1000),
              },
              'gift-wedding',
              false
            ),
          ],
          session
        );

        await upsertMany(
          'campaignVersions',
          ['tenantId', 'campaignId', 'version'],
          [
            applySeedLabels(
              {
                campaignId: weddingCampaignId,
                tenantId: 'shop_a',
                version: 1,
                name: 'Wedding Reminder Campaign',
                industry: 'BOUTIQUE',
                purpose: 'MARKETING',
                priority: 70,
                category: 'MARKETING',
                presetId: 'gift_wedding_reminder',
                trigger: {
                  type: 'CUSTOMER_EVENT_DATE',
                  occasionKind: 'WEDDING',
                  fulfillmentLeadDays: 21,
                },
                audience: {
                  mode: 'ALL_ELIGIBLE',
                  rules: null,
                },
                goal: {
                  type: 'OCCASION_TAGGED_OR_STAFF_COMPLETED',
                },
                enabledBranches: ['branch_main', 'branch_two'],
                steps: [
                  {
                    stepId: 'step_wedding_d45',
                    stepName: '45 Days Before Wedding',
                    offsetDays: -45,
                    localTime: '10:00',
                    prerequisite: 'NONE',
                    outsideHoursPolicy: 'DEFER_NEXT_DAY',
                    maxDeferralHours: 24,
                    maxLatenessMinutes: 180,
                    stopOnReply: true,
                    stopOnGoal: true,
                    templateRef: tplInviteRef,
                    bindings: inviteBindings,
                  },
                  {
                    stepId: 'step_wedding_d21',
                    stepName: '21 Days Before Wedding',
                    offsetDays: -21,
                    localTime: '10:00',
                    prerequisite: 'PREVIOUS_ACCEPTED',
                    outsideHoursPolicy: 'DEFER_NEXT_DAY',
                    maxDeferralHours: 24,
                    maxLatenessMinutes: 180,
                    stopOnReply: true,
                    stopOnGoal: true,
                    templateRef: tplFollowupRef,
                    bindings: followupBindings,
                  },
                ],
                timezone: 'Asia/Kolkata',
                bindingsSchemaVersion: 2,
                isPublished: true,
                publishedAt: clock.now(),
                activatedBy: 'owner@shop-a.com',
                activatedAt: new Date(clock.now().getTime() - 60 * 60 * 1000),
              },
              'gift-wedding',
              false
            ),
          ],
          session
        );

        await upsertMany(
          'campaignControlGates',
          ['tenantId', 'campaignId'],
          [
            applySeedLabels(
              {
                campaignId: weddingCampaignId,
                tenantId: 'shop_a',
                pauseGeneration: 0,
                version: 1,
              },
              'gift-wedding',
              false
            ),
          ],
          session
        );

        // Provision Gift Reminder Campaign (GIFT occasionKind)
        const giftCampaignId = 'cmp_gift_reminder_shop_a';
        const giftVersionId = 'ver_gift_reminder_shop_a_1';

        const tplGiftRef = isMetaMode
          ? { id: 'tpl_hello_world', name: 'hello_world', language: 'en_US', revision: 1 }
          : { id: 'tpl_gift_reminder', name: 'gift_reminder', language: 'en', revision: 1 };

        const giftBindings = isMetaMode
          ? {}
          : {
              '1': { source: 'customer.firstName' },
              '2': { source: 'event.recipientLabel' },
              '3': { source: 'shop.displayName' },
            };

        await upsertMany(
          'campaigns',
          ['tenantId', 'campaignId'],
          [
            applySeedLabels(
              {
                campaignId: giftCampaignId,
                tenantId: 'shop_a',
                name: 'Gift Reminder Campaign',
                presetId: 'gift_wedding_reminder',
                status: 'ACTIVE',
                activeVersionId: giftVersionId,
                draftVersion: 1,
                pauseGeneration: 0,
                enabledBranches: ['branch_main', 'branch_two'],
                activatedAt: new Date(clock.now().getTime() - 60 * 60 * 1000),
              },
              'gift-wedding',
              false
            ),
          ],
          session
        );

        await upsertMany(
          'campaignVersions',
          ['tenantId', 'campaignId', 'version'],
          [
            applySeedLabels(
              {
                campaignId: giftCampaignId,
                tenantId: 'shop_a',
                version: 1,
                name: 'Gift Reminder Campaign',
                industry: 'BOUTIQUE',
                purpose: 'MARKETING',
                priority: 65,
                category: 'MARKETING',
                presetId: 'gift_wedding_reminder',
                trigger: {
                  type: 'CUSTOMER_EVENT_DATE',
                  occasionKind: 'GIFT',
                  fulfillmentLeadDays: 2,
                },
                audience: {
                  mode: 'ALL_ELIGIBLE',
                  rules: null,
                },
                goal: {
                  type: 'OCCASION_TAGGED_OR_STAFF_COMPLETED',
                },
                enabledBranches: ['branch_main', 'branch_two'],
                steps: [
                  {
                    stepId: 'step_gift_d10',
                    stepName: '10 Days Before Gift Occasion',
                    offsetDays: -10,
                    localTime: '10:00',
                    prerequisite: 'NONE',
                    outsideHoursPolicy: 'DEFER_NEXT_DAY',
                    maxDeferralHours: 24,
                    maxLatenessMinutes: 180,
                    stopOnReply: true,
                    stopOnGoal: true,
                    templateRef: tplGiftRef,
                    bindings: giftBindings,
                  },
                  {
                    stepId: 'step_gift_d3',
                    stepName: '3 Days Before Gift Occasion',
                    offsetDays: -3,
                    localTime: '10:00',
                    prerequisite: 'NONE',
                    outsideHoursPolicy: 'DEFER_NEXT_DAY',
                    maxDeferralHours: 24,
                    maxLatenessMinutes: 180,
                    stopOnReply: true,
                    stopOnGoal: true,
                    templateRef: tplGiftRef,
                    bindings: giftBindings,
                  },
                ],
                timezone: 'Asia/Kolkata',
                bindingsSchemaVersion: 2,
                isPublished: true,
                publishedAt: clock.now(),
                activatedBy: 'owner@shop-a.com',
                activatedAt: new Date(clock.now().getTime() - 60 * 60 * 1000),
              },
              'gift-wedding',
              false
            ),
          ],
          session
        );

        await upsertMany(
          'campaignControlGates',
          ['tenantId', 'campaignId'],
          [
            applySeedLabels(
              {
                campaignId: giftCampaignId,
                tenantId: 'shop_a',
                pauseGeneration: 0,
                version: 1,
              },
              'gift-wedding',
              false
            ),
          ],
          session
        );
      }

      if (scenario === 'unresolved-enquiry') {
        const enquiryCampaignId = 'cmp_unresolved_enquiry_shop_a';
        const enquiryVersionId = 'ver_unresolved_enquiry_shop_a_1';

        // 1. Seed Products for shop_a
        const productDocs = [
          {
            tenantId: 'shop_a',
            productId: 'prod_kanjivaram_silk',
            name: 'Kanjivaram Silk Saree',
            status: 'ACTIVE',
            entityVersion: 1,
            variants: [
              {
                variantId: 'var_gold_border',
                label: 'Gold Zari Border',
                sellableQty: 10,
                version: 1,
              },
            ],
          },
          {
            tenantId: 'shop_a',
            productId: 'prod_linen_shirt',
            name: 'Linen Casual Shirt',
            status: 'ACTIVE',
            entityVersion: 1,
            variants: [
              {
                variantId: 'var_linen_blue',
                label: 'Sky Blue M',
                sellableQty: 0, // Out of stock
                version: 1,
              },
            ],
          },
          {
            tenantId: 'shop_a',
            productId: 'prod_discontinued_kurta',
            name: 'Discontinued Kurta',
            status: 'DISCONTINUED', // Discontinued product
            entityVersion: 1,
            variants: [
              {
                variantId: 'var_d1',
                label: 'Standard',
                sellableQty: 5,
                version: 1,
              },
            ],
          },
          {
            tenantId: 'shop_a',
            productId: 'prod_other',
            name: 'Cotton Dupatta',
            status: 'ACTIVE',
            entityVersion: 1,
            variants: [
              {
                variantId: 'var_other_red',
                label: 'Crimson Red',
                sellableQty: 20,
                version: 1,
              },
            ],
          },
        ];
        await upsertMany(
          'src_products',
          ['tenantId', 'productId'],
          applySeedLabels(productDocs, 'unresolved-enquiry', true),
          session
        );

        // 2. Extra customer fixtures needed for edge cases
        const now = clock.now();
        const nowMs = now.getTime();

        const extraCustomers = [
          {
            tenantId: 'shop_a',
            customerId: 'cus_enq_open_item',
            firstName: 'Lakshmi',
            rawPhone: '+91 91000 00101',
            status: 'ACTIVE',
            branchId: 'branch_main',
            marketingOptIn: true,
            channelSuppressed: false,
            verified: true,
          },
          {
            tenantId: 'shop_a',
            customerId: 'cus_enq_open_no_item',
            firstName: 'Priya',
            rawPhone: '+91 91000 00102',
            status: 'ACTIVE',
            branchId: 'branch_main',
            marketingOptIn: true,
            channelSuppressed: false,
            verified: true,
          },
          {
            tenantId: 'shop_a',
            customerId: 'cus_enq_23h',
            firstName: 'Aarti',
            rawPhone: '+91 91000 00103',
            status: 'ACTIVE',
            branchId: 'branch_main',
            marketingOptIn: true,
            channelSuppressed: false,
            verified: true,
          },
          {
            tenantId: 'shop_a',
            customerId: 'cus_enq_30h',
            firstName: 'Sunita',
            rawPhone: '+91 91000 00104',
            status: 'ACTIVE',
            branchId: 'branch_main',
            marketingOptIn: true,
            channelSuppressed: false,
            verified: true,
          },
          {
            tenantId: 'shop_a',
            customerId: 'cus_enq_80h',
            firstName: 'Meera',
            rawPhone: '+91 91000 00105',
            status: 'ACTIVE',
            branchId: 'branch_main',
            marketingOptIn: true,
            channelSuppressed: false,
            verified: true,
          },
          {
            tenantId: 'shop_a',
            customerId: 'cus_enq_too_old',
            firstName: 'Radha',
            rawPhone: '+91 91000 00106',
            status: 'ACTIVE',
            branchId: 'branch_main',
            marketingOptIn: true,
            channelSuppressed: false,
            verified: true,
          },
          {
            tenantId: 'shop_a',
            customerId: 'cus_enq_takeover',
            firstName: 'Kavita',
            rawPhone: '+91 91000 00107',
            status: 'ACTIVE',
            branchId: 'branch_main',
            marketingOptIn: true,
            channelSuppressed: false,
            verified: true,
          },
          {
            tenantId: 'shop_a',
            customerId: 'cus_enq_resolved',
            firstName: 'Anita',
            rawPhone: '+91 91000 00108',
            status: 'ACTIVE',
            branchId: 'branch_main',
            marketingOptIn: true,
            channelSuppressed: false,
            verified: true,
          },
          {
            tenantId: 'shop_a',
            customerId: 'cus_enq_closed',
            firstName: 'Pooja',
            rawPhone: '+91 91000 00109',
            status: 'ACTIVE',
            branchId: 'branch_main',
            marketingOptIn: true,
            channelSuppressed: false,
            verified: true,
          },
          {
            tenantId: 'shop_a',
            customerId: 'cus_enq_cancelled',
            firstName: 'Divya',
            rawPhone: '+91 91000 00110',
            status: 'ACTIVE',
            branchId: 'branch_main',
            marketingOptIn: true,
            channelSuppressed: false,
            verified: true,
          },
          {
            tenantId: 'shop_a',
            customerId: 'cus_enq_deleted',
            firstName: 'Sneha',
            rawPhone: '+91 91000 00111',
            status: 'ACTIVE',
            branchId: 'branch_main',
            marketingOptIn: true,
            channelSuppressed: false,
            verified: true,
          },
          {
            tenantId: 'shop_a',
            customerId: 'cus_enq_two_enquiries',
            firstName: 'Neha',
            rawPhone: '+91 91000 00112',
            status: 'ACTIVE',
            branchId: 'branch_main',
            marketingOptIn: true,
            channelSuppressed: false,
            verified: true,
          },
          {
            tenantId: 'shop_a',
            customerId: 'cus_enq_out_of_stock',
            firstName: 'Ananya',
            rawPhone: '+91 91000 00113',
            status: 'ACTIVE',
            branchId: 'branch_main',
            marketingOptIn: true,
            channelSuppressed: false,
            verified: true,
          },
          {
            tenantId: 'shop_a',
            customerId: 'cus_enq_buyer',
            firstName: 'Shilpa Buyer',
            rawPhone: '+91 91000 00114',
            status: 'ACTIVE',
            branchId: 'branch_main',
            marketingOptIn: true,
            channelSuppressed: false,
            verified: true,
          },
          {
            tenantId: 'shop_a',
            customerId: 'cus_enq_unrelated_buyer',
            firstName: 'Urmila Unrelated',
            rawPhone: '+91 91000 00115',
            status: 'ACTIVE',
            branchId: 'branch_main',
            marketingOptIn: true,
            channelSuppressed: false,
            verified: true,
          },
          {
            tenantId: 'shop_a',
            customerId: 'cus_enq_opted_out',
            firstName: 'Opted Out Customer',
            rawPhone: '+91 91000 00116',
            status: 'ACTIVE',
            branchId: 'branch_main',
            marketingOptIn: false,
            channelSuppressed: false,
            verified: true,
          },
          {
            tenantId: 'shop_a',
            customerId: 'cus_enq_unverified',
            firstName: 'Unverified Customer',
            rawPhone: '+91 91000 00117',
            status: 'ACTIVE',
            branchId: 'branch_main',
            marketingOptIn: true,
            channelSuppressed: false,
            verified: false,
          },
          {
            tenantId: 'shop_a',
            customerId: 'cus_enq_undeliverable',
            firstName: 'Undeliverable Customer',
            rawPhone: '+91 91000 00118',
            status: 'ACTIVE',
            branchId: 'branch_main',
            marketingOptIn: true,
            channelSuppressed: false,
            verified: true,
          },
          {
            tenantId: 'shop_a',
            customerId: 'cus_enq_shared_1',
            firstName: 'Shared Phone One',
            rawPhone: '+91 91000 00119',
            status: 'ACTIVE',
            branchId: 'branch_main',
            marketingOptIn: true,
            channelSuppressed: false,
            verified: true,
          },
          {
            tenantId: 'shop_a',
            customerId: 'cus_enq_shared_2',
            firstName: 'Shared Phone Two',
            rawPhone: '+91 91000 00119',
            status: 'ACTIVE',
            branchId: 'branch_main',
            marketingOptIn: true,
            channelSuppressed: false,
            verified: true,
          },
          {
            tenantId: 'shop_a',
            customerId: 'cus_enq_no_phone',
            firstName: 'No Phone Customer',
            rawPhone: '',
            status: 'ACTIVE',
            branchId: 'branch_main',
            marketingOptIn: true,
            channelSuppressed: false,
            verified: false,
          },
        ];

        const custDocs: any[] = [];
        const gateDocs: any[] = [];
        for (const cust of extraCustomers) {
          const hasPhone = Boolean(cust.rawPhone && cust.rawPhone.trim());
          const encPhone = hasPhone ? encryptPhone(cust.rawPhone) : '';
          const destHash = hasPhone ? destinationHash(cust.rawPhone) : '';
          const masked = hasPhone ? maskPhone(cust.rawPhone) : '';

          custDocs.push({
            tenantId: cust.tenantId,
            customerId: cust.customerId,
            firstName: cust.firstName,
            destination: hasPhone
              ? {
                  encryptedPhone: encPhone,
                  destinationHash: destHash,
                  masked,
                  verified: cust.verified,
                  version: 1,
                  verificationLevel: cust.verified ? 'CONFIRMED_BY_STAFF' : 'UNVERIFIED',
                  verifiedAt: cust.verified ? now : null,
                  verificationMethod: cust.verified ? 'MOCK' : null,
                }
              : {
                  encryptedPhone: '',
                  destinationHash: '',
                  masked: '',
                  verified: false,
                  version: 1,
                  verificationLevel: 'UNVERIFIED',
                  verifiedAt: null,
                  verificationMethod: null,
                },
            birthday: null,
            consent: {
              marketingOptIn: cust.marketingOptIn,
              channelSuppressed: cust.channelSuppressed,
              consentCapturedAt: cust.marketingOptIn ? now : null,
              consentSource: cust.marketingOptIn ? 'MOCK' : null,
            },
            preferences: {},
            tags: ['unresolved_enquiry_fixture'],
            status: cust.status,
            branchId: cust.branchId,
            language: 'en',
            isLive: false,
          });

          if (cust.customerId === 'cus_enq_undeliverable') {
            gateDocs.push({
              tenantId: 'shop_a',
              destinationHash: destHash,
              version: 1,
              health: {
                status: 'UNDELIVERABLE',
                reason: 'UNDELIVERABLE_PERMANENT',
                failureCount: 1,
                lastFailureAt: now,
                source: 'PROVIDER_STATUS',
              },
              ledger: [],
            });
          }
        }

        await upsertMany(
          'src_customers',
          ['tenantId', 'customerId'],
          applySeedLabels(custDocs, 'unresolved-enquiry', true),
          session
        );

        if (gateDocs.length > 0) {
          await upsertMany(
            'campaignContactGates',
            ['tenantId', 'destinationHash'],
            applySeedLabels(gateDocs, 'unresolved-enquiry'),
            session
          );
        }

        // 3. Seed orders for customer purchases (goal testing)
        const buyerEnquiryCreatedAt = new Date(nowMs - 24 * 3600000);
        await upsertMany(
          'src_orders',
          ['tenantId', 'orderId'],
          applySeedLabels(
            [
              {
                tenantId: 'shop_a',
                orderId: 'ord_enq_buyer_001',
                customerId: 'cus_enq_buyer',
                status: 'COMPLETED',
                paid: true,
                netPaise: 1250000,
                completedAt: new Date(nowMs - 12 * 3600000), // 12h ago, after createdAt
                branchId: 'branch_main',
                entityVersion: 1,
                lines: [
                  {
                    lineId: 'line_buyer_1',
                    itemRef: 'prod_kanjivaram_silk',
                    productId: 'prod_kanjivaram_silk',
                    variantId: 'var_gold_border',
                    name: 'Kanjivaram Silk Saree',
                    quantity: 1,
                    pricePaise: 1250000,
                  },
                ],
              },
              {
                tenantId: 'shop_a',
                orderId: 'ord_enq_unrelated_001',
                customerId: 'cus_enq_unrelated_buyer',
                status: 'COMPLETED',
                paid: true,
                netPaise: 450000,
                completedAt: new Date(nowMs - 12 * 3600000), // after createdAt
                branchId: 'branch_main',
                entityVersion: 1,
                lines: [
                  {
                    lineId: 'line_unrelated_1',
                    itemRef: 'prod_other',
                    productId: 'prod_other',
                    variantId: 'var_other_red',
                    name: 'Cotton Dupatta',
                    quantity: 1,
                    pricePaise: 450000,
                  },
                ],
              },
            ],
            'unresolved-enquiry',
            true
          ),
          session
        );

        // 4. Calculate live customer's interaction time:
        const nowKolkata = DateTime.fromJSDate(now, { zone: 'Asia/Kolkata' });
        let next1005 = nowKolkata.set({ hour: 10, minute: 5, second: 0, millisecond: 0 });
        if (next1005 <= nowKolkata) {
          next1005 = next1005.plus({ days: 1 });
        }
        const liveInteractionAt = next1005.minus({ hours: 24 }).toJSDate();

        // 5. Seed src_enquiries
        const enquiryDocs: any[] = [
          {
            tenantId: 'shop_a',
            enquiryId: 'enq_open_item',
            customerId: 'cus_enq_open_item',
            branchId: 'branch_main',
            channel: 'IN_STORE',
            status: 'OPEN',
            staffTakeover: false,
            itemRef: { productId: 'prod_kanjivaram_silk', variantId: 'var_gold_border' },
            createdAt: new Date(nowMs - 2 * 3600000),
            lastCustomerInteractionAt: new Date(nowMs - 2 * 3600000),
            updatedAt: new Date(nowMs - 2 * 3600000),
            entityVersion: 1,
            source: 'MOCK',
          },
          {
            tenantId: 'shop_a',
            enquiryId: 'enq_open_no_item',
            customerId: 'cus_enq_open_no_item',
            branchId: 'branch_main',
            channel: 'PHONE',
            status: 'OPEN',
            staffTakeover: false,
            itemRef: null,
            createdAt: new Date(nowMs - 5 * 3600000),
            lastCustomerInteractionAt: new Date(nowMs - 5 * 3600000),
            updatedAt: new Date(nowMs - 5 * 3600000),
            entityVersion: 1,
            source: 'MOCK',
          },
          {
            tenantId: 'shop_a',
            enquiryId: 'enq_interaction_23h',
            customerId: 'cus_enq_23h',
            branchId: 'branch_main',
            channel: 'IN_STORE',
            status: 'OPEN',
            staffTakeover: false,
            itemRef: { productId: 'prod_kanjivaram_silk', variantId: 'var_gold_border' },
            createdAt: new Date(nowMs - 23 * 3600000),
            lastCustomerInteractionAt: new Date(nowMs - 23 * 3600000),
            updatedAt: new Date(nowMs - 23 * 3600000),
            entityVersion: 1,
            source: 'MOCK',
          },
          {
            tenantId: 'shop_a',
            enquiryId: 'enq_interaction_30h',
            customerId: 'cus_enq_30h',
            branchId: 'branch_main',
            channel: 'IN_STORE',
            status: 'OPEN',
            staffTakeover: false,
            itemRef: { productId: 'prod_kanjivaram_silk', variantId: 'var_gold_border' },
            createdAt: new Date(nowMs - 30 * 3600000),
            lastCustomerInteractionAt: new Date(nowMs - 30 * 3600000),
            updatedAt: new Date(nowMs - 30 * 3600000),
            entityVersion: 1,
            source: 'MOCK',
          },
          {
            tenantId: 'shop_a',
            enquiryId: 'enq_interaction_80h',
            customerId: 'cus_enq_80h',
            branchId: 'branch_main',
            channel: 'IN_STORE',
            status: 'OPEN',
            staffTakeover: false,
            itemRef: { productId: 'prod_kanjivaram_silk', variantId: 'var_gold_border' },
            createdAt: new Date(nowMs - 80 * 3600000),
            lastCustomerInteractionAt: new Date(nowMs - 80 * 3600000),
            updatedAt: new Date(nowMs - 80 * 3600000),
            entityVersion: 1,
            source: 'MOCK',
          },
          {
            tenantId: 'shop_a',
            enquiryId: 'enq_too_old_20d',
            customerId: 'cus_enq_too_old',
            branchId: 'branch_main',
            channel: 'IN_STORE',
            status: 'OPEN',
            staffTakeover: false,
            itemRef: { productId: 'prod_kanjivaram_silk', variantId: 'var_gold_border' },
            createdAt: new Date(nowMs - 20 * 86400000),
            lastCustomerInteractionAt: new Date(nowMs - 20 * 86400000),
            updatedAt: new Date(nowMs - 20 * 86400000),
            entityVersion: 1,
            source: 'MOCK',
          },
          {
            tenantId: 'shop_a',
            enquiryId: 'enq_staff_takeover',
            customerId: 'cus_enq_takeover',
            branchId: 'branch_main',
            channel: 'IN_STORE',
            status: 'OPEN',
            staffTakeover: true,
            itemRef: { productId: 'prod_kanjivaram_silk', variantId: 'var_gold_border' },
            createdAt: new Date(nowMs - 3 * 3600000),
            lastCustomerInteractionAt: new Date(nowMs - 3 * 3600000),
            updatedAt: new Date(nowMs - 3 * 3600000),
            entityVersion: 1,
            source: 'MOCK',
          },
          {
            tenantId: 'shop_a',
            enquiryId: 'enq_resolved',
            customerId: 'cus_enq_resolved',
            branchId: 'branch_main',
            channel: 'IN_STORE',
            status: 'RESOLVED',
            staffTakeover: false,
            itemRef: { productId: 'prod_kanjivaram_silk', variantId: 'var_gold_border' },
            createdAt: new Date(nowMs - 10 * 3600000),
            lastCustomerInteractionAt: new Date(nowMs - 10 * 3600000),
            updatedAt: new Date(nowMs - 10 * 3600000),
            entityVersion: 1,
            source: 'MOCK',
          },
          {
            tenantId: 'shop_a',
            enquiryId: 'enq_closed',
            customerId: 'cus_enq_closed',
            branchId: 'branch_main',
            channel: 'IN_STORE',
            status: 'CLOSED',
            staffTakeover: false,
            itemRef: { productId: 'prod_kanjivaram_silk', variantId: 'var_gold_border' },
            createdAt: new Date(nowMs - 10 * 3600000),
            lastCustomerInteractionAt: new Date(nowMs - 10 * 3600000),
            updatedAt: new Date(nowMs - 10 * 3600000),
            entityVersion: 1,
            source: 'MOCK',
          },
          {
            tenantId: 'shop_a',
            enquiryId: 'enq_cancelled',
            customerId: 'cus_enq_cancelled',
            branchId: 'branch_main',
            channel: 'IN_STORE',
            status: 'CANCELLED',
            staffTakeover: false,
            itemRef: { productId: 'prod_kanjivaram_silk', variantId: 'var_gold_border' },
            createdAt: new Date(nowMs - 10 * 3600000),
            lastCustomerInteractionAt: new Date(nowMs - 10 * 3600000),
            updatedAt: new Date(nowMs - 10 * 3600000),
            entityVersion: 1,
            source: 'MOCK',
          },
          {
            tenantId: 'shop_a',
            enquiryId: 'enq_deleted',
            customerId: 'cus_enq_deleted',
            branchId: 'branch_main',
            channel: 'IN_STORE',
            status: 'DELETED',
            staffTakeover: false,
            itemRef: { productId: 'prod_kanjivaram_silk', variantId: 'var_gold_border' },
            createdAt: new Date(nowMs - 10 * 3600000),
            lastCustomerInteractionAt: new Date(nowMs - 10 * 3600000),
            updatedAt: new Date(nowMs - 10 * 3600000),
            entityVersion: 1,
            source: 'MOCK',
          },
          {
            tenantId: 'shop_a',
            enquiryId: 'enq_anonymous',
            customerId: null,
            branchId: 'branch_main',
            channel: 'IN_STORE',
            status: 'OPEN',
            staffTakeover: false,
            itemRef: { productId: 'prod_kanjivaram_silk', variantId: 'var_gold_border' },
            createdAt: new Date(nowMs - 4 * 3600000),
            lastCustomerInteractionAt: new Date(nowMs - 4 * 3600000),
            updatedAt: new Date(nowMs - 4 * 3600000),
            entityVersion: 1,
            source: 'MOCK',
          },
          {
            tenantId: 'shop_a',
            enquiryId: 'enq_cust_two_1',
            customerId: 'cus_enq_two_enquiries',
            branchId: 'branch_main',
            channel: 'IN_STORE',
            status: 'OPEN',
            staffTakeover: false,
            itemRef: { productId: 'prod_kanjivaram_silk', variantId: 'var_gold_border' },
            createdAt: new Date(nowMs - 6 * 3600000),
            lastCustomerInteractionAt: new Date(nowMs - 6 * 3600000),
            updatedAt: new Date(nowMs - 6 * 3600000),
            entityVersion: 1,
            source: 'MOCK',
          },
          {
            tenantId: 'shop_a',
            enquiryId: 'enq_cust_two_2',
            customerId: 'cus_enq_two_enquiries',
            branchId: 'branch_main',
            channel: 'PHONE',
            status: 'OPEN',
            staffTakeover: false,
            itemRef: null,
            createdAt: new Date(nowMs - 5 * 3600000),
            lastCustomerInteractionAt: new Date(nowMs - 5 * 3600000),
            updatedAt: new Date(nowMs - 5 * 3600000),
            entityVersion: 1,
            source: 'MOCK',
          },
          {
            tenantId: 'shop_a',
            enquiryId: 'enq_out_of_stock',
            customerId: 'cus_enq_out_of_stock',
            branchId: 'branch_main',
            channel: 'IN_STORE',
            status: 'OPEN',
            staffTakeover: false,
            itemRef: { productId: 'prod_linen_shirt', variantId: 'var_linen_blue' },
            createdAt: new Date(nowMs - 4 * 3600000),
            lastCustomerInteractionAt: new Date(nowMs - 4 * 3600000),
            updatedAt: new Date(nowMs - 4 * 3600000),
            entityVersion: 1,
            source: 'MOCK',
          },
          {
            tenantId: 'shop_a',
            enquiryId: 'enq_buys_item',
            customerId: 'cus_enq_buyer',
            branchId: 'branch_main',
            channel: 'IN_STORE',
            status: 'OPEN',
            staffTakeover: false,
            itemRef: { productId: 'prod_kanjivaram_silk', variantId: 'var_gold_border' },
            createdAt: buyerEnquiryCreatedAt,
            lastCustomerInteractionAt: buyerEnquiryCreatedAt,
            updatedAt: buyerEnquiryCreatedAt,
            entityVersion: 1,
            source: 'MOCK',
          },
          {
            tenantId: 'shop_a',
            enquiryId: 'enq_buys_unrelated',
            customerId: 'cus_enq_unrelated_buyer',
            branchId: 'branch_main',
            channel: 'IN_STORE',
            status: 'OPEN',
            staffTakeover: false,
            itemRef: { productId: 'prod_kanjivaram_silk', variantId: 'var_gold_border' },
            createdAt: buyerEnquiryCreatedAt,
            lastCustomerInteractionAt: buyerEnquiryCreatedAt,
            updatedAt: buyerEnquiryCreatedAt,
            entityVersion: 1,
            source: 'MOCK',
          },
          {
            tenantId: 'shop_a',
            enquiryId: 'enq_opted_out',
            customerId: 'cus_enq_opted_out',
            branchId: 'branch_main',
            channel: 'IN_STORE',
            status: 'OPEN',
            staffTakeover: false,
            itemRef: { productId: 'prod_kanjivaram_silk', variantId: 'var_gold_border' },
            createdAt: new Date(nowMs - 2 * 3600000),
            lastCustomerInteractionAt: new Date(nowMs - 2 * 3600000),
            updatedAt: new Date(nowMs - 2 * 3600000),
            entityVersion: 1,
            source: 'MOCK',
          },
          {
            tenantId: 'shop_a',
            enquiryId: 'enq_unverified',
            customerId: 'cus_enq_unverified',
            branchId: 'branch_main',
            channel: 'IN_STORE',
            status: 'OPEN',
            staffTakeover: false,
            itemRef: { productId: 'prod_kanjivaram_silk', variantId: 'var_gold_border' },
            createdAt: new Date(nowMs - 2 * 3600000),
            lastCustomerInteractionAt: new Date(nowMs - 2 * 3600000),
            updatedAt: new Date(nowMs - 2 * 3600000),
            entityVersion: 1,
            source: 'MOCK',
          },
          {
            tenantId: 'shop_a',
            enquiryId: 'enq_undeliverable',
            customerId: 'cus_enq_undeliverable',
            branchId: 'branch_main',
            channel: 'IN_STORE',
            status: 'OPEN',
            staffTakeover: false,
            itemRef: { productId: 'prod_kanjivaram_silk', variantId: 'var_gold_border' },
            createdAt: new Date(nowMs - 2 * 3600000),
            lastCustomerInteractionAt: new Date(nowMs - 2 * 3600000),
            updatedAt: new Date(nowMs - 2 * 3600000),
            entityVersion: 1,
            source: 'MOCK',
          },
          {
            tenantId: 'shop_a',
            enquiryId: 'enq_no_phone',
            customerId: 'cus_enq_no_phone',
            branchId: 'branch_main',
            channel: 'IN_STORE',
            status: 'OPEN',
            staffTakeover: false,
            itemRef: { productId: 'prod_kanjivaram_silk', variantId: 'var_gold_border' },
            createdAt: new Date(nowMs - 2 * 3600000),
            lastCustomerInteractionAt: new Date(nowMs - 2 * 3600000),
            updatedAt: new Date(nowMs - 2 * 3600000),
            entityVersion: 1,
            source: 'MOCK',
          },
        ];

        // Seed live customer enquiry if live customer exists and options.live is true
        const liveCust = shopACustomers.find((c) => c.isLive);
        if (liveCust && options.live) {
          enquiryDocs.push({
            tenantId: 'shop_a',
            enquiryId: 'enq_live_01',
            customerId: liveCust.customerId,
            branchId: 'branch_main',
            channel: 'IN_STORE',
            status: 'OPEN',
            staffTakeover: false,
            itemRef: { productId: 'prod_kanjivaram_silk', variantId: 'var_gold_border' },
            createdAt: liveInteractionAt,
            lastCustomerInteractionAt: liveInteractionAt,
            updatedAt: liveInteractionAt,
            entityVersion: 1,
            source: 'MOCK',
          });
        }

        await upsertMany(
          'src_enquiries',
          ['tenantId', 'enquiryId'],
          applySeedLabels(enquiryDocs, 'unresolved-enquiry', true),
          session
        );

        // 6. Campaign & Version Model
        const tplStep1Ref = { id: 'tpl_enquiry_followup_item', name: 'tpl_enquiry_followup_item', language: 'en', revision: 1 };
        const tplStep2Ref = { id: 'tpl_enquiry_followup_general', name: 'tpl_enquiry_followup_general', language: 'en', revision: 1 };

        const step1Bindings = {
          '1': { source: 'customer.firstName' },
          '2': { source: 'shop.displayName' },
          '3': { source: 'item.name', fallbackLiteral: 'the item you asked about' },
        };
        const step2Bindings = {
          '1': { source: 'customer.firstName' },
          '2': { source: 'shop.displayName' },
        };

        await upsertMany(
          'campaigns',
          ['tenantId', 'campaignId'],
          [
            applySeedLabels(
              {
                campaignId: enquiryCampaignId,
                tenantId: 'shop_a',
                name: 'Unresolved Enquiry Follow-up',
                presetId: 'unresolved_enquiry',
                status: 'ACTIVE',
                activeVersionId: enquiryVersionId,
                draftVersion: 1,
                pauseGeneration: 0,
                enabledBranches: ['branch_main', 'branch_two'],
                activatedAt: new Date(nowMs - 60 * 60 * 1000),
              },
              'unresolved-enquiry',
              false
            ),
          ],
          session
        );

        await upsertMany(
          'campaignVersions',
          ['tenantId', 'campaignId', 'version'],
          [
            applySeedLabels(
              {
                campaignId: enquiryCampaignId,
                tenantId: 'shop_a',
                version: 1,
                name: 'Unresolved Enquiry Follow-up',
                industry: 'BOUTIQUE',
                purpose: 'MARKETING',
                priority: 55,
                category: 'MARKETING',
                presetId: 'unresolved_enquiry',
                trigger: {
                  type: 'ENQUIRY_EVENT_DELAY',
                  anchor: 'ENQUIRY_LAST_INTERACTION',
                },
                usefulForDays: 14,
                goalMode: 'ITEM_OR_TAGGED',
                requireItem: false,
                audience: {
                  mode: 'ALL_ELIGIBLE',
                  rules: null,
                },
                goal: {
                  type: 'OCCASION_TAGGED_OR_STAFF_COMPLETED',
                },
                enabledBranches: ['branch_main', 'branch_two'],
                steps: [
                  {
                    stepId: 'step_enq_nudge_1',
                    stepName: 'First Follow-up Nudge',
                    offsetDays: 0,
                    localTime: '10:00',
                    prerequisite: 'NONE',
                    delay: { value: 24, unit: 'HOURS' },
                    outsideHoursPolicy: 'DEFER_NEXT_DAY',
                    maxDeferralHours: 24,
                    maxLatenessMinutes: 720,
                    stopOnReply: true,
                    stopOnGoal: true,
                    templateRef: tplStep1Ref,
                    bindings: step1Bindings,
                  },
                  {
                    stepId: 'step_enq_nudge_2',
                    stepName: 'Second Follow-up Nudge',
                    offsetDays: 0,
                    localTime: '10:00',
                    prerequisite: 'NONE',
                    delay: { value: 72, unit: 'HOURS' },
                    outsideHoursPolicy: 'DEFER_NEXT_DAY',
                    maxDeferralHours: 24,
                    maxLatenessMinutes: 720,
                    stopOnReply: true,
                    stopOnGoal: true,
                    templateRef: tplStep2Ref,
                    bindings: step2Bindings,
                  },
                ],
                timezone: 'Asia/Kolkata',
                bindingsSchemaVersion: 2,
                isPublished: true,
                publishedAt: now,
                activatedBy: 'owner@shop-a.com',
                activatedAt: new Date(nowMs - 60 * 60 * 1000),
              },
              'unresolved-enquiry',
              false
            ),
          ],
          session
        );

        await upsertMany(
          'campaignControlGates',
          ['tenantId', 'campaignId'],
          [
            applySeedLabels(
              {
                campaignId: enquiryCampaignId,
                tenantId: 'shop_a',
                pauseGeneration: 0,
                version: 1,
              },
              'unresolved-enquiry',
              false
            ),
          ],
          session
        );
      }

      if (scenario === 'complete-outfit') {
        const now = clock.now();
        const nowMs = now.getTime();
        const outfitCampaignId = 'cmp_complete_outfit_shop_a';
        const outfitVersionId = 'ver_complete_outfit_shop_a_1';

        // 1. Seed Products for shop_a
        const outfitProducts = [
          {
            tenantId: 'shop_a',
            productId: 'prod_saree_red_silk',
            name: 'Red Silk Saree',
            category: 'saree',
            colourFamily: 'red',
            weave: 'silk',
            pricePaise: 850000,
            status: 'ACTIVE',
            entityVersion: 1,
            variants: [{ variantId: 'var_s1', label: 'Standard', sellableQty: 5, version: 1 }],
          },
          {
            tenantId: 'shop_a',
            productId: 'prod_saree_blue_cotton',
            name: 'Blue Cotton Saree',
            category: 'saree',
            colourFamily: 'blue',
            weave: 'cotton',
            pricePaise: 350000,
            status: 'ACTIVE',
            entityVersion: 1,
            variants: [{ variantId: 'var_s2', label: 'Standard', sellableQty: 5, version: 1 }],
          },
          {
            tenantId: 'shop_a',
            productId: 'prod_saree_green_silk',
            name: 'Green Silk Saree',
            category: 'saree',
            colourFamily: 'green',
            weave: 'silk',
            pricePaise: 750000,
            status: 'ACTIVE',
            entityVersion: 1,
            variants: [{ variantId: 'var_s3', label: 'Standard', sellableQty: 5, version: 1 }],
          },
          {
            tenantId: 'shop_a',
            productId: 'prod_saree_cream_handloom',
            name: 'Cream Handloom Saree',
            category: 'saree',
            colourFamily: 'cream',
            weave: 'handloom',
            pricePaise: 600000,
            status: 'ACTIVE',
            entityVersion: 1,
            variants: [{ variantId: 'var_s4', label: 'Standard', sellableQty: 5, version: 1 }],
          },
          {
            tenantId: 'shop_a',
            productId: 'prod_blouse_gold_silk',
            name: 'Gold Silk Blouse',
            category: 'blouse',
            colourFamily: 'gold',
            weave: 'silk',
            pricePaise: 250000,
            status: 'ACTIVE',
            entityVersion: 1,
            variants: [{ variantId: 'var_b1', label: 'Size 38', sellableQty: 10, version: 1 }],
          },
          {
            tenantId: 'shop_a',
            productId: 'prod_blouse_red_silk',
            name: 'Red Silk Brocade Blouse',
            category: 'blouse',
            colourFamily: 'red',
            weave: 'silk',
            pricePaise: 220000,
            status: 'ACTIVE',
            entityVersion: 1,
            variants: [{ variantId: 'var_b2', label: 'Size 38', sellableQty: 8, version: 1 }],
          },
          {
            tenantId: 'shop_a',
            productId: 'prod_blouse_green_cotton',
            name: 'Green Cotton Blouse',
            category: 'blouse',
            colourFamily: 'green',
            weave: 'cotton',
            pricePaise: 150000,
            status: 'ACTIVE',
            entityVersion: 1,
            variants: [{ variantId: 'var_b3', label: 'Size 38', sellableQty: 6, version: 1 }],
          },
          {
            tenantId: 'shop_a',
            productId: 'prod_blouse_black_silk_oos',
            name: 'Black Silk Blouse',
            category: 'blouse',
            colourFamily: 'black',
            weave: 'silk',
            pricePaise: 200000,
            status: 'ACTIVE',
            entityVersion: 1,
            variants: [{ variantId: 'var_b_oos', label: 'Size 38', sellableQty: 0, version: 1 }],
          },
          {
            tenantId: 'shop_a',
            productId: 'prod_blouse_discontinued',
            name: 'Discontinued Pink Blouse',
            category: 'blouse',
            colourFamily: 'pink',
            weave: 'silk',
            pricePaise: 180000,
            status: 'DISCONTINUED',
            entityVersion: 1,
            variants: [{ variantId: 'var_b_disc', label: 'Size 38', sellableQty: 5, version: 1 }],
          },
          {
            tenantId: 'shop_a',
            productId: 'prod_petticoat_cream',
            name: 'Cotton Satin Petticoat Cream',
            category: 'petticoat',
            colourFamily: 'cream',
            weave: 'cotton',
            pricePaise: 80000,
            status: 'ACTIVE',
            entityVersion: 1,
            variants: [{ variantId: 'var_p1', label: 'Free Size', sellableQty: 15, version: 1 }],
          },
          {
            tenantId: 'shop_a',
            productId: 'prod_dupatta_gold',
            name: 'Gold Banarasi Dupatta',
            category: 'dupatta',
            colourFamily: 'gold',
            weave: 'silk',
            pricePaise: 300000,
            status: 'ACTIVE',
            entityVersion: 1,
            variants: [{ variantId: 'var_d1', label: 'Standard', sellableQty: 7, version: 1 }],
          },
          {
            tenantId: 'shop_a',
            productId: 'prod_accessories_belt',
            name: 'Embroidered Saree Belt',
            category: 'accessories',
            colourFamily: 'gold',
            weave: 'other',
            pricePaise: 120000,
            status: 'ACTIVE',
            entityVersion: 1,
            variants: [{ variantId: 'var_a1', label: 'Standard', sellableQty: 12, version: 1 }],
          },
          {
            tenantId: 'shop_a',
            productId: 'prod_unknown_cat',
            name: 'Unknown Category Item',
            category: 'unknown_clothing',
            colourFamily: 'red',
            weave: 'silk',
            pricePaise: 500000,
            status: 'ACTIVE',
            entityVersion: 1,
            variants: [{ variantId: 'var_u1', label: 'Standard', sellableQty: 5, version: 1 }],
          },
          {
            tenantId: 'shop_a',
            productId: 'prod_no_colour_blouse',
            name: 'Raw Silk Designer Blouse',
            category: 'blouse',
            colourFamily: null,
            weave: 'silk',
            pricePaise: 280000,
            status: 'ACTIVE',
            entityVersion: 1,
            variants: [{ variantId: 'var_nc1', label: 'Size 38', sellableQty: 4, version: 1 }],
          },
        ];

        await upsertMany(
          'src_products',
          ['tenantId', 'productId'],
          applySeedLabels(outfitProducts, 'complete-outfit', true),
          session
        );

        // 2. Extra customers for outfit fixtures
        const outfitCustomers = [
          { customerId: 'cus_of_due_tomorrow', firstName: 'Priya (Due Tomorrow)', rawPhone: '+91 91000 00201', verified: true, marketingOptIn: true },
          { customerId: 'cus_of_elapsed', firstName: 'Anita (Elapsed)', rawPhone: '+91 91000 00202', verified: true, marketingOptIn: true },
          { customerId: 'cus_of_category_in_order', firstName: 'Sunita (Category In Order)', rawPhone: '+91 91000 00203', verified: true, marketingOptIn: true },
          { customerId: 'cus_of_saree_returned', firstName: 'Ritu (Saree Returned)', rawPhone: '+91 91000 00204', verified: true, marketingOptIn: true },
          { customerId: 'cus_of_two_sarees', firstName: 'Meera (Two Sarees)', rawPhone: '+91 91000 00205', verified: true, marketingOptIn: true },
          { customerId: 'cus_of_accessories_only', firstName: 'Kiran (Accessories Only)', rawPhone: '+91 91000 00206', verified: true, marketingOptIn: true },
          { customerId: 'cus_of_night_order', firstName: 'Rekha (Night Order)', rawPhone: '+91 91000 00207', verified: true, marketingOptIn: true },
          { customerId: 'cus_of_spacing', firstName: 'Shalini (Spacing)', rawPhone: '+91 91000 00208', verified: true, marketingOptIn: true },
          { customerId: 'cus_of_already_purchased_60d', firstName: 'Deepa (Bought 60d Ago)', rawPhone: '+91 91000 00209', verified: true, marketingOptIn: true },
          { customerId: 'cus_of_already_purchased_400d', firstName: 'Vandana (Bought 400d Ago)', rawPhone: '+91 91000 00210', verified: true, marketingOptIn: true },
          { customerId: 'cus_of_budget_low', firstName: 'Geeta (Low Budget)', rawPhone: '+91 91000 00211', verified: true, marketingOptIn: true, preferences: { budgetMaxPaise: 100000 } },
          { customerId: 'cus_of_opted_out', firstName: 'Kavita (Opted Out)', rawPhone: '+91 91000 00212', verified: true, marketingOptIn: false },
          { customerId: 'cus_of_unverified', firstName: 'Swati (Unverified)', rawPhone: '+91 91000 00213', verified: false, marketingOptIn: true },
          { customerId: 'cus_of_undeliverable', firstName: 'Rupa (Undeliverable)', rawPhone: '+91 91000 00214', verified: true, marketingOptIn: true },
          { customerId: 'cus_of_shared_1', firstName: 'Tara (Shared 1)', rawPhone: '+91 91000 00215', verified: true, marketingOptIn: true },
          { customerId: 'cus_of_shared_2', firstName: 'Maya (Shared 2)', rawPhone: '+91 91000 00215', verified: true, marketingOptIn: true },
          { customerId: 'cus_of_pending', firstName: 'Bhavna (Pending Order)', rawPhone: '+91 91000 00216', verified: true, marketingOptIn: true },
          { customerId: 'cus_of_cancelled', firstName: 'Alka (Cancelled Order)', rawPhone: '+91 91000 00217', verified: true, marketingOptIn: true },
        ];

        const custDocs: any[] = [];
        const gateDocs: any[] = [];
        for (const cust of outfitCustomers) {
          const encPhone = encryptPhone(cust.rawPhone);
          const destHash = destinationHash(cust.rawPhone);
          const masked = maskPhone(cust.rawPhone);
          custDocs.push({
            tenantId: 'shop_a',
            customerId: cust.customerId,
            firstName: cust.firstName,
            destination: {
              encryptedPhone: encPhone,
              destinationHash: destHash,
              masked,
              verified: cust.verified,
              version: 1,
              verificationLevel: cust.verified ? 'CONFIRMED_BY_STAFF' : 'UNVERIFIED',
              verifiedAt: cust.verified ? now : null,
              verificationMethod: cust.verified ? 'MOCK' : null,
            },
            birthday: null,
            consent: {
              marketingOptIn: cust.marketingOptIn,
              channelSuppressed: false,
              consentCapturedAt: cust.marketingOptIn ? now : null,
              consentSource: cust.marketingOptIn ? 'MOCK' : null,
            },
            preferences: (cust as any).preferences || {},
            tags: ['complete_outfit_fixture'],
            status: 'ACTIVE',
            branchId: 'branch_main',
            language: 'en',
            isLive: false,
          });

          if (cust.customerId === 'cus_of_undeliverable') {
            gateDocs.push({
              tenantId: 'shop_a',
              destinationHash: destHash,
              version: 1,
              health: {
                status: 'UNDELIVERABLE',
                reason: 'UNDELIVERABLE_PERMANENT',
                failureCount: 1,
                lastFailureAt: now,
                source: 'PROVIDER_STATUS',
              },
              ledger: [],
            });
          }
        }

        await upsertMany(
          'src_customers',
          ['tenantId', 'customerId'],
          applySeedLabels(custDocs, 'complete-outfit', true),
          session
        );

        if (gateDocs.length > 0) {
          await upsertMany(
            'campaignContactGates',
            ['tenantId', 'destinationHash'],
            applySeedLabels(gateDocs, 'complete-outfit'),
            session
          );
        }

        // 3. Seed orders for complete_the_outfit fixtures
        const outfitOrders = [
          {
            tenantId: 'shop_a',
            orderId: 'ord_of_due_tomorrow',
            customerId: 'cus_of_due_tomorrow',
            status: 'COMPLETED',
            paid: true,
            netPaise: 850000,
            grossPaise: 850000,
            refundedPaise: 0,
            completedAt: new Date(nowMs - 4 * 86400000), // 4 days ago -> due tomorrow
            branchId: 'branch_main',
            entityVersion: 1,
            lines: [
              {
                lineId: 'line_dt_1',
                productId: 'prod_saree_red_silk',
                name: 'Red Silk Saree',
                qty: 1,
                returnedQty: 0,
                lineNetPaise: 850000,
              },
            ],
          },
          {
            tenantId: 'shop_a',
            orderId: 'ord_of_elapsed',
            customerId: 'cus_of_elapsed',
            status: 'COMPLETED',
            paid: true,
            netPaise: 850000,
            grossPaise: 850000,
            refundedPaise: 0,
            completedAt: new Date(nowMs - 6 * 86400000), // 6 days ago -> elapsed
            branchId: 'branch_main',
            entityVersion: 1,
            lines: [
              {
                lineId: 'line_el_1',
                productId: 'prod_saree_red_silk',
                name: 'Red Silk Saree',
                qty: 1,
                returnedQty: 0,
                lineNetPaise: 850000,
              },
            ],
          },
          {
            tenantId: 'shop_a',
            orderId: 'ord_of_category_in_order',
            customerId: 'cus_of_category_in_order',
            status: 'COMPLETED',
            paid: true,
            netPaise: 1100000,
            grossPaise: 1100000,
            refundedPaise: 0,
            completedAt: new Date(nowMs - 3 * 86400000),
            branchId: 'branch_main',
            entityVersion: 1,
            lines: [
              {
                lineId: 'line_cio_1',
                productId: 'prod_saree_red_silk',
                name: 'Red Silk Saree',
                qty: 1,
                returnedQty: 0,
                lineNetPaise: 850000,
              },
              {
                lineId: 'line_cio_2',
                productId: 'prod_blouse_gold_silk',
                name: 'Gold Silk Blouse',
                qty: 1,
                returnedQty: 0,
                lineNetPaise: 250000,
              },
            ],
          },
          {
            tenantId: 'shop_a',
            orderId: 'ord_of_saree_returned',
            customerId: 'cus_of_saree_returned',
            status: 'COMPLETED',
            paid: true,
            netPaise: 0,
            grossPaise: 850000,
            refundedPaise: 850000,
            completedAt: new Date(nowMs - 2 * 86400000),
            branchId: 'branch_main',
            entityVersion: 1,
            lines: [
              {
                lineId: 'line_sr_1',
                productId: 'prod_saree_red_silk',
                name: 'Red Silk Saree',
                qty: 1,
                returnedQty: 1,
                lineNetPaise: 0,
              },
            ],
          },
          {
            tenantId: 'shop_a',
            orderId: 'ord_of_two_sarees',
            customerId: 'cus_of_two_sarees',
            status: 'COMPLETED',
            paid: true,
            netPaise: 750000,
            grossPaise: 1600000,
            refundedPaise: 850000,
            completedAt: new Date(nowMs - 2 * 86400000),
            branchId: 'branch_main',
            entityVersion: 1,
            lines: [
              {
                lineId: 'line_ts_1',
                productId: 'prod_saree_red_silk',
                name: 'Red Silk Saree',
                qty: 1,
                returnedQty: 1,
                lineNetPaise: 0,
              },
              {
                lineId: 'line_ts_2',
                productId: 'prod_saree_green_silk',
                name: 'Green Silk Saree',
                qty: 1,
                returnedQty: 0,
                lineNetPaise: 750000,
              },
            ],
          },
          {
            tenantId: 'shop_a',
            orderId: 'ord_of_accessories_only',
            customerId: 'cus_of_accessories_only',
            status: 'COMPLETED',
            paid: true,
            netPaise: 120000,
            grossPaise: 120000,
            refundedPaise: 0,
            completedAt: new Date(nowMs - 2 * 86400000),
            branchId: 'branch_main',
            entityVersion: 1,
            lines: [
              {
                lineId: 'line_ao_1',
                productId: 'prod_accessories_belt',
                name: 'Embroidered Saree Belt',
                qty: 1,
                returnedQty: 0,
                lineNetPaise: 120000,
              },
            ],
          },
          {
            tenantId: 'shop_a',
            orderId: 'ord_of_anonymous',
            customerId: null,
            status: 'COMPLETED',
            paid: true,
            netPaise: 850000,
            grossPaise: 850000,
            refundedPaise: 0,
            completedAt: new Date(nowMs - 2 * 86400000),
            branchId: 'branch_main',
            entityVersion: 1,
            lines: [
              {
                lineId: 'line_anon_1',
                productId: 'prod_saree_red_silk',
                name: 'Red Silk Saree',
                qty: 1,
                returnedQty: 0,
                lineNetPaise: 850000,
              },
            ],
          },
          {
            tenantId: 'shop_a',
            orderId: 'ord_of_night_order',
            customerId: 'cus_of_night_order',
            status: 'COMPLETED',
            paid: true,
            netPaise: 850000,
            grossPaise: 850000,
            refundedPaise: 0,
            // 20:30 IST 5 days ago
            completedAt: DateTime.fromJSDate(new Date(nowMs - 5 * 86400000), { zone: 'Asia/Kolkata' }).set({ hour: 20, minute: 30, second: 0, millisecond: 0 }).toJSDate(),
            branchId: 'branch_main',
            entityVersion: 1,
            lines: [
              {
                lineId: 'line_no_1',
                productId: 'prod_saree_red_silk',
                name: 'Red Silk Saree',
                qty: 1,
                returnedQty: 0,
                lineNetPaise: 850000,
              },
            ],
          },
          {
            tenantId: 'shop_a',
            orderId: 'ord_of_spacing_1',
            customerId: 'cus_of_spacing',
            status: 'COMPLETED',
            paid: true,
            netPaise: 850000,
            grossPaise: 850000,
            refundedPaise: 0,
            completedAt: new Date(nowMs - 20 * 86400000),
            branchId: 'branch_main',
            entityVersion: 1,
            lines: [
              {
                lineId: 'line_sp_1',
                productId: 'prod_saree_red_silk',
                name: 'Red Silk Saree',
                qty: 1,
                returnedQty: 0,
                lineNetPaise: 850000,
              },
            ],
          },
          {
            tenantId: 'shop_a',
            orderId: 'ord_of_spacing_2',
            customerId: 'cus_of_spacing',
            status: 'COMPLETED',
            paid: true,
            netPaise: 750000,
            grossPaise: 750000,
            refundedPaise: 0,
            completedAt: new Date(nowMs - 10 * 86400000),
            branchId: 'branch_main',
            entityVersion: 1,
            lines: [
              {
                lineId: 'line_sp_2',
                productId: 'prod_saree_green_silk',
                name: 'Green Silk Saree',
                qty: 1,
                returnedQty: 0,
                lineNetPaise: 750000,
              },
            ],
          },
          {
            tenantId: 'shop_a',
            orderId: 'ord_of_prev_blouse',
            customerId: 'cus_of_already_purchased_60d',
            status: 'COMPLETED',
            paid: true,
            netPaise: 250000,
            grossPaise: 250000,
            refundedPaise: 0,
            completedAt: new Date(nowMs - 60 * 86400000),
            branchId: 'branch_main',
            entityVersion: 1,
            lines: [
              {
                lineId: 'line_pb_1',
                productId: 'prod_blouse_gold_silk',
                name: 'Gold Silk Blouse',
                qty: 1,
                returnedQty: 0,
                lineNetPaise: 250000,
              },
            ],
          },
          {
            tenantId: 'shop_a',
            orderId: 'ord_of_saree_60d',
            customerId: 'cus_of_already_purchased_60d',
            status: 'COMPLETED',
            paid: true,
            netPaise: 850000,
            grossPaise: 850000,
            refundedPaise: 0,
            completedAt: new Date(nowMs - 2 * 86400000),
            branchId: 'branch_main',
            entityVersion: 1,
            lines: [
              {
                lineId: 'line_s60_1',
                productId: 'prod_saree_red_silk',
                name: 'Red Silk Saree',
                qty: 1,
                returnedQty: 0,
                lineNetPaise: 850000,
              },
            ],
          },
          {
            tenantId: 'shop_a',
            orderId: 'ord_of_prev_blouse_old',
            customerId: 'cus_of_already_purchased_400d',
            status: 'COMPLETED',
            paid: true,
            netPaise: 250000,
            grossPaise: 250000,
            refundedPaise: 0,
            completedAt: new Date(nowMs - 400 * 86400000),
            branchId: 'branch_main',
            entityVersion: 1,
            lines: [
              {
                lineId: 'line_pbo_1',
                productId: 'prod_blouse_gold_silk',
                name: 'Gold Silk Blouse',
                qty: 1,
                returnedQty: 0,
                lineNetPaise: 250000,
              },
            ],
          },
          {
            tenantId: 'shop_a',
            orderId: 'ord_of_saree_400d',
            customerId: 'cus_of_already_purchased_400d',
            status: 'COMPLETED',
            paid: true,
            netPaise: 850000,
            grossPaise: 850000,
            refundedPaise: 0,
            completedAt: new Date(nowMs - 2 * 86400000),
            branchId: 'branch_main',
            entityVersion: 1,
            lines: [
              {
                lineId: 'line_s400_1',
                productId: 'prod_saree_red_silk',
                name: 'Red Silk Saree',
                qty: 1,
                returnedQty: 0,
                lineNetPaise: 850000,
              },
            ],
          },
          {
            tenantId: 'shop_a',
            orderId: 'ord_of_budget',
            customerId: 'cus_of_budget_low',
            status: 'COMPLETED',
            paid: true,
            netPaise: 850000,
            grossPaise: 850000,
            refundedPaise: 0,
            completedAt: new Date(nowMs - 2 * 86400000),
            branchId: 'branch_main',
            entityVersion: 1,
            lines: [
              {
                lineId: 'line_bg_1',
                productId: 'prod_saree_red_silk',
                name: 'Red Silk Saree',
                qty: 1,
                returnedQty: 0,
                lineNetPaise: 850000,
              },
            ],
          },
          {
            tenantId: 'shop_a',
            orderId: 'ord_of_pending',
            customerId: 'cus_of_pending',
            status: 'PENDING',
            paid: false,
            netPaise: 850000,
            grossPaise: 850000,
            refundedPaise: 0,
            completedAt: null,
            branchId: 'branch_main',
            entityVersion: 1,
            lines: [
              {
                lineId: 'line_pen_1',
                productId: 'prod_saree_red_silk',
                name: 'Red Silk Saree',
                qty: 1,
                returnedQty: 0,
                lineNetPaise: 850000,
              },
            ],
          },
          {
            tenantId: 'shop_a',
            orderId: 'ord_of_cancelled',
            customerId: 'cus_of_cancelled',
            status: 'CANCELLED',
            paid: true,
            netPaise: 0,
            grossPaise: 850000,
            refundedPaise: 850000,
            completedAt: new Date(nowMs - 2 * 86400000),
            branchId: 'branch_main',
            entityVersion: 1,
            lines: [
              {
                lineId: 'line_can_1',
                productId: 'prod_saree_red_silk',
                name: 'Red Silk Saree',
                qty: 1,
                returnedQty: 0,
                lineNetPaise: 850000,
              },
            ],
          },
          {
            tenantId: 'shop_a',
            orderId: 'ord_of_opted_out',
            customerId: 'cus_of_opted_out',
            status: 'COMPLETED',
            paid: true,
            netPaise: 850000,
            grossPaise: 850000,
            refundedPaise: 0,
            completedAt: new Date(nowMs - 2 * 86400000),
            branchId: 'branch_main',
            entityVersion: 1,
            lines: [
              {
                lineId: 'line_oo_1',
                productId: 'prod_saree_red_silk',
                name: 'Red Silk Saree',
                qty: 1,
                returnedQty: 0,
                lineNetPaise: 850000,
              },
            ],
          },
          {
            tenantId: 'shop_a',
            orderId: 'ord_of_unverified',
            customerId: 'cus_of_unverified',
            status: 'COMPLETED',
            paid: true,
            netPaise: 850000,
            grossPaise: 850000,
            refundedPaise: 0,
            completedAt: new Date(nowMs - 2 * 86400000),
            branchId: 'branch_main',
            entityVersion: 1,
            lines: [
              {
                lineId: 'line_uv_1',
                productId: 'prod_saree_red_silk',
                name: 'Red Silk Saree',
                qty: 1,
                returnedQty: 0,
                lineNetPaise: 850000,
              },
            ],
          },
          {
            tenantId: 'shop_a',
            orderId: 'ord_of_undeliverable',
            customerId: 'cus_of_undeliverable',
            status: 'COMPLETED',
            paid: true,
            netPaise: 850000,
            grossPaise: 850000,
            refundedPaise: 0,
            completedAt: new Date(nowMs - 2 * 86400000),
            branchId: 'branch_main',
            entityVersion: 1,
            lines: [
              {
                lineId: 'line_ud_1',
                productId: 'prod_saree_red_silk',
                name: 'Red Silk Saree',
                qty: 1,
                returnedQty: 0,
                lineNetPaise: 850000,
              },
            ],
          },
        ];

        // Seed Live customer order if live customer exists
        const liveCust = shopACustomers.find((c) => c.isLive);
        if (liveCust) {
          const tz = 'Asia/Kolkata';
          const currentDt = DateTime.fromJSDate(now, { zone: tz });
          let nextTarget = currentDt.set({ hour: 10, minute: 5, second: 0, millisecond: 0 });
          if (currentDt >= nextTarget) {
            nextTarget = nextTarget.plus({ days: 1 });
          }
          const liveCompletedAt = nextTarget.minus({ days: 5 }).toJSDate();

          outfitOrders.push({
            tenantId: 'shop_a',
            orderId: 'ord_of_live_customer_01',
            customerId: liveCust.customerId,
            status: 'COMPLETED',
            paid: true,
            netPaise: 850000,
            grossPaise: 850000,
            refundedPaise: 0,
            completedAt: liveCompletedAt,
            branchId: 'branch_main',
            entityVersion: 1,
            lines: [
              {
                lineId: 'line_live_of_1',
                productId: 'prod_saree_red_silk',
                name: 'Red Silk Saree',
                qty: 1,
                returnedQty: 0,
                lineNetPaise: 850000,
              },
            ],
          });
        }

        await upsertMany(
          'src_orders',
          ['tenantId', 'orderId'],
          applySeedLabels(outfitOrders, 'complete-outfit', true),
          session
        );

        // 4. Seed Complete the Outfit Campaign & Version Model
        await upsertMany(
          'campaigns',
          ['tenantId', 'campaignId'],
          [
            applySeedLabels(
              {
                campaignId: outfitCampaignId,
                tenantId: 'shop_a',
                name: 'Complete the Outfit',
                presetId: 'complete_the_outfit',
                status: 'ACTIVE',
                activeVersionId: outfitVersionId,
                draftVersion: 1,
                pauseGeneration: 0,
                enabledBranches: ['branch_main', 'branch_two'],
                activatedAt: new Date(nowMs - 60 * 60 * 1000),
              },
              'complete-outfit',
              false
            ),
          ],
          session
        );

        await upsertMany(
          'campaignVersions',
          ['tenantId', 'campaignId', 'version'],
          [
            applySeedLabels(
              {
                campaignId: outfitCampaignId,
                tenantId: 'shop_a',
                version: 1,
                name: 'Complete the Outfit',
                industry: 'BOUTIQUE',
                purpose: 'MARKETING',
                priority: 35,
                category: 'MARKETING',
                presetId: 'complete_the_outfit',
                trigger: {
                  type: 'ORDER_EVENT_DELAY',
                  anchor: 'ORDER_COMPLETED_AT',
                },
                pairing: {
                  anchorCategories: ['saree'],
                  complementMap: {
                    saree: ['blouse', 'petticoat', 'dupatta', 'accessories'],
                    lehenga: ['dupatta', 'accessories'],
                    kurta: ['dupatta', 'accessories'],
                  },
                  colourMatch: 'NEUTRAL_OR_SAME',
                  requireSameWeave: false,
                  budgetAware: false,
                  alreadyOwnedLookbackDays: 180,
                  suppressIfCategoryInOrder: true,
                },
                minDaysBetweenEnrollments: 30,
                goalMode: 'COMPLEMENT_OR_TAGGED',
                audience: {
                  mode: 'ALL_ELIGIBLE',
                  rules: null,
                },
                goal: {
                  type: 'OCCASION_TAGGED_OR_STAFF_COMPLETED',
                },
                enabledBranches: ['branch_main', 'branch_two'],
                steps: [
                  {
                    stepId: 'step_outfit_1',
                    stepName: 'Complete Your Saree Look',
                    offsetDays: 0,
                    localTime: '10:00',
                    prerequisite: 'NONE',
                    delay: { value: 5, unit: 'DAYS' },
                    outsideHoursPolicy: 'DEFER_NEXT_DAY',
                    maxDeferralHours: 24,
                    maxLatenessMinutes: 1440,
                    stopOnReply: true,
                    stopOnGoal: true,
                    templateRef: { id: 'tpl_outfit_complete_one', name: 'tpl_outfit_complete_one', language: 'en', revision: 1 },
                    bindings: {
                      '1': { source: 'customer.firstName' },
                      '2': { source: 'anchor.itemName' },
                      '3': { source: 'complement.1.name' },
                      '4': { source: 'shop.displayName' },
                    },
                  },
                ],
                timezone: 'Asia/Kolkata',
                bindingsSchemaVersion: 2,
                isPublished: true,
                publishedAt: now,
                activatedBy: 'owner@shop-a.com',
                activatedAt: new Date(nowMs - 60 * 60 * 1000),
              },
              'complete-outfit',
              false
            ),
          ],
          session
        );

        await upsertMany(
          'campaignControlGates',
          ['tenantId', 'campaignId'],
          [
            applySeedLabels(
              {
                campaignId: outfitCampaignId,
                tenantId: 'shop_a',
                pauseGeneration: 0,
                version: 1,
              },
              'complete-outfit',
              false
            ),
          ],
          session
        );
      }

      if (scenario === 'selected-stock-promotion') {
        const now = clock.now();
        const seedGroup = 'selected-stock-promotion';
        const validUntil = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);
        const selectedCustomers: CustomerSeedRecord[] = Array.from({ length: 40 }, (_, index) => {
          const n = String(index + 1).padStart(2, '0');
          const live = Boolean(options.live && index === 0);
          return {
            customerId: `cus_sp_${n}`,
            firstName: `Stock Customer ${n}`,
            rawPhone: live ? (config.LIVE_CUSTOMER_PHONES?.split(',')[0] || '') : `91990000${n}01`,
            birthday: null,
            marketingOptIn: index !== 8,
            channelSuppressed: index === 9,
            preferences: index === 7 ? {} : { weave: index % 5 === 1 ? 'cotton' : 'silk', budgetMaxPaise: index % 6 === 3 ? 1400000 : 2000000, size: index % 7 === 0 ? 'M' : undefined, colour: index % 4 === 0 ? 'red' : undefined },
            tags: index === 2 ? ['branch_two'] : [],
            status: index === 10 ? 'DELETED' : 'ACTIVE',
            branchId: index % 6 === 2 ? 'branch_two' : 'branch_main',
            deletedAt: index === 10 ? now : null,
            language: 'en',
            isLive: Boolean(live),
          };
        });
        await insertCustomerBatch('shop_a', selectedCustomers, seedGroup, session);
        const stockProducts = [
          { tenantId: 'shop_a', productId: 'prd_sp_red_silk_saree', name: 'Red Silk Saree', category: 'saree', colourFamily: 'red', weave: 'silk', pricePaise: 2000000, status: 'ACTIVE', entityVersion: 1, variants: [{ variantId: 'v1', label: 'Standard', sellableQty: 4, version: 1 }] },
          { tenantId: 'shop_a', productId: 'prd_sp_blue_silk_saree', name: 'Blue Silk Saree', category: 'saree', colourFamily: 'blue', weave: 'silk', pricePaise: 1800000, status: 'ACTIVE', entityVersion: 1, variants: [{ variantId: 'v1', label: 'Standard', sellableQty: 2, version: 1 }] },
          { tenantId: 'shop_a', productId: 'prd_sp_green_silk_saree', name: 'Green Silk Saree', category: 'saree', colourFamily: 'green', weave: 'silk', pricePaise: 2500000, status: 'ACTIVE', entityVersion: 1, variants: [{ variantId: 'v1', label: 'Standard', sellableQty: 1, version: 1 }] },
          { tenantId: 'shop_a', productId: 'prd_sp_cream_cotton_saree', name: 'Cream Cotton Saree', category: 'saree', colourFamily: 'cream', weave: 'cotton', pricePaise: 850000, status: 'ACTIVE', entityVersion: 1, variants: [{ variantId: 'v1', label: 'Standard', sellableQty: 8, version: 1 }] },
          { tenantId: 'shop_a', productId: 'prd_sp_handloom_saree', name: 'Handloom Saree', category: 'saree', colourFamily: 'blue', weave: 'handloom', pricePaise: 1200000, status: 'ACTIVE', entityVersion: 1, variants: [{ variantId: 'v1', label: 'Standard', sellableQty: 3, version: 1 }] },
          { tenantId: 'shop_a', productId: 'prd_sp_lehenga', name: 'Festive Lehenga', category: 'lehenga', colourFamily: 'red', weave: 'silk', pricePaise: 2200000, status: 'ACTIVE', entityVersion: 1, variants: [{ variantId: 'v1', label: 'Standard', sellableQty: 2, version: 1 }] },
          { tenantId: 'shop_a', productId: 'prd_sp_kurta', name: 'Cotton Kurta', category: 'kurta', colourFamily: 'blue', weave: 'cotton', pricePaise: 450000, status: 'ACTIVE', entityVersion: 1, variants: [{ variantId: 's', label: 'S', sellableQty: 4, version: 1 }, { variantId: 'm', label: 'M', sellableQty: 3, version: 1 }] },
          { tenantId: 'shop_a', productId: 'prd_sp_dupatta', name: 'Silk Dupatta', category: 'dupatta', colourFamily: 'green', weave: 'silk', pricePaise: 600000, status: 'ACTIVE', entityVersion: 1, variants: [{ variantId: 'v1', label: 'Standard', sellableQty: 5, version: 1 }] },
          { tenantId: 'shop_a', productId: 'prd_sp_blouse', name: 'Gold Blouse', category: 'blouse', colourFamily: 'gold', weave: 'cotton', pricePaise: 450000, status: 'ACTIVE', entityVersion: 1, variants: [{ variantId: 'v1', label: 'M', sellableQty: 0, version: 1 }] },
          { tenantId: 'shop_a', productId: 'prd_sp_discontinued', name: 'Discontinued Saree', category: 'saree', colourFamily: 'black', weave: 'silk', pricePaise: 1500000, status: 'DISCONTINUED', entityVersion: 1, variants: [{ variantId: 'v1', label: 'Standard', sellableQty: 0, version: 1 }] },
          { tenantId: 'shop_a', productId: 'prd_sp_unknown_weave', name: 'Artisan Special', category: 'saree', colourFamily: 'cream', weave: 'unknown', pricePaise: 950000, status: 'ACTIVE', entityVersion: 1, variants: [{ variantId: 'v1', label: 'Standard', sellableQty: 1, version: 1 }] },
          { tenantId: 'shop_a', productId: 'prd_sp_low_stock', name: 'Low Stock Silk', category: 'saree', colourFamily: 'red', weave: 'silk', pricePaise: 1100000, status: 'ACTIVE', entityVersion: 1, variants: [{ variantId: 'v1', label: 'Standard', sellableQty: 1, version: 1 }] },
        ].map((doc) => applySeedLabels(doc, seedGroup, true));
        await upsertMany('src_products', ['tenantId', 'productId'], stockProducts, session);

        const stockOffers = [
          {
            tenantId: 'shop_a', offerId: 'off_sp_percent', kind: 'SELECTED_STOCK', name: 'Silk Saree Festive Offer',
            status: 'DRAFT', publishedAt: null, validFrom: now, validUntil,
            discount: { type: 'PERCENT_OFF', percent: 20 }, terms: 'Selected items only',
            tags: ['festive'], branchIds: [],
            items: stockProducts.slice(0, 5).map((product, position) => ({ productId: product.productId, variantIds: ['v1'], offerPricePaise: null, position })),
            version: 1,
          },
          {
            tenantId: 'shop_a', offerId: 'off_sp_flat', kind: 'SELECTED_STOCK', name: 'Handloom Flat Offer',
            status: 'DRAFT', publishedAt: null, validFrom: now, validUntil,
            discount: { type: 'FLAT_OFF', flatOffPaise: 50000 }, terms: 'Selected items only',
            tags: [], branchIds: [], items: [{ productId: stockProducts[0].productId, variantIds: ['v1'], offerPricePaise: null, position: 0 }], version: 1,
          },
          {
            tenantId: 'shop_a', offerId: 'off_sp_special', kind: 'SELECTED_STOCK', name: 'Special Price Edit',
            status: 'DRAFT', publishedAt: null, validFrom: now, validUntil,
            discount: { type: 'SPECIAL_PRICE' }, terms: 'Special price on selected item',
            tags: [], branchIds: [], items: [{ productId: stockProducts[1].productId, variantIds: ['v1'], offerPricePaise: 1500000, position: 0 }], version: 1,
          },
          {
            tenantId: 'shop_a', offerId: 'off_sp_out', kind: 'SELECTED_STOCK', name: 'Currently Unavailable', status: 'DRAFT', publishedAt: null, validFrom: now, validUntil,
            discount: { type: 'PERCENT_OFF', percent: 15 }, terms: 'While stock lasts', tags: [], branchIds: [],
            items: [{ productId: 'prd_sp_blouse', variantIds: ['v1'], offerPricePaise: null, position: 0 }],
          },
          {
            tenantId: 'shop_a', offerId: 'off_sp_tags', kind: 'SELECTED_STOCK', name: 'Festive Tag Offer', status: 'DRAFT', publishedAt: null, validFrom: now, validUntil,
            discount: { type: 'PERCENT_OFF', percent: 10 }, terms: 'Festive edit', tags: ['festive'], branchIds: [],
            items: [{ productId: 'prd_sp_lehenga', variantIds: ['v1'], offerPricePaise: null, position: 0 }],
          },
          {
            tenantId: 'shop_a', offerId: 'off_sp_branch_two', kind: 'SELECTED_STOCK', name: 'Heritage Lane Offer', status: 'DRAFT', publishedAt: null, validFrom: now, validUntil,
            discount: { type: 'FLAT_OFF', flatOffPaise: 50000 }, terms: 'Branch two only', tags: [], branchIds: ['branch_two'],
            items: [{ productId: 'prd_sp_handloom_saree', variantIds: ['v1'], offerPricePaise: null, position: 0 }],
          },
          {
            tenantId: 'shop_a', offerId: 'off_sp_short', kind: 'SELECTED_STOCK', name: 'Short Window Offer', status: 'DRAFT', publishedAt: null, validFrom: now, validUntil: new Date(now.getTime() + 26 * 60 * 60 * 1000),
            discount: { type: 'PERCENT_OFF', percent: 10 }, terms: 'Short window', tags: [], branchIds: [],
            items: [{ productId: 'prd_sp_kurta', variantIds: ['s'], offerPricePaise: null, position: 0 }],
          },
          {
            tenantId: 'shop_a', offerId: 'off_sp_withdrawn', kind: 'SELECTED_STOCK', name: 'Withdrawn Offer', status: 'WITHDRAWN', publishedAt: new Date(now.getTime() - 3 * 86400000), validFrom: new Date(now.getTime() - 4 * 86400000), validUntil,
            discount: { type: 'PERCENT_OFF', percent: 20 }, terms: 'Withdrawn', tags: [], branchIds: [],
            items: [{ productId: 'prd_sp_dupatta', variantIds: ['v1'], offerPricePaise: null, position: 0 }],
          },
          {
            tenantId: 'shop_a', offerId: 'off_sp_ended', kind: 'SELECTED_STOCK', name: 'Ended Offer', status: 'EXPIRED', publishedAt: new Date(now.getTime() - 5 * 86400000), validFrom: new Date(now.getTime() - 6 * 86400000), validUntil: new Date(now.getTime() - 86400000),
            discount: { type: 'PERCENT_OFF', percent: 20 }, terms: 'Ended', tags: [], branchIds: [],
            items: [{ productId: 'prd_sp_low_stock', variantIds: ['v1'], offerPricePaise: null, position: 0 }],
          },
        ].map((doc) => applySeedLabels(doc, seedGroup, true));
        await upsertMany('src_offers', ['tenantId', 'offerId'], stockOffers, session);
        await upsertMany('campaigns', ['tenantId', 'campaignId'], [applySeedLabels({
          campaignId: 'cmp_selected_stock_promotion',
          tenantId: 'shop_a',
          name: 'Selected-stock Promotion',
          presetId: 'selected_stock_promotion',
          status: 'ACTIVE',
          activeVersionId: 'ver_selected_stock_promotion_1',
          draftVersion: 1,
          pauseGeneration: 0,
          enabledBranches: ['branch_main', 'branch_two'],
          startAt: null,
          activatedAt: now,
          endAt: null,
        }, seedGroup, false)], session);
        await upsertMany('campaignVersions', ['tenantId', 'campaignId', 'version'], [applySeedLabels({
          campaignId: 'cmp_selected_stock_promotion', tenantId: 'shop_a', version: 1, name: 'Selected-stock Promotion',
          presetId: 'selected_stock_promotion', purpose: 'MARKETING', category: 'MARKETING', priority: 45,
          trigger: { type: 'OFFER_PUBLICATION', anchor: 'OFFER_ACTIVE_FROM' },
          audience: { mode: 'PREFERENCE_MATCH', rules: null }, audienceMode: 'PREFERENCE_MATCH', matchMode: 'STRICT',
          maxItemsInMessage: 3, maxRecipientsPerOffer: 1000, goalMode: 'OFFER_ITEM_OR_TAGGED',
          steps: [{ stepId: 'step_stock_1', stepName: 'Selected-stock offer', delay: { value: 1, unit: 'HOURS' }, prerequisite: 'NONE',
            outsideHoursPolicy: 'DEFER_NEXT_DAY', maxDeferralHours: 24, maxLatenessMinutes: 720, stopOnReply: true, stopOnGoal: true,
            templateRef: { id: 'tpl_stock_offer_items', name: 'tpl_stock_offer_items', language: 'en', revision: 1 }, bindings: {} }],
          enabledBranches: ['branch_main', 'branch_two'], timezone: 'Asia/Kolkata', bindingsSchemaVersion: 2, isPublished: true, publishedAt: now,
        }, seedGroup, false)], session);
      }

      if (scenario === 'festival-collection') {
        const now = clock.now();
        const seedGroup = 'festival-collection';
        const festivalDate = new Date('2026-11-01T00:00:00.000Z');
        const validUntil = new Date('2026-11-02T23:59:59.000Z');

        const festivalCustomers: CustomerSeedRecord[] = Array.from({ length: 30 }, (_, index) => {
          const n = String(index + 1).padStart(2, '0');
          const live = Boolean(options.live && index === 0);
          return {
            customerId: `cus_fc_${n}`,
            firstName: `Festival Customer ${n}`,
            rawPhone: live ? (config.LIVE_CUSTOMER_PHONES?.split(',')[0] || '') : `91991100${n}01`,
            birthday: null,
            marketingOptIn: index !== 8,
            channelSuppressed: index === 9,
            preferences: index === 7 ? {} : {
              weave: index % 3 === 0 ? 'silk' : (index % 3 === 1 ? 'cotton' : 'zari'),
              budgetMaxPaise: index % 5 === 0 ? 1500000 : 3000000,
              size: index % 4 === 0 ? 'M' : 'L',
              colour: index % 2 === 0 ? 'red' : 'gold',
            },
            tags: index === 2 ? ['branch_two'] : ['festive'],
            status: index === 10 ? 'DELETED' : 'ACTIVE',
            branchId: index % 5 === 2 ? 'branch_two' : 'branch_main',
            deletedAt: index === 10 ? now : null,
            language: 'en',
            isLive: Boolean(live),
          };
        });
        await insertCustomerBatch('shop_a', festivalCustomers, seedGroup, session);

        const festivalProducts = [
          { tenantId: 'shop_a', productId: 'prd_fc_red_kanjivaram', name: 'Red Kanjivaram Silk Saree', category: 'saree', colourFamily: 'red', weave: 'silk', pricePaise: 2500000, status: 'ACTIVE', entityVersion: 1, variants: [{ variantId: 'v1', label: 'Standard', sellableQty: 5, version: 1 }] },
          { tenantId: 'shop_a', productId: 'prd_fc_gold_zari_saree', name: 'Gold Zari Festive Saree', category: 'saree', colourFamily: 'gold', weave: 'zari', pricePaise: 2800000, status: 'ACTIVE', entityVersion: 1, variants: [{ variantId: 'v1', label: 'Standard', sellableQty: 3, version: 1 }] },
          { tenantId: 'shop_a', productId: 'prd_fc_green_banarasi', name: 'Emerald Green Banarasi Saree', category: 'saree', colourFamily: 'green', weave: 'silk', pricePaise: 2200000, status: 'ACTIVE', entityVersion: 1, variants: [{ variantId: 'v1', label: 'Standard', sellableQty: 4, version: 1 }] },
          { tenantId: 'shop_a', productId: 'prd_fc_cream_chanderi', name: 'Cream Chanderi Cotton Saree', category: 'saree', colourFamily: 'cream', weave: 'cotton', pricePaise: 1100000, status: 'ACTIVE', entityVersion: 1, variants: [{ variantId: 'v1', label: 'Standard', sellableQty: 6, version: 1 }] },
          { tenantId: 'shop_a', productId: 'prd_fc_festive_lehenga', name: 'Festive Brocade Lehenga', category: 'lehenga', colourFamily: 'red', weave: 'silk', pricePaise: 3500000, status: 'ACTIVE', entityVersion: 1, variants: [{ variantId: 'v1', label: 'Standard', sellableQty: 2, version: 1 }] },
          { tenantId: 'shop_a', productId: 'prd_fc_silk_kurta', name: 'Raw Silk Festive Kurta', category: 'kurta', colourFamily: 'gold', weave: 'silk', pricePaise: 750000, status: 'ACTIVE', entityVersion: 1, variants: [{ variantId: 'm', label: 'M', sellableQty: 4, version: 1 }, { variantId: 'l', label: 'L', sellableQty: 3, version: 1 }] },
          { tenantId: 'shop_a', productId: 'prd_fc_zari_dupatta', name: 'Heavy Zari Dupatta', category: 'dupatta', colourFamily: 'gold', weave: 'zari', pricePaise: 800000, status: 'ACTIVE', entityVersion: 1, variants: [{ variantId: 'v1', label: 'Standard', sellableQty: 5, version: 1 }] },
          { tenantId: 'shop_a', productId: 'prd_fc_silk_blouse', name: 'Festive Embroidered Blouse', category: 'blouse', colourFamily: 'red', weave: 'silk', pricePaise: 650000, status: 'ACTIVE', entityVersion: 1, variants: [{ variantId: 'm', label: 'M', sellableQty: 3, version: 1 }] },
        ].map((doc) => applySeedLabels(doc, seedGroup, true));
        await upsertMany('src_products', ['tenantId', 'productId'], festivalProducts, session);

        const festivalCollection = [
          {
            tenantId: 'shop_a',
            releaseId: 'rel_fc_diwali',
            title: 'Diwali Handloom Festive Collection 2026',
            description: 'Exclusive handwoven silks, brocades, and festive zari ensembles',
            status: 'ACTIVE',
            categories: ['saree', 'lehenga', 'kurta', 'dupatta', 'blouse'],
            publishedAt: now,
            entityVersion: 1,
            items: festivalProducts.map((p) => ({
              productId: p.productId,
              name: p.name,
              category: p.category,
              colourFamily: p.colourFamily,
              weave: p.weave,
              pricePaise: p.pricePaise,
              sellableQtyAfter: p.variants?.[0]?.sellableQty || 1,
            })),
          },
        ].map((doc) => applySeedLabels(doc, seedGroup, true));
        await upsertMany('src_collections', ['tenantId', 'releaseId'], festivalCollection, session);

        const festivalSeasons = [
          {
            tenantId: 'shop_a',
            seasonId: 'season_fc_diwali',
            name: 'Diwali Festive Season 2026',
            festivalDate,
            releaseId: 'rel_fc_diwali',
            collectionId: 'rel_fc_diwali',
            description: 'Diwali festive handloom collection launch',
            validFrom: now,
            validUntil,
            status: 'ACTIVE',
            branchIds: ['branch_main', 'branch_two'],
            entityVersion: 1,
          },
        ].map((doc) => applySeedLabels(doc, seedGroup, true));
        await upsertMany('src_seasons', ['tenantId', 'seasonId'], festivalSeasons, session);

        await upsertMany('campaigns', ['tenantId', 'campaignId'], [applySeedLabels({
          campaignId: 'cmp_festival_collection',
          tenantId: 'shop_a',
          name: 'Festival Collection Launch',
          presetId: 'festival_collection',
          status: 'ACTIVE',
          activeVersionId: 'ver_festival_collection_1',
          draftVersion: 1,
          pauseGeneration: 0,
          enabledBranches: ['branch_main', 'branch_two'],
          startAt: null,
          activatedAt: now,
          endAt: null,
        }, seedGroup, false)], session);

        await upsertMany('campaignVersions', ['tenantId', 'campaignId', 'version'], [applySeedLabels({
          campaignId: 'cmp_festival_collection',
          tenantId: 'shop_a',
          version: 1,
          name: 'Festival Collection Launch',
          presetId: 'festival_collection',
          purpose: 'MARKETING',
          category: 'MARKETING',
          priority: 50,
          trigger: { type: 'OWNER_DATED_EVENT', anchor: 'FESTIVAL_DATE' },
          audience: { mode: 'ALL_ELIGIBLE', rules: null },
          audienceMode: 'ALL_ELIGIBLE',
          matchMode: 'STRICT',
          maxItemsInMessage: 3,
          maxRecipientsPerOffer: 1000,
          goalMode: 'COLLECTION_ITEM_OR_TAGGED',
          steps: [
            {
              stepId: 'step_launch',
              stepName: 'Festival Collection Launch',
              offsetDays: -21,
              localTime: '10:00',
              prerequisite: 'NONE',
              outsideHoursPolicy: 'DEFER_NEXT_DAY',
              maxDeferralHours: 24,
              maxLatenessMinutes: 720,
              stopOnReply: true,
              stopOnGoal: true,
              templateRef: { id: 'tpl_collection_new_items', name: 'tpl_collection_new_items', language: 'en', revision: 1 },
              bindings: {
                '1': { source: 'customer.firstName' },
                '2': { source: 'shop.displayName' },
                '3': { source: 'festival.name', fallbackLiteral: 'Festive Edit' },
                '4': { source: 'match.itemList', fallbackLiteral: 'our festive sarees' },
              },
            },
            {
              stepId: 'step_followup',
              stepName: 'Festival Preparation Follow-up',
              offsetDays: -7,
              localTime: '10:00',
              prerequisite: 'PREVIOUS_ACCEPTED',
              outsideHoursPolicy: 'DEFER_NEXT_DAY',
              maxDeferralHours: 24,
              maxLatenessMinutes: 720,
              stopOnReply: true,
              stopOnGoal: true,
              templateRef: { id: 'tpl_collection_followup', name: 'tpl_collection_followup', language: 'en', revision: 1 },
              bindings: {
                '1': { source: 'customer.firstName' },
                '2': { source: 'shop.displayName' },
                '3': { source: 'festival.name', fallbackLiteral: 'Festive Edit' },
                '4': { source: 'match.itemList', fallbackLiteral: 'festive handloom pieces' },
              },
            },
          ],
          enabledBranches: ['branch_main', 'branch_two'],
          timezone: 'Asia/Kolkata',
          bindingsSchemaVersion: 2,
          isPublished: true,
          publishedAt: now,
        }, seedGroup, false)], session);
      }

      if (scenario === 'exhibition-trunk-show') {
        const now = clock.now();
        const seedGroup = 'exhibition-trunk-show';

        const exhibitionCustomers = Array.from({ length: 25 }, (_, i) => {
          const index = i + 1;
          const pad = String(index).padStart(2, '0');
          const city = index % 3 === 0 ? 'Mumbai' : index % 3 === 1 ? 'Pune' : 'Delhi';
          return {
            tenantId: 'shop_a',
            customerId: `cus_ex_${pad}`,
            firstName: ['Aarav', 'Diya', 'Ishaan', 'Ananya', 'Rohan', 'Meera', 'Kabir', 'Tanvi', 'Aditya', 'Pooja', 'Vikram', 'Rhea', 'Siddharth', 'Fatima', 'Arjun', 'Sneha', 'Varun', 'Nisha', 'Karan', 'Simran', 'Rahul', 'Anjali', 'Dev', 'Kavita', 'Amit'][i],
            rawPhone: `+91 98200 000${pad}`,
            marketingOptIn: index !== 12,
            channelSuppressed: index === 13,
            verified: index !== 14,
            preferences: {
              source: 'CUSTOMER_DECLARED',
              categories: index % 2 === 0 ? ['saree', 'lehenga'] : ['dupatta', 'blouse'],
              weaves: index % 2 === 0 ? ['silk', 'zari'] : ['cotton'],
              colours: ['red', 'gold'],
              budgetMaxPaise: 5000000,
            },
            tags: index === 2 ? ['branch_two'] : ['vip', 'trunk_show'],
            status: index === 15 ? 'DELETED' : 'ACTIVE',
            branchId: index % 5 === 2 ? 'branch_two' : 'branch_main',
            birthday: null,
            city,
            deletedAt: index === 15 ? now : null,
            language: 'en',
            isLive: Boolean(options.live),
          };
        });
        await insertCustomerBatch('shop_a', exhibitionCustomers, seedGroup, session);

        // 5 customers for shop_b tenant isolation
        const shopBCustomers = Array.from({ length: 5 }, (_, i) => {
          const index = i + 1;
          const pad = String(index).padStart(2, '0');
          return {
            tenantId: 'shop_b',
            customerId: `cus_ex_b_${pad}`,
            firstName: ['Bhavna', 'Bharat', 'Bina', 'Brijesh', 'Balram'][i],
            rawPhone: `+91 98211 000${pad}`,
            birthday: null,
            marketingOptIn: true,
            channelSuppressed: false,
            verified: true,
            preferences: { source: 'CUSTOMER_DECLARED', categories: ['saree'] },
            tags: ['trunk_show'],
            status: 'ACTIVE',
            branchId: 'branch_b_main',
            city: 'Mumbai',
            deletedAt: null,
            language: 'en',
            isLive: Boolean(options.live),
          };
        });
        await insertCustomerBatch('shop_b', shopBCustomers, seedGroup, session);

        // Store events for shop_a
        const startDateMumbai = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);
        const endDateMumbai = new Date(now.getTime() + 16 * 24 * 60 * 60 * 1000);
        const startDateDelhi = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
        const endDateDelhi = new Date(now.getTime() + 32 * 24 * 60 * 60 * 1000);

        const storeEvents = [
          {
            tenantId: 'shop_a',
            eventId: 'evt_ex_mumbai_2026',
            title: 'Mumbai Handloom Silk Trunk Show 2026',
            eventType: 'TRUNK_SHOW',
            venue: {
              name: 'The Taj Mahal Palace',
              address: 'Apollo Bunder, Colaba',
              city: 'Mumbai',
              googleMapsUrl: 'https://maps.google.com/?q=The+Taj+Mahal+Palace+Mumbai',
            },
            city: 'Mumbai',
            startDate: startDateMumbai,
            endDate: endDateMumbai,
            capacity: 50,
            registeredCount: 5,
            rsvpLinkUrl: 'https://rsvp.example.com/mumbai-silk-trunk-show',
            targetCities: ['Mumbai', 'Thane', 'Navi Mumbai', 'Pune'],
            targetBranches: ['branch_main', 'branch_two'],
            categories: ['saree', 'lehenga', 'dupatta'],
            status: 'ACTIVE',
            entityVersion: 1,
            publishedAt: now,
          },
          {
            tenantId: 'shop_a',
            eventId: 'evt_ex_delhi_2026',
            title: 'Delhi Heritage Exhibition 2026',
            eventType: 'EXHIBITION',
            venue: {
              name: 'The Imperial',
              address: 'Janpath, Connaught Place',
              city: 'Delhi',
              googleMapsUrl: 'https://maps.google.com/?q=The+Imperial+New+Delhi',
            },
            city: 'Delhi',
            startDate: startDateDelhi,
            endDate: endDateDelhi,
            capacity: 100,
            registeredCount: 0,
            rsvpLinkUrl: 'https://rsvp.example.com/delhi-heritage-2026',
            targetCities: ['Delhi', 'Noida', 'Gurugram'],
            targetBranches: ['branch_main'],
            categories: ['saree', 'shawl'],
            status: 'ACTIVE',
            entityVersion: 1,
            publishedAt: now,
          },
        ].map((doc) => applySeedLabels(doc, seedGroup, true));
        await upsertMany('src_events', ['tenantId', 'eventId'], storeEvents, session);

        // Campaign cmp_exhibition_trunk_show
        await upsertMany('campaigns', ['tenantId', 'campaignId'], [applySeedLabels({
          campaignId: 'cmp_exhibition_trunk_show',
          tenantId: 'shop_a',
          name: 'Exhibition / Trunk Show',
          presetId: 'exhibition_trunk_show',
          status: 'ACTIVE',
          activeVersionId: 'ver_exhibition_trunk_show_1',
          draftVersion: 1,
          pauseGeneration: 0,
          enabledBranches: ['branch_main', 'branch_two'],
          startAt: null,
          activatedAt: now,
          endAt: null,
        }, seedGroup, false)], session);

        await upsertMany('campaignVersions', ['tenantId', 'campaignId', 'version'], [applySeedLabels({
          campaignId: 'cmp_exhibition_trunk_show',
          tenantId: 'shop_a',
          version: 1,
          name: 'Exhibition / Trunk Show',
          presetId: 'exhibition_trunk_show',
          purpose: 'MARKETING',
          category: 'MARKETING',
          priority: 45,
          trigger: { type: 'OWNER_DATED_EVENT', anchor: 'EVENT_START_DATE' },
          audience: { mode: 'ALL_ELIGIBLE', rules: null },
          audienceMode: 'ALL_ELIGIBLE',
          matchMode: 'STRICT',
          maxRecipientsPerOffer: 1000,
          goalMode: 'STORE_EVENT_VISIT_OR_PURCHASE',
          steps: [
            {
              stepId: 'step_invite',
              stepName: 'Exhibition Invitation',
              offsetDays: -14,
              localTime: '10:00',
              prerequisite: 'NONE',
              outsideHoursPolicy: 'DEFER_NEXT_DAY',
              maxDeferralHours: 24,
              maxLatenessMinutes: 720,
              stopOnReply: true,
              stopOnGoal: true,
              templateRef: { id: 'tpl_exhibition_invite', name: 'tpl_exhibition_invite', language: 'en', revision: 1 },
              bindings: {
                '1': { source: 'customer.firstName' },
                '2': { source: 'shop.displayName' },
                '3': { source: 'event.name', fallbackLiteral: 'Boutique Trunk Show' },
                '4': { source: 'event.date', fallbackLiteral: 'Upcoming' },
                '5': { source: 'event.venue', fallbackLiteral: 'Main Boutique' },
                '6': { source: 'event.rsvpLink', fallbackLiteral: '' },
              },
            },
            {
              stepId: 'step_reminder',
              stepName: 'Exhibition Reminder',
              offsetDays: -3,
              localTime: '10:00',
              prerequisite: 'PREVIOUS_ACCEPTED',
              outsideHoursPolicy: 'DEFER_NEXT_DAY',
              maxDeferralHours: 24,
              maxLatenessMinutes: 720,
              stopOnReply: true,
              stopOnGoal: true,
              templateRef: { id: 'tpl_exhibition_reminder', name: 'tpl_exhibition_reminder', language: 'en', revision: 1 },
              bindings: {
                '1': { source: 'customer.firstName' },
                '2': { source: 'shop.displayName' },
                '3': { source: 'event.name', fallbackLiteral: 'Boutique Trunk Show' },
                '4': { source: 'event.date', fallbackLiteral: 'Upcoming' },
                '5': { source: 'event.venue', fallbackLiteral: 'Main Boutique' },
              },
            },
          ],
          enabledBranches: ['branch_main', 'branch_two'],
          timezone: 'Asia/Kolkata',
          bindingsSchemaVersion: 2,
          isPublished: true,
          publishedAt: now,
        }, seedGroup, false)], session);
      }

      if (scenario === 'fitting-alteration') {
        const now = clock.now();
        const seedGroup = 'fitting-alteration';

        const fittingCustomers = Array.from({ length: 20 }, (_, i) => {
          const index = i + 1;
          const pad = String(index).padStart(2, '0');
          return {
            tenantId: 'shop_a',
            customerId: `cus_fa_${pad}`,
            firstName: ['Aarohi', 'Bhavika', 'Charvi', 'Deepa', 'Esha', 'Falguni', 'Geeta', 'Harini', 'Ila', 'Jyoti', 'Kavya', 'Leela', 'Madhavi', 'Naina', 'Ojasvi', 'Prachi', 'Radha', 'Sadhana', 'Tara', 'Uma'][i],
            rawPhone: `+91 98230 000${pad}`,
            marketingOptIn: index !== 12,
            channelSuppressed: index === 13,
            verified: index !== 14,
            preferences: {
              source: 'CUSTOMER_DECLARED',
              categories: ['saree', 'lehenga', 'blouse'],
            },
            tags: index === 2 ? ['branch_two'] : ['service', 'bridal'],
            status: index === 15 ? 'DELETED' : 'ACTIVE',
            branchId: index % 5 === 2 ? 'branch_two' : 'branch_main',
            birthday: null,
            city: 'Mumbai',
            deletedAt: index === 15 ? now : null,
            language: 'en',
            isLive: Boolean(options.live),
          };
        });
        await insertCustomerBatch('shop_a', fittingCustomers, seedGroup, session);

        // 5 customers for shop_b tenant isolation
        const shopBCustomers = Array.from({ length: 5 }, (_, i) => {
          const index = i + 1;
          const pad = String(index).padStart(2, '0');
          return {
            tenantId: 'shop_b',
            customerId: `cus_fa_b_${pad}`,
            firstName: ['Bhairavi', 'Bimla', 'Bandana', 'Bhumika', 'Barkha'][i],
            rawPhone: `+91 98231 000${pad}`,
            birthday: null,
            marketingOptIn: true,
            channelSuppressed: false,
            verified: true,
            preferences: { source: 'CUSTOMER_DECLARED', categories: ['saree'] },
            tags: ['service'],
            status: 'ACTIVE',
            branchId: 'branch_b_main',
            city: 'Mumbai',
            deletedAt: null,
            language: 'en',
            isLive: Boolean(options.live),
          };
        });
        await insertCustomerBatch('shop_b', shopBCustomers, seedGroup, session);

        // Appointments for shop_a
        const appointments = [
          {
            tenantId: 'shop_a',
            appointmentId: 'appt_fa_01',
            customerId: 'cus_fa_01',
            branchId: 'branch_main',
            serviceType: 'FITTING',
            scheduledAt: new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000),
            status: 'BOOKED',
            stylistName: 'Pooja',
            notes: 'Bridal saree pleating & trial',
            entityVersion: 1,
            seedGroup,
          },
          {
            tenantId: 'shop_a',
            appointmentId: 'appt_fa_02',
            customerId: 'cus_fa_02',
            branchId: 'branch_main',
            serviceType: 'BRIDAL_TRIAL',
            scheduledAt: new Date(now.getTime() + 5 * 24 * 60 * 60 * 1000),
            status: 'BOOKED',
            stylistName: 'Rhea',
            notes: 'Lehenga final trial with dupatta drape',
            entityVersion: 1,
            seedGroup,
          },
          {
            tenantId: 'shop_a',
            appointmentId: 'appt_fa_03',
            customerId: 'cus_fa_03',
            branchId: 'branch_two',
            serviceType: 'MEASUREMENT',
            scheduledAt: new Date(now.getTime() + 1 * 24 * 60 * 60 * 1000),
            status: 'BOOKED',
            stylistName: 'Meera',
            notes: 'Custom blouse measurement',
            entityVersion: 1,
            seedGroup,
          },
          {
            tenantId: 'shop_a',
            appointmentId: 'appt_fa_04',
            customerId: 'cus_fa_04',
            branchId: 'branch_main',
            serviceType: 'STYLING',
            scheduledAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
            status: 'RESCHEDULED',
            rescheduledFrom: new Date(now.getTime() + 4 * 24 * 60 * 60 * 1000),
            rescheduledAt: now,
            stylistName: 'Pooja',
            notes: 'Consultation rescheduled per customer request',
            entityVersion: 2,
            seedGroup,
          },
          {
            tenantId: 'shop_a',
            appointmentId: 'appt_fa_past',
            customerId: 'cus_fa_05',
            branchId: 'branch_main',
            serviceType: 'FITTING',
            scheduledAt: new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000),
            status: 'COMPLETED',
            stylistName: 'Pooja',
            notes: 'Completed past fitting',
            entityVersion: 1,
            seedGroup,
          },
        ];
        await upsertMany('src_appointments', ['tenantId', 'appointmentId'], appointments, session);

        // Alterations for shop_a
        const alterations = [
          {
            tenantId: 'shop_a',
            jobId: 'alt_fa_01',
            orderId: 'ord_fa_01',
            customerId: 'cus_fa_06',
            branchId: 'branch_main',
            garmentDescription: 'Bridal Lehenga Blouse',
            currentStage: 'STITCHING',
            milestones: [
              { milestoneId: 'ms_01', stage: 'RECEIVED', reachedAt: new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000) },
              { milestoneId: 'ms_02', stage: 'CUTTING', reachedAt: new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000) },
              { milestoneId: 'ms_03', stage: 'STITCHING', reachedAt: now },
            ],
            trialDate: new Date(now.getTime() + 4 * 24 * 60 * 60 * 1000),
            notes: 'Sleeve alteration & padding adjustment',
            entityVersion: 3,
            seedGroup,
          },
          {
            tenantId: 'shop_a',
            jobId: 'alt_fa_02',
            orderId: 'ord_fa_02',
            customerId: 'cus_fa_07',
            branchId: 'branch_main',
            garmentDescription: 'Silk Saree Fall & Pico',
            currentStage: 'TRIAL_READY',
            milestones: [
              { milestoneId: 'ms_10', stage: 'RECEIVED', reachedAt: new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000) },
              { milestoneId: 'ms_11', stage: 'TRIAL_READY', reachedAt: now, notes: 'Ready for trial / pickup' },
            ],
            trialDate: new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000),
            notes: 'Finished fall & pico finishing',
            entityVersion: 2,
            seedGroup,
          },
          {
            tenantId: 'shop_a',
            jobId: 'alt_fa_03',
            orderId: 'ord_fa_03',
            customerId: 'cus_fa_08',
            branchId: 'branch_two',
            garmentDescription: 'Anarkali Kurta Sleeves',
            currentStage: 'CUTTING',
            milestones: [
              { milestoneId: 'ms_20', stage: 'RECEIVED', reachedAt: now },
            ],
            notes: 'Length shortening by 2 inches',
            entityVersion: 1,
            seedGroup,
          },
        ];
        await upsertMany('src_alterations', ['tenantId', 'jobId'], alterations, session);

        // Campaign cmp_fitting_alteration
        await upsertMany('campaigns', ['tenantId', 'campaignId'], [applySeedLabels({
          campaignId: 'cmp_fitting_alteration',
          tenantId: 'shop_a',
          name: 'Fitting / Alteration',
          presetId: 'fitting_alteration',
          status: 'ACTIVE',
          activeVersionId: 'ver_fitting_alteration_1',
          draftVersion: 1,
          pauseGeneration: 0,
          enabledBranches: ['branch_main', 'branch_two'],
          startAt: null,
          activatedAt: now,
          endAt: null,
        }, seedGroup, false)], session);

        await upsertMany('campaignVersions', ['tenantId', 'campaignId', 'version'], [applySeedLabels({
          campaignId: 'cmp_fitting_alteration',
          tenantId: 'shop_a',
          version: 1,
          name: 'Fitting / Alteration',
          presetId: 'fitting_alteration',
          purpose: 'SERVICE',
          category: 'SERVICE',
          priority: 60,
          trigger: { type: 'APPOINTMENT', anchor: 'APPOINTMENT_SCHEDULED_AT' },
          audience: { mode: 'ALL_ELIGIBLE', rules: null },
          audienceMode: 'ALL_ELIGIBLE',
          matchMode: 'STRICT',
          steps: [
            {
              stepId: 'appointment_confirmation',
              stepName: 'Appointment Confirmation',
              offsetDays: 0,
              localTime: '10:00',
              prerequisite: 'NONE',
              outsideHoursPolicy: 'DEFER_NEXT_DAY',
              maxDeferralHours: 24,
              maxLatenessMinutes: 120,
              stopOnReply: false,
              stopOnGoal: true,
              templateRef: { id: 'tpl_fitting_confirmation', name: 'tpl_fitting_confirmation', language: 'en', revision: 1 },
              bindings: {
                '1': { source: 'customer.firstName' },
                '2': { source: 'shop.displayName' },
                '3': { source: 'appointment.serviceType', fallbackLiteral: 'Fitting' },
                '4': { source: 'appointment.date', fallbackLiteral: 'Upcoming' },
                '5': { source: 'appointment.time', fallbackLiteral: '10:00 AM' },
                '6': { source: 'appointment.branch', fallbackLiteral: 'Main Store' },
              },
            },
            {
              stepId: 'appointment_reminder',
              stepName: 'Appointment Reminder',
              offsetDays: -1,
              localTime: '10:00',
              prerequisite: 'NONE',
              outsideHoursPolicy: 'DEFER_NEXT_DAY',
              maxDeferralHours: 24,
              maxLatenessMinutes: 180,
              stopOnReply: false,
              stopOnGoal: true,
              templateRef: { id: 'tpl_fitting_reminder', name: 'tpl_fitting_reminder', language: 'en', revision: 1 },
              bindings: {
                '1': { source: 'customer.firstName' },
                '2': { source: 'shop.displayName' },
                '3': { source: 'appointment.serviceType', fallbackLiteral: 'Fitting' },
                '4': { source: 'appointment.date', fallbackLiteral: 'Upcoming' },
                '5': { source: 'appointment.time', fallbackLiteral: '10:00 AM' },
                '6': { source: 'appointment.branch', fallbackLiteral: 'Main Store' },
              },
            },
            {
              stepId: 'alteration_stage_update',
              stepName: 'Alteration Stage Update',
              offsetDays: 0,
              localTime: '11:00',
              prerequisite: 'NONE',
              outsideHoursPolicy: 'DEFER_NEXT_DAY',
              maxDeferralHours: 24,
              maxLatenessMinutes: 240,
              stopOnReply: false,
              stopOnGoal: true,
              templateRef: { id: 'tpl_alteration_milestone', name: 'tpl_alteration_milestone', language: 'en', revision: 1 },
              bindings: {
                '1': { source: 'customer.firstName' },
                '2': { source: 'shop.displayName' },
                '3': { source: 'alteration.garment', fallbackLiteral: 'Outfit Piece' },
                '4': { source: 'alteration.stage', fallbackLiteral: 'in progress' },
                '5': { source: 'alteration.notes', fallbackLiteral: 'Please contact store for details' },
              },
            },
          ],
          enabledBranches: ['branch_main', 'branch_two'],
          timezone: 'Asia/Kolkata',
          bindingsSchemaVersion: 2,
          isPublished: true,
          publishedAt: now,
        }, seedGroup, false)], session);
      }

      if (scenario === 'outfit-fulfilment') {
        const now = clock.now();
        const seedGroup = 'outfit-fulfilment';
        const oldTimestamp = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000); // 60 days ago

        // 14 customers for shop_a
        const outfitCustomers: any[] = [
          {
            tenantId: 'shop_a',
            customerId: 'cus_of_ful_eligible',
            firstName: 'Kavita',
            rawPhone: '+91 98230 00101',
            marketingOptIn: true,
            channelSuppressed: false,
            verified: true,
            status: 'ACTIVE',
            branchId: 'branch_main',
            tags: ['service', 'fulfilment'],
          },
          {
            tenantId: 'shop_a',
            customerId: 'cus_of_ful_opted_out',
            firstName: 'Pooja',
            rawPhone: '+91 98230 00102',
            marketingOptIn: false, // Marketing opt-out: must still receive service messages!
            channelSuppressed: false,
            verified: true,
            status: 'ACTIVE',
            branchId: 'branch_main',
            tags: ['service', 'fulfilment'],
          },
          {
            tenantId: 'shop_a',
            customerId: 'cus_of_ful_suppressed',
            firstName: 'Ananya',
            rawPhone: '+91 98230 00103',
            marketingOptIn: true,
            channelSuppressed: true, // Suppressed: blocks service messages
            verified: true,
            status: 'ACTIVE',
            branchId: 'branch_main',
            tags: ['service', 'fulfilment'],
          },
          {
            tenantId: 'shop_a',
            customerId: 'cus_of_ful_unverified',
            firstName: 'Bhavna',
            rawPhone: '+91 98230 00104',
            marketingOptIn: true,
            channelSuppressed: false,
            verified: false,
            status: 'ACTIVE',
            branchId: 'branch_main',
            tags: ['service', 'fulfilment'],
          },
          {
            tenantId: 'shop_a',
            customerId: 'cus_of_ful_undeliverable',
            firstName: 'Deepa',
            rawPhone: '+91 98230 00105',
            marketingOptIn: true,
            channelSuppressed: false,
            verified: true,
            destination: {
              verified: true,
              verificationLevel: 'CONFIRMED_BY_STAFF',
              undeliverable: true,
              undeliverableReason: 'INVALID_NUMBER',
            },
            status: 'ACTIVE',
            branchId: 'branch_main',
            tags: ['service', 'fulfilment'],
          },
          {
            tenantId: 'shop_a',
            customerId: 'cus_of_ful_deleted',
            firstName: 'Geeta',
            rawPhone: '+91 98230 00106',
            marketingOptIn: true,
            channelSuppressed: false,
            verified: true,
            status: 'DELETED',
            deletedAt: now,
            branchId: 'branch_main',
            tags: ['service', 'fulfilment'],
          },
          {
            tenantId: 'shop_a',
            customerId: 'cus_of_ful_shared_1',
            firstName: 'Harini',
            rawPhone: '+91 98230 00107',
            marketingOptIn: true,
            channelSuppressed: false,
            verified: true,
            status: 'ACTIVE',
            branchId: 'branch_main',
            tags: ['service', 'fulfilment'],
          },
          {
            tenantId: 'shop_a',
            customerId: 'cus_of_ful_shared_2',
            firstName: 'Ishita',
            rawPhone: '+91 98230 00107', // Shares phone with shared_1
            marketingOptIn: true,
            channelSuppressed: false,
            verified: true,
            status: 'ACTIVE',
            branchId: 'branch_main',
            tags: ['service', 'fulfilment'],
          },
          {
            tenantId: 'shop_a',
            customerId: 'cus_of_ful_no_phone',
            firstName: 'Jaya',
            rawPhone: '',
            marketingOptIn: true,
            channelSuppressed: false,
            verified: false,
            status: 'ACTIVE',
            branchId: 'branch_main',
            tags: ['service', 'fulfilment'],
          },
          {
            tenantId: 'shop_a',
            customerId: 'cus_of_ful_pickup_1',
            firstName: 'Lavanya',
            rawPhone: '+91 98230 00110',
            marketingOptIn: true,
            channelSuppressed: false,
            verified: true,
            status: 'ACTIVE',
            branchId: 'branch_main',
            tags: ['service', 'fulfilment'],
          },
          {
            tenantId: 'shop_a',
            customerId: 'cus_of_ful_pickup_2',
            firstName: 'Madhu',
            rawPhone: '+91 98230 00111',
            marketingOptIn: true,
            channelSuppressed: false,
            verified: true,
            status: 'ACTIVE',
            branchId: 'branch_two',
            tags: ['service', 'fulfilment'],
          },
          {
            tenantId: 'shop_a',
            customerId: 'cus_of_ful_delivery_1',
            firstName: 'Neha',
            rawPhone: '+91 98230 00112',
            marketingOptIn: true,
            channelSuppressed: false,
            verified: true,
            status: 'ACTIVE',
            branchId: 'branch_main',
            tags: ['service', 'fulfilment'],
          },
          {
            tenantId: 'shop_a',
            customerId: 'cus_of_ful_delivery_2',
            firstName: 'Pallavi',
            rawPhone: '+91 98230 00113',
            marketingOptIn: true,
            channelSuppressed: false,
            verified: true,
            status: 'ACTIVE',
            branchId: 'branch_two',
            tags: ['service', 'fulfilment'],
          },
          {
            tenantId: 'shop_a',
            customerId: 'cus_of_ful_partial',
            firstName: 'Radha',
            rawPhone: '+91 98230 00114',
            marketingOptIn: true,
            channelSuppressed: false,
            verified: true,
            status: 'ACTIVE',
            branchId: 'branch_main',
            tags: ['service', 'fulfilment'],
          },
        ];
        await insertCustomerBatch('shop_a', outfitCustomers, seedGroup, session);

        // 3 customers for shop_b (tenant isolation)
        const shopBCustomers = [
          {
            tenantId: 'shop_b',
            customerId: 'cus_of_ful_b_01',
            firstName: 'Bhavna B',
            rawPhone: '+91 98231 00201',
            marketingOptIn: true,
            channelSuppressed: false,
            verified: true,
            status: 'ACTIVE',
            branchId: 'branch_b_main',
            tags: ['service'],
          },
          {
            tenantId: 'shop_b',
            customerId: 'cus_of_ful_b_02',
            firstName: 'Bindu B',
            rawPhone: '+91 98231 00202',
            marketingOptIn: true,
            channelSuppressed: false,
            verified: true,
            status: 'ACTIVE',
            branchId: 'branch_b_main',
            tags: ['service'],
          },
          {
            tenantId: 'shop_b',
            customerId: 'cus_of_ful_b_03',
            firstName: 'Bela B',
            rawPhone: '+91 98231 00203',
            marketingOptIn: true,
            channelSuppressed: false,
            verified: true,
            status: 'ACTIVE',
            branchId: 'branch_b_main',
            tags: ['service'],
          },
        ];
        await insertCustomerBatch('shop_b', shopBCustomers as any, seedGroup, session);

        // 16 fulfilment records for shop_a
        const fulfilments: any[] = [
          {
            tenantId: 'shop_a',
            orderId: 'ord_of_pickup_not_ready_1',
            customerId: 'cus_of_ful_eligible',
            branchId: 'branch_main',
            orderNumber: 'ORD-OF-101',
            mode: 'PICKUP',
            status: 'NOT_READY',
            readinessKind: null,
            readinessVersion: 0,
            readyAt: null,
            collectedAt: null,
            entityVersion: 1,
            shipments: [],
            seedGroup,
          },
          {
            tenantId: 'shop_a',
            orderId: 'ord_of_pickup_not_ready_2',
            customerId: 'cus_of_ful_pickup_1',
            branchId: 'branch_main',
            orderNumber: 'ORD-OF-102',
            mode: 'PICKUP',
            status: 'NOT_READY',
            readinessKind: null,
            readinessVersion: 0,
            readyAt: null,
            collectedAt: null,
            entityVersion: 1,
            shipments: [],
            seedGroup,
          },
          {
            tenantId: 'shop_a',
            orderId: 'ord_of_delivery_not_ready_1',
            customerId: 'cus_of_ful_eligible',
            branchId: 'branch_main',
            orderNumber: 'ORD-OF-201',
            mode: 'DELIVERY',
            status: 'NOT_READY',
            readinessKind: null,
            readinessVersion: 0,
            readyAt: null,
            collectedAt: null,
            entityVersion: 1,
            shipments: [],
            seedGroup,
          },
          {
            tenantId: 'shop_a',
            orderId: 'ord_of_delivery_not_ready_2',
            customerId: 'cus_of_ful_delivery_1',
            branchId: 'branch_two',
            orderNumber: 'ORD-OF-202',
            mode: 'DELIVERY',
            status: 'NOT_READY',
            readinessKind: null,
            readinessVersion: 0,
            readyAt: null,
            collectedAt: null,
            entityVersion: 1,
            shipments: [],
            seedGroup,
          },
          {
            tenantId: 'shop_a',
            orderId: 'ord_of_old_ready',
            customerId: 'cus_of_ful_pickup_2',
            branchId: 'branch_main',
            orderNumber: 'ORD-OF-OLD-01',
            mode: 'PICKUP',
            status: 'READY_FOR_COLLECTION',
            readinessKind: 'FULL',
            readinessVersion: 1,
            readyAt: oldTimestamp,
            collectedAt: null,
            entityVersion: 1,
            shipments: [],
            seedGroup,
          },
          {
            tenantId: 'shop_a',
            orderId: 'ord_of_old_partial',
            customerId: 'cus_of_ful_partial',
            branchId: 'branch_main',
            orderNumber: 'ORD-OF-OLD-02',
            mode: 'PICKUP',
            status: 'PARTIALLY_READY',
            readinessKind: 'PARTIAL',
            readinessVersion: 1,
            readyAt: oldTimestamp,
            collectedAt: null,
            entityVersion: 1,
            shipments: [],
            seedGroup,
          },
          {
            tenantId: 'shop_a',
            orderId: 'ord_of_old_collected',
            customerId: 'cus_of_ful_pickup_1',
            branchId: 'branch_main',
            orderNumber: 'ORD-OF-OLD-03',
            mode: 'PICKUP',
            status: 'COLLECTED',
            readinessKind: 'FULL',
            readinessVersion: 1,
            readyAt: new Date(oldTimestamp.getTime() - 5 * 86400000),
            collectedAt: new Date(oldTimestamp.getTime() - 2 * 86400000),
            entityVersion: 2,
            shipments: [],
            seedGroup,
          },
          {
            tenantId: 'shop_a',
            orderId: 'ord_of_old_delivered',
            customerId: 'cus_of_ful_delivery_1',
            branchId: 'branch_main',
            orderNumber: 'ORD-OF-OLD-04',
            mode: 'DELIVERY',
            status: 'DELIVERED',
            readinessKind: null,
            readinessVersion: 0,
            readyAt: null,
            collectedAt: null,
            entityVersion: 2,
            shipments: [
              {
                shipmentId: 'shp_of_old_01',
                carrier: 'BLUE_DART',
                carrierName: 'Blue Dart',
                trackingRef: 'BD-OLD-12345',
                status: 'DELIVERED',
                verified: true,
                dispatchedAt: new Date(oldTimestamp.getTime() - 5 * 86400000),
                deliveredAt: new Date(oldTimestamp.getTime() - 2 * 86400000),
                entityVersion: 2,
              },
            ],
            seedGroup,
          },
          {
            tenantId: 'shop_a',
            orderId: 'ord_of_old_cancelled',
            customerId: 'cus_of_ful_eligible',
            branchId: 'branch_main',
            orderNumber: 'ORD-OF-OLD-05',
            mode: 'PICKUP',
            status: 'CANCELLED',
            readinessKind: null,
            readinessVersion: 0,
            readyAt: null,
            collectedAt: null,
            entityVersion: 2,
            shipments: [],
            seedGroup,
          },
          {
            tenantId: 'shop_a',
            orderId: 'ord_of_old_rework',
            customerId: 'cus_of_ful_eligible',
            branchId: 'branch_main',
            orderNumber: 'ORD-OF-OLD-06',
            mode: 'PICKUP',
            status: 'REWORK',
            readinessKind: 'FULL',
            readinessVersion: 1,
            readyAt: new Date(oldTimestamp.getTime() - 5 * 86400000),
            collectedAt: null,
            entityVersion: 2,
            shipments: [],
            seedGroup,
          },
          {
            tenantId: 'shop_a',
            orderId: 'ord_of_old_returned',
            customerId: 'cus_of_ful_delivery_2',
            branchId: 'branch_two',
            orderNumber: 'ORD-OF-OLD-07',
            mode: 'DELIVERY',
            status: 'RETURNED',
            readinessKind: null,
            readinessVersion: 0,
            readyAt: null,
            collectedAt: null,
            entityVersion: 2,
            shipments: [],
            seedGroup,
          },
          {
            tenantId: 'shop_a',
            orderId: 'ord_of_shp_label',
            customerId: 'cus_of_ful_delivery_1',
            branchId: 'branch_main',
            orderNumber: 'ORD-OF-SHP-01',
            mode: 'DELIVERY',
            status: 'NOT_READY',
            readinessKind: null,
            readinessVersion: 0,
            readyAt: null,
            collectedAt: null,
            entityVersion: 1,
            shipments: [
              {
                shipmentId: 'shp_of_lbl_01',
                carrier: 'DELHIVERY',
                carrierName: 'Delhivery',
                trackingRef: 'DEL-LBL-01',
                status: 'LABEL_CREATED',
                verified: false,
                entityVersion: 1,
              },
            ],
            seedGroup,
          },
          {
            tenantId: 'shop_a',
            orderId: 'ord_of_shp_dispatched',
            customerId: 'cus_of_ful_delivery_2',
            branchId: 'branch_two',
            orderNumber: 'ORD-OF-SHP-02',
            mode: 'DELIVERY',
            status: 'NOT_READY',
            readinessKind: null,
            readinessVersion: 0,
            readyAt: null,
            collectedAt: null,
            entityVersion: 1,
            shipments: [
              {
                shipmentId: 'shp_of_dsp_01',
                carrier: 'DELHIVERY',
                carrierName: 'Delhivery',
                trackingRef: 'DEL-DSP-01',
                status: 'DISPATCHED',
                verified: true,
                dispatchedAt: oldTimestamp,
                entityVersion: 1,
              },
            ],
            seedGroup,
          },
          {
            tenantId: 'shop_a',
            orderId: 'ord_of_shp_failed',
            customerId: 'cus_of_ful_delivery_2',
            branchId: 'branch_two',
            orderNumber: 'ORD-OF-SHP-03',
            mode: 'DELIVERY',
            status: 'NOT_READY',
            readinessKind: null,
            readinessVersion: 0,
            readyAt: null,
            collectedAt: null,
            entityVersion: 2,
            shipments: [
              {
                shipmentId: 'shp_of_fld_01',
                carrier: 'BLUE_DART',
                carrierName: 'Blue Dart',
                trackingRef: 'BD-FLD-01',
                status: 'FAILED',
                verified: true,
                dispatchedAt: oldTimestamp,
                entityVersion: 2,
              },
            ],
            seedGroup,
          },
          {
            tenantId: 'shop_a',
            orderId: 'ord_of_anonymous',
            customerId: null,
            branchId: 'branch_main',
            orderNumber: 'ORD-OF-ANON-01',
            mode: 'PICKUP',
            status: 'READY_FOR_COLLECTION',
            readinessKind: 'FULL',
            readinessVersion: 1,
            readyAt: oldTimestamp,
            collectedAt: null,
            entityVersion: 1,
            shipments: [],
            seedGroup,
          },
          {
            tenantId: 'shop_a',
            orderId: 'ord_of_pickup_opted_out',
            customerId: 'cus_of_ful_opted_out',
            branchId: 'branch_main',
            orderNumber: 'ORD-OF-301',
            mode: 'PICKUP',
            status: 'NOT_READY',
            readinessKind: null,
            readinessVersion: 0,
            readyAt: null,
            collectedAt: null,
            entityVersion: 1,
            shipments: [],
            seedGroup,
          },
        ];

        if (options.live) {
          const liveCust: any = await SrcCustomerModel.findOne({ tenantId: 'shop_a', isLive: true }).session(session).lean();
          if (liveCust) {
            fulfilments.push(
              {
                tenantId: 'shop_a',
                orderId: 'ord_of_live_pickup',
                customerId: liveCust.customerId,
                branchId: 'branch_main',
                orderNumber: 'ORD-OF-LIVE-01',
                mode: 'PICKUP',
                status: 'NOT_READY',
                readinessKind: null,
                readinessVersion: 0,
                readyAt: null,
                collectedAt: null,
                entityVersion: 1,
                shipments: [],
                seedGroup,
              },
              {
                tenantId: 'shop_a',
                orderId: 'ord_of_live_delivery',
                customerId: liveCust.customerId,
                branchId: 'branch_main',
                orderNumber: 'ORD-OF-LIVE-02',
                mode: 'DELIVERY',
                status: 'NOT_READY',
                readinessKind: null,
                readinessVersion: 0,
                readyAt: null,
                collectedAt: null,
                entityVersion: 1,
                shipments: [],
                seedGroup,
              }
            );
          }
        }

        await upsertMany('src_fulfilments', ['tenantId', 'orderId'], fulfilments, session);

        // Seed corresponding orders in src_orders
        const srcOrders = fulfilments.filter(f => f.customerId).map(f => ({
          tenantId: f.tenantId,
          orderId: f.orderId,
          customerId: f.customerId,
          status: 'CONFIRMED',
          paid: true,
          netPaise: 500000,
          occasionRef: null,
          lines: [
            {
              lineId: `line_${f.orderId}_1`,
              productId: 'prod_saree_silk',
              category: 'saree',
              productName: 'Raw Silk Festive Ensemble',
              pricePaise: 500000,
              quantity: 1,
            },
          ],
          entityVersion: 1,
          completedAt: null,
          branchId: f.branchId,
        }));
        await upsertMany('src_orders', ['tenantId', 'orderId'], applySeedLabels(srcOrders, seedGroup, true), session);

        // 3 ACTIVE Campaigns + 1 DRAFT Campaign
        // 1. cmp_outfit_ready (ACTIVE)
        await upsertMany('campaigns', ['tenantId', 'campaignId'], [applySeedLabels({
          campaignId: 'cmp_outfit_ready',
          tenantId: 'shop_a',
          name: 'Outfit Ready for Collection',
          presetId: 'outfit_collection_delivery',
          status: 'ACTIVE',
          activeVersionId: 'ver_outfit_ready_1',
          draftVersion: 1,
          pauseGeneration: 0,
          enabledBranches: ['branch_main', 'branch_two'],
          startAt: null,
          activatedAt: now,
          endAt: null,
        }, seedGroup, false)], session);

        await upsertMany('campaignVersions', ['tenantId', 'campaignId', 'version'], [applySeedLabels({
          campaignId: 'cmp_outfit_ready',
          tenantId: 'shop_a',
          version: 1,
          name: 'Outfit Ready for Collection',
          presetId: 'outfit_collection_delivery',
          purpose: 'SERVICE',
          category: 'SERVICE',
          priority: 60,
          trigger: {
            type: 'FULFILMENT_MILESTONE',
            anchor: 'FULFILMENT_READY_AT',
            milestone: 'OUTFIT_READY',
            fulfilmentFilter: 'PICKUP',
            usefulForDays: 14,
          },
          audience: { mode: 'ALL_ELIGIBLE', rules: null },
          audienceMode: 'ALL_ELIGIBLE',
          matchMode: 'STRICT',
          steps: [
            {
              stepId: 'ready_notice',
              stepName: 'Outfit Ready Notice',
              offsetDays: 0,
              delayMinutes: 0,
              localTime: '10:00',
              delay: { value: 0, unit: 'MINUTES' },
              prerequisite: 'NONE',
              outsideHoursPolicy: 'DEFER_NEXT_DAY',
              maxDeferralHours: 16,
              maxLatenessMinutes: 360,
              stopOnReply: false,
              stopOnGoal: true,
              templateRef: { id: 'tpl_fulfil_ready', name: 'tpl_fulfil_ready', language: 'en', revision: 1 },
              bindings: {
                '1': { source: 'customer.firstName' },
                '2': { source: 'shop.displayName' },
                '3': { source: 'order.number' },
              },
            },
            {
              stepId: 'uncollected_reminder',
              stepName: 'Uncollected Outfit Reminder',
              offsetDays: 3,
              delayMinutes: 4320,
              localTime: '10:00',
              delay: { value: 3, unit: 'DAYS' },
              prerequisite: 'NONE',
              outsideHoursPolicy: 'DEFER_NEXT_DAY',
              maxDeferralHours: 16,
              maxLatenessMinutes: 360,
              stopOnReply: true,
              stopOnGoal: true,
              templateRef: { id: 'tpl_fulfil_reminder', name: 'tpl_fulfil_reminder', language: 'en', revision: 1 },
              bindings: {
                '1': { source: 'customer.firstName' },
                '2': { source: 'shop.displayName' },
                '3': { source: 'order.number' },
              },
            },
          ],
          enabledBranches: ['branch_main', 'branch_two'],
          timezone: 'Asia/Kolkata',
          bindingsSchemaVersion: 2,
          isPublished: true,
          publishedAt: now,
        }, seedGroup, false)], session);

        // 2. cmp_delivery_dispatched (ACTIVE)
        await upsertMany('campaigns', ['tenantId', 'campaignId'], [applySeedLabels({
          campaignId: 'cmp_delivery_dispatched',
          tenantId: 'shop_a',
          name: 'Delivery Dispatched Update',
          presetId: 'outfit_collection_delivery',
          status: 'ACTIVE',
          activeVersionId: 'ver_delivery_dispatched_1',
          draftVersion: 1,
          pauseGeneration: 0,
          enabledBranches: ['branch_main', 'branch_two'],
          startAt: null,
          activatedAt: now,
          endAt: null,
        }, seedGroup, false)], session);

        await upsertMany('campaignVersions', ['tenantId', 'campaignId', 'version'], [applySeedLabels({
          campaignId: 'cmp_delivery_dispatched',
          tenantId: 'shop_a',
          version: 1,
          name: 'Delivery Dispatched Update',
          presetId: 'outfit_collection_delivery',
          purpose: 'SERVICE',
          category: 'SERVICE',
          priority: 60,
          trigger: {
            type: 'FULFILMENT_MILESTONE',
            anchor: 'SHIPMENT_DISPATCHED_AT',
            milestone: 'DISPATCHED',
            fulfilmentFilter: 'DELIVERY',
          },
          audience: { mode: 'ALL_ELIGIBLE', rules: null },
          audienceMode: 'ALL_ELIGIBLE',
          matchMode: 'STRICT',
          steps: [
            {
              stepId: 'dispatch_notice',
              stepName: 'Dispatched Notice',
              offsetDays: 0,
              delayMinutes: 0,
              localTime: '10:00',
              delay: { value: 0, unit: 'MINUTES' },
              prerequisite: 'NONE',
              outsideHoursPolicy: 'DEFER_NEXT_DAY',
              maxDeferralHours: 16,
              maxLatenessMinutes: 240,
              stopOnReply: false,
              stopOnGoal: true,
              templateRef: { id: 'tpl_fulfil_dispatched', name: 'tpl_fulfil_dispatched', language: 'en', revision: 1 },
              bindings: {
                '1': { source: 'customer.firstName' },
                '2': { source: 'shop.displayName' },
                '3': { source: 'order.number' },
                '4': { source: 'shipment.carrierName' },
                '5': { source: 'shipment.trackingRef' },
              },
            },
          ],
          enabledBranches: ['branch_main', 'branch_two'],
          timezone: 'Asia/Kolkata',
          bindingsSchemaVersion: 2,
          isPublished: true,
          publishedAt: now,
        }, seedGroup, false)], session);

        // 3. cmp_delivery_delivered (ACTIVE)
        await upsertMany('campaigns', ['tenantId', 'campaignId'], [applySeedLabels({
          campaignId: 'cmp_delivery_delivered',
          tenantId: 'shop_a',
          name: 'Delivery Completed Update',
          presetId: 'outfit_collection_delivery',
          status: 'ACTIVE',
          activeVersionId: 'ver_delivery_delivered_1',
          draftVersion: 1,
          pauseGeneration: 0,
          enabledBranches: ['branch_main', 'branch_two'],
          startAt: null,
          activatedAt: now,
          endAt: null,
        }, seedGroup, false)], session);

        await upsertMany('campaignVersions', ['tenantId', 'campaignId', 'version'], [applySeedLabels({
          campaignId: 'cmp_delivery_delivered',
          tenantId: 'shop_a',
          version: 1,
          name: 'Delivery Completed Update',
          presetId: 'outfit_collection_delivery',
          purpose: 'SERVICE',
          category: 'SERVICE',
          priority: 60,
          trigger: {
            type: 'FULFILMENT_MILESTONE',
            anchor: 'SHIPMENT_DELIVERED_AT',
            milestone: 'DELIVERED',
            fulfilmentFilter: 'DELIVERY',
          },
          audience: { mode: 'ALL_ELIGIBLE', rules: null },
          audienceMode: 'ALL_ELIGIBLE',
          matchMode: 'STRICT',
          steps: [
            {
              stepId: 'delivery_notice',
              stepName: 'Delivered Notice',
              offsetDays: 0,
              delayMinutes: 0,
              localTime: '10:00',
              delay: { value: 0, unit: 'MINUTES' },
              prerequisite: 'NONE',
              outsideHoursPolicy: 'DEFER_NEXT_DAY',
              maxDeferralHours: 16,
              maxLatenessMinutes: 240,
              stopOnReply: false,
              stopOnGoal: true,
              templateRef: { id: 'tpl_fulfil_delivered', name: 'tpl_fulfil_delivered', language: 'en', revision: 1 },
              bindings: {
                '1': { source: 'customer.firstName' },
                '2': { source: 'shop.displayName' },
                '3': { source: 'order.number' },
              },
            },
          ],
          enabledBranches: ['branch_main', 'branch_two'],
          timezone: 'Asia/Kolkata',
          bindingsSchemaVersion: 2,
          isPublished: true,
          publishedAt: now,
        }, seedGroup, false)], session);

        // 4. cmp_outfit_ready_partial (DRAFT)
        await upsertMany('campaigns', ['tenantId', 'campaignId'], [applySeedLabels({
          campaignId: 'cmp_outfit_ready_partial',
          tenantId: 'shop_a',
          name: 'Outfit Partial Ready (Draft)',
          presetId: 'outfit_collection_delivery',
          status: 'DRAFT',
          draftVersion: 1,
          pauseGeneration: 0,
          enabledBranches: ['branch_main'],
          startAt: null,
          endAt: null,
        }, seedGroup, false)], session);

        await upsertMany('campaignVersions', ['tenantId', 'campaignId', 'version'], [applySeedLabels({
          campaignId: 'cmp_outfit_ready_partial',
          tenantId: 'shop_a',
          version: 1,
          name: 'Outfit Partial Ready (Draft)',
          presetId: 'outfit_collection_delivery',
          purpose: 'SERVICE',
          category: 'SERVICE',
          priority: 60,
          trigger: {
            type: 'FULFILMENT_MILESTONE',
            anchor: 'FULFILMENT_READY_AT',
            milestone: 'OUTFIT_READY',
            fulfilmentFilter: 'PICKUP',
            partialReadyTemplateRef: { id: 'tpl_fulfil_ready_partial', name: 'tpl_fulfil_ready_partial', language: 'en', revision: 1 },
            usefulForDays: 14,
          },
          audience: { mode: 'ALL_ELIGIBLE', rules: null },
          audienceMode: 'ALL_ELIGIBLE',
          matchMode: 'STRICT',
          steps: [
            {
              stepId: 'ready_notice',
              stepName: 'Outfit Ready Notice',
              offsetDays: 0,
              delayMinutes: 0,
              localTime: '10:00',
              delay: { value: 0, unit: 'MINUTES' },
              prerequisite: 'NONE',
              outsideHoursPolicy: 'DEFER_NEXT_DAY',
              maxDeferralHours: 16,
              maxLatenessMinutes: 360,
              stopOnReply: false,
              stopOnGoal: true,
              templateRef: { id: 'tpl_fulfil_ready', name: 'tpl_fulfil_ready', language: 'en', revision: 1 },
              bindings: {
                '1': { source: 'customer.firstName' },
                '2': { source: 'shop.displayName' },
                '3': { source: 'order.number' },
              },
            },
          ],
          enabledBranches: ['branch_main'],
          timezone: 'Asia/Kolkata',
          bindingsSchemaVersion: 2,
          isPublished: false,
        }, seedGroup, false)], session);

        await upsertMany(
          'campaignControlGates',
          ['tenantId', 'campaignId'],
          applySeedLabels([
            { campaignId: 'cmp_outfit_ready', tenantId: 'shop_a', pauseGeneration: 0, version: 1 },
            { campaignId: 'cmp_delivery_dispatched', tenantId: 'shop_a', pauseGeneration: 0, version: 1 },
            { campaignId: 'cmp_delivery_delivered', tenantId: 'shop_a', pauseGeneration: 0, version: 1 },
            { campaignId: 'cmp_outfit_ready_partial', tenantId: 'shop_a', pauseGeneration: 0, version: 1 },
          ], seedGroup, false),
          session
        );
      }

      return {
        shopACount,
        shopBCount,
        liveCount,
        eventsCount,
        ordersCount,
        templatesCount,
        connectionsCount,
        offersCount,
      };
    }

export async function seedScenario(
  scenario: string,
  options: SeedOptions = {}
): Promise<SeedSummary> {
  await verifySeedEnvironment();
  await connectToDatabase();

  // If base hasn't been seeded yet, run seedBase first so platform data exists
  const state = await DevSeedStateModel.findOne({ tenantId: 'shop_a' });
  if (!state || !state.appliedScenarios?.includes('base')) {
    await seedBase();
  }

  if (options.reset) {
    await resetScenario(scenario);
  }

  if (options.live) {
    await handleLiveCustomerHandover(scenario);
  }

  const session = await mongoose.startSession();
  try {
    let summary!: SeedSummary;
    await session.withTransaction(async () => {
      summary = await executeScenarioData(scenario, options, session);
    });

    // Rebuild facts
    await customerFactsService.rebuildAllCustomerFacts('shop_a');
    await customerFactsService.rebuildAllCustomerFacts('shop_b');

    // Run planner for this scenario
    if (scenario === 'welcome') {
      const { plannerService } = await import('../services/planner/planner.service');
      await plannerService.planCampaign('shop_a', 'cmp_wel_order_mode');
    } else if (scenario === 'first-repeat') {
      const { plannerService } = await import('../services/planner/planner.service');
      await plannerService.planCampaign('shop_a', 'cmp_first_repeat');
    } else if (scenario === 'gift-wedding') {
      const { plannerService } = await import('../services/planner/planner.service');
      await plannerService.planCampaign('shop_a', 'cmp_gift_wedding_shop_a');
      await plannerService.planCampaign('shop_a', 'cmp_gift_reminder_shop_a');
    } else if (scenario === 'unresolved-enquiry') {
      const { plannerService } = await import('../services/planner/planner.service');
      await plannerService.planCampaign('shop_a', 'cmp_unresolved_enquiry_shop_a');
    } else if (scenario === 'complete-outfit') {
      const { plannerService } = await import('../services/planner/planner.service');
      await plannerService.planCampaign('shop_a', 'cmp_complete_outfit_shop_a');
    }

    // Record in dev_seedState
    await DevSeedStateModel.updateOne(
      { tenantId: 'shop_a' },
      {
        $addToSet: { appliedScenarios: scenario },
        $set: { appliedAt: new Date() },
      },
      { upsert: true }
    );

    // Audit log
    await auditService.logEvent({
      tenantId: 'shop_a',
      action: 'system.seed_scenario',
      metadata: {
        scenario,
        live: Boolean(options.live),
        reset: Boolean(options.reset),
      },
    });

    console.log(`✅ Scenario "${scenario}" seeded successfully!\n`);
    return summary;
  } catch (err) {
    logger.error({ err }, `Error during scenario "${scenario}" seed`);
    throw err;
  } finally {
    await session.endSession();
  }
}

export async function seedDatabase(
  scenario: string = 'base',
  options: SeedOptions = {}
): Promise<SeedSummary> {
  if (scenario === 'base') {
    return seedBase();
  }
  if (['welcome', 'gift-wedding'].includes(scenario)) {
    console.warn(`DEPRECATED: seed:welcome and seed:gift-wedding are deprecated. Use seed:scenario ${scenario} instead.`);
  }
  return seedScenario(scenario, options);
}

// CLI Execution support:
// - `pnpm seed:base`
// - `pnpm seed:scenario <name> [--live] [--reset]`
// - `pnpm seed:reset --yes`
// - `pnpm seed:purge-mock --yes`
// - `pnpm seed:status`
// - `pnpm seed:demo`
// - Old aliases: `pnpm seed:welcome`, `pnpm seed:gift-wedding`
if (require.main === module) {
  const args = process.argv.slice(2);
  const command = args[0] || 'base';

  const hasFlag = (flag: string) => args.includes(flag);
  const isYes = hasFlag('--yes') || hasFlag('-y');
  const isLive = hasFlag('--live');
  const isReset = hasFlag('--reset');

  (async () => {
    try {
      if (command === 'reset') {
        await seedReset(isYes);
      } else if (command === 'purge-mock') {
        await seedPurgeMock(isYes);
      } else if (command === 'status') {
        await seedStatus();
      } else if (command === 'demo') {
        await seedDemo();
      } else if (command === 'base') {
        await seedBase();
      } else if (command === 'scenario') {
        const scenarioName = args[1];
        if (!scenarioName) {
          throw new Error('Usage: pnpm seed:scenario <name> [--live] [--reset]');
        }
        await seedScenario(scenarioName, { live: isLive, reset: isReset });
      } else if (command === 'welcome') {
        console.log('DEPRECATED: use pnpm seed:scenario welcome');
        await seedScenario('welcome', { live: isLive, reset: isReset });
      } else if (command === 'gift-wedding') {
        console.log('DEPRECATED: use pnpm seed:scenario gift-wedding');
        await seedScenario('gift-wedding', { live: isLive, reset: isReset });
      } else if (['first-repeat', 'unresolved-enquiry', 'complete-outfit', 'selected-stock-promotion', 'festival-collection', 'exhibition-trunk-show', 'fitting-alteration', 'outfit-fulfilment'].includes(command)) {
        await seedScenario(command, { live: isLive, reset: isReset });
      } else {
        const scenarioIdx = args.findIndex((a) => a === '--scenario' || a === '-s');
        if (scenarioIdx !== -1 && args[scenarioIdx + 1]) {
          await seedScenario(args[scenarioIdx + 1], { live: isLive, reset: isReset });
        } else {
          await seedBase();
        }
      }
      await disconnectDatabase();
      process.exit(0);
    } catch (err: any) {
      console.error('Seed execution failed:', err.message || err);
      await disconnectDatabase();
      process.exit(1);
    }
  })();
}

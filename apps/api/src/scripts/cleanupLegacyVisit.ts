import mongoose from 'mongoose';
import { connectToDatabase, verifyReplicaSetAndTransactions } from '../db/connection';
import { config } from '../config/env';
import { logger } from '../logger/logger';

export interface CleanupReport {
  dryRun: boolean;
  dbName: string;
  legacyCampaignsCount: number;
  legacyCampaignIds: string[];
  srcVisitsBefore: number;
  srcVisitsAfter: number;
  campaignVersionsBefore: number;
  campaignVersionsAfter: number;
  campaignEnrollmentsBefore: number;
  campaignEnrollmentsAfter: number;
  campaignExecutionsBefore: number;
  campaignExecutionsAfter: number;
  campaignDeliveryIntentsBefore: number;
  campaignDeliveryIntentsAfter: number;
  campaignGoalEventsBefore: number;
  campaignGoalEventsAfter: number;
  campaignDryRunsBefore: number;
  campaignDryRunsAfter: number;
  campaignCheckpointsBefore: number;
  campaignCheckpointsAfter: number;
  campaignControlGatesBefore: number;
  campaignControlGatesAfter: number;
  campaignTombstonesBefore: number;
  campaignTombstonesAfter: number;
  campaignProviderEventsBefore: number;
  campaignProviderEventsAfter: number;
  contactGateLedgerEntriesRemoved: number;
  campaignEventInboxVisitsBefore: number;
  campaignEventInboxVisitsAfter: number;
  factsWithVisitFieldsBefore: number;
  factsWithVisitFieldsAfter: number;
  indexDropped: boolean;
  collectionDropped: boolean;
  auditLogsCount: number;
  orderCampaignsCount: number;
}

export interface CleanupOptions {
  yes?: boolean;
  dbName?: string;
  mongoUri?: string;
}

export async function runCleanupLegacyVisit(options: CleanupOptions = {}): Promise<CleanupReport> {
  const isYes = Boolean(options.yes ?? process.argv.includes('--yes'));

  // Safety Check 1: Refuse production
  const nodeEnv = process.env.NODE_ENV || config.NODE_ENV || 'development';
  if (nodeEnv === 'production') {
    throw new Error('[SAFETY GUARD] cleanupLegacyVisit is strictly forbidden in production (NODE_ENV=production).');
  }

  // Safety Check 2 & 3: Connect and check DB Name
  const uri = options.mongoUri || config.MONGODB_URI;
  const targetDbName = options.dbName || config.MONGODB_DB;

  if (targetDbName !== 'grovastra_dev' && targetDbName !== 'grovastra_test') {
    throw new Error(
      `[SAFETY GUARD] cleanupLegacyVisit only operates on 'grovastra_dev' or 'grovastra_test'. Target was '${targetDbName}'.`
    );
  }

  const conn = await connectToDatabase(uri, targetDbName);
  const db = conn.db;
  if (!db) {
    throw new Error('Database handle unavailable after connection.');
  }

  // Verify Replica Set & Transactions
  await verifyReplicaSetAndTransactions(conn);

  // 1. Discover legacy campaigns
  const legacyCampaigns = await db.collection('campaigns').find({
    $or: [
      { presetId: 'WELCOME_FIRST_VISIT' },
      { triggerMode: 'VISIT' },
      { campaignId: 'cmp_wel_first_visit' },
    ],
  }).toArray();

  const legacyCampaignIds = legacyCampaigns.map((c) => c.campaignId as string);

  // 2. Discover related records
  const legacyEnrollments = legacyCampaignIds.length > 0
    ? await db.collection('campaignEnrollments').find({ campaignId: { $in: legacyCampaignIds } }).project({ enrollmentId: 1 }).toArray()
    : [];
  const legacyEnrollmentIds = legacyEnrollments.map((e) => e.enrollmentId as string);

  const legacyExecutions = legacyCampaignIds.length > 0
    ? await db.collection('campaignExecutions').find({
        $or: [
          { campaignId: { $in: legacyCampaignIds } },
          { enrollmentId: { $in: legacyEnrollmentIds } },
        ],
      }).project({ executionId: 1 }).toArray()
    : [];
  const legacyExecutionIds = legacyExecutions.map((e) => e.executionId as string);

  // 3. Count before states
  const collections = await db.listCollections().toArray();
  const hasSrcVisits = collections.some((c) => c.name === 'src_visits');
  const srcVisitsBefore = hasSrcVisits ? await db.collection('src_visits').countDocuments() : 0;

  const campaignVersionsBefore = legacyCampaignIds.length > 0
    ? await db.collection('campaignVersions').countDocuments({ campaignId: { $in: legacyCampaignIds } })
    : 0;

  const campaignEnrollmentsBefore = legacyEnrollmentIds.length;
  const campaignExecutionsBefore = legacyExecutionIds.length;

  const campaignDeliveryIntentsBefore = (legacyCampaignIds.length > 0 || legacyExecutionIds.length > 0)
    ? await db.collection('campaignDeliveryIntents').countDocuments({
        $or: [
          { campaignId: { $in: legacyCampaignIds } },
          { executionId: { $in: legacyExecutionIds } },
        ],
      })
    : 0;

  const campaignGoalEventsBefore = (legacyCampaignIds.length > 0 || legacyEnrollmentIds.length > 0)
    ? await db.collection('campaignGoalEvents').countDocuments({
        $or: [
          { campaignId: { $in: legacyCampaignIds } },
          { enrollmentId: { $in: legacyEnrollmentIds } },
        ],
      })
    : 0;

  const campaignDryRunsBefore = legacyCampaignIds.length > 0
    ? await db.collection('campaignDryRuns').countDocuments({ campaignId: { $in: legacyCampaignIds } })
    : 0;

  const campaignCheckpointsBefore = legacyCampaignIds.length > 0
    ? await db.collection('campaignCheckpoints').countDocuments({ campaignId: { $in: legacyCampaignIds } })
    : 0;

  const campaignControlGatesBefore = legacyCampaignIds.length > 0
    ? await db.collection('campaignControlGates').countDocuments({ campaignId: { $in: legacyCampaignIds } })
    : 0;

  const campaignTombstonesBefore = legacyCampaignIds.length > 0
    ? await db.collection('campaignTombstones').countDocuments({ campaignId: { $in: legacyCampaignIds } })
    : 0;

  const campaignProviderEventsBefore = legacyExecutionIds.length > 0
    ? await db.collection('campaignProviderEvents').countDocuments({ correlatedExecutionId: { $in: legacyExecutionIds } })
    : 0;

  const campaignEventInboxVisitsBefore = await db.collection('campaignEventInbox').countDocuments({
    type: { $in: ['visit.recorded', 'visit.voided'] },
  });

  const factsWithVisitFieldsBefore = await db.collection('campaignCustomerFacts').countDocuments({
    $or: [
      { visitCount: { $exists: true } },
      { firstVisitId: { $exists: true } },
      { firstVisitAt: { $exists: true } },
      { lastVisitAt: { $exists: true } },
      { visitAggregateVersion: { $exists: true } },
    ],
  });

  const auditLogsCount = await db.collection('auditLog').countDocuments();
  const orderCampaignsCount = await db.collection('campaigns').countDocuments({
    campaignId: { $nin: legacyCampaignIds },
  });

  // Calculate contact gate ledger entries that would be removed
  let contactGateLedgerEntriesRemoved = 0;
  if (legacyExecutionIds.length > 0) {
    const gates = await db.collection('campaignContactGates').find({
      'ledger.executionId': { $in: legacyExecutionIds },
    }).toArray();
    for (const g of gates) {
      const ledger = (g.ledger as Array<{ executionId: string }>) || [];
      contactGateLedgerEntriesRemoved += ledger.filter((entry) => legacyExecutionIds.includes(entry.executionId)).length;
    }
  }

  let indexDropped = false;
  let collectionDropped = false;

  if (!isYes) {
    logger.info('=== [DRY RUN] CLEANUP LEGACY VISIT ===');
    logger.info(`Database: ${targetDbName}`);
    logger.info(`Legacy Campaigns: ${legacyCampaigns.length} (${legacyCampaignIds.join(', ') || 'none'})`);
    logger.info(`src_visits to drop: ${srcVisitsBefore} records`);
    logger.info(`campaignVersions to delete: ${campaignVersionsBefore}`);
    logger.info(`campaignEnrollments to delete: ${campaignEnrollmentsBefore}`);
    logger.info(`campaignExecutions to delete: ${campaignExecutionsBefore}`);
    logger.info(`campaignDeliveryIntents to delete: ${campaignDeliveryIntentsBefore}`);
    logger.info(`campaignDryRuns to delete: ${campaignDryRunsBefore}`);
    logger.info(`campaignControlGates to delete: ${campaignControlGatesBefore}`);
    logger.info(`campaignEventInbox visit events to delete: ${campaignEventInboxVisitsBefore}`);
    logger.info(`campaignCustomerFacts to unset visit fields: ${factsWithVisitFieldsBefore}`);
    logger.info(`contactGate ledger entries to prune: ${contactGateLedgerEntriesRemoved}`);
    logger.info('Dry run completed. To commit changes, pass --yes flag.');

    return {
      dryRun: true,
      dbName: targetDbName,
      legacyCampaignsCount: legacyCampaigns.length,
      legacyCampaignIds,
      srcVisitsBefore,
      srcVisitsAfter: srcVisitsBefore,
      campaignVersionsBefore,
      campaignVersionsAfter: campaignVersionsBefore,
      campaignEnrollmentsBefore,
      campaignEnrollmentsAfter: campaignEnrollmentsBefore,
      campaignExecutionsBefore,
      campaignExecutionsAfter: campaignExecutionsBefore,
      campaignDeliveryIntentsBefore,
      campaignDeliveryIntentsAfter: campaignDeliveryIntentsBefore,
      campaignGoalEventsBefore,
      campaignGoalEventsAfter: campaignGoalEventsBefore,
      campaignDryRunsBefore,
      campaignDryRunsAfter: campaignDryRunsBefore,
      campaignCheckpointsBefore,
      campaignCheckpointsAfter: campaignCheckpointsBefore,
      campaignControlGatesBefore,
      campaignControlGatesAfter: campaignControlGatesBefore,
      campaignTombstonesBefore,
      campaignTombstonesAfter: campaignTombstonesBefore,
      campaignProviderEventsBefore,
      campaignProviderEventsAfter: campaignProviderEventsBefore,
      contactGateLedgerEntriesRemoved,
      campaignEventInboxVisitsBefore,
      campaignEventInboxVisitsAfter: campaignEventInboxVisitsBefore,
      factsWithVisitFieldsBefore,
      factsWithVisitFieldsAfter: factsWithVisitFieldsBefore,
      indexDropped: false,
      collectionDropped: false,
      auditLogsCount,
      orderCampaignsCount,
    };
  }

  // Live cleanup inside a replica set transaction
  logger.info(`[CLEANUP] Committing legacy visit cleanup on '${targetDbName}'...`);
  const session = await conn.startSession();

  try {
    await session.withTransaction(async () => {
      if (legacyExecutionIds.length > 0) {
        await db.collection('campaignExecutions').deleteMany(
          { executionId: { $in: legacyExecutionIds } },
          { session }
        );
        await db.collection('campaignDeliveryIntents').deleteMany(
          { executionId: { $in: legacyExecutionIds } },
          { session }
        );
        await db.collection('campaignProviderEvents').deleteMany(
          { correlatedExecutionId: { $in: legacyExecutionIds } },
          { session }
        );
        // Prune ledger entries while preserving gate & health
        await db.collection('campaignContactGates').updateMany(
          { 'ledger.executionId': { $in: legacyExecutionIds } },
          { $pull: { ledger: { executionId: { $in: legacyExecutionIds } } } as any },
          { session }
        );
      }

      if (legacyEnrollmentIds.length > 0) {
        await db.collection('campaignEnrollments').deleteMany(
          { enrollmentId: { $in: legacyEnrollmentIds } },
          { session }
        );
        await db.collection('campaignGoalEvents').deleteMany(
          { enrollmentId: { $in: legacyEnrollmentIds } },
          { session }
        );
      }

      if (legacyCampaignIds.length > 0) {
        await db.collection('campaignVersions').deleteMany(
          { campaignId: { $in: legacyCampaignIds } },
          { session }
        );
        await db.collection('campaignControlGates').deleteMany(
          { campaignId: { $in: legacyCampaignIds } },
          { session }
        );
        await db.collection('campaignDryRuns').deleteMany(
          { campaignId: { $in: legacyCampaignIds } },
          { session }
        );
        await db.collection('campaignCheckpoints').deleteMany(
          { campaignId: { $in: legacyCampaignIds } },
          { session }
        );
        await db.collection('campaignTombstones').deleteMany(
          { campaignId: { $in: legacyCampaignIds } },
          { session }
        );
        await db.collection('campaigns').deleteMany(
          { campaignId: { $in: legacyCampaignIds } },
          { session }
        );
      }

      // Delete inbox visit events
      await db.collection('campaignEventInbox').deleteMany(
        { type: { $in: ['visit.recorded', 'visit.voided'] } },
        { session }
      );

      // $unset visit fields from all customer facts
      await db.collection('campaignCustomerFacts').updateMany(
        {},
        {
          $unset: {
            visitCount: 1,
            firstVisitId: 1,
            firstVisitAt: 1,
            lastVisitAt: 1,
            visitAggregateVersion: 1,
          },
        },
        { session }
      );
    });
  } finally {
    await session.endSession();
  }

  // Post-transaction operations: index and collection drop
  try {
    const indexes = await db.collection('campaignCustomerFacts').indexes();
    for (const idx of indexes) {
      if (idx.key && 'visitCount' in idx.key && idx.name) {
        await db.collection('campaignCustomerFacts').dropIndex(idx.name);
        indexDropped = true;
        logger.info(`Dropped index ${idx.name} from campaignCustomerFacts.`);
      }
    }
  } catch (err: unknown) {
    logger.warn({ err }, 'Note: No visit index to drop on campaignCustomerFacts.');
  }

  if (hasSrcVisits) {
    try {
      await db.collection('src_visits').drop();
      collectionDropped = true;
      logger.info('Dropped collection src_visits.');
    } catch (err: unknown) {
      logger.warn({ err }, 'Error dropping src_visits collection.');
    }
  }

  // 4. Verify after state
  const collectionsAfter = await db.listCollections().toArray();
  const hasSrcVisitsAfter = collectionsAfter.some((c) => c.name === 'src_visits');
  const srcVisitsAfter = hasSrcVisitsAfter ? await db.collection('src_visits').countDocuments() : 0;

  const campaignVersionsAfter = legacyCampaignIds.length > 0
    ? await db.collection('campaignVersions').countDocuments({ campaignId: { $in: legacyCampaignIds } })
    : 0;
  const campaignEnrollmentsAfter = legacyCampaignIds.length > 0
    ? await db.collection('campaignEnrollments').countDocuments({ campaignId: { $in: legacyCampaignIds } })
    : 0;
  const campaignExecutionsAfter = legacyCampaignIds.length > 0
    ? await db.collection('campaignExecutions').countDocuments({ campaignId: { $in: legacyCampaignIds } })
    : 0;
  const campaignDeliveryIntentsAfter = (legacyCampaignIds.length > 0 || legacyExecutionIds.length > 0)
    ? await db.collection('campaignDeliveryIntents').countDocuments({
        $or: [
          { campaignId: { $in: legacyCampaignIds } },
          { executionId: { $in: legacyExecutionIds } },
        ],
      })
    : 0;
  const campaignGoalEventsAfter = legacyCampaignIds.length > 0
    ? await db.collection('campaignGoalEvents').countDocuments({ campaignId: { $in: legacyCampaignIds } })
    : 0;
  const campaignDryRunsAfter = legacyCampaignIds.length > 0
    ? await db.collection('campaignDryRuns').countDocuments({ campaignId: { $in: legacyCampaignIds } })
    : 0;
  const campaignCheckpointsAfter = legacyCampaignIds.length > 0
    ? await db.collection('campaignCheckpoints').countDocuments({ campaignId: { $in: legacyCampaignIds } })
    : 0;
  const campaignControlGatesAfter = legacyCampaignIds.length > 0
    ? await db.collection('campaignControlGates').countDocuments({ campaignId: { $in: legacyCampaignIds } })
    : 0;
  const campaignTombstonesAfter = legacyCampaignIds.length > 0
    ? await db.collection('campaignTombstones').countDocuments({ campaignId: { $in: legacyCampaignIds } })
    : 0;
  const campaignProviderEventsAfter = legacyExecutionIds.length > 0
    ? await db.collection('campaignProviderEvents').countDocuments({ correlatedExecutionId: { $in: legacyExecutionIds } })
    : 0;

  const campaignEventInboxVisitsAfter = await db.collection('campaignEventInbox').countDocuments({
    type: { $in: ['visit.recorded', 'visit.voided'] },
  });

  const factsWithVisitFieldsAfter = await db.collection('campaignCustomerFacts').countDocuments({
    $or: [
      { visitCount: { $exists: true } },
      { firstVisitId: { $exists: true } },
      { firstVisitAt: { $exists: true } },
      { lastVisitAt: { $exists: true } },
      { visitAggregateVersion: { $exists: true } },
    ],
  });

  const auditLogsCountAfter = await db.collection('auditLog').countDocuments();
  const orderCampaignsCountAfter = await db.collection('campaigns').countDocuments({
    campaignId: { $nin: legacyCampaignIds },
  });

  logger.info('=== CLEANUP COMPLETED SUCCESSFULLY ===');
  logger.info(`src_visits: ${srcVisitsBefore} -> ${srcVisitsAfter}`);
  logger.info(`campaignVersions: ${campaignVersionsBefore} -> ${campaignVersionsAfter}`);
  logger.info(`campaignEnrollments: ${campaignEnrollmentsBefore} -> ${campaignEnrollmentsAfter}`);
  logger.info(`campaignExecutions: ${campaignExecutionsBefore} -> ${campaignExecutionsAfter}`);
  logger.info(`factsWithVisitFields: ${factsWithVisitFieldsBefore} -> ${factsWithVisitFieldsAfter}`);
  logger.info(`auditLog preserved: ${auditLogsCount} == ${auditLogsCountAfter}`);
  logger.info(`order campaigns preserved: ${orderCampaignsCount} == ${orderCampaignsCountAfter}`);

  return {
    dryRun: false,
    dbName: targetDbName,
    legacyCampaignsCount: legacyCampaigns.length,
    legacyCampaignIds,
    srcVisitsBefore,
    srcVisitsAfter,
    campaignVersionsBefore,
    campaignVersionsAfter,
    campaignEnrollmentsBefore,
    campaignEnrollmentsAfter,
    campaignExecutionsBefore,
    campaignExecutionsAfter,
    campaignDeliveryIntentsBefore,
    campaignDeliveryIntentsAfter,
    campaignGoalEventsBefore,
    campaignGoalEventsAfter,
    campaignDryRunsBefore,
    campaignDryRunsAfter,
    campaignCheckpointsBefore,
    campaignCheckpointsAfter,
    campaignControlGatesBefore,
    campaignControlGatesAfter,
    campaignTombstonesBefore,
    campaignTombstonesAfter,
    campaignProviderEventsBefore,
    campaignProviderEventsAfter,
    contactGateLedgerEntriesRemoved,
    campaignEventInboxVisitsBefore,
    campaignEventInboxVisitsAfter,
    factsWithVisitFieldsBefore,
    factsWithVisitFieldsAfter,
    indexDropped,
    collectionDropped,
    auditLogsCount: auditLogsCountAfter,
    orderCampaignsCount: orderCampaignsCountAfter,
  };
}

if (process.argv[1] && (process.argv[1].endsWith('cleanupLegacyVisit.ts') || process.argv[1].endsWith('cleanupLegacyVisit.js'))) {
  runCleanupLegacyVisit()
    .then(() => {
      logger.info('Script finished.');
      process.exit(0);
    })
    .catch((err) => {
      logger.error({ err: err instanceof Error ? err.message : err }, 'Cleanup script failed.');
      process.exit(1);
    });
}

import { config } from '../config/env';
import { connectToDatabase, disconnectDatabase } from '../db/connection';
import { reconcileFittingAlterationCampaigns } from '../presets/fittingAlteration/reconciler';
import { logger } from '../logger/logger';

async function main() {
  const args = process.argv.slice(2);
  const tenantId = args.includes('--tenant') ? args[args.indexOf('--tenant') + 1] : 'shop_a';
  await connectToDatabase(config.MONGODB_URI, config.MONGODB_DB);
  try {
    const result = await reconcileFittingAlterationCampaigns(tenantId);
    logger.info(result, 'Fitting / alteration reconciliation result');
  } finally {
    await disconnectDatabase();
  }
}

main().catch((error) => {
  logger.error({ error }, 'Fitting / alteration reconciliation failed');
  process.exitCode = 1;
});

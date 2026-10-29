import { config } from '../config/env';
import { connectToDatabase, disconnectDatabase } from '../db/connection';
import { reconcileFulfilmentCampaigns } from '../presets/outfitCollectionDelivery/reconciler';
import { logger } from '../logger/logger';

async function main() {
  const args = process.argv.slice(2);
  const tenantId = args.includes('--tenant') ? args[args.indexOf('--tenant') + 1] : 'shop_a';
  await connectToDatabase(config.MONGODB_URI, config.MONGODB_DB);
  try {
    const result = await reconcileFulfilmentCampaigns(tenantId);
    logger.info(result, 'Outfit collection / delivery reconciliation result');
  } finally {
    await disconnectDatabase();
  }
}

main().catch((error) => {
  logger.error({ error }, 'Outfit collection / delivery reconciliation failed');
  process.exitCode = 1;
});

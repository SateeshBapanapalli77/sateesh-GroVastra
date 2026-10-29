import { config } from '../config/env';
import { connectToDatabase, disconnectDatabase } from '../db/connection';
import { reconcileFestivalCampaigns } from '../presets/festivalCollection/reconciler';
import { logger } from '../logger/logger';

async function main() {
  const args = process.argv.slice(2);
  const tenantId = args.includes('--tenant') ? args[args.indexOf('--tenant') + 1] : 'shop_a';
  const campaignId = args.includes('--campaignId') ? args[args.indexOf('--campaignId') + 1] : undefined;
  await connectToDatabase(config.MONGODB_URI, config.MONGODB_DB);
  try {
    const result = await reconcileFestivalCampaigns(tenantId, { campaignId });
    logger.info(result, 'Festival collection reconciliation result');
  } finally {
    await disconnectDatabase();
  }
}

main().catch((error) => {
  logger.error({ error }, 'Festival collection reconciliation failed');
  process.exitCode = 1;
});

import { config } from '../config/env';
import { connectToDatabase, disconnectDatabase } from '../db/connection';
import { reconcileExhibitionCampaigns } from '../presets/exhibitionTrunkShow/reconciler';
import { logger } from '../logger/logger';

async function main() {
  const args = process.argv.slice(2);
  const tenantId = args.includes('--tenant') ? args[args.indexOf('--tenant') + 1] : 'shop_a';
  const campaignId = args.includes('--campaignId') ? args[args.indexOf('--campaignId') + 1] : undefined;
  await connectToDatabase(config.MONGODB_URI, config.MONGODB_DB);
  try {
    const result = await reconcileExhibitionCampaigns(tenantId, { campaignId });
    logger.info(result, 'Exhibition / trunk show reconciliation result');
  } finally {
    await disconnectDatabase();
  }
}

main().catch((error) => {
  logger.error({ error }, 'Exhibition / trunk show reconciliation failed');
  process.exitCode = 1;
});

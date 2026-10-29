import { config } from '../config/env';
import { connectToDatabase, disconnectDatabase } from '../db/connection';
import { CampaignModel } from '../db/models/campaign.model';
import { reconcileSelectedStockCampaign } from '../presets/selectedStockPromotion/reconciler';
import { logger } from '../logger/logger';

async function main() {
  const args = process.argv.slice(2);
  const tenantId = args.includes('--tenant') ? args[args.indexOf('--tenant') + 1] : 'shop_a';
  const campaignId = args.includes('--campaignId') ? args[args.indexOf('--campaignId') + 1] : undefined;
  await connectToDatabase(config.MONGODB_URI, config.MONGODB_DB);
  try {
    const campaigns: any[] = campaignId
      ? await CampaignModel.find({ tenantId, campaignId, status: 'ACTIVE' }).lean()
      : await CampaignModel.find({
          tenantId,
          status: 'ACTIVE',
          presetId: { $in: ['selected_stock_promotion', 'SELECTED_STOCK_PROMOTION'] },
        }).lean();
    for (const campaign of campaigns) {
      logger.info(await reconcileSelectedStockCampaign(tenantId, campaign.campaignId), 'Selected-stock reconciliation result');
    }
  } finally {
    await disconnectDatabase();
  }
}

main().catch((error) => {
  logger.error({ error }, 'Selected-stock reconciliation failed');
  process.exitCode = 1;
});

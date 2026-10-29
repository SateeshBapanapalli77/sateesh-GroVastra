import mongoose from 'mongoose';
import { config } from '../config/env';
import { connectToDatabase, disconnectDatabase } from '../db/connection';
import { CampaignModel } from '../db/models/campaign.model';
import { reconcileEnquiryCampaign } from '../presets/unresolvedEnquiry/enquiryReconciler';
import { logger } from '../logger/logger';

async function main() {
  const args = process.argv.slice(2);
  let tenantId = 'shop_a';
  let campaignId: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--tenant' && args[i + 1]) {
      tenantId = args[i + 1];
      i++;
    } else if (args[i] === '--campaignId' && args[i + 1]) {
      campaignId = args[i + 1];
      i++;
    }
  }

  logger.info({ tenantId, campaignId }, 'Starting enquiry reconciliation CLI script');

  await connectToDatabase(config.MONGODB_URI, config.MONGODB_DB);

  try {
    let targetCampaigns: any[] = [];
    if (campaignId) {
      const c = await CampaignModel.findOne({ tenantId, campaignId, status: 'ACTIVE' }).lean();
      if (c) targetCampaigns.push(c);
    } else {
      targetCampaigns = await CampaignModel.find({
        tenantId,
        presetId: { $in: ['unresolved_enquiry', 'enquiry'] },
        status: 'ACTIVE',
      }).lean();
    }

    if (targetCampaigns.length === 0) {
      logger.info('No active enquiry campaigns found to reconcile.');
      return;
    }

    for (const c of targetCampaigns) {
      logger.info({ campaignId: c.campaignId }, 'Reconciling enquiry campaign...');
      const result = await reconcileEnquiryCampaign(c.tenantId, c.campaignId);
      logger.info(result, 'Enquiry campaign reconciliation result');
    }
  } finally {
    await disconnectDatabase();
  }
}

if (require.main === module) {
  main().catch((err) => {
    logger.error({ err }, 'Enquiry reconciliation script failed');
    process.exit(1);
  });
}

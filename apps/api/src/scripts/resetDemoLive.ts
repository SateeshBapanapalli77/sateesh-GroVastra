import mongoose from 'mongoose';
import { connectToDatabase, disconnectDatabase } from '../db/connection';
import {
  CampaignContactGateModel,
  CampaignEnrollmentModel,
  CampaignExecutionModel,
  CampaignDeliveryIntentModel,
  SrcCustomerModel,
  SrcOrderModel,
} from '../db/models';
import { clock } from '../services/clock';

async function resetDemoLive() {
  await connectToDatabase();
  console.log('\n[DEMO RESET] Resetting contact caps and enrollments for live demo numbers...');

  // 1. Wipe contact gates for tenant so daily marketing caps (1 msg per 24h) reset to 0
  const gateResult = await CampaignContactGateModel.deleteMany({ tenantId: 'shop_a' });
  console.log(`- Cleared ${gateResult.deletedCount} contact gate records (daily cap reset).`);

  // 2. Find live customers
  const liveCusts = await SrcCustomerModel.find({ tenantId: 'shop_a', isLive: true }).lean();
  const liveCustIds = liveCusts.map((c: any) => c.customerId);

  if (liveCustIds.length > 0) {
    const enrResult = await CampaignEnrollmentModel.deleteMany({
      tenantId: 'shop_a',
      customerId: { $in: liveCustIds },
    });
    const execResult = await CampaignExecutionModel.deleteMany({
      tenantId: 'shop_a',
      customerId: { $in: liveCustIds },
    });
    await CampaignDeliveryIntentModel.deleteMany({
      tenantId: 'shop_a',
      customerId: { $in: liveCustIds },
    });

    // Reset order completion time to 61 minutes ago for immediate dispatch
    const nowMs = clock.now().getTime();
    await SrcOrderModel.updateMany(
      { tenantId: 'shop_a', customerId: { $in: liveCustIds } },
      { $set: { completedAt: new Date(nowMs - 61 * 60 * 1000) } }
    );

    console.log(`- Cleared ${enrResult.deletedCount} enrollments and ${execResult.deletedCount} executions for live customers (${liveCustIds.join(', ')}).`);
    console.log(`- Updated qualifying orders to 61 minutes ago for immediate trigger.`);
  }

  console.log('\n✅ DEMO READY: All live test numbers are cleared and ready to receive messages!\n');
  await disconnectDatabase();
}

resetDemoLive().catch((err) => {
  console.error('Error during demo reset:', err);
  process.exit(1);
});

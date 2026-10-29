import crypto from 'crypto';
import {
  CampaignEnrollmentModel,
  CampaignExecutionModel,
  CampaignGoalEventModel,
  SrcCollectionModel,
} from '../../db/models';
import { clock } from '../../services/clock';
import { mockSeasonSource } from '../../adapters/season-source';

export async function handleOrderCompletedForFestivalGoal(
  tenantId: string,
  customerId: string,
  order: any,
  occurredAt: Date
): Promise<{ goalMatches: string[] }> {
  const enrollments = await CampaignEnrollmentModel.find({
    tenantId,
    customerId,
    status: 'ACTIVE',
    occurrenceId: { $regex: '^festival:' },
  }).lean();

  if (!enrollments.length) {
    return { goalMatches: [] };
  }

  const goalMatches: string[] = [];
  const completedAt = new Date(order.completedAt || occurredAt || clock.now());
  const orderLines = order.lines || [];
  const orderProductIds = new Set(orderLines.map((l: any) => l.productId || l.itemRef).filter(Boolean));

  for (const enrollment of enrollments) {
    const seasonId = enrollment.occurrenceId.replace('festival:', '');
    const season = await mockSeasonSource.getSeason(tenantId, seasonId);

    let isMatch = false;

    // 1. Direct occasionRef match
    if (order.occasionRef && (order.occasionRef === enrollment.occurrenceId || order.occasionRef === seasonId)) {
      isMatch = true;
    }

    // 2. Collection item match
    if (!isMatch && season) {
      const relId = season.releaseId || season.collectionId;
      if (relId) {
        const collection: any = await SrcCollectionModel.findOne({ tenantId, releaseId: relId }).lean();
        if (collection && collection.items) {
          const collectionProductIds = new Set(collection.items.map((i: any) => i.productId));
          for (const pid of orderProductIds) {
            if (collectionProductIds.has(pid)) {
              isMatch = true;
              break;
            }
          }
        }
      }
    }

    if (!isMatch) continue;

    // Record goal event
    const goalEventId = `gev_${crypto.randomUUID().slice(0, 12)}`;
    await CampaignGoalEventModel.create({
      goalEventId,
      tenantId,
      enrollmentId: enrollment.enrollmentId,
      occurrence: enrollment.occurrenceId,
      customerId,
      campaignId: enrollment.campaignId,
      source: 'ORDER_OCCASION',
      orderRef: order.orderId,
      cause: 'Festival collection product purchased',
      supportingRecord: JSON.stringify({ orderId: order.orderId, seasonId }),
      recordedBy: 'system',
      at: completedAt,
    });

    // Mark enrollment as COMPLETED
    await CampaignEnrollmentModel.updateOne(
      { tenantId, enrollmentId: enrollment.enrollmentId },
      {
        $set: {
          status: 'COMPLETED',
          goalReachedAt: completedAt,
          goalEventId,
          goalOrderRef: order.orderId,
          goalSource: 'ORDER_OCCASION',
          stoppedAt: completedAt,
          stopReason: 'GOAL_ACHIEVED',
        },
      }
    );

    // Cancel unexecuted steps that stop on goal
    await CampaignExecutionModel.updateMany(
      {
        tenantId,
        enrollmentId: enrollment.enrollmentId,
        state: { $in: ['SCHEDULED', 'DEFERRED', 'EVALUATING'] },
      },
      {
        $set: {
          state: 'SKIPPED',
          skipReason: 'SKIPPED_GOAL_REACHED',
        },
      }
    );

    goalMatches.push(enrollment.enrollmentId);
  }

  return { goalMatches };
}

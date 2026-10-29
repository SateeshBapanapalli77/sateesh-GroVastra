import crypto from 'crypto';
import {
  CampaignEnrollmentModel,
  CampaignExecutionModel,
  CampaignGoalEventModel,
  SrcEventModel,
} from '../../db/models';
import { clock } from '../../services/clock';

export async function handleOrderCompletedForExhibitionGoal(
  tenantId: string,
  customerId: string,
  order: any,
  occurredAt: Date
): Promise<{ goalMatches: string[] }> {
  const enrollments = await CampaignEnrollmentModel.find({
    tenantId,
    customerId,
    status: 'ACTIVE',
    occurrenceId: { $regex: '^storeevent:' },
  }).lean();

  if (!enrollments.length) {
    return { goalMatches: [] };
  }

  const goalMatches: string[] = [];
  const completedAt = new Date(order.completedAt || occurredAt || clock.now());

  for (const enrollment of enrollments) {
    const eventId = enrollment.occurrenceId.replace('storeevent:', '');

    let isMatch = false;

    // 1. Direct eventRef match
    if (order.eventRef && (order.eventRef === eventId || order.eventRef === enrollment.occurrenceId)) {
      isMatch = true;
    }

    // 2. Direct occasionRef match
    if (order.occasionRef && (order.occasionRef === enrollment.occurrenceId || order.occasionRef === eventId)) {
      isMatch = true;
    }

    // 3. Metadata or tagged order
    if (order.metadata?.eventId === eventId || order.tags?.includes(eventId)) {
      isMatch = true;
    }

    if (!isMatch) continue;

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
      cause: 'Exhibition / trunk show order completed',
      supportingRecord: JSON.stringify({ orderId: order.orderId, eventId }),
      recordedBy: 'system',
      at: completedAt,
    });

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

export async function handleRsvpCompletedForExhibition(
  tenantId: string,
  eventId: string,
  customerId: string,
  rsvpRecord?: any
): Promise<{ stoppedEnrollments: string[] }> {
  const stoppedEnrollments: string[] = [];
  const now = clock.now();

  // Increment event registered count
  await SrcEventModel.updateOne(
    { tenantId, eventId },
    { $inc: { registeredCount: 1 } }
  );

  const enrollments = await CampaignEnrollmentModel.find({
    tenantId,
    customerId,
    occurrenceId: `storeevent:${eventId}`,
    status: 'ACTIVE',
  }).lean();

  for (const enrollment of enrollments) {
    const goalEventId = `gev_${crypto.randomUUID().slice(0, 12)}`;
    await CampaignGoalEventModel.create({
      goalEventId,
      tenantId,
      enrollmentId: enrollment.enrollmentId,
      occurrence: enrollment.occurrenceId,
      customerId,
      campaignId: enrollment.campaignId,
      source: 'CUSTOMER_RSVP',
      cause: 'Customer registered / RSVP for exhibition',
      supportingRecord: JSON.stringify(rsvpRecord || { eventId, customerId }),
      recordedBy: 'system',
      at: now,
    });

    await CampaignEnrollmentModel.updateOne(
      { tenantId, enrollmentId: enrollment.enrollmentId },
      {
        $set: {
          status: 'COMPLETED',
          goalReachedAt: now,
          goalEventId,
          goalSource: 'CUSTOMER_RSVP',
          stoppedAt: now,
          stopReason: 'CUSTOMER_REGISTERED',
        },
      }
    );

    await CampaignExecutionModel.updateMany(
      {
        tenantId,
        enrollmentId: enrollment.enrollmentId,
        state: { $in: ['SCHEDULED', 'DEFERRED', 'EVALUATING'] },
      },
      {
        $set: {
          state: 'SKIPPED',
          skipReason: 'CUSTOMER_REGISTERED',
        },
      }
    );

    stoppedEnrollments.push(enrollment.enrollmentId);
  }

  return { stoppedEnrollments };
}

import { ICampaignEventInbox, CampaignEnrollmentModel, CampaignExecutionModel } from '../../db/models';
import { mockSeasonSource } from '../../adapters/season-source';
import { clock } from '../../services/clock';
import { fanoutFestivalSeason } from './fanout';

/**
 * Season events are hints. The authoritative season is always re-read from the
 * source adapter before validation or downstream processing.
 */
export async function handleFestivalSeasonEvent(
  eventDoc: ICampaignEventInbox
): Promise<Record<string, unknown>> {
  const { tenantId, entityId: seasonId, type } = eventDoc;
  const season = await mockSeasonSource.getSeason(tenantId, seasonId);

  if (!season) {
    return {
      handler: type,
      seasonId,
      outcome: 'QUARANTINED',
      reason: 'SEASON_INVALID',
      reasonText: `Festival season '${seasonId}' not found`,
    };
  }

  // Validate festival date
  if (!season.festivalDate || isNaN(new Date(season.festivalDate).getTime())) {
    return {
      handler: type,
      seasonId,
      outcome: 'QUARANTINED',
      reason: 'SEASON_INVALID',
      reasonText: 'Festival date is missing or invalid',
    };
  }

  // On publication, trigger fan-out
  if (type === 'season.published') {
    return fanoutFestivalSeason(tenantId, seasonId, eventDoc.eventId);
  }

  // On cancellation, withdrawal, or completion
  if (
    type === 'season.cancelled' ||
    type === 'season.withdrawn' ||
    season.status === 'CANCELLED' ||
    season.status === 'COMPLETED'
  ) {
    const reason = type === 'season.withdrawn' ? 'SEASON_WITHDRAWN' : 'SEASON_CANCELLED';
    const enrollments = await CampaignEnrollmentModel.find({
      tenantId,
      occurrenceId: `festival:${seasonId}`,
      status: 'ACTIVE',
    }).select({ enrollmentId: 1 }).lean();

    const enrollmentIds = enrollments.map((e) => e.enrollmentId);
    if (enrollmentIds.length) {
      await CampaignExecutionModel.updateMany(
        {
          tenantId,
          enrollmentId: { $in: enrollmentIds },
          state: { $in: ['SCHEDULED', 'DEFERRED', 'EVALUATING'] },
        },
        { $set: { state: 'CANCELLED', skipReason: reason } }
      );
      await CampaignEnrollmentModel.updateMany(
        { tenantId, enrollmentId: { $in: enrollmentIds }, status: 'ACTIVE' },
        { $set: { status: 'CANCELLED', stopReason: reason, stoppedAt: clock.now() } }
      );
    }
    return { handler: type, seasonId, outcome: 'CANCELLED', reason, cancelled: enrollmentIds.length };
  }

  // On pause
  if (type === 'season.updated' && season.status === 'PAUSED') {
    const enrollments = await CampaignEnrollmentModel.find({
      tenantId,
      occurrenceId: `festival:${seasonId}`,
      status: 'ACTIVE',
    }).select({ enrollmentId: 1 }).lean();

    const enrollmentIds = enrollments.map((e) => e.enrollmentId);
    if (enrollmentIds.length) {
      await CampaignExecutionModel.updateMany(
        { tenantId, enrollmentId: { $in: enrollmentIds }, state: { $in: ['SCHEDULED', 'DEFERRED'] } },
        { $set: { state: 'SKIPPED', skipReason: 'SEASON_PAUSED' } }
      );
    }
    return { handler: type, seasonId, outcome: 'PAUSED', skipped: enrollmentIds.length };
  }

  return {
    handler: type,
    seasonId,
    outcome: 'VALIDATED',
    entityVersion: season.entityVersion,
  };
}

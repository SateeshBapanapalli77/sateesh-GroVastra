import { ICampaignEventInbox, CampaignEnrollmentModel, CampaignExecutionModel } from '../../db/models';
import { mockEventSource } from '../../adapters/event-source';
import { clock } from '../../services/clock';
import { fanoutStoreEvent } from './fanout';
import { handleRsvpCompletedForExhibition } from './goalHandler';

/**
 * Store event handlers. Events are hints; the authoritative event is re-read
 * from the source adapter before validation or downstream fan-out.
 */
export async function handleStoreEvent(
  eventDoc: ICampaignEventInbox
): Promise<Record<string, unknown>> {
  const { tenantId, entityId: eventId, type } = eventDoc;
  const payload = (eventDoc.data || (eventDoc as any).payload || {}) as Record<string, unknown>;

  // Handle RSVP event
  if (type === 'rsvp.completed' || type === 'event.rsvp') {
    const customerId = (payload as any)?.customerId || (eventDoc as any).customerId;
    if (customerId) {
      return handleRsvpCompletedForExhibition(tenantId, eventId, customerId, payload);
    }
  }

  const event = await mockEventSource.getEvent(tenantId, eventId);

  if (!event) {
    return {
      handler: type,
      eventId,
      outcome: 'QUARANTINED',
      reason: 'EVENT_INVALID',
      reasonText: `Store event '${eventId}' not found`,
    };
  }

  // Validate start date
  if (!event.startDate || isNaN(new Date(event.startDate).getTime())) {
    return {
      handler: type,
      eventId,
      outcome: 'QUARANTINED',
      reason: 'EVENT_INVALID',
      reasonText: 'Event start date is missing or invalid',
    };
  }

  // Validate venue and city
  if (!event.venue || !event.venue.name || !event.venue.city) {
    return {
      handler: type,
      eventId,
      outcome: 'QUARANTINED',
      reason: 'EVENT_INVALID',
      reasonText: 'Event venue or venue city is missing',
    };
  }

  // Validate date range
  if (event.endDate && new Date(event.endDate) < new Date(event.startDate)) {
    return {
      handler: type,
      eventId,
      outcome: 'QUARANTINED',
      reason: 'EVENT_INVALID',
      reasonText: 'Event end date is before start date',
    };
  }

  // On publication, trigger fan-out
  if (type === 'event.published') {
    return fanoutStoreEvent(tenantId, eventId, eventDoc.eventId);
  }

  // On cancellation or completion
  if (
    type === 'event.cancelled' ||
    event.status === 'CANCELLED' ||
    event.status === 'COMPLETED'
  ) {
    const reason = 'EVENT_CANCELLED';
    const enrollments = await CampaignEnrollmentModel.find({
      tenantId,
      occurrenceId: `storeevent:${eventId}`,
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
    return { handler: type, eventId, outcome: 'CANCELLED', reason, cancelled: enrollmentIds.length };
  }

  // On pause or full status
  if (type === 'event.updated') {
    if (event.status === 'PAUSED') {
      const enrollments = await CampaignEnrollmentModel.find({
        tenantId,
        occurrenceId: `storeevent:${eventId}`,
        status: 'ACTIVE',
      }).select({ enrollmentId: 1 }).lean();

      const enrollmentIds = enrollments.map((e) => e.enrollmentId);
      if (enrollmentIds.length) {
        await CampaignExecutionModel.updateMany(
          { tenantId, enrollmentId: { $in: enrollmentIds }, state: { $in: ['SCHEDULED', 'DEFERRED'] } },
          { $set: { state: 'SKIPPED', skipReason: 'EVENT_PAUSED' } }
        );
      }
      return { handler: type, eventId, outcome: 'PAUSED', skipped: enrollmentIds.length };
    }

    if (event.status === 'FULL') {
      const enrollments = await CampaignEnrollmentModel.find({
        tenantId,
        occurrenceId: `storeevent:${eventId}`,
        status: 'ACTIVE',
      }).select({ enrollmentId: 1 }).lean();

      const enrollmentIds = enrollments.map((e) => e.enrollmentId);
      if (enrollmentIds.length) {
        await CampaignExecutionModel.updateMany(
          { tenantId, enrollmentId: { $in: enrollmentIds }, state: { $in: ['SCHEDULED', 'DEFERRED'] } },
          { $set: { state: 'SKIPPED', skipReason: 'EVENT_AT_CAPACITY' } }
        );
      }
      return { handler: type, eventId, outcome: 'FULL', skipped: enrollmentIds.length };
    }
  }

  return {
    handler: type,
    eventId,
    outcome: 'VALIDATED',
    entityVersion: event.entityVersion,
  };
}

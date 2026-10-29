/**
 * Event Handlers for Fitting / Alteration Campaign (F30)
 *
 * Handles domain events:
 * - appointment.booked, appointment.rescheduled, appointment.cancelled, appointment.completed
 * - alteration.created, alteration.stage_changed, alteration.cancelled, alteration.completed
 *
 * Strict Spec Guarantees:
 * - Authoritative re-read: the event payload is only a hint; authoritative state is fetched from adapter.
 * - QA Matrix A17: Rescheduling updates unsubmitted reminder times to 24h before new date.
 * - Cancellation/completion stops unsubmitted reminders.
 * - Unknown or invalid entities are safely quarantined.
 */
import {
  ICampaignEventInbox,
  CampaignEnrollmentModel,
  CampaignExecutionModel,
  CampaignModel,
} from '../../db/models';
import { mockAppointmentSource } from '../../adapters/appointment-source';
import { mockAlterationSource } from '../../adapters/alteration-source';
import {
  enrollFittingAppointment,
  rescheduleFittingEnrollment,
  enrollAlterationMilestone,
} from './enroller';
import { FITTING_ALTERATION_ID, FITTING_ALTERATION_ALIASES } from './definition';

export async function handleFittingAppointmentEvent(
  eventDoc: ICampaignEventInbox
): Promise<Record<string, unknown>> {
  const { tenantId, entityId: appointmentId, type } = eventDoc;
  const appointment = await mockAppointmentSource.getAppointment(tenantId, appointmentId);

  if (!appointment) {
    return {
      handler: type,
      appointmentId,
      outcome: 'QUARANTINED',
      reason: 'APPOINTMENT_INVALID',
      reasonText: `Appointment '${appointmentId}' not found`,
    };
  }

  // Validate scheduledAt
  if (!appointment.scheduledAt || isNaN(new Date(appointment.scheduledAt).getTime())) {
    return {
      handler: type,
      appointmentId,
      outcome: 'QUARANTINED',
      reason: 'APPOINTMENT_INVALID',
      reasonText: 'Appointment scheduled time is missing or invalid',
    };
  }

  // Handle cancellation
  if (type === 'appointment.cancelled' || appointment.status === 'CANCELLED') {
    const occurrenceId = `fitting:${appointmentId}`;
    const enrs = await CampaignEnrollmentModel.find({ tenantId, occurrenceId }).lean();
    for (const enr of enrs) {
      await CampaignExecutionModel.updateMany(
        {
          tenantId,
          enrollmentId: enr.enrollmentId,
          state: { $in: ['SCHEDULED', 'DEFERRED'] },
        },
        {
          $set: {
            state: 'CANCELLED',
            skipReason: 'APPOINTMENT_CANCELLED',
          },
        }
      );
      await CampaignEnrollmentModel.updateOne(
        { tenantId, enrollmentId: enr.enrollmentId },
        { $set: { status: 'CANCELLED' } }
      );
    }
    return {
      handler: type,
      appointmentId,
      outcome: 'CANCELLED',
      cancelledEnrollments: enrs.length,
    };
  }

  // Handle completion
  if (type === 'appointment.completed' || appointment.status === 'COMPLETED') {
    const occurrenceId = `fitting:${appointmentId}`;
    const enrs = await CampaignEnrollmentModel.find({ tenantId, occurrenceId }).lean();
    for (const enr of enrs) {
      await CampaignExecutionModel.updateMany(
        {
          tenantId,
          enrollmentId: enr.enrollmentId,
          state: { $in: ['SCHEDULED', 'DEFERRED'] },
        },
        {
          $set: {
            state: 'CANCELLED',
            skipReason: 'APPOINTMENT_COMPLETED',
          },
        }
      );
      await CampaignEnrollmentModel.updateOne(
        { tenantId, enrollmentId: enr.enrollmentId },
        { $set: { status: 'COMPLETED' } }
      );
    }
    return {
      handler: type,
      appointmentId,
      outcome: 'COMPLETED',
      completedEnrollments: enrs.length,
    };
  }

  // Handle reschedule (QA Matrix A17)
  if (type === 'appointment.rescheduled' || appointment.status === 'RESCHEDULED') {
    const { updatedCount } = await rescheduleFittingEnrollment(
      tenantId,
      appointmentId,
      new Date(appointment.scheduledAt)
    );
    return {
      handler: type,
      appointmentId,
      outcome: 'RESCHEDULED',
      rescheduledExecutions: updatedCount,
    };
  }

  // Handle appointment.booked (or new booking)
  const matchingPresets = [FITTING_ALTERATION_ID, ...FITTING_ALTERATION_ALIASES];
  const activeCampaigns = await CampaignModel.find({
    tenantId,
    presetId: { $in: matchingPresets },
    status: 'ACTIVE',
  }).lean();

  if (activeCampaigns.length === 0) {
    return {
      handler: type,
      appointmentId,
      outcome: 'NOOP',
      reason: 'NO_ACTIVE_FITTING_CAMPAIGNS',
    };
  }

  const results = [];
  for (const cmp of activeCampaigns) {
    const res = await enrollFittingAppointment(tenantId, cmp.campaignId, appointmentId);
    results.push({ campaignId: cmp.campaignId, ...res });
  }

  return {
    handler: type,
    appointmentId,
    outcome: 'ENROLLED',
    results,
  };
}

export async function handleAlterationEvent(
  eventDoc: ICampaignEventInbox
): Promise<Record<string, unknown>> {
  const { tenantId, entityId: jobId, type } = eventDoc;
  const payload = (eventDoc.data || (eventDoc as any).payload || {}) as Record<string, unknown>;
  const milestoneId =
    (payload.milestoneId as string) ||
    (payload.stage as string) ||
    `ms_${Date.now()}`;

  const alteration = await mockAlterationSource.getAlteration(tenantId, jobId);
  if (!alteration) {
    return {
      handler: type,
      jobId,
      outcome: 'QUARANTINED',
      reason: 'ALTERATION_INVALID',
      reasonText: `Alteration job '${jobId}' not found`,
    };
  }

  // Handle cancellation
  if (type === 'alteration.cancelled' || alteration.currentStage === 'CANCELLED') {
    const enrs = await CampaignEnrollmentModel.find({
      tenantId,
      occurrenceId: { $regex: `^alteration:${jobId}:` },
    }).lean();

    for (const enr of enrs) {
      await CampaignExecutionModel.updateMany(
        {
          tenantId,
          enrollmentId: enr.enrollmentId,
          state: { $in: ['SCHEDULED', 'DEFERRED'] },
        },
        {
          $set: {
            state: 'CANCELLED',
            skipReason: 'ALTERATION_CANCELLED',
          },
        }
      );
      await CampaignEnrollmentModel.updateOne(
        { tenantId, enrollmentId: enr.enrollmentId },
        { $set: { status: 'CANCELLED' } }
      );
    }
    return {
      handler: type,
      jobId,
      outcome: 'CANCELLED',
      cancelledEnrollments: enrs.length,
    };
  }

  // Handle stage change or created
  const matchingPresets = [FITTING_ALTERATION_ID, ...FITTING_ALTERATION_ALIASES];
  const activeCampaigns = await CampaignModel.find({
    tenantId,
    presetId: { $in: matchingPresets },
    status: 'ACTIVE',
  }).lean();

  if (activeCampaigns.length === 0) {
    return {
      handler: type,
      jobId,
      outcome: 'NOOP',
      reason: 'NO_ACTIVE_ALTERATION_CAMPAIGNS',
    };
  }

  const results = [];
  for (const cmp of activeCampaigns) {
    const res = await enrollAlterationMilestone(tenantId, cmp.campaignId, jobId, milestoneId);
    results.push({ campaignId: cmp.campaignId, ...res });
  }

  return {
    handler: type,
    jobId,
    outcome: 'ENROLLED',
    results,
  };
}

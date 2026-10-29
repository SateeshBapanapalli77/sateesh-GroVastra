/**
 * Reconciler for Fitting / Alteration Campaign (F30)
 *
 * Scans upcoming appointments and active alterations, ensuring active campaigns
 * have stable enrollments and marking expired appointments APPOINTMENT_PASSED.
 */
import {
  CampaignModel,
  CampaignEnrollmentModel,
  CampaignExecutionModel,
} from '../../db/models';
import { mockAppointmentSource } from '../../adapters/appointment-source';
import { enrollFittingAppointment } from './enroller';
import { FITTING_ALTERATION_ID, FITTING_ALTERATION_ALIASES } from './definition';
import { clock } from '../../services/clock';

export interface ReconcileFittingAlterationResult {
  scannedAppointments: number;
  enrolledAppointments: number;
  expiredExecutions: number;
}

export async function reconcileFittingAlterationCampaigns(
  tenantId: string,
  options?: { now?: Date }
): Promise<ReconcileFittingAlterationResult> {
  const now = options?.now || clock.now();

  const matchingPresets = [FITTING_ALTERATION_ID, ...FITTING_ALTERATION_ALIASES];
  const activeCampaigns = await CampaignModel.find({
    tenantId,
    presetId: { $in: matchingPresets },
    status: 'ACTIVE',
  }).lean();

  if (activeCampaigns.length === 0) {
    return { scannedAppointments: 0, enrolledAppointments: 0, expiredExecutions: 0 };
  }

  // 1. Scan upcoming appointments within 30 days
  const horizonEnd = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  const appointments = await mockAppointmentSource.listUpcomingAppointments(tenantId, now, horizonEnd);

  let enrolledAppointments = 0;
  for (const cmp of activeCampaigns) {
    for (const appt of appointments) {
      const occurrenceId = `fitting:${appt.appointmentId}`;
      const existing = await CampaignEnrollmentModel.findOne({
        tenantId,
        campaignId: cmp.campaignId,
        occurrenceId,
      });

      if (!existing) {
        const res = await enrollFittingAppointment(tenantId, cmp.campaignId, appt.appointmentId, {
          now,
        });
        if (res.enrolled) enrolledAppointments++;
      }
    }
  }

  // 2. Mark expired past scheduled executions
  const expiredRes = await CampaignExecutionModel.updateMany(
    {
      tenantId,
      state: 'SCHEDULED',
      dueAt: { $lt: now },
      expiresAt: { $lt: now },
      executionKey: { $regex: /:appointment_/ },
    },
    {
      $set: {
        state: 'SKIPPED',
        skipReason: 'APPOINTMENT_PASSED',
      },
    }
  );

  return {
    scannedAppointments: appointments.length,
    enrolledAppointments,
    expiredExecutions: expiredRes.modifiedCount || 0,
  };
}

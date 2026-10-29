/**
 * Enroller for Fitting / Alteration Campaign (F30)
 *
 * Implements:
 * - enrollFittingAppointment: occurrenceId 'fitting:appointmentId'
 * - enrollAlterationMilestone: occurrenceId 'alteration:jobId:milestoneId'
 * - rescheduleFittingEnrollment: moves unsubmitted reminders to 24h before new time (QA Matrix A17)
 */
import {
  CampaignEnrollmentModel,
  CampaignExecutionModel,
  CampaignModel,
  CampaignVersionModel,
} from '../../db/models';
import { mockAppointmentSource } from '../../adapters/appointment-source';
import { mockAlterationSource } from '../../adapters/alteration-source';
import { mockCustomerSource } from '../../adapters/customer-source';
import { campaignSettingsService } from '../../services/campaign-settings.service';
import { matchFittingAppointment, matchAlterationMilestone } from './matching';
import { FITTING_ALTERATION_DEFINITION } from './definition';
import { formatDateOnly } from '../../templates/bindingSources';
import { clock } from '../../services/clock';

export interface EnrollFittingResult {
  enrolled: boolean;
  enrollmentId?: string;
  occurrenceId?: string;
  reason?: string;
  reasonText?: string;
}

export interface EnrollAlterationResult {
  enrolled: boolean;
  enrollmentId?: string;
  occurrenceId?: string;
  reason?: string;
  reasonText?: string;
}

export async function enrollFittingAppointment(
  tenantId: string,
  campaignId: string,
  appointmentId: string,
  options?: { now?: Date; allowPast?: boolean }
): Promise<EnrollFittingResult> {
  const now = options?.now || clock.now();

  const appointment = await mockAppointmentSource.getAppointment(tenantId, appointmentId);
  if (!appointment) {
    return {
      enrolled: false,
      reason: 'APPOINTMENT_NOT_FOUND',
      reasonText: `Appointment '${appointmentId}' not found`,
    };
  }

  const customer = await mockCustomerSource.getCustomerById(tenantId, appointment.customerId);
  if (!customer) {
    return {
      enrolled: false,
      reason: 'CUSTOMER_NOT_FOUND',
      reasonText: `Customer '${appointment.customerId}' not found`,
    };
  }

  const matchRes = matchFittingAppointment(customer, appointment, options);
  if (!matchRes.eligible) {
    return {
      enrolled: false,
      reason: matchRes.reason,
      reasonText: matchRes.reasonText,
    };
  }

  // Load campaign and active version
  const campaign: any = await CampaignModel.findOne({ tenantId, campaignId }).lean();
  if (!campaign || campaign.status !== 'ACTIVE') {
    return {
      enrolled: false,
      reason: 'CAMPAIGN_NOT_ACTIVE',
      reasonText: 'Campaign is not active',
    };
  }

  const versionDoc: any =
    (await CampaignVersionModel.findOne({
      tenantId,
      campaignId,
      version: typeof campaign.draftVersion === 'number' ? campaign.draftVersion : 1,
    }).lean()) ||
    (await CampaignVersionModel.findOne({
      tenantId,
      campaignId,
    }).sort({ version: -1 }).lean());

  const steps = versionDoc?.steps || FITTING_ALTERATION_DEFINITION.defaults?.steps || [];
  const settings = await campaignSettingsService.getSettings(tenantId);
  const timezone = versionDoc?.timezone || settings?.timezone || 'Asia/Kolkata';

  const occurrenceId = `fitting:${appointmentId}`;
  const enrollmentKey = `${tenantId}:${campaignId}:${appointment.customerId}:${occurrenceId}`;

  // Upsert enrollment
  let enrollment = await CampaignEnrollmentModel.findOne({
    tenantId,
    campaignId,
    customerId: appointment.customerId,
    occurrenceId,
  });

  if (!enrollment) {
    const enrollmentId = `enr_fit_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    enrollment = await CampaignEnrollmentModel.create({
      tenantId,
      campaignId,
      enrollmentId,
      enrollmentKey,
      campaignVersionId: versionDoc?.version || 1,
      campaignVersion: versionDoc?.version || 1,
      customerId: appointment.customerId,
      occurrenceId,
      status: 'ACTIVE',
      dateHistory: [],
      metadata: {
        appointmentId,
        serviceType: appointment.serviceType,
        scheduledAt: appointment.scheduledAt,
      },
    });
  }

  // Plan executions (appointment steps only, exclude alteration milestones)
  const appointmentSteps = (steps as any[]).filter(
    (s: any) =>
      s.stepId.includes('confirmation') ||
      s.stepId.includes('reminder') ||
      s.stepId.includes('fitting') ||
      (!s.stepId.includes('alteration') && !s.stepId.includes('stage'))
  );
  const scheduledTime = new Date(appointment.scheduledAt).getTime();
  const reminderTimeMs = scheduledTime - 24 * 60 * 60 * 1000; // 24h before appointment

  for (const step of appointmentSteps) {
    const executionKey = `${enrollment.enrollmentId}:${step.stepId}`;
    const existing = await CampaignExecutionModel.findOne({
      tenantId,
      enrollmentId: enrollment.enrollmentId,
      stepId: step.stepId,
    });
    if (existing) continue;

    let dueAt: Date;
    let state = 'SCHEDULED';
    let skipReason: string | undefined;

    if (step.stepId.includes('reminder')) {
      dueAt = new Date(reminderTimeMs);
      if (dueAt.getTime() <= now.getTime()) {
        state = 'SKIPPED';
        skipReason = 'Elapsed step prior to evaluation instant (appointment within 24h)';
      }
    } else {
      // Confirmation step: sends immediately
      dueAt = new Date(now.getTime() + 1000);
    }

    const executionId = `exe_fit_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    await CampaignExecutionModel.create({
      tenantId,
      campaignId,
      executionId,
      executionKey,
      enrollmentId: enrollment.enrollmentId,
      stepId: step.stepId,
      stepName: step.stepName,
      dueAt,
      originalDueAt: dueAt,
      expiresAt: new Date(scheduledTime + 2 * 60 * 60 * 1000), // useful until 2h after appointment
      localDate: formatDateOnly(dueAt, timezone),
      localTime: '10:00',
      timezone,
      planRevision: 1,
      state,
      skipReason,
      templateRef: step.templateRef,
      selectionSnapshot: {
        appointmentId,
        serviceType: appointment.serviceType,
        scheduledAt: appointment.scheduledAt,
        branchId: appointment.branchId,
        stylistName: appointment.stylistName,
      },
      attemptCount: 0,
      attempts: [],
    });
  }

  return {
    enrolled: true,
    enrollmentId: enrollment.enrollmentId,
    occurrenceId,
  };
}

export async function rescheduleFittingEnrollment(
  tenantId: string,
  appointmentId: string,
  newScheduledAt: Date
): Promise<{ updatedCount: number }> {
  const occurrenceId = `fitting:${appointmentId}`;
  const enrollments = await CampaignEnrollmentModel.find({
    tenantId,
    occurrenceId,
    status: 'ACTIVE',
  }).lean();

  let updatedCount = 0;
  const newScheduledTime = new Date(newScheduledAt).getTime();
  const newReminderTime = new Date(newScheduledTime - 24 * 60 * 60 * 1000);

  for (const enr of enrollments) {
    // Find unsubmitted reminder execution
    const reminderExec = await CampaignExecutionModel.findOne({
      tenantId,
      enrollmentId: enr.enrollmentId,
      stepId: { $regex: /reminder/i },
      state: 'SCHEDULED',
    });

    if (reminderExec) {
      reminderExec.dueAt = newReminderTime;
      reminderExec.originalDueAt = newReminderTime;
      reminderExec.expiresAt = new Date(newScheduledTime + 2 * 60 * 60 * 1000);
      reminderExec.planRevision = (reminderExec.planRevision || 1) + 1;
      if (reminderExec.selectionSnapshot) {
        reminderExec.selectionSnapshot.scheduledAt = newScheduledAt;
      }
      await reminderExec.save();
      updatedCount++;
    }

    // Record in date history on enrollment
    const oldDateStr = (enr.metadata as any)?.scheduledAt
      ? new Date((enr.metadata as any).scheduledAt).toISOString()
      : '';
    const newDateStr = new Date(newScheduledAt).toISOString();
    await CampaignEnrollmentModel.updateOne(
      { tenantId, enrollmentId: enr.enrollmentId },
      {
        $push: {
          dateHistory: {
            at: clock.now(),
            oldDate: oldDateStr,
            newDate: newDateStr,
            oldVersion: enr.planRevision || 1,
            newVersion: (enr.planRevision || 1) + 1,
            reason: 'APPOINTMENT_RESCHEDULED',
          },
        },
        $set: {
          'metadata.scheduledAt': newScheduledAt,
          planRevision: (enr.planRevision || 1) + 1,
        },
      }
    );
  }

  return { updatedCount };
}

export async function enrollAlterationMilestone(
  tenantId: string,
  campaignId: string,
  jobId: string,
  milestoneId: string,
  options?: { now?: Date }
): Promise<EnrollAlterationResult> {
  const now = options?.now || clock.now();

  const alteration = await mockAlterationSource.getAlteration(tenantId, jobId);
  if (!alteration) {
    return {
      enrolled: false,
      reason: 'ALTERATION_NOT_FOUND',
      reasonText: `Alteration job '${jobId}' not found`,
    };
  }

  const customer = await mockCustomerSource.getCustomerById(tenantId, alteration.customerId);
  if (!customer) {
    return {
      enrolled: false,
      reason: 'CUSTOMER_NOT_FOUND',
      reasonText: `Customer '${alteration.customerId}' not found`,
    };
  }

  const matchRes = matchAlterationMilestone(customer, alteration);
  if (!matchRes.eligible) {
    return {
      enrolled: false,
      reason: matchRes.reason,
      reasonText: matchRes.reasonText,
    };
  }

  const campaign: any = await CampaignModel.findOne({ tenantId, campaignId }).lean();
  if (!campaign || campaign.status !== 'ACTIVE') {
    return {
      enrolled: false,
      reason: 'CAMPAIGN_NOT_ACTIVE',
      reasonText: 'Campaign is not active',
    };
  }

  const versionDoc: any =
    (await CampaignVersionModel.findOne({
      tenantId,
      campaignId,
      version: typeof campaign.draftVersion === 'number' ? campaign.draftVersion : 1,
    }).lean()) ||
    (await CampaignVersionModel.findOne({
      tenantId,
      campaignId,
    }).sort({ version: -1 }).lean());

  const steps = versionDoc?.steps || FITTING_ALTERATION_DEFINITION.defaults?.steps || [];
  const settings = await campaignSettingsService.getSettings(tenantId);
  const timezone = versionDoc?.timezone || settings?.timezone || 'Asia/Kolkata';

  const occurrenceId = `alteration:${jobId}:${milestoneId}`;
  const enrollmentKey = `${tenantId}:${campaignId}:${alteration.customerId}:${occurrenceId}`;

  let enrollment = await CampaignEnrollmentModel.findOne({
    tenantId,
    campaignId,
    customerId: alteration.customerId,
    occurrenceId,
  });

  if (!enrollment) {
    const enrollmentId = `enr_alt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    enrollment = await CampaignEnrollmentModel.create({
      tenantId,
      campaignId,
      enrollmentId,
      enrollmentKey,
      campaignVersionId: versionDoc?.version || 1,
      campaignVersion: versionDoc?.version || 1,
      customerId: alteration.customerId,
      occurrenceId,
      status: 'ACTIVE',
      metadata: {
        jobId,
        milestoneId,
        garmentDescription: alteration.garmentDescription,
        currentStage: alteration.currentStage,
      },
    });
  }

  const step =
    (steps as any[]).find((s: any) => s.stepId.includes('alteration') || s.stepId.includes('stage')) || steps[0];

  const executionKey = `${enrollment.enrollmentId}:${step.stepId}`;
  const existingExec = await CampaignExecutionModel.findOne({
    tenantId,
    enrollmentId: enrollment.enrollmentId,
    stepId: step.stepId,
  });

  if (!existingExec) {
    const executionId = `exe_alt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    await CampaignExecutionModel.create({
      tenantId,
      campaignId,
      executionId,
      executionKey,
      enrollmentId: enrollment.enrollmentId,
      stepId: step.stepId,
      stepName: step.stepName,
      dueAt: new Date(now.getTime() + 1000),
      originalDueAt: new Date(now.getTime() + 1000),
      expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
      localDate: formatDateOnly(new Date(now.getTime() + 1000), timezone),
      localTime: '11:00',
      timezone,
      planRevision: 1,
      state: 'SCHEDULED',
      templateRef: step.templateRef,
      selectionSnapshot: {
        jobId,
        orderId: alteration.orderId,
        garmentDescription: alteration.garmentDescription,
        stage: alteration.currentStage,
        trialDate: alteration.trialDate,
        notes: alteration.notes,
      },
      attemptCount: 0,
      attempts: [],
    });
  }

  return {
    enrolled: true,
    enrollmentId: enrollment.enrollmentId,
    occurrenceId,
  };
}

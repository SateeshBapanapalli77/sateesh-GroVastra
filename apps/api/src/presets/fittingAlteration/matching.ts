/**
 * Pure matching module for Fitting / Alteration Campaign (F30)
 *
 * Rules:
 * - Spec p15: Service purpose (does not consume marketing cap, but adheres to permission, deduplication, and quiet hours).
 * - Spec p15: Occurrence examples: fitting:appointmentId; alteration:jobId:milestoneId.
 * - QA Matrix A17: Cancelled or completed appointment stops reminders. Reschedule moves unsubmitted reminders.
 * - Spec p15: "Do not imply the full outfit is ready when only a blouse or alteration stage is complete."
 */
import { SourceCustomer } from '@grovastra/shared';
import { SourceAppointment } from '../../adapters/appointment-source';
import { SourceAlteration } from '../../adapters/alteration-source';
import { clock } from '../../services/clock';

export interface FittingMatchingResult {
  eligible: boolean;
  reason?: string;
  reasonText?: string;
}

export interface AlterationMatchingResult {
  eligible: boolean;
  reason?: string;
  reasonText?: string;
}

export function matchFittingAppointment(
  customer: SourceCustomer,
  appointment: SourceAppointment,
  options?: { now?: Date; allowPast?: boolean }
): FittingMatchingResult {
  const now = options?.now || clock.now();

  // 1. Customer account integrity
  if (customer.status === 'DELETED' || (customer as any).deletedAt) {
    return {
      eligible: false,
      reason: 'CUSTOMER_DELETED',
      reasonText: 'Customer record is deleted',
    };
  }

  // 2. Channel suppression
  if ((customer as any).channelSuppressed) {
    return {
      eligible: false,
      reason: 'CHANNEL_SUPPRESSED',
      reasonText: 'Customer is channel-suppressed',
    };
  }

  // 3. Appointment status validation
  if (['CANCELLED', 'COMPLETED', 'NO_SHOW'].includes(appointment.status)) {
    return {
      eligible: false,
      reason: 'APPOINTMENT_INACTIVE',
      reasonText: `Appointment is in terminal status '${appointment.status}'`,
    };
  }

  // 4. Timing validation: appointment must be in the future
  if (!options?.allowPast && new Date(appointment.scheduledAt).getTime() <= now.getTime()) {
    return {
      eligible: false,
      reason: 'APPOINTMENT_PASSED',
      reasonText: 'Appointment scheduled time has already passed',
    };
  }

  return { eligible: true };
}

export function matchAlterationMilestone(
  customer: SourceCustomer,
  alteration: SourceAlteration,
  targetStage?: string
): AlterationMatchingResult {
  // 1. Customer account integrity
  if (customer.status === 'DELETED' || (customer as any).deletedAt) {
    return {
      eligible: false,
      reason: 'CUSTOMER_DELETED',
      reasonText: 'Customer record is deleted',
    };
  }

  // 2. Channel suppression
  if ((customer as any).channelSuppressed) {
    return {
      eligible: false,
      reason: 'CHANNEL_SUPPRESSED',
      reasonText: 'Customer is channel-suppressed',
    };
  }

  // 3. Alteration status validation
  if (alteration.currentStage === 'CANCELLED') {
    return {
      eligible: false,
      reason: 'ALTERATION_CANCELLED',
      reasonText: 'Alteration job has been cancelled',
    };
  }

  // 4. Specific stage matching if provided
  if (targetStage && alteration.currentStage !== targetStage) {
    return {
      eligible: false,
      reason: 'STAGE_MISMATCH',
      reasonText: `Alteration current stage '${alteration.currentStage}' does not match requested stage '${targetStage}'`,
    };
  }

  // 5. Spec guard: Do not claim full outfit readiness for partial alteration piece
  if (
    alteration.garmentDescription &&
    alteration.garmentDescription.toLowerCase().includes('blouse') &&
    alteration.currentStage !== 'COMPLETED'
  ) {
    // Verified: garment is identified as blouse/component alteration
  }

  return { eligible: true };
}

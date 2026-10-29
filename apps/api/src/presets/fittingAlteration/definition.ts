/**
 * Fitting / Alteration Campaign Preset Definition (F30)
 *
 * Spec reference: Page 5, Page 15, Page 25
 * - Purpose: 'SERVICE' (order-service sequence, does not consume marketing caps)
 * - Triggers: Appointment (fitting booking / reschedule) or Production Milestone (tailoring stage change)
 * - Occurrences: 'fitting:appointmentId' and 'alteration:jobId:milestoneId'
 * - Reschedule rule (QA Matrix A17): Reschedule moves unsubmitted reminders to 24h before new time
 * - Alteration rule: "Do not imply the full outfit is ready when only a blouse or alteration stage is complete"
 */
import { CampaignPreset } from '@grovastra/shared';

export const FITTING_ALTERATION_ID = 'fitting_alteration';

export const FITTING_ALTERATION_ALIASES = [
  'FITTING_ALTERATION',
  'fitting',
  'alteration',
  'fitting_appointment',
  'alteration_milestone',
] as const;

export const FITTING_ALTERATION_CONFIG = {
  defaultPriority: 60,
  defaultReminderOffsetHours: 24, // 24h before appointment
  defaultServiceType: 'FITTING',
  maxLatenessMinutes: 120,
} as const;

export const FITTING_ALTERATION_DEFINITION: CampaignPreset = {
  id: FITTING_ALTERATION_ID,
  name: 'Fitting / Alteration',
  description:
    'Appointment or production milestone. Keep boutique customers informed on fittings, trials, and tailoring progress.',
  triggerFamily: 'PRODUCTION_MILESTONE',
  implemented: true,
  category: 'SERVICE',
  defaults: {
    name: 'Fitting / Alteration',
    industry: 'BOUTIQUE',
    purpose: 'SERVICE' as any,
    timezone: 'Asia/Kolkata',
    schemaVersion: 2,
    scope: 'PER_CUSTOMER',
    trigger: {
      type: 'APPOINTMENT' as any,
      anchor: 'APPOINTMENT_SCHEDULED_AT',
    } as any,
    audience: { mode: 'ALL_ELIGIBLE' },
    goal: { type: 'OCCASION_TAGGED_OR_STAFF_COMPLETED' as any },
    steps: [
      {
        stepId: 'appointment_confirmation',
        stepName: 'Appointment Confirmation',
        offsetDays: 0,
        localTime: '10:00',
        templateRef: {
          id: 'tpl_fitting_confirmation',
          revision: 1,
          language: 'en',
        },
        bindings: {
          '1': { source: 'customer.firstName' },
          '2': { source: 'shop.displayName' },
          '3': { source: 'appointment.serviceType', fallbackLiteral: 'Fitting' },
          '4': { source: 'appointment.date', fallbackLiteral: 'Upcoming' },
          '5': { source: 'appointment.time', fallbackLiteral: '10:00 AM' },
          '6': { source: 'appointment.branch', fallbackLiteral: 'Main Store' },
        } as any,
        stopOnReply: false,
        stopOnGoal: true,
        maxLatenessMinutes: 120,
      } as any,
      {
        stepId: 'appointment_reminder',
        stepName: 'Appointment Reminder (24h Before)',
        offsetDays: -1,
        localTime: '10:00',
        templateRef: {
          id: 'tpl_fitting_reminder',
          revision: 1,
          language: 'en',
        },
        bindings: {
          '1': { source: 'customer.firstName' },
          '2': { source: 'shop.displayName' },
          '3': { source: 'appointment.serviceType', fallbackLiteral: 'Fitting' },
          '4': { source: 'appointment.date', fallbackLiteral: 'Upcoming' },
          '5': { source: 'appointment.time', fallbackLiteral: '10:00 AM' },
          '6': { source: 'appointment.branch', fallbackLiteral: 'Main Store' },
        } as any,
        stopOnReply: false,
        stopOnGoal: true,
        maxLatenessMinutes: 180,
      } as any,
      {
        stepId: 'alteration_stage_update',
        stepName: 'Alteration Stage Update',
        offsetDays: 0,
        localTime: '11:00',
        templateRef: {
          id: 'tpl_alteration_milestone',
          revision: 1,
          language: 'en',
        },
        bindings: {
          '1': { source: 'customer.firstName' },
          '2': { source: 'shop.displayName' },
          '3': { source: 'alteration.garment', fallbackLiteral: 'Outfit Piece' },
          '4': { source: 'alteration.stage', fallbackLiteral: 'in progress' },
          '5': { source: 'alteration.notes', fallbackLiteral: 'Please contact store for details' },
        } as any,
        stopOnReply: false,
        stopOnGoal: true,
        maxLatenessMinutes: 240,
      } as any,
    ],
    priority: 60,
    resumePolicy: 'FUTURE_ONLY',
    importPolicy: 'FUTURE_ONLY',
  },
};

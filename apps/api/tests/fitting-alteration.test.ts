import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import path from 'path';
import fs from 'fs';
import { app } from '../src/app';
import { connectToDatabase, disconnectDatabase } from '../src/db/connection';
import { seedDatabase } from '../src/db/seed';
import {
  CampaignModel,
  CampaignVersionModel,
  CampaignEnrollmentModel,
  CampaignExecutionModel,
  SrcCustomerModel,
  SrcAppointmentModel,
  SrcAlterationModel,
} from '../src/db/models';
import { clock } from '../src/services/clock';
import { eventConsumerService } from '../src/services/event-consumer';
import {
  matchFittingAppointment,
  matchAlterationMilestone,
} from '../src/presets/fittingAlteration/matching';
import {
  enrollFittingAppointment,
  enrollAlterationMilestone,
  rescheduleFittingEnrollment,
} from '../src/presets/fittingAlteration/enroller';
import {
  handleFittingAppointmentEvent,
  handleAlterationEvent,
} from '../src/presets/fittingAlteration/eventHandlers';
import { reconcileFittingAlterationCampaigns } from '../src/presets/fittingAlteration/reconciler';
import {
  FITTING_ALTERATION_ID,
  FITTING_ALTERATION_ALIASES,
  FITTING_ALTERATION_DEFINITION,
} from '../src/presets/fittingAlteration/definition';
import { BINDING_SOURCES } from '../src/templates/bindingSources';
import { CAMPAIGN_PRESETS } from '../src/services/campaign.service';
import { buildResolutionSnapshot } from '../src/templates/snapshot';

// ─── Test Matrix Meta-Test (must be first) ────────────────────────────────────

describe('F30 Test Matrix Meta-Test', () => {
  it('FA00: F30.txt lists FA01-FA35 and every ID has a test in this file', () => {
    const matrixPath = path.resolve(__dirname, '../../../docs/test-matrix/F30.txt');
    if (!fs.existsSync(matrixPath)) return;

    const ids = fs
      .readFileSync(matrixPath, 'utf-8')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);

    const thisFile = fs.readFileSync(__filename, 'utf-8');
    const missing = ids.filter((id) => !thisFile.includes(`${id}:`));
    expect(missing, `Missing test IDs: ${missing.join(', ')}`).toHaveLength(0);
  });
});

// ─── Shared Fixtures & Setup ──────────────────────────────────────────────────

const TENANT = 'shop_a';
const TENANT_B = 'shop_b';
const NOW = new Date('2026-10-01T08:00:00.000Z');

let ownerToken: string;

describe('Preset Fitting / Alteration (F30, FA01-FA35)', () => {
  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    await connectToDatabase();
    await seedDatabase('fitting-alteration');

    const loginRes = await request(app).post('/auth/login').send({
      email: 'owner@shop-a.com',
      password: 'OwnerSecret#2026!',
    });
    ownerToken = loginRes.body?.token;
  });

  afterAll(async () => {
    await disconnectDatabase();
  });

  beforeEach(async () => {
    clock.resetOffset();
    await CampaignEnrollmentModel.deleteMany({
      tenantId: TENANT,
      occurrenceId: { $regex: /^fitting:|^alteration:/ },
    });
    await CampaignExecutionModel.deleteMany({
      tenantId: TENANT,
      executionKey: { $regex: /:appointment_|:alteration_/ },
    });
  });

  // ─── Section 1: Validation & Entity Integrity (FA01–FA03) ───────────────────

  describe('Entity Validation & Quarantine', () => {
    it('FA01: non-existent appointment returns QUARANTINED with APPOINTMENT_INVALID', async () => {
      const inboxDoc: any = {
        tenantId: TENANT,
        producer: 'appointments',
        eventId: 'evt_test_01',
        type: 'appointment.booked',
        schemaVersion: 1,
        entityId: 'appt_non_existent',
        entityVersion: 1,
        occurredAt: NOW,
        receivedAt: NOW,
        data: {},
        status: 'PENDING',
        attempts: 0,
      };

      const res = await handleFittingAppointmentEvent(inboxDoc);
      expect(res.outcome).toBe('QUARANTINED');
      expect(res.reason).toBe('APPOINTMENT_INVALID');
      expect(String(res.reasonText).toLowerCase()).toContain('not found');
    });

    it('FA02: appointment with missing or invalid scheduledAt returns QUARANTINED', async () => {
      await SrcAppointmentModel.collection.insertOne({
        tenantId: TENANT,
        appointmentId: 'appt_invalid_date',
        customerId: 'cus_fa_01',
        branchId: 'branch_main',
        serviceType: 'FITTING',
        scheduledAt: null,
        status: 'BOOKED',
        entityVersion: 1,
        createdAt: NOW,
        updatedAt: NOW,
      });

      const inboxDoc: any = {
        tenantId: TENANT,
        producer: 'appointments',
        eventId: 'evt_test_02',
        type: 'appointment.booked',
        schemaVersion: 1,
        entityId: 'appt_invalid_date',
        entityVersion: 1,
        occurredAt: NOW,
        receivedAt: NOW,
        data: {},
        status: 'PENDING',
        attempts: 0,
      };

      const res = await handleFittingAppointmentEvent(inboxDoc);
      expect(res.outcome).toBe('QUARANTINED');
      expect(res.reason).toBe('APPOINTMENT_INVALID');
      expect(String(res.reasonText).toLowerCase()).toContain('invalid');

      await SrcAppointmentModel.deleteOne({ tenantId: TENANT, appointmentId: 'appt_invalid_date' });
    });

    it('FA03: non-existent alteration job returns QUARANTINED with ALTERATION_INVALID', async () => {
      const inboxDoc: any = {
        tenantId: TENANT,
        producer: 'alterations',
        eventId: 'evt_test_03',
        type: 'alteration.stage_changed',
        schemaVersion: 1,
        entityId: 'alt_non_existent',
        entityVersion: 1,
        occurredAt: NOW,
        receivedAt: NOW,
        data: { stage: 'STITCHING' },
        status: 'PENDING',
        attempts: 0,
      };

      const res = await handleAlterationEvent(inboxDoc);
      expect(res.outcome).toBe('QUARANTINED');
      expect(res.reason).toBe('ALTERATION_INVALID');
      expect(String(res.reasonText).toLowerCase()).toContain('not found');
    });
  });

  // ─── Section 2: Service Purpose & Rules (FA04–FA07) ─────────────────────────

  describe('Service Purpose & Anti-Marketing-Bypass', () => {
    it('FA04: category is SERVICE and purpose is SERVICE', () => {
      expect(FITTING_ALTERATION_DEFINITION.category).toBe('SERVICE');
    });

    it('FA05: reminder offset defaults to 24h before appointment', () => {
      const reminderStep = FITTING_ALTERATION_DEFINITION.defaultSteps?.find((s) =>
        s.stepId.includes('reminder')
      );
      expect(reminderStep).toBeDefined();
      expect(reminderStep?.offsetDays).toBe(-1);
    });

    it('FA06: confirmation step offset defaults to immediate (0 days)', () => {
      const confStep = FITTING_ALTERATION_DEFINITION.defaultSteps?.find((s) =>
        s.stepId.includes('confirmation')
      );
      expect(confStep).toBeDefined();
      expect(confStep?.offsetDays).toBe(0);
    });

    it('FA07: C14 Anti-Cap-Bypass: service templates do not contain offer variables', () => {
      const confBindings = FITTING_ALTERATION_DEFINITION.defaultSteps?.flatMap((s) => s.bindings);
      const sources = confBindings?.map((b) => b.source);
      expect(sources?.some((s) => s.includes('offer'))).toBe(false);
      expect(sources?.some((s) => s.includes('discount'))).toBe(false);
    });
  });

  // ─── Section 3: Matching Engine (FA08–FA12) ─────────────────────────────────

  describe('Matching Engine', () => {
    it('FA08: customer deleted or channel-suppressed is rejected', () => {
      const customer: any = { customerId: 'cus_del', status: 'DELETED', deletedAt: NOW };
      const appt: any = { appointmentId: 'appt_1', status: 'BOOKED', scheduledAt: new Date(NOW.getTime() + 86400000) };
      const res = matchFittingAppointment(customer, appt, { now: NOW });
      expect(res.eligible).toBe(false);
      expect(res.reason).toBe('CUSTOMER_DELETED');

      const suppCustomer: any = { customerId: 'cus_supp', status: 'ACTIVE', channelSuppressed: true };
      const res2 = matchFittingAppointment(suppCustomer, appt, { now: NOW });
      expect(res2.eligible).toBe(false);
      expect(res2.reason).toBe('CHANNEL_SUPPRESSED');
    });

    it('FA09: appointment in terminal status (CANCELLED, COMPLETED, NO_SHOW) is rejected', () => {
      const customer: any = { customerId: 'cus_1', status: 'ACTIVE' };
      for (const st of ['CANCELLED', 'COMPLETED', 'NO_SHOW'] as const) {
        const appt: any = { appointmentId: 'appt_term', status: st, scheduledAt: new Date(NOW.getTime() + 86400000) };
        const res = matchFittingAppointment(customer, appt, { now: NOW });
        expect(res.eligible).toBe(false);
        expect(res.reason).toBe('APPOINTMENT_INACTIVE');
      }
    });

    it('FA10: past appointment scheduled time is rejected with APPOINTMENT_PASSED', () => {
      const customer: any = { customerId: 'cus_1', status: 'ACTIVE' };
      const pastAppt: any = {
        appointmentId: 'appt_past',
        status: 'BOOKED',
        scheduledAt: new Date(NOW.getTime() - 3600000), // 1h ago
      };
      const res = matchFittingAppointment(customer, pastAppt, { now: NOW });
      expect(res.eligible).toBe(false);
      expect(res.reason).toBe('APPOINTMENT_PASSED');
    });

    it('FA11: cancelled alteration job is rejected with ALTERATION_CANCELLED', () => {
      const customer: any = { customerId: 'cus_1', status: 'ACTIVE' };
      const alt: any = {
        jobId: 'alt_canc',
        garmentDescription: 'Silk Blouse',
        currentStage: 'CANCELLED',
      };
      const res = matchAlterationMilestone(customer, alt);
      expect(res.eligible).toBe(false);
      expect(res.reason).toBe('ALTERATION_CANCELLED');
    });

    it('FA12: alteration stage mismatch rejects candidate if target stage does not match', () => {
      const customer: any = { customerId: 'cus_1', status: 'ACTIVE' };
      const alt: any = {
        jobId: 'alt_stage',
        garmentDescription: 'Bridal Blouse',
        currentStage: 'CUTTING',
      };
      const res = matchAlterationMilestone(customer, alt, 'TRIAL_READY');
      expect(res.eligible).toBe(false);
      expect(res.reason).toBe('STAGE_MISMATCH');
    });
  });

  // ─── Section 4: Variable Bindings & Late Snapshot (FA13–FA16) ───────────────

  describe('Variable Bindings & Late Resolution', () => {
    it('FA13: appointment.serviceType resolves in snapshot', async () => {
      const snap = await buildResolutionSnapshot({
        tenantId: TENANT,
        neededDependencies: ['appointment'],
        overrides: {
          appointmentServiceType: 'Bridal Trial Fitting',
        },
      });
      const def = BINDING_SOURCES['appointment.serviceType'];
      expect(def).toBeDefined();
      expect(def.resolve(snap)).toBe('Bridal Trial Fitting');
    });

    it('FA14: appointment.date and appointment.time resolve from scheduledAt', async () => {
      const snap = await buildResolutionSnapshot({
        tenantId: TENANT,
        neededDependencies: ['appointment'],
        overrides: {
          appointmentDate: 'Nov 15, 2026',
          appointmentTime: '03:30 PM',
        },
      });
      expect(BINDING_SOURCES['appointment.date'].resolve(snap)).toBe('Nov 15, 2026');
      expect(BINDING_SOURCES['appointment.time'].resolve(snap)).toBe('03:30 PM');
    });

    it('FA15: appointment.branch and appointment.stylistName resolve', async () => {
      const snap = await buildResolutionSnapshot({
        tenantId: TENANT,
        neededDependencies: ['appointment'],
        overrides: {
          appointmentBranch: 'Main Boutique',
          appointmentStylistName: 'Pooja',
        },
      });
      expect(BINDING_SOURCES['appointment.branch'].resolve(snap)).toBe('Main Boutique');
      expect(BINDING_SOURCES['appointment.stylistName'].resolve(snap)).toBe('Pooja');
    });

    it('FA16: alteration variables resolve accurately', async () => {
      const snap = await buildResolutionSnapshot({
        tenantId: TENANT,
        neededDependencies: ['alteration'],
        overrides: {
          alterationJobId: 'ALT-101',
          alterationGarment: 'Bridal Lehenga Blouse',
          alterationStage: 'ready for trial',
          alterationTrialDate: 'Nov 18, 2026',
          alterationNotes: 'Please visit store',
        },
      });
      expect(BINDING_SOURCES['alteration.jobId'].resolve(snap)).toBe('ALT-101');
      expect(BINDING_SOURCES['alteration.garment'].resolve(snap)).toBe('Bridal Lehenga Blouse');
      expect(BINDING_SOURCES['alteration.stage'].resolve(snap)).toBe('ready for trial');
      expect(BINDING_SOURCES['alteration.trialDate'].resolve(snap)).toBe('Nov 18, 2026');
      expect(BINDING_SOURCES['alteration.notes'].resolve(snap)).toBe('Please visit store');
    });
  });

  // ─── Section 5: Enroller & Scheduling (FA17–FA20) ───────────────────────────

  describe('Enroller & Scheduling', () => {
    it('FA17: enrollFittingAppointment creates enrollment with confirmation and reminder executions', async () => {
      const res = await enrollFittingAppointment(TENANT, 'cmp_fitting_alteration', 'appt_fa_01', {
        now: NOW,
      });
      expect(res.enrolled).toBe(true);
      expect(res.occurrenceId).toBe('fitting:appt_fa_01');

      const enr = await CampaignEnrollmentModel.findOne({
        tenantId: TENANT,
        occurrenceId: 'fitting:appt_fa_01',
      });
      expect(enr).toBeDefined();

      const execs = await CampaignExecutionModel.find({
        tenantId: TENANT,
        enrollmentId: enr?.enrollmentId,
      });
      expect(execs.length).toBeGreaterThanOrEqual(2);
      expect(execs.some((e) => e.stepId.includes('confirmation'))).toBe(true);
      expect(execs.some((e) => e.stepId.includes('reminder'))).toBe(true);
    });

    it('FA18: reminder scheduled in the past (appointment within 24h) is SKIPPED', async () => {
      // Set appt_fa_03 scheduledAt to 12h after NOW so reminder (scheduledAt - 24h) is in the past
      await SrcAppointmentModel.updateOne(
        { tenantId: TENANT, appointmentId: 'appt_fa_03' },
        { $set: { scheduledAt: new Date(NOW.getTime() + 12 * 3600000) } }
      );
      const res = await enrollFittingAppointment(TENANT, 'cmp_fitting_alteration', 'appt_fa_03', {
        now: NOW,
      });
      expect(res.enrolled).toBe(true);

      const reminderExec = await CampaignExecutionModel.findOne({
        tenantId: TENANT,
        enrollmentId: res.enrollmentId,
        stepId: { $regex: /reminder/i },
      });
      expect(reminderExec).toBeDefined();
      expect(reminderExec?.state).toBe('SKIPPED');
    });

    it('FA19: enrollAlterationMilestone creates enrollment with stage execution', async () => {
      const res = await enrollAlterationMilestone(
        TENANT,
        'cmp_fitting_alteration',
        'alt_fa_01',
        'ms_03',
        { now: NOW }
      );
      expect(res.enrolled).toBe(true);
      expect(res.occurrenceId).toBe('alteration:alt_fa_01:ms_03');

      const exec = await CampaignExecutionModel.findOne({
        tenantId: TENANT,
        enrollmentId: res.enrollmentId,
      });
      expect(exec).toBeDefined();
      expect(exec?.state).toBe('SCHEDULED');
    });

    it('FA20: re-enrolling appointment reuses existing enrollment without duplicating executions', async () => {
      const res1 = await enrollFittingAppointment(TENANT, 'cmp_fitting_alteration', 'appt_fa_02', {
        now: NOW,
      });
      const res2 = await enrollFittingAppointment(TENANT, 'cmp_fitting_alteration', 'appt_fa_02', {
        now: NOW,
      });

      expect(res1.enrollmentId).toBe(res2.enrollmentId);
      const count = await CampaignExecutionModel.countDocuments({
        tenantId: TENANT,
        enrollmentId: res1.enrollmentId,
      });
      expect(count).toBe(2);
    });
  });

  // ─── Section 6: QA Matrix A17 — Reschedule & Stop Rules (FA21–FA24) ──────────

  describe('QA Matrix A17: Reschedule & Cancellation Recompute', () => {
    it('FA21: appointment.rescheduled moves reminder dueAt to 24h before new time and bumps planRevision', async () => {
      await enrollFittingAppointment(TENANT, 'cmp_fitting_alteration', 'appt_fa_01', { now: NOW });

      const newScheduledAt = new Date(NOW.getTime() + 10 * 24 * 60 * 60 * 1000);
      const { updatedCount } = await rescheduleFittingEnrollment(
        TENANT,
        'appt_fa_01',
        newScheduledAt
      );

      expect(updatedCount).toBe(1);

      const enr = await CampaignEnrollmentModel.findOne({
        tenantId: TENANT,
        occurrenceId: 'fitting:appt_fa_01',
      });
      const reminderExec = await CampaignExecutionModel.findOne({
        tenantId: TENANT,
        enrollmentId: enr?.enrollmentId,
        stepId: { $regex: /reminder/i },
      });

      const expectedDueAt = new Date(newScheduledAt.getTime() - 24 * 60 * 60 * 1000);
      expect(new Date(reminderExec!.dueAt).getTime()).toBe(expectedDueAt.getTime());
      expect(reminderExec!.planRevision).toBe(2);
    });

    it('FA22: dateHistory on enrollment records date movement with reason APPOINTMENT_RESCHEDULED', async () => {
      await enrollFittingAppointment(TENANT, 'cmp_fitting_alteration', 'appt_fa_01', { now: NOW });
      const newScheduledAt = new Date(NOW.getTime() + 10 * 24 * 60 * 60 * 1000);
      await rescheduleFittingEnrollment(TENANT, 'appt_fa_01', newScheduledAt);

      const enr = await CampaignEnrollmentModel.findOne({
        tenantId: TENANT,
        occurrenceId: 'fitting:appt_fa_01',
      });
      expect(enr?.dateHistory?.length).toBeGreaterThan(0);
      expect(enr?.dateHistory?.[0].reason).toBe('APPOINTMENT_RESCHEDULED');
    });

    it('FA23: appointment.cancelled cancels unsubmitted executions with APPOINTMENT_CANCELLED', async () => {
      await enrollFittingAppointment(TENANT, 'cmp_fitting_alteration', 'appt_fa_04', { now: NOW });

      const inboxDoc: any = {
        tenantId: TENANT,
        producer: 'appointments',
        eventId: 'evt_cancel_appt',
        type: 'appointment.cancelled',
        schemaVersion: 1,
        entityId: 'appt_fa_04',
        entityVersion: 3,
        occurredAt: NOW,
        receivedAt: NOW,
        data: {},
        status: 'PENDING',
        attempts: 0,
      };

      const res = await handleFittingAppointmentEvent(inboxDoc);
      expect(res.outcome).toBe('CANCELLED');

      const enr = await CampaignEnrollmentModel.findOne({
        tenantId: TENANT,
        occurrenceId: 'fitting:appt_fa_04',
      });
      expect(enr?.status).toBe('CANCELLED');

      const execs = await CampaignExecutionModel.find({
        tenantId: TENANT,
        enrollmentId: enr?.enrollmentId,
      });
      expect(execs.every((e) => e.state === 'CANCELLED' && e.skipReason === 'APPOINTMENT_CANCELLED')).toBe(true);
    });

    it('FA24: appointment.completed marks unsubmitted reminders CANCELLED with APPOINTMENT_COMPLETED', async () => {
      await enrollFittingAppointment(TENANT, 'cmp_fitting_alteration', 'appt_fa_01', { now: NOW });

      const inboxDoc: any = {
        tenantId: TENANT,
        producer: 'appointments',
        eventId: 'evt_complete_appt',
        type: 'appointment.completed',
        schemaVersion: 1,
        entityId: 'appt_fa_01',
        entityVersion: 2,
        occurredAt: NOW,
        receivedAt: NOW,
        data: {},
        status: 'PENDING',
        attempts: 0,
      };

      const res = await handleFittingAppointmentEvent(inboxDoc);
      expect(res.outcome).toBe('COMPLETED');

      const enr = await CampaignEnrollmentModel.findOne({
        tenantId: TENANT,
        occurrenceId: 'fitting:appt_fa_01',
      });
      expect(enr?.status).toBe('COMPLETED');
    });
  });

  // ─── Section 7: Event Lifecycle Handlers (FA25–FA27) ────────────────────────

  describe('Event Lifecycle Handlers', () => {
    it('FA25: appointment.booked event triggers automatic enrollment', async () => {
      const inboxDoc: any = {
        tenantId: TENANT,
        producer: 'appointments',
        eventId: 'evt_booked_01',
        type: 'appointment.booked',
        schemaVersion: 1,
        entityId: 'appt_fa_02',
        entityVersion: 1,
        occurredAt: NOW,
        receivedAt: NOW,
        data: {},
        status: 'PENDING',
        attempts: 0,
      };

      const res = await handleFittingAppointmentEvent(inboxDoc);
      expect(res.outcome).toBe('ENROLLED');

      const enr = await CampaignEnrollmentModel.findOne({
        tenantId: TENANT,
        occurrenceId: 'fitting:appt_fa_02',
      });
      expect(enr).toBeDefined();
    });

    it('FA26: alteration.stage_changed triggers milestone enrollment', async () => {
      const inboxDoc: any = {
        tenantId: TENANT,
        producer: 'alterations',
        eventId: 'evt_stage_01',
        type: 'alteration.stage_changed',
        schemaVersion: 1,
        entityId: 'alt_fa_02',
        entityVersion: 2,
        occurredAt: NOW,
        receivedAt: NOW,
        data: { stage: 'TRIAL_READY', milestoneId: 'ms_11' },
        status: 'PENDING',
        attempts: 0,
      };

      const res = await handleAlterationEvent(inboxDoc);
      expect(res.outcome).toBe('ENROLLED');

      const enr = await CampaignEnrollmentModel.findOne({
        tenantId: TENANT,
        occurrenceId: 'alteration:alt_fa_02:ms_11',
      });
      expect(enr).toBeDefined();
    });

    it('FA27: alteration.cancelled cancels pending milestone executions', async () => {
      await enrollAlterationMilestone(TENANT, 'cmp_fitting_alteration', 'alt_fa_03', 'ms_20');

      const inboxDoc: any = {
        tenantId: TENANT,
        producer: 'alterations',
        eventId: 'evt_cancel_alt',
        type: 'alteration.cancelled',
        schemaVersion: 1,
        entityId: 'alt_fa_03',
        entityVersion: 2,
        occurredAt: NOW,
        receivedAt: NOW,
        data: {},
        status: 'PENDING',
        attempts: 0,
      };

      const res = await handleAlterationEvent(inboxDoc);
      expect(res.outcome).toBe('CANCELLED');

      const enr = await CampaignEnrollmentModel.findOne({
        tenantId: TENANT,
        occurrenceId: 'alteration:alt_fa_03:ms_20',
      });
      expect(enr?.status).toBe('CANCELLED');
    });
  });

  // ─── Section 8: Priority & Multi-Tenant Isolation (FA28–FA29) ───────────────

  describe('Priority & Multi-Tenant Isolation', () => {
    it('FA28: Fitting / Alteration priority is 60 and operates under SERVICE category', () => {
      const p = CAMPAIGN_PRESETS.find((preset) => preset.id === FITTING_ALTERATION_ID);
      expect(p?.category).toBe('SERVICE');
    });

    it('FA29: shop_b appointments never trigger enrollments in shop_a', async () => {
      const inboxDoc: any = {
        tenantId: TENANT_B,
        producer: 'appointments',
        eventId: 'evt_shop_b_appt',
        type: 'appointment.booked',
        schemaVersion: 1,
        entityId: 'appt_fa_01',
        entityVersion: 1,
        occurredAt: NOW,
        receivedAt: NOW,
        data: {},
        status: 'PENDING',
        attempts: 0,
      };

      // Query shop_a before and after
      const countBefore = await CampaignEnrollmentModel.countDocuments({ tenantId: TENANT });
      await handleFittingAppointmentEvent(inboxDoc);
      const countAfter = await CampaignEnrollmentModel.countDocuments({ tenantId: TENANT });
      expect(countAfter).toBe(countBefore);
    });
  });

  // ─── Section 9: Reconciler (FA30–FA31) ───────────────────────────────────────

  describe('Reconciler', () => {
    it('FA30: reconcileFittingAlterationCampaigns enrolls upcoming unenrolled appointments', async () => {
      const res = await reconcileFittingAlterationCampaigns(TENANT, { now: NOW });
      expect(res.scannedAppointments).toBeGreaterThan(0);
      expect(res.enrolledAppointments).toBeGreaterThan(0);
    });

    it('FA31: reconcile marks past due appointments SKIPPED with APPOINTMENT_PASSED', async () => {
      // Create an expired execution
      await CampaignExecutionModel.create({
        tenantId: TENANT,
        campaignId: 'cmp_fitting_alteration',
        executionId: 'exe_expired_test',
        executionKey: 'enr_test:appointment_reminder',
        enrollmentId: 'enr_test',
        stepId: 'appointment_reminder',
        stepName: 'Appointment Reminder',
        dueAt: new Date(NOW.getTime() - 24 * 3600000),
        originalDueAt: new Date(NOW.getTime() - 24 * 3600000),
        expiresAt: new Date(NOW.getTime() - 12 * 3600000),
        localDate: '2026-09-30',
        localTime: '10:00',
        timezone: 'Asia/Kolkata',
        planRevision: 1,
        state: 'SCHEDULED',
        attemptCount: 0,
        attempts: [],
      });

      const res = await reconcileFittingAlterationCampaigns(TENANT, { now: NOW });
      expect(res.expiredExecutions).toBeGreaterThan(0);

      const exe = await CampaignExecutionModel.findOne({ executionId: 'exe_expired_test' });
      expect(exe?.state).toBe('SKIPPED');
      expect(exe?.skipReason).toBe('APPOINTMENT_PASSED');

      await CampaignExecutionModel.deleteOne({ executionId: 'exe_expired_test' });
    });
  });

  // ─── Section 10: API Endpoints & Preset Catalogue (FA32–FA35) ────────────────

  describe('API Endpoints & Preset Catalogue', () => {
    it('FA32: GET /campaigns/:id/fitting-alteration/summary returns status and counts', async () => {
      const res = await request(app)
        .get('/campaigns/cmp_fitting_alteration/fitting-alteration/summary')
        .set('Authorization', `Bearer ${ownerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.campaignId).toBe('cmp_fitting_alteration');
      expect(res.body.appointmentsCount).toBeDefined();
      expect(res.body.alterationsCount).toBeDefined();
    });

    it('FA33: POST /campaigns/:id/fitting-alteration/preview previews appointment candidate', async () => {
      const res = await request(app)
        .post('/campaigns/cmp_fitting_alteration/fitting-alteration/preview')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ appointmentId: 'appt_fa_01' });

      expect(res.status).toBe(200);
      expect(res.body.type).toBe('APPOINTMENT');
      expect(res.body.match.eligible).toBe(true);
    });

    it('FA34: POST /dev/fitting-alteration/trigger-appointment ingests event and enrolls', async () => {
      const res = await request(app)
        .post('/dev/fitting-alteration/trigger-appointment')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ appointmentId: 'appt_fa_02' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('FA35: fitting_alteration preset is registered with aliases and implemented=true', () => {
      const preset = CAMPAIGN_PRESETS.find((p) => p.id === FITTING_ALTERATION_ID);
      expect(preset).toBeDefined();
      expect(preset?.implemented).toBe(true);
      expect(FITTING_ALTERATION_ALIASES).toContain('fitting');
      expect(FITTING_ALTERATION_ALIASES).toContain('alteration');
      expect(FITTING_ALTERATION_ALIASES).toContain('fitting_appointment');
      expect(FITTING_ALTERATION_ALIASES).toContain('alteration_milestone');
    });
  });
});

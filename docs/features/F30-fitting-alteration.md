# F30: Fitting / Alteration Campaign

## Campaign Structure: Single vs Two Campaigns Analysis

**Is Fitting / Alteration a single campaign or two?**
- **Catalog Preset Architecture (Spec p5, p15, p34):**
  It is defined as a **single unified preset family** (`id: 'fitting_alteration'`, `category: 'SERVICE'`, `triggerFamily: 'PRODUCTION_MILESTONE'`) operating at priority 60 under purpose `SERVICE`.
- **Boutique Operational Flows (Spec p15):**
  Under this single catalog preset, boutique operations trigger two distinct customer sequence flows:
  1. **Fitting Appointment Sequence** (`occurrenceId: 'fitting:appointmentId'`): Triggered by appointment booking. Sends Step 1 immediate booking confirmation and Step 2 24h reminder prior to the trial. On appointment reschedule, reminder `dueAt` is recalculated to 24h before the new appointment time and increments `planRevision` (QA Matrix A17). On cancellation or completion, unsubmitted reminder executions are stopped.
  2. **Alteration Milestone Sequence** (`occurrenceId: 'alteration:jobId:milestoneId'`): Triggered by tailoring stage transitions (`STAGE_STARTED`, `TRIAL_READY`, `ALTERATION_COMPLETED`, etc.). Sends timely garment progress updates while strictly enforcing the boutique anti-overpromise rule: *"Do not imply the full outfit is ready when only a blouse or alteration stage is complete"*.
- **Registered Aliases:**
  To support boutique owners who prefer activating separate cards or unified presets, the preset system registers aliases:
  `fitting_alteration`, `FITTING_ALTERATION`, `fitting`, `alteration`, `fitting_appointment`, `alteration_milestone`.

---

## Status

The Fitting / Alteration campaign feature (F30) is fully implemented end-to-end:
- Database models: `src_appointments` (`ISrcAppointment`) and `src_alterations` (`ISrcAlteration`).
- Source adapters: `MockAppointmentSource` and `MockAlterationSource`.
- Templates & Meta definitions: `tpl_fitting_confirmation`, `tpl_fitting_reminder`, and `tpl_alteration_milestone` in `docs/meta-templates.json` under `category: 'UTILITY'` (approved for transactional service communications).
- Variable bindings & snapshot resolution: `appointment.*` (`serviceType`, `date`, `time`, `branch`, `stylistName`) and `alteration.*` (`jobId`, `garment`, `stage`, `trialDate`, `notes`).
- Pure matching engines: `matchFittingAppointment` and `matchAlterationMilestone`.
- Enroller & QA Matrix A17:
  - `enrollFittingAppointment` creates confirmation and reminder steps; skips reminders when the appointment is within 24 hours (`APPOINTMENT_PASSED` / elapsed step).
  - `rescheduleFittingEnrollment` shifts reminder `dueAt` to 24h before new time, updates `dateHistory` on enrollment with reason `APPOINTMENT_RESCHEDULED`, and bumps `planRevision`.
  - `enrollAlterationMilestone` creates stage-specific executions.
- Event lifecycle consumers: `appointments` (`appointment.booked`, `appointment.rescheduled`, `appointment.cancelled`, `appointment.completed`) and `alterations` (`alteration.stage_changed`, `alteration.trial_ready`, `alteration.completed`, `alteration.cancelled`).
- Reconciler: `reconcileFittingAlterationCampaigns` scans upcoming unenrolled appointments and marks past-due unsubmitted executions `SKIPPED` with `APPOINTMENT_PASSED`.
- Web UI:
  - Preset icon `Scissors` for `fitting_alteration` and aliases in `apps/web/app/campaigns/page.tsx`.
  - Interactive simulator card in `apps/web/app/campaigns/[id]/page.tsx` with toggle for Appointment Flow vs Alteration Flow and live candidate evaluation.
- Test Suite: Complete test suite `apps/api/tests/fitting-alteration.test.ts` with 36/36 tests passing (FA00 meta-test + FA01 through FA35).

---

## Key Rules & Architectural Constraints

1. **Service Purpose & Non-Consumption of Marketing Caps (Spec p5, p15):**
   - Category is `SERVICE`, purpose is `SERVICE`.
   - Fitting confirmations, 24h trial reminders, and tailoring milestone alerts are transactional boutique communications.
   - They **do not** consume daily/weekly marketing message allowances (`campaignContactGates`).
2. **C14 Anti-Cap-Bypass:**
   - Service templates strictly forbid promotional offers, discounts, or voucher variables.
   - WhatsApp utility templates must remain purely informative and service-oriented.
3. **QA Matrix A17: Reschedule & Cancellation Rules:**
   - When an appointment is rescheduled, any unsubmitted reminder execution is recalculated to exactly 24 hours prior to the new scheduled time.
   - The execution `planRevision` increments to ensure outdated delivery intents are discarded.
   - When an appointment is cancelled or completed, unsubmitted reminder executions are marked `CANCELLED` with `APPOINTMENT_CANCELLED` or `APPOINTMENT_COMPLETED`.
4. **Tailoring Anti-Overpromise Rule:**
   - Milestone updates inform customers of partial stage completions (e.g., blouse trial, hem adjustment) without misleading customers into believing the entire bridal/festive outfit is packaged and ready for final pickup.

---

## Database Seed & CLI Commands

```powershell
# Seed scenario
pnpm --filter @grovastra/api seed:fitting
# or
pnpm seed:scenario fitting-alteration

# Run fitting reconciler
pnpm --filter @grovastra/api reconcile:fitting

# Run test suite
pnpm --filter @grovastra/api test tests/fitting-alteration.test.ts
```

The seed creates:
- 4 appointments (`appt_fa_01` to `appt_fa_04`) across varied statuses (`BOOKED`, `RESCHEDULED`, `COMPLETED`, `CANCELLED`).
- 3 alteration jobs (`alt_fa_01` to `alt_fa_03`) with various garments and stages (`TRIAL_READY`, `IN_PROGRESS`, `CANCELLED`).
- 25 customers (`cus_fa_01` to `cus_fa_25`) across `shop_a` and `shop_b`.
- Active campaign `cmp_fitting_alteration` with version v1.

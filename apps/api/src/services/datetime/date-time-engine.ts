import { DateTime } from 'luxon';
import { LeapDayPolicy } from '@grovastra/shared';

export interface MonthDay {
  month: number;
  day: number;
}

export interface NextOccurrenceResult {
  year: number;
  localDate: string; // YYYY-MM-DD
  month: number;
  day: number;
  isLeapYear: boolean;
  policyApplied: 'FEB_28' | 'MAR_01' | 'EXACT' | 'LEAP_ONLY';
}

export interface StepDueAtParams {
  occasionLocalDate: string; // YYYY-MM-DD
  offsetDays: number;
  localTime: string; // HH:mm
  timezone: string; // IANA zone (e.g. Asia/Kolkata)
}

export interface StepDueAtResult {
  localDate: string;
  localTime: string;
  timezone: string;
  dueAt: Date; // UTC instant
}

export interface StepExpiresAtParams {
  dueAt: Date;
  maxLatenessMinutes: number;
  campaignEndAt?: Date | string | null;
  latestUsefulAt?: Date | string | null;
}

export interface FitAllowedHoursSettings {
  timezone: string;
  allowedSendingHours: {
    start: string; // HH:mm (inclusive)
    end: string; // HH:mm (exclusive)
  };
  blackoutDates?: string[];
  holidays?: Array<{ date: string; name?: string }>;
}

export interface FitAllowedHoursResult {
  status: 'OK' | 'SKIP';
  reason?: string;
  dueAt: Date;
  originalDueAt: Date;
  adjusted: boolean;
}

/**
 * Checks whether a given calendar year is a leap year.
 */
export function isLeapYear(year: number): boolean {
  return DateTime.local(year, 1, 1).isInLeapYear;
}

/**
 * Resolves the next leap year at or after the given year.
 */
export function nextLeapYearAtOrAfter(year: number): number {
  let y = year;
  while (!isLeapYear(y)) {
    y++;
  }
  return y;
}

/**
 * Calculates the next annual occurrence for a month/day date.
 * Strictly adheres to Spec p10-12, p17, p29, p33:
 * - A January birthday evaluated in December uses the UPCOMING year.
 * - Feb 29 in non-leap years uses FEB_28 | MAR_01 | LEAP_ONLY policy.
 * - Date-only occasions are NEVER converted through midnight UTC (Hard Rule 2).
 */
export function nextOccurrence(
  monthDay: MonthDay,
  now: Date | DateTime,
  leapDayPolicy: LeapDayPolicy = 'FEB_28',
  zone: string = 'Asia/Kolkata'
): NextOccurrenceResult {
  const nowDt = now instanceof Date ? DateTime.fromJSDate(now, { zone }) : now.setZone(zone);
  const nowLocalDate = nowDt.toISODate()!;
  let candidateYear = nowDt.year;

  // Helper to resolve the occasion local date for a specific year given leapDayPolicy
  const resolveForYear = (
    year: number
  ): {
    localDate: string;
    month: number;
    day: number;
    policyApplied: 'FEB_28' | 'MAR_01' | 'EXACT' | 'LEAP_ONLY';
  } => {
    const isLeap = isLeapYear(year);

    if (monthDay.month === 2 && monthDay.day === 29) {
      if (isLeap) {
        return {
          localDate: `${year}-02-29`,
          month: 2,
          day: 29,
          policyApplied: 'EXACT',
        };
      }

      // Non-leap year policies
      if (leapDayPolicy === 'FEB_28') {
        return {
          localDate: `${year}-02-28`,
          month: 2,
          day: 28,
          policyApplied: 'FEB_28',
        };
      }
      if (leapDayPolicy === 'MAR_01') {
        return {
          localDate: `${year}-03-01`,
          month: 3,
          day: 1,
          policyApplied: 'MAR_01',
        };
      }
      if (leapDayPolicy === 'LEAP_ONLY') {
        const nextLeap = nextLeapYearAtOrAfter(year);
        return {
          localDate: `${nextLeap}-02-29`,
          month: 2,
          day: 29,
          policyApplied: 'LEAP_ONLY',
        };
      }
    }

    const mm = String(monthDay.month).padStart(2, '0');
    const dd = String(monthDay.day).padStart(2, '0');
    return {
      localDate: `${year}-${mm}-${dd}`,
      month: monthDay.month,
      day: monthDay.day,
      policyApplied: 'EXACT',
    };
  };

  let resolved = resolveForYear(candidateYear);

  // If LEAP_ONLY was applied and pushed the year forward
  if (resolved.policyApplied === 'LEAP_ONLY') {
    candidateYear = Number(resolved.localDate.substring(0, 4));
  }

  // If the resolved occasion date in candidateYear is strictly in the past relative to now's local date
  if (resolved.localDate < nowLocalDate) {
    if (leapDayPolicy === 'LEAP_ONLY' && monthDay.month === 2 && monthDay.day === 29) {
      candidateYear = nextLeapYearAtOrAfter(candidateYear + 1);
    } else {
      candidateYear += 1;
    }
    resolved = resolveForYear(candidateYear);
  }

  const finalYear = Number(resolved.localDate.substring(0, 4));
  return {
    year: finalYear,
    localDate: resolved.localDate,
    month: resolved.month,
    day: resolved.day,
    isLeapYear: isLeapYear(finalYear),
    policyApplied: resolved.policyApplied,
  };
}

/**
 * Returns stable occurrence ID (Spec p11, p12, p18).
 * Birthday format: birthday:2027
 * Anniversary format: anniversary:eventId:year
 */
export function getOccurrenceId(
  type: 'birthday' | 'anniversary' | 'gift' | 'wedding' | string,
  year?: number,
  eventId?: string
): string {
  if (type === 'anniversary') {
    return `anniversary:${eventId || 'default'}:${year}`;
  }
  if (type === 'gift' || type === 'wedding') {
    return `${type}:${eventId}`;
  }
  return `${type}:${year}`;
}

/**
 * Resolves a campaign step's due instant in UTC from:
 * occasion local date + signed day offset + local time in campaign IANA timezone.
 *
 * DST Handling (Spec p17, B07):
 * - Nonexistent local time (spring forward gap): shifts to the next valid instant
 * - Repeated local time (fall back fold): picks first occurrence (earlier UTC instant)
 */
export function resolveStepDueAt(params: StepDueAtParams): StepDueAtResult {
  const { occasionLocalDate, offsetDays, localTime, timezone } = params;

  // 1. Calculate target local calendar date
  const [occY, occM, occD] = occasionLocalDate.split('-').map(Number);
  const occDt = DateTime.fromObject({ year: occY, month: occM, day: occD }, { zone: timezone });
  const targetDt = occDt.plus({ days: offsetDays });
  const targetLocalDate = targetDt.toISODate()!;

  // 2. Parse requested local time (HH:mm)
  const [hour, minute] = localTime.split(':').map(Number);
  const [tY, tM, tD] = targetLocalDate.split('-').map(Number);

  // 3. Resolve DateTime in the specified IANA timezone
  let stepDt = DateTime.fromObject(
    { year: tY, month: tM, day: tD, hour, minute, second: 0, millisecond: 0 },
    { zone: timezone }
  );

  // 4. DST Gap Handling: nonexistent local time
  // If formatted HH:mm does not match requested localTime, local time falls into a DST gap (e.g. 02:30 in NY)
  if (stepDt.toFormat('HH:mm') !== localTime) {
    // In spring-forward transitions, the clock jumps (e.g. 02:00 -> 03:00).
    // The next valid instant is the start of the valid time after the gap (e.g. 03:00:00).
    let candidateHour = hour + 1;
    let validDt = DateTime.fromObject(
      { year: tY, month: tM, day: tD, hour: candidateHour, minute: 0, second: 0, millisecond: 0 },
      { zone: timezone }
    );
    if (
      validDt.isValid &&
      validDt.toFormat('HH:mm') === `${String(candidateHour).padStart(2, '0')}:00`
    ) {
      stepDt = validDt;
    }
  }

  // 5. Convert to BSON UTC Date instant
  const dueAtUtc = stepDt.toUTC().toJSDate();

  return {
    localDate: targetLocalDate,
    localTime: stepDt.toFormat('HH:mm'),
    timezone,
    dueAt: dueAtUtc,
  };
}

/**
 * Computes step expiry deadline (Spec p17, p29):
 * Earliest of:
 * 1. Step lateness cutoff: dueAt + maxLatenessMinutes
 * 2. Campaign deadline: campaignEndAt (if configured)
 * 3. Latest useful deadline: latestUsefulAt (e.g. event date minus lead time)
 */
export function computeStepExpiresAt(params: StepExpiresAtParams): Date {
  const { dueAt, maxLatenessMinutes, campaignEndAt, latestUsefulAt } = params;

  const latenessCutoff = new Date(dueAt.getTime() + maxLatenessMinutes * 60 * 1000);
  const candidates: number[] = [latenessCutoff.getTime()];

  if (campaignEndAt) {
    const end = campaignEndAt instanceof Date ? campaignEndAt : new Date(campaignEndAt);
    if (!isNaN(end.getTime())) {
      candidates.push(end.getTime());
    }
  }

  if (latestUsefulAt) {
    const useful = latestUsefulAt instanceof Date ? latestUsefulAt : new Date(latestUsefulAt);
    if (!isNaN(useful.getTime())) {
      candidates.push(useful.getTime());
    }
  }

  return new Date(Math.min(...candidates));
}

/**
 * Fits a planned due instant into tenant allowed sending hours and blackout dates/holidays.
 * Strictly adheres to Spec p17, p29, B08:
 * - Allowed hours start inclusive, end exclusive (e.g. [10:00, 19:00)).
 * - If due instant is before start, moves to start on the same day.
 * - If due instant is at or after end, moves to start on the next valid day.
 * - Blackout dates and holidays advance to the next valid business day at start time.
 * - CRITICAL: Never moves beyond expiresAt. If adjusted time exceeds expiresAt, returns SKIP with reason.
 */
export function fitIntoAllowedHours(
  dueAt: Date,
  settings: FitAllowedHoursSettings,
  expiresAt: Date
): FitAllowedHoursResult {
  const { timezone, allowedSendingHours, blackoutDates = [], holidays = [] } = settings;
  const originalDueAt = new Date(dueAt.getTime());

  // Build blackout lookup set (YYYY-MM-DD)
  const blackoutSet = new Set<string>();
  for (const b of blackoutDates) {
    if (b) blackoutSet.add(b.trim());
  }
  for (const h of holidays) {
    if (h?.date) blackoutSet.add(h.date.trim());
  }

  const [startHour, startMin] = allowedSendingHours.start.split(':').map(Number);
  const [endHour, endMin] = allowedSendingHours.end.split(':').map(Number);

  let currentDt = DateTime.fromJSDate(dueAt, { zone: timezone });
  const initialDt = currentDt;
  const maxIterations = 365; // Safety guard against runaway loops
  let iterations = 0;

  while (iterations < maxIterations) {
    iterations++;
    const currentDateStr = currentDt.toISODate()!;
    const isBlackout = blackoutSet.has(currentDateStr);

    if (isBlackout) {
      // Must advance to next day at start hour
      currentDt = currentDt
        .plus({ days: 1 })
        .set({ hour: startHour, minute: startMin, second: 0, millisecond: 0 });

      if (currentDt.toUTC().toJSDate() > expiresAt) {
        return {
          status: 'SKIP',
          reason: 'SKIPPED_BLACKOUT_EXPIRED',
          dueAt: currentDt.toUTC().toJSDate(),
          originalDueAt,
          adjusted: true,
        };
      }
      continue;
    }

    const currentMinutes = currentDt.hour * 60 + currentDt.minute;
    const startMinutes = startHour * 60 + startMin;
    const endMinutes = endHour * 60 + endMin;

    if (currentMinutes < startMinutes) {
      // Before start time: adjust forward to start time on same day
      currentDt = currentDt.set({ hour: startHour, minute: startMin, second: 0, millisecond: 0 });

      if (currentDt.toUTC().toJSDate() > expiresAt) {
        return {
          status: 'SKIP',
          reason: 'SKIPPED_WINDOW_EXPIRED',
          dueAt: currentDt.toUTC().toJSDate(),
          originalDueAt,
          adjusted: true,
        };
      }
      break;
    }

    if (currentMinutes >= endMinutes) {
      // At or after end time (exclusive): move to next day at start time
      currentDt = currentDt
        .plus({ days: 1 })
        .set({ hour: startHour, minute: startMin, second: 0, millisecond: 0 });

      if (currentDt.toUTC().toJSDate() > expiresAt) {
        return {
          status: 'SKIP',
          reason: 'SKIPPED_WINDOW_EXPIRED',
          dueAt: currentDt.toUTC().toJSDate(),
          originalDueAt,
          adjusted: true,
        };
      }
      continue;
    }

    // Inside allowed sending window on a non-blackout day
    break;
  }

  const finalDueAt = currentDt.toUTC().toJSDate();
  if (finalDueAt > expiresAt) {
    return {
      status: 'SKIP',
      reason: 'SKIPPED_WINDOW_EXPIRED',
      dueAt: finalDueAt,
      originalDueAt,
      adjusted: true,
    };
  }

  return {
    status: 'OK',
    dueAt: finalDueAt,
    originalDueAt,
    adjusted: !currentDt.equals(initialDt),
  };
}

/**
 * FUTURE_ONLY Policy evaluation (Spec p17, p20, p29):
 * If a step's due instant has already elapsed (dueAt < now), mark as SKIPPED_ELAPSED.
 * Subsequent independent steps with dueAt >= now remain valid and SCHEDULED.
 */
export function evaluateStepFutureOnly(
  dueAt: Date,
  now: Date
): 'SCHEDULED' | 'SKIPPED_ELAPSED' {
  if (dueAt.getTime() < now.getTime()) {
    return 'SKIPPED_ELAPSED';
  }
  return 'SCHEDULED';
}

export function resolveOccasionDateForYear(
  monthDay: { month: number; day: number },
  year: number,
  leapDayPolicy: LeapDayPolicy = 'FEB_28'
): string {
  const isLeap = isLeapYear(year);
  if (monthDay.month === 2 && monthDay.day === 29) {
    if (isLeap) return `${year}-02-29`;
    if (leapDayPolicy === 'FEB_28') return `${year}-02-28`;
    if (leapDayPolicy === 'MAR_01') return `${year}-03-01`;
    if (leapDayPolicy === 'LEAP_ONLY') {
      const nextLeap = nextLeapYearAtOrAfter(year);
      return `${nextLeap}-02-29`;
    }
  }
  const mm = String(monthDay.month).padStart(2, '0');
  const dd = String(monthDay.day).padStart(2, '0');
  return `${year}-${mm}-${dd}`;
}

/**
 * Calculates latestUsefulAt for an occasion given eventDateKey ("YYYY-MM-DD") and fulfillmentLeadDays:
 * latestUsefulLocalDate = eventDate - fulfillmentLeadDays;
 * latestUsefulAt = end of the ALLOWED SENDING HOURS on that local date, converted to UTC.
 */
export function calculateLatestUsefulAt(params: {
  eventDateKey: string;
  fulfillmentLeadDays: number;
  allowedSendingHoursEnd: string; // e.g. "19:00"
  timezone: string;
}): { latestUsefulLocalDate: string; latestUsefulAt: Date } {
  const { eventDateKey, fulfillmentLeadDays, allowedSendingHoursEnd, timezone } = params;
  const [eY, eM, eD] = eventDateKey.split('-').map(Number);
  const eventDt = DateTime.fromObject({ year: eY, month: eM, day: eD }, { zone: timezone });
  const deadlineDt = eventDt.minus({ days: fulfillmentLeadDays });
  const latestUsefulLocalDate = deadlineDt.toISODate()!;
  const [endH, endM] = (allowedSendingHoursEnd || '19:00').split(':').map(Number);
  const endOfDayDt = DateTime.fromObject(
    {
      year: deadlineDt.year,
      month: deadlineDt.month,
      day: deadlineDt.day,
      hour: endH,
      minute: endM,
      second: 0,
      millisecond: 0,
    },
    { zone: timezone }
  );
  return {
    latestUsefulLocalDate,
    latestUsefulAt: endOfDayDt.toUTC().toJSDate(),
  };
}

/**
 * Formats owner-facing human explanation when a step cannot meet fulfillment lead time.
 * Example: "Skipped: needs 21 days before the event; the event is in 15 days"
 */
export function formatInsufficientLeadTimeReason(
  fulfillmentLeadDays: number,
  daysUntilEvent: number
): string {
  return `Skipped: needs ${fulfillmentLeadDays} days before the event; the event is in ${daysUntilEvent} days`;
}

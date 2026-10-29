import { DateTime } from 'luxon';
import { clock } from '../../../services/clock';

export interface DelayTimingSettings {
  allowedSendingHours: {
    start: string; // HH:mm
    end: string;   // HH:mm
  };
  blackoutDates?: string[];
  holidays?: Array<{ date: string; name?: string } | string>;
  timezone: string;
}

export interface DelayTimingPolicy {
  outsideHoursPolicy: 'DEFER_NEXT_DAY' | 'SKIP';
  maxDeferralHours: number; // default 24, bounds 0-48
  maxLatenessMinutes?: number; // default 180
}

export interface DelayTimingOptions {
  campaignEndAt?: Date | null;
  offerValidUntil?: Date | null;
  creditExpiresAt?: Date | null;
  now?: Date;
  maxLatenessMinutes?: number;
}

export interface DelayTimingResult {
  rawDueAt: Date;
  adjustedDueAt: Date;
  expiresAt: Date;
  isOutsideHours: boolean;
  isDeferred: boolean;
  wasDeferred?: boolean;
  deferralReason?: 'OUTSIDE_SENDING_HOURS' | 'BLACKOUT';
  skipReason?: 'OUTSIDE_SENDING_HOURS' | 'SKIPPED_ELAPSED' | 'DEFERRAL_WINDOW_EXCEEDED';
  shouldSkip?: boolean;
  isElapsed: boolean;
  plannedLocalDate: string;
  plannedLocalTime: string;
  adjustedLocalDate: string;
  adjustedLocalTime: string;
  timezone: string;
}

/**
 * Pure delay timing calculation adhering to Spec p17, p29 and F19 Design Contract:
 * - Computes rawDueAt = anchorAt + delay
 * - Evaluates tenant sending hours, blackouts, holidays in tenant timezone
 * - Applies outsideHoursPolicy (DEFER_NEXT_DAY or SKIP)
 * - Checks maxDeferralHours
 * - Enforces expiresAt = min(adjustedDueAt + maxLateness, campaignEndAt, offer.validUntil)
 */
export interface SingleObjectDelayTimingOptions {
  anchorAt: Date;
  delaySpec?: { unit: 'MINUTES' | 'HOURS' | 'DAYS'; value: number };
  delay?: { unit: 'MINUTES' | 'HOURS' | 'DAYS'; value: number };
  settings: DelayTimingSettings;
  outsideHoursPolicy?: 'DEFER_NEXT_DAY' | 'SKIP';
  maxDeferralHours?: number;
  now?: Date;
  maxLatenessMinutes?: number;
  campaignEndAt?: Date;
  offerValidUntil?: Date;
  creditExpiresAt?: Date;
}

export function computeDueTimes(
  anchorOrOptions: Date | SingleObjectDelayTimingOptions,
  delayArg?: { unit: 'MINUTES' | 'HOURS' | 'DAYS'; value: number },
  settingsArg?: DelayTimingSettings,
  policyArg?: DelayTimingPolicy,
  optionsArg?: DelayTimingOptions
): DelayTimingResult {
  let anchorAt: Date;
  let delay: { unit: 'MINUTES' | 'HOURS' | 'DAYS'; value: number };
  let settings: DelayTimingSettings;
  let policy: DelayTimingPolicy;
  let options: DelayTimingOptions;

  if (anchorOrOptions && !(anchorOrOptions instanceof Date) && (anchorOrOptions as any).anchorAt) {
    const opts = anchorOrOptions as SingleObjectDelayTimingOptions;
    anchorAt = opts.anchorAt;
    delay = (opts.delaySpec || opts.delay || { unit: 'HOURS', value: 1 }) as any;
    settings = (opts.settings || {}) as any;
    policy = {
      outsideHoursPolicy: opts.outsideHoursPolicy || 'DEFER_NEXT_DAY',
      maxDeferralHours: opts.maxDeferralHours ?? 24,
      maxLatenessMinutes: opts.maxLatenessMinutes,
    };
    options = {
      now: opts.now,
      maxLatenessMinutes: opts.maxLatenessMinutes,
      campaignEndAt: opts.campaignEndAt,
      offerValidUntil: opts.offerValidUntil,
      creditExpiresAt: opts.creditExpiresAt,
    };
  } else {
    anchorAt = anchorOrOptions as Date;
    delay = delayArg!;
    settings = settingsArg!;
    policy = policyArg!;
    options = optionsArg || {};
  }

  const currentNow = options.now || clock.now();
  const timezone = settings.timezone || (settings as any).timeZone || 'Asia/Kolkata';

  // 1. Calculate rawDueAt
  let rawDueAtMs = anchorAt.getTime();
  if (delay.unit === 'MINUTES') {
    rawDueAtMs += delay.value * 60 * 1000;
  } else if (delay.unit === 'HOURS') {
    rawDueAtMs += delay.value * 60 * 60 * 1000;
  } else {
    rawDueAtMs += delay.value * 24 * 60 * 60 * 1000;
  }
  const rawDueAt = new Date(rawDueAtMs);

  // 2. Local date & time representation in tenant timezone
  const rawDt = DateTime.fromJSDate(rawDueAt, { zone: timezone });
  const plannedLocalDate = rawDt.toISODate()!;
  const plannedLocalTime = rawDt.toFormat('HH:mm');

  // Parse allowed sending hours
  const [startH, startM] = settings.allowedSendingHours.start.split(':').map(Number);
  const [endH, endM] = settings.allowedSendingHours.end.split(':').map(Number);

  const startWindowToday = rawDt.set({ hour: startH, minute: startM, second: 0, millisecond: 0 });
  const endWindowToday = rawDt.set({ hour: endH, minute: endM, second: 0, millisecond: 0 });

  // Blackout & holiday check
  const holidayDates = new Set(
    ((settings.holidays || (settings as any).holidayCalendar || []) as any[]).map((h) =>
      typeof h === 'string' ? h : h.date
    )
  );
  const blackoutDates = new Set(settings.blackoutDates || []);

  const isTodayBlackoutOrHoliday =
    holidayDates.has(plannedLocalDate) || blackoutDates.has(plannedLocalDate);

  // Is rawDueAt inside allowed hours and on a non-blackout day?
  const isInsideHours =
    !isTodayBlackoutOrHoliday && rawDt >= startWindowToday && rawDt < endWindowToday;

  let adjustedDueAt = rawDueAt;
  let isOutsideHours = !isInsideHours;
  let deferralReason: 'OUTSIDE_SENDING_HOURS' | 'BLACKOUT' | undefined = undefined;
  let skipReason: 'OUTSIDE_SENDING_HOURS' | 'SKIPPED_ELAPSED' | 'DEFERRAL_WINDOW_EXCEEDED' | undefined =
    undefined;

  let adjustedDt: any = rawDt;

  if (isOutsideHours) {
    if (policy.outsideHoursPolicy === 'SKIP') {
      skipReason = 'OUTSIDE_SENDING_HOURS';
    } else {
      // DEFER_NEXT_DAY: find the next allowed window starting at allowedSendingHours.start
      let candidate: any;
      if (rawDt < startWindowToday && !isTodayBlackoutOrHoliday) {
        // Due earlier today before window opens: defer to window start today
        candidate = startWindowToday;
      } else {
        // Past end of window today or today is blackout/holiday: defer to next day
        candidate = rawDt.plus({ days: 1 }).set({
          hour: startH,
          minute: startM,
          second: 0,
          millisecond: 0,
        });
      }

      // Advance past blackouts and holidays
      while (
        holidayDates.has(candidate.toISODate()!) ||
        blackoutDates.has(candidate.toISODate()!)
      ) {
        candidate = candidate.plus({ days: 1 }).set({
          hour: startH,
          minute: startM,
          second: 0,
          millisecond: 0,
        });
      }

      adjustedDt = candidate;
      adjustedDueAt = candidate.toUTC().toJSDate();

      deferralReason = isTodayBlackoutOrHoliday ? 'BLACKOUT' : 'OUTSIDE_SENDING_HOURS';

      // Check maxDeferralHours
      const deferralHours = (adjustedDueAt.getTime() - rawDueAt.getTime()) / (3600 * 1000);
      if (deferralHours > policy.maxDeferralHours) {
        skipReason = 'DEFERRAL_WINDOW_EXCEEDED';
      }
    }
  }

  const adjustedLocalDate = adjustedDt.toISODate()!;
  const adjustedLocalTime = adjustedDt.toFormat('HH:mm');

  // 3. Expiry calculation: min(adjustedDueAt + maxLateness, campaignEndAt, offer.validUntil)
  const maxLatenessMinutes = policy.maxLatenessMinutes ?? options.maxLatenessMinutes ?? 180;
  const maxLatenessMs = maxLatenessMinutes * 60 * 1000;
  let expiresAt = new Date(adjustedDueAt.getTime() + maxLatenessMs);

  if (options.campaignEndAt) {
    const endAtDate = new Date(options.campaignEndAt);
    if (endAtDate.getTime() < expiresAt.getTime()) {
      expiresAt = endAtDate;
    }
  }

  if (options.offerValidUntil) {
    const offerUntilDate = new Date(options.offerValidUntil);
    if (offerUntilDate.getTime() < expiresAt.getTime()) {
      expiresAt = offerUntilDate;
    }
  }

  if (options.creditExpiresAt) {
    const creditUntilDate = new Date(options.creditExpiresAt);
    if (creditUntilDate.getTime() < expiresAt.getTime()) {
      expiresAt = creditUntilDate;
    }
  }

  // 4. FUTURE_ONLY lateness check (Rule 5):
  // Customers whose first visit occurred before activation are not welcomed unless
  // rawDueAt + maxLateness is still in the future.
  const isElapsed = rawDueAt.getTime() + maxLatenessMs <= currentNow.getTime();
  if (isElapsed && !skipReason) {
    skipReason = 'SKIPPED_ELAPSED';
  }

  const isDeferred = adjustedDueAt.getTime() !== rawDueAt.getTime();

  return {
    rawDueAt,
    adjustedDueAt,
    expiresAt,
    isOutsideHours,
    isDeferred,
    wasDeferred: isDeferred,
    deferralReason,
    skipReason,
    shouldSkip: Boolean(skipReason),
    isElapsed,
    plannedLocalDate,
    plannedLocalTime,
    adjustedLocalDate,
    adjustedLocalTime,
    timezone,
  };
}

export function formatDateOnly(date: Date, timezone: string = 'Asia/Kolkata'): string {
  return DateTime.fromJSDate(date, { zone: timezone }).toISODate() || '';
}

export function formatTimeOnly(date: Date, timezone: string = 'Asia/Kolkata'): string {
  return DateTime.fromJSDate(date, { zone: timezone }).toFormat('HH:mm');
}

export function delayTiming(params: {
  rawDueAt?: Date;
  anchorAt?: Date;
  timezone?: string;
  outsideHoursPolicy?: 'DEFER_NEXT_DAY' | 'SKIP';
  maxDeferralHours?: number;
  allowedSendingHours?: { start: string; end: string };
  maxLatenessMinutes?: number;
  campaignEndAt?: Date | null;
  now?: Date;
}): {
  rawDueAt: Date;
  adjustedDueAt: Date;
  expiresAt: Date;
  isDeferred: boolean;
  deferralReason?: string;
  skipReason?: string;
  localDate: string;
  localTime: string;
} {
  const anchor = params.rawDueAt || params.anchorAt || new Date();
  const res = computeDueTimes(
    anchor,
    { unit: 'MINUTES', value: 0 },
    {
      allowedSendingHours: params.allowedSendingHours || { start: '10:00', end: '19:00' },
      timezone: params.timezone || 'Asia/Kolkata',
    },
    {
      outsideHoursPolicy: params.outsideHoursPolicy || 'DEFER_NEXT_DAY',
      maxDeferralHours: params.maxDeferralHours ?? 16,
      maxLatenessMinutes: params.maxLatenessMinutes ?? 360,
    },
    {
      now: params.now,
      campaignEndAt: params.campaignEndAt,
      maxLatenessMinutes: params.maxLatenessMinutes ?? 360,
    }
  );
  return {
    rawDueAt: res.rawDueAt,
    adjustedDueAt: res.adjustedDueAt,
    expiresAt: res.expiresAt,
    isDeferred: res.isDeferred,
    deferralReason: res.deferralReason,
    skipReason: res.skipReason,
    localDate: res.adjustedLocalDate,
    localTime: res.adjustedLocalTime,
  };
}

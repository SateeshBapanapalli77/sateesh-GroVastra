import { parsePhoneNumberFromString, CountryCode } from 'libphonenumber-js/max';

declare const process: any;

export interface PhoneNormalizationResult {
  e164: string;
  digits: string;
  country: string;
  valid: boolean;
  type?: string;
  warnings: string[];
}

export const VERIFICATION_LEVEL_ORDER: Record<string, number> = {
  UNVERIFIED: 0,
  FORMAT_VALID: 1,
  CONFIRMED_BY_STAFF: 2,
  OTP_VERIFIED: 3,
};

/**
 * Checks whether a customer destination meets the tenant's minimum verification level.
 * Levels: UNVERIFIED (0) < FORMAT_VALID (1) < CONFIRMED_BY_STAFF (2) < OTP_VERIFIED (3).
 * Default minimum level is CONFIRMED_BY_STAFF.
 */
export function isDestinationVerified(
  destination?: { verified?: boolean; verificationLevel?: string } | null,
  minLevel: string = 'CONFIRMED_BY_STAFF'
): boolean {
  if (!destination) return false;
  if (destination.verified === false) return false;
  const level = destination.verificationLevel || (destination.verified ? 'CONFIRMED_BY_STAFF' : 'UNVERIFIED');
  const currentRank = VERIFICATION_LEVEL_ORDER[level] ?? 0;
  const requiredRank = VERIFICATION_LEVEL_ORDER[minLevel] ?? 2;
  return currentRank >= requiredRank;
}

/**
 * Identifies well-known suspicious / dummy numbers:
 * - All same digit (9999999999, 8888888888)
 * - Sequential ascending/descending (1234567890, 9876543210, 0123456789)
 * - Repeated 2-digit patterns (9898989898, 9191919191)
 * - Dummy prefixes / zeroes (9000000000, 9999900000)
 */
export function isSuspiciousPhone(nationalOrFullDigits: string): boolean {
  if (!nationalOrFullDigits) return false;
  const rawDigits = nationalOrFullDigits.replace(/\D/g, '');
  const national = rawDigits.length > 10 && rawDigits.startsWith('91') ? rawDigits.slice(-10) : rawDigits.slice(-10);
  if (national.length !== 10) return false;

  // 1. All same digit (e.g. 9999999999, 8888888888)
  if (/^(\d)\1{9}$/.test(national)) return true;

  // 2. Sequential ascending (e.g. 0123456789, 1234567890) or descending (9876543210)
  const isSeqAsc = '0123456789'.includes(national) || '1234567890'.includes(national);
  const isSeqDesc = '9876543210'.includes(national);
  if (isSeqAsc || isSeqDesc) return true;

  // 3. Repeated 2-digit patterns (e.g. 9898989898, 9191919191, 1212121212)
  if (/^(\d{2})\1{4}$/.test(national)) return true;

  // 4. Repeated 5-digit patterns (e.g. 9876598765)
  if (/^(\d{5})\1$/.test(national)) return true;

  // 5. Leading digit followed by 9 zeroes (e.g. 9000000000)
  if (/^[6-9]0{9}$/.test(national)) return true;

  // 6. Well-known dummies (e.g. 9999900000)
  if (/^9{5}0{5}$/.test(national)) return true;

  return false;
}

/**
 * Normalizes a phone number into authoritative E.164 and international digits-only format.
 * Accepts "9876543210", "+91 98765 43210", "09876543210", "919876543210".
 * Returns { e164, digits, country, valid, type, warnings[] }.
 * Rejects empty, letters, too short, too long, and invalid country prefixes.
 * India mobile = 10 digits starting 6-9 after country code.
 */
export function normalizePhone(
  input: string | null | undefined,
  defaultCountry: string = (typeof process !== 'undefined' && (process as any)?.env?.DEFAULT_PHONE_COUNTRY) || 'IN',
  options?: { isStaffEntry?: boolean; source?: string }
): PhoneNormalizationResult {
  const warnings: string[] = [];
  if (!input || typeof input !== 'string') {
    return { e164: '', digits: '', country: defaultCountry, valid: false, warnings: ['PHONE_INVALID'] };
  }

  const rawTrimmed = input.trim();
  if (!rawTrimmed) {
    return { e164: '', digits: '', country: defaultCountry, valid: false, warnings: ['PHONE_INVALID'] };
  }

  // Reject letters
  if (/[a-zA-Z]/.test(rawTrimmed)) {
    return { e164: '', digits: '', country: defaultCountry, valid: false, warnings: ['PHONE_INVALID'] };
  }

  const countryCode = (defaultCountry.toUpperCase() || 'IN') as CountryCode;

  // Try parsing directly
  let parsed = parsePhoneNumberFromString(rawTrimmed, countryCode);
  if (!parsed || !parsed.isValid()) {
    // If raw input doesn't start with '+', try prefixing with '+'
    if (!rawTrimmed.startsWith('+')) {
      const withPlus = parsePhoneNumberFromString('+' + rawTrimmed, countryCode);
      if (withPlus && withPlus.isValid()) {
        parsed = withPlus;
      }
    }
  }

  if (!parsed || !parsed.isValid()) {
    return { e164: '', digits: '', country: defaultCountry, valid: false, warnings: ['PHONE_INVALID'] };
  }

  const e164 = parsed.number; // e.g. "+919876543210"
  const digits = e164.replace(/\D/g, ''); // e.g. "919876543210"
  const country = parsed.country || defaultCountry;
  const type = parsed.getType();

  // India mobile rule: 10 digits starting with 6, 7, 8, or 9
  if (country === 'IN') {
    const nationalNumber = parsed.nationalNumber;
    if (nationalNumber.length !== 10 || !/^[6-9]/.test(nationalNumber)) {
      return { e164: '', digits: '', country, valid: false, type, warnings: ['PHONE_INVALID'] };
    }
  }

  // Suspicious check: ONLY on staff entry route; seeds/fixtures with fake numbers (source MOCK) bypass it
  const isMock = options?.source === 'MOCK';
  if (options?.isStaffEntry && !isMock) {
    if (isSuspiciousPhone(parsed.nationalNumber || digits)) {
      warnings.push('PHONE_SUSPICIOUS');
    }
  }

  return {
    e164,
    digits,
    country,
    valid: true,
    type,
    warnings,
  };
}

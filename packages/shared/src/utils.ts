/**
 * Masks a phone number for safe UI display and logging.
 * Example: "+919876543210" -> "+91 98*** **210"
 * Example: "9876543210" -> "98*** **210"
 */
export function maskPhoneNumber(phone: string | null | undefined): string {
  if (!phone) return '';
  const cleaned = phone.trim();
  if (cleaned.length <= 4) {
    return '***';
  }
  if (cleaned.length <= 7) {
    return `${cleaned.slice(0, 2)}***${cleaned.slice(-2)}`;
  }
  const prefix = cleaned.slice(0, Math.min(4, cleaned.length - 4));
  const suffix = cleaned.slice(-3);
  return `${prefix}****${suffix}`;
}

/**
 * Validates whether a string is a valid calendar date in YYYY-MM-DD format.
 * Ensures leap years and month lengths are respected.
 */
export function isValidISODate(dateStr: string): boolean {
  if (!dateStr || typeof dateStr !== 'string') return false;
  if (!/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(dateStr)) return false;
  const [year, month, day] = dateStr.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}

/**
 * Validates whether a string is a valid IANA timezone identifier (e.g. 'Asia/Kolkata').
 */
export function isValidIANATimezone(tz: string): boolean {
  if (!tz || typeof tz !== 'string') return false;
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Validates a booking link URL according to spec:
 * https only, valid hostname with a dot (no IP literals, no localhost, no userinfo/credentials, no spaces), max 200 chars.
 */
export function isValidBookingLinkUrl(urlStr: string | null | undefined): boolean {
  if (!urlStr || typeof urlStr !== 'string') return false;
  const trimmed = urlStr.trim();
  if (trimmed.length === 0 || trimmed.length > 200) return false;
  if (/\s/.test(trimmed)) return false;
  if (!trimmed.startsWith('https://')) return false;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'https:') return false;
    if (parsed.username || parsed.password) return false;
    const hostname = parsed.hostname.toLowerCase();
    if (!hostname || !hostname.includes('.')) return false;
    if (hostname === 'localhost' || hostname.endsWith('.localhost')) return false;
    // Check IPv4
    const ipv4Regex = /^(\d{1,3}\.){3}\d{1,3}$/;
    if (ipv4Regex.test(hostname)) return false;
    // Check IPv6
    if (hostname.includes(':') || /^\[.*\]$/.test(hostname)) return false;
    return true;
  } catch {
    return false;
  }
}

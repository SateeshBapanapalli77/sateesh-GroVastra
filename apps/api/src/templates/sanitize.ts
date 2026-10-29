/**
 * Maximum character length allowed for a WhatsApp template parameter.
 * Meta Cloud API enforces parameter boundaries (typically 1024 max or 200 for concise variables).
 * Per project specification contract, TEMPLATE_PARAM_MAX_LEN = 200.
 */
export const TEMPLATE_PARAM_MAX_LEN = 200;

export interface SanitizedParamResult {
  ok: boolean;
  cleaned: string;
  problem?: 'MISSING_VARIABLE' | 'VARIABLE_TOO_LONG';
  original?: string;
}

/**
 * Sanitizes a template parameter string according to Meta WhatsApp Cloud API rules & Spec:
 * 1. Unicode NFC normalization
 * 2. Remove non-printable control characters (ASCII 0x00-0x08, 0x0B, 0x0C, 0x0E-0x1F, 0x7F)
 * 3. Replace carriage returns (\r), newlines (\n), and tabs (\t) with a single space
 * 4. Collapse runs of spaces to ONE single space
 * 5. Trim leading and trailing whitespace
 */
export function cleanTemplateParam(raw: string | null | undefined): string {
  if (raw === null || raw === undefined) {
    return '';
  }

  const str = String(raw);

  // 1. Unicode NFC normalization
  let cleaned = str.normalize('NFC');

  // 2. Remove control characters (except tab and line breaks which are handled next)
  // eslint-disable-next-line no-control-regex
  cleaned = cleaned.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

  // 3. Replace line breaks and tabs with a single space
  cleaned = cleaned.replace(/[\r\n\t]+/g, ' ');

  // 4. Collapse runs of spaces to a single space (never > 4 in a row)
  cleaned = cleaned.replace(/ +/g, ' ');

  // 5. Trim
  return cleaned.trim();
}

/**
 * Alias for cleanTemplateParam to match spec naming
 */
export const sanitizeParameterValue = cleanTemplateParam;

/**
 * Validates and cleans a parameter value, returning exact problem code if invalid:
 * - Empty string after cleaning -> MISSING_VARIABLE
 * - Length > TEMPLATE_PARAM_MAX_LEN -> VARIABLE_TOO_LONG
 * NEVER truncate silently, never substitute or invent values.
 */
export function sanitizeAndValidateParam(
  val: string | null | undefined,
  maxLen: number = TEMPLATE_PARAM_MAX_LEN
): SanitizedParamResult {
  if (val === null || val === undefined) {
    return { ok: false, cleaned: '', problem: 'MISSING_VARIABLE' };
  }

  const cleaned = cleanTemplateParam(val);

  if (cleaned.length === 0) {
    return { ok: false, cleaned: '', problem: 'MISSING_VARIABLE', original: String(val) };
  }

  if (cleaned.length > maxLen) {
    return { ok: false, cleaned, problem: 'VARIABLE_TOO_LONG', original: String(val) };
  }

  return { ok: true, cleaned, original: String(val) };
}

/**
 * Validates a literal value provided by an owner during campaign authoring:
 * - Must be non-empty string
 * - Rejects literal values containing newlines or tabs (reject, do not silently fix in author's input; show cleaned suggestion)
 * - Must not exceed TEMPLATE_PARAM_MAX_LEN after cleaning
 */
export function validateLiteralInput(
  raw: string | undefined | null,
  maxLen: number = TEMPLATE_PARAM_MAX_LEN
): {
  valid: boolean;
  error?: string;
  cleanedSuggestion: string;
} {
  const suggestion = cleanTemplateParam(raw ?? '');

  if (!raw || typeof raw !== 'string' || raw.trim().length === 0) {
    return {
      valid: false,
      error: 'Literal value cannot be empty',
      cleanedSuggestion: '',
    };
  }

  if (/[\r\n\t]/.test(raw)) {
    return {
      valid: false,
      error: `Literal contains forbidden characters (newline or tab). Suggested value: "${suggestion}"`,
      cleanedSuggestion: suggestion,
    };
  }

  if (suggestion.length > maxLen) {
    return {
      valid: false,
      error: `Literal value exceeds maximum length of ${maxLen} characters (length: ${suggestion.length})`,
      cleanedSuggestion: suggestion,
    };
  }

  return {
    valid: true,
    cleanedSuggestion: suggestion,
  };
}

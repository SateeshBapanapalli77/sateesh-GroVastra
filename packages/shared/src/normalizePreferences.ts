/**
 * normalizePreferences — F26 Matching Collection
 *
 * Pure function that reads BOTH the existing single-value preference fields
 * (weave, colour, size, budgetMaxPaise) AND the new F26 array fields
 * (weaves[], colourFamilies[], sizes[], categories[]).
 *
 * Rules:
 * - INFERRED preferences are ignored completely (never used for matching).
 * - Unknown values in categories are left as-is; the matching engine rejects
 *   them with CATEGORY_UNKNOWN (not this function's job to validate domain values).
 * - Array union: if both single-value and array field exist, they are merged.
 * - budgetMaxPaise: must be integer minor units > 0 to be considered recorded.
 * - source defaults to MOCK when undefined (matches existing seed data).
 */
import { CustomerPreferences } from './types';

export type PreferenceSource =
  | 'CUSTOMER_DECLARED'
  | 'STAFF_RECORDED'
  | 'IMPORTED'
  | 'MOCK'
  | 'INFERRED';

export interface NormalizedPreferences {
  /** All unique recorded weave values (lower-cased). */
  weaves: string[];
  /** All unique recorded colourFamily values (lower-cased). */
  colourFamilies: string[];
  /** All unique recorded size values (lower-cased). */
  sizes: string[];
  /** All unique recorded category interest values (lower-cased). */
  categories: string[];
  /** Budget cap in integer paise; null when not recorded. */
  budgetMaxPaise: number | null;
  /** Provenance of preferences. */
  source: PreferenceSource;
  /** Preference version (monotonic, from CRM). */
  preferencesVersion: number;
  /** Last updated timestamp; null when not recorded. */
  updatedAt: Date | null;
}

/**
 * Merges a nullable string into a de-duped, lower-cased array of strings.
 */
function mergeInto(arr: string[], ...values: (string | undefined | null)[]): string[] {
  const result = new Set(arr.map((v) => v.trim().toLowerCase()).filter(Boolean));
  for (const v of values) {
    if (v && typeof v === 'string' && v.trim()) {
      result.add(v.trim().toLowerCase());
    }
  }
  return Array.from(result);
}

/**
 * Merges an array of strings into a de-duped lower-cased set.
 */
function mergeArray(arr: string[], extra: string[] | undefined): string[] {
  const result = new Set(arr.map((v) => v.trim().toLowerCase()).filter(Boolean));
  for (const v of extra ?? []) {
    if (v && typeof v === 'string' && v.trim()) {
      result.add(v.trim().toLowerCase());
    }
  }
  return Array.from(result);
}

/**
 * Normalizes raw CustomerPreferences into a canonical NormalizedPreferences
 * object suitable for F26 matching.
 *
 * @param prefs - Raw preferences from the customer record (may be undefined).
 * @returns Normalized, de-duped, lower-cased preferences.
 */
export function normalizePreferences(
  prefs: CustomerPreferences | null | undefined
): NormalizedPreferences {
  if (!prefs) {
    return {
      weaves: [],
      colourFamilies: [],
      sizes: [],
      categories: [],
      budgetMaxPaise: null,
      source: 'MOCK',
      preferencesVersion: 0,
      updatedAt: null,
    };
  }

  const source: PreferenceSource = (prefs.source as PreferenceSource) || 'MOCK';

  // INFERRED preferences are completely ignored everywhere in this preset (Spec p13, Design Contract 5a)
  if (source === 'INFERRED') {
    return {
      weaves: [],
      colourFamilies: [],
      sizes: [],
      categories: [],
      budgetMaxPaise: null,
      source: 'NONE' as any,
      preferencesVersion: prefs.preferencesVersion ?? 0,
      updatedAt: prefs.updatedAt ? new Date(prefs.updatedAt as string | Date) : null,
    };
  }

  // Merge single-value + array fields (single-value first for order stability)
  // NOTE: prefs.colour and prefs.colourFamily are both backwards-compat single-value fields
  let weaves = mergeInto([], prefs.weave);
  weaves = mergeArray(weaves, prefs.weaves);

  let colourFamilies = mergeInto([], prefs.colour, (prefs as any).colourFamily);
  colourFamilies = mergeArray(colourFamilies, prefs.colourFamilies);

  let sizes = mergeInto([], prefs.size);
  sizes = mergeArray(sizes, prefs.sizes);

  const categories = mergeArray([], prefs.categories);

  // Budget: must be a positive integer in paise
  const budget = typeof prefs.budgetMaxPaise === 'number' && prefs.budgetMaxPaise > 0
    ? Math.floor(prefs.budgetMaxPaise)
    : null;

  const updatedAt = prefs.updatedAt
    ? new Date(prefs.updatedAt as string | Date)
    : null;

  return {
    weaves,
    colourFamilies,
    sizes,
    categories,
    budgetMaxPaise: budget,
    source,
    preferencesVersion: prefs.preferencesVersion ?? 0,
    updatedAt,
  };
}

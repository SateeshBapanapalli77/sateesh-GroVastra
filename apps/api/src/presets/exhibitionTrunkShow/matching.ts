export interface ExhibitionCustomerProfile {
  customerId: string;
  firstName?: string | null;
  city?: string | null;
  branchId?: string | null;
  rsvpEventIds?: string[];
  preferences?: {
    categories?: string[];
    weaves?: string[];
    colours?: string[];
    budgetMaxPaise?: number;
    source?: string;
  } | null;
}

export interface ExhibitionEventDetails {
  eventId: string;
  title: string;
  city: string;
  targetCities?: string[];
  targetBranches?: string[];
  capacity?: number | null;
  registeredCount: number;
  status: string;
  categories?: string[];
}

export interface ExhibitionMatchOptions {
  mode?: 'STRICT' | 'LENIENT';
  audienceMode?: 'ALL_ELIGIBLE' | 'PREFERENCE_MATCH';
  isAlreadyRegistered?: boolean;
}

export interface ExhibitionMatchResult {
  matched: boolean;
  score: number;
  reason?: string | null;
  matchReasons: string[];
}

/**
 * Pure matcher for Exhibition / Trunk Show (F29).
 *
 * HARD RULE 8: Never infer religion, relationships, demographics, or preferences
 * from customer names. Purely declared attributes!
 */
export function matchExhibitionEvent(
  customer: ExhibitionCustomerProfile,
  event: ExhibitionEventDetails,
  options: ExhibitionMatchOptions = {}
): ExhibitionMatchResult {
  const mode = options.mode || 'STRICT';
  const audienceMode = options.audienceMode || 'ALL_ELIGIBLE';

  // 1. RSVP check: already registered customers should not receive generic invitations
  const hasRsvp =
    options.isAlreadyRegistered ||
    (customer.rsvpEventIds && customer.rsvpEventIds.includes(event.eventId));
  if (hasRsvp) {
    return {
      matched: false,
      score: 0,
      reason: 'CUSTOMER_REGISTERED',
      matchReasons: ['Customer is already registered for this event'],
    };
  }

  // 2. Capacity check: full event skips with EVENT_AT_CAPACITY
  if (
    event.status === 'FULL' ||
    (typeof event.capacity === 'number' &&
      event.capacity > 0 &&
      event.registeredCount >= event.capacity)
  ) {
    return {
      matched: false,
      score: 0,
      reason: 'EVENT_AT_CAPACITY',
      matchReasons: ['Event is at maximum capacity'],
    };
  }

  // 3. Geography matching
  const hasTargetCities = Array.isArray(event.targetCities) && event.targetCities.length > 0;
  const hasTargetBranches = Array.isArray(event.targetBranches) && event.targetBranches.length > 0;

  if (hasTargetCities || hasTargetBranches) {
    const custCity = customer.city?.trim().toLowerCase();
    const custBranch = customer.branchId?.trim().toLowerCase();

    const cityMatch =
      hasTargetCities && custCity
        ? event.targetCities!.some((tc) => tc.trim().toLowerCase() === custCity)
        : false;

    const branchMatch =
      hasTargetBranches && custBranch
        ? event.targetBranches!.some((tb) => tb.trim().toLowerCase() === custBranch)
        : false;

    if (!cityMatch && !branchMatch) {
      return {
        matched: false,
        score: 0,
        reason: 'OUTSIDE_GEOGRAPHY',
        matchReasons: ['Customer is outside target cities or branches'],
      };
    }
  }

  // 4. Hard Rule 8: ignore inferred preferences, never inspect names
  const prefs = customer.preferences?.source === 'INFERRED' ? null : customer.preferences;

  // 5. Category & interest matching
  const matchReasons: string[] = [];
  let score = 50;

  if (Array.isArray(event.categories) && event.categories.length > 0 && prefs) {
    const eventCats = event.categories.map((c) => c.trim().toLowerCase());
    const custCats = [
      ...(prefs.categories || []),
      ...(prefs.weaves || []),
    ].map((c) => c.trim().toLowerCase());

    const hasOverlap = custCats.some((cc) => eventCats.includes(cc));
    if (hasOverlap) {
      score += 50;
      matchReasons.push('Customer declared category preference matches event categories');
    } else if (mode === 'STRICT' && audienceMode === 'PREFERENCE_MATCH') {
      return {
        matched: false,
        score: 0,
        reason: 'NO_PREFERENCE_MATCH',
        matchReasons: ['Customer preferences do not match event categories'],
      };
    }
  }

  if (matchReasons.length === 0) {
    matchReasons.push('Eligible for exhibition event based on geography and capacity');
  }

  return {
    matched: true,
    score: score / 100,
    reason: null,
    matchReasons,
  };
}

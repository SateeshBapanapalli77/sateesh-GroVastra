/**
 * F26 compatibility barrel. Preference matching is shared with F27.
 */
export {
  scoreAffinityForCollection,
  calculateCustomerItemAffinity,
  evaluateAffinityEligibility,
  getMatchedItemDisplayName,
} from '../_shared/preferenceMatching/matching';
export type { AffinityScoreResult } from '../_shared/preferenceMatching/matching';

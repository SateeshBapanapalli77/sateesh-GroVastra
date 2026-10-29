import {
  SourceCustomer,
  CampaignAudience,
  AudienceRulePredicate,
  ALLOWED_AUDIENCE_FIELDS,
  ALLOWED_AUDIENCE_OPERATORS,
  AllowedAudienceField,
  AllowedAudienceOperator,
  EXCLUSION_REASONS,
  ExclusionReason,
  CampaignTrigger,
} from '@grovastra/shared';

export interface AudienceValidationResult {
  valid: boolean;
  errors: Array<{ fieldPath: string; message: string }>;
}

export interface CustomerEvaluationResult {
  eligible: boolean;
  primaryReason?: ExclusionReason;
  explanation?: string;
  details?: string;
  matchedRules: string[];
}

/**
 * Validates campaign audience rules according to Spec p10.
 * Rejects unknown fields/operators and empty audience when mode is not ALL_ELIGIBLE.
 */
export function validateAudience(audience?: CampaignAudience | null): AudienceValidationResult {
  const errors: Array<{ fieldPath: string; message: string }> = [];

  if (!audience) {
    errors.push({
      fieldPath: 'audience',
      message: 'Audience configuration is required',
    });
    return { valid: false, errors };
  }

  if (audience.mode === 'ALL_ELIGIBLE') {
    return { valid: true, errors: [] };
  }

  if (audience.mode !== 'CUSTOM_RULES') {
    errors.push({
      fieldPath: 'audience.mode',
      message: `Invalid audience mode '${(audience as any).mode}'. Supported: ALL_ELIGIBLE, CUSTOM_RULES`,
    });
    return { valid: false, errors };
  }

  const rules = audience.rules;
  if (!rules) {
    errors.push({
      fieldPath: 'audience.rules',
      message: 'Audience rules must be provided when mode is CUSTOM_RULES',
    });
    return { valid: false, errors };
  }

  const allRules = rules.all || [];
  const anyRules = rules.any || [];
  const noneRules = rules.none || [];

  if (allRules.length === 0 && anyRules.length === 0 && noneRules.length === 0) {
    errors.push({
      fieldPath: 'audience.rules',
      message: 'An entirely empty audience is invalid unless the owner selects ALL_ELIGIBLE',
    });
    return { valid: false, errors };
  }

  const validatePredicate = (pred: AudienceRulePredicate, path: string) => {
    if (!pred || typeof pred !== 'object') {
      errors.push({ fieldPath: path, message: 'Invalid predicate object' });
      return;
    }

    if (!ALLOWED_AUDIENCE_FIELDS.includes(pred.field)) {
      errors.push({
        fieldPath: `${path}.field`,
        message: `Unknown audience field '${pred.field}'. Allowed fields: ${ALLOWED_AUDIENCE_FIELDS.join(', ')}`,
      });
    }

    if (!ALLOWED_AUDIENCE_OPERATORS.includes(pred.op)) {
      errors.push({
        fieldPath: `${path}.op`,
        message: `Unknown audience operator '${pred.op}'. Allowed operators: ${ALLOWED_AUDIENCE_OPERATORS.join(', ')}`,
      });
    }

    if (['in', 'nin'].includes(pred.op) && !Array.isArray(pred.value)) {
      errors.push({
        fieldPath: `${path}.value`,
        message: `Operator '${pred.op}' requires an array value`,
      });
    }

    if (['gte', 'lte', 'gt', 'lt'].includes(pred.op) && typeof pred.value !== 'number') {
      errors.push({
        fieldPath: `${path}.value`,
        message: `Operator '${pred.op}' requires a numeric value`,
      });
    }
  };

  allRules.forEach((p, idx) => validatePredicate(p, `audience.rules.all[${idx}]`));
  anyRules.forEach((p, idx) => validatePredicate(p, `audience.rules.any[${idx}]`));
  noneRules.forEach((p, idx) => validatePredicate(p, `audience.rules.none[${idx}]`));

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Extracts property value from customer object (and optional occasion) given an allowlisted fieldPath.
 */
function extractFieldValue(
  customer: SourceCustomer,
  field: AllowedAudienceField,
  occasion?: { budgetPaise?: number | null; categories?: string[] } | null,
  enquiry?: { channel?: string; hasItem?: boolean; itemRef?: any } | null
): any {
  switch (field) {
    case 'enquiry.channel':
      return enquiry?.channel;
    case 'enquiry.hasItem':
      if (!enquiry) return undefined;
      return enquiry.hasItem !== undefined ? enquiry.hasItem : Boolean(enquiry.itemRef?.productId);
    case 'occasion.budgetPaise':
      return occasion?.budgetPaise !== undefined ? occasion.budgetPaise : null;
    case 'occasion.categories':
      return occasion?.categories || [];
    case 'customer.status':
      return customer.status;
    case 'preferences.weave':
      return customer.preferences?.weave;
    case 'preferences.budgetMaxPaise':
      return customer.preferences?.budgetMaxPaise;
    case 'preferences.size':
      return customer.preferences?.size;
    case 'preferences.colour':
      return customer.preferences?.colour;
    case 'tags':
      return customer.tags;
    case 'branchId':
      return customer.branchId;
    case 'language':
      return customer.language;
    case 'serviceIssueOpen':
      return (customer as any).serviceIssueOpen;
    case 'isLive':
      return customer.isLive;
    default:
      return undefined;
  }
}

/**
 * Evaluates a single predicate against an extracted field value.
 * Strictly adheres to Spec p10:
 * - Missing fields fail ordinary comparisons.
 */
function evaluatePredicate(fieldValue: any, op: AllowedAudienceOperator, ruleValue: any): boolean {
  // Missing fields fail ordinary comparisons (spec p10)
  if (fieldValue === undefined || fieldValue === null) {
    return false;
  }

  switch (op) {
    case 'eq':
      if (typeof fieldValue === 'string' && typeof ruleValue === 'string') {
        return fieldValue.toLowerCase() === ruleValue.toLowerCase();
      }
      return fieldValue === ruleValue;

    case 'neq':
      if (typeof fieldValue === 'string' && typeof ruleValue === 'string') {
        return fieldValue.toLowerCase() !== ruleValue.toLowerCase();
      }
      return fieldValue !== ruleValue;

    case 'in':
      if (!Array.isArray(ruleValue)) return false;
      if (Array.isArray(fieldValue)) {
        return fieldValue.some((item) =>
          ruleValue.some((v) => {
            if (typeof item === 'string' && typeof v === 'string') {
              return item.toLowerCase() === v.toLowerCase();
            }
            return item === v;
          })
        );
      }
      return ruleValue.some((v) => {
        if (typeof fieldValue === 'string' && typeof v === 'string') {
          return fieldValue.toLowerCase() === v.toLowerCase();
        }
        return fieldValue === v;
      });

    case 'nin':
      if (!Array.isArray(ruleValue)) return false;
      if (Array.isArray(fieldValue)) {
        return !fieldValue.some((item) =>
          ruleValue.some((v) => {
            if (typeof item === 'string' && typeof v === 'string') {
              return item.toLowerCase() === v.toLowerCase();
            }
            return item === v;
          })
        );
      }
      return !ruleValue.some((v) => {
        if (typeof fieldValue === 'string' && typeof v === 'string') {
          return fieldValue.toLowerCase() === v.toLowerCase();
        }
        return fieldValue === v;
      });

    case 'gte':
      return typeof fieldValue === 'number' && typeof ruleValue === 'number' && fieldValue >= ruleValue;

    case 'lte':
      return typeof fieldValue === 'number' && typeof ruleValue === 'number' && fieldValue <= ruleValue;

    case 'gt':
      return typeof fieldValue === 'number' && typeof ruleValue === 'number' && fieldValue > ruleValue;

    case 'lt':
      return typeof fieldValue === 'number' && typeof ruleValue === 'number' && fieldValue < ruleValue;

    case 'contains':
      if (Array.isArray(fieldValue)) {
        return fieldValue.some((item) =>
          String(item).toLowerCase().includes(String(ruleValue).toLowerCase())
        );
      }
      if (typeof fieldValue === 'string') {
        return fieldValue.toLowerCase().includes(String(ruleValue).toLowerCase());
      }
      return false;

    default:
      return false;
  }
}

/**
 * Evaluates a customer against Mandatory Platform Gates (Spec p10) and Editable Audience Rules.
 * Returns concise match explanation string on match (e.g. "birthday in 14 days; opted in; silk preference").
 */
export function evaluateCustomerForCampaign(params: {
  customer: SourceCustomer;
  campaign: {
    trigger: CampaignTrigger;
    enabledBranches: string[];
    audience: CampaignAudience;
    purpose?: string;
  };
  occasionLocalDate?: string;
  daysUntilOccasion?: number;
  occasion?: { kind?: string | null; budgetPaise?: number | null; categories?: string[] } | null;
  enquiry?: { channel?: string; hasItem?: boolean; itemRef?: any } | null;
}): CustomerEvaluationResult {
  const { customer, campaign, occasionLocalDate, daysUntilOccasion, occasion, enquiry } = params;

  // 1. Mandatory Gate 1: Active Customer & Non-Deleted (Hard Rule 7, Spec p10)
  if (customer.deletedAt || customer.status !== 'ACTIVE') {
    return {
      eligible: false,
      primaryReason: EXCLUSION_REASONS.INACTIVE_CUSTOMER,
      details: `Customer status is '${customer.status}'${customer.deletedAt ? ' (deleted)' : ''}`,
      matchedRules: [],
    };
  }

  // 2. Mandatory Gate 2: Destination Validity & Verification (Spec p10)
  if (
    !customer.destination ||
    !customer.destination.encryptedPhone ||
    customer.destination.verified !== true
  ) {
    return {
      eligible: false,
      primaryReason: EXCLUSION_REASONS.INVALID_DESTINATION,
      details: 'Destination phone number is unverified or missing',
      matchedRules: [],
    };
  }

  // 3. Mandatory Gate 3: Channel Suppression (Hard Rule 7, Spec p10)
  if (customer.consent?.channelSuppressed) {
    return {
      eligible: false,
      primaryReason: EXCLUSION_REASONS.CHANNEL_SUPPRESSED,
      details: 'Customer phone destination is channel-suppressed across all communications',
      matchedRules: [],
    };
  }

  // 4. Mandatory Gate 4: Marketing Consent for Promotional Campaigns (Spec p10)
  if (customer.consent?.marketingOptIn !== true) {
    return {
      eligible: false,
      primaryReason: EXCLUSION_REASONS.MARKETING_OPT_OUT,
      details: 'Customer has not opted into marketing messages',
      matchedRules: [],
    };
  }

  // 5. Mandatory Gate 5: Branch Scope Authorization (Spec p10, Hard Rule 1)
  if (
    customer.branchId &&
    campaign.enabledBranches &&
    campaign.enabledBranches.length > 0 &&
    !campaign.enabledBranches.includes(customer.branchId)
  ) {
    return {
      eligible: false,
      primaryReason: EXCLUSION_REASONS.BRANCH_NOT_ENABLED,
      details: `Customer branch '${customer.branchId}' is not enabled for this campaign`,
      matchedRules: [],
    };
  }

  // 6. Mandatory Gate 6: Trigger Data Presence
  if (campaign.trigger.type === 'ANNUAL_DATE') {
    if (campaign.trigger.field === 'customer.birthday') {
      if (!customer.birthday || !customer.birthday.month || !customer.birthday.day) {
        return {
          eligible: false,
          primaryReason: EXCLUSION_REASONS.MISSING_TRIGGER_DATE,
          details: 'Customer has no recorded birthday month/day',
          matchedRules: [],
        };
      }
    }
  }

  // 7. Audience Rules Evaluation (all, any, none semantics per Spec p10)
  const matchedRules: string[] = [];

  if (campaign.audience.mode === 'CUSTOM_RULES' && campaign.audience.rules) {
    const { all = [], any = [], none = [] } = campaign.audience.rules;

    // A. All predicates must pass
    for (let i = 0; i < all.length; i++) {
      const pred = all[i];
      const val = extractFieldValue(customer, pred.field, occasion, enquiry);
      const passed = evaluatePredicate(val, pred.op, pred.value);
      if (!passed) {
        return {
          eligible: false,
          primaryReason: EXCLUSION_REASONS.EXCLUDED_AUDIENCE_FILTER,
          details: `Failed 'all' rule on '${pred.field}' (${pred.op} ${JSON.stringify(pred.value)})`,
          matchedRules: [],
        };
      }
      matchedRules.push(describePredicateMatch(pred, val));
    }

    // B. Any predicates (optional; at least one must pass when present)
    if (any.length > 0) {
      let anyPassed = false;
      for (const pred of any) {
        const val = extractFieldValue(customer, pred.field, occasion, enquiry);
        if (evaluatePredicate(val, pred.op, pred.value)) {
          anyPassed = true;
          matchedRules.push(describePredicateMatch(pred, val));
          break; // First passing any rule suffices
        }
      }
      if (!anyPassed) {
        return {
          eligible: false,
          primaryReason: EXCLUSION_REASONS.EXCLUDED_AUDIENCE_FILTER,
          details: `Failed 'any' rule: none of the ${any.length} conditions matched`,
          matchedRules: [],
        };
      }
    }

    // C. None predicates (must all fail)
    if (none.length > 0) {
      for (const pred of none) {
        const val = extractFieldValue(customer, pred.field, occasion, enquiry);
        if (evaluatePredicate(val, pred.op, pred.value)) {
          return {
            eligible: false,
            primaryReason: EXCLUSION_REASONS.EXCLUDED_AUDIENCE_FILTER,
            details: `Failed 'none' exclusion rule on '${pred.field}'`,
            matchedRules: [],
          };
        }
      }
    }
  }

  // 8. Generate concise match explanation string (Spec p10)
  // Example: "birthday in 14 days; opted in; silk preference"
  const explanationParts: string[] = [];

  if (campaign.trigger.type === 'EVENT_DELAY') {
    explanationParts.push(`qualifying order on ${occasionLocalDate || 'recent'}`);
  } else if (campaign.trigger.type === 'INACTIVITY_THRESHOLD') {
    explanationParts.push('inactivity threshold reached');
  } else if (daysUntilOccasion !== undefined) {
    let triggerLabel = 'occasion';
    if (campaign.trigger.type === 'CUSTOMER_EVENT_DATE') {
      triggerLabel = campaign.trigger.occasionKind === 'GIFT' ? 'gift reminder' : 'wedding';
    } else if (campaign.trigger.field === 'customer.birthday') {
      triggerLabel = 'birthday';
    } else if (campaign.trigger.field === 'customer.event') {
      triggerLabel = 'anniversary';
    }
    if (daysUntilOccasion === 0) {
      explanationParts.push(`${triggerLabel} today`);
    } else if (daysUntilOccasion > 0) {
      explanationParts.push(`${triggerLabel} in ${daysUntilOccasion} days`);
    } else {
      explanationParts.push(`${triggerLabel} was ${Math.abs(daysUntilOccasion)} days ago`);
    }
  } else if (occasionLocalDate) {
    explanationParts.push(`occasion on ${occasionLocalDate}`);
  }

  explanationParts.push('opted in');

  if (matchedRules.length > 0) {
    explanationParts.push(...matchedRules);
  } else if (campaign.audience.mode === 'ALL_ELIGIBLE') {
    explanationParts.push('all eligible');
  }

  const explanation = explanationParts.join('; ');

  return {
    eligible: true,
    explanation,
    matchedRules,
  };
}

function describePredicateMatch(pred: AudienceRulePredicate, val: any): string {
  if (pred.field === 'preferences.weave') {
    return `${val} preference`;
  }
  if (pred.field === 'preferences.budgetMaxPaise') {
    const rupees = Math.round(Number(pred.value) / 100);
    return `budget >= ₹${rupees.toLocaleString('en-IN')}`;
  }
  if (pred.field === 'occasion.budgetPaise') {
    const rupees = Math.round(Number(pred.value) / 100);
    return `occasion budget >= ₹${rupees.toLocaleString('en-IN')}`;
  }
  if (pred.field === 'occasion.categories') {
    return `category ${Array.isArray(pred.value) ? pred.value.join(', ') : pred.value}`;
  }
  if (pred.field === 'tags') {
    return `tagged ${pred.value}`;
  }
  return `${pred.field} match`;
}

/**
 * Compiles allowlisted audience rules into a safe MongoDB filter scoped by tenant + branch.
 * Strictly guarantees tenant isolation and never executes raw Mongo filters or JavaScript.
 */
export function compileSafeMongoQuery(params: {
  tenantId: string;
  branchIds?: string[];
  audience?: CampaignAudience | null;
}): Record<string, any> {
  const { tenantId, branchIds, audience } = params;

  const query: Record<string, any> = {
    tenantId,
    deletedAt: null,
  };

  if (branchIds && branchIds.length > 0) {
    query.branchId = { $in: branchIds };
  }

  if (!audience || audience.mode === 'ALL_ELIGIBLE' || !audience.rules) {
    return query;
  }

  const { all = [] } = audience.rules;

  // Compile 'all' predicates into direct MongoDB clauses
  for (const pred of all) {
    const mongoField = mapAllowlistedFieldToMongo(pred.field);
    if (!mongoField) continue;

    switch (pred.op) {
      case 'eq':
        query[mongoField] =
          typeof pred.value === 'string'
            ? { $regex: `^${escapeRegex(pred.value)}$`, $options: 'i' }
            : pred.value;
        break;
      case 'neq':
        query[mongoField] = { $ne: pred.value };
        break;
      case 'in':
        if (Array.isArray(pred.value)) {
          query[mongoField] = {
            $in: pred.value.map((v) =>
              typeof v === 'string' ? new RegExp(`^${escapeRegex(v)}$`, 'i') : v
            ),
          };
        }
        break;
      case 'nin':
        if (Array.isArray(pred.value)) {
          query[mongoField] = { $nin: pred.value };
        }
        break;
      case 'gte':
        query[mongoField] = { ...query[mongoField], $gte: pred.value };
        break;
      case 'lte':
        query[mongoField] = { ...query[mongoField], $lte: pred.value };
        break;
      case 'gt':
        query[mongoField] = { ...query[mongoField], $gt: pred.value };
        break;
      case 'lt':
        query[mongoField] = { ...query[mongoField], $lt: pred.value };
        break;
      case 'contains':
        query[mongoField] = { $regex: escapeRegex(String(pred.value)), $options: 'i' };
        break;
    }
  }

  return query;
}

function mapAllowlistedFieldToMongo(field: AllowedAudienceField): string | null {
  switch (field) {
    case 'customer.status':
      return 'status';
    case 'preferences.weave':
      return 'preferences.weave';
    case 'preferences.budgetMaxPaise':
      return 'preferences.budgetMaxPaise';
    case 'preferences.size':
      return 'preferences.size';
    case 'preferences.colour':
      return 'preferences.colour';
    case 'tags':
      return 'tags';
    case 'branchId':
      return 'branchId';
    case 'language':
      return 'language';
    case 'isLive':
      return 'isLive';
    default:
      return null;
  }
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

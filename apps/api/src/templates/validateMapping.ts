import { SourceTemplate } from '@grovastra/shared';
import { BINDING_SOURCES, isSourceAllowedForPreset } from './bindingSources';
import { normalizeBindings, NormalizedBindings } from './normalizeBindings';
import { validateLiteralInput } from './sanitize';

export interface ValidationItem {
  fieldPath: string;
  message: string;
  code?: string;
  resolutionOwner: 'BOUTIQUE_OWNER' | 'INTEGRATION_DEVELOPER';
}

export interface ValidateMappingParams {
  template: (SourceTemplate & { parameterFormat?: string }) | null | undefined;
  templateRef?: { id: string; revision: number; language: string } | null;
  bindings: unknown;
  presetId?: string;
  fieldPrefix?: string; // e.g. "steps[0]"
  offerRef?: { offerId?: string } | null;
  creditRef?: { selector?: string; creditId?: string; reason?: string } | null;
  dispatchMode?: string; // 'meta' | 'dry'
  isActivation?: boolean;
  occasionKind?: 'GIFT' | 'WEDDING' | null;
}

export interface ValidateMappingResult {
  valid: boolean;
  errors: ValidationItem[];
  warnings: ValidationItem[];
  normalizedBindings: NormalizedBindings;
}

/**
 * Validates step template variable mappings according to Spec p8, p20, p27 and F19c contract.
 */
export function validateTemplateMapping(params: ValidateMappingParams): ValidateMappingResult {
  const {
    template,
    templateRef,
    bindings: rawBindings,
    presetId,
    fieldPrefix = 'steps[0]',
    offerRef,
    creditRef,
    dispatchMode = 'dry',
    isActivation = false,
    occasionKind,
  } = params;

  const errors: ValidationItem[] = [];
  const warnings: ValidationItem[] = [];

  const prefix = fieldPrefix ? `${fieldPrefix}.` : '';

  // 1. Template Existence & Revision/Language match
  if (!template || !templateRef) {
    errors.push({
      fieldPath: `${prefix}templateRef`,
      message: 'Template reference is required and must exist in approved catalogue',
      code: 'TEMPLATE_MISSING',
      resolutionOwner: 'BOUTIQUE_OWNER',
    });
    return { valid: false, errors, warnings, normalizedBindings: {} };
  }

  // Exact ID, revision and language match
  const templateRevision = template.revision ?? 1;
  const refRevision = templateRef.revision ?? 1;
  if (
    template.id !== templateRef.id ||
    templateRevision !== refRevision ||
    template.language !== templateRef.language
  ) {
    errors.push({
      fieldPath: `${prefix}templateRef`,
      message: `Template reference mismatch: requested ${templateRef.id} (rev ${templateRef.revision}, lang ${templateRef.language}) does not match catalogue template ${template.id} (rev ${template.revision}, lang ${template.language})`,
      code: 'TEMPLATE_REVISION_CHANGED',
      resolutionOwner: 'INTEGRATION_DEVELOPER',
    });
  }

  // In meta dispatch mode, template must be sendable on activation (drafts allow dummy templates with warnings)
  if (isActivation && dispatchMode.toLowerCase() === 'meta' && !template.sendable) {
    errors.push({
      fieldPath: `${prefix}templateRef`,
      message: `Template '${template.id}' is marked sendable=false (DUMMY template cannot be used in meta mode)`,
      code: 'TEMPLATE_NOT_SENDABLE',
      resolutionOwner: 'INTEGRATION_DEVELOPER',
    });
  }

  // 2. parameterFormat check (Positional vs Named)
  // Spec: only POSITIONAL is supported; if catalogue marks template NAMED -> error TEMPLATE_PARAMETER_FORMAT_UNSUPPORTED
  // (resolution owner: integration developer). Assume POSITIONAL when absent.
  const format = (template.parameterFormat || 'POSITIONAL').toUpperCase();
  if (format !== 'POSITIONAL') {
    errors.push({
      fieldPath: `${prefix}templateRef`,
      message: `Template parameter format '${template.parameterFormat}' is unsupported. Only POSITIONAL parameters are supported.`,
      code: 'TEMPLATE_PARAMETER_FORMAT_UNSUPPORTED',
      resolutionOwner: 'INTEGRATION_DEVELOPER',
    });
  }

  // 3. Normalize bindings
  const normalized = normalizeBindings(rawBindings, template);
  const templateVars = template.variables || [];
  const expectedIndices = new Set(templateVars.map((v) => v.index));
  const providedKeyStrings = Object.keys(normalized);

  // 4. Zero-variable templates
  if (templateVars.length === 0) {
    if (providedKeyStrings.length > 0) {
      errors.push({
        fieldPath: `${prefix}bindings`,
        message: 'Template has zero variables; bindings must be empty',
        code: 'BINDING_COUNT_MISMATCH',
        resolutionOwner: 'BOUTIQUE_OWNER',
      });
    }
    return {
      valid: errors.length === 0,
      errors,
      warnings,
      normalizedBindings: normalized,
    };
  }

  // 5. Variable indices validation (exact match: no extra, missing, duplicate, gap, non-integer or non-positive)
  const providedIndices: number[] = [];
  for (const key of providedKeyStrings) {
    const num = Number(key);
    if (!Number.isInteger(num) || num <= 0 || String(num) !== key) {
      errors.push({
        fieldPath: `${prefix}bindings.${key}`,
        message: `Invalid variable binding index '${key}'. Binding indices must be positive integers matching template variables.`,
        code: 'BINDING_INDEX_INVALID',
        resolutionOwner: 'BOUTIQUE_OWNER',
      });
    } else {
      providedIndices.push(num);
    }
  }

  // Check count
  if (providedIndices.length !== templateVars.length) {
    errors.push({
      fieldPath: `${prefix}bindings`,
      message: `Variable count mismatch: template requires ${templateVars.length} variable bindings, but ${providedIndices.length} were provided`,
      code: 'BINDING_COUNT_MISMATCH',
      resolutionOwner: 'BOUTIQUE_OWNER',
    });
  }

  // Check exact index match (1..N)
  for (const expIndex of expectedIndices) {
    if (!providedIndices.includes(expIndex)) {
      errors.push({
        fieldPath: `${prefix}bindings.${expIndex}`,
        message: `Missing variable binding for variable index {{${expIndex}}}`,
        code: 'BINDING_COUNT_MISMATCH',
        resolutionOwner: 'BOUTIQUE_OWNER',
      });
    }
  }

  for (const provIndex of providedIndices) {
    if (!expectedIndices.has(provIndex)) {
      errors.push({
        fieldPath: `${prefix}bindings.${provIndex}`,
        message: `Unexpected variable binding index {{${provIndex}}} not defined in template variables`,
        code: 'BINDING_INDEX_INVALID',
        resolutionOwner: 'BOUTIQUE_OWNER',
      });
    }
  }

  // 6. Validate each binding definition
  let hasOfferBinding = false;
  let hasCreditBinding = false;

  for (const [key, entry] of Object.entries(normalized)) {
    const fieldPath = `${prefix}bindings.${key}`;

    if (!entry.source || typeof entry.source !== 'string') {
      errors.push({
        fieldPath,
        message: `Binding for variable {{${key}}} must specify a valid source or literal`,
        code: 'BINDING_SOURCE_NOT_ALLOWED',
        resolutionOwner: 'BOUTIQUE_OWNER',
      });
      continue;
    }

    if (entry.source === 'literal') {
      // Literal validation
      const literalCheck = validateLiteralInput(entry.value);
      if (!literalCheck.valid) {
        errors.push({
          fieldPath: `${fieldPath}.value`,
          message: literalCheck.error || 'Invalid literal value',
          code: 'LITERAL_INVALID',
          resolutionOwner: 'BOUTIQUE_OWNER',
        });
      }
      if (entry.fallbackLiteral !== undefined) {
        errors.push({
          fieldPath: `${fieldPath}.fallbackLiteral`,
          message: 'fallbackLiteral cannot be set on a literal binding',
          code: 'LITERAL_INVALID',
          resolutionOwner: 'BOUTIQUE_OWNER',
        });
      }
    } else {
      // Source validation
      const sourceDef = BINDING_SOURCES[entry.source];
      if (!sourceDef) {
        errors.push({
          fieldPath: `${prefix}bindings[${key}]`,
          message: `Invalid binding source '${entry.source}'. Allowed sources: customer.firstName, shop.displayName, occasion.localDate, offer.amountRupees, or literal value`,
          code: 'BINDING_SOURCE_NOT_ALLOWED',
          resolutionOwner: 'BOUTIQUE_OWNER',
        });
        continue;
      }

      // Allowlist check per preset
      if (presetId) {
        const isAllowed = isSourceAllowedForPreset(entry.source, presetId);
        if (!isAllowed) {
          errors.push({
            fieldPath: `${prefix}bindings[${key}]`,
            message: `Invalid binding source '${entry.source}' for preset '${presetId}'`,
            code: 'BINDING_SOURCE_NOT_ALLOWED',
            resolutionOwner: 'BOUTIQUE_OWNER',
          });
        }
      }

      // Welcome preset with order.* details produces a privacy warning, not error
      const normPreset = (presetId || '').toUpperCase().replace(/-/g, '_');
      if (
        normPreset.includes('WELCOME') &&
        entry.source.startsWith('order.')
      ) {
        warnings.push({
          fieldPath: `${fieldPath}.source`,
          message: `Welcome message uses ${entry.source}. Verify that referencing previous order details in welcome sequence does not leak unexpected customer history.`,
          code: 'WELCOME_CONTAINS_ORDER_DETAILS',
          resolutionOwner: 'BOUTIQUE_OWNER',
        });
      }

      if (entry.source === 'shop.bookingLink') {
        if (occasionKind === 'GIFT') {
          errors.push({
            fieldPath: `${prefix}bindings.${key}`,
            message: 'shop.bookingLink is permitted only for wedding campaigns',
            code: 'BINDING_SOURCE_NOT_ALLOWED',
            resolutionOwner: 'BOUTIQUE_OWNER',
          });
        }
        if (template?.bodyText && /(booked|confirmed|reserved|your appointment)/i.test(template.bodyText)) {
          warnings.push({
            fieldPath: `${prefix}templateRef`,
            message: 'Template text contains booking claim wording ("booked", "confirmed", "reserved", or "your appointment") combined with shop.bookingLink. An invitation should offer a booking link, not claim a booking already exists (spec p12)',
            code: 'BOOKING_CLAIM_WORDING',
            resolutionOwner: 'BOUTIQUE_OWNER',
          });
        }
      }

      if (entry.source === 'event.recipientLabel' && occasionKind === 'WEDDING') {
        errors.push({
          fieldPath: `${prefix}bindings.${key}`,
          message: 'event.recipientLabel is permitted only for gift reminder campaigns',
          code: 'BINDING_SOURCE_NOT_ALLOWED',
          resolutionOwner: 'BOUTIQUE_OWNER',
        });
      }

      if (entry.source === 'offer.amountRupees' || entry.source.startsWith('offer.')) {
        hasOfferBinding = true;
      }
      if (entry.source.startsWith('credit.')) {
        hasCreditBinding = true;
      }

      // Fallback literal validation: only allowed for sources that can be missing (customer.firstName)
      if (entry.fallbackLiteral !== undefined && entry.fallbackLiteral !== null) {
        if (!sourceDef.allowFallback) {
          errors.push({
            fieldPath: `${fieldPath}.fallbackLiteral`,
            message: `fallbackLiteral is forbidden for source '${entry.source}'. Fallbacks are only permitted for sources that can legitimately be missing without changing core business terms (customer.firstName). Inventing values for dates, offers, or credits is strictly prohibited (spec p13, p16, p29).`,
            code: 'LITERAL_INVALID',
            resolutionOwner: 'BOUTIQUE_OWNER',
          });
        } else {
          const fallbackCheck = validateLiteralInput(entry.fallbackLiteral);
          if (!fallbackCheck.valid) {
            errors.push({
              fieldPath: `${fieldPath}.fallbackLiteral`,
              message: fallbackCheck.error || 'Invalid fallbackLiteral value',
              code: 'LITERAL_INVALID',
              resolutionOwner: 'BOUTIQUE_OWNER',
            });
          }
        }
      }
    }
  }

  // 7. OfferRef check: required when template has offer variable or bindings use offer.*
  const hasOfferVariable = templateVars.some((v) => {
    const name = (v.name || '').toLowerCase();
    return name.includes('offer') || name.includes('discount');
  });

  if (hasOfferBinding || hasOfferVariable) {
    if (!offerRef || !offerRef.offerId) {
      errors.push({
        fieldPath: `${prefix}offerRef`,
        message: 'offerRef is required because the selected template or bindings reference an offer',
        code: 'OFFER_REF_REQUIRED',
        resolutionOwner: 'BOUTIQUE_OWNER',
      });
    }
  }

  // 8. CreditRef check: required when template has credit variable or bindings use credit.*
  const hasCreditVariable = templateVars.some((v) => {
    const name = (v.name || '').toLowerCase();
    return (
      name.includes('credit') ||
      name.includes('reward') ||
      name.includes('cashback') ||
      name.includes('expiry') ||
      name.includes('point')
    );
  });

  if (hasCreditBinding || hasCreditVariable) {
    if (!creditRef || (!creditRef.selector && !creditRef.creditId && !creditRef.reason)) {
      errors.push({
        fieldPath: `${prefix}creditRef`,
        message: 'creditRef is required when credit.* variables or bindings are used',
        code: 'CREDIT_REF_REQUIRED',
        resolutionOwner: 'BOUTIQUE_OWNER',
      });
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    normalizedBindings: normalized,
  };
}

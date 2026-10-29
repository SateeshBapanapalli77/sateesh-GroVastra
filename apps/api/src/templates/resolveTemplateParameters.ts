import { SourceCustomer, SourceTemplate } from '@grovastra/shared';
import {
  BINDING_SOURCES,
  BindingResolutionContext,
} from './bindingSources';
import { normalizeBindings } from './normalizeBindings';
import { sanitizeAndValidateParam } from './sanitize';

export interface ResolvedParameterItem {
  index: number;
  name: string;
  text: string;
  source: string;
  usedFallback: boolean;
}

export interface ResolutionProblem {
  code: 'MISSING_VARIABLE' | 'VARIABLE_TOO_LONG' | 'BINDING_NOT_FOUND' | string;
  variableIndex: number;
  variableName: string;
  source: string;
  message?: string;
}

export interface TemplateResolutionResult {
  ok: boolean;
  parameters: ResolvedParameterItem[];
  paramMap: Record<string, string>;
  renderedPreview: string;
  problems: ResolutionProblem[];
  usedFallback: boolean;
  skipReason?: string;
  missingVariableIndex?: number;
  missingSource?: string;
  longVariableIndex?: number;
}

export interface ResolveTemplateParametersParams {
  template: Pick<SourceTemplate, 'id' | 'name' | 'language' | 'variables' | 'bodyText'>;
  step?: {
    bindings?: unknown;
    templateRef?: any;
    offerRef?: any;
    creditRef?: any;
  } | null;
  bindings?: unknown; // direct bindings can also be provided
  customer?: SourceCustomer | null;
  tenant?: { name?: string; timezone?: string } | null;
  campaignVersion?: { timezone?: string } | null;
  snapshot?: BindingResolutionContext;
  presetId?: string;
  clock?: { now: () => Date };
}

/**
 * The ONE shared resolver for all WhatsApp template parameters.
 * Used identically across:
 * - Dry run simulation
 * - Authoring preview API
 * - Worker live dispatch / delivery intent freezing
 *
 * Rules:
 * 1. Parameters are strictly sorted by ascending variable index (never object keys).
 * 2. Every value is sanitized (Unicode NFC, control chars removed, whitespace collapsed & trimmed).
 * 3. Empty after cleaning -> MISSING_VARIABLE problem.
 * 4. Length > TEMPLATE_PARAM_MAX_LEN -> VARIABLE_TOO_LONG problem.
 * 5. If primary value is missing and valid fallbackLiteral is provided -> uses fallback and flags usedFallback=true.
 * 6. Never invents values, never substitutes another template.
 * 7. Pure function with respect to provided customer and snapshot context.
 */
export function resolveTemplateParameters(
  params: ResolveTemplateParametersParams
): TemplateResolutionResult {
  const {
    template,
    step,
    bindings: directBindings,
    customer,
    tenant,
    campaignVersion,
    snapshot,
    clock,
  } = params;

  const rawBindings = directBindings !== undefined ? directBindings : step?.bindings;
  const normalized = normalizeBindings(rawBindings, template as SourceTemplate);

  const templateVars = template?.variables
    ? [...template.variables].sort((a, b) => a.index - b.index)
    : Object.keys(normalized)
        .map((k) => Number(k))
        .filter((n) => Number.isInteger(n) && n > 0)
        .sort((a, b) => a - b)
        .map((index) => ({ index, name: `var_${index}` }));

  // Context preparation
  const timezone =
    snapshot?.timezone ||
    campaignVersion?.timezone ||
    tenant?.timezone ||
    'Asia/Kolkata';

  const now = snapshot?.now || (clock ? clock.now() : new Date());

  const resolutionCtx: BindingResolutionContext = {
    customer: customer ?? snapshot?.customer ?? null,
    shopName: snapshot?.shopName || tenant?.name || (params as any).shop?.displayName || 'Sample Boutique',
    occasionLocalDate: snapshot?.occasionLocalDate,
    eventDate: snapshot?.eventDate ?? snapshot?.occasionLocalDate,
    recipientLabel: snapshot?.recipientLabel ?? null,
    bookingLinkUrl: snapshot?.bookingLinkUrl ?? null,
    occasionKind: snapshot?.occasionKind ?? null,
    order: snapshot?.order ?? null,
    credit: snapshot?.credit ?? null,
    offerAmountRupees: snapshot?.offerAmountRupees ?? null,
    offer: snapshot?.offer ?? null,
    enquiry: snapshot?.enquiry ?? null,
    itemName: snapshot?.itemName ?? null,
    outfit: snapshot?.outfit ?? null,
    anchorItemName: snapshot?.anchorItemName ?? null,
    complement1Name: snapshot?.complement1Name ?? null,
    complement2Name: snapshot?.complement2Name ?? null,
    complement3Name: snapshot?.complement3Name ?? null,
    collection: snapshot?.collection ?? null,
    collectionName: snapshot?.collectionName ?? null,
    matchItemList: snapshot?.matchItemList ?? null,
    now,
    timezone,
    ...snapshot,
  };

  const parameters: ResolvedParameterItem[] = [];
  const problems: ResolutionProblem[] = [];

  // Zero-variable templates
  if (templateVars.length === 0) {
    const rendered =
      template.bodyText !== null && template.bodyText !== undefined
        ? template.bodyText
        : `${template.name} []`;
    return {
      ok: true,
      parameters: [],
      paramMap: {},
      renderedPreview: rendered,
      usedFallback: false,
      problems: [],
    };
  }

  // Iterate in ascending index order
  for (const v of templateVars) {
    const vIndex = v.index;
    const vName = v.name || `var_${vIndex}`;
    const binding = normalized[String(vIndex)];

    if (!binding) {
      problems.push({
        code: 'MISSING_VARIABLE',
        variableIndex: vIndex,
        variableName: vName,
        source: 'undefined',
        message: `No binding configured for variable {{${vIndex}}} (${vName})`,
      });
      parameters.push({
        index: vIndex,
        name: vName,
        text: '',
        source: 'undefined',
        usedFallback: false,
      });
      continue;
    }

    let resolvedRaw: string | null = null;
    let usedFallback = false;

    if (binding.source === 'literal') {
      resolvedRaw = binding.value ?? '';
    } else {
      const sourceDef = BINDING_SOURCES[binding.source];
      if (sourceDef) {
        resolvedRaw = sourceDef.resolve(resolutionCtx);
      }
    }

    // Sanitize primary value
    let check = sanitizeAndValidateParam(resolvedRaw);

    // If primary value is missing or empty, attempt fallback if configured
    if (!check.ok && check.problem === 'MISSING_VARIABLE') {
      if (
        binding.fallbackLiteral !== undefined &&
        binding.fallbackLiteral !== null &&
        binding.fallbackLiteral.trim().length > 0
      ) {
        const fallbackCheck = sanitizeAndValidateParam(binding.fallbackLiteral);
        if (fallbackCheck.ok) {
          check = fallbackCheck;
          usedFallback = true;
        } else {
          problems.push({
            code: fallbackCheck.problem!,
            variableIndex: vIndex,
            variableName: vName,
            source: binding.source,
            message: `Fallback literal for variable {{${vIndex}}} failed validation: ${fallbackCheck.problem}`,
          });
        }
      }
    }

    if (!check.ok) {
      problems.push({
        code: check.problem!,
        variableIndex: vIndex,
        variableName: vName,
        source: binding.source,
        message: `Variable {{${vIndex}}} (${vName}) from source '${binding.source}' failed: ${check.problem}`,
      });
    }

    parameters.push({
      index: vIndex,
      name: vName,
      text: check.cleaned,
      source: binding.source,
      usedFallback,
    });
  }

  // Generate renderedPreview
  let renderedPreview: string;
  if (template?.bodyText) {
    renderedPreview = template.bodyText;
    for (const p of parameters) {
      const token = `{{${p.index}}}`;
      const replacement = p.text.length > 0 ? p.text : `[MISSING: {{${p.index}}}]`;
      renderedPreview = renderedPreview.split(token).join(replacement);
    }
  } else {
    // Template without bodyText (e.g. Meta test templates) or template not supplied
    const paramSummary = parameters.map((p) => p.text || `[MISSING: {{${p.index}}}]`).join(', ');
    const templateName = template?.name || 'Template';
    renderedPreview = `${templateName} [${paramSummary}]`;
  }

  const ok = problems.length === 0;
  const paramMap: Record<string, string> = {};
  for (const p of parameters) {
    if (!problems.some((prob) => prob.variableIndex === p.index)) {
      paramMap[String(p.index)] = p.text;
    }
  }
  const firstProblem = problems[0];
  const usedFallback = parameters.some((p) => p.usedFallback);

  return {
    ok,
    parameters,
    paramMap,
    renderedPreview,
    problems,
    usedFallback,
    skipReason: !ok ? firstProblem?.code : undefined,
    missingVariableIndex:
      !ok && firstProblem?.code === 'MISSING_VARIABLE' ? firstProblem.variableIndex : undefined,
    missingSource:
      !ok && firstProblem?.code === 'MISSING_VARIABLE' ? firstProblem.source : undefined,
    longVariableIndex:
      !ok && firstProblem?.code === 'VARIABLE_TOO_LONG' ? firstProblem.variableIndex : undefined,
  };
}

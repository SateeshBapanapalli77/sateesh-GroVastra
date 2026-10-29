import { SourceTemplate } from '@grovastra/shared';

export interface NormalizedBindingEntry {
  source: string;
  value?: string;
  fallbackLiteral?: string;
}

export type NormalizedBindings = Record<string, NormalizedBindingEntry>;

/**
 * Normalizes any legacy or modern binding representation into the immutable v2 normalized schema:
 * bindings = {
 *   "<variableIndex>": {
 *     source: <path> | "literal",
 *     value?: string (literal only),
 *     fallbackLiteral?: string
 *   }
 * }
 *
 * Handles:
 * - Legacy string path: "customer.firstName"
 * - Legacy literal prefix: "literal:Welcome"
 * - Legacy object without fallback: { source: "customer.firstName" }
 * - Named variable keys (when template is provided, maps name -> index)
 * - Already normalized bindings
 */
export function normalizeBindings(
  rawBindings: unknown,
  template?: SourceTemplate | null
): NormalizedBindings {
  if (!rawBindings || typeof rawBindings !== 'object' || Array.isArray(rawBindings)) {
    return {};
  }

  const result: NormalizedBindings = {};
  const entries = Object.entries(rawBindings as Record<string, unknown>);

  // Build name-to-index map if template is provided
  const nameToIndexMap = new Map<string, number>();
  if (template?.variables) {
    for (const v of template.variables) {
      if (v.name) {
        nameToIndexMap.set(v.name.toLowerCase(), v.index);
      }
      nameToIndexMap.set(String(v.index), v.index);
    }
  }

  for (const [key, val] of entries) {
    // Determine the variable index (1-based string: "1", "2", ...)
    let resolvedIndexKey: string = key;
    if (nameToIndexMap.has(key.toLowerCase())) {
      resolvedIndexKey = String(nameToIndexMap.get(key.toLowerCase())!);
    }

    if (typeof val === 'string') {
      if (val.startsWith('literal:')) {
        result[resolvedIndexKey] = {
          source: 'literal',
          value: val.substring('literal:'.length),
        };
      } else {
        result[resolvedIndexKey] = {
          source: val,
        };
      }
    } else if (val && typeof val === 'object' && !Array.isArray(val)) {
      const obj = val as Record<string, unknown>;
      const source = typeof obj.source === 'string' ? obj.source : (typeof obj.path === 'string' ? obj.path : '');
      const entry: NormalizedBindingEntry = {
        source,
      };

      if (source === 'literal') {
        entry.value = typeof obj.value === 'string' ? obj.value : '';
      } else if (typeof obj.value === 'string') {
        entry.value = obj.value;
      }

      if (typeof obj.fallbackLiteral === 'string') {
        entry.fallbackLiteral = obj.fallbackLiteral;
      }

      result[resolvedIndexKey] = entry;
    }
  }

  return result;
}

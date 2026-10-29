import fs from 'fs';
import path from 'path';
import { logger } from '../logger/logger';
import { BINDING_SOURCES, isSourceAllowedForPreset } from './bindingSources';
import { normalizeBindings } from './normalizeBindings';
import { validateLiteralInput } from './sanitize';

export interface TemplateMappingSuggestionItem {
  templateId: string;
  revision: number;
  language: string;
  presets: Record<string, { bindings: Record<string, any> }>;
}

export interface SuggestionsLoadResult {
  loadedCount: number;
  errorCount: number;
  errors: string[];
}

export interface CatalogueTemplate {
  id: string;
  name: string;
  language: string;
  revision: number;
  variables?: Array<{ index: number; name?: string; type?: string }>;
  bodyText?: string | null;
  status?: string;
  sendable?: boolean;
}

function findFile(relativePath: string): string | null {
  const possiblePaths = [
    path.resolve(process.cwd(), relativePath),
    path.resolve(process.cwd(), `../../${relativePath}`),
    path.resolve(__dirname, `../../../../${relativePath}`),
    path.resolve(__dirname, `../../../${relativePath}`),
    path.resolve(`d:/GROVIEWS/GroVastra/${relativePath}`),
  ];
  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      return p;
    }
  }
  return null;
}

function loadCatalogueTemplates(): Map<string, CatalogueTemplate> {
  const templateMap = new Map<string, CatalogueTemplate>();
  const metaPath = findFile('docs/meta-templates.json');
  if (!metaPath) {
    logger.warn('loadCatalogueTemplates: docs/meta-templates.json not found');
    return templateMap;
  }

  try {
    const raw = fs.readFileSync(metaPath, 'utf-8');
    const data = JSON.parse(raw);
    const templates: CatalogueTemplate[] = data.templates || [];
    for (const t of templates) {
      templateMap.set(t.id, t);
      // Also key by templateId:language
      templateMap.set(`${t.id}:${t.language}`, t);
    }
  } catch (err) {
    logger.error({ err }, 'loadCatalogueTemplates: Failed to parse docs/meta-templates.json');
  }

  return templateMap;
}

class TemplateMappingSuggestionsRegistry {
  private suggestions: Map<string, TemplateMappingSuggestionItem> = new Map();
  private lastLoadResult: SuggestionsLoadResult = { loadedCount: 0, errorCount: 0, errors: [] };

  constructor() {
    this.load();
  }

  load(): SuggestionsLoadResult {
    const filePath = findFile('docs/template-mappings.json');
    if (!filePath) {
      const msg = 'docs/template-mappings.json not found';
      logger.warn(msg);
      this.lastLoadResult = { loadedCount: 0, errorCount: 1, errors: [msg] };
      return this.lastLoadResult;
    }

    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const data = JSON.parse(raw);
      const rawSuggestions = data.suggestions || [];
      const catalogue = loadCatalogueTemplates();

      const newSuggestions = new Map<string, TemplateMappingSuggestionItem>();
      const errors: string[] = [];
      let loadedCount = 0;

      for (const item of rawSuggestions) {
        const { templateId, revision, language, presets } = item;
        const catalogueTemplate = catalogue.get(templateId);

        if (!catalogueTemplate) {
          const err = `Suggestion for template '${templateId}' discarded: template not found in approved catalogue`;
          logger.warn(err);
          errors.push(err);
          continue;
        }

        const templateVars = catalogueTemplate.variables || [];
        const validPresets: Record<string, { bindings: Record<string, any> }> = {};

        for (const [presetKey, presetData] of Object.entries(presets || {})) {
          const bindings = (presetData as any)?.bindings || {};
          const normalized = normalizeBindings(bindings, catalogueTemplate as any);
          const providedIndices = Object.keys(normalized).map(Number).sort((a, b) => a - b);

          // Variable count check
          if (providedIndices.length !== templateVars.length) {
            const err = `Suggestion discarded for template '${templateId}' on preset '${presetKey}': variable count mismatch (template has ${templateVars.length}, suggestion has ${providedIndices.length})`;
            logger.warn(err);
            errors.push(err);
            continue;
          }

          // Exact index check (1..N)
          let hasIndexMismatch = false;
          for (const v of templateVars) {
            if (!providedIndices.includes(v.index)) {
              const err = `Suggestion discarded for template '${templateId}' on preset '${presetKey}': missing variable {{${v.index}}}`;
              logger.warn(err);
              errors.push(err);
              hasIndexMismatch = true;
              break;
            }
          }
          if (hasIndexMismatch) continue;

          // Sources validation
          let hasSourceError = false;
          for (const [key, bDef] of Object.entries(normalized)) {
            if (bDef.source === 'literal') {
              const check = validateLiteralInput(bDef.value);
              if (!check.valid) {
                const err = `Suggestion discarded for template '${templateId}' on preset '${presetKey}': invalid literal for variable {{${key}}}: ${check.error}`;
                logger.warn(err);
                errors.push(err);
                hasSourceError = true;
                break;
              }
            } else {
              const sourceDef = BINDING_SOURCES[bDef.source];
              if (!sourceDef) {
                const err = `Suggestion discarded for template '${templateId}' on preset '${presetKey}': unknown source '${bDef.source}'`;
                logger.warn(err);
                errors.push(err);
                hasSourceError = true;
                break;
              }

              if (presetKey !== '*') {
                const isAllowed = isSourceAllowedForPreset(bDef.source, presetKey);
                if (!isAllowed) {
                  const err = `Suggestion discarded for template '${templateId}' on preset '${presetKey}': source '${bDef.source}' not allowed for preset '${presetKey}'`;
                  logger.warn(err);
                  errors.push(err);
                  hasSourceError = true;
                  break;
                }
              }
            }
          }

          if (hasSourceError) continue;

          validPresets[presetKey] = { bindings: normalized };
        }

        if (Object.keys(validPresets).length > 0) {
          const validItem: TemplateMappingSuggestionItem = {
            templateId,
            revision: revision || catalogueTemplate.revision || 1,
            language: language || catalogueTemplate.language || 'en',
            presets: validPresets,
          };
          newSuggestions.set(templateId, validItem);
          loadedCount += Object.keys(validPresets).length;
        }
      }

      this.suggestions = newSuggestions;
      this.lastLoadResult = {
        loadedCount,
        errorCount: errors.length,
        errors,
      };

      logger.info(
        { loadedTemplates: newSuggestions.size, loadedPresets: loadedCount, errors: errors.length },
        'Template mapping suggestions loaded successfully'
      );

      return this.lastLoadResult;
    } catch (err: any) {
      const msg = `Failed to load template mappings: ${err.message}`;
      logger.error({ err }, msg);
      this.lastLoadResult = { loadedCount: 0, errorCount: 1, errors: [msg] };
      return this.lastLoadResult;
    }
  }

  getSuggestion(
    presetId?: string,
    templateId?: string,
    language?: string
  ): TemplateMappingSuggestionItem | Record<string, any> | null {
    if (!templateId) {
      // Return all suggestions
      const all: Record<string, any> = {};
      for (const [id, item] of this.suggestions.entries()) {
        all[id] = item;
      }
      return all;
    }

    const item = this.suggestions.get(templateId);
    if (!item) return null;

    if (!presetId) {
      return item;
    }

    const normPreset = presetId.toUpperCase().replace(/-/g, '_');
    // Match exact preset, or normalized preset, or wildcard '*'
    for (const [key, val] of Object.entries(item.presets)) {
      if (key === '*' || key.toUpperCase().replace(/-/g, '_') === normPreset) {
        return {
          templateId: item.templateId,
          revision: item.revision,
          language: item.language,
          presetKey: key,
          bindings: val.bindings,
        };
      }
    }

    return null;
  }

  getAll(): Map<string, TemplateMappingSuggestionItem> {
    return this.suggestions;
  }

  getLastResult(): SuggestionsLoadResult {
    return this.lastLoadResult;
  }
}

export const templateMappingSuggestionsRegistry = new TemplateMappingSuggestionsRegistry();

export function loadTemplateMappingSuggestions(): SuggestionsLoadResult {
  return templateMappingSuggestionsRegistry.load();
}

export function reloadTemplateMappingSuggestions(): SuggestionsLoadResult {
  return templateMappingSuggestionsRegistry.load();
}

export function getTemplateMappingSuggestions(
  presetId?: string,
  templateId?: string,
  language?: string
) {
  return templateMappingSuggestionsRegistry.getSuggestion(presetId, templateId, language);
}

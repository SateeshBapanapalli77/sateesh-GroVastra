import { SourceTemplate } from '@grovastra/shared';

export interface MetaTemplateParameterItem {
  type: 'text';
  text: string;
}

export interface MetaTemplateComponent {
  type: 'body';
  parameters: MetaTemplateParameterItem[];
}

export interface MetaTemplatePayload {
  name: string;
  language: {
    code: string;
  };
  components?: MetaTemplateComponent[];
}

export interface MetaSendRequestBody {
  messaging_product: 'whatsapp';
  to: string;
  type: 'template';
  template: MetaTemplatePayload;
}

export type InputParameterSource =
  | Array<{ index?: number; name?: string; text: string }>
  | Record<string, string | number>;

/**
 * Builds the canonical Meta WhatsApp Cloud API template message body.
 *
 * Rules:
 * 1. components key is OMITTED when the template has zero variables.
 * 2. Parameters are strictly sorted by variable index (1, 2, 3...) ascending,
 *    never by dictionary key insertion order.
 * 3. Exactly one body component with type: "body" and text parameters.
 * 4. Only positional body text parameters are supported.
 */
export function buildMetaTemplateBody(
  template: Pick<SourceTemplate, 'name' | 'language' | 'variables'>,
  parameters: InputParameterSource,
  toDigits: string
): MetaSendRequestBody {
  const templateVars = [...(template.variables || [])].sort((a, b) => a.index - b.index);

  const templatePayload: MetaTemplatePayload = {
    name: template.name,
    language: {
      code: template.language,
    },
  };

  if (templateVars.length > 0) {
    const formattedParams: MetaTemplateParameterItem[] = [];

    if (Array.isArray(parameters)) {
      // If parameters is an array of items with index
      const paramMapByIndex = new Map<number, string>();
      const paramMapByName = new Map<string, string>();
      for (const p of parameters) {
        if (p.index !== undefined) {
          paramMapByIndex.set(p.index, String(p.text));
        }
        if (p.name) {
          paramMapByName.set(p.name, String(p.text));
        }
      }

      for (let i = 0; i < templateVars.length; i++) {
        const v = templateVars[i];
        let val = paramMapByIndex.get(v.index);
        if (val === undefined && v.name) {
          val = paramMapByName.get(v.name);
        }
        if (val === undefined && i < parameters.length && parameters[i].index === undefined) {
          val = String(parameters[i].text);
        }
        formattedParams.push({
          type: 'text',
          text: val ?? '',
        });
      }
    } else {
      // If parameters is a dictionary Record<string, string | number>
      for (const v of templateVars) {
        const val =
          parameters[String(v.index)] ??
          (v.name ? parameters[v.name] : undefined) ??
          '';
        formattedParams.push({
          type: 'text',
          text: String(val),
        });
      }
    }

    templatePayload.components = [
      {
        type: 'body',
        parameters: formattedParams,
      },
    ];
  }

  // Sanitize recipient 'to' to digits only
  const cleanTo = toDigits.replace(/\D/g, '');

  return {
    messaging_product: 'whatsapp',
    to: cleanTo,
    type: 'template',
    template: templatePayload,
  };
}

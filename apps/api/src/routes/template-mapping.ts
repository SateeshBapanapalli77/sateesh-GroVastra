import { Router, Request, Response, NextFunction } from 'express';
import {
  getTemplateMappingSuggestions,
  reloadTemplateMappingSuggestions,
  resolveForStep,
  validateTemplateMapping,
} from '../templates';
import { MongoTemplateSourceAdapter } from '../adapters/template-source';

export const templateMappingRouter = Router();
const templateSource = new MongoTemplateSourceAdapter();

/**
 * GET /template-mapping-suggestions
 * Optional query: presetId, templateId, language
 */
templateMappingRouter.get(
  '/template-mapping-suggestions',
  (req: Request, res: Response, next: NextFunction) => {
    try {
      const presetId = req.query.presetId as string | undefined;
      const templateId = req.query.templateId as string | undefined;
      const language = req.query.language as string | undefined;

      const suggestions = getTemplateMappingSuggestions(presetId, templateId, language);
      return res.json({
        success: true,
        data: suggestions,
      });
    } catch (err) {
      return next(err);
    }
  }
);

/**
 * POST /template-mapping/preview
 * Body: { presetId, templateRef: { id, revision, language }, bindings, sampleCustomer?: { firstName } }
 * Renders sample message text using canonical resolveForStep with redactions enforced.
 */
templateMappingRouter.post(
  '/template-mapping/preview',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { presetId, templateRef, bindings, sampleCustomer } = req.body || {};

      if (!templateRef || !templateRef.id) {
        return res.status(400).json({
          success: false,
          error: 'templateRef with id is required',
        });
      }

      const template = await templateSource.getTemplateById(templateRef.id);
      if (!template) {
        return res.status(404).json({
          success: false,
          error: `Template '${templateRef.id}' not found in approved catalogue`,
        });
      }

      // Check validation first
      const validation = validateTemplateMapping({
        template,
        templateRef,
        bindings,
        presetId,
      });

      // Sample context snapshot with dummy values
      const sampleCustomerData = {
        firstName: sampleCustomer?.firstName !== undefined ? sampleCustomer.firstName : 'Lakshmi',
      };

      const tenantId = (req as any).user?.tenantId || 'test_tenant';

      const stepResolution = await resolveForStep({
        tenantId,
        template,
        bindings,
        customer: sampleCustomerData as any,
        overrides: {
          customer: sampleCustomerData as any,
          shopName: 'Sample Boutique',
          occasionLocalDate: '2026-10-24',
          eventDate: '2026-10-24',
          recipientLabel: 'sister',
          bookingLinkUrl: 'https://boutique.example.com/book',
          occasionKind: presetId?.toLowerCase().includes('wedding') ? 'WEDDING' : 'GIFT',
          offerAmountRupees: '50',
          order: {
            orderId: 'ORD-1001',
            orderNumber: 'ORD-1001',
            completedAt: '2026-10-24',
          },
          credit: {
            amount: 15000,
            unit: 'PAISE',
            expiresAt: new Date(Date.now() + 14 * 86400000),
          },
        },
      });

      const resolution = stepResolution.resolution;

      // Hard Rule 9: Redact any sensitive customer fields or phone numbers
      return res.json({
        success: true,
        ok: resolution.ok && validation.valid,
        renderedText: resolution.renderedPreview,
        canonicalParameters: stepResolution.canonicalParameters,
        payloadHash: stepResolution.payloadHash,
        parameters: resolution.parameters.map((p) => ({
          index: p.index,
          name: p.name,
          source: p.source,
          usedFallback: p.usedFallback,
        })),
        paramValues: resolution.paramMap,
        usedFallback: resolution.usedFallback,
        problems: resolution.problems,
        validationErrors: validation.errors,
        validationWarnings: validation.warnings,
      });
    } catch (err) {
      return next(err);
    }
  }
);

/**
 * POST /dev/template-mapping/reload-suggestions
 * Dev-only endpoint to reload /docs/template-mappings.json without restart.
 */
templateMappingRouter.post(
  '/dev/template-mapping/reload-suggestions',
  (req: Request, res: Response, next: NextFunction) => {
    try {
      if (process.env.NODE_ENV === 'production') {
        return res.status(403).json({
          success: false,
          error: 'Dev reload endpoint is forbidden in production',
        });
      }

      const result = reloadTemplateMappingSuggestions();
      return res.json({
        success: true,
        ...result,
      });
    } catch (err) {
      return next(err);
    }
  }
);

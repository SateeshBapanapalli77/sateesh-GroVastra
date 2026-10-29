import { Router, Request, Response, NextFunction } from 'express';
import { authenticate, requireRole } from '../middleware/auth';
import { mockTemplateSource } from '../adapters';
import { readinessService } from '../services/readiness.service';
import { TemplateCatalogueResponse } from '@grovastra/shared';

export const integrationRouter = Router();

const integrationGuards = [authenticate, requireRole('owner', 'admin')];

/**
 * Handler for GET /approved-template-catalogue
 * Returns read-only WhatsApp template catalogue with exact locale, category, variables, and sendable badge.
 */
async function getApprovedTemplateCatalogueHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const { category, sendable, source } = req.query;

    const filter: { category?: string; sendable?: boolean; source?: string } = {};
    if (typeof category === 'string' && category.trim()) {
      filter.category = category.trim().toUpperCase();
    }
    if (typeof sendable === 'string') {
      filter.sendable = sendable.toLowerCase() === 'true';
    }
    if (typeof source === 'string' && source.trim()) {
      filter.source = source.trim().toUpperCase();
    }

    const templates = await mockTemplateSource.listTemplates(filter);
    const allTemplates = await mockTemplateSource.listTemplates();

    const response: TemplateCatalogueResponse = {
      templates,
      total: templates.length,
      sendableCount: allTemplates.filter((t) => t.sendable).length,
      metaProvidedCount: allTemplates.filter((t) => t.source === 'META_PROVIDED').length,
      dummyCount: allTemplates.filter((t) => t.source === 'DUMMY').length,
    };

    res.status(200).json(response);
  } catch (err) {
    next(err);
  }
}

/**
 * Handler for GET /integration/readiness
 * Evaluates tenant's WhatsApp connection, token environment configuration, allowlist, and sendable templates.
 * Returns failure reasons and designated fix owners.
 * Under NO circumstances is the actual token or secret value exposed.
 */
async function getIntegrationReadinessHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const tenantId = req.tenantContext!.tenantId;
    const report = await readinessService.getTenantReadiness(tenantId);

    res.status(200).json(report);
  } catch (err) {
    next(err);
  }
}

// Mount both standard routes and /api/v1 prefixed aliases
integrationRouter.get('/approved-template-catalogue', ...integrationGuards, getApprovedTemplateCatalogueHandler);
integrationRouter.get('/api/v1/approved-template-catalogue', ...integrationGuards, getApprovedTemplateCatalogueHandler);

integrationRouter.get('/integration/readiness', ...integrationGuards, getIntegrationReadinessHandler);
integrationRouter.get('/api/v1/integration/readiness', ...integrationGuards, getIntegrationReadinessHandler);

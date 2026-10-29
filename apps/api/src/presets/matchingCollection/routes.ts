/**
 * matchingCollection routes — F26
 *
 * Routes for testing, managing and previewing Matching Collection campaigns:
 *   POST /dev/matching-collection/trigger-published  — simulate collection.published event
 *   POST /dev/matching-collection/trigger-withdrawn  — simulate collection.withdrawn event
 *   GET  /dev/matching-collection/collections        — inspect collections in src_collections
 *   GET  /dev/matching-collection/enrollments        — inspect enrollments for matching_collection
 *   GET  /campaigns/:campaignId/collection-preview   — preview customer affinity for a collection
 */

import crypto from 'crypto';
import { Router, Request, Response, NextFunction } from 'express';
import {
  AUTH_COOKIE_NAME,
  ENROLLMENT_STATUS,
  normalizePreferences,
} from '@grovastra/shared';
import { authenticate, requireRole } from '../../middleware/auth';
import {
  CampaignModel,
  CampaignVersionModel,
  CampaignEnrollmentModel,
  SrcCustomerModel,
} from '../../db/models';
import { SrcCollectionModel } from '../../db/models/src-collection.model';
import { eventConsumerService } from '../../services/event-consumer';
import { clock } from '../../services/clock';
import { NotFoundError, ValidationError } from '../../errors/app-error';
import { scoreAffinityForCollection, evaluateAffinityEligibility } from './matching';
import { MATCHING_COLLECTION_ID, MATCHING_COLLECTION_ALIAS } from './definition';

export const matchingCollectionRouter = Router();

// Middleware: allow dev routes in test/dev
matchingCollectionRouter.use((req: Request, res: Response, next: NextFunction) => {
  if (req.path.startsWith('/dev/')) {
    if (process.env.NODE_ENV === 'production') {
      return res.status(404).json({ error: 'Not Found' });
    }
    if (req.headers.authorization || (req.cookies && req.cookies[AUTH_COOKIE_NAME])) {
      return authenticate(req, res, next);
    }
    const tenantId = (req.headers['x-tenant-id'] as string) || 'shop_a';
    req.tenantContext = {
      tenantId,
      userId: 'dev-user',
      role: 'owner',
      branchIds: ['branch_main'],
      email: 'dev@example.com',
    };
    return next();
  }
  return authenticate(req, res, next);
});

/**
 * POST /dev/matching-collection/trigger-published
 * Simulates a collection.published event.
 */
matchingCollectionRouter.post(
  '/dev/matching-collection/trigger-published',
  requireRole('owner', 'admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = req.tenantContext!.tenantId;
      const { releaseId, title, name, description, branchId, items, entityVersion, publishedAt } = req.body;

      if (!releaseId) {
        throw new ValidationError('releaseId is required');
      }

      const eventId = `evt_col_pub_${crypto.randomUUID().slice(0, 10)}`;
      const occurredAt = publishedAt || clock.now().toISOString();

      const eventDoc = await eventConsumerService.ingestEvent({
        schemaVersion: 1,
        producer: 'collections',
        eventId,
        tenantId,
        type: 'collection.published',
        entityId: releaseId,
        entityVersion: entityVersion || 1,
        occurredAt,
        data: {
          title: title || name || 'New Collection',
          name: name || title || 'New Collection',
          description: description || null,
          branchId: branchId || null,
          items: items || [],
          publishedAt: occurredAt,
        },
      });

      return res.status(200).json({
        ok: true,
        eventId,
        releaseId,
        status: eventDoc.status,
        effects: (eventDoc as any).effects,
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /dev/matching-collection/trigger-withdrawn
 * Simulates a collection.withdrawn event.
 */
matchingCollectionRouter.post(
  '/dev/matching-collection/trigger-withdrawn',
  requireRole('owner', 'admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = req.tenantContext!.tenantId;
      const { releaseId, entityVersion, withdrawnAt } = req.body;

      if (!releaseId) {
        throw new ValidationError('releaseId is required');
      }

      const eventId = `evt_col_wdr_${crypto.randomUUID().slice(0, 10)}`;
      const occurredAt = withdrawnAt || clock.now().toISOString();

      const eventDoc = await eventConsumerService.ingestEvent({
        schemaVersion: 1,
        producer: 'collections',
        eventId,
        tenantId,
        type: 'collection.withdrawn',
        entityId: releaseId,
        entityVersion: entityVersion || 2,
        occurredAt,
        data: {
          withdrawnAt: occurredAt,
        },
      });

      return res.status(200).json({
        ok: true,
        eventId,
        releaseId,
        status: eventDoc.status,
        effects: (eventDoc as any).effects,
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /dev/matching-collection/collections
 * Lists collections in src_collections for this tenant.
 */
matchingCollectionRouter.get(
  '/dev/matching-collection/collections',
  requireRole('owner', 'admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = req.tenantContext!.tenantId;
      const collections = await SrcCollectionModel.find({ tenantId })
        .sort({ publishedAt: -1 })
        .lean();

      return res.status(200).json({
        ok: true,
        total: collections.length,
        collections,
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /dev/matching-collection/enrollments
 * Lists enrollments for matching_collection campaigns for this tenant.
 */
matchingCollectionRouter.get(
  '/dev/matching-collection/enrollments',
  requireRole('owner', 'admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = req.tenantContext!.tenantId;
      const { releaseId, status } = req.query;

      const query: Record<string, unknown> = {
        tenantId,
        occurrenceId: { $regex: '^collection:' },
      };

      if (releaseId) {
        query.occurrenceId = { $regex: `^collection:${releaseId}:` };
      }
      if (status) {
        query.status = status;
      }

      const enrollments = await CampaignEnrollmentModel.find(query)
        .sort({ createdAt: -1 })
        .limit(100)
        .lean();

      return res.status(200).json({
        ok: true,
        total: enrollments.length,
        enrollments,
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /campaigns/:campaignId/collection-preview
 * Previews customer matching for a given releaseId against this campaign.
 */
matchingCollectionRouter.get(
  '/campaigns/:campaignId/collection-preview',
  requireRole('owner', 'admin', 'staff'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = req.tenantContext!.tenantId;
      const { campaignId } = req.params;
      const releaseId = req.query.releaseId as string;

      if (!releaseId) {
        throw new ValidationError('releaseId query parameter is required');
      }

      const campaign = await CampaignModel.findOne({ tenantId, campaignId }).lean();
      if (!campaign) {
        throw new NotFoundError(`Campaign ${campaignId} not found`);
      }

      const version = await CampaignVersionModel.findOne({
        tenantId,
        campaignId,
        isPublished: true,
      })
        .sort({ version: -1 })
        .lean();

      if (!version) {
        throw new NotFoundError(`No published version found for campaign ${campaignId}`);
      }

      const collection = (await SrcCollectionModel.findOne({ tenantId, releaseId }).lean()) as any;
      if (!collection) {
        throw new NotFoundError(`Collection ${releaseId} not found`);
      }

      const minAffinityScore = (version as any).minAffinityScore ?? 0.0;

      // Sample first 50 opted-in customers to preview affinity
      const customers = await SrcCustomerModel.find({
        tenantId,
        deletedAt: null,
        status: { $nin: ['DELETED', 'OPTED_OUT'] },
        'consent.marketingOptIn': true,
      })
        .limit(50)
        .lean();

      const previewResults = customers.map((c) => {
        const norm = normalizePreferences(c.preferences as any);
        const affinity = scoreAffinityForCollection(norm, collection.items as any, minAffinityScore);
        const eligibility = evaluateAffinityEligibility(affinity, minAffinityScore);
        return {
          customerId: c.customerId,
          name: `${c.firstName || ''} ${c.lastName || ''}`.trim(),
          score: affinity.score,
          eligible: eligibility.eligible,
          explanation: affinity.explanation,
          bestMatchItem: affinity.bestMatchItem
            ? {
                productId: affinity.bestMatchItem.productId,
                name: affinity.bestMatchItem.name,
              }
            : null,
        };
      });

      const eligibleCount = previewResults.filter((r) => r.eligible).length;

      return res.status(200).json({
        ok: true,
        releaseId,
        collectionTitle: collection.title,
        itemCount: collection.items.length,
        minAffinityScore,
        sampledCount: customers.length,
        eligibleCount,
        results: previewResults,
      });
    } catch (err) {
      next(err);
    }
  }
);

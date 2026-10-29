/**
 * requestedItemAvailable routes — F25
 *
 * Dev routes:
 *   POST /dev/requested-item-available/trigger-stock   — simulate stock.published event
 *   GET  /dev/requested-item-available/enrollments     — inspect enrollments for the preset
 */

import crypto from 'crypto';
import mongoose from 'mongoose';
import { Router, Request, Response, NextFunction } from 'express';
import {
  AUTH_COOKIE_NAME,
  ENROLLMENT_STATUS,
  EXECUTION_STATE,
} from '@grovastra/shared';
import { authenticate, requireRole } from '../../middleware/auth';
import {
  CampaignModel,
  CampaignVersionModel,
  CampaignEnrollmentModel,
  CampaignExecutionModel,
  CampaignGoalEventModel,
  SrcRequestModel,
} from '../../db/models';
import { eventConsumerService } from '../../services/event-consumer';
import { clock } from '../../services/clock';
import { NotFoundError, ValidationError } from '../../errors/app-error';
import { mockRequestSource } from '../../adapters/request-source';
import { mockCustomerSource } from '../../adapters/customer-source';
import { mockProductSource } from '../../adapters/product-source';

export const requestedItemAvailableRouter = Router();

// Middleware: allow dev routes in test/dev
requestedItemAvailableRouter.use((req: Request, res: Response, next: NextFunction) => {
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
 * POST /dev/requested-item-available/trigger-stock
 * Simulates a stock.published event for testing the F25 preset.
 * Body: { items: [{ productId, variantId?, sellableQtyBefore?, sellableQtyAfter }] }
 */
requestedItemAvailableRouter.post(
  [
    '/dev/requested-item-available/trigger-stock',
    '/api/v1/dev/requested-item-available/trigger-stock',
  ],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = req.tenantContext!.tenantId;
      const now = clock.now();
      const { items = [] } = req.body;

      if (!Array.isArray(items) || items.length === 0) {
        return res.status(422).json({
          error: 'VALIDATION_ERROR',
          message: 'items must be a non-empty array of { productId, sellableQtyAfter }',
        });
      }

      const eventId = `evt_stock_dev_${crypto.randomUUID().slice(0, 10)}`;
      const payload = {
        schemaVersion: 1,
        id: eventId,
        type: 'stock.published',
        source: '/inventory',
        time: now.toISOString(),
        datacontenttype: 'application/json',
        data: { source: 'DEV_TRIGGER', items },
      };

      const result = await eventConsumerService.ingestEvent({
        id: eventId,
        tenantId,
        producer: 'inventory',
        eventType: 'stock.published',
        entityId: `pub_dev_${crypto.randomUUID().slice(0, 8)}`,
        entityVersion: 1,
        payload,
        occurredAt: now,
      });

      return res.status(200).json({ success: true, eventId, result });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /dev/requested-item-available/enrollments
 * Inspect all enrollments for the requested_item_available preset.
 */
requestedItemAvailableRouter.get(
  [
    '/dev/requested-item-available/enrollments',
    '/api/v1/dev/requested-item-available/enrollments',
  ],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = req.tenantContext!.tenantId;

      const enrollments = await CampaignEnrollmentModel.find({
        tenantId,
        occurrenceId: { $regex: '^request:' },
      })
        .sort({ createdAt: -1 })
        .limit(50)
        .lean();

      const enriched = await Promise.all(
        enrollments.map(async (enr) => {
          const executions = await CampaignExecutionModel.find({
            tenantId,
            enrollmentId: enr.enrollmentId,
          }).lean();
          return { ...enr, executions };
        })
      );

      return res.json({ enrollments: enriched, count: enriched.length });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /dev/requested-item-available/requests
 * Inspect all src_requests for the tenant.
 */
requestedItemAvailableRouter.get(
  [
    '/dev/requested-item-available/requests',
    '/api/v1/dev/requested-item-available/requests',
  ],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = req.tenantContext!.tenantId;
      const requests = await SrcRequestModel.find({ tenantId })
        .sort({ createdAt: -1 })
        .limit(100)
        .lean();
      return res.json({ requests, count: requests.length });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /requests & /api/v1/requests
 * Paginated read-only customer requests listing.
 */
requestedItemAvailableRouter.get(
  ['/requests', '/api/v1/requests'],
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = req.tenantContext!.tenantId;
      const { status, customerId, productId, page = '1', limit = '20' } = req.query;

      const pageNum = Math.max(1, parseInt(page as string, 10) || 1);
      const limitNum = Math.min(100, Math.max(1, parseInt(limit as string, 10) || 20));
      const skip = (pageNum - 1) * limitNum;

      const filter: any = { tenantId };
      if (status && typeof status === 'string') filter.status = status;
      if (customerId && typeof customerId === 'string') filter.customerId = customerId;
      if (productId && typeof productId === 'string') filter['itemRef.productId'] = productId;

      const [requests, total] = await Promise.all([
        SrcRequestModel.find(filter)
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(limitNum)
          .lean(),
        SrcRequestModel.countDocuments(filter),
      ]);

      return res.json({
        requests,
        total,
        page: pageNum,
        totalPages: Math.ceil(total / limitNum) || 1,
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /campaigns/:id/requested-item/summary & /campaigns/:id/requested-item-available/summary
 * Observational report only.
 */
requestedItemAvailableRouter.get(
  [
    '/campaigns/:id/requested-item/summary',
    '/api/v1/campaigns/:id/requested-item/summary',
    '/campaigns/:id/requested-item-available/summary',
    '/api/v1/campaigns/:id/requested-item-available/summary',
  ],
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = req.tenantContext!.tenantId;
      const campaignId = req.params.id;

      const campaign = await CampaignModel.findOne({ tenantId, campaignId }).lean();
      if (!campaign) {
        throw new NotFoundError(`Campaign '${campaignId}' not found`);
      }

      const enrollments = await CampaignEnrollmentModel.find({ tenantId, campaignId }).lean<any[]>();
      const totalEnrollments = enrollments.length;

      const excludedByReason: Record<string, number> = {};
      let activeCount = 0;
      let completedCount = 0;
      let cancelledCount = 0;

      for (const enr of enrollments) {
        if (enr.status === ENROLLMENT_STATUS.EXCLUDED && enr.exclusionReason) {
          excludedByReason[enr.exclusionReason] = (excludedByReason[enr.exclusionReason] || 0) + 1;
        } else if (enr.status === ENROLLMENT_STATUS.ACTIVE) {
          activeCount++;
        } else if (enr.status === ENROLLMENT_STATUS.COMPLETED) {
          completedCount++;
        } else if (enr.status === ENROLLMENT_STATUS.CANCELLED) {
          cancelledCount++;
        }
      }

      const executions = await CampaignExecutionModel.find({ tenantId, campaignId }).lean<any[]>();
      let scheduledCount = 0;
      let deferredCount = 0;
      let sentCount = 0;
      let deliveredCount = 0;
      let readCount = 0;
      const skippedByReason: Record<string, number> = {};

      for (const exec of executions) {
        switch (exec.state) {
          case EXECUTION_STATE.SCHEDULED:
            scheduledCount++;
            break;
          case EXECUTION_STATE.DEFERRED:
            deferredCount++;
            break;
          case EXECUTION_STATE.SKIPPED:
            if (exec.skipReason) {
              skippedByReason[exec.skipReason] = (skippedByReason[exec.skipReason] || 0) + 1;
            }
            break;
          case EXECUTION_STATE.PROVIDER_ACCEPTED:
          case 'SENT':
            sentCount++;
            break;
          case 'DELIVERED':
            sentCount++;
            deliveredCount++;
            break;
          case 'READ':
            sentCount++;
            deliveredCount++;
            readCount++;
            break;
        }
      }

      const goalEvents = await CampaignGoalEventModel.find({ tenantId, campaignId }).lean<any[]>();
      const goalCount = goalEvents.length;

      return res.json({
        campaignId,
        totalEnrollments,
        activeCount,
        completedCount,
        cancelledCount,
        scheduledCount,
        deferredCount,
        sentCount,
        deliveredCount,
        readCount,
        goalCount,
        excludedByReason,
        skippedByReason,
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /campaigns/:id/requested-item/preview & /campaigns/:id/requested-item-available/preview
 * Body: { requestId }
 * READ-ONLY preview of eligibility and template rendering. Zero live writes.
 */
requestedItemAvailableRouter.post(
  [
    '/campaigns/:id/requested-item/preview',
    '/api/v1/campaigns/:id/requested-item/preview',
    '/campaigns/:id/requested-item-available/preview',
    '/api/v1/campaigns/:id/requested-item-available/preview',
  ],
  authenticate,
  requireRole('owner', 'admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = req.tenantContext!.tenantId;
      const campaignId = req.params.id;
      const { requestId } = req.body;

      if (!requestId) {
        throw new ValidationError('requestId is required in preview request body');
      }

      const campaign: any = await CampaignModel.findOne({ tenantId, campaignId }).lean();
      if (!campaign) {
        throw new NotFoundError(`Campaign '${campaignId}' not found`);
      }

      let version: any = await CampaignVersionModel.findOne({
        tenantId,
        campaignId,
        version: campaign.draftVersion,
      }).lean();

      if (!version && campaign.activeVersionId && mongoose.isValidObjectId(campaign.activeVersionId)) {
        version = await CampaignVersionModel.findById(campaign.activeVersionId).lean();
      }

      if (!version) {
        version = await CampaignVersionModel.findOne({ tenantId, campaignId }).sort({ version: -1 }).lean();
      }

      if (!version) {
        throw new NotFoundError(`Campaign version not found for campaign '${campaignId}'`);
      }

      const requestDoc = await mockRequestSource.getRequest(tenantId, requestId);
      if (!requestDoc) {
        throw new NotFoundError(`Request '${requestId}' not found`);
      }

      const customer = await mockCustomerSource.getCustomerById(tenantId, requestDoc.customerId);
      const product = await mockProductSource.getProductById(tenantId, requestDoc.itemRef.productId);

      const isEligible =
        requestDoc.status === 'OPEN' &&
        customer &&
        customer.status !== 'DELETED' &&
        customer.consent?.marketingOptIn !== false &&
        customer.consent?.channelSuppressed !== true;

      const step = version.steps?.[0];
      const templateId = step?.templateRef?.id || 'tpl_request_available_one';

      return res.json({
        campaignId,
        requestId,
        customerId: requestDoc.customerId,
        productId: requestDoc.itemRef.productId,
        productName: product?.name || requestDoc.itemRef.productId,
        isEligible: Boolean(isEligible),
        templateId,
        status: requestDoc.status,
      });
    } catch (err) {
      next(err);
    }
  }
);

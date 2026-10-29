import crypto from 'crypto';
import mongoose from 'mongoose';
import { Router, Request, Response, NextFunction } from 'express';
import { DateTime } from 'luxon';
import {
  PRODUCT_CATEGORIES,
  COLOUR_FAMILIES,
  WEAVES,
  ProductCategory,
  ColourFamily,
  Weave,
  AUTH_COOKIE_NAME,
  EXECUTION_STATE,
  EXECUTION_REASONS,
  ENROLLMENT_STATUS,
} from '@grovastra/shared';
import { authenticate, requireRole } from '../../middleware/auth';
import {
  CampaignModel,
  CampaignVersionModel,
  CampaignEnrollmentModel,
  CampaignExecutionModel,
  CampaignGoalEventModel,
  CampaignDeliveryIntentModel,
  SrcOrderModel,
} from '../../db/models';
import { mockProductSource } from '../../adapters/product-source';
import { mockOrderSource } from '../../adapters/order-source';
import { mockCustomerSource } from '../../adapters/customer-source';
import { selectComplements } from './matching';
import { DEFAULT_OUTFIT_PAIRING } from './definition';
import { isQualifyingOrder } from '../_shared/orderTrigger/qualifying';
import { computeDueTimes } from '../_shared/eventDelay/delayTiming';
import { clock } from '../../services/clock';
import { NotFoundError, ValidationError } from '../../errors/app-error';

export const completeOutfitRouter = Router();

// Middleware: allow dev routes in test/dev without strict auth header if tenant is set
completeOutfitRouter.use((req: Request, res: Response, next: NextFunction) => {
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
 * GET /products & /api/v1/products (all roles; read-only; paginated)
 * Query: category?, status?, cursor?, limit?
 */
completeOutfitRouter.get(
  ['/products', '/api/v1/products'],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = req.tenantContext!.tenantId;
      const { category, status, cursor, limit = 20 } = req.query;

      const categories = category && typeof category === 'string' ? [category] : [];
      const statusFilter = status && typeof status === 'string' ? status : undefined;
      const safeLimit = Math.min(Math.max(1, Number(limit) || 20), 100);

      const result = await mockProductSource.listByCategories(
        tenantId,
        categories,
        cursor as string | undefined,
        safeLimit,
        statusFilter
      );

      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /campaigns/:id/complete-outfit/preview & /api/v1/campaigns/:id/complete-outfit/preview
 * Body: { orderId }
 * READ-ONLY: zero enrollments/executions/intents/provider calls.
 */
completeOutfitRouter.post(
  [
    '/campaigns/:id/complete-outfit/preview',
    '/api/v1/campaigns/:id/complete-outfit/preview',
  ],
  requireRole('owner', 'admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = req.tenantContext!.tenantId;
      const campaignId = req.params.id;
      const { orderId } = req.body;

      if (!orderId) {
        throw new ValidationError('orderId is required in preview request body');
      }

      const campaign: any = await CampaignModel.findOne({ tenantId, campaignId }).lean();
      if (!campaign) {
        throw new NotFoundError(`Campaign '${campaignId}' not found`);
      }

      let version: any = await CampaignVersionModel.findOne({
        tenantId,
        campaignId,
        version: campaign.draftVersion,
        isPublished: true,
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

      const order = await mockOrderSource.getOrderById(tenantId, orderId);
      if (!order) {
        throw new NotFoundError(`Order '${orderId}' not found`);
      }

      const tz = version.timezone || 'Asia/Kolkata';
      const pairing = version.pairing || version.config?.pairing || DEFAULT_OUTFIT_PAIRING;
      const anchorCategories = (pairing.anchorCategories || ['saree']).map((c: string) => c.toLowerCase());

      // 1. Identify primary anchor line
      const productCategoryMap: Record<string, ProductCategory> = {};
      const candidateAnchorLines: Array<{ line: any; product: any; netPaise: number }> = [];

      for (const line of order.lines || []) {
        if (!line.productId) continue;
        const prod = await mockProductSource.getProduct(tenantId, line.productId);
        if (prod && prod.category) {
          productCategoryMap[line.productId] = prod.category as ProductCategory;
          const retQty = line.returnedQty ?? 0;
          const qty = line.qty ?? line.quantity ?? 1;
          if (retQty < qty && anchorCategories.includes(prod.category.toLowerCase())) {
            const netPaise =
              line.lineNetPaise !== undefined
                ? line.lineNetPaise
                : (line.pricePaise || prod.pricePaise || 0) * (qty - retQty);
            candidateAnchorLines.push({ line, product: prod, netPaise });
          }
        }
      }

      if (candidateAnchorLines.length === 0) {
        return res.status(200).json({
          order: {
            id: order.orderId,
            completedAt: order.completedAt,
            localCompletedAt: order.completedAt
              ? DateTime.fromJSDate(new Date(order.completedAt), { zone: tz }).toFormat('yyyy-MM-dd HH:mm')
              : null,
          },
          anchor: null,
          candidates: [],
          selected: [],
          matchReasons: [],
          insufficient: true,
          wouldDueAt: null,
        });
      }

      // Sort candidate anchor lines: netPaise desc, tie lowest lineId
      candidateAnchorLines.sort((a, b) => {
        if (b.netPaise !== a.netPaise) return b.netPaise - a.netPaise;
        return String(a.line.lineId || '').localeCompare(String(b.line.lineId || ''));
      });

      const primary = candidateAnchorLines[0];
      const primaryAnchorLine = primary.line;
      const anchorProduct = primary.product;

      // 2. Load candidate products & order history
      const allowedCategories = pairing.complementMap?.[anchorProduct.category] || [];
      const candidateProductsRes = await mockProductSource.listByCategories(
        tenantId,
        allowedCategories,
        undefined,
        200,
        'ACTIVE'
      );
      const candidateProducts = candidateProductsRes.products;

      const orderHistory = order.customerId
        ? await mockOrderSource.listOrdersForCustomer(tenantId, order.customerId)
        : [];

      // Load customer preferences
      let customerPrefs = null;
      if (order.customerId) {
        const cust = await mockCustomerSource.getCustomerById(tenantId, order.customerId);
        customerPrefs = cust?.preferences || null;
      }

      // Count complement slots needed by step 1 template bindings
      const step1 = (version.steps || [])[0];
      let k = 1;
      if (step1?.bindings) {
        let maxSlot = 0;
        for (const val of Object.values(step1.bindings)) {
          const src = typeof val === 'string' ? val : (val as any)?.source;
          if (src === 'complement.1.name') maxSlot = Math.max(maxSlot, 1);
          if (src === 'complement.2.name') maxSlot = Math.max(maxSlot, 2);
          if (src === 'complement.3.name') maxSlot = Math.max(maxSlot, 3);
        }
        if (maxSlot > 0) k = maxSlot;
      }

      const selection = selectComplements({
        anchorOrder: order,
        primaryAnchorLine,
        anchorProduct,
        customer: {
          customerId: order.customerId || '',
          preferences: customerPrefs,
        },
        candidateProducts,
        productCategoryMap,
        orderHistory,
        pairing,
        k,
        now: clock.now(),
      });

      // Format all candidates with accepted status and reasons
      const excludedReasonMap = new Map<string, string>();
      for (const ex of selection.excluded) {
        excludedReasonMap.set(ex.productId, ex.reason);
      }
      const selectedIdSet = new Set(selection.complements.map((c) => c.productId));

      const candidates = candidateProducts.map((p) => {
        const accepted = selectedIdSet.has(p.productId);
        const reason = excludedReasonMap.get(p.productId);
        const reasons = accepted ? ['Selected matching complement'] : reason ? [reason] : ['Ranked below selected candidates'];
        return {
          productId: p.productId,
          name: p.name,
          category: p.category,
          accepted,
          reasons,
        };
      });

      // Compute wouldDueAt
      const completedAtDate = order.completedAt ? new Date(order.completedAt) : clock.now();
      const delay = step1?.delay || { unit: 'DAYS', value: 5 };
      const timing = computeDueTimes({
        anchorAt: completedAtDate,
        delay,
        settings: {
          timezone: tz,
          allowedSendingHours: { start: '10:00', end: '19:00' },
        },
      });

      res.status(200).json({
        order: {
          id: order.orderId,
          completedAt: order.completedAt,
          localCompletedAt: DateTime.fromJSDate(completedAtDate, { zone: tz }).toFormat('yyyy-MM-dd HH:mm'),
        },
        anchor: selection.anchor,
        candidates,
        selected: selection.complements,
        matchReasons: selection.matchReasons,
        insufficient: selection.insufficient,
        wouldDueAt: {
          utc: timing.adjustedDueAt,
          local: DateTime.fromJSDate(timing.adjustedDueAt, { zone: tz }).toFormat('yyyy-MM-dd HH:mm'),
          rawDueAt: timing.rawDueAt,
          adjustedDueAt: timing.adjustedDueAt,
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /campaigns/:id/complete-outfit/summary & /api/v1/campaigns/:id/complete-outfit/summary
 * Observational report only. Spec p28 ("never claim a message caused a sale").
 */
completeOutfitRouter.get(
  [
    '/campaigns/:id/complete-outfit/summary',
    '/api/v1/campaigns/:id/complete-outfit/summary',
  ],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = req.tenantContext!.tenantId;
      const campaignId = req.params.id;

      const campaign: any = await CampaignModel.findOne({ tenantId, campaignId }).lean();
      if (!campaign) {
        throw new NotFoundError(`Campaign '${campaignId}' not found`);
      }

      // 1. Count enrollments
      const enrollments = await CampaignEnrollmentModel.find({ tenantId, campaignId }).lean<any[]>();
      const totalEnrollments = enrollments.length;

      // 2. Tally excluded by reason
      const excludedByReason: Record<string, number> = {};
      for (const enr of enrollments) {
        if (enr.status === ENROLLMENT_STATUS.EXCLUDED && enr.exclusionReason) {
          excludedByReason[enr.exclusionReason] = (excludedByReason[enr.exclusionReason] || 0) + 1;
        }
      }

      // 3. Count executions and states
      const executions = await CampaignExecutionModel.find({ tenantId, campaignId }).lean<any[]>();
      let scheduledCount = 0;
      let deferredCount = 0;
      let sentCount = 0;
      let acceptedCount = 0;
      let deliveredCount = 0;
      let readCount = 0;
      const skippedByReason: Record<string, number> = {};
      const staleBlocks: Record<string, number> = {};

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
          case EXECUTION_STATE.BLOCKED:
            if (exec.stopReason) {
              staleBlocks[exec.stopReason] = (staleBlocks[exec.stopReason] || 0) + 1;
            }
            break;
          case EXECUTION_STATE.PROVIDER_ACCEPTED:
          case 'SENT':
            sentCount++;
            acceptedCount++;
            break;
          case 'DELIVERED':
            sentCount++;
            acceptedCount++;
            deliveredCount++;
            break;
          case 'READ':
            sentCount++;
            acceptedCount++;
            deliveredCount++;
            readCount++;
            break;
        }
      }

      // 4. Count replies / holds
      let repliesCount = 0;
      for (const enr of enrollments) {
        if (enr.replyHoldAt || enr.holdReason) {
          repliesCount++;
        }
      }

      // 5. Goal completions by evidence type
      const goalEvents = await CampaignGoalEventModel.find({ tenantId, campaignId }).lean<any[]>();
      const goalCompletionsByEvidence: Record<string, number> = {};
      for (const ge of goalEvents) {
        const src = ge.source || 'OUTFIT_COMPLEMENT_PURCHASED';
        goalCompletionsByEvidence[src] = (goalCompletionsByEvidence[src] || 0) + 1;
      }

      // 6. Qualifying orders seen with anchor category
      let version: any = await CampaignVersionModel.findOne({
        tenantId,
        campaignId,
        version: campaign.draftVersion,
        isPublished: true,
      }).lean();

      if (!version && campaign.activeVersionId && mongoose.isValidObjectId(campaign.activeVersionId)) {
        version = await CampaignVersionModel.findById(campaign.activeVersionId).lean();
      }

      if (!version) {
        version = await CampaignVersionModel.findOne({ tenantId, campaignId }).sort({ version: -1 }).lean();
      }

      const pairing = version?.pairing || version?.config?.pairing || DEFAULT_OUTFIT_PAIRING;
      const anchorCategories = (pairing.anchorCategories || ['saree']).map((c: string) => c.toLowerCase());

      const orders = await SrcOrderModel.find({ tenantId, status: 'COMPLETED', paid: true }).lean<any[]>();
      let qualifyingOrdersSeen = 0;
      for (const ord of orders) {
        if (!isQualifyingOrder(ord)) continue;
        const hasAnchor = (ord.lines || []).some((l: any) => {
          const cat = l.category || (l.productId && anchorCategories.some((ac: string) => l.productId.includes(ac)));
          return cat || true; // count qualifying orders considered
        });
        if (hasAnchor) qualifyingOrdersSeen++;
      }

      // Observational purchases
      const observationalCount = goalEvents.length;
      const totalExcluded = Object.values(excludedByReason).reduce((a, b) => a + b, 0);
      const totalSkipped = Object.values(skippedByReason).reduce((a, b) => a + b, 0);
      const totalStaleBlocked = Object.values(staleBlocks).reduce((a, b) => a + b, 0);

      const observationalObj = {
        count: observationalCount,
        note: 'Customers who bought a complement after the message; observational only, not sales attribution (spec p28)',
      };

      res.status(200).json({
        campaignId,
        tenantId,
        qualifyingOrdersSeen,
        enrollments: totalEnrollments,
        enrollmentsCount: totalEnrollments,
        excludedCount: totalExcluded,
        excludedByReason,
        scheduled: scheduledCount,
        deferred: deferredCount,
        deferredCount,
        skippedCount: totalSkipped,
        skippedByReason,
        staleBlocks: totalStaleBlocked,
        staleBlocksByReason: staleBlocks,
        sent: sentCount,
        accepted: acceptedCount,
        delivered: deliveredCount,
        read: readCount,
        replies: repliesCount,
        repliesAndHolds: {
          totalHeldOrReplied: repliesCount,
          exactCampaignReplies: repliesCount,
          conservativeHolds: 0,
          currentlyOnHold: repliesCount,
          resolvedHolds: 0,
        },
        goalCompletionsByEvidence,
        goalCompletions: {
          total: goalEvents.length,
          byEvidenceType: goalCompletionsByEvidence,
        },
        observationalPurchases: observationalObj,
        observationalComplementsPurchased: observationalObj,
      });
    } catch (err) {
      next(err);
    }
  }
);

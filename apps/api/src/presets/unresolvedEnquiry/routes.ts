import { Router, Request, Response, NextFunction } from 'express';
import { authenticate } from '../../middleware/auth';
import {
  CampaignModel,
  CampaignVersionModel,
  CampaignEnrollmentModel,
  CampaignExecutionModel,
  CampaignDeliveryIntentModel,
  CampaignGoalEventModel,
  SrcEnquiryModel,
  SrcProductModel,
  SrcCustomerModel,
} from '../../db/models';
import {
  ENROLLMENT_STATUS,
  EXECUTION_STATE,
  EXECUTION_REASONS,
  HOLD_REASON,
} from '@grovastra/shared';
import { mockCustomerSource } from '../../adapters';
import { NotFoundError } from '../../errors/app-error';
import { clock } from '../../services/clock';
import { logger } from '../../logger';

export const unresolvedEnquiryRouter = Router();

import { AUTH_COOKIE_NAME } from '@grovastra/shared';

// All production routes require authentication; allow dev routes for testing
unresolvedEnquiryRouter.use((req: Request, res: Response, next: NextFunction) => {
  if (req.path.startsWith('/dev/')) {
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
 * GET /enquiries?customerId=&status=&page=&limit= (all roles; read-only; paginated; masked customer data)
 */
unresolvedEnquiryRouter.get(
  ['/enquiries', '/api/v1/enquiries'],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = req.tenantContext!.tenantId;
      const { customerId, status, page = 1, limit = 20 } = req.query;

      const filter: Record<string, any> = { tenantId };
      if (customerId && typeof customerId === 'string') {
        filter.customerId = customerId;
      }
      if (status && typeof status === 'string' && status !== 'ALL') {
        filter.status = status;
      } else {
        // Exclude deleted enquiries from default listing
        filter.status = { $ne: 'DELETED' };
      }

      const safeLimit = Math.min(Math.max(1, Number(limit) || 20), 100);
      const safePage = Math.max(1, Number(page) || 1);
      const skip = (safePage - 1) * safeLimit;

      const [docs, total] = await Promise.all([
        SrcEnquiryModel.find(filter)
          .sort({ lastCustomerInteractionAt: -1, createdAt: -1 })
          .skip(skip)
          .limit(safeLimit)
          .lean<any[]>(),
        SrcEnquiryModel.countDocuments(filter),
      ]);

      // Enrich with masked customer info
      const customerIds = [...new Set(docs.map((d) => d.customerId).filter(Boolean))];
      const customers = await Promise.all(
        customerIds.map((cid) => mockCustomerSource.getCustomerById(tenantId, cid).catch(() => null))
      );
      const customerMap = new Map<string, any>();
      customers.forEach((c) => {
        if (c) customerMap.set(c.customerId, c);
      });

      // Enrich with product names
      const productIds = [
        ...new Set(docs.map((d) => d.itemRef?.productId).filter(Boolean)),
      ];
      const products = await SrcProductModel.find({
        tenantId,
        productId: { $in: productIds },
      }).lean<any[]>();
      const productMap = new Map<string, any>();
      products.forEach((p) => productMap.set(p.productId, p));

      const enriched = docs.map((d) => {
        const cust = d.customerId ? customerMap.get(d.customerId) : null;
        const prod = d.itemRef?.productId ? productMap.get(d.itemRef.productId) : null;
        let itemDisplayName = null;
        if (prod) {
          if (d.itemRef?.variantId) {
            const v = (prod.variants || []).find((x: any) => x.variantId === d.itemRef.variantId);
            itemDisplayName = v?.label ? `${prod.name} - ${v.label}` : prod.name;
          } else {
            itemDisplayName = prod.name;
          }
        }

        return {
          enquiryId: d.enquiryId,
          tenantId: d.tenantId,
          customerId: d.customerId || null,
          customerName: cust ? `${cust.firstName || ''} ${cust.lastName || ''}`.trim() : null,
          maskedPhone: cust?.destination?.masked || null,
          branchId: d.branchId || null,
          channel: d.channel,
          status: d.status,
          staffTakeover: Boolean(d.staffTakeover),
          itemRef: d.itemRef || null,
          itemDisplayName,
          createdAt: d.createdAt,
          lastCustomerInteractionAt: d.lastCustomerInteractionAt,
          updatedAt: d.updatedAt,
          entityVersion: d.entityVersion || 1,
        };
      });

      res.json({
        enquiries: enriched,
        total,
        page: safePage,
        limit: safeLimit,
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /campaigns/:id/enquiry-followups/summary (all roles)
 * Spec p28: observational, not sales attribution.
 */
unresolvedEnquiryRouter.get(
  ['/campaigns/:id/enquiry-followups/summary', '/api/v1/campaigns/:id/enquiry-followups/summary'],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = req.tenantContext!.tenantId;
      const campaignId = req.params.id;

      const campaign: any = await CampaignModel.findOne({ tenantId, campaignId }).lean();
      if (!campaign) {
        throw new NotFoundError(`Campaign '${campaignId}' not found`);
      }

      const activeVersion: any = await CampaignVersionModel.findOne({
        tenantId,
        campaignId,
        version: campaign.draftVersion,
      }).lean();

      // Find enrollments for this campaign
      const enrollments = await CampaignEnrollmentModel.find({ tenantId, campaignId }).lean<any[]>();

      let activeEnrollmentsCount = 0;
      let excludedCount = 0;
      const excludedByReason: Record<string, number> = {};
      const activeEnrollmentIds: string[] = [];

      let replansCount = 0;
      const holdsByReason: Record<string, number> = {
        STAFF_TAKEOVER: 0,
        CUSTOMER_INTERACTION: 0,
        reply: 0,
      };

      for (const enr of enrollments) {
        if (enr.status === 'EXCLUDED') {
          excludedCount++;
          const reason = enr.exclusionReason || 'OTHER';
          excludedByReason[reason] = (excludedByReason[reason] || 0) + 1;
        } else {
          activeEnrollmentsCount++;
          activeEnrollmentIds.push(enr.enrollmentId);
        }

        if (Array.isArray(enr.anchorHistory) && enr.anchorHistory.length > 0) {
          replansCount += enr.anchorHistory.length;
        }

        if (enr.replyHoldAt != null) {
          if (enr.holdReason === 'STAFF_TAKEOVER') {
            holdsByReason.STAFF_TAKEOVER = (holdsByReason.STAFF_TAKEOVER || 0) + 1;
          } else if (enr.holdReason === 'CUSTOMER_INTERACTION') {
            holdsByReason.CUSTOMER_INTERACTION = (holdsByReason.CUSTOMER_INTERACTION || 0) + 1;
          } else {
            holdsByReason.reply = (holdsByReason.reply || 0) + 1;
          }
        }
      }

      // Query executions for campaign
      const executions = await CampaignExecutionModel.find({
        tenantId,
        campaignId,
      }).lean<any[]>();

      let scheduled = 0;
      let deferred = 0;
      const skippedByReason: Record<string, number> = {};
      const cancellationsByResolutionStatus: Record<string, number> = {
        RESOLVED: 0,
        CLOSED: 0,
        CANCELLED: 0,
        DELETED: 0,
      };

      let sent = 0;
      let accepted = 0;
      let delivered = 0;
      let read = 0;
      let staleIntentBlocks = 0;

      for (const ex of executions) {
        if (ex.state === EXECUTION_STATE.SCHEDULED) {
          scheduled++;
        } else if (ex.state === EXECUTION_STATE.DEFERRED) {
          deferred++;
        } else if (ex.state === EXECUTION_STATE.SKIPPED) {
          const reason = ex.skipReason || 'OTHER';
          skippedByReason[reason] = (skippedByReason[reason] || 0) + 1;
        } else if (ex.state === EXECUTION_STATE.CANCELLED) {
          const reason = ex.skipReason || ex.stopReason || '';
          if (reason.includes('ENQUIRY_RESOLVED')) cancellationsByResolutionStatus.RESOLVED++;
          else if (reason.includes('ENQUIRY_CLOSED')) cancellationsByResolutionStatus.CLOSED++;
          else if (reason.includes('ENQUIRY_CANCELLED')) cancellationsByResolutionStatus.CANCELLED++;
          else if (reason.includes('ENQUIRY_DELETED')) cancellationsByResolutionStatus.DELETED++;
        } else if (ex.state === EXECUTION_STATE.BLOCKED) {
          if (ex.skipReason === EXECUTION_REASONS.BLOCKED_STALE_INTENT) {
            staleIntentBlocks++;
          }
        } else if (ex.state === EXECUTION_STATE.DISPATCHING) {
          sent++;
        } else if (ex.state === EXECUTION_STATE.PROVIDER_ACCEPTED) {
          accepted++;
        } else if (ex.state === 'DELIVERED') {
          delivered++;
        } else if (ex.state === 'READ') {
          read++;
        }
      }

      // Check delivery intents for stale blocks
      const intentBlocks = await CampaignDeliveryIntentModel.countDocuments({
        tenantId,
        campaignId,
        state: 'BLOCKED_STALE_INTENT',
      });
      staleIntentBlocks = Math.max(staleIntentBlocks, intentBlocks);

      // Inbound replies count
      const repliesCount = enrollments.filter(
        (e) => e.replyAttribution === 'CAMPAIGN' || e.lastInboundMessageAt != null
      ).length;

      // Goal completions breakdown
      const goalEvents = await CampaignGoalEventModel.find({
        tenantId,
        campaignId,
      }).lean<any[]>();

      const goalBreakdown = {
        tagged: 0,
        itemPurchase: 0,
        anyOrder: 0,
        staff: 0,
      };

      for (const ge of goalEvents) {
        const src = (ge.source || '').toUpperCase();
        if (src === 'ENQUIRY_TAGGED' || src.includes('TAGGED')) {
          goalBreakdown.tagged++;
        } else if (src === 'ENQUIRY_PURCHASE' || src.includes('ITEM')) {
          goalBreakdown.itemPurchase++;
        } else if (src.includes('ANY') || src === 'ANY_QUALIFYING_ORDER') {
          goalBreakdown.anyOrder++;
        } else if (src.includes('STAFF')) {
          goalBreakdown.staff++;
        } else {
          goalBreakdown.itemPurchase++;
        }
      }

      // Count open enquiries in horizon window
      const now = clock.now();
      const maxDelayHours = 72;
      const windowStart = new Date(now.getTime() - (maxDelayHours + 24 + 12 + 24) * 3600 * 1000);
      const enquiriesInWindow = await SrcEnquiryModel.countDocuments({
        tenantId,
        status: 'OPEN',
        lastCustomerInteractionAt: { $gte: windowStart, $lte: now },
      });

      res.json({
        campaignId,
        enquiriesInWindow,
        enrollments: enrollments.length,
        activeEnrollments: activeEnrollmentsCount,
        excludedCount,
        excludedByReason,
        scheduled,
        deferred,
        skippedByReason,
        replans: replansCount,
        holdsByReason,
        cancellationsByResolutionStatus,
        staleIntentBlocks,
        delivery: {
          sent,
          accepted,
          delivered,
          read,
        },
        replies: repliesCount,
        goalCompletions: {
          total: goalEvents.length,
          breakdown: goalBreakdown,
        },
        attributionNote: 'observational, not sales attribution',
      });
    } catch (err) {
      next(err);
    }
  }
);

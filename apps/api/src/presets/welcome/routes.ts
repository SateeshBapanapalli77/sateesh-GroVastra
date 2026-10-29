import { Router, Request, Response, NextFunction } from 'express';
import { authenticate, requireRole } from '../../middleware/auth';
import { mockOfferSource } from '../../adapters/OfferSource';
import {
  CampaignModel,
  CampaignEnrollmentModel,
  CampaignExecutionModel,
  CampaignCustomerFactModel,
  CampaignEventInboxModel,
  SrcCustomerModel,
  SrcOrderModel,
} from '../../db/models';
import {
  AUTH_COOKIE_NAME,
  ENROLLMENT_STATUS,
  EXECUTION_STATE,
} from '@grovastra/shared';
import { mockCustomerSource } from '../../adapters';
import { customerFactsService } from '../../services/customer-facts';
import { reconcileEventDelayCampaign } from '../_shared/eventDelay/reconcilerBase';
import { NotFoundError, ValidationError } from '../../errors/app-error';

export const welcomeRouter = Router();

welcomeRouter.use((req: Request, res: Response, next: NextFunction) => {
  if (req.path.startsWith('/dev/')) {
    if (req.headers.authorization || (req.cookies && req.cookies[AUTH_COOKIE_NAME])) {
      return authenticate(req, res, next);
    }
    const tenantId = (req.headers['x-tenant-id'] as string) || 'tenant_default';
    req.tenantContext = {
      tenantId,
      userId: 'dev-user',
      role: 'owner',
      branchIds: [],
      email: 'dev@example.com',
    };
    return next();
  }
  return authenticate(req, res, next);
});

/**
 * GET /offers?status=ACTIVE (owner/admin)
 */
welcomeRouter.get(
  '/offers',
  requireRole('owner', 'admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = req.tenantContext!.tenantId;
      const kind = typeof req.query.kind === 'string' ? req.query.kind : undefined;
      const status = typeof req.query.status === 'string' ? req.query.status : undefined;
      const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : null;
      if (kind === 'SELECTED_STOCK') {
        const from = new Date(0);
        const to = new Date('9999-12-31T23:59:59.999Z');
        const page = await mockOfferSource.listActiveByPublishedRange(tenantId, from, to, cursor, 100);
        const filtered = status ? page.offers.filter((offer) => offer.status === status) : page.offers;
        return res.status(200).json({ tenantId, offers: filtered, nextCursor: page.nextCursor });
      }
      const offers = await mockOfferSource.listActiveOffers(tenantId);
      res.status(200).json({
        tenantId,
        offers,
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /campaigns/:id/welcome/summary (all roles)
 */
welcomeRouter.get(
  '/campaigns/:id/welcome/summary',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = req.tenantContext!.tenantId;
      const campaignId = req.params.id;

      const campaign: any = await CampaignModel.findOne({ tenantId, campaignId }).lean();
      if (!campaign) {
        throw new NotFoundError(`Campaign '${campaignId}' not found`);
      }

      // Anonymous purchases seen without customer identity
      const noCustomerIdentityCount = await CampaignEventInboxModel.countDocuments({
        tenantId,
        outcome: 'NO_CUSTOMER_IDENTITY',
      });

      // Existing customers not welcomed (earliest qualifying order before campaign effectiveStart)
      const effectiveStart = campaign.activatedAt ? new Date(campaign.activatedAt) : new Date(0);
      const allCustomerFacts = await CampaignCustomerFactModel.find({
        tenantId,
        firstQualifyingOrderCompletedAt: { $lt: effectiveStart },
      }).lean();
      const existingCustomersNotWelcomed = allCustomerFacts.length;

      // Enrollments & Exclusions
      const enrollments = await CampaignEnrollmentModel.find({ tenantId, campaignId }).lean();
      let activeEnrollmentsCount = 0;
      let excludedCount = 0;
      const excludedByReason: Record<string, number> = {};
      const activeEnrollmentIds: string[] = [];
      const acceptedCustomerTimestamps = new Map<string, Date>();
      let needsStaffReviewCount = 0;

      let totalHeldOrReplied = 0;
      let exactCampaignReplies = 0;
      let conservativeHolds = 0;
      let currentlyOnHold = 0;
      let resolvedHolds = 0;

      for (const enr of enrollments) {
        if ((enr as any).needsStaffReview) {
          needsStaffReviewCount++;
        }
        if (enr.status === (ENROLLMENT_STATUS as any).EXCLUDED) {
          excludedCount++;
          const reason = enr.exclusionReason || 'OTHER';
          excludedByReason[reason] = (excludedByReason[reason] || 0) + 1;
        } else {
          activeEnrollmentsCount++;
          activeEnrollmentIds.push(enr.enrollmentId);
        }

        if (enr.replyHoldAt != null) {
          totalHeldOrReplied++;
          if (enr.replyAttribution === 'CAMPAIGN') {
            exactCampaignReplies++;
          } else {
            conservativeHolds++;
          }
          if (enr.holdResolvedAt == null) {
            currentlyOnHold++;
          } else {
            resolvedHolds++;
          }
        }
      }

      // Query executions
      const executions = await CampaignExecutionModel.find({
        tenantId,
        campaignId,
        enrollmentId: { $in: activeEnrollmentIds },
      }).lean();

      let scheduled = 0;
      let deferredCount = 0;
      const deferredByReason: Record<string, number> = {};
      let skippedCount = 0;
      const skippedByReason: Record<string, number> = {};

      let accepted = 0;
      let sent = 0;
      let delivered = 0;
      let read = 0;

      let failedCount = 0;
      const failedByReason: Record<string, number> = {};

      let executionsWithRetries = 0;
      let totalAttempts = 0;
      let safeRejectionRetries = 0;
      let outcomeUnknownCount = 0;

      for (const ex of executions) {
        const attempts = (ex as any).attempts || ((ex as any).statusHistory?.length ? 1 : 0);
        if (attempts > 1) {
          executionsWithRetries++;
          safeRejectionRetries += attempts - 1;
        }
        totalAttempts += Math.max(1, attempts);

        if (ex.state === EXECUTION_STATE.SCHEDULED) {
          scheduled++;
        } else if (ex.state === EXECUTION_STATE.DEFERRED) {
          deferredCount++;
          const reason = ex.deferralReason || 'OUTSIDE_SENDING_HOURS';
          deferredByReason[reason] = (deferredByReason[reason] || 0) + 1;
        } else if (ex.state === EXECUTION_STATE.SKIPPED) {
          skippedCount++;
          const reason = ex.skipReason || 'OTHER';
          skippedByReason[reason] = (skippedByReason[reason] || 0) + 1;
        } else if (ex.state === EXECUTION_STATE.OUTCOME_UNKNOWN) {
          outcomeUnknownCount++;
        } else if (ex.state === EXECUTION_STATE.FAILED) {
          failedCount++;
          const reason = (ex as any).lastErrorCategory || ex.skipReason || 'PROVIDER_FAILED';
          failedByReason[reason] = (failedByReason[reason] || 0) + 1;
        }

        if (
          [
            EXECUTION_STATE.PROVIDER_ACCEPTED,
            EXECUTION_STATE.SENT,
            EXECUTION_STATE.DELIVERED,
            EXECUTION_STATE.READ,
          ].includes(ex.state as any)
        ) {
          accepted++;
          const enr = enrollments.find((e) => e.enrollmentId === ex.enrollmentId);
          if (enr?.customerId) {
            const acceptedAt = (ex as any).acceptedAt || (ex as any).updatedAt || new Date();
            acceptedCustomerTimestamps.set(enr.customerId, new Date(acceptedAt));
          }
        }
        if (
          [EXECUTION_STATE.SENT, EXECUTION_STATE.DELIVERED, EXECUTION_STATE.READ].includes(
            ex.state as any
          )
        ) {
          sent++;
        }
        if ([EXECUTION_STATE.DELIVERED, EXECUTION_STATE.READ].includes(ex.state as any)) {
          delivered++;
        }
        if (ex.state === EXECUTION_STATE.READ) {
          read++;
        }
      }

      // Observational repeat purchase (Spec p28: customers with another qualifying order after welcome was accepted)
      let returnedCustomersCount = 0;
      for (const [customerId, acceptedAt] of acceptedCustomerTimestamps.entries()) {
        const subsequentOrder = await SrcOrderModel.findOne({
          tenantId,
          customerId,
          status: 'COMPLETED',
          paid: true,
          netPaise: { $gt: 0 },
          completedAt: { $gt: acceptedAt },
        }).lean();
        if (subsequentOrder) {
          returnedCustomersCount++;
        }
      }

      // Also check customer-level needsStaffReview count
      const customerStaffReviews = await SrcCustomerModel.countDocuments({
        tenantId,
        needsStaffReview: { $ne: null },
      });
      const totalStaffReviews = Math.max(needsStaffReviewCount, customerStaffReviews);

      return res.status(200).json({
        campaignId,
        tenantId,
        noCustomerIdentityCount,
        existingCustomersNotWelcomed,
        enrolled: activeEnrollmentsCount,
        enrollments: enrollments.length,
        activeEnrollments: activeEnrollmentsCount,
        excludedCount,
        excludedByReason,
        scheduled,
        deferredCount,
        deferredByReason,
        skippedCount,
        skippedByReason,
        accepted,
        sent,
        delivered,
        read,
        failed: failedCount,
        failedByReason,
        retries: {
          executionsWithRetries,
          totalAttempts,
          safeRejectionRetries,
          outcomeUnknownCount,
          note: 'no automatic resend',
        },
        repliesAndHolds: {
          totalHeldOrReplied,
          exactCampaignReplies,
          conservativeHolds,
          currentlyOnHold,
          resolvedHolds,
        },
        needsStaffReviewCount: totalStaffReviews,
        observationalRepeatPurchases: {
          count: returnedCustomersCount,
          note: 'observational only, not sales attribution (spec p28)',
        },
        offerRedemption: {
          status: 'not available',
          note: 'Offer redemption events not integrated by offer owner',
        },
        note: 'Welcome messages do not claim sales attribution (spec p28).',
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /dev/event-delay/reconcile
 */
welcomeRouter.post(
  '/dev/event-delay/reconcile',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = req.tenantContext?.tenantId || (req.headers['x-tenant-id'] as string) || 'tenant_default';
      const { campaignId, batchSize, nowOverride, resumeFromCheckpoint } = req.body;
      if (!campaignId) {
        throw new ValidationError('campaignId is required', { field: 'campaignId' });
      }

      const resObj = await reconcileEventDelayCampaign(tenantId, campaignId, {
        batchSize,
        nowOverride: nowOverride ? new Date(nowOverride) : undefined,
        resumeFromCheckpoint,
      });

      res.status(200).json(resObj);
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /dev/customer-facts/rebuild
 */
welcomeRouter.post(
  '/dev/customer-facts/rebuild',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = req.tenantContext?.tenantId || (req.headers['x-tenant-id'] as string) || 'tenant_default';
      const { customerId } = req.body;

      if (customerId) {
        const fact = await customerFactsService.recomputeCustomerFacts(tenantId, customerId);
        return res.status(200).json({ success: true, fact });
      }

      const customers = await SrcCustomerModel.find({ tenantId }).lean();
      for (const c of customers) {
        await customerFactsService.recomputeCustomerFacts(tenantId, c.customerId);
      }
      res.status(200).json({ success: true, count: customers.length });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /customers/:id (includes customer facts block)
 */
welcomeRouter.get(
  '/customers/:id',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = req.tenantContext!.tenantId;
      const customerId = req.params.id as string;

      const customer = await mockCustomerSource.getCustomerById(tenantId, customerId);
      if (!customer) {
        throw new NotFoundError(`Customer '${customerId}' not found`);
      }

      const facts: any = await CampaignCustomerFactModel.findOne({ tenantId, customerId }).lean();

      res.status(200).json({
        tenantId,
        customer: {
          customerId: customer.customerId,
          firstName: customer.firstName,
          phone: customer.destination?.masked || '',
          destination: customer.destination,
          branchId: customer.branchId,
          status: customer.status,
          marketingOptIn: customer.consent?.marketingOptIn ?? true,
          channelSuppressed: customer.status === 'deleted',
          createdAt: customer.createdAt,
          updatedAt: customer.updatedAt,
          facts: facts
            ? {
                lastQualifyingPurchaseAt: facts.lastQualifyingPurchaseAt || null,
              }
            : {
                lastQualifyingPurchaseAt: null,
              },
        },
        facts: facts
          ? {
              lastQualifyingPurchaseAt: facts.lastQualifyingPurchaseAt || null,
            }
          : {
              lastQualifyingPurchaseAt: null,
            },
      });
    } catch (err) {
      next(err);
    }
  }
);

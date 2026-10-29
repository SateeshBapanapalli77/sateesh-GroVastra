import { Router, Request, Response, NextFunction } from 'express';
import { DateTime } from 'luxon';
import { authenticate } from '../middleware/auth';
import {
  SrcCustomerEventModel,
  CampaignModel,
  CampaignVersionModel,
  CampaignEnrollmentModel,
  CampaignExecutionModel,
} from '../db/models';
import { ENROLLMENT_STATUS } from '@grovastra/shared';
import { clock } from '../services/clock';
import { NotFoundError } from '../errors/app-error';

export const occasionsRouter = Router();

// Base authentication for all occasions routes
occasionsRouter.use(authenticate);

/**
 * GET /occasions & /api/v1/occasions
 * Read-only, paginated, tenant-isolated.
 * Query params: customerId?, kind?, status?, page?, limit?
 */
occasionsRouter.get(
  ['/occasions', '/api/v1/occasions'],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = req.tenantContext!.tenantId;
      const { customerId, kind, status, page, limit } = req.query;

      const query: Record<string, any> = { tenantId, deletedAt: null };
      if (customerId) query.customerId = customerId;
      if (kind) query.kind = (kind as string).toUpperCase();
      if (status) query.status = (status as string).toUpperCase();

      const pageNum = Math.max(1, parseInt(page as string, 10) || 1);
      const limitNum = Math.min(100, Math.max(1, parseInt(limit as string, 10) || 20));
      const skip = (pageNum - 1) * limitNum;

      const [total, docs] = await Promise.all([
        SrcCustomerEventModel.countDocuments(query),
        SrcCustomerEventModel.find(query)
          .sort({ eventDateKey: 1, createdAt: -1 })
          .skip(skip)
          .limit(limitNum)
          .lean(),
      ]);

      const occasions = docs.map((d: any) => ({
        id: d._id.toString(),
        _id: d._id.toString(),
        tenantId: d.tenantId,
        customerId: d.customerId,
        eventId: d.eventId,
        type: d.type,
        kind: d.kind,
        eventDate: d.eventDate,
        eventDateKey: d.eventDateKey,
        month: d.month,
        day: d.day,
        label: d.label,
        recipientLabel: d.recipientLabel,
        budgetPaise: d.budgetPaise,
        categories: d.categories || [],
        status: d.status,
        declaredByCustomer: d.declaredByCustomer,
        declaredAt: d.declaredAt,
        source: d.source,
        entityVersion: d.entityVersion || 1,
        version: d.version || 1,
        deletedAt: d.deletedAt,
        createdAt: d.createdAt,
        updatedAt: d.updatedAt,
      }));

      res.status(200).json({
        occasions,
        total,
        page: pageNum,
        limit: limitNum,
        totalPages: Math.ceil(total / limitNum),
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /campaigns/:id/occasion-reminders/summary & /api/v1/campaigns/:id/occasion-reminders/summary
 * Observational metrics only. Spec p28.
 */
occasionsRouter.get(
  [
    '/campaigns/:id/occasion-reminders/summary',
    '/api/v1/campaigns/:id/occasion-reminders/summary',
  ],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = req.tenantContext!.tenantId;
      const campaignId = req.params.id;

      const campaign = (await CampaignModel.findOne({ tenantId, campaignId }).lean()) as any;
      if (!campaign) {
        throw new NotFoundError(`Campaign '${campaignId}' not found`);
      }

      // Load active published version (or draft)
      const version = ((await CampaignVersionModel.findOne({
        tenantId,
        campaignId,
        version: campaign.draftVersion,
        isPublished: true,
      }).lean()) ||
        (campaign.activeVersionId
          ? await CampaignVersionModel.findById(campaign.activeVersionId).lean()
          : null)) as any;

      const tz = version?.timezone || 'Asia/Kolkata';
      const targetKind = version?.trigger?.occasionKind || (campaign.presetId === 'gift_wedding_reminder' ? 'WEDDING' : null);

      const effectiveNow = clock.now();
      const steps = version?.steps || [];
      const maxPositiveOffset = Math.max(
        0,
        ...steps.map((s: any) => s.offsetDays ?? 0).filter((d: number) => d > 0)
      );
      const maxLeadDays = Math.max(
        0,
        ...steps.map((s: any) => -(s.offsetDays ?? 0)).filter((d: number) => d > 0)
      );
      const horizonStart = DateTime.fromJSDate(effectiveNow, { zone: tz })
        .minus({ days: maxPositiveOffset })
        .startOf('day')
        .toISODate()!;
      const horizonEnd = DateTime.fromJSDate(effectiveNow, { zone: tz })
        .plus({ days: maxLeadDays + 30 })
        .endOf('day')
        .toISODate()!;

      // Find all customer occasions for this tenant & kind
      const occasionQuery: Record<string, any> = { tenantId, deletedAt: null, status: 'ACTIVE' };
      if (targetKind) occasionQuery.kind = targetKind;

      const allOccasions = await SrcCustomerEventModel.find(occasionQuery).lean();
      let occasionsInWindowCount = 0;
      let occasionsBeyondHorizonCount = 0;

      for (const occ of allOccasions) {
        if (!occ.eventDateKey) continue;
        if (occ.eventDateKey >= horizonStart && occ.eventDateKey <= horizonEnd) {
          occasionsInWindowCount++;
        } else if (occ.eventDateKey > horizonEnd) {
          occasionsBeyondHorizonCount++;
        }
      }

      // Find all enrollments for this campaign
      const enrollments = await CampaignEnrollmentModel.find({ tenantId, campaignId }).lean();
      const activeEnrollments = enrollments.filter((e) => e.status === ENROLLMENT_STATUS.ACTIVE);
      const completedEnrollments = enrollments.filter(
        (e) => e.status === ENROLLMENT_STATUS.COMPLETED || e.goalReachedAt != null
      );
      const cancelledEnrollments = enrollments.filter(
        (e) => e.status === ENROLLMENT_STATUS.CANCELLED
      );
      const replannedCount = enrollments.reduce(
        (sum, e) => sum + (e.dateHistory?.length || 0),
        0
      );

      // Find all executions for this campaign
      const executions = await CampaignExecutionModel.find({ tenantId, campaignId }).lean();
      const leadTimeSkips = executions.filter(
        (x) =>
          x.skipReason === 'INSUFFICIENT_LEAD_TIME' ||
          x.skipReason?.includes('INSUFFICIENT_LEAD_TIME')
      );

      const stepBreakdown: Record<string, number> = {};
      for (const exe of executions) {
        stepBreakdown[exe.state] = (stepBreakdown[exe.state] || 0) + 1;
      }

      res.status(200).json({
        campaignId,
        occasionKind: targetKind,
        timezone: tz,
        horizonStart,
        horizonEnd,
        occasionsInWindow: occasionsInWindowCount,
        occasionsBeyondHorizon: occasionsBeyondHorizonCount,
        eligibleOccasionsCount: enrollments.length,
        activeEnrollmentsCount: activeEnrollments.length,
        completedOccasionsCount: completedEnrollments.length,
        cancelledEnrollmentsCount: cancelledEnrollments.length,
        leadTimeSkipsCount: leadTimeSkips.length,
        replannedCount,
        stepBreakdown,
        leadTimeSkipReasons: leadTimeSkips.map((x) => ({
          executionId: x.executionId,
          stepId: x.stepId,
          usefulUntilReason: x.usefulUntilReason,
          dueAt: x.dueAt,
          latestUsefulAt: x.latestUsefulAt,
        })),
      });
    } catch (err) {
      next(err);
    }
  }
);

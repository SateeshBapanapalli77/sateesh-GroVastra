import { Router, Request, Response, NextFunction } from 'express';
import { authenticate, requireRole } from '../middleware/auth';
import { createTenantRepository } from '../db/tenant-repository';
import { BranchModel } from '../db/models/branch.model';
import { UserModel } from '../db/models/user.model';
import { TenantModel } from '../db/models/tenant.model';
import { CampaignCustomerFactModel } from '../db/models/campaign-customer-fact.model';
import { auditService } from '../services/audit.service';
import { authService } from '../services/auth.service';
import { ChangeUserRoleSchema, SourceCustomer, CustomerFilter } from '@grovastra/shared';
import { NotFoundError, ValidationError } from '../errors/app-error';
import { mockCustomerSource, mockOrderSource } from '../adapters';
import { mockCreditSource } from '../adapters/CreditSource';
import { SrcCreditModel } from '../db/models/src-credit.model';

/**
 * Sanitizes customer destination data for client UI (Hard Rule 9).
 * encryptedPhone is strictly stripped so staff and UI only see masked phone and HMAC hash.
 */
function sanitizeCustomerForClient(customer: SourceCustomer) {
  const { encryptedPhone, ...safeDestination } = customer.destination;
  return {
    ...customer,
    destination: safeDestination,
  };
}

export const tenantRouter = Router();

// All tenant routes require authenticated tenant context
tenantRouter.use(authenticate);

/**
 * GET /tenant/branches
 * Returns all branches for the authenticated tenant.
 * Accessible by: owner, admin, staff.
 */
tenantRouter.get(
  '/tenant/branches',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = req.tenantContext!.tenantId;
      const branchRepo = createTenantRepository(tenantId, BranchModel);
      const branches = await branchRepo.find().sort({ isMain: -1, name: 1 }).lean();

      res.status(200).json({
        tenantId,
        branches,
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /tenant/branches/:branchId
 * Returns a single branch by branchId, strictly isolated to the authenticated tenant.
 * Cross-tenant attempts return 404.
 */
tenantRouter.get(
  '/tenant/branches/:branchId',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = req.tenantContext!.tenantId;
      const branchId = req.params.branchId as string;
      const branchRepo = createTenantRepository(tenantId, BranchModel);

      const branch = await branchRepo.findOne({ branchId }).lean();
      if (!branch) {
        throw new NotFoundError(`Branch '${branchId}' not found in tenant '${tenantId}'`);
      }

      res.status(200).json(branch);
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /tenant/activity
 * Returns audit log events for the authenticated tenant.
 * Accessible by: owner, admin, staff (staff view activity per spec).
 */
tenantRouter.get(
  '/tenant/activity',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = req.tenantContext!.tenantId;
      const limit = Math.min(Number(req.query.limit) || 50, 100);
      const skip = Number(req.query.skip) || 0;

      const logs = await auditService.getTenantLogs(tenantId, limit, skip);

      res.status(200).json({
        tenantId,
        count: logs.length,
        logs,
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /tenant/users
 * Returns list of team members within the tenant.
 */
tenantRouter.get(
  '/tenant/users',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = req.tenantContext!.tenantId;
      const userRepo = createTenantRepository(tenantId, UserModel);
      const users = await userRepo
        .find({}, { passwordHash: 0 })
        .sort({ role: 1, email: 1 })
        .lean();

      res.status(200).json({
        tenantId,
        users,
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /tenant/users/:id/role
 * Changes a user's role within the tenant.
 * Accessible ONLY by: owner, admin. Staff receives 403 Forbidden.
 */
tenantRouter.post(
  '/tenant/users/:id/role',
  requireRole('owner', 'admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = ChangeUserRoleSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError('Invalid role update payload', parsed.error.flatten().fieldErrors);
      }

      const clientIp = req.ip || req.socket.remoteAddress;
      const userAgent = req.headers['user-agent'];

      const updatedUser = await authService.changeUserRole(
        req.tenantContext!,
        req.params.id as string,
        parsed.data.role,
        clientIp,
        userAgent
      );

      res.status(200).json({
        message: 'User role updated successfully',
        user: {
          id: updatedUser._id.toString(),
          tenantId: updatedUser.tenantId,
          email: updatedUser.email,
          role: updatedUser.role,
        },
      });
    } catch (err) {
      next(err);
    }
  }
);


/**
 * GET /settings
 * Tenant settings endpoint placeholder.
 * Accessible ONLY by: owner, admin. Staff receives 403 Forbidden.
 */
tenantRouter.get(
  '/settings',
  requireRole('owner', 'admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenant = await TenantModel.findOne({ tenantId: req.tenantContext!.tenantId });
      res.status(200).json({
        tenantId: req.tenantContext!.tenantId,
        tenantName: tenant?.name,
        settings: {
          dispatchMode: 'dry',
          whatsappConfigured: true,
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /tenant/customers
 * Returns paginated list of customers for the authenticated tenant.
 * Accessible by: owner, admin, staff (all roles view customer directory per spec).
 * Hard Rule 9: Full phone numbers are NEVER returned. UI receives masked numbers only.
 */
tenantRouter.get(
  '/tenant/customers',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = req.tenantContext!.tenantId;
      const {
        status,
        marketingOptIn,
        channelSuppressed,
        branchId,
        hasBirthday,
        birthdayMonth,
        birthdayDay,
        isLive,
        search,
        limit,
        skip,
        includeDeleted,
      } = req.query;

      const filter: CustomerFilter = {
        status: status ? String(status) : undefined,
        marketingOptIn:
          marketingOptIn !== undefined ? marketingOptIn === 'true' : undefined,
        channelSuppressed:
          channelSuppressed !== undefined ? channelSuppressed === 'true' : undefined,
        branchId: branchId ? String(branchId) : undefined,
        hasBirthday: hasBirthday !== undefined ? hasBirthday === 'true' : undefined,
        birthdayMonth: birthdayMonth ? Number(birthdayMonth) : undefined,
        birthdayDay: birthdayDay ? Number(birthdayDay) : undefined,
        isLive: isLive !== undefined ? isLive === 'true' : undefined,
        search: search ? String(search) : undefined,
        includeDeleted: includeDeleted === 'true',
      };

      const pagination = {
        limit: limit ? Number(limit) : 50,
        skip: skip ? Number(skip) : 0,
      };

      const result = await mockCustomerSource.listCustomers(tenantId, filter, pagination);

      res.status(200).json({
        tenantId,
        total: result.total,
        limit: pagination.limit,
        skip: pagination.skip,
        customers: result.customers.map(sanitizeCustomerForClient),
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /tenant/customers/:customerId
 * Retrieves customer profile strictly scoped to authenticated tenant.
 * Cross-tenant access returns 404.
 */
tenantRouter.get(
  '/tenant/customers/:customerId',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = req.tenantContext!.tenantId;
      const customerId = req.params.customerId as string;

      const customer = await mockCustomerSource.getCustomerById(tenantId, customerId);
      if (!customer) {
        throw new NotFoundError(
          `Customer '${customerId}' not found in tenant '${tenantId}'`
        );
      }

      const facts: any = await CampaignCustomerFactModel.findOne({ tenantId, customerId }).lean();
      const sanitized = sanitizeCustomerForClient(customer);
      const credits = await mockCreditSource.listCreditsForCustomer(tenantId, customerId);

      const factsBlock = facts
        ? {
            lastQualifyingPurchaseAt: facts.lastQualifyingPurchaseAt || null,
            qualifyingOrderCount: facts.qualifyingOrderCount || 0,
            firstQualifyingOrderId: facts.firstQualifyingOrderId || null,
            firstQualifyingOrderNumber: facts.firstQualifyingOrderNumber || null,
            firstQualifyingAt: facts.firstQualifyingAt || null,
            firstQualifyingNetPaise: facts.firstQualifyingNetPaise || 0,
            secondQualifyingOrderId: facts.secondQualifyingOrderId || null,
            secondQualifyingAt: facts.secondQualifyingAt || null,
            lastQualifyingOrderId: facts.lastQualifyingOrderId || null,
            maxQualifyingOrderCountSeen: facts.maxQualifyingOrderCountSeen || 0,
          }
        : {
            lastQualifyingPurchaseAt: null,
            qualifyingOrderCount: 0,
            firstQualifyingOrderId: null,
            firstQualifyingOrderNumber: null,
            firstQualifyingAt: null,
            firstQualifyingNetPaise: 0,
            secondQualifyingOrderId: null,
            secondQualifyingAt: null,
            lastQualifyingOrderId: null,
            maxQualifyingOrderCountSeen: 0,
          };

      res.status(200).json({
        tenantId,
        customer: {
          ...sanitized,
          facts: factsBlock,
        },
        facts: factsBlock,
        credits: credits.map((c) => ({
          creditId: c.creditId,
          customerId: c.customerId,
          type: c.type,
          unit: c.unit,
          amount: c.amount,
          originalAmount: c.originalAmount,
          issuedAt: c.issuedAt,
          expiresAt: c.expiresAt,
          status: c.status,
          reason: c.reason,
          sourceOrderId: c.sourceOrderId,
        })),
      });
    } catch (err) {
      next(err);
    }
  }
);

tenantRouter.get(
  ['/customers/:customerId', '/api/v1/customers/:customerId'],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = req.tenantContext!.tenantId;
      const customerId = req.params.customerId as string;

      const customer = await mockCustomerSource.getCustomerById(tenantId, customerId);
      if (!customer) {
        throw new NotFoundError(
          `Customer '${customerId}' not found in tenant '${tenantId}'`
        );
      }

      const facts: any = await CampaignCustomerFactModel.findOne({ tenantId, customerId }).lean();
      const sanitized = sanitizeCustomerForClient(customer);
      const credits = await mockCreditSource.listCreditsForCustomer(tenantId, customerId);

      const factsBlock = facts
        ? {
            lastQualifyingPurchaseAt: facts.lastQualifyingPurchaseAt || null,
            qualifyingOrderCount: facts.qualifyingOrderCount || 0,
            firstQualifyingOrderId: facts.firstQualifyingOrderId || null,
            firstQualifyingOrderNumber: facts.firstQualifyingOrderNumber || null,
            firstQualifyingAt: facts.firstQualifyingAt || null,
            firstQualifyingNetPaise: facts.firstQualifyingNetPaise || 0,
            secondQualifyingOrderId: facts.secondQualifyingOrderId || null,
            secondQualifyingAt: facts.secondQualifyingAt || null,
            lastQualifyingOrderId: facts.lastQualifyingOrderId || null,
            maxQualifyingOrderCountSeen: facts.maxQualifyingOrderCountSeen || 0,
          }
        : {
            lastQualifyingPurchaseAt: null,
            qualifyingOrderCount: 0,
            firstQualifyingOrderId: null,
            firstQualifyingOrderNumber: null,
            firstQualifyingAt: null,
            firstQualifyingNetPaise: 0,
            secondQualifyingOrderId: null,
            secondQualifyingAt: null,
            lastQualifyingOrderId: null,
            maxQualifyingOrderCountSeen: 0,
          };

      res.status(200).json({
        tenantId,
        customer: {
          ...sanitized,
          facts: factsBlock,
        },
        facts: factsBlock,
        credits: credits.map((c) => ({
          creditId: c.creditId,
          customerId: c.customerId,
          type: c.type,
          unit: c.unit,
          amount: c.amount,
          originalAmount: c.originalAmount,
          issuedAt: c.issuedAt,
          expiresAt: c.expiresAt,
          status: c.status,
          reason: c.reason,
          sourceOrderId: c.sourceOrderId,
        })),
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /credits & /api/v1/credits (all roles; read-only; masked data only)
 */
tenantRouter.get(
  ['/credits', '/api/v1/credits'],
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = req.tenantContext!.tenantId;
      const customerId = req.query.customerId as string | undefined;
      const status = req.query.status as string | undefined;

      let credits: any[];
      if (customerId) {
        credits = await mockCreditSource.listCreditsForCustomer(
          tenantId,
          customerId,
          status ? { status } : undefined
        );
      } else {
        const query: Record<string, unknown> = { tenantId };
        if (status) query.status = status;
        credits = (await SrcCreditModel.find(query).sort({ expiresAt: 1 }).limit(100).lean()) as any[];
      }

      res.status(200).json({
        credits: credits.map((c) => ({
          creditId: c.creditId,
          customerId: c.customerId,
          type: c.type,
          unit: c.unit,
          amount: c.amount,
          originalAmount: c.originalAmount,
          issuedAt: c.issuedAt,
          expiresAt: c.expiresAt,
          status: c.status,
          reason: c.reason,
          sourceOrderId: c.sourceOrderId,
        })),
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /tenant/customers/:customerId/events
 * Retrieves saved anniversaries & events for customer.
 */
tenantRouter.get(
  '/tenant/customers/:customerId/events',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = req.tenantContext!.tenantId;
      const customerId = req.params.customerId as string;

      // Verify customer belongs to tenant
      const customer = await mockCustomerSource.getCustomerById(tenantId, customerId);
      if (!customer) {
        throw new NotFoundError(
          `Customer '${customerId}' not found in tenant '${tenantId}'`
        );
      }

      const events = await mockCustomerSource.getCustomerEvents(tenantId, customerId);

      res.status(200).json({
        tenantId,
        customerId,
        events,
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /tenant/customers/:customerId/orders
 * Retrieves orders placed by the customer.
 */
tenantRouter.get(
  '/tenant/customers/:customerId/orders',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = req.tenantContext!.tenantId;
      const customerId = req.params.customerId as string;

      // Verify customer belongs to tenant
      const customer = await mockCustomerSource.getCustomerById(tenantId, customerId);
      if (!customer) {
        throw new NotFoundError(
          `Customer '${customerId}' not found in tenant '${tenantId}'`
        );
      }

      const orders = await mockOrderSource.getOrdersByCustomer(tenantId, customerId);

      res.status(200).json({
        tenantId,
        customerId,
        orders,
      });
    } catch (err) {
      next(err);
    }
  }
);


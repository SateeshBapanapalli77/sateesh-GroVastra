import { Router, Request, Response, NextFunction } from 'express';
import { authenticate, requireRole } from '../middleware/auth';
import { CampaignContactGateModel, SrcCustomerModel } from '../db/models';

export const destinationRouter = Router();

// Base authentication for all destination routes
destinationRouter.use(authenticate);

/**
 * GET /destinations/health & /api/v1/destinations/health
 * Accessible to owner and admin only (staff receives 403).
 * Returns health status of destinations (masked data only).
 */
destinationRouter.get(
  ['/destinations/health', '/api/v1/destinations/health'],
  requireRole('owner', 'admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = req.tenantContext!.tenantId;
      const status = (req.query.status as string) || 'UNDELIVERABLE';
      const gates: any[] = await CampaignContactGateModel.find({
        tenantId,
        'health.status': status,
      }).lean();

      const hashes = gates.map((g) => g.destinationHash);
      const customers: any[] = await SrcCustomerModel.find({
        tenantId,
        'destination.destinationHash': { $in: hashes },
      }).lean();

      const customerByHash = new Map<string, any>();
      for (const c of customers) {
        if (c.destination?.destinationHash) {
          customerByHash.set(c.destination.destinationHash, c);
        }
      }

      const destinations = gates.map((g) => {
        const cust = customerByHash.get(g.destinationHash);
        return {
          destinationHash: g.destinationHash,
          health: g.health,
          maskedPhone: cust?.destination?.masked || '***',
          customerName: cust?.firstName || null,
          customerId: cust?.customerId || null,
        };
      });

      res.status(200).json({
        status,
        count: destinations.length,
        destinations,
      });
    } catch (err) {
      next(err);
    }
  }
);

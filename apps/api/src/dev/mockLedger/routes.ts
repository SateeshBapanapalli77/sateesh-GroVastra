import { Router, Request, Response, NextFunction } from 'express';
import { mockLedgerService } from './mockLedger.service';
import { AUTH_COOKIE_NAME } from '@grovastra/shared';
import { authenticate } from '../../middleware/auth';

export const mockLedgerRouter = Router();

// Middleware: 404 in production, dev authentication or fallback tenant context
mockLedgerRouter.use((req: Request, res: Response, next: NextFunction) => {
  if (!req.path.startsWith('/dev/mock-credits')) {
    return next();
  }

  if (process.env.NODE_ENV === 'production') {
    return res.status(404).json({
      error: {
        code: 'NOT_FOUND',
        message: 'Mock ledger routes are disabled in production',
      },
    });
  }

  if (req.headers.authorization || (req.cookies && req.cookies[AUTH_COOKIE_NAME])) {
    return authenticate(req, res, next);
  }

  const tenantId = (req.headers['x-tenant-id'] as string) || 'shop_a';
  req.tenantContext = {
    tenantId,
    userId: 'dev-user',
    role: 'owner',
    branchIds: [],
    email: 'dev@example.com',
  };
  return next();
});

/**
 * POST /dev/mock-credits
 */
mockLedgerRouter.post(
  '/dev/mock-credits',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = req.tenantContext!.tenantId;
      const { customerId, unit, amount, reason, expiresAt, sourceOrderId, creditId } = req.body;

      const credit = await mockLedgerService.issueCredit({
        tenantId,
        customerId,
        unit: unit || 'PAISE',
        amount: Number(amount),
        reason: reason || 'FIRST_ORDER_REWARD',
        expiresAt: expiresAt || new Date(Date.now() + 120 * 24 * 3600 * 1000),
        sourceOrderId,
        creditId,
      });

      res.status(201).json({ success: true, credit });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /dev/mock-credits/:creditId/redeem
 */
mockLedgerRouter.post(
  '/dev/mock-credits/:creditId/redeem',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = req.tenantContext!.tenantId;
      const creditId = req.params.creditId as string;
      const { amount } = req.body;

      const credit = await mockLedgerService.redeemCredit({
        tenantId,
        creditId,
        amount: amount !== undefined ? Number(amount) : undefined,
      });

      res.status(200).json({ success: true, credit });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /dev/mock-credits/:creditId/extend-expiry
 */
mockLedgerRouter.post(
  '/dev/mock-credits/:creditId/extend-expiry',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = req.tenantContext!.tenantId;
      const creditId = req.params.creditId as string;
      const { expiresAt } = req.body;

      const credit = await mockLedgerService.extendExpiry({
        tenantId,
        creditId,
        expiresAt,
      });

      res.status(200).json({ success: true, credit });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /dev/mock-credits/:creditId/expire
 */
mockLedgerRouter.post(
  '/dev/mock-credits/:creditId/expire',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = req.tenantContext!.tenantId;
      const creditId = req.params.creditId as string;

      const credit = await mockLedgerService.expireCredit({
        tenantId,
        creditId,
      });

      res.status(200).json({ success: true, credit });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /dev/mock-credits/:creditId/revoke
 */
mockLedgerRouter.post(
  '/dev/mock-credits/:creditId/revoke',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = req.tenantContext!.tenantId;
      const creditId = req.params.creditId as string;

      const credit = await mockLedgerService.revokeCredit({
        tenantId,
        creditId,
      });

      res.status(200).json({ success: true, credit });
    } catch (err) {
      next(err);
    }
  }
);

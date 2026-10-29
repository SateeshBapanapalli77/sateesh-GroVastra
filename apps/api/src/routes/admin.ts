import { Router, Request, Response, NextFunction } from 'express';
import { clock } from '../services/clock';
import { ClockOffsetBodySchema } from '@grovastra/shared';
import { ForbiddenError } from '../errors/app-error';

export const adminRouter = Router();

/**
 * Guard middleware: Disable all clock administration in production
 */
adminRouter.use((req: Request, res: Response, next: NextFunction) => {
  if (clock.isProduction()) {
    next(new ForbiddenError('Admin clock endpoints are disabled in production mode'));
    return;
  }
  next();
});

/**
 * Get current clock status
 */
adminRouter.get('/clock', (req: Request, res: Response) => {
  res.status(200).json(clock.getStatus());
});

import mongoose from 'mongoose';

/**
 * Set dev clock offset in milliseconds
 */
adminRouter.post('/clock/offset', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const validated = ClockOffsetBodySchema.parse(req.body);
    clock.setOffsetMs(validated.offsetMs);

    try {
      if (mongoose.connection.readyState === 1) {
        await mongoose.connection.db?.collection('devClockOffsets').updateOne(
          { key: 'global' },
          { $set: { offsetMs: validated.offsetMs, updatedAt: new Date() } },
          { upsert: true }
        );
      }
    } catch {
      // Non-blocking in case of offline db
    }

    req.log.info({ offsetMs: validated.offsetMs, newTime: clock.iso() }, 'Dev clock offset updated');
    res.status(200).json(clock.getStatus());
  } catch (err) {
    next(err);
  }
});

/**
 * Reset dev clock offset to 0
 */
adminRouter.post('/clock/reset', async (req: Request, res: Response, next: NextFunction) => {
  try {
    clock.resetOffset();

    try {
      if (mongoose.connection.readyState === 1) {
        await mongoose.connection.db?.collection('devClockOffsets').updateOne(
          { key: 'global' },
          { $set: { offsetMs: 0, updatedAt: new Date() } },
          { upsert: true }
        );
      }
    } catch {
      // Non-blocking in case of offline db
    }

    req.log.info({ newTime: clock.iso() }, 'Dev clock offset reset to zero');
    res.status(200).json(clock.getStatus());
  } catch (err) {
    next(err);
  }
});

/**
 * Re-seed dev database with selected scenario (dev/test only, disabled in production)
 */
adminRouter.post('/seed', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { seedDatabase } = await import('../db/seed');
    const scenario = req.body?.scenario || 'base';
    req.log.info({ scenario }, 'Triggering dev re-seed from admin API');
    const summary = await seedDatabase(scenario);
    res.status(200).json({
      message: `Database re-seeded successfully with scenario '${scenario}'`,
      summary,
    });
  } catch (err) {
    next(err);
  }
});


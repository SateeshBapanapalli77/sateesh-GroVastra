import { Router, Request, Response } from 'express';
import { clock } from '../services/clock';
import { checkDbHealth } from '../db/connection';
import { HealthStatus } from '@grovastra/shared';

export const healthRouter = Router();

const startTime = Date.now();

/**
 * Basic service health and clock status
 */
healthRouter.get('/health', (req: Request, res: Response) => {
  const uptimeSeconds = Math.floor((Date.now() - startTime) / 1000);
  const status: HealthStatus = {
    status: 'ok',
    timestamp: clock.iso(),
    uptimeSeconds,
    service: 'grovastra-api',
    version: '1.0.0',
    requestId: req.id,
    clock: {
      now: clock.iso(),
      offsetMs: clock.getOffsetMs(),
      isDevOffsetActive: clock.isDevOffsetActive(),
    },
  };

  res.status(200).json(status);
});

/**
 * Detailed MongoDB connection and replica set health check
 */
healthRouter.get('/health/db', async (req: Request, res: Response) => {
  const dbHealth = await checkDbHealth(req.id);

  if (dbHealth.status !== 'connected' || !dbHealth.isReplicaSet) {
    res.status(503).json(dbHealth);
    return;
  }

  res.status(200).json(dbHealth);
});

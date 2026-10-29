import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { REQUEST_ID_HEADER } from '@grovastra/shared';
import { logger } from '../logger/logger';
import pino from 'pino';

// Extend Express Request interface
declare global {
  namespace Express {
    interface Request {
      id: string;
      log: pino.Logger;
    }
  }
}

export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incomingId = req.headers[REQUEST_ID_HEADER];
  const requestId = typeof incomingId === 'string' && incomingId.trim().length > 0
    ? incomingId.trim()
    : `req_${crypto.randomUUID()}`;

  req.id = requestId;
  res.setHeader(REQUEST_ID_HEADER, requestId);

  req.log = logger.child({ requestId });
  next();
}

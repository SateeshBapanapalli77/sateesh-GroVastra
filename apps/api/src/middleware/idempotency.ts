import { Request, Response, NextFunction } from 'express';
import { IdempotencyRecordModel } from '../db/models/idempotency-record.model';
import { ValidationError } from '../errors/app-error';

export interface IdempotencyOptions {
  required?: boolean;
}

/**
 * Idempotency-key middleware for mutating routes.
 * Caches and replays results for identical (tenantId, key) pairs to prevent duplicate mutations (spec p26, C15).
 */
export function idempotencyMiddleware(options: IdempotencyOptions = { required: true }) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    // Only inspect mutating HTTP methods
    if (!['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method)) {
      return next();
    }

    const tenantId = req.tenantContext?.tenantId;
    if (!tenantId) {
      // Must be authenticated first
      return next();
    }

    const rawKey =
      (req.headers['idempotency-key'] as string | undefined) ||
      (req.headers['x-idempotency-key'] as string | undefined) ||
      req.body?.idempotencyKey;

    if (!rawKey || typeof rawKey !== 'string' || !rawKey.trim()) {
      if (options.required) {
        return next(
          new ValidationError(
            'An Idempotency-Key header (or idempotencyKey field) is required for this mutating operation'
          )
        );
      }
      return next();
    }

    const key = rawKey.trim();

    try {
      // Check existing cached result
      const existing = (await IdempotencyRecordModel.findOne({ tenantId, key }).lean()) as any;
      if (existing) {
        req.log?.info(
          { tenantId, key, statusCode: existing.statusCode },
          'Returning cached response for repeated idempotency key'
        );
        res.setHeader('x-idempotent-replay', 'true');
        res.status(existing.statusCode).json(existing.responseBody);
        return;
      }

      // Intercept res.json to capture response body
      const originalJson = res.json.bind(res);

      res.json = function (body: unknown): Response {
        // Restore original method
        res.json = originalJson;

        // Persist only non-5xx responses before flushing to client
        if (res.statusCode < 500) {
          void IdempotencyRecordModel.findOneAndUpdate(
            { tenantId, key },
            {
              tenantId,
              key,
              method: req.method,
              path: req.originalUrl || req.path,
              statusCode: res.statusCode,
              responseBody: body,
              createdAt: new Date(),
            },
            { upsert: true, new: true }
          )
            .then(() => {
              originalJson(body);
            })
            .catch((err) => {
              req.log?.error({ err, key, tenantId }, 'Failed to persist idempotency record');
              originalJson(body);
            });

          return res;
        }

        return originalJson(body);
      };

      next();
    } catch (err) {
      next(err);
    }
  };
}

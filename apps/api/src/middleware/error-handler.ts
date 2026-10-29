import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { AppError } from '../errors/app-error';
import { ERROR_CODES, ApiErrorResponse } from '@grovastra/shared';
import { ReplicaSetRequiredError } from '../db/connection';

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  next: NextFunction
): void {
  const requestId = req.id;
  const reqLog = req.log ?? console;

  // 1. Zod Validation Errors
  if (err instanceof ZodError || (err instanceof Error && err.name === 'ZodError') || (typeof err === 'object' && err !== null && 'issues' in err)) {
    const issues = (err as ZodError).errors || (err as { issues: Array<{ path: (string | number)[]; message: string; code: string }> }).issues || [];
    const details = issues.map((e) => ({
      field: Array.isArray(e.path) ? e.path.join('.') : String(e.path),
      message: e.message,
      code: e.code,
    }));

    const response: ApiErrorResponse = {
      error: {
        code: ERROR_CODES.VALIDATION_ERROR,
        message: 'Invalid request input',
        details,
        requestId,
      },
    };

    reqLog.warn({ err, details }, 'Validation error');
    res.status(400).json(response);
    return;
  }

  // 2. Custom AppError instances
  if (err instanceof AppError) {
    const fieldPath = (err as any).fieldPath || (err.details as any)?.fieldPath;
    const response: any = {
      error: {
        code: err.code,
        message: err.message,
        details: err.details,
        ...(fieldPath ? { fieldPath } : {}),
        requestId,
      },
      ...(fieldPath ? { fieldPath, errors: [{ fieldPath, message: err.message }] } : {}),
    };

    if (err.statusCode >= 500) {
      reqLog.error({ err, details: err.details }, 'Server AppError');
    } else {
      reqLog.warn({ err, details: err.details }, 'Client AppError');
    }

    res.status(err.statusCode).json(response);
    return;
  }

  // 3. ReplicaSetRequiredError
  if (err instanceof ReplicaSetRequiredError) {
    const response: ApiErrorResponse = {
      error: {
        code: ERROR_CODES.REPLICA_SET_REQUIRED,
        message: err.message,
        requestId,
      },
    };

    reqLog.error({ err }, 'ReplicaSetRequiredError encountered in request');
    res.status(503).json(response);
    return;
  }

  // 4. Fallback unknown errors
  const standardError = err instanceof Error ? err : new Error(String(err));
  reqLog.error({ err: standardError }, 'Unhandled internal server error');

  const response: ApiErrorResponse = {
    error: {
      code: ERROR_CODES.INTERNAL_SERVER_ERROR,
      message: 'An unexpected internal server error occurred',
      requestId,
    },
  };

  res.status(500).json(response);
}

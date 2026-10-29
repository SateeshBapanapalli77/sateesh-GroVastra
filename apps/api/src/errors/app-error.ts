import { ERROR_CODES, ErrorCode } from '@grovastra/shared';

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: ErrorCode | string;
  public readonly details?: Record<string, unknown> | unknown[];

  constructor(
    message: string,
    statusCode = 500,
    code: ErrorCode | string = ERROR_CODES.INTERNAL_SERVER_ERROR,
    details?: Record<string, unknown> | unknown[]
  ) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class ValidationError extends AppError {
  constructor(message = 'Validation failed', details?: Record<string, unknown> | unknown[]) {
    super(message, 400, ERROR_CODES.VALIDATION_ERROR, details);
    this.name = 'ValidationError';
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Resource not found') {
    super(message, 404, ERROR_CODES.NOT_FOUND);
    this.name = 'NotFoundError';
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Access forbidden') {
    super(message, 403, ERROR_CODES.FORBIDDEN);
    this.name = 'ForbiddenError';
  }
}

export class ConflictError extends AppError {
  constructor(message = 'Resource conflict', details?: Record<string, unknown>) {
    super(message, 409, ERROR_CODES.CONFLICT, details);
    this.name = 'ConflictError';
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Authentication required', details?: Record<string, unknown>) {
    super(message, 401, ERROR_CODES.UNAUTHORIZED, details);
    this.name = 'UnauthorizedError';
  }
}

export class RateLimitError extends AppError {
  constructor(message = 'Too many requests. Please try again later.', details?: Record<string, unknown>) {
    super(message, 429, ERROR_CODES.RATE_LIMIT_EXCEEDED, details);
    this.name = 'RateLimitError';
  }
}

export class BadRequestError extends AppError {
  constructor(message = 'Bad request', details?: Record<string, unknown> | unknown[]) {
    super(message, 400, ERROR_CODES.BAD_REQUEST, details);
    this.name = 'BadRequestError';
  }
}


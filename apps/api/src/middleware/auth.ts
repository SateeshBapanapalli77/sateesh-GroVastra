import { Request, Response, NextFunction } from 'express';
import { AUTH_COOKIE_NAME, TenantContext, UserRole } from '@grovastra/shared';
import { authService } from '../services/auth.service';
import { UnauthorizedError, ForbiddenError } from '../errors/app-error';

declare global {
  namespace Express {
    interface Request {
      tenantContext?: TenantContext;
    }
  }
}

/**
 * Authentication middleware.
 * Validates session token from httpOnly cookie or Authorization Bearer header.
 * Attaches verified tenantContext {tenantId, userId, role, branchIds, email} to the request.
 */
export function authenticate(req: Request, res: Response, next: NextFunction): void {
  let token: string | undefined;

  // 1. Check httpOnly cookie
  if (req.cookies && req.cookies[AUTH_COOKIE_NAME]) {
    token = req.cookies[AUTH_COOKIE_NAME];
  }

  // 2. Check Authorization Bearer header (for automated testing / API clients)
  if (!token && req.headers.authorization) {
    const parts = req.headers.authorization.split(' ');
    if (parts.length === 2 && parts[0].toLowerCase() === 'bearer') {
      token = parts[1];
    }
  }

  if (!token) {
    return next(new UnauthorizedError('Authentication required. Missing session cookie or token.'));
  }

  try {
    const payload = authService.verifyToken(token);
    req.tenantContext = {
      tenantId: payload.tenantId,
      userId: payload.userId,
      role: payload.role,
      branchIds: payload.branchIds || [],
      email: payload.email,
    };

    // Enrich contextual logger with tenant and user ID
    req.log = req.log.child({
      tenantId: payload.tenantId,
      userId: payload.userId,
      role: payload.role,
    });

    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Role-based authorization middleware.
 * Requires that the authenticated user possesses one of the allowed roles.
 */
export function requireRole(...allowedRoles: (UserRole | UserRole[])[]) {
  const flattened = allowedRoles.flat() as UserRole[];
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.tenantContext) {
      return next(new UnauthorizedError('Authentication required before checking roles'));
    }

    if (!flattened.includes(req.tenantContext.role)) {
      return next(
        new ForbiddenError(
          `Access forbidden: Role '${req.tenantContext.role}' does not have sufficient permission for this resource.`
        )
      );
    }

    next();
  };
}

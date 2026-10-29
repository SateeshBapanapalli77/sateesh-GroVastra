import { Router, Request, Response, NextFunction } from 'express';
import { AUTH_COOKIE_NAME, LoginBodySchema, UserRole } from '@grovastra/shared';
import { authService } from '../services/auth.service';
import { authenticate } from '../middleware/auth';
import { loginRateLimitMiddleware, loginRateLimiter } from '../middleware/rate-limiter';
import { ValidationError } from '../errors/app-error';
import { config } from '../config/env';
import { TenantModel } from '../db/models/tenant.model';
import { UserModel } from '../db/models/user.model';
import { auditService } from '../services/audit.service';

export const authRouter = Router();

/**
 * POST /auth/login
 * Authenticates user via email and password, issues httpOnly session cookie.
 */
authRouter.post(
  '/auth/login',
  loginRateLimitMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = LoginBodySchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError('Invalid login request parameters', parsed.error.flatten().fieldErrors);
      }

      const clientIp = req.ip || req.socket.remoteAddress;
      const userAgent = req.headers['user-agent'];

      try {
        const { token, response } = await authService.login(
          parsed.data.email,
          parsed.data.password,
          clientIp,
          userAgent
        );

        // Record rate limit success
        loginRateLimiter.recordSuccess(req);

        // Set secure httpOnly session cookie
        res.cookie(AUTH_COOKIE_NAME, token, {
          httpOnly: true,
          secure: config.NODE_ENV === 'production',
          sameSite: 'lax',
          maxAge: 24 * 60 * 60 * 1000, // 24 hours
          path: '/',
        });

        // Also return token in body for automated testing or non-cookie clients
        res.status(200).json({
          ...response,
          token,
        });
      } catch (authErr) {
        loginRateLimiter.recordFailure(req);
        throw authErr;
      }
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /auth/logout
 * Clears httpOnly session cookie and logs audit event.
 */
authRouter.post('/auth/logout', async (req: Request, res: Response, next: NextFunction) => {
  try {
    let token: string | undefined = req.cookies?.[AUTH_COOKIE_NAME];
    if (!token && req.headers.authorization) {
      const parts = req.headers.authorization.split(' ');
      if (parts.length === 2 && parts[0].toLowerCase() === 'bearer') {
        token = parts[1];
      }
    }

    if (token) {
      try {
        const payload = authService.verifyToken(token);
        await auditService.logEvent({
          tenantId: payload.tenantId,
          userId: payload.userId,
          action: 'auth.logout',
          ip: req.ip || req.socket.remoteAddress,
          userAgent: req.headers['user-agent'],
        });
      } catch {
        // Ignore token verification errors during logout
      }
    }

    res.clearCookie(AUTH_COOKIE_NAME, {
      httpOnly: true,
      secure: config.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
    });

    res.status(200).json({
      message: 'Logged out successfully',
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /auth/me
 * Returns current authenticated user and tenant context.
 */
authRouter.get('/auth/me', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ctx = req.tenantContext!;
    const user = await UserModel.findOne({ _id: ctx.userId, tenantId: ctx.tenantId });
    const tenant = await TenantModel.findOne({ tenantId: ctx.tenantId });

    if (!user || !tenant) {
      res.clearCookie(AUTH_COOKIE_NAME, { path: '/' });
      return res.status(401).json({
        error: {
          code: 'UNAUTHORIZED',
          message: 'User or tenant record no longer exists',
        },
      });
    }

    res.status(200).json({
      user: {
        id: user._id.toString(),
        tenantId: user.tenantId,
        email: user.email,
        role: user.role,
        branchIds: user.branchIds || [],
        name: user.name,
      },
      tenant: {
        tenantId: tenant.tenantId,
        name: tenant.name,
      },
    });
  } catch (err) {
    next(err);
  }
});

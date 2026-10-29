import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { config } from '../config/env';
import { UserModel, IUser } from '../db/models/user.model';
import { TenantModel } from '../db/models/tenant.model';
import { auditService } from './audit.service';
import { UnauthorizedError, NotFoundError, ForbiddenError } from '../errors/app-error';
import { SessionPayload, UserRole, LoginResponse, TenantContext } from '@grovastra/shared';
import { logger } from '../logger/logger';

const SALT_ROUNDS = 10;
const TOKEN_EXPIRY = '24h';

export class AuthService {
  public async hashPassword(password: string): Promise<string> {
    return bcrypt.hash(password, SALT_ROUNDS);
  }

  public async verifyPassword(password: string, hash: string): Promise<boolean> {
    return bcrypt.compare(password, hash);
  }

  public signToken(payload: SessionPayload): string {
    return jwt.sign(payload, config.SESSION_SECRET, {
      expiresIn: TOKEN_EXPIRY,
    });
  }

  public verifyToken(token: string): SessionPayload {
    try {
      const decoded = jwt.verify(token, config.SESSION_SECRET) as SessionPayload;
      return decoded;
    } catch (err) {
      throw new UnauthorizedError('Invalid or expired authentication session');
    }
  }

  public async login(
    email: string,
    plainPassword: string,
    ip?: string,
    userAgent?: string
  ): Promise<{ token: string; response: LoginResponse }> {
    const normalizedEmail = email.trim().toLowerCase();
    const user = await UserModel.findOne({ email: normalizedEmail });

    if (!user) {
      await auditService.logEvent({
        tenantId: 'unauthenticated',
        action: 'auth.login_failed',
        metadata: { email: normalizedEmail, reason: 'user_not_found' },
        ip,
        userAgent,
      });
      throw new UnauthorizedError('Invalid email or password');
    }

    const isMatch = await this.verifyPassword(plainPassword, user.passwordHash);
    if (!isMatch) {
      await auditService.logEvent({
        tenantId: user.tenantId,
        userId: user._id.toString(),
        action: 'auth.login_failed',
        metadata: { email: normalizedEmail, reason: 'invalid_password' },
        ip,
        userAgent,
      });
      throw new UnauthorizedError('Invalid email or password');
    }

    if (user.status !== 'active') {
      await auditService.logEvent({
        tenantId: user.tenantId,
        userId: user._id.toString(),
        action: 'auth.login_failed',
        metadata: { email: normalizedEmail, reason: 'user_inactive' },
        ip,
        userAgent,
      });
      throw new UnauthorizedError('User account is inactive');
    }

    const tenant = await TenantModel.findOne({ tenantId: user.tenantId });
    if (!tenant || tenant.status !== 'active') {
      throw new UnauthorizedError('Tenant organization is inactive or not found');
    }

    const payload: SessionPayload = {
      userId: user._id.toString(),
      tenantId: user.tenantId,
      role: user.role,
      branchIds: user.branchIds || [],
      email: user.email,
    };

    const token = this.signToken(payload);

    await auditService.logEvent({
      tenantId: user.tenantId,
      userId: user._id.toString(),
      action: 'auth.login_success',
      metadata: { role: user.role },
      ip,
      userAgent,
    });

    return {
      token,
      response: {
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
      },
    };
  }

  public async changeUserRole(
    actor: TenantContext,
    targetUserId: string,
    newRole: UserRole,
    ip?: string,
    userAgent?: string
  ): Promise<IUser> {
    // Role check: Only owner can promote to owner or modify admins, owner/admin can change staff
    if (actor.role !== 'owner' && actor.role !== 'admin') {
      throw new ForbiddenError('Only owners and admins can manage user roles');
    }

    if (actor.role === 'admin' && newRole === 'owner') {
      throw new ForbiddenError('Admins cannot promote users to owner');
    }

    // Scoped strictly to actor's tenantId
    const targetUser = await UserModel.findOne({
      _id: targetUserId,
      tenantId: actor.tenantId,
    });

    if (!targetUser) {
      throw new NotFoundError('User not found within your tenant');
    }

    if (actor.role === 'admin' && targetUser.role === 'owner') {
      throw new ForbiddenError('Admins cannot modify owner roles');
    }

    const oldRole = targetUser.role;
    targetUser.role = newRole;
    await targetUser.save();

    await auditService.logEvent({
      tenantId: actor.tenantId,
      userId: actor.userId,
      action: 'user.role_changed',
      metadata: {
        targetUserId: targetUser._id.toString(),
        targetEmail: targetUser.email,
        oldRole,
        newRole,
      },
      ip,
      userAgent,
    });

    return targetUser;
  }
}

export const authService = new AuthService();

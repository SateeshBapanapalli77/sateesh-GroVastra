import { Request, Response, NextFunction } from 'express';
import { RateLimitError } from '../errors/app-error';

interface RateLimitRecord {
  attempts: number;
  resetAt: number;
}

class LoginRateLimiter {
  private records: Map<string, RateLimitRecord> = new Map();
  private maxAttempts: number;
  private windowMs: number;

  constructor(maxAttempts = 5, windowMs = 15 * 60 * 1000) {
    this.maxAttempts = maxAttempts;
    this.windowMs = windowMs;

    // Periodic cleanup of expired records every 5 minutes
    setInterval(() => this.cleanup(), 5 * 60 * 1000).unref();
  }

  private getKey(req: Request): string {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const email = (req.body?.email || '').trim().toLowerCase();
    return `${ip}:${email}`;
  }

  public check(req: Request, res: Response, next: NextFunction): void {
    const key = this.getKey(req);
    const now = Date.now();
    const record = this.records.get(key);

    if (record) {
      if (now < record.resetAt) {
        if (record.attempts >= this.maxAttempts) {
          const retryAfterSec = Math.ceil((record.resetAt - now) / 1000);
          res.setHeader('Retry-After', retryAfterSec.toString());
          return next(
            new RateLimitError(
              `Too many failed login attempts. Please wait ${retryAfterSec} seconds before trying again.`,
              { retryAfterSec }
            )
          );
        }
      } else {
        // Window expired, reset
        this.records.delete(key);
      }
    }

    next();
  }

  public recordFailure(req: Request): void {
    const key = this.getKey(req);
    const now = Date.now();
    const record = this.records.get(key);

    if (!record || now >= record.resetAt) {
      this.records.set(key, {
        attempts: 1,
        resetAt: now + this.windowMs,
      });
    } else {
      record.attempts += 1;
    }
  }

  public recordSuccess(req: Request): void {
    const key = this.getKey(req);
    this.records.delete(key);
  }

  public resetAll(): void {
    this.records.clear();
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, record] of this.records.entries()) {
      if (now >= record.resetAt) {
        this.records.delete(key);
      }
    }
  }
}

export const loginRateLimiter = new LoginRateLimiter(5, 15 * 60 * 1000);

export const loginRateLimitMiddleware = (req: Request, res: Response, next: NextFunction) => {
  loginRateLimiter.check(req, res, next);
};

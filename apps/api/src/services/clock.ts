import { DateTime } from 'luxon';
import { config } from '../config/env';
import { ClockStatus } from '@grovastra/shared';

export interface IClock {
  /**
   * Returns current effective Date (BSON UTC Date).
   * Reflects any active dev offset in non-production environments.
   */
  now(): Date;

  /**
   * Returns ISO 8601 UTC string of the effective time.
   */
  iso(): string;

  /**
   * Returns current effective epoch milliseconds.
   */
  epochMs(): number;

  /**
   * Returns Luxon DateTime instance in the specified timezone (default 'UTC').
   */
  luxonNow(zone?: string): DateTime;

  /**
   * Returns the current time offset in milliseconds.
   */
  getOffsetMs(): number;

  /**
   * Sets time offset in milliseconds.
   * Throws in production environments.
   */
  setOffsetMs(ms: number): void;

  /**
   * Resets time offset to 0.
   * Throws in production environments.
   */
  resetOffset(): void;

  /**
   * Sets the effective time directly to the given Date by computing the required offset.
   * Throws in production environments.
   */
  setSystemTime(date: Date): void;

  /**
   * Returns true if a dev offset is actively applied.
   */
  isDevOffsetActive(): boolean;

  /**
   * Returns whether the clock is running in production mode.
   */
  isProduction(): boolean;

  /**
   * Returns detailed clock status summary.
   */
  getStatus(): ClockStatus;
}

export class SystemClock implements IClock {
  private offsetMs = 0;
  private readonly production: boolean;

  constructor(isProd = config.NODE_ENV === 'production', initialOffsetMs = config.DEV_TIME_OFFSET_MS) {
    this.production = isProd;
    if (!this.production && initialOffsetMs) {
      this.offsetMs = initialOffsetMs;
    }
  }

  public now(): Date {
    return new Date(Date.now() + this.offsetMs);
  }

  public iso(): string {
    return this.now().toISOString();
  }

  public epochMs(): number {
    return this.now().getTime();
  }

  public luxonNow(zone = 'UTC'): DateTime {
    return DateTime.fromMillis(this.epochMs(), { zone });
  }

  public getOffsetMs(): number {
    return this.offsetMs;
  }

  public setOffsetMs(ms: number): void {
    if (this.production) {
      throw new Error('Clock time offset manipulation is forbidden in production environment');
    }
    this.offsetMs = ms;
  }

  public resetOffset(): void {
    if (this.production) {
      throw new Error('Clock time offset manipulation is forbidden in production environment');
    }
    this.offsetMs = 0;
  }

  public setSystemTime(date: Date): void {
    if (this.production) {
      throw new Error('Clock time offset manipulation is forbidden in production environment');
    }
    this.offsetMs = date.getTime() - Date.now();
  }

  public isDevOffsetActive(): boolean {
    return !this.production && this.offsetMs !== 0;
  }

  public isProduction(): boolean {
    return this.production;
  }

  public getStatus(): ClockStatus {
    return {
      now: this.iso(),
      epochMs: this.epochMs(),
      offsetMs: this.offsetMs,
      isDevOffsetActive: this.isDevOffsetActive(),
      isProduction: this.production,
    };
  }
}

// Singleton instance for use across the application
export const clock: IClock = new SystemClock();

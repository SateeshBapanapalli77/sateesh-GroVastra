import { describe, it, expect, beforeEach } from 'vitest';
import { SystemClock } from '../src/services/clock';
import request from 'supertest';
import { createApp } from '../src/app';

describe('SystemClock Service', () => {
  let clock: SystemClock;

  beforeEach(() => {
    // Development mode clock
    clock = new SystemClock(false, 0);
  });

  it('returns current time close to real time by default', () => {
    const before = Date.now();
    const clockTime = clock.epochMs();
    const after = Date.now();

    expect(clockTime).toBeGreaterThanOrEqual(before);
    expect(clockTime).toBeLessThanOrEqual(after);
    expect(clock.isDevOffsetActive()).toBe(false);
  });

  it('correctly shifts time when offset is applied in development', () => {
    const oneHourMs = 3600 * 1000;
    clock.setOffsetMs(oneHourMs);

    const now = Date.now();
    expect(clock.epochMs()).toBeGreaterThanOrEqual(now + oneHourMs - 50);
    expect(clock.isDevOffsetActive()).toBe(true);
    expect(clock.getOffsetMs()).toBe(oneHourMs);

    const status = clock.getStatus();
    expect(status.offsetMs).toBe(oneHourMs);
    expect(status.isDevOffsetActive).toBe(true);
  });

  it('resets offset back to zero', () => {
    clock.setOffsetMs(50000);
    expect(clock.isDevOffsetActive()).toBe(true);

    clock.resetOffset();
    expect(clock.getOffsetMs()).toBe(0);
    expect(clock.isDevOffsetActive()).toBe(false);
  });

  it('produces valid Luxon DateTime in requested timezone', () => {
    const dt = clock.luxonNow('Asia/Kolkata');
    expect(dt.zoneName).toBe('Asia/Kolkata');
    expect(dt.isValid).toBe(true);
  });

  it('strictly forbids offset manipulation in production environment', () => {
    const prodClock = new SystemClock(true, 0);

    expect(prodClock.isProduction()).toBe(true);
    expect(prodClock.isDevOffsetActive()).toBe(false);

    expect(() => prodClock.setOffsetMs(60000)).toThrow(
      /Clock time offset manipulation is forbidden in production/
    );
    expect(() => prodClock.resetOffset()).toThrow(
      /Clock time offset manipulation is forbidden in production/
    );
  });
});

describe('Admin Clock HTTP Endpoints', () => {
  const app = createApp();

  it('GET /admin/clock returns status with epoch and now ISO string', async () => {
    const res = await request(app).get('/admin/clock');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('now');
    expect(res.body).toHaveProperty('epochMs');
    expect(res.body).toHaveProperty('offsetMs');
    expect(res.body).toHaveProperty('isDevOffsetActive');
    expect(res.body).toHaveProperty('isProduction');
  });

  it('POST /admin/clock/offset updates offset in dev mode', async () => {
    const res = await request(app)
      .post('/admin/clock/offset')
      .send({ offsetMs: 120000 });

    expect(res.status).toBe(200);
    expect(res.body.offsetMs).toBe(120000);
    expect(res.body.isDevOffsetActive).toBe(true);

    // Reset back
    await request(app).post('/admin/clock/reset');
  });

  it('POST /admin/clock/offset returns 400 validation error for invalid body', async () => {
    const res = await request(app)
      .post('/admin/clock/offset')
      .send({ offsetMs: 'not-a-number' });

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error');
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

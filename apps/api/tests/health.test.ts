import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app';
import { connectToDatabase, disconnectDatabase } from '../src/db/connection';
import { config } from '../src/config/env';

describe('Health Endpoints Integration', () => {
  const app = createApp();

  beforeAll(async () => {
    await connectToDatabase(config.MONGODB_URI, config.MONGODB_TEST_DB);
  });

  afterAll(async () => {
    await disconnectDatabase();
  });

  it('GET /health returns 200 with service info, clock, and requestId header', async () => {
    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.headers['x-request-id']).toBeDefined();
    expect(res.body.status).toBe('ok');
    expect(res.body.service).toBe('grovastra-api');
    expect(res.body.clock).toBeDefined();
    expect(typeof res.body.uptimeSeconds).toBe('number');
  });

  it('GET /health/db returns 200 with replica set details when connected', async () => {
    const res = await request(app).get('/health/db');

    expect(res.status).toBe(200);
    expect(res.headers['x-request-id']).toBeDefined();
    expect(res.body.status).toBe('connected');
    expect(res.body.isReplicaSet).toBe(true);
    expect(res.body.replicaSetName).toBe('rs0');
    expect(res.body.transactionsSupported).toBe(true);
    expect(res.body.isPrimary).toBe(true);
  });
});

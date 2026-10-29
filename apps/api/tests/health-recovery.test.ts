import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app';
import { connectToDatabase, disconnectDatabase } from '../src/db/connection';
import { config } from '../src/config/env';

describe('Database Disconnect & Auto-Recovery Verification', () => {
  const app = createApp();

  it('reports 503 Service Unavailable when database is disconnected (Red State)', async () => {
    // Explicitly disconnect database
    await disconnectDatabase();

    const res = await request(app).get('/health/db');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('disconnected');
    expect(res.body.isReplicaSet).toBe(false);
    expect(res.body.transactionsSupported).toBe(false);
    expect(res.body.error).toContain('MongoDB connection is not established');
  });

  it('recovers to 200 OK with replica set details when reconnected (Green State)', async () => {
    // Reconnect to replica set
    await connectToDatabase(config.MONGODB_URI, config.MONGODB_TEST_DB);

    const res = await request(app).get('/health/db');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('connected');
    expect(res.body.isReplicaSet).toBe(true);
    expect(res.body.replicaSetName).toBe('rs0');
    expect(res.body.transactionsSupported).toBe(true);
    expect(res.body.isPrimary).toBe(true);
  });
});

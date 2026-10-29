import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose, { Schema } from 'mongoose';
import { config } from '../src/config/env';
import { connectToDatabase, disconnectDatabase } from '../src/db/connection';

interface TestDoc {
  tenantId: string;
  name: string;
  counter: number;
}

const TestDocSchema = new Schema<TestDoc>(
  {
    tenantId: { type: String, required: true },
    name: { type: String, required: true },
    counter: { type: Number, default: 0 },
  },
  { collection: '__test_transaction_smoke', timestamps: true }
);

const TestModel = mongoose.model<TestDoc>('TestDoc', TestDocSchema);

describe('MongoDB Replica Set & Transaction Smoke Test', () => {
  beforeAll(async () => {
    // Connect to test database: MONGODB_TEST_DB
    await connectToDatabase(config.MONGODB_URI, config.MONGODB_TEST_DB);
    // Ensure test collection exists before transactions to avoid implicit DDL conflicts
    if (mongoose.connection.db) {
      await mongoose.connection.db.dropCollection('__test_transaction_smoke').catch(() => {});
      await TestModel.createCollection();
    }
  });

  afterAll(async () => {
    // Cleanup: Drop test collection and disconnect
    if (mongoose.connection.db) {
      await mongoose.connection.db.dropCollection('__test_transaction_smoke').catch(() => {});
    }
    await disconnectDatabase();
  });

  it('verifies that the connection is to a valid replica set', async () => {
    expect(mongoose.connection.readyState).toBe(1);
    const admin = mongoose.connection.db!.admin();
    const hello = (await admin.command({ hello: 1 })) as Record<string, unknown>;

    expect(hello.setName).toBeDefined();
    expect(typeof hello.setName).toBe('string');
  });

  it('successfully commits a multi-document transaction and persists data', async () => {
    const session = await mongoose.startSession();
    const testTenantId = 'tenant_smoke_test_1';

    try {
      session.startTransaction();

      // Create document within session
      await TestModel.create(
        [
          {
            tenantId: testTenantId,
            name: 'Committed Doc',
            counter: 100,
          },
        ],
        { session }
      );

      // Verify visible inside session
      const foundInSession = await TestModel.findOne({ tenantId: testTenantId, name: 'Committed Doc' }).session(session);
      expect(foundInSession).not.toBeNull();
      expect(foundInSession?.counter).toBe(100);

      // Commit the transaction
      await session.commitTransaction();
    } finally {
      await session.endSession();
    }

    // Verify document exists outside session in database
    const foundAfterCommit = await TestModel.findOne({ tenantId: testTenantId, name: 'Committed Doc' });
    expect(foundAfterCommit).not.toBeNull();
    expect(foundAfterCommit?.name).toBe('Committed Doc');
  });

  it('successfully aborts a transaction and rolls back changes without persisting', async () => {
    const session = await mongoose.startSession();
    const testTenantId = 'tenant_smoke_test_2';

    try {
      session.startTransaction();

      // Insert document inside session
      await TestModel.create(
        [
          {
            tenantId: testTenantId,
            name: 'Aborted Doc Should Rollback',
            counter: 999,
          },
        ],
        { session }
      );

      // Verify visible inside session
      const inside = await TestModel.findOne({ tenantId: testTenantId, name: 'Aborted Doc Should Rollback' }).session(session);
      expect(inside).not.toBeNull();

      // Explicitly abort transaction
      await session.abortTransaction();
    } finally {
      await session.endSession();
    }

    // Verify document DOES NOT exist after abort
    const foundAfterAbort = await TestModel.findOne({ tenantId: testTenantId, name: 'Aborted Doc Should Rollback' });
    expect(foundAfterAbort).toBeNull();
  });
});

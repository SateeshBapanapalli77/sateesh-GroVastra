import { describe, it, expect, vi } from 'vitest';
import mongoose from 'mongoose';
import { verifyReplicaSetAndTransactions, ReplicaSetRequiredError } from '../src/db/connection';

describe('Replica Set & Transaction Guard', () => {
  it('throws ReplicaSetRequiredError if server returns no setName (standalone mode)', async () => {
    // Mock connection that simulates standalone MongoDB server
    const mockConn = {
      db: {
        admin: () => ({
          command: vi.fn().mockResolvedValue({
            ismaster: true,
            isWritablePrimary: true,
            // Notice: no setName property!
          }),
        }),
      },
      startSession: vi.fn(),
    } as unknown as mongoose.Connection;

    await expect(verifyReplicaSetAndTransactions(mockConn)).rejects.toThrow(ReplicaSetRequiredError);
    await expect(verifyReplicaSetAndTransactions(mockConn)).rejects.toThrow(/standalone mode/);
  });

  it('throws ReplicaSetRequiredError if transaction execution fails', async () => {
    // Mock connection with setName but failing transactions
    const mockConn = {
      db: {
        admin: () => ({
          command: vi.fn().mockResolvedValue({
            setName: 'rs0',
            isWritablePrimary: true,
          }),
        }),
      },
      startSession: vi.fn().mockImplementation(() => {
        throw new Error('Transaction numbers are only allowed on a replica set member or mongos');
      }),
    } as unknown as mongoose.Connection;

    await expect(verifyReplicaSetAndTransactions(mockConn)).rejects.toThrow(ReplicaSetRequiredError);
    await expect(verifyReplicaSetAndTransactions(mockConn)).rejects.toThrow(/Transaction smoke check failed/);
  });

  it('includes clear Windows instructions in the error message', () => {
    const error = new ReplicaSetRequiredError('test failure');
    expect(error.message).toContain('mongod.cfg');
    expect(error.message).toContain('replSetName: rs0');
    expect(error.message).toContain('rs.initiate');
    expect(error.message).toContain('Restart-Service MongoDB');
  });
});

import mongoose from 'mongoose';
import { config } from '../config/env';
import { logger } from '../logger/logger';
import { DbHealthStatus } from '@grovastra/shared';

export class ReplicaSetRequiredError extends Error {
  constructor(details?: string) {
    const message = [
      '================================================================================',
      '[FATAL DATABASE ERROR] MongoDB is NOT configured as a replica set or does NOT support transactions!',
      details ? `Details: ${details}` : '',
      'GroVastra requires a replica set (spec p3, p25) for atomic campaign transactions.',
      '',
      'To enable a single-node replica set locally on Windows:',
      '1. Open mongod.cfg (typically in C:\\Program Files\\MongoDB\\Server\\<version>\\bin\\mongod.cfg).',
      '2. Add the replication block (preserve YAML indentation):',
      '   replication:',
      '     replSetName: rs0',
      '3. Restart the MongoDB Windows service: Restart-Service MongoDB',
      '4. In mongosh ("mongosh mongodb://localhost:27017"), run once:',
      '   rs.initiate({ _id: "rs0", members: [{ _id: 0, host: "localhost:27017" }] })',
      '5. Verify with rs.status(). Check that stateStr is "PRIMARY".',
      '6. Ensure MONGODB_URI in .env includes "?replicaSet=rs0".',
      '================================================================================',
    ].filter(Boolean).join('\n');

    super(message);
    this.name = 'ReplicaSetRequiredError';
  }
}

/**
 * Validates that the active MongoDB connection belongs to a replica set
 * and successfully supports multi-document transactions.
 */
export async function verifyReplicaSetAndTransactions(conn: mongoose.Connection): Promise<{
  replicaSetName: string;
  isPrimary: boolean;
  hosts: string[];
}> {
  if (!conn.db) {
    throw new ReplicaSetRequiredError('Database handle is unavailable.');
  }

  const admin = conn.db.admin();
  let helloResult: Record<string, unknown>;
  try {
    helloResult = (await admin.command({ hello: 1 })) as Record<string, unknown>;
  } catch (err: unknown) {
    // Fallback for older server versions
    helloResult = (await admin.command({ isMaster: 1 })) as Record<string, unknown>;
  }

  const setName = helloResult.setName as string | undefined;
  if (!setName) {
    throw new ReplicaSetRequiredError(
      'Server response indicated standalone mode (no setName present in hello/isMaster response).'
    );
  }

  // Attempt starting and aborting a transaction to verify transaction engine capability
  let session: mongoose.ClientSession | null = null;
  try {
    session = await conn.startSession();
    session.startTransaction();
    await session.abortTransaction();
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    throw new ReplicaSetRequiredError(`Transaction smoke check failed: ${errMsg}`);
  } finally {
    if (session) {
      await session.endSession();
    }
  }

  return {
    replicaSetName: setName,
    isPrimary: Boolean(helloResult.isWritablePrimary ?? helloResult.ismaster),
    hosts: Array.isArray(helloResult.hosts) ? (helloResult.hosts as string[]) : [],
  };
}

export async function connectToDatabase(
  uri = config.MONGODB_URI,
  dbName = (process.env.NODE_ENV === 'test' || config.NODE_ENV === 'test')
    ? (process.env.MONGODB_TEST_DB || config.MONGODB_TEST_DB || 'grovastra_test')
    : config.MONGODB_DB
): Promise<mongoose.Connection> {
  if (mongoose.connection.readyState === 1) {
    if (mongoose.connection.name === dbName) {
      return mongoose.connection;
    }
    await mongoose.disconnect();
  }

  try {
    logger.info({ uri: uri.replace(/\/\/.*@/, '//<redacted>@'), dbName }, 'Connecting to MongoDB...');
    await mongoose.connect(uri, {
      dbName,
      serverSelectionTimeoutMS: 5000,
    });

    // Mandatory check: Fail startup if not a replica set or no transaction support
    const rsInfo = await verifyReplicaSetAndTransactions(mongoose.connection);
    logger.info(
      {
        dbName,
        replicaSet: rsInfo.replicaSetName,
        isPrimary: rsInfo.isPrimary,
        hosts: rsInfo.hosts,
      },
      'Connected to MongoDB replica set successfully. Transactions are verified.'
    );

    return mongoose.connection;
  } catch (err) {
    if (err instanceof ReplicaSetRequiredError) {
      logger.error(err.message);
      await mongoose.disconnect();
      throw err;
    }
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error({ error: errMsg }, 'Failed to connect to MongoDB');
    throw err;
  }
}

export async function disconnectDatabase(): Promise<void> {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
    logger.info('Disconnected from MongoDB.');
  }
}

export async function checkDbHealth(requestId?: string): Promise<DbHealthStatus> {
  const isConnected = mongoose.connection.readyState === 1;
  const dbName = mongoose.connection.name || config.MONGODB_DB;

  if (!isConnected || !mongoose.connection.db) {
    return {
      status: 'disconnected',
      database: dbName,
      isReplicaSet: false,
      transactionsSupported: false,
      error: 'MongoDB connection is not established (readyState: ' + mongoose.connection.readyState + ')',
      timestamp: new Date().toISOString(),
      requestId,
    };
  }

  try {
    const admin = mongoose.connection.db.admin();
    const hello = (await admin.command({ hello: 1 })) as Record<string, unknown>;
    const setName = hello.setName as string | undefined;

    return {
      status: 'connected',
      database: dbName,
      isReplicaSet: Boolean(setName),
      replicaSetName: setName,
      isPrimary: Boolean(hello.isWritablePrimary ?? hello.ismaster),
      transactionsSupported: Boolean(setName),
      hosts: Array.isArray(hello.hosts) ? (hello.hosts as string[]) : undefined,
      timestamp: new Date().toISOString(),
      requestId,
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    return {
      status: 'error',
      database: dbName,
      isReplicaSet: false,
      transactionsSupported: false,
      error: errMsg,
      timestamp: new Date().toISOString(),
      requestId,
    };
  }
}

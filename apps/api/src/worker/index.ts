import { config } from '../config/env';
import { logger } from '../logger/logger';
import { connectToDatabase, disconnectDatabase } from '../db/connection';
import { workerService, startWorkerLoop, stopWorkerLoop } from '../services/worker';

async function bootstrapWorker() {
  try {
    logger.info('Starting GroVastra Campaign Worker Process (Spec p19, p25)...');
    logger.info(
      { nodeEnv: config.NODE_ENV, dispatchMode: config.DISPATCH_MODE },
      'Initializing worker environment'
    );

    // Connect to MongoDB with replica set / transaction verification
    await connectToDatabase(config.MONGODB_URI, config.MONGODB_DB);

    // Run initial startup cycle
    logger.info('Executing startup worker evaluation cycle...');
    const result = await workerService.runWorkerCycle();
    logger.info(
      {
        claimed: result.claimedCount,
        dispatched: result.dispatchedCount,
        skipped: result.skippedCount,
        cancelled: result.cancelledCount,
      },
      'Startup worker cycle completed'
    );

    // Start recurring worker loop (default 5 seconds)
    const intervalMs = Number(process.env.WORKER_INTERVAL_MS) || 5000;
    startWorkerLoop(intervalMs);
    logger.info(`⚙️ Campaign Worker loop active. Polling due executions every ${intervalMs / 1000}s.`);

    // Graceful shutdown handling
    const shutdown = async (signal: string) => {
      logger.info({ signal }, 'Shutdown signal received. Stopping worker loop and closing database...');
      stopWorkerLoop();
      await disconnectDatabase();
      logger.info('Worker process shutdown complete.');
      process.exit(0);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.fatal({ err: errMsg }, 'Fatal error during Worker bootstrap. Process terminating.');
    process.exit(1);
  }
}

if (require.main === module) {
  bootstrapWorker();
}

export { bootstrapWorker };

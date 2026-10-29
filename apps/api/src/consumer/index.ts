import { config } from '../config/env';
import { logger } from '../logger/logger';
import { connectToDatabase, disconnectDatabase } from '../db/connection';
import { eventConsumerService } from '../services/event-consumer';

let consumerLoopTimer: NodeJS.Timeout | null = null;
let isProcessing = false;

export function startConsumerLoop(intervalMs: number = 5000): void {
  if (consumerLoopTimer) return;

  consumerLoopTimer = setInterval(async () => {
    if (isProcessing) return;
    try {
      isProcessing = true;
      const result = await eventConsumerService.processPendingEvents({ limit: 50 });
      if (result.processedCount > 0 || result.quarantinedCount > 0 || result.failedCount > 0) {
        logger.info(
          {
            processed: result.processedCount,
            quarantined: result.quarantinedCount,
            failed: result.failedCount,
          },
          'Event Consumer cycle processed pending inbox events'
        );
      }
    } catch (err: any) {
      logger.error({ err: err.message }, 'Error in Event Consumer loop cycle');
    } finally {
      isProcessing = false;
    }
  }, intervalMs);
}

export function stopConsumerLoop(): void {
  if (consumerLoopTimer) {
    clearInterval(consumerLoopTimer);
    consumerLoopTimer = null;
  }
}

async function bootstrapConsumer() {
  try {
    logger.info('Starting GroVastra Event Consumer Process (Spec p20, p24, p25)...');
    logger.info({ nodeEnv: config.NODE_ENV }, 'Initializing event consumer environment');

    await connectToDatabase(config.MONGODB_URI, config.MONGODB_DB);

    // Initial startup cycle
    logger.info('Executing startup event consumer cycle...');
    const result = await eventConsumerService.processPendingEvents({ limit: 100 });
    logger.info(
      {
        processed: result.processedCount,
        quarantined: result.quarantinedCount,
        failed: result.failedCount,
      },
      'Startup event consumer cycle completed'
    );

    const intervalMs = Number(process.env.EVENT_CONSUMER_INTERVAL_MS) || 5000;
    startConsumerLoop(intervalMs);
    logger.info(`📥 Event Consumer loop active. Polling inbox every ${intervalMs / 1000}s.`);

    const shutdown = async (signal: string) => {
      logger.info({ signal }, 'Shutdown signal received. Stopping consumer loop and disconnecting DB...');
      stopConsumerLoop();
      await disconnectDatabase();
      logger.info('Event Consumer process shutdown complete.');
      process.exit(0);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.fatal({ err: errMsg }, 'Fatal error during Event Consumer bootstrap. Process terminating.');
    process.exit(1);
  }
}

if (require.main === module) {
  bootstrapConsumer();
}

export { bootstrapConsumer };

import { app } from './app';
import { config } from './config/env';
import { logger } from './logger/logger';
import { connectToDatabase, disconnectDatabase } from './db/connection';

async function bootstrap() {
  try {
    logger.info('Starting GroVastra API Server...');
    logger.info({ nodeEnv: config.NODE_ENV, port: config.PORT }, 'Initializing environment');

    // Connect to MongoDB and strictly verify replica set / transactions
    await connectToDatabase(config.MONGODB_URI, config.MONGODB_DB);

    const server = app.listen(config.PORT, () => {
      logger.info(`🚀 GroVastra API Server listening on http://localhost:${config.PORT}`);
      logger.info(`Health check: http://localhost:${config.PORT}/health`);
      logger.info(`DB Health check: http://localhost:${config.PORT}/health/db`);
    });

    // Graceful shutdown handling
    const shutdown = async (signal: string) => {
      logger.info({ signal }, 'Shutdown signal received. Closing HTTP server and database...');
      server.close(async () => {
        await disconnectDatabase();
        logger.info('Server shutdown complete. Exiting process.');
        process.exit(0);
      });

      // Force exit after 10s if graceful fails
      setTimeout(() => {
        logger.error('Graceful shutdown timed out. Forcing process exit.');
        process.exit(1);
      }, 10000).unref();
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.fatal({ err: errMsg }, 'Fatal error during API bootstrap. Process terminating.');
    process.exit(1);
  }
}

// Start only if executed directly
if (require.main === module) {
  bootstrap();
}

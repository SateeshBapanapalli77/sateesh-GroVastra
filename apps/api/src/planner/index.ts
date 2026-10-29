import { config } from '../config/env';
import { logger } from '../logger/logger';
import { connectToDatabase, disconnectDatabase } from '../db/connection';
import { plannerService, startPlannerLoop, stopPlannerLoop } from '../services/planner';

async function bootstrapPlanner() {
  try {
    logger.info('Starting GroVastra Calendar Planner Engine (Spec p17)...');
    logger.info({ nodeEnv: config.NODE_ENV }, 'Initializing planner environment');

    // Connect to MongoDB with replica set / transaction verification
    await connectToDatabase(config.MONGODB_URI, config.MONGODB_DB);

    // Run initial cycle
    logger.info('Executing startup calendar planner evaluation cycle...');
    const results = await plannerService.runPlannerCycle();
    logger.info({ plannedCampaigns: results.length }, 'Startup planner cycle completed');

    // Start recurring interval loop (default 15 minutes)
    const intervalMinutes = Number(process.env.PLANNER_INTERVAL_MINUTES) || 15;
    const intervalMs = Number(process.env.PLANNER_INTERVAL_MS) || intervalMinutes * 60 * 1000;
    startPlannerLoop(intervalMs);
    logger.info(`⏰ Calendar Planner loop active. Scheduled every ${intervalMinutes} minute(s).`);

    // Graceful shutdown handling
    const shutdown = async (signal: string) => {
      logger.info({ signal }, 'Shutdown signal received. Stopping planner loop and closing database...');
      stopPlannerLoop();
      await disconnectDatabase();
      logger.info('Planner process shutdown complete.');
      process.exit(0);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.fatal({ err: errMsg }, 'Fatal error during Planner bootstrap. Process terminating.');
    process.exit(1);
  }
}

if (require.main === module) {
  bootstrapPlanner();
}

export { bootstrapPlanner };

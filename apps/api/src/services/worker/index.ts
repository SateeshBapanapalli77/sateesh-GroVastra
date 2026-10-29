import { workerService } from './worker.service';
import { logger } from '../../logger';

export * from './worker.service';

let workerIntervalHandle: NodeJS.Timeout | null = null;

export function startWorkerLoop(intervalMs = 5000): void {
  if (workerIntervalHandle) return;
  workerIntervalHandle = setInterval(async () => {
    try {
      await workerService.runWorkerCycle();
    } catch (err: any) {
      logger.error({ err: err?.message || err }, 'Error in recurring worker cycle');
    }
  }, intervalMs);
}

export function stopWorkerLoop(): void {
  if (workerIntervalHandle) {
    clearInterval(workerIntervalHandle);
    workerIntervalHandle = null;
  }
}

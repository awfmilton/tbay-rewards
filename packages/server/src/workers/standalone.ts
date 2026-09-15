/**
 * Standalone worker process.
 *
 * Runs the background jobs without serving HTTP, so the API container can be
 * scaled horizontally while exactly one worker container owns the schedule.
 * Every job claims its work with `FOR UPDATE SKIP LOCKED` or a unique key, so
 * running more than one worker is safe — just unnecessary.
 */
import { config } from '../config.js';
import { closeDb } from '../db/pool.js';
import { startWorkers, stopWorkers } from './index.js';

const cfg = config();

const logger = {
  info: (obj: unknown, msg?: string) => console.log(JSON.stringify({ level: 'info', obj, msg })),
  error: (obj: unknown, msg?: string) => console.error(JSON.stringify({ level: 'error', obj, msg })),
};

logger.info({ env: cfg.env }, 'tbay-rewards worker starting');
startWorkers(logger);

// Nothing else holds the event loop open, so keep the process alive explicitly.
const keepAlive = setInterval(() => {}, 1 << 30);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void (async () => {
      logger.info({ signal }, 'shutting down');
      stopWorkers();
      clearInterval(keepAlive);
      await closeDb();
      process.exit(0);
    })();
  });
}

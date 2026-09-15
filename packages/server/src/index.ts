import { buildApp } from './app.js';
import { config } from './config.js';
import { closeDb } from './db/pool.js';
import { migrate } from './db/migrate.js';
import { startWorkers, stopWorkers } from './workers/index.js';
import { formatPreflight, preflight } from './lib/preflight.js';

const cfg = config();
const app = await buildApp();

// Migrating on boot keeps single-node deploys (the common case for a retailer
// self-hosting this) from needing a separate release step.
if (process.env.MIGRATE_ON_BOOT !== 'false') {
  const result = await migrate((message) => app.log.info(message));
  if (result.applied.length > 0) app.log.info(`applied ${result.applied.length} migration(s)`);
}

// Surface configuration that will cost money or credibility later. Errors are
// loud but non-fatal: refusing to boot would take a running store offline over
// a setting that only matters at redemption time.
const findings = preflight();
if (findings.length > 0) {
  app.log.warn(`\nTBAY Rewards preflight:\n${formatPreflight(findings)}\n`);
}

if (process.env.RUN_WORKERS !== 'false') {
  startWorkers(app.log);
}

await app.listen({ host: cfg.host, port: cfg.port });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void (async () => {
      app.log.info(`${signal} received, shutting down`);
      stopWorkers();
      await app.close();
      await closeDb();
      process.exit(0);
    })();
  });
}

import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, withTransaction } from './pool.js';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', 'migrations');

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

/**
 * Apply every .sql file in ./migrations exactly once, in filename order.
 * Each file runs inside its own transaction, so a failure leaves the database
 * on the last complete migration rather than half-way through one.
 */
export async function migrate(log: (message: string) => void = () => {}): Promise<MigrationResult> {
  await db().query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
  const { rows } = await db().query<{ name: string }>('SELECT name FROM schema_migrations');
  const done = new Set(rows.map((row) => row.name));

  const applied: string[] = [];
  const skipped: string[] = [];

  for (const file of files) {
    if (done.has(file)) {
      skipped.push(file);
      continue;
    }
    const sql = await readFile(join(migrationsDir, file), 'utf8');
    await withTransaction(async (client) => {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
    });
    applied.push(file);
    log(`applied ${file}`);
  }

  return { applied, skipped };
}

/** Drop and recreate the public schema. Test-only; refuses to run in production. */
export async function resetDatabase(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('resetDatabase() must never run against production');
  }
  await db().query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
}

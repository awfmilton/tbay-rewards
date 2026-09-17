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

/**
 * The advisory-lock key that serialises a reset-and-migrate.
 *
 * An arbitrary constant, but a *stable* one: two processes only exclude each
 * other if they ask for the same number.
 */
const SETUP_LOCK = 4_071_982_311;

/**
 * Reset and migrate, with no other process doing the same thing at the time.
 *
 * `DROP SCHEMA public CASCADE` plus thirty sequential migrations is not atomic,
 * and vitest's own config says as much ("run files serially so migrations and
 * per-file tenant fixtures never race each other") -- but `singleFork` only
 * serialises files *inside one invocation*. Two invocations against the same
 * database, or one invocation started while another is being torn down,
 * interleave: one drops the schema between the other's migrations, and the
 * next file to touch `tenants` fails with `relation "tenants" does not exist`.
 *
 * This is not hypothetical. A reviewer's first from-scratch run produced 71
 * failures across four files with exactly that error, plus one deadlock, and
 * an immediately repeated run was clean -- which is the worst possible shape
 * for a test suite, because it teaches everybody to re-run instead of read.
 *
 * `pg_advisory_lock` is session-scoped and held on one dedicated connection
 * for the whole reset-and-migrate, so the second process waits and then does
 * its own clean reset rather than landing in the middle of the first one.
 */
export async function resetAndMigrate(): Promise<MigrationResult> {
  const client = await db().connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [SETUP_LOCK]);
    await resetDatabase();
    return await migrate();
  } finally {
    // Released explicitly rather than by dropping the connection: a pooled
    // client goes back to the pool holding its session locks, and the next
    // borrower of that same connection would inherit one it never took.
    await client.query('SELECT pg_advisory_unlock($1)', [SETUP_LOCK]).catch(() => {});
    client.release();
  }
}

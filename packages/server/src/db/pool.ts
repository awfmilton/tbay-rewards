import pg from 'pg';
import { config } from '../config.js';

const { Pool, types } = pg;

// numeric(78,0) columns hold uint256 values; keep them as strings instead of
// letting node-postgres coerce them into lossy JS numbers.
types.setTypeParser(types.builtins.NUMERIC, (value: string) => value);
types.setTypeParser(types.builtins.INT8, (value: string) => Number(value));

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;

/** Anything that can run a query: the pool itself or a transaction client. */
export interface Queryable {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<pg.QueryResult<R>>;
}

let pool: pg.Pool | null = null;

export function db(): pg.Pool {
  if (!pool) {
    const cfg = config();
    pool = new Pool({
      connectionString: cfg.database.url,
      max: cfg.database.poolSize,
      ssl: cfg.database.ssl ? { rejectUnauthorized: false } : undefined,
      application_name: 'tbay-rewards',
    });
    pool.on('error', (err) => {
      // An idle client failing must not take the process down.
      console.error('[db] idle client error', err);
    });
  }
  return pool;
}

export async function closeDb(): Promise<void> {
  if (pool) {
    const current = pool;
    pool = null;
    await current.end();
  }
}

/** Run `fn` inside a transaction, rolling back on any throw. */
export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await db().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // The connection is already broken; releasing it is all we can do.
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function queryOne<R extends pg.QueryResultRow = pg.QueryResultRow>(
  runner: Queryable,
  text: string,
  values: unknown[] = [],
): Promise<R | null> {
  const result = await runner.query<R>(text, values);
  return result.rows[0] ?? null;
}

export async function queryMany<R extends pg.QueryResultRow = pg.QueryResultRow>(
  runner: Queryable,
  text: string,
  values: unknown[] = [],
): Promise<R[]> {
  const result = await runner.query<R>(text, values);
  return result.rows;
}

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
      // Without this, callers queue for a connection indefinitely: the pool
      // never sheds load, it just converts saturation into unbounded latency
      // while the client has long since given up.
      connectionTimeoutMillis: cfg.database.connectTimeoutMs,
      // A transaction left open by a crashed handler holds its row locks until
      // the connection dies. Ten seconds is far longer than any path here
      // legitimately needs between statements.
      options: `-c idle_in_transaction_session_timeout=${cfg.database.idleTxTimeoutMs}`,
      // Recycle connections so a long-lived process cannot accumulate
      // per-connection state or a stale plan cache.
      maxLifetimeSeconds: 1800,
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
    client.release();
    return result;
  } catch (err) {
    let broken = false;
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      // A failed ROLLBACK means the connection is not in a known state. Handing
      // it back as healthy puts the next caller on a session that may still be
      // inside an aborted transaction; `release(err)` destroys it instead.
      broken = true;
      client.release(rollbackError instanceof Error ? rollbackError : new Error('rollback failed'));
    }
    if (!broken) client.release();
    throw err;
  }

  // Note: no `finally`. The success path releases below, and the catch path
  // above decides between a clean release and destroying the connection — a
  // `finally` would double-release whichever branch already ran.
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

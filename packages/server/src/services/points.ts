import { db, queryOne, withTransaction, type Queryable } from '../db/pool.js';
import { ApiError } from '../lib/errors.js';

/**
 * The points ledger is append-only and every entry carries an idempotency key
 * unique within the tenant. `points_balances` is a cache written in the same
 * transaction as the entry, so a balance can never drift from its ledger.
 */

export interface LedgerEntry {
  id: string;
  tenant_id: string;
  contact_id: string;
  delta_points: number;
  reason: string;
  rule_key: string | null;
  ref_type: string | null;
  ref_id: string | null;
  idempotency_key: string;
  status: 'pending' | 'cleared' | 'reversed';
  available_at: Date;
  meta: Record<string, unknown>;
  created_at: Date;
}

export interface Balance {
  balance: number;
  pending: number;
  lifetime_earned: number;
  lifetime_spent: number;
}

export interface AwardInput {
  contactId: string;
  points: number;
  reason: string;
  ruleKey?: string | null;
  refType?: string | null;
  refId?: string | null;
  idempotencyKey: string;
  /** Hold the points (e.g. until a refund window closes) before they spend. */
  holdSeconds?: number;
  meta?: Record<string, unknown>;
}

export interface AwardResult {
  entry: LedgerEntry;
  balance: Balance;
  /** False when the idempotency key had already been booked. */
  created: boolean;
}

const ZERO_BALANCE: Balance = { balance: 0, pending: 0, lifetime_earned: 0, lifetime_spent: 0 };

export async function getBalance(
  tenantId: string,
  contactId: string,
  runner: Queryable = db(),
): Promise<Balance> {
  const row = await queryOne<Balance>(
    runner,
    `SELECT balance, pending, lifetime_earned, lifetime_spent
       FROM points_balances WHERE tenant_id = $1 AND contact_id = $2`,
    [tenantId, contactId],
  );
  return row ?? { ...ZERO_BALANCE };
}

/** Credit points. Re-running with the same idempotency key is a no-op. */
export async function award(
  tenantId: string,
  input: AwardInput,
  runner?: Queryable,
): Promise<AwardResult> {
  if (!Number.isInteger(input.points) || input.points <= 0) {
    throw ApiError.badRequest('points must be a positive integer');
  }

  const run = async (client: Queryable): Promise<AwardResult> => {
    const hold = Math.max(0, input.holdSeconds ?? 0);
    const status = hold > 0 ? 'pending' : 'cleared';

    const entry = await queryOne<LedgerEntry>(
      client,
      `INSERT INTO points_ledger (
         tenant_id, contact_id, delta_points, reason, rule_key, ref_type, ref_id,
         idempotency_key, status, available_at, meta
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now() + ($10 || ' seconds')::interval, $11::jsonb)
       ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
       RETURNING *`,
      [
        tenantId,
        input.contactId,
        input.points,
        input.reason,
        input.ruleKey ?? null,
        input.refType ?? null,
        input.refId ?? null,
        input.idempotencyKey,
        status,
        String(hold),
        JSON.stringify(input.meta ?? {}),
      ],
    );

    if (!entry) {
      const existing = await queryOne<LedgerEntry>(
        client,
        'SELECT * FROM points_ledger WHERE tenant_id = $1 AND idempotency_key = $2',
        [tenantId, input.idempotencyKey],
      );
      return {
        entry: existing!,
        balance: await getBalance(tenantId, input.contactId, client),
        created: false,
      };
    }

    const balance = await applyToBalance(client, tenantId, input.contactId, {
      balance: status === 'cleared' ? input.points : 0,
      pending: status === 'pending' ? input.points : 0,
      earned: input.points,
      spent: 0,
    });

    return { entry, balance, created: true };
  };

  return runner ? run(runner) : withTransaction(run);
}

export interface SpendInput {
  contactId: string;
  points: number;
  reason: string;
  refType?: string | null;
  refId?: string | null;
  idempotencyKey: string;
  meta?: Record<string, unknown>;
}

/**
 * Debit points, failing loudly rather than going negative.
 *
 * Takes a row lock on the balance so two concurrent redemptions cannot both see
 * the same balance and overspend it.
 */
export async function spend(
  tenantId: string,
  input: SpendInput,
  runner?: Queryable,
): Promise<AwardResult> {
  if (!Number.isInteger(input.points) || input.points <= 0) {
    throw ApiError.badRequest('points must be a positive integer');
  }

  const run = async (client: Queryable): Promise<AwardResult> => {
    const locked = await queryOne<{ balance: number }>(
      client,
      'SELECT balance FROM points_balances WHERE tenant_id = $1 AND contact_id = $2 FOR UPDATE',
      [tenantId, input.contactId],
    );
    const available = locked?.balance ?? 0;

    const existing = await queryOne<LedgerEntry>(
      client,
      'SELECT * FROM points_ledger WHERE tenant_id = $1 AND idempotency_key = $2',
      [tenantId, input.idempotencyKey],
    );
    if (existing) {
      return {
        entry: existing,
        balance: await getBalance(tenantId, input.contactId, client),
        created: false,
      };
    }

    if (available < input.points) {
      throw ApiError.unprocessable('Insufficient points balance', {
        balance: available,
        required: input.points,
      });
    }

    const entry = await queryOne<LedgerEntry>(
      client,
      `INSERT INTO points_ledger (
         tenant_id, contact_id, delta_points, reason, ref_type, ref_id,
         idempotency_key, status, meta
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'cleared', $8::jsonb)
       RETURNING *`,
      [
        tenantId,
        input.contactId,
        -input.points,
        input.reason,
        input.refType ?? null,
        input.refId ?? null,
        input.idempotencyKey,
        JSON.stringify(input.meta ?? {}),
      ],
    );

    const balance = await applyToBalance(client, tenantId, input.contactId, {
      balance: -input.points,
      pending: 0,
      earned: 0,
      spent: input.points,
    });

    return { entry: entry!, balance, created: true };
  };

  return runner ? run(runner) : withTransaction(run);
}

/**
 * Undo an earlier entry — a refunded order, an expired claim, a rejected share.
 * Writes a compensating entry rather than mutating history.
 */
export async function reverse(
  tenantId: string,
  entryId: string,
  reason: string,
  runner?: Queryable,
): Promise<LedgerEntry | null> {
  const run = async (client: Queryable): Promise<LedgerEntry | null> => {
    const original = await queryOne<LedgerEntry>(
      client,
      `SELECT * FROM points_ledger
        WHERE tenant_id = $1 AND id = $2 AND status <> 'reversed' FOR UPDATE`,
      [tenantId, entryId],
    );
    if (!original) return null;

    const compensation = await queryOne<LedgerEntry>(
      client,
      `INSERT INTO points_ledger (
         tenant_id, contact_id, delta_points, reason, ref_type, ref_id,
         idempotency_key, status, meta
       ) VALUES ($1, $2, $3, $4, 'ledger_entry', $5, $6, 'cleared', $7::jsonb)
       ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
       RETURNING *`,
      [
        tenantId,
        original.contact_id,
        -original.delta_points,
        reason,
        original.id,
        `reversal:${original.id}`,
        JSON.stringify({ reversed_entry: original.id }),
      ],
    );
    if (!compensation) return null;

    await client.query(
      `UPDATE points_ledger SET status = 'reversed', reversed_by = $2 WHERE id = $1`,
      [original.id, compensation.id],
    );

    const wasPending = original.status === 'pending';
    await applyToBalance(client, tenantId, original.contact_id, {
      // A pending award never reached the spendable balance, so only the pending
      // bucket unwinds.
      balance: wasPending ? 0 : -original.delta_points,
      pending: wasPending ? -original.delta_points : 0,
      earned: original.delta_points > 0 ? -original.delta_points : 0,
      spent: original.delta_points < 0 ? original.delta_points : 0,
    });

    return compensation;
  };

  return runner ? run(runner) : withTransaction(run);
}

/** Move matured `pending` awards into the spendable balance. */
export async function releaseMaturedPoints(runner: Queryable = db()): Promise<number> {
  return withTransactionIfPool(runner, async (client) => {
    const { rows } = await client.query<{
      id: string;
      tenant_id: string;
      contact_id: string;
      delta_points: number;
    }>(
      `UPDATE points_ledger SET status = 'cleared'
        WHERE id IN (
          SELECT id FROM points_ledger
           WHERE status = 'pending' AND available_at <= now()
           ORDER BY available_at
           LIMIT 500
           FOR UPDATE SKIP LOCKED
        )
        RETURNING id, tenant_id, contact_id, delta_points`,
    );

    for (const row of rows) {
      await applyToBalance(client, row.tenant_id, row.contact_id, {
        balance: row.delta_points,
        pending: -row.delta_points,
        earned: 0,
        spent: 0,
      });
    }
    return rows.length;
  });
}

async function applyToBalance(
  client: Queryable,
  tenantId: string,
  contactId: string,
  delta: { balance: number; pending: number; earned: number; spent: number },
): Promise<Balance> {
  // Two statements on purpose. An INSERT ... ON CONFLICT DO UPDATE evaluates
  // CHECK constraints against the *proposed* row before the conflict is
  // detected, so a negative delta trips points_balances_non_negative even when
  // the resulting balance is perfectly fine. Seeding the row first means the
  // constraint only ever sees the real post-update balance — which is exactly
  // the invariant it exists to protect.
  await client.query(
    `INSERT INTO points_balances (tenant_id, contact_id) VALUES ($1, $2)
     ON CONFLICT (tenant_id, contact_id) DO NOTHING`,
    [tenantId, contactId],
  );

  const row = await queryOne<Balance>(
    client,
    `UPDATE points_balances SET
       balance         = balance + $3,
       pending         = GREATEST(0, pending + $4),
       lifetime_earned = GREATEST(0, lifetime_earned + $5),
       lifetime_spent  = GREATEST(0, lifetime_spent + $6),
       updated_at      = now()
     WHERE tenant_id = $1 AND contact_id = $2
     RETURNING balance, pending, lifetime_earned, lifetime_spent`,
    [tenantId, contactId, delta.balance, delta.pending, delta.earned, delta.spent],
  );
  return row!;
}

async function withTransactionIfPool<T>(
  runner: Queryable,
  fn: (client: Queryable) => Promise<T>,
): Promise<T> {
  // The pool itself has no transaction semantics; a PoolClient already does.
  if (runner === (db() as unknown as Queryable)) return withTransaction(fn);
  return fn(runner);
}

export async function listLedger(
  tenantId: string,
  contactId: string,
  limit = 50,
  runner: Queryable = db(),
): Promise<LedgerEntry[]> {
  const { rows } = await runner.query<LedgerEntry>(
    `SELECT * FROM points_ledger
      WHERE tenant_id = $1 AND contact_id = $2
      ORDER BY created_at DESC
      LIMIT $3`,
    [tenantId, contactId, Math.min(limit, 200)],
  );
  return rows;
}

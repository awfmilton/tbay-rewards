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

    // Let the storefront mirror the new balance (myCred, a header badge, a
    // notification) without polling.
    const { enqueueWebhook } = await import('./automations.js');
    await enqueueWebhook(client, tenantId, 'points_awarded', {
      contact_id: input.contactId,
      points: input.points,
      reason: input.reason,
      balance: balance.balance,
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
      // An idempotency hit only means "already done" when it is the SAME
      // operation. If the key matches but the contact or amount differs, this
      // is a different debit wearing a borrowed key — returning early would
      // skip the balance check entirely and let it succeed for free.
      if (existing.contact_id !== input.contactId || -existing.delta_points !== input.points) {
        throw ApiError.conflict('That idempotency key was already used for a different operation', {
          idempotency_key: input.idempotencyKey,
        });
      }
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

    const { enqueueWebhook } = await import('./automations.js');
    await enqueueWebhook(client, tenantId, 'points_redeemed', {
      contact_id: input.contactId,
      points: input.points,
      reason: input.reason,
      balance: balance.balance,
    });

    return { entry: entry!, balance, created: true };
  };

  return runner ? run(runner) : withTransaction(run);
}

/**
 * Undo an earlier entry — a refunded order, an expired claim, a rejected share.
 * Writes a compensating entry rather than mutating history.
 */
export interface ReverseOptions {
  /**
   * Book as much of the reversal as the balance allows instead of failing.
   *
   * A refunded order whose points have already been redeemed for TBAY cannot be
   * fully clawed back — those tokens exist. Without this the whole refund
   * transaction rolls back on the non-negative balance constraint, so the
   * retailer's commissions never get voided either. Clamping books what it can
   * and records the shortfall.
   */
  clampToBalance?: boolean;
}

export async function reverse(
  tenantId: string,
  entryId: string,
  reason: string,
  runner?: Queryable,
  options: ReverseOptions = {},
): Promise<LedgerEntry | null> {
  const run = async (client: Queryable): Promise<LedgerEntry | null> => {
    const original = await queryOne<LedgerEntry>(
      client,
      `SELECT * FROM points_ledger
        WHERE tenant_id = $1 AND id = $2 AND status <> 'reversed' FOR UPDATE`,
      [tenantId, entryId],
    );
    if (!original) return null;

    const wasPendingEntry = original.status === 'pending';
    let delta = -original.delta_points;
    let shortfall = 0;

    // Clawing back a cleared award can exceed what is left, e.g. an order
    // refunded after its points were redeemed. Book what we can and record the
    // rest rather than failing the caller's whole transaction.
    if (options.clampToBalance && delta < 0 && !wasPendingEntry) {
      const current = await queryOne<{ balance: number }>(
        client,
        'SELECT balance FROM points_balances WHERE tenant_id = $1 AND contact_id = $2 FOR UPDATE',
        [tenantId, original.contact_id],
      );
      const available = current?.balance ?? 0;
      if (available < -delta) {
        shortfall = -delta - available;
        delta = -available;
      }
    }

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
        delta,
        reason,
        original.id,
        `reversal:${original.id}`,
        JSON.stringify({
          reversed_entry: original.id,
          ...(shortfall > 0 ? { shortfall_points: shortfall } : {}),
        }),
      ],
    );
    if (!compensation) return null;

    await client.query(
      `UPDATE points_ledger SET status = 'reversed', reversed_by = $2 WHERE id = $1`,
      [original.id, compensation.id],
    );

    await applyToBalance(client, tenantId, original.contact_id, {
      // A pending award never reached the spendable balance, so only the pending
      // bucket unwinds.
      balance: wasPendingEntry ? 0 : delta,
      pending: wasPendingEntry ? -original.delta_points : 0,
      earned: original.delta_points > 0 ? delta : 0,
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

export interface LedgerQuery {
  /** Omit for every contact — the view support needs to answer a question. */
  contactId?: string | null;
  ruleKey?: string | null;
  refType?: string | null;
  status?: LedgerEntry['status'] | null;
  /** 'credit' for awards only, 'debit' for spends only. */
  direction?: 'credit' | 'debit' | null;
  from?: Date | null;
  to?: Date | null;
  /** Matches the reason text or the contact's email. */
  search?: string | null;
  limit?: number;
  offset?: number;
}

export interface LedgerRow extends LedgerEntry {
  contact_email: string | null;
  contact_name: string | null;
}

/**
 * Search the ledger across contacts.
 *
 * `listLedger` above answers "what did this person earn", which is the
 * storefront's question. This one answers support's: "why does this customer
 * say they are missing 250 points", which needs a date range, a rule filter
 * and a search across everyone.
 *
 * The ledger stays append-only — there is deliberately no edit or delete here,
 * unlike myCred's admin log. A mistake is corrected with `reverse()`, which
 * leaves both entries visible.
 */
export async function queryLedger(
  tenantId: string,
  query: LedgerQuery = {},
  runner: Queryable = db(),
): Promise<{ rows: LedgerRow[]; total: number }> {
  const limit = Math.min(Math.max(query.limit ?? 50, 1), 1000);
  const offset = Math.max(query.offset ?? 0, 0);

  const where: string[] = ['l.tenant_id = $1'];
  const params: unknown[] = [tenantId];
  const add = (clause: string, value: unknown) => {
    params.push(value);
    where.push(clause.replace('$?', `$${params.length}`));
  };

  if (query.contactId) add('l.contact_id = $?', query.contactId);
  if (query.ruleKey) add('l.rule_key = $?', query.ruleKey);
  if (query.refType) add('l.ref_type = $?', query.refType);
  if (query.status) add('l.status = $?', query.status);
  if (query.direction === 'credit') where.push('l.delta_points > 0');
  if (query.direction === 'debit') where.push('l.delta_points < 0');
  if (query.from) add('l.created_at >= $?', query.from);
  if (query.to) add('l.created_at < $?', query.to);
  if (query.search) {
    // ILIKE with a leading wildcard cannot use a btree, so this is bounded by
    // the other filters. Support always has at least a date range in practice.
    params.push(`%${query.search}%`);
    where.push(
      `(l.reason ILIKE $${params.length} OR c.email ILIKE $${params.length} OR c.name ILIKE $${params.length})`,
    );
  }

  const clause = where.join(' AND ');

  const totalRow = await queryOne<{ n: string }>(
    runner,
    `SELECT COUNT(*) AS n FROM points_ledger l
       LEFT JOIN contacts c ON c.id = l.contact_id
      WHERE ${clause}`,
    params,
  );

  const { rows } = await runner.query<LedgerRow>(
    `SELECT l.*, c.email AS contact_email, c.name AS contact_name
       FROM points_ledger l
       LEFT JOIN contacts c ON c.id = l.contact_id
      WHERE ${clause}
      ORDER BY l.created_at DESC, l.id DESC
      LIMIT ${limit} OFFSET ${offset}`,
    params,
  );

  return { rows, total: Number(totalRow?.n ?? 0) };
}

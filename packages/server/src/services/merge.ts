import { db, queryOne, withTransaction, type Queryable } from '../db/pool.js';
import { ApiError } from '../lib/errors.js';

/**
 * Two records, one person.
 *
 * Duplicates are a daily fact of a store's life: somebody checks out as a
 * guest with one address and signs up with another, an import brings the same
 * customer in twice, a name is typed differently. Until now the only options
 * were to leave both — so their points are split across two balances and
 * neither shows the truth — or delete one and lose whichever history it held.
 *
 * Merging is irreversible and it moves money, so it is written to be boring:
 * one transaction, one direction, and a rule for every table rather than a
 * general "update contact_id everywhere" that silently violates a unique
 * constraint the moment two rows collide.
 */

export interface MergeResult {
  kept: string;
  merged: string;
  moved: Record<string, number>;
  points_moved: Record<string, number>;
}

/**
 * Tables where a row simply changes owner.
 *
 * Nothing here has a unique constraint involving `contact_id`, so two rows
 * pointing at the same contact is ordinary. History, in other words: the
 * losing record's orders and ledger entries become the survivor's.
 */
const REASSIGN: Array<{ table: string; column: string; tenantScoped: boolean }> = [
  { table: 'points_ledger', column: 'contact_id', tenantScoped: true },
  { table: 'orders', column: 'contact_id', tenantScoped: true },
  { table: 'carts', column: 'contact_id', tenantScoped: true },
  { table: 'events', column: 'contact_id', tenantScoped: true },
  { table: 'sessions', column: 'contact_id', tenantScoped: true },
  { table: 'visitors', column: 'contact_id', tenantScoped: true },
  { table: 'touchpoints', column: 'contact_id', tenantScoped: true },
  { table: 'email_messages', column: 'contact_id', tenantScoped: true },
  { table: 'email_events', column: 'contact_id', tenantScoped: true },
  { table: 'notifications', column: 'contact_id', tenantScoped: true },
  { table: 'share_events', column: 'contact_id', tenantScoped: true },
  { table: 'store_credits', column: 'contact_id', tenantScoped: true },
  { table: 'token_claims', column: 'contact_id', tenantScoped: true },
  { table: 'token_spend_intents', column: 'contact_id', tenantScoped: true },
  { table: 'bridge_withdrawals', column: 'contact_id', tenantScoped: true },
  { table: 'automation_runs', column: 'contact_id', tenantScoped: true },
  { table: 'wallet_challenges', column: 'contact_id', tenantScoped: true },
  { table: 'preference_changes', column: 'contact_id', tenantScoped: true },
  { table: 'coupon_redemptions', column: 'contact_id', tenantScoped: true },
  { table: 'links', column: 'owner_contact_id', tenantScoped: true },
  { table: 'commissions', column: 'owner_contact_id', tenantScoped: true },
  { table: 'referrals', column: 'referrer_contact_id', tenantScoped: true },
  { table: 'referrals', column: 'referee_contact_id', tenantScoped: true },
  { table: 'point_transfers', column: 'from_contact_id', tenantScoped: true },
  { table: 'point_transfers', column: 'to_contact_id', tenantScoped: true },
];

/**
 * Tables where the survivor may already have a row for the same thing.
 *
 * A blind UPDATE here trips a unique constraint and takes the whole merge
 * down — which is how a merge feature ends up working for the easy cases and
 * failing for every customer who was actually active on both records.
 */
const RECONCILE: Array<{
  table: string;
  /** The other columns that make the row unique, besides tenant and contact. */
  by: string[];
  /** Kept when both sides have one: 'greatest' takes the higher value. */
  keep?: { column: string; rule: 'greatest' };
}> = [
  { table: 'badge_awards', by: ['badge_id'], keep: { column: 'level', rule: 'greatest' } },
  { table: 'rank_awards', by: ['rank_id'] },
  { table: 'streaks', by: ['key'], keep: { column: 'longest_length', rule: 'greatest' } },
  { table: 'subscriptions', by: ['list_id'] },
  { table: 'contact_topic_prefs', by: ['topic_key'] },
  { table: 'contact_field_values', by: ['field_key'] },
  { table: 'content_unlocks', by: ['content_ref'] },
];

/**
 * Merge `mergeId` into `keepId`.
 *
 * The survivor keeps its own id, so every link a retailer has already saved —
 * a WordPress user meta, a webhook payload, a printed loyalty card — still
 * resolves. The loser is deleted once everything has moved.
 */
export async function mergeContacts(
  tenantId: string,
  keepId: string,
  mergeId: string,
  runner?: Queryable,
): Promise<MergeResult> {
  if (keepId === mergeId) {
    throw ApiError.badRequest('A contact cannot be merged into itself');
  }

  const run = async (client: Queryable): Promise<MergeResult> => {
    // Locked in a fixed order. Two operators merging overlapping pairs at the
    // same moment would otherwise take the rows in opposite orders and
    // deadlock — the same reasoning as the transfer path.
    const [first, second] = [keepId, mergeId].sort();
    const { rows: locked } = await client.query<{
      id: string;
      email: string | null;
      erased_at: Date | null;
    }>(
      `SELECT id, email, erased_at FROM contacts
        WHERE tenant_id = $1 AND id = ANY($2::uuid[])
        ORDER BY id
        FOR UPDATE`,
      [tenantId, [first, second]],
    );

    if (locked.length !== 2) {
      throw ApiError.notFound('Both contacts must exist at this store');
    }
    // Merging an erased record would resurrect what it held onto a live one,
    // which is the erasure undone by another route.
    if (locked.some((row) => row.erased_at !== null)) {
      throw ApiError.unprocessable('An erased contact cannot be merged');
    }

    // Both contacts' balance rows, exclusively, before anything reads one.
    //
    // The contact locks above are what award and spend now wait on (see
    // `holdContact` in points.ts), so this is belt and braces for a row that
    // exists — but it also means `mergeBalances` reads a balance nothing can
    // change underneath it, rather than a snapshot it then adds to the
    // survivor while a spend drains the original.
    await client.query(
      `SELECT 1 FROM points_balances
        WHERE tenant_id = $1 AND contact_id = ANY($2::uuid[])
        ORDER BY contact_id, point_type
        FOR UPDATE`,
      [tenantId, [first, second]],
    );

    const moved: Record<string, number> = {};
    const bump = (key: string, n: number): void => {
      if (n > 0) moved[key] = (moved[key] ?? 0) + n;
    };

    // ── Balances, first and by themselves ────────────────────────────────────
    //
    // The one place a merge adds rather than moves. Two balance rows for one
    // person are two halves of one balance, and the ledger entries behind them
    // are all moving to the survivor, so the totals have to end up summed or
    // the balance stops matching its own history.
    const pointsMoved = await mergeBalances(client, tenantId, keepId, mergeId);

    for (const spec of RECONCILE) {
      bump(spec.table, await reconcile(client, tenantId, keepId, mergeId, spec));
    }

    for (const spec of REASSIGN) {
      // Table and column names come from the module constants above, never
      // from input.
      const { rowCount } = await client.query(
        `UPDATE ${spec.table} SET ${spec.column} = $2
          WHERE tenant_id = $1 AND ${spec.column} = $3`,
        [tenantId, keepId, mergeId],
      );
      bump(spec.table, rowCount ?? 0);
    }

    // Scoped by their parent rather than by tenant_id.
    const { rowCount: segmentRows } = await client.query(
      `UPDATE segment_members m SET contact_id = $2
         FROM segments s
        WHERE s.id = m.segment_id AND s.tenant_id = $1 AND m.contact_id = $3
          AND NOT EXISTS (
            SELECT 1 FROM segment_members other
             WHERE other.segment_id = m.segment_id AND other.contact_id = $2
          )`,
      [tenantId, keepId, mergeId],
    );
    bump('segment_members', segmentRows ?? 0);
    // Whatever could not move was already there under the survivor.
    await client.query(
      `DELETE FROM segment_members m USING segments s
        WHERE s.id = m.segment_id AND s.tenant_id = $1 AND m.contact_id = $2`,
      [tenantId, mergeId],
    );

    const { rowCount: broadcastRows } = await client.query(
      `UPDATE broadcast_recipients r SET contact_id = $2
         FROM broadcasts b
        WHERE b.id = r.broadcast_id AND b.tenant_id = $1 AND r.contact_id = $3
          AND NOT EXISTS (
            SELECT 1 FROM broadcast_recipients other
             WHERE other.broadcast_id = r.broadcast_id AND other.contact_id = $2
          )`,
      [tenantId, keepId, mergeId],
    );
    bump('broadcast_recipients', broadcastRows ?? 0);
    await client.query(
      `DELETE FROM broadcast_recipients r USING broadcasts b
        WHERE b.id = r.broadcast_id AND b.tenant_id = $1 AND r.contact_id = $2`,
      [tenantId, mergeId],
    );

    // ── The contact row itself ───────────────────────────────────────────────
    //
    // Fields fill gaps rather than overwrite: whoever the operator chose to
    // keep is the one whose details they meant to keep, so the loser only
    // supplies what the survivor does not have.
    //
    // Consent is the exception, and the direction is deliberate. It is a
    // permission a person gave, so the merged record having given it is enough
    // for the merged record to have given it — but a withdrawal is never
    // overridden by the other record's yes.
    // Read, delete, then write — not a self-join.
    //
    // `external_ref` is uniquely indexed per tenant, so copying it onto the
    // survivor while the loser still holds it violates the index and takes the
    // whole merge down. By this point every child row has moved, so deleting
    // the contact cascades to nothing.
    const lose = await queryOne<Record<string, unknown>>(
      client,
      'SELECT * FROM contacts WHERE tenant_id = $1 AND id = $2',
      [tenantId, mergeId],
    );
    await client.query('DELETE FROM contacts WHERE tenant_id = $1 AND id = $2', [
      tenantId,
      mergeId,
    ]);

    await client.query(
      `UPDATE contacts keep SET
         name              = COALESCE(keep.name, $3),
         phone             = COALESCE(keep.phone, $4),
         external_ref      = COALESCE(keep.external_ref, $5),
         locale            = COALESCE(keep.locale, $6),
         country           = COALESCE(keep.country, $7),
         wallet_address    = COALESCE(keep.wallet_address, $8),
         wallet_verified_at = COALESCE(keep.wallet_verified_at, $9::timestamptz),
         is_writer         = keep.is_writer OR $10,
         marketing_consent = keep.marketing_consent OR $11,
         consent_source    = COALESCE(keep.consent_source, $12),
         -- The earlier of the two: consent dates prove how long a permission
         -- has been held, and taking the later one quietly shortens it.
         consent_at        = LEAST(
                               COALESCE(keep.consent_at, $13::timestamptz),
                               COALESCE($13::timestamptz, keep.consent_at)
                             ),
         -- The loser's attributes fill gaps; the survivor's win a conflict.
         attributes        = $14::jsonb || keep.attributes,
         tags              = (
                               SELECT COALESCE(array_agg(DISTINCT tag), '{}')
                                 FROM unnest(keep.tags || $15::text[]) AS tag
                             ),
         first_seen_at     = LEAST(keep.first_seen_at, $16::timestamptz),
         last_seen_at      = GREATEST(keep.last_seen_at, $17::timestamptz),
         -- A pause on either record is a pause: the later of the two, so
         -- merging never shortens one somebody asked for.
         marketing_paused_until = GREATEST(keep.marketing_paused_until, $18::timestamptz),
         updated_at        = now()
       WHERE keep.tenant_id = $1 AND keep.id = $2`,
      [
        tenantId,
        keepId,
        lose?.name ?? null,
        lose?.phone ?? null,
        lose?.external_ref ?? null,
        lose?.locale ?? null,
        lose?.country ?? null,
        lose?.wallet_address ?? null,
        lose?.wallet_verified_at ?? null,
        lose?.is_writer ?? false,
        lose?.marketing_consent ?? false,
        lose?.consent_source ?? null,
        lose?.consent_at ?? null,
        JSON.stringify(lose?.attributes ?? {}),
        (lose?.tags as string[] | undefined) ?? [],
        lose?.first_seen_at ?? null,
        lose?.last_seen_at ?? null,
        lose?.marketing_paused_until ?? null,
      ],
    );

    return { kept: keepId, merged: mergeId, moved, points_moved: pointsMoved };
  };

  return runner ? run(runner) : withTransaction(run);
}

/**
 * Add the two balances together, per currency.
 *
 * Not a reassignment: the ledger entries behind both are moving to the
 * survivor, so their balances have to end up summed or the survivor's balance
 * no longer matches the history that explains it.
 */
async function mergeBalances(
  client: Queryable,
  tenantId: string,
  keepId: string,
  mergeId: string,
): Promise<Record<string, number>> {
  const { rows } = await client.query<{
    point_type: string;
    balance: number;
    pending: number;
    lifetime_earned: number;
    lifetime_spent: number;
    current_rank_id: string | null;
  }>(
    `SELECT point_type, balance, pending, lifetime_earned, lifetime_spent, current_rank_id
       FROM points_balances
      WHERE tenant_id = $1 AND contact_id = $2
      ORDER BY point_type`,
    [tenantId, mergeId],
  );

  const moved: Record<string, number> = {};

  for (const row of rows) {
    await client.query(
      `INSERT INTO points_balances (
         tenant_id, contact_id, point_type, balance, pending,
         lifetime_earned, lifetime_spent, current_rank_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (tenant_id, contact_id, point_type) DO UPDATE SET
         balance = points_balances.balance + EXCLUDED.balance,
         pending = points_balances.pending + EXCLUDED.pending,
         lifetime_earned = points_balances.lifetime_earned + EXCLUDED.lifetime_earned,
         lifetime_spent = points_balances.lifetime_spent + EXCLUDED.lifetime_spent,
         -- A rank the survivor already holds is not given up for the loser's.
         current_rank_id = COALESCE(points_balances.current_rank_id, EXCLUDED.current_rank_id),
         updated_at = now()`,
      [
        tenantId,
        keepId,
        row.point_type,
        row.balance,
        row.pending,
        row.lifetime_earned,
        row.lifetime_spent,
        row.current_rank_id,
      ],
    );
    if (row.balance !== 0) moved[row.point_type] = row.balance;
  }

  await client.query(
    'DELETE FROM points_balances WHERE tenant_id = $1 AND contact_id = $2',
    [tenantId, mergeId],
  );

  return moved;
}

/**
 * Move a row only where the survivor has no equivalent, then drop the rest.
 *
 * `keep` says what to do when both sides have one. A badge earned to level 3
 * on one record and level 1 on the other is a level 3 badge: taking the
 * survivor's blindly would demote somebody for having been merged.
 */
async function reconcile(
  client: Queryable,
  tenantId: string,
  keepId: string,
  mergeId: string,
  spec: { table: string; by: string[]; keep?: { column: string; rule: 'greatest' } },
): Promise<number> {
  // Every name here comes from the RECONCILE constant, never from input.
  const match = spec.by.map((column) => `other.${column} = t.${column}`).join(' AND ');

  if (spec.keep) {
    // Carry the higher value onto the survivor's row before the loser's goes.
    await client.query(
      `UPDATE ${spec.table} other
          SET ${spec.keep.column} = GREATEST(other.${spec.keep.column}, t.${spec.keep.column})
         FROM ${spec.table} t
        WHERE other.tenant_id = $1 AND other.contact_id = $2
          AND t.tenant_id = $1 AND t.contact_id = $3
          AND ${match}`,
      [tenantId, keepId, mergeId],
    );
  }

  const { rowCount } = await client.query(
    `UPDATE ${spec.table} t SET contact_id = $2
      WHERE t.tenant_id = $1 AND t.contact_id = $3
        AND NOT EXISTS (
          SELECT 1 FROM ${spec.table} other
           WHERE other.tenant_id = $1 AND other.contact_id = $2 AND ${match}
        )`,
    [tenantId, keepId, mergeId],
  );

  await client.query(`DELETE FROM ${spec.table} WHERE tenant_id = $1 AND contact_id = $2`, [
    tenantId,
    mergeId,
  ]);

  return rowCount ?? 0;
}

/**
 * Contacts that look like the same person.
 *
 * Deliberately narrow. A shared phone number or a shared name is a household,
 * not a duplicate, and offering those as candidates gets somebody merged who
 * should not have been — a merge is irreversible and it moves points, so a
 * confident short list beats a long speculative one.
 *
 * Two signals, both of them proofs rather than resemblances:
 *
 *   a shared wallet, which the holder signed a challenge to bind, so two
 *   records carrying it are two records for whoever holds that key;
 *
 *   a shared `member_id`, the platform's cross-retailer identity — two local
 *   records that resolve to one person.
 *
 * Not `external_ref` or `email`: both are uniquely indexed per tenant, so
 * neither can be duplicated in the first place.
 */
export async function findDuplicates(
  tenantId: string,
  limit = 50,
  runner: Queryable = db(),
): Promise<Array<{ reason: string; value: string; contact_ids: string[] }>> {
  const { rows } = await runner.query<{ reason: string; value: string; contact_ids: string[] }>(
    `SELECT 'wallet_address' AS reason, wallet_address AS value,
            array_agg(id::text ORDER BY created_at) AS contact_ids
       FROM contacts
      WHERE tenant_id = $1 AND wallet_address IS NOT NULL AND erased_at IS NULL
      GROUP BY wallet_address HAVING COUNT(*) > 1
      UNION ALL
     SELECT 'member_id', member_id::text, array_agg(id::text ORDER BY created_at)
       FROM contacts
      WHERE tenant_id = $1 AND member_id IS NOT NULL AND erased_at IS NULL
      GROUP BY member_id HAVING COUNT(*) > 1
      LIMIT ${Math.min(Math.max(limit, 1), 500)}`,
    [tenantId],
  );
  return rows;
}

/** What a merge would do, without doing it. */
export async function previewMerge(
  tenantId: string,
  keepId: string,
  mergeId: string,
  runner: Queryable = db(),
): Promise<{ keep: unknown; merge: unknown; combined_balances: Record<string, number> }> {
  const one = async (id: string) =>
    queryOne(
      runner,
      `SELECT id, email, name, phone, external_ref, wallet_address, marketing_consent,
              tags, first_seen_at, last_seen_at, erased_at
         FROM contacts WHERE tenant_id = $1 AND id = $2`,
      [tenantId, id],
    );

  const { rows } = await runner.query<{ point_type: string; total: string }>(
    `SELECT point_type, SUM(balance)::text AS total FROM points_balances
      WHERE tenant_id = $1 AND contact_id = ANY($2::uuid[])
      GROUP BY point_type ORDER BY point_type`,
    [tenantId, [keepId, mergeId]],
  );

  return {
    keep: await one(keepId),
    merge: await one(mergeId),
    combined_balances: Object.fromEntries(rows.map((row) => [row.point_type, Number(row.total)])),
  };
}

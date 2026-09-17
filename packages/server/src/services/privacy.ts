import { db, queryOne, withTransaction, type Queryable } from '../db/pool.js';
import { ApiError } from '../lib/errors.js';
import { hashPii } from '../lib/crypto.js';
import { getTenantById, type Tenant } from './tenants.js';
import { SPEND_SETTLEMENT_DAYS } from './token.js';

/**
 * Erasure, subject access, and not keeping what nobody needs.
 *
 * A retailer running this platform is a data controller. Two obligations it
 * could not meet before: erase a person on request, and stop holding
 * behavioural data long after it is any use to anyone.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Erasure
// ─────────────────────────────────────────────────────────────────────────────

export interface EraseOptions {
  /** 'request' (they asked), 'retention' (a policy), 'admin' (the retailer). */
  reason?: 'request' | 'retention' | 'admin';
  /** Free text for the log — a ticket reference, an operator name. */
  requestedBy?: string | null;
  /**
   * Zero any remaining points balance.
   *
   * On by default, and the default is the honest one. An anonymised row with a
   * spendable balance is a liability nobody can ever reconcile: the person it
   * belonged to is gone, so no one can claim it and no one can write it off.
   * Booking the forfeit as a ledger entry keeps the retailer's totals correct
   * and leaves the reason visible in the history.
   *
   * A retailer that has agreed to pay a balance out should do that *first*,
   * then erase.
   */
  forfeitPoints?: boolean;
}

export interface EraseResult {
  contact_id: string;
  points_forfeited: number;
  rows_deleted: Record<string, number>;
  /**
   * On-chain obligations that outlived the erasure.
   *
   * A bridge withdrawal whose L2 tokens are already burned still owes L1
   * tokens to the wallet that burned them. Erasure unlinks it from the person
   * but cannot cancel it, so it is reported here rather than disappearing:
   * the retailer has to know something is still payable, and the erasure log
   * has to show that it was not quietly destroyed.
   */
  obligations_kept: number;
}

/**
 * Tables whose rows are personal data and nothing else.
 *
 * Deleted outright on erasure. Everything absent from this list is either a
 * financial record the retailer must keep (points_ledger, orders, commissions,
 * store_credits, token_claims), an aggregate that carries no identifier
 * (heatmap_cells, product_stats), or a suppression the person is better off
 * keeping (email_suppressions — see below).
 */
const PERSONAL_TABLES = [
  'contact_field_values',
  'events',
  'sessions',
  'touchpoints',
  'carts',
  'notifications',
  'wallet_challenges',
  'share_events',
  'email_events',
  'automation_runs',
] as const;

/**
 * The same, for tables scoped by their parent rather than by tenant_id.
 *
 * `segment_members` and `broadcast_recipients` belong to a segment or a
 * broadcast, which belongs to the tenant. Deleting by (tenant_id, contact_id)
 * would simply error — which is how a column list that was never checked
 * against the schema announces itself.
 */
const PERSONAL_CHILD_TABLES = [
  {
    table: 'segment_members',
    sql: `DELETE FROM segment_members m
           USING segments s
           WHERE s.id = m.segment_id AND s.tenant_id = $1 AND m.contact_id = $2`,
  },
  {
    table: 'broadcast_recipients',
    sql: `DELETE FROM broadcast_recipients r
           USING broadcasts b
           WHERE b.id = r.broadcast_id AND b.tenant_id = $1 AND r.contact_id = $2`,
  },
] as const;

/**
 * Erase a person, keeping the retailer's books.
 *
 * The contact row survives, stripped. Deleting it would cascade through
 * points_ledger and take the retailer's own financial record with it, which is
 * not what anybody is asking for and in most jurisdictions is itself unlawful.
 * What actually identifies a person — name, address, phone, wallet, external
 * reference, attributes, tags — is removed, and the row is marked so nothing
 * writes an identifier back onto it.
 */
export async function eraseContact(
  tenantId: string,
  contactId: string,
  options: EraseOptions = {},
  runner?: Queryable,
): Promise<EraseResult> {
  const tenant = await getTenantById(tenantId);
  if (!tenant) throw ApiError.notFound('No such tenant');

  const run = async (client: Queryable): Promise<EraseResult> => {
    const contact = await queryOne<{
      id: string;
      email: string | null;
      email_normalised: string | null;
      erased_at: Date | null;
    }>(
      client,
      `SELECT id, email, email_normalised, erased_at FROM contacts
        WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
      [tenantId, contactId],
    );
    if (!contact) throw ApiError.notFound('No such contact');
    if (contact.erased_at) {
      throw ApiError.conflict('That contact has already been erased', {
        erased_at: contact.erased_at,
      });
    }

    const address = (contact.email_normalised ?? contact.email ?? '').toLowerCase();
    const emailHash = address === '' ? '' : hashPii(address, tenant.pii_salt);

    // Forfeit first: it writes a ledger entry, and the ledger entry needs the
    // contact row to still look normal when the balance check runs.
    let forfeited = 0;
    if (options.forfeitPoints !== false) {
      forfeited = await forfeitAllBalances(client, tenantId, contactId);
    }

    const rowsDeleted: Record<string, number> = {};
    for (const table of PERSONAL_TABLES) {
      // The table list is a module constant, never caller input — see the
      // segment filter compiler for the same rule stated at length.
      const { rowCount } = await client.query(
        `DELETE FROM ${table} WHERE tenant_id = $1 AND contact_id = $2`,
        [tenantId, contactId],
      );
      if ((rowCount ?? 0) > 0) rowsDeleted[table] = rowCount ?? 0;
    }

    for (const child of PERSONAL_CHILD_TABLES) {
      const { rowCount } = await client.query(child.sql, [tenantId, contactId]);
      if ((rowCount ?? 0) > 0) rowsDeleted[child.table] = rowCount ?? 0;
    }

    // Visitors are kept but unlinked: the rows carry hashed IPs and user agents
    // and drive nothing but counts, while deleting them would leave the
    // sessions that referenced them dangling.
    await client.query(
      'UPDATE visitors SET contact_id = NULL WHERE tenant_id = $1 AND contact_id = $2',
      [tenantId, contactId],
    );

    // Anything still queued never goes out. Blanking to_email and leaving the
    // row queued handed the transport an empty recipient, which SMTP answers
    // with "No recipients defined" -- retried, then written off as a failure
    // against the address '', and a suppression row keyed on nothing.
    await client.query(
      `UPDATE email_messages
          SET status = 'suppressed', error = 'Contact erased',
              claimed_at = NULL, claim_token = NULL
        WHERE tenant_id = $1 AND contact_id = $2
          AND status IN ('queued', 'sending')`,
      [tenantId, contactId],
    );

    // The rendered body of a sent email quotes the recipient by name. The
    // delivery record stays — a suppression list whose reasons have been
    // deleted is a list nobody can audit — but the body goes.
    //
    // tracked_links goes with it, and that one is not cosmetic: every
    // marketing body carries {{unsubscribe_url}} and {{preferences_url}}, the
    // click tracker rewrites both, and the token in each is a base64url JSON
    // blob with the address in plaintext. Leaving the array behind left the
    // erased person's email address sitting in a column keyed by their contact
    // id, readable without a key. tracking_token goes too: a pixel that still
    // resolves is a live handle on somebody who asked to be forgotten.
    await client.query(
      `UPDATE email_messages
          SET html = '', text = NULL, subject = '[erased]',
              to_email = '', unsubscribe_url = NULL,
              tracked_links = '[]'::jsonb, tracking_token = NULL
        WHERE tenant_id = $1 AND contact_id = $2`,
      [tenantId, contactId],
    );

    // Subscriptions become an unsubscribed tombstone rather than disappearing:
    // "unsubscribed" is itself a wish the person expressed, and dropping it
    // means a later import silently resubscribes them.
    await client.query(
      `UPDATE subscriptions SET status = 'unsubscribed', unsubscribed_at = COALESCE(unsubscribed_at, now())
        WHERE tenant_id = $1 AND contact_id = $2`,
      [tenantId, contactId],
    );

    await client.query(
      `UPDATE contacts SET
         email             = NULL,
         email_normalised  = NULL,
         name              = NULL,
         phone             = NULL,
         external_ref      = NULL,
         wallet_address    = NULL,
         wallet_verified_at = NULL,
         locale            = NULL,
         country           = NULL,
         attributes        = '{}'::jsonb,
         tags              = '{}',
         marketing_consent = false,
         consent_source    = NULL,
         is_writer         = false,
         erased_at         = now(),
         erased_email_hash = NULLIF($3, ''),
         updated_at        = now()
       WHERE tenant_id = $1 AND id = $2`,
      [tenantId, contactId, emailHash],
    );

    // The cross-tenant identity row.
    //
    // `members` links one person's contacts across every retailer on the
    // platform, keyed by a hash of their address and their wallet. Stripping
    // the contact row while leaving that intact meant an erased record was
    // still trivially re-linkable: hash the address again and the row is
    // right there, pointing at the contact that is supposed to have been
    // forgotten.
    //
    // Detached rather than deleted: the member may hold contacts at other
    // retailers who have not asked to be erased, and their linkage is theirs.
    // The identifiers only go when this was the last contact using them.
    const { rows: memberRows } = await client.query<{ member_id: string | null }>(
      'SELECT member_id FROM contacts WHERE tenant_id = $1 AND id = $2',
      [tenantId, contactId],
    );
    const memberId = memberRows[0]?.member_id ?? null;

    await client.query(
      'UPDATE contacts SET member_id = NULL WHERE tenant_id = $1 AND id = $2',
      [tenantId, contactId],
    );

    // The chain tables carry member_id and a wallet address of their own, and
    // clearing the contact's copy did nothing about either.
    //
    // member_id is the platform-wide identity link, which is exactly what
    // nulling it on the contact is meant to break. It survived one join away,
    // in a row keyed by the erased contact_id -- and because a member spans
    // retailers, that join lands on the same person's live, fully identified
    // record at another shop. Erased here, recovered from there, by name and
    // address.
    //
    // A wallet address is a public chain identifier and permanent: it cannot
    // be rotated, and anything ever done with it stays on a ledger the whole
    // world can read. It is the strongest identifier in the schema, and the
    // sweep test never looked for it because no fixture in it had one.
    //
    // The rows stay: a token claim is a financial record and a mint against a
    // supply budget, and deleting it makes the supply unreconcilable. What
    // goes is everything that says who it was.
    // An on-chain obligation outlives the person's account.
    //
    // Round four overwrote every address on these tables with the zero
    // address, unconditionally, and that destroyed money twice over. A
    // `pending` spend intent is settled by matching an on-chain transfer
    // against the addresses recorded here, so blanking them meant the customer
    // had sent their TBAY, the retailer had it, and the store credit could
    // never be issued. A `burn_verified` bridge withdrawal is worse: the L2
    // tokens are already burned and an operator is about to send L1 tokens to
    // `l1_recipient` -- which had just been repointed at the burn address.
    //
    // Round five answered that by refusing the erasure outright, and round
    // seven showed what that costs: the refusal named "releasing or rejecting"
    // a withdrawal as the remedy, both of which need the platform's bridge
    // operator credential, which a retailer does not have and which ships
    // empty -- so the route answers 503 and the erasure could never be carried
    // out at all. An erasure a controller cannot complete is itself the
    // defect, and this one was unbounded.
    //
    // Neither destroying the record nor refusing forever is right, because
    // both treat one row as a single thing. It is two: a link to a person, and
    // an obligation to a wallet. The link is what identifies, and it goes. The
    // wallet is what the money is owed to, it is a public chain identifier the
    // retailer can already read off their own payout address, and keeping it
    // is the only way an unsettled transfer can ever be settled. Article
    // 17(3)(e) exists for exactly this: a record kept for the establishment of
    // a legal claim.
    //
    // So: unlink everything, and scrub the wallet only where nothing is owed.
    const unsettled = await client.query<{ kind: string; id: string }>(
      // Live, not merely unfinished -- and only for the one case where erasing
      // *now* would break something actually in progress. A spend intent is
      // created the moment somebody taps "Pay with TBAY"; the expiry worker
      // moves it out of `pending` within five minutes of its own deadline, so
      // this refusal lasts minutes and clears itself. A verification in flight
      // is about to write a store credit against this contact.
      `SELECT 'token spend' AS kind, id::text FROM token_spend_intents
        WHERE tenant_id = $1 AND contact_id = $2
          AND (status = 'verifying' OR (status = 'pending' AND expires_at > now()))`,
      [tenantId, contactId],
    );
    if ((unsettled.rowCount ?? 0) > 0) {
      const what = unsettled.rows.map((row) => `${row.kind} ${row.id}`).join(', ');
      throw ApiError.badRequest(
        `This person has a checkout in progress (${what}). Erasing mid-payment would ` +
          'lose the store credit they are about to be owed. POST /v1/token/spend/{id}/cancel ' +
          'closes an open intent now, and one stuck mid-verification ten minutes after ' +
          'the request that abandoned it. Otherwise it closes itself: an intent lapses ' +
          'at its own expiry, and a stalled verification is released by the worker.',
      );
    }

    // What is left is history, and most of its addresses can go.
    //
    // The columns are NOT NULL, so they are overwritten rather than emptied.
    // `to_address` on a spend intent is deliberately untouched: that is the
    // retailer's own payout wallet, not the erased person's data, and blanking
    // it neither protects anybody nor leaves the retailer able to reconcile
    // their own takings.
    const ERASED_ADDRESS = '0x00000000000000000000000000000000000000ff';
    await client.query(
      `UPDATE token_claims SET wallet_address = $3, member_id = NULL
        WHERE tenant_id = $1 AND contact_id = $2`,
      [tenantId, contactId, ERASED_ADDRESS],
    );

    // A spend intent that could still be settled keeps the *means* to settle,
    // not the address.
    //
    // Keeping the raw wallet was wrong twice over. `members.wallet_address` is
    // a plaintext, platform-wide, unique column, and it is only cleared when
    // the erased contact was that person's last on the platform -- so a kept
    // address joined straight back to their live, fully identified record at
    // another retailer. Reproduced: one join, one row, name and email. And
    // "while it could still be settled" was in practice forever, because
    // erasure is one-shot: nothing revisits the row when the window closes and
    // a second erasure is refused.
    //
    // A keyed digest settles the question without answering it. A retailer
    // with an unexplained transfer at their payout wallet hashes the sending
    // address and compares; the digest is salted per tenant and 160 bits of
    // address are not enumerable, so it cannot be turned back into a wallet or
    // joined against one. Nothing needs revisiting later, because nothing
    // identifying is left to remove.
    const digest = (address: string): string => `erased:${hashPii(address.toLowerCase(), tenant.pii_salt)}`;
    const openIntents = await client.query<{ id: string; from_address: string }>(
      `SELECT id, from_address FROM token_spend_intents
        WHERE tenant_id = $1 AND contact_id = $2
          AND from_address NOT LIKE 'erased:%'
          AND status = 'expired' AND expires_at > now() - ($3 || ' days')::interval`,
      [tenantId, contactId, String(SPEND_SETTLEMENT_DAYS)],
    );
    for (const intent of openIntents.rows) {
      await client.query('UPDATE token_spend_intents SET from_address = $2 WHERE id = $1', [
        intent.id,
        digest(intent.from_address),
      ]);
    }

    // Everything else on the table is settled, so the address goes outright.
    // `contact_id` stays: it points at the stripped contact row, which carries
    // no identifier any more, and it is what lets the retailer see that a row
    // belongs to an erasure rather than to nobody at all. `member_id` is the
    // platform-wide identity and does go.
    await client.query(
      `UPDATE token_spend_intents
          SET member_id = NULL,
              from_address = CASE WHEN from_address LIKE 'erased:%' THEN from_address
                                  ELSE $3 END
        WHERE tenant_id = $1 AND contact_id = $2`,
      [tenantId, contactId, ERASED_ADDRESS],
    );

    // A released or rejected bridge withdrawal owes nothing, so its addresses
    // go. One still in flight has to keep them: those L2 tokens are burned and
    // the L1 release can only reach the wallet that burned them, so a digest
    // is no use -- somebody has to send to that address.
    await client.query(
      `UPDATE bridge_withdrawals
          SET from_address = $3, l1_recipient = $3
        WHERE tenant_id = $1 AND contact_id = $2
          AND status IN ('released', 'rejected')`,
      [tenantId, contactId, ERASED_ADDRESS],
    );
    // So the *link* goes instead, `contact_id` included. What is left is a
    // debt to a wallet with nothing in this system saying whose it was --
    // which is the only shape that both honours the obligation and answers
    // the erasure. The retailer finds it the way they find every other
    // outstanding release, by listing burn_verified withdrawals.
    const stillOwed = await client.query<{ status: string }>(
      `UPDATE bridge_withdrawals SET member_id = NULL, contact_id = NULL
        WHERE tenant_id = $1 AND contact_id = $2
        RETURNING status`,
      [tenantId, contactId],
    );
    const obligationsKept = stillOwed.rows.filter(
      (row) => row.status === 'pending' || row.status === 'burn_verified',
    ).length;

    // The ledger keeps its rows -- the points have to reconcile -- but a
    // redemption wrote the wallet into `ref_id`, the idempotency key and the
    // meta blob. The amounts are what reconciles; the address is not.
    await client.query(
      `UPDATE points_ledger
          SET ref_id = CASE WHEN ref_type = 'token_claim' THEN NULL ELSE ref_id END,
              idempotency_key = 'erased:' || id::text,
              meta = (meta - 'wallet_address' - 'to_address' - 'from_address')
        WHERE tenant_id = $1 AND contact_id = $2
          AND (meta ? 'wallet_address' OR meta ? 'to_address' OR meta ? 'from_address'
               OR idempotency_key LIKE 'redeem:%')`,
      [tenantId, contactId],
    );

    // A suppression's reason quotes the bounce, and a bounce quotes the
    // address: "550 5.1.1 <them@example.com>: User unknown". The address
    // column is kept on purpose -- a suppression nobody can match is not a
    // suppression -- but the detail was never part of that bargain.
    await client.query(
      `UPDATE email_suppressions SET detail = ''
        WHERE tenant_id = $1 AND email = lower($2) AND detail <> ''`,
      [tenantId, contact.email ?? contact.email_normalised ?? ''],
    );

    if (memberId) {
      await client.query(
        `UPDATE members SET email_hash = NULL, wallet_address = NULL, updated_at = now()
          WHERE id = $1
            AND NOT EXISTS (SELECT 1 FROM contacts WHERE member_id = $1)`,
        [memberId],
      );
    }

    // The audit log records who did what, and its `target` is the address the
    // operator typed — including on the erase request itself. Replaced with
    // the same salted hash the contact row keeps, so the record of the action
    // survives without the address surviving with it.
    await client.query(
      `UPDATE audit_log
          SET target = 'erased:' || $2
        WHERE tenant_id = $1 AND target IS NOT NULL AND $2 <> ''
          AND lower(target) = lower($3)`,
      [tenantId, emailHash, contact.email ?? contact.email_normalised ?? ''],
    );

    await client.query(
      `INSERT INTO erasure_log (
         tenant_id, contact_id, email_hash, reason, requested_by, points_forfeited, rows_deleted
       ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
      [
        tenantId,
        contactId,
        emailHash,
        options.reason ?? 'request',
        options.requestedBy ?? null,
        forfeited,
        // The obligations ride along in the same blob so the proof-of-erasure
        // endpoint shows them without a migration: a retailer reading the log
        // needs to see that something was kept, and why, not just what went.
        JSON.stringify({ ...rowsDeleted, obligations_kept: obligationsKept }),
      ],
    );

    return {
      contact_id: contactId,
      points_forfeited: forfeited,
      rows_deleted: rowsDeleted,
      obligations_kept: obligationsKept,
    };
  };

  return runner ? run(runner) : withTransaction(run);
}

/**
 * Spend every currency down to zero, recording why.
 *
 * Through the ledger rather than by writing the balance directly, so the
 * history explains the change and the balance stays derivable from it.
 */
async function forfeitAllBalances(
  client: Queryable,
  tenantId: string,
  contactId: string,
): Promise<number> {
  const { rows } = await client.query<{ point_type: string; balance: number; pending: number }>(
    `SELECT point_type, balance, pending FROM points_balances
      WHERE tenant_id = $1 AND contact_id = $2 AND (balance > 0 OR pending > 0)
      ORDER BY point_type
      FOR UPDATE`,
    [tenantId, contactId],
  );

  const { spend } = await import('./points.js');
  let total = 0;

  for (const row of rows) {
    // Pending awards are cancelled outright: they never reached the spendable
    // balance, so there is nothing to spend, and leaving them would have the
    // release worker credit an erased contact an hour later.
    if (row.pending > 0) {
      await client.query(
        `UPDATE points_ledger SET status = 'reversed'
          WHERE tenant_id = $1 AND contact_id = $2 AND point_type = $3 AND status = 'pending'`,
        [tenantId, contactId, row.point_type],
      );
      await client.query(
        `UPDATE points_balances SET pending = 0, updated_at = now()
          WHERE tenant_id = $1 AND contact_id = $2 AND point_type = $3`,
        [tenantId, contactId, row.point_type],
      );
    }

    if (row.balance > 0) {
      await spend(
        tenantId,
        {
          contactId,
          points: row.balance,
          reason: 'Balance forfeited on erasure',
          refType: 'erasure',
          idempotencyKey: `erase:${contactId}:${row.point_type}`,
          pointType: row.point_type,
        },
        client,
      );
      total += row.balance;
    }
  }

  return total;
}

/** Has this address been erased at this retailer? */
export async function isErased(
  tenant: Tenant,
  email: string,
  runner: Queryable = db(),
): Promise<boolean> {
  const address = email.trim().toLowerCase();
  if (address === '') return false;

  const row = await queryOne<{ id: string }>(
    runner,
    `SELECT id FROM contacts
      WHERE tenant_id = $1 AND erased_email_hash = $2 LIMIT 1`,
    [tenant.id, hashPii(address, tenant.pii_salt)],
  );
  return row !== null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Subject access
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Everything the platform holds about one person.
 *
 * Answers a subject access request without an operator writing SQL, which is
 * how these get answered late or wrongly. The shape is deliberately the raw
 * rows rather than a summary: a person asking what is held is entitled to what
 * is held, not to our description of it.
 */
export async function exportContact(
  tenantId: string,
  contactId: string,
  runner: Queryable = db(),
): Promise<Record<string, unknown>> {
  const contact = await queryOne<Record<string, unknown>>(
    runner,
    'SELECT * FROM contacts WHERE tenant_id = $1 AND id = $2',
    [tenantId, contactId],
  );
  if (!contact) throw ApiError.notFound('No such contact');

  // Bounded per table. An export is a document somebody reads, and a contact
  // with 40,000 events produces a file nobody opens — the count tells them
  // what is held, the rows show them what it looks like.
  const LIMIT = 1_000;
  const sections: Record<string, string> = {
    orders: 'SELECT * FROM orders WHERE tenant_id = $1 AND contact_id = $2 ORDER BY placed_at DESC NULLS LAST',
    points_ledger:
      'SELECT * FROM points_ledger WHERE tenant_id = $1 AND contact_id = $2 ORDER BY created_at DESC',
    points_balances: 'SELECT * FROM points_balances WHERE tenant_id = $1 AND contact_id = $2',
    subscriptions: 'SELECT * FROM subscriptions WHERE tenant_id = $1 AND contact_id = $2',
    email_messages:
      'SELECT id, template_key, subject, status, sent_at, opened_at, first_clicked_at, bounce_type FROM email_messages WHERE tenant_id = $1 AND contact_id = $2 ORDER BY created_at DESC',
    sessions:
      'SELECT id, started_at, entry_path, referrer_host, device_class, source, medium, campaign FROM sessions WHERE tenant_id = $1 AND contact_id = $2 ORDER BY started_at DESC',
    events:
      'SELECT id, type, path, url, product_ref, value_cents, occurred_at FROM events WHERE tenant_id = $1 AND contact_id = $2 ORDER BY occurred_at DESC',
    badge_awards: 'SELECT * FROM badge_awards WHERE tenant_id = $1 AND contact_id = $2',
    rank_awards: 'SELECT * FROM rank_awards WHERE tenant_id = $1 AND contact_id = $2',
    store_credits: 'SELECT * FROM store_credits WHERE tenant_id = $1 AND contact_id = $2',
    token_claims: 'SELECT * FROM token_claims WHERE tenant_id = $1 AND contact_id = $2',
    notifications: 'SELECT * FROM notifications WHERE tenant_id = $1 AND contact_id = $2',
  };

  const { getFieldValues } = await import('./contact-fields.js');
  const data: Record<string, unknown> = {
    contact,
    // The retailer's own fields are as personal as the platform's. Leaving
    // them out of a subject access response would answer the question wrongly.
    custom_fields: await getFieldValues(tenantId, contactId, runner),
  };
  const counts: Record<string, number> = {};

  for (const [key, sql] of Object.entries(sections)) {
    const { rows } = await runner.query(`${sql} LIMIT ${LIMIT + 1}`, [tenantId, contactId]);
    counts[key] = rows.length;
    data[key] = rows.slice(0, LIMIT);
    if (rows.length > LIMIT) {
      counts[key] = -1; // "more than the limit" — a precise count is its own scan.
    }
  }

  return {
    exported_at: new Date().toISOString(),
    truncated_at: LIMIT,
    counts,
    ...data,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Retention
// ─────────────────────────────────────────────────────────────────────────────

export interface RetentionPolicy {
  tenant_id: string;
  event_days: number | null;
  session_days: number | null;
  email_body_days: number | null;
  notification_days: number | null;
}

export async function getRetentionPolicy(
  tenantId: string,
  runner: Queryable = db(),
): Promise<RetentionPolicy> {
  const row = await queryOne<RetentionPolicy>(
    runner,
    'SELECT * FROM retention_policies WHERE tenant_id = $1',
    [tenantId],
  );
  return (
    row ?? {
      tenant_id: tenantId,
      event_days: null,
      session_days: null,
      email_body_days: null,
      notification_days: null,
    }
  );
}

export async function setRetentionPolicy(
  tenantId: string,
  policy: Partial<Omit<RetentionPolicy, 'tenant_id'>>,
  runner: Queryable = db(),
): Promise<RetentionPolicy> {
  const days = (value: number | null | undefined): number | null => {
    if (value === null || value === undefined) return null;
    if (!Number.isInteger(value) || value < 1 || value > 3650) {
      throw ApiError.badRequest('A retention window is 1 to 3650 days, or null to keep forever');
    }
    return value;
  };

  const row = await queryOne<RetentionPolicy>(
    runner,
    `INSERT INTO retention_policies (
       tenant_id, event_days, session_days, email_body_days, notification_days
     ) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (tenant_id) DO UPDATE SET
       -- Not COALESCE: null is how a retailer turns a window off, so it has to
       -- be written rather than treated as "unchanged".
       event_days = EXCLUDED.event_days,
       session_days = EXCLUDED.session_days,
       email_body_days = EXCLUDED.email_body_days,
       notification_days = EXCLUDED.notification_days,
       updated_at = now()
     RETURNING *`,
    [
      tenantId,
      days(policy.event_days),
      days(policy.session_days),
      days(policy.email_body_days),
      days(policy.notification_days),
    ],
  );
  return row!;
}

/**
 * Delete what every tenant's policy says is past its window.
 *
 * Batched and capped per pass. A tenant that turns on a 30-day event policy
 * after two years of collection has tens of millions of rows to shed, and a
 * single unbounded DELETE would hold locks for minutes and bloat the WAL. It
 * takes a bite each pass and catches up over a day, which is the right trade
 * for a job nothing waits on.
 */
export async function runRetentionSweep(
  runner: Queryable = db(),
  batchSize = 5_000,
): Promise<Record<string, number>> {
  const { rows: policies } = await runner.query<RetentionPolicy>(
    `SELECT * FROM retention_policies
      WHERE event_days IS NOT NULL OR session_days IS NOT NULL
         OR email_body_days IS NOT NULL OR notification_days IS NOT NULL`,
  );

  const totals: Record<string, number> = {};
  const bump = (key: string, n: number): void => {
    if (n > 0) totals[key] = (totals[key] ?? 0) + n;
  };

  for (const policy of policies) {
    if (policy.event_days !== null) {
      bump(
        'events',
        await deleteBatch(
          runner,
          `DELETE FROM events WHERE ctid IN (
             SELECT ctid FROM events
              WHERE tenant_id = $1 AND occurred_at < now() - ($2 || ' days')::interval
              LIMIT ${batchSize}
           )`,
          [policy.tenant_id, String(policy.event_days)],
        ),
      );
    }

    if (policy.session_days !== null) {
      // `events.session_id` cascades, so deleting a session takes its events
      // with it — whatever the event policy says. A tenant keeping events
      // forever and sessions for thirty days was losing every event older than
      // thirty days, in an unbounded cascade behind a bounded delete.
      //
      // So a session is only removed once its events are out of retention too.
      // A tenant who keeps events forever keeps the sessions that hold them,
      // which is the honest reading of "keep events forever".
      //
      // "The sessions that hold them", though -- not all of them. Gating the
      // whole leg on an event policy existing meant a retailer who set
      // sessions to thirty days and left events alone deleted nothing at all,
      // including sessions with no events to protect. Ask the question that
      // was meant: does this session still hold an event we are keeping?
      bump(
        'sessions',
        await deleteBatch(
          runner,
          `DELETE FROM sessions WHERE ctid IN (
             SELECT s.ctid FROM sessions s
              WHERE s.tenant_id = $1 AND s.started_at < now() - ($2 || ' days')::interval
                AND NOT EXISTS (
                  SELECT 1 FROM events e
                   WHERE e.session_id = s.id
                     -- No event policy means every event is one we are
                     -- keeping, so only an event-free session may go.
                     AND ($3::text IS NULL
                          OR e.occurred_at >= now() - ($3 || ' days')::interval)
                )
              LIMIT ${batchSize}
           )`,
          [
            policy.tenant_id,
            String(policy.session_days),
            policy.event_days === null ? null : String(policy.event_days),
          ],
        ),
      );
    }

    if (policy.email_body_days !== null) {
      // The body only. Delivery metadata is what a suppression list is
      // justified by, and deleting it makes every suppression unexplainable.
      //
      // Bounded like every other leg. Unbounded, the first pass after a
      // retailer enabled this rewrote every old message in one transaction —
      // multi-kilobyte rows, all of it through the WAL at once — on a table
      // that is usually the largest one they have.
      const { rowCount } = await runner.query(
        `UPDATE email_messages SET html = '', text = NULL
          WHERE ctid IN (
            SELECT ctid FROM email_messages
             WHERE tenant_id = $1
               AND created_at < now() - ($2 || ' days')::interval
               AND (html <> '' OR text IS NOT NULL)
             LIMIT ${batchSize}
          )`,
        [policy.tenant_id, String(policy.email_body_days)],
      );
      bump('email_bodies', rowCount ?? 0);
    }

    if (policy.notification_days !== null) {
      bump(
        'notifications',
        await deleteBatch(
          runner,
          `DELETE FROM notifications WHERE ctid IN (
             SELECT ctid FROM notifications
              WHERE tenant_id = $1 AND created_at < now() - ($2 || ' days')::interval
              LIMIT ${batchSize}
           )`,
          [policy.tenant_id, String(policy.notification_days)],
        ),
      );
    }
  }

  return totals;
}

async function deleteBatch(
  runner: Queryable,
  sql: string,
  params: unknown[],
): Promise<number> {
  const { rowCount } = await runner.query(sql, params);
  return rowCount ?? 0;
}

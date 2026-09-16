import { db, queryOne, withTransaction, type Queryable } from '../db/pool.js';
import { ApiError } from '../lib/errors.js';
import { config } from '../config.js';
import { normaliseEmail, signPayload, verifyPayload } from '../lib/crypto.js';

/**
 * Something to click other than "never again".
 *
 * Unsubscribe is binary, and most people who click it do not want silence.
 * They want less, or they want the one thing they signed up for and not the
 * other three. Offered only the binary choice they take it, and the list loses
 * somebody who would have stayed on a monthly digest.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Topics
// ─────────────────────────────────────────────────────────────────────────────

export interface EmailTopic {
  id: string;
  tenant_id: string;
  key: string;
  name: string;
  description: string;
  selectable: boolean;
  default_on: boolean;
  display_order: number;
}

export async function listTopics(
  tenantId: string,
  runner: Queryable = db(),
): Promise<EmailTopic[]> {
  const { rows } = await runner.query<EmailTopic>(
    'SELECT * FROM email_topics WHERE tenant_id = $1 ORDER BY display_order, name',
    [tenantId],
  );
  return rows;
}

export async function upsertTopic(
  tenantId: string,
  input: {
    key: string;
    name?: string;
    description?: string;
    selectable?: boolean;
    defaultOn?: boolean;
    displayOrder?: number;
  },
  runner: Queryable = db(),
): Promise<EmailTopic> {
  const key = String(input.key ?? '').trim().toLowerCase();
  if (!/^[a-z0-9_]{2,40}$/.test(key)) {
    throw ApiError.badRequest('A topic key is 2-40 chars of a-z, 0-9 or underscore');
  }

  const row = await queryOne<EmailTopic>(
    runner,
    `INSERT INTO email_topics (
       tenant_id, key, name, description, selectable, default_on, display_order
     ) VALUES (
       $1, $2, $3, COALESCE($4, ''), COALESCE($5, true), COALESCE($6, true), COALESCE($7, 0)
     )
     ON CONFLICT (tenant_id, key) DO UPDATE SET
       name = COALESCE(EXCLUDED.name, email_topics.name),
       description = COALESCE($4, email_topics.description),
       selectable = COALESCE($5, email_topics.selectable),
       default_on = COALESCE($6, email_topics.default_on),
       display_order = COALESCE($7, email_topics.display_order),
       updated_at = now()
     RETURNING *`,
    [
      tenantId,
      key,
      input.name ?? key,
      input.description ?? null,
      input.selectable ?? null,
      input.defaultOn ?? null,
      input.displayOrder ?? null,
    ],
  );
  return row!;
}

export async function deleteTopic(
  tenantId: string,
  key: string,
  runner: Queryable = db(),
): Promise<boolean> {
  // The preferences go with it. A stored choice about a topic that no longer
  // exists is not a choice about anything, and leaving them means a topic key
  // reused later silently inherits opinions nobody expressed about it.
  await runner.query(
    'DELETE FROM contact_topic_prefs WHERE tenant_id = $1 AND topic_key = $2',
    [tenantId, key],
  );
  const { rowCount } = await runner.query(
    'DELETE FROM email_topics WHERE tenant_id = $1 AND key = $2',
    [tenantId, key],
  );
  return (rowCount ?? 0) > 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// What one person currently wants
// ─────────────────────────────────────────────────────────────────────────────

export interface Preferences {
  contact_id: string;
  email: string;
  marketing_consent: boolean;
  /** Null when not paused; otherwise when the pause lifts on its own. */
  paused_until: Date | null;
  topics: Array<EmailTopic & { subscribed: boolean; chosen: boolean }>;
}

export async function getPreferences(
  tenantId: string,
  contactId: string,
  runner: Queryable = db(),
): Promise<Preferences> {
  const contact = await queryOne<{
    id: string;
    email: string | null;
    marketing_consent: boolean;
    marketing_paused_until: Date | null;
  }>(
    runner,
    `SELECT id, email, marketing_consent, marketing_paused_until
       FROM contacts WHERE tenant_id = $1 AND id = $2`,
    [tenantId, contactId],
  );
  if (!contact) throw ApiError.notFound('No such contact');

  const topics = await listTopics(tenantId, runner);
  const { rows: chosen } = await runner.query<{ topic_key: string; subscribed: boolean }>(
    'SELECT topic_key, subscribed FROM contact_topic_prefs WHERE tenant_id = $1 AND contact_id = $2',
    [tenantId, contactId],
  );
  const byKey = new Map(chosen.map((row) => [row.topic_key, row.subscribed]));

  return {
    contact_id: contact.id,
    email: contact.email ?? '',
    marketing_consent: contact.marketing_consent,
    // A pause that has already lifted is not a pause.
    paused_until:
      contact.marketing_paused_until && contact.marketing_paused_until > new Date()
        ? contact.marketing_paused_until
        : null,
    topics: topics.map((topic) => ({
      ...topic,
      subscribed: byKey.get(topic.key) ?? topic.default_on,
      // Whether they have actually said, as opposed to falling to the default.
      chosen: byKey.has(topic.key),
    })),
  };
}

export interface PreferenceUpdate {
  /** Explicit per-topic choices. Topics not named are left as they are. */
  topics?: Record<string, boolean>;
  /** Days to pause for; 0 or null resumes. */
  pauseDays?: number | null;
  /** Leave entirely. Recorded, then handled by the caller's unsubscribe path. */
  unsubscribe?: boolean;
}

export async function setPreferences(
  tenantId: string,
  contactId: string,
  update: PreferenceUpdate,
  runner?: Queryable,
): Promise<Preferences> {
  const run = async (client: Queryable): Promise<Preferences> => {
    if (update.topics) {
      const known = new Set((await listTopics(tenantId, client)).map((topic) => topic.key));
      for (const [key, subscribed] of Object.entries(update.topics)) {
        // A key the retailer does not have is dropped rather than stored. The
        // form is public, so an unknown key means either a stale page or
        // somebody typing into the request — neither is a preference.
        if (!known.has(key)) continue;
        await client.query(
          `INSERT INTO contact_topic_prefs (tenant_id, contact_id, topic_key, subscribed)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (tenant_id, contact_id, topic_key)
           DO UPDATE SET subscribed = EXCLUDED.subscribed, updated_at = now()`,
          [tenantId, contactId, key, subscribed],
        );
      }
      await recordChange(client, tenantId, contactId, 'topics', update.topics);
    }

    if (update.pauseDays !== undefined) {
      const days = update.pauseDays;
      if (days === null || days <= 0) {
        await client.query(
          `UPDATE contacts SET marketing_paused_until = NULL, updated_at = now()
            WHERE tenant_id = $1 AND id = $2`,
          [tenantId, contactId],
        );
        await recordChange(client, tenantId, contactId, 'resumed', {});
      } else {
        const capped = Math.min(Math.trunc(days), 365);
        await client.query(
          `UPDATE contacts
              SET marketing_paused_until = now() + ($3 || ' days')::interval, updated_at = now()
            WHERE tenant_id = $1 AND id = $2`,
          [tenantId, contactId, String(capped)],
        );
        await recordChange(client, tenantId, contactId, 'paused', { days: capped });
      }
    }

    return getPreferences(tenantId, contactId, client);
  };

  return runner ? run(runner) : withTransaction(run);
}

async function recordChange(
  client: Queryable,
  tenantId: string,
  contactId: string,
  action: string,
  detail: unknown,
): Promise<void> {
  await client.query(
    `INSERT INTO preference_changes (tenant_id, contact_id, action, detail)
     VALUES ($1, $2, $3, $4::jsonb)`,
    [tenantId, contactId, action, JSON.stringify(detail ?? {})],
  );
}

/** Note that somebody left from the preference page, for the same report. */
export async function recordUnsubscribe(
  tenantId: string,
  contactId: string,
  runner: Queryable = db(),
): Promise<void> {
  await recordChange(runner, tenantId, contactId, 'unsubscribed', {});
}

// ─────────────────────────────────────────────────────────────────────────────
// Whether to send
// ─────────────────────────────────────────────────────────────────────────────

/**
 * May this contact be sent this topic right now?
 *
 * Asked at send time rather than at audience-build time, because the audience
 * for a broadcast is built once and sent over minutes or hours: somebody who
 * pauses in between should not receive the rest of it.
 *
 * A null topic means "no topic", which everyone who has consented receives —
 * that is every message a retailer sends today, so nothing changes for a store
 * that never defines a topic.
 */
export async function mayReceive(
  tenantId: string,
  contactId: string,
  topicKey: string | null,
  runner: Queryable = db(),
  /**
   * Transactional mail ignores all of this.
   *
   * A receipt, a confirmation, a "here is your token claim" is not marketing:
   * it is the answer to something the customer did, and withholding it because
   * they paused the newsletter would be withholding a receipt for want of a
   * marketing opt-in.
   */
  transactional = false,
): Promise<{ allowed: boolean; reason: string | null }> {
  if (transactional) return { allowed: true, reason: null };

  const row = await queryOne<{
    marketing_consent: boolean;
    paused: boolean;
    subscribed: boolean | null;
    default_on: boolean | null;
    topic_exists: boolean;
  }>(
    runner,
    `SELECT c.marketing_consent,
            (c.marketing_paused_until IS NOT NULL AND c.marketing_paused_until > now()) AS paused,
            p.subscribed,
            t.default_on,
            (t.key IS NOT NULL) AS topic_exists
       FROM contacts c
       LEFT JOIN email_topics t
              ON t.tenant_id = c.tenant_id AND t.key = $3
       LEFT JOIN contact_topic_prefs p
              ON p.tenant_id = c.tenant_id AND p.contact_id = c.id AND p.topic_key = $3
      WHERE c.tenant_id = $1 AND c.id = $2`,
    [tenantId, contactId, topicKey],
  );

  if (!row) return { allowed: false, reason: 'no_contact' };
  if (!row.marketing_consent) return { allowed: false, reason: 'no_consent' };
  if (row.paused) return { allowed: false, reason: 'paused' };

  // A topic the retailer has not defined filters nothing. Silently dropping
  // mail because a template names a topic that was deleted would be a campaign
  // that sends to nobody with no explanation.
  if (topicKey && row.topic_exists) {
    const wants = row.subscribed ?? row.default_on ?? true;
    if (!wants) return { allowed: false, reason: 'topic_off' };
  }

  return { allowed: true, reason: null };
}

/** Lift pauses that have run their course, so the flag means what it says. */
export async function expirePauses(runner: Queryable = db()): Promise<number> {
  const { rowCount } = await runner.query(
    `UPDATE contacts SET marketing_paused_until = NULL, updated_at = now()
      WHERE marketing_paused_until IS NOT NULL AND marketing_paused_until <= now()`,
  );
  return rowCount ?? 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// The signed link
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A link only the recipient can use.
 *
 * Signed over exactly the (tenant, address) pair, the same construction the
 * unsubscribe link uses and for the same reason: the tenant id is printed in
 * every marketing email, so anything that took it from a query string could be
 * walked over a list of addresses.
 *
 * It does not expire. A preference link in a two-year-old email must still
 * work — somebody digging out an old message to turn something off is exactly
 * who this page is for.
 */
export function preferencesUrl(tenantId: string, email: string): string {
  const token = signPayload({ t: tenantId, e: normaliseEmail(email), k: 'prefs' });
  return `${config().publicUrl}/n/prefs/${encodeURIComponent(token)}`;
}

export function verifyPreferencesToken(
  token: string,
): { tenantId: string; email: string } | null {
  const payload = verifyPayload<{ t?: string; e?: string; k?: string }>(token);
  // The discriminator stops an unsubscribe token — which is signed over the
  // same pair — being replayed here, and vice versa.
  if (!payload || payload.k !== 'prefs' || !payload.t || !payload.e) return null;
  return { tenantId: payload.t, email: payload.e };
}

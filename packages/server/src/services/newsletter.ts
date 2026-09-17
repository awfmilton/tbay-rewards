import { db, queryOne, withTransaction, type Queryable } from '../db/pool.js';
import { config } from '../config.js';
import { hashPii, hashToken, randomToken, signPayload, verifyPayload, normaliseEmail } from '../lib/crypto.js';
import { ApiError } from '../lib/errors.js';
import { isValidEmail, upsertContact, type Contact } from './contacts.js';
import { getTemplate, queueEmail, renderTemplate, senderFor } from './email.js';
import { trigger } from './rewards.js';
import { fire } from './automations.js';
import { getBalance } from './points.js';
import type { Tenant } from './tenants.js';

export interface List {
  id: string;
  tenant_id: string;
  slug: string;
  name: string;
  double_optin: boolean;
}

export interface Subscription {
  id: string;
  tenant_id: string;
  list_id: string;
  contact_id: string;
  status: 'pending' | 'subscribed' | 'unsubscribed' | 'bounced' | 'complained';
  source: string | null;
  confirmed_at: Date | null;
}

export const DEFAULT_LIST_SLUG = 'newsletter';

export async function ensureList(
  tenantId: string,
  slug = DEFAULT_LIST_SLUG,
  name = 'Newsletter',
  runner: Queryable = db(),
): Promise<List> {
  const list = await queryOne<List>(
    runner,
    `INSERT INTO lists (tenant_id, slug, name) VALUES ($1, $2, $3)
     ON CONFLICT (tenant_id, slug) DO UPDATE SET name = lists.name
     RETURNING *`,
    [tenantId, slug, name],
  );
  return list!;
}

export async function getList(
  tenantId: string,
  slug: string,
  runner: Queryable = db(),
): Promise<List | null> {
  return queryOne<List>(runner, 'SELECT * FROM lists WHERE tenant_id = $1 AND slug = $2', [
    tenantId,
    slug,
  ]);
}

export interface SubscribeInput {
  email: string;
  name?: string | null;
  listSlug?: string;
  source?: string | null;
  ip?: string | null;
  visitorAnonId?: string | null;
  attributes?: Record<string, unknown>;
}

export interface SubscribeResult {
  status: 'pending' | 'subscribed' | 'already_subscribed';
  contact: Contact;
  subscription: Subscription;
  /** Only returned in non-production so tests and local dev can follow the link. */
  confirmToken?: string;
}

/**
 * Subscribe an address, with double opt-in by default.
 *
 * The confirmation token is stored hashed and only the plaintext goes in the
 * email, so a database leak cannot be used to confirm subscriptions on someone's
 * behalf. Re-subscribing an already-confirmed address is a no-op rather than an
 * error, so a double-submitted form is harmless.
 */
export async function subscribe(
  tenant: Tenant,
  input: SubscribeInput,
  runner?: Queryable,
  /**
   * Called with the public site key, which is in every page's source.
   *
   * A subscribe form may introduce somebody and fill in what the store does
   * not know; it may not rewrite the name or the attributes of a customer the
   * store already has. See `UpsertOptions.fillOnly`.
   */
  options: { fillOnly?: boolean } = {},
): Promise<SubscribeResult> {
  const email = String(input.email ?? '').trim();
  if (!isValidEmail(email)) throw ApiError.badRequest('A valid email address is required');

  const run = async (client: Queryable): Promise<SubscribeResult> => {
    const list = await ensureList(tenant.id, input.listSlug ?? DEFAULT_LIST_SLUG, 'Newsletter', client);

    // Has this person already said no?
    //
    // On a single-opt-in list, subscribing granted consent outright -- so a
    // form in the page source, callable by anyone with the address, undid an
    // unsubscribe that the person had made deliberately. The form may still
    // invite them back; it may not answer for them. Confirming by email is
    // exactly the right instrument: a returning subscriber clicks the link, a
    // stranger typing somebody else's address accomplishes one email and no
    // consent at all.
    // Scoped to this list, and to consent that is currently withdrawn.
    //
    // Asking "has this address ever unsubscribed from anything here" was far
    // too wide: somebody who left one list and later used the on-site form for
    // a different list they were still subscribed to came back as a prior
    // opt-out. That is not just a needless confirmation email -- `mustConfirm`
    // is passed straight to upsertContact as `marketingConsent`, so `false`
    // was written over a live `true` and the customer went unmailable account
    // wide, with their subscription row still reading `subscribed`.
    const priorOptOut = await client.query(
      `SELECT 1
         FROM subscriptions s
         JOIN contacts c ON c.id = s.contact_id
        WHERE c.tenant_id = $1 AND c.email_normalised = lower($2)
          AND s.list_id = $3
          AND s.status IN ('unsubscribed', 'complained')
        UNION ALL
       SELECT 1
         FROM contacts c
        WHERE c.tenant_id = $1 AND c.email_normalised = lower($2)
          AND c.marketing_consent = false AND c.consent_at IS NOT NULL
        LIMIT 1`,
      [tenant.id, email, list.id],
    );
    const mustConfirm = list.double_optin || (priorOptOut.rowCount ?? 0) > 0;

    const contact = await upsertContact(
      tenant.id,
      {
        email,
        name: input.name ?? null,
        attributes: input.attributes ?? {},
        // `undefined`, never `false`: this call may grant consent, and it may
        // leave it exactly as it is. It may not take it away. Withdrawing is
        // something only the person does, through unsubscribe or the
        // preference centre -- a signup form that revokes consent is a bug
        // wearing the clothes of a feature.
        marketingConsent: mustConfirm ? undefined : true,
        consentSource: mustConfirm ? undefined : (input.source ?? 'newsletter_form'),
      },
      client,
      { fillOnly: options.fillOnly ?? false },
    );

    if (input.visitorAnonId) {
      const visitor = await queryOne<{ id: string }>(
        client,
        'SELECT id FROM visitors WHERE tenant_id = $1 AND anon_id = $2',
        [tenant.id, input.visitorAnonId],
      );
      if (visitor) {
        const { linkVisitorToContact } = await import('./visitors.js');
        await linkVisitorToContact(client, tenant.id, visitor.id, contact.id);
      }
    }

    const existing = await queryOne<Subscription>(
      client,
      'SELECT * FROM subscriptions WHERE list_id = $1 AND contact_id = $2',
      [list.id, contact.id],
    );
    if (existing?.status === 'subscribed') {
      return { status: 'already_subscribed', contact, subscription: existing };
    }

    const confirmToken = randomToken(24);
    const unsubToken = randomToken(24);
    const needsConfirmation = mustConfirm;

    const subscription = await queryOne<Subscription>(
      client,
      `INSERT INTO subscriptions (
         tenant_id, list_id, contact_id, status, confirm_token_hash, unsub_token_hash,
         source, ip_hash, confirmed_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (list_id, contact_id) DO UPDATE SET
         status            = EXCLUDED.status,
         confirm_token_hash= EXCLUDED.confirm_token_hash,
         unsub_token_hash  = COALESCE(subscriptions.unsub_token_hash, EXCLUDED.unsub_token_hash),
         source            = COALESCE(EXCLUDED.source, subscriptions.source),
         requested_at      = now(),
         unsubscribed_at   = NULL,
         confirmed_at      = EXCLUDED.confirmed_at
       RETURNING *`,
      [
        tenant.id,
        list.id,
        contact.id,
        needsConfirmation ? 'pending' : 'subscribed',
        needsConfirmation ? hashToken(confirmToken) : null,
        hashToken(unsubToken),
        input.source ?? null,
        input.ip ? hashPii(input.ip, tenant.pii_salt) : null,
        needsConfirmation ? null : new Date(),
      ],
    );

    if (needsConfirmation) {
      await queueConfirmationEmail(client, tenant, contact, confirmToken, unsubToken);
      return {
        status: 'pending',
        contact,
        subscription: subscription!,
        // Returned only when NODE_ENV is explicitly 'test'. Any other
        // environment — including a misconfigured staging box — would be
        // handing the opt-in token to whoever asked, which defeats double
        // opt-in entirely.
        ...(config().env === 'test' ? { confirmToken } : {}),
      };
    }

    await completeSubscription(client, tenant, contact, subscription!, unsubToken);
    return { status: 'subscribed', contact, subscription: subscription! };
  };

  return runner ? run(runner) : withTransaction(run);
}

async function queueConfirmationEmail(
  client: Queryable,
  tenant: Tenant,
  contact: Contact,
  confirmToken: string,
  unsubToken: string,
): Promise<void> {
  const template = await getTemplate(tenant.id, 'newsletter_confirm', client);
  if (!template || !contact.email) return;

  const base = config().publicUrl;
  const rendered = renderTemplate(template, {
    tenant_name: tenant.name,
    name: contact.name ?? '',
    confirm_url: `${base}/n/confirm/${confirmToken}`,
    unsubscribe_url: `${base}/n/unsubscribe/${unsubToken}`,
  });

  await queueEmail(
    {
      tenantId: tenant.id,
      contactId: contact.id,
      templateKey: 'newsletter_confirm',
      to: contact.email,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      dedupeKey: `newsletter_confirm:${contact.id}:${hashToken(confirmToken).slice(0, 16)}`,
      ...senderFor(tenant),
    },
    client,
  );
}

/** Confirm a double opt-in, award the signup reward and send the welcome. */
export async function confirmSubscription(
  token: string,
  runner?: Queryable,
): Promise<{ tenant_id: string; contact_id: string; list_slug: string } | null> {
  const run = async (client: Queryable) => {
    const row = await queryOne<{
      id: string;
      tenant_id: string;
      contact_id: string;
      list_id: string;
      status: string;
      unsub_token_hash: string | null;
    }>(
      client,
      `SELECT id, tenant_id, contact_id, list_id, status, unsub_token_hash
         FROM subscriptions WHERE confirm_token_hash = $1`,
      [hashToken(token)],
    );
    if (!row) return null;

    const list = await queryOne<{ slug: string }>(client, 'SELECT slug FROM lists WHERE id = $1', [
      row.list_id,
    ]);

    // Already confirmed: report success so a re-clicked link is not an error.
    if (row.status === 'subscribed') {
      return { tenant_id: row.tenant_id, contact_id: row.contact_id, list_slug: list?.slug ?? '' };
    }

    const subscription = await queryOne<Subscription>(
      client,
      `UPDATE subscriptions
          SET status = 'subscribed', confirmed_at = now(), confirm_token_hash = NULL
        WHERE id = $1
        RETURNING *`,
      [row.id],
    );

    await client.query(
      `UPDATE contacts SET marketing_consent = true, consent_at = COALESCE(consent_at, now()),
              updated_at = now()
        WHERE id = $1`,
      [row.contact_id],
    );

    const tenant = await queryOne<Tenant>(client, 'SELECT * FROM tenants WHERE id = $1', [
      row.tenant_id,
    ]);
    const contact = await queryOne<Contact>(client, 'SELECT * FROM contacts WHERE id = $1', [
      row.contact_id,
    ]);
    if (tenant && contact && subscription) {
      await completeSubscription(client, tenant, contact, subscription, null);
    }

    return { tenant_id: row.tenant_id, contact_id: row.contact_id, list_slug: list?.slug ?? '' };
  };

  return runner ? run(runner) : withTransaction(run);
}

async function completeSubscription(
  client: Queryable,
  tenant: Tenant,
  contact: Contact,
  subscription: Subscription,
  unsubToken: string | null,
): Promise<void> {
  const outcome = await trigger(
    tenant.id,
    {
      contactId: contact.id,
      ruleKey: 'newsletter_signup',
      refId: subscription.id,
      refType: 'subscription',
    },
    client,
  );

  // `newsletter.confirmed` was a declared trigger type with no caller, so a
  // welcome series built on it never ran. This is the moment it describes:
  // double opt-in complete, consent recorded.
  await fire(
    tenant.id,
    'newsletter.confirmed',
    {
      contact,
      data: {
        list_id: subscription.list_id,
        subscription_id: subscription.id,
        points_awarded: outcome.awarded ? outcome.points : 0,
      },
      dedupeKey: `subscription:${subscription.id}`,
    },
    client,
  );

  const template = await getTemplate(tenant.id, 'newsletter_welcome', client);
  if (!template || !contact.email) return;

  const balance = await getBalance(tenant.id, contact.id, client);
  const base = config().publicUrl;
  // A signed request link when there is no list token, rather than the site
  // root. After a double opt-in confirmation the token has already been spent,
  // so the welcome email carried an "unsubscribe" link that went to the
  // homepage and no List-Unsubscribe header at all — the one message most
  // likely to be the first a person wants out of.
  const unsubscribeUrl = unsubToken
    ? `${base}/n/unsubscribe/${unsubToken}`
    : unsubscribeRequestUrl(tenant.id, contact.email);

  const rendered = renderTemplate(template, {
    tenant_name: tenant.name,
    name: contact.name ?? '',
    points: outcome.awarded ? outcome.points : 0,
    balance: balance.balance,
    rewards_url: (tenant.settings?.siteUrl as string) ?? base,
    unsubscribe_url: unsubscribeUrl,
  });

  await queueEmail(
    {
      tenantId: tenant.id,
      contactId: contact.id,
      templateKey: 'newsletter_welcome',
      to: contact.email,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      dedupeKey: `newsletter_welcome:${subscription.id}`,
      // A welcome carries the list's real token where there is one, which is
      // what makes the mail client's one-click unsubscribe work for the whole
      // subscription — and a signed request link otherwise, so the header is
      // there either way.
      unsubscribeUrl,
      ...senderFor(tenant),
    },
    client,
  );
}

/** One-click unsubscribe. Never reveals whether the token was real. */
export async function unsubscribeByToken(token: string, runner: Queryable = db()): Promise<boolean> {
  const { rowCount } = await runner.query(
    `UPDATE subscriptions
        SET status = 'unsubscribed', unsubscribed_at = now()
      WHERE unsub_token_hash = $1 AND status <> 'unsubscribed'`,
    [hashToken(token)],
  );

  // Parked sequences stop too. A welcome series that keeps arriving after
  // someone unsubscribed is the complaint that turns into a spam report, and
  // the consent check at send time would not save a run already mid-flight if
  // one of its steps were ever made transactional.
  await cancelParkedRuns(runner, token);

  // Unconditional: someone clicking an unsubscribe link a second time still
  // means "stop", and the first click may have flipped the list row without
  // the consent flag under the old code above.
  const { rowCount: consentRows } = await runner.query(
    `UPDATE contacts SET marketing_consent = false, updated_at = now()
      WHERE marketing_consent AND id IN (
        SELECT contact_id FROM subscriptions WHERE unsub_token_hash = $1
      )`,
    [hashToken(token)],
  );
  return (rowCount ?? 0) > 0 || (consentRows ?? 0) > 0;
}

/**
 * Unsubscribe everything for an address.
 *
 * This clears `marketing_consent` as well as the list rows, and the order
 * matters more than it looks: automation and cart-recovery mail gates on
 * `contacts.marketing_consent`, not on list membership, so an unsubscribe that
 * only touched `subscriptions` left those sequences running. The link in those
 * very emails points here, which made "Unsubscribe" a button that did nothing
 * for the mail the person was actually trying to stop.
 *
 * Consent is cleared whether or not a subscription row existed, because the
 * request is "stop emailing me" and a contact can be mailable without ever
 * having joined a list.
 */
export async function unsubscribeByEmail(
  tenantId: string,
  email: string,
  runner: Queryable = db(),
): Promise<boolean> {
  const normalised = email.trim().toLowerCase();

  const { rowCount: listRows } = await runner.query(
    `UPDATE subscriptions s
        SET status = 'unsubscribed', unsubscribed_at = now()
       FROM contacts c
      WHERE s.contact_id = c.id
        AND s.tenant_id = $1
        AND c.email_normalised = $2
        AND s.status <> 'unsubscribed'`,
    [tenantId, normalised],
  );

  const { rowCount: consentRows } = await runner.query(
    `UPDATE contacts
        SET marketing_consent = false, updated_at = now()
      WHERE tenant_id = $1 AND email_normalised = $2 AND marketing_consent`,
    [tenantId, normalised],
  );

  // Same reasoning as the token path: stop the sequences already in flight,
  // not just the next one that would start.
  await runner.query(
    `UPDATE automation_runs r
        SET status = 'cancelled', resume_at = NULL, updated_at = now()
       FROM contacts c
      WHERE r.contact_id = c.id AND r.tenant_id = $1
        AND c.email_normalised = $2
        AND r.status IN ('waiting', 'running')`,
    [tenantId, normalised],
  );

  return (listRows ?? 0) > 0 || (consentRows ?? 0) > 0;
}

export interface ListStats {
  slug: string;
  name: string;
  subscribed: number;
  pending: number;
  unsubscribed: number;
}

export async function listStats(tenantId: string, runner: Queryable = db()): Promise<ListStats[]> {
  const { rows } = await runner.query<ListStats>(
    `SELECT l.slug, l.name,
            COUNT(*) FILTER (WHERE s.status = 'subscribed')::int   AS subscribed,
            COUNT(*) FILTER (WHERE s.status = 'pending')::int      AS pending,
            COUNT(*) FILTER (WHERE s.status = 'unsubscribed')::int AS unsubscribed
       FROM lists l
       LEFT JOIN subscriptions s ON s.list_id = l.id
      WHERE l.tenant_id = $1
      GROUP BY l.slug, l.name
      ORDER BY l.slug`,
    [tenantId],
  );
  return rows;
}

/** Everyone who may legally be mailed on a list. */
export async function subscribersFor(
  tenantId: string,
  listSlug: string,
  limit = 1000,
  runner: Queryable = db(),
): Promise<Array<{ contact_id: string; email: string; name: string | null; unsub_token_hash: string | null }>> {
  const { rows } = await runner.query<{
    contact_id: string;
    email: string;
    name: string | null;
    unsub_token_hash: string | null;
  }>(
    `SELECT s.contact_id, c.email, c.name, s.unsub_token_hash
       FROM subscriptions s
       JOIN lists l ON l.id = s.list_id
       JOIN contacts c ON c.id = s.contact_id
      WHERE s.tenant_id = $1 AND l.slug = $2 AND s.status = 'subscribed'
        AND c.email IS NOT NULL AND c.marketing_consent
      ORDER BY s.confirmed_at DESC NULLS LAST
      LIMIT $3`,
    [tenantId, listSlug, Math.min(limit, 10_000)],
  );
  return rows;
}

/** Cancel every parked automation run for the contact behind an unsub token. */
async function cancelParkedRuns(runner: Queryable, token: string): Promise<void> {
  await runner.query(
    `UPDATE automation_runs
        SET status = 'cancelled', resume_at = NULL, updated_at = now()
      WHERE status IN ('waiting', 'running')
        AND contact_id IN (
          SELECT contact_id FROM subscriptions WHERE unsub_token_hash = $1
        )`,
    [hashToken(token)],
  );
}

/**
 * A signed, self-contained unsubscribe link.
 *
 * The unsigned form of this endpoint took a tenant id and an email address
 * straight from the query string — and the tenant id is printed in the
 * unsubscribe link of every marketing email we send, so one received message
 * revealed it. Anyone could then walk a list of addresses and permanently
 * suppress a competitor's entire audience with a shell loop.
 *
 * The signature is an HMAC over exactly the pair being acted on, so a link
 * only works for the address it was minted for. It does not expire: an
 * unsubscribe link in a two-year-old email must still work, and there is
 * nothing to gain by replaying one — unsubscribing twice is unsubscribing.
 */
export function unsubscribeRequestUrl(tenantId: string, email: string): string {
  const token = signPayload({ t: tenantId, e: normaliseEmail(email), k: 'unsub' });
  return `${config().publicUrl}/n/u/${encodeURIComponent(token)}`;
}

export function verifyUnsubscribeRequest(
  token: string,
): { tenantId: string; email: string } | null {
  const payload = verifyPayload<{ t?: string; e?: string; k?: string }>(token);
  // The `k` discriminator stops a signed payload minted for some other purpose
  // — an attribution cookie, say — from being replayed here.
  if (!payload || payload.k !== 'unsub' || !payload.t || !payload.e) return null;
  return { tenantId: payload.t, email: payload.e };
}

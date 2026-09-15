import { db, queryOne, withTransaction, type Queryable } from '../db/pool.js';
import { config } from '../config.js';
import { hashPii, hashToken, randomToken } from '../lib/crypto.js';
import { ApiError } from '../lib/errors.js';
import { isValidEmail, upsertContact, type Contact } from './contacts.js';
import { getTemplate, queueEmail, renderTemplate, senderFor } from './email.js';
import { trigger } from './rewards.js';
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
): Promise<SubscribeResult> {
  const email = String(input.email ?? '').trim();
  if (!isValidEmail(email)) throw ApiError.badRequest('A valid email address is required');

  const run = async (client: Queryable): Promise<SubscribeResult> => {
    const list = await ensureList(tenant.id, input.listSlug ?? DEFAULT_LIST_SLUG, 'Newsletter', client);

    const contact = await upsertContact(
      tenant.id,
      {
        email,
        name: input.name ?? null,
        attributes: input.attributes ?? {},
        marketingConsent: !list.double_optin,
        consentSource: input.source ?? 'newsletter_form',
      },
      client,
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
    const needsConfirmation = list.double_optin;

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
        ...(config().isProduction ? {} : { confirmToken }),
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

  const template = await getTemplate(tenant.id, 'newsletter_welcome', client);
  if (!template || !contact.email) return;

  const balance = await getBalance(tenant.id, contact.id, client);
  const base = config().publicUrl;
  const rendered = renderTemplate(template, {
    tenant_name: tenant.name,
    name: contact.name ?? '',
    points: outcome.awarded ? outcome.points : 0,
    balance: balance.balance,
    rewards_url: (tenant.settings?.siteUrl as string) ?? base,
    unsubscribe_url: unsubToken ? `${base}/n/unsubscribe/${unsubToken}` : base,
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

  if (rowCount && rowCount > 0) {
    await runner.query(
      `UPDATE contacts SET marketing_consent = false, updated_at = now()
        WHERE id IN (
          SELECT contact_id FROM subscriptions WHERE unsub_token_hash = $1
        )`,
      [hashToken(token)],
    );
  }
  return (rowCount ?? 0) > 0;
}

export async function unsubscribeByEmail(
  tenantId: string,
  email: string,
  runner: Queryable = db(),
): Promise<boolean> {
  const { rowCount } = await runner.query(
    `UPDATE subscriptions s
        SET status = 'unsubscribed', unsubscribed_at = now()
       FROM contacts c
      WHERE s.contact_id = c.id
        AND s.tenant_id = $1
        AND c.email_normalised = lower($2)
        AND s.status <> 'unsubscribed'`,
    [tenantId, email.trim()],
  );
  return (rowCount ?? 0) > 0;
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

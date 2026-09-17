import nodemailer, { type Transporter } from 'nodemailer';
import { db, queryOne, type Queryable } from '../db/pool.js';
import { config } from '../config.js';
import { ApiError } from '../lib/errors.js';
import { mayReceive } from './preferences.js';
import { planTracking } from './email-tracking.js';
import { isSuppressed, recordFailure } from './deliverability.js';
import type { Tenant } from './tenants.js';

export interface OutgoingEmail {
  to: string;
  subject: string;
  html: string;
  text?: string | null;
  fromName?: string;
  fromAddress?: string;
  /**
   * Extra RFC 5322 headers, in practice List-Unsubscribe and
   * List-Unsubscribe-Post. Gmail and Yahoo require one-click unsubscribe from
   * bulk senders, and a missing header is a deliverability problem long before
   * anyone complains about it.
   */
  headers?: Record<string, string>;
}

export interface SentEmail extends OutgoingEmail {
  providerId: string;
  sentAt: Date;
}

export interface EmailTransport {
  send(message: OutgoingEmail): Promise<{ providerId: string }>;
}

/** Development transport: records to the log and to an in-memory outbox. */
class LogTransport implements EmailTransport {
  readonly outbox: SentEmail[] = [];

  async send(message: OutgoingEmail): Promise<{ providerId: string }> {
    const providerId = `log-${Date.now()}-${this.outbox.length}`;
    this.outbox.push({ ...message, providerId, sentAt: new Date() });
    if (config().env !== 'test') {
      console.log(`[email] → ${message.to}: ${message.subject}`);
    }
    return { providerId };
  }
}

class SmtpTransport implements EmailTransport {
  private transporter: Transporter;

  constructor(url: string) {
    this.transporter = nodemailer.createTransport(url, {
      // These have to stay well under STALE_CLAIM, because that is what the
      // queue assumes: a send still running when another worker reclaims the
      // row delivers the message a second time. nodemailer's own defaults do
      // not hold that -- its socket timeout is ten minutes, twice the claim
      // window -- so a relay that accepts the connection and then goes quiet
      // is exactly the stall that sends twice. Say the numbers out loud
      // instead of inheriting them.
      connectionTimeout: 30_000,
      greetingTimeout: 30_000,
      socketTimeout: 120_000,
    });
  }

  async send(message: OutgoingEmail): Promise<{ providerId: string }> {
    const cfg = config();
    const info = await this.transporter.sendMail({
      from: `"${message.fromName ?? cfg.email.fromName}" <${message.fromAddress ?? cfg.email.fromAddress}>`,
      to: message.to,
      subject: message.subject,
      html: message.html,
      text: message.text ?? stripHtml(message.html),
      headers: message.headers,
    });
    return { providerId: info.messageId };
  }
}

let transport: EmailTransport | null = null;

export function emailTransport(): EmailTransport {
  if (transport) return transport;
  const cfg = config();
  transport =
    cfg.email.transport === 'smtp' && cfg.email.smtpUrl
      ? new SmtpTransport(cfg.email.smtpUrl)
      : new LogTransport();
  return transport;
}

export function setEmailTransport(custom: EmailTransport | null): void {
  transport = custom;
}

/** The in-memory outbox, when the log transport is active. Test helper. */
export function outbox(): SentEmail[] {
  const current = emailTransport();
  return current instanceof LogTransport ? current.outbox : [];
}

export interface QueueInput {
  tenantId: string;
  contactId?: string | null;
  templateKey: string;
  to: string;
  subject: string;
  html: string;
  text?: string | null;
  /** Unique per tenant; a repeat enqueue with the same key is dropped. */
  dedupeKey: string;
  /**
   * Rewrite links and add an open pixel.
   *
   * Left unset the message is not tracked, so every existing caller keeps its
   * current behaviour and a transactional receipt never gets a pixel. The
   * senders that raise it read the tenant's `emailTracking` setting first.
   */
  track?: boolean;
  /**
   * Where this message's unsubscribe link points.
   *
   * Supplied by the caller because the plaintext token exists only there —
   * subscriptions store a hash. Used for the List-Unsubscribe header, so the
   * mail client's own button lands in the same place as the link in the body.
   * Omit for transactional mail, which has nothing to unsubscribe from.
   */
  unsubscribeUrl?: string | null;
}

export interface QueueResult {
  id: string | null;
  queued: boolean;
}

/**
 * Enqueue a message. The unique dedupe key is what makes the whole email side
 * safe to retry: a worker that crashes after queueing but before sending will
 * not produce a second copy on its next pass.
 */
export async function queueEmail(input: QueueInput, runner: Queryable = db()): Promise<QueueResult> {
  // Rewriting happens at queue time, not at send time: the stored html is what
  // the recipient received, so a support question about "the link in my email"
  // can be answered from the row.
  const plan = input.track ? planTracking(input.html) : null;

  const row = await queryOne<{ id: string }>(
    runner,
    `INSERT INTO email_messages (
       tenant_id, contact_id, template_key, to_email, subject, html, text, dedupe_key,
       tracking_token, tracked_links, unsubscribe_url
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11)
     ON CONFLICT (tenant_id, dedupe_key) DO NOTHING
     RETURNING id`,
    [
      input.tenantId,
      input.contactId ?? null,
      input.templateKey,
      input.to,
      input.subject,
      plan?.html ?? input.html,
      input.text ?? null,
      input.dedupeKey,
      plan && plan.links.length > 0 ? plan.token : null,
      JSON.stringify(plan?.links ?? []),
      input.unsubscribeUrl ?? null,
    ],
  );
  return { id: row?.id ?? null, queued: row !== null };
}

/** Send up to `limit` queued messages. Returns how many went out. */
export async function flushEmailQueue(limit = 50, runner: Queryable = db()): Promise<number> {
  // A worker that dies mid-send leaves the row in `sending` for the next claim
  // to take back -- but each reclaim spends an attempt, and once they run out
  // the claim's `attempts < MAX` skips the row while nothing else looks at
  // `sending` at all. The message sat there forever: never sent, never failed,
  // no error, invisible to the retailer. Give those rows the ending they
  // earned. Not a suppression: five dead workers say nothing about the address.
  await runner.query(
    `UPDATE email_messages
        SET status = 'failed',
            error = COALESCE(error, 'Sending stopped responding and ran out of attempts'),
            claimed_at = NULL,
            claim_token = NULL
      WHERE status = 'sending'
        AND attempts >= $1
        AND claimed_at < now() - $2::interval`,
    [MAX_SEND_ATTEMPTS, STALE_CLAIM],
  );

  const { rows } = await runner.query<{
    id: string;
    tenant_id: string;
    contact_id: string | null;
    to_email: string;
    subject: string;
    html: string;
    text: string | null;
    attempts: number;
    unsubscribe_url: string | null;
    template_key: string | null;
    claim_token: string;
  }>(
    // The claim moves the row to `sending`, which no other claim selects.
    //
    // `FOR UPDATE SKIP LOCKED` alone was not enough: those locks last only as
    // long as the claiming statement, so once it committed the rows were
    // `queued` again with `attempts` merely one higher — and the next worker's
    // tick sent every one of them a second time. One worker never noticed; the
    // shipped compose file runs two.
    //
    // A worker that dies mid-send leaves a row in `sending` forever, so the
    // claim also takes back anything that has been there longer than any send
    // could plausibly take. That is at-least-once rather than exactly-once,
    // which is the honest guarantee for "we called an SMTP server and did not
    // hear back".
    //
    // Each row comes back with a fresh `claim_token`, because every write below
    // is a compare-and-swap against it. Without that, a worker whose send outlived
    // the stale window wrote its late failure over the row another worker had
    // already marked `sent` -- the message went back to `queued` and was
    // delivered a second time. A stall that long is not exotic: nodemailer's
    // default socket timeout is ten minutes, so a relay that goes quiet
    // mid-conversation produces exactly it. A token rather than `claimed_at`:
    // Postgres keeps microseconds, node-postgres hands back a JS Date with
    // milliseconds, and the truncated value never matches on the way in.
    //
    // RETURNING does not inherit the subselect's ORDER BY, so the final SELECT
    // is what actually sends a batch in the order it was queued.
    `WITH claimed AS (
       SELECT id FROM email_messages
        WHERE attempts < $2
          AND next_attempt_at <= now()
          AND (
            status = 'queued'
            OR (status = 'sending' AND claimed_at < now() - $3::interval)
          )
        ORDER BY created_at
        LIMIT $1
        FOR UPDATE SKIP LOCKED
     ), bumped AS (
       UPDATE email_messages
          SET attempts = attempts + 1, status = 'sending', claimed_at = now(),
              claim_token = gen_random_uuid()
        WHERE id IN (SELECT id FROM claimed)
        RETURNING id, tenant_id, contact_id, to_email, subject, html, text, attempts,
                  unsubscribe_url, template_key, claim_token, created_at
     )
     SELECT id, tenant_id, contact_id, to_email, subject, html, text, attempts,
            unsubscribe_url, template_key, claim_token
       FROM bumped ORDER BY created_at`,
    [limit, MAX_SEND_ATTEMPTS, STALE_CLAIM],
  );

  const sender = emailTransport();
  let sent = 0;

  for (const message of rows) {
    // Checked at send time rather than at queue time: an address can be
    // suppressed between being queued and being sent, and the whole point of
    // a suppression list is that nothing gets past it.
    //
    // Unsubscribing is the same shape and was not covered. A broadcast queues
    // 200 recipients a pass while the queue drains 50, so a large audience
    // spends the best part of an hour in the queue — and anybody who clicked
    // unsubscribe during it was mailed anyway, by a message written before
    // they asked us to stop. Only marketing is re-checked: a message with no
    // unsubscribe URL is a receipt, which withdrawing consent does not cancel.
    const blocked =
      (await isSuppressed(message.tenant_id, message.to_email, runner)) ??
      (message.unsubscribe_url ? await withdrawnConsent(runner, message) : null);
    if (blocked) {
      await runner.query(
        `UPDATE email_messages
            SET status = 'suppressed', error = $2, claimed_at = NULL, claim_token = NULL
          WHERE id = $1 AND status = 'sending' AND claim_token = $3`,
        [message.id, `Address suppressed: ${blocked.reason}`, message.claim_token],
      );
      continue;
    }

    try {
      const { providerId } = await sender.send({
        to: message.to_email,
        subject: message.subject,
        html: message.html,
        text: message.text,
        headers: unsubscribeHeaders(message.unsubscribe_url),
      });
      await runner.query(
        `UPDATE email_messages
            SET status = 'sent', sent_at = now(), provider_id = $2,
                error = NULL, claimed_at = NULL, claim_token = NULL
          WHERE id = $1 AND status = 'sending' AND claim_token = $3`,
        [message.id, providerId, message.claim_token],
      );
      sent += 1;
    } catch (err) {
      // The code as well as the message: nodemailer puts the useful part of a
      // timeout in `err.code` and leaves the message as the bare word
      // "Timeout", which reads like a soft bounce against the recipient.
      const code = (err as { code?: unknown } | null)?.code;
      const reason = [
        err instanceof Error ? err.message : String(err),
        typeof code === 'string' && code !== '' ? `(${code})` : '',
      ]
        .filter((part) => part !== '')
        .join(' ');

      // Classify before deciding to retry: a mailbox that does not exist will
      // not start existing on the fourth attempt, and four more tries at it is
      // four more bounces against the sending domain's reputation.
      const type = await recordFailure(
        message.tenant_id,
        message.to_email,
        reason,
        message.attempts,
        MAX_SEND_ATTEMPTS,
        runner,
      );

      // A transport failure is about us, not the recipient, so it neither
      // gives up nor spends the attempt budget. Otherwise a relay that is down
      // for ninety seconds burns the whole attempt budget on every queued
      // message and a whole broadcast is lost to an outage that fixed itself.
      const transport = type === 'transport';
      const giveUp = !transport && (type !== 'soft' || message.attempts >= MAX_SEND_ATTEMPTS);

      await runner.query(
        // Backed off, not retried on the next tick: see
        // SOFT_RETRY_DELAYS_SECONDS for why the budget is hours rather than
        // minutes.
        `UPDATE email_messages
            SET status = $3,
                error = $2,
                bounce_type = $4,
                claimed_at = NULL,
                claim_token = NULL,
                next_attempt_at = now() + ($6 || ' seconds')::interval,
                attempts = CASE WHEN $5::boolean THEN GREATEST(attempts - 1, 0) ELSE attempts END
          WHERE id = $1 AND status = 'sending' AND claim_token = $7`,
        [
          message.id,
          reason.slice(0, 500),
          giveUp ? 'failed' : 'queued',
          type,
          transport,
          String(retryDelaySeconds(message.attempts, transport)),
          message.claim_token,
        ],
      );
    }
  }

  return sent;
}

/**
 * Did this person withdraw consent after the message was queued?
 *
 * Keyed on the contact rather than the address, because that is what an
 * unsubscribe writes. A message with no contact — an operator sending to a
 * bare address — has nobody to have changed their mind.
 */
async function withdrawnConsent(
  runner: Queryable,
  message: { tenant_id: string; contact_id?: string | null; template_key?: string | null },
): Promise<{ reason: string } | null> {
  if (!message.contact_id) return null;

  // Everything the preference page can say, not just the consent flag.
  //
  // This read `marketing_consent` alone, so somebody who chose "pause for 30
  // days" or turned this topic off between the queue and the send was mailed
  // anyway. A large audience spends the best part of an hour in the queue;
  // every answer given during it has to count, not only the strongest one.
  const topic = await queryOne<{ topic_key: string | null }>(
    runner,
    'SELECT topic_key FROM email_templates WHERE tenant_id = $1 AND key = $2',
    [message.tenant_id, message.template_key ?? ''],
  );

  const verdict = await mayReceive(
    message.tenant_id,
    message.contact_id,
    topic?.topic_key ?? null,
    runner,
  );
  return verdict.allowed ? null : { reason: verdict.reason ?? 'not_permitted' };
}

// Six, paired with SOFT_RETRY_DELAYS_SECONDS: five backoffs of 5m, 15m, 1h,
// 4h and 12h, then the sixth failure is the one that gives up.
const MAX_SEND_ATTEMPTS = 6;

/**
 * How long a claimed message may sit in `sending` before another worker takes
 * it back.
 *
 * Long enough that a slow SMTP conversation is never mistaken for a dead
 * worker, and short enough that a crash does not strand a campaign until
 * somebody notices.
 *
 * The first half of that only holds because SmtpTransport sets its own
 * timeouts: 30s to connect, 30s for the greeting, 120s of silence mid-stream,
 * so a send cannot outlive this window. It does not hold for a transport
 * injected through setEmailTransport — give that one a timeout under five
 * minutes too, or a stalled send will go out twice.
 */
const STALE_CLAIM = '5 minutes';

/**
 * How long to wait before trying a message again.
 *
 * 1, 2, 4, 8 minutes. A transport failure does not spend an attempt, so an
 * outage still backs off without ever exhausting the budget — the wait is what
 * stops the queue hammering a relay that is down, and the unspent attempt is
 * what stops the outage suppressing anybody.
 */
/**
 * How long before the next try.
 *
 * A transport failure is the relay being briefly unreachable, so it comes back
 * in a minute and does not spend an attempt. Everything else is the far end
 * saying no for a reason of its own -- throttling, a reputation block, a
 * greylist that has not aged -- and those are measured in hours.
 *
 * 1, 2, 4, 8 minutes spent the whole budget in a quarter of an hour, which
 * meant an afternoon on a blocklist ended with the address suppressed for
 * thirty days. This schedule runs a little over seventeen hours across six
 * attempts, so a bad afternoon or an overnight block is survivable and the
 * address is still there in the morning.
 */
const SOFT_RETRY_DELAYS_SECONDS = [5 * 60, 15 * 60, 60 * 60, 4 * 60 * 60, 12 * 60 * 60];

function retryDelaySeconds(attempts: number, transport: boolean): number {
  if (transport) return 60;
  const index = Math.min(Math.max(attempts, 1), SOFT_RETRY_DELAYS_SECONDS.length) - 1;
  return SOFT_RETRY_DELAYS_SECONDS[index]!;
}

/**
 * RFC 8058 one-click unsubscribe.
 *
 * `List-Unsubscribe-Post` is what makes the mail client's own unsubscribe
 * button work without the recipient visiting anything, and Gmail and Yahoo
 * both require it from bulk senders. Sending the header without it is worse
 * than useless: the client shows the button and the POST it makes is ignored.
 *
 * Only added when the message carries an unsubscribe token, which means it
 * belongs to a list subscription. Transactional mail has nothing to
 * unsubscribe from.
 */
export function unsubscribeHeaders(url: string | null): Record<string, string> | undefined {
  if (!url) return undefined;
  return {
    'List-Unsubscribe': `<${url}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Templates
// ─────────────────────────────────────────────────────────────────────────────

export interface RenderedTemplate {
  subject: string;
  html: string;
  text: string;
}

const PLACEHOLDER = /\{\{\s*([a-z0-9_.]+)\s*\}\}/gi;

export function renderTemplate(
  template: { subject: string; html: string; text?: string | null },
  vars: Record<string, unknown>,
): RenderedTemplate {
  const subject = interpolate(template.subject, vars, false);
  let html = interpolate(template.html, vars);

  // A missing variable interpolates to an empty string, which in an `href`
  // means a link back to the email itself — worse than no link. Confirmation
  // and cart-recovery mail has no preference page to point at, so the whole
  // anchor goes rather than depending on five call sites to remember.
  if (!vars.preferences_url) html = stripEmptyLinks(html);

  const text = template.text ? interpolate(template.text, vars, false) : stripHtml(html);
  return { subject, html, text };
}

/** Drop `<a href="">…</a>`, and any separator left stranded beside it. */
function stripEmptyLinks(html: string): string {
  return html
    .replace(/<a\s+href=""[^>]*>[\s\S]*?<\/a>\s*(&nbsp;)?\s*(&middot;)?\s*(&nbsp;)?/gi, '')
    .replace(/(&nbsp;)?\s*&middot;\s*(&nbsp;)?\s*(?=<\/p>)/gi, '');
}

/**
 * Substitute `{{placeholders}}`.
 *
 * `escape` is false for the subject line and the plain-text part, because
 * neither is HTML: a store called "Bob's Bikes" was arriving as "Bob&#39;s
 * Bikes" in the inbox, and a text-part link with two query parameters arrived
 * with `&amp;` in it, which is a broken link in a text-only client.
 *
 * It stays true — unconditionally — for the HTML part.
 */
function interpolate(
  input: string,
  vars: Record<string, unknown>,
  escape = true,
): string {
  return input.replace(PLACEHOLDER, (_match, key: string) => {
    const value = key.split('.').reduce<unknown>((acc, part) => {
      if (acc && typeof acc === 'object' && part in (acc as Record<string, unknown>)) {
        return (acc as Record<string, unknown>)[part];
      }
      return undefined;
    }, vars);
    if (value === undefined || value === null) return '';
    return escape ? escapeHtml(String(value)) : String(value);
  });
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export async function getTemplate(
  tenantId: string,
  key: string,
  runner: Queryable = db(),
): Promise<EmailTemplate | null> {
  const row = await queryOne<EmailTemplate>(
    runner,
    `SELECT subject, html, text, transactional, topic_key, blocks, preheader
       FROM email_templates WHERE tenant_id = $1 AND key = $2`,
    [tenantId, key],
  );
  if (row) return row;
  const fallback = DEFAULT_TEMPLATES[key];
  if (!fallback) return null;
  // A built-in template belongs to no topic: these are the messages a store
  // has not customised, and inventing a topic for them would filter mail the
  // retailer never chose to categorise.
  return {
    ...fallback,
    transactional: fallback.transactional ?? false,
    topic_key: null,
    blocks: null,
    preheader: null,
  };
}

export interface EmailTemplate {
  subject: string;
  html: string;
  text: string | null;
  /** True means consent is not required; see `upsertTemplate`. */
  transactional: boolean;
  /** Which topic this belongs to, so a recipient's choice can be honoured. */
  topic_key: string | null;
  /**
   * The composed blocks, when the template was built rather than written.
   *
   * `html` above is already rendered from these, so most sends need not look
   * at them. They matter when a block is conditional: the stored HTML shows
   * every block, and the per-recipient copy has to be re-rendered against what
   * that recipient is a member of.
   */
  blocks: unknown;
  /** The line a mail client shows beside the subject; composed messages only. */
  preheader: string | null;
}

export async function upsertTemplate(
  tenantId: string,
  key: string,
  template: {
    subject: string;
    /** Hand-written HTML. Omitted leaves whatever is stored alone. */
    html?: string;
    text?: string | null;
    /**
     * Send this even to contacts without marketing consent.
     *
     * A transactional message is one the person's own action asked for — an
     * order receipt, the points that order earned. Marketing is anything they
     * did not ask for, and stays consent-gated. Default false: opting a
     * template out of consent is a decision the retailer makes on purpose.
     */
    transactional?: boolean;
    /** Which topic it belongs to, for the preference centre. */
    topicKey?: string | null;
    /**
     * Composed blocks instead of hand-written HTML.
     *
     * When present, `html` is generated from them — so the send path reads one
     * column either way and a template that uses blocks costs nothing extra to
     * send. The blocks are kept so the builder can reopen what somebody wrote,
     * which generated HTML cannot be parsed back into.
     */
    blocks?: unknown;
    /** The line a mail client shows beside the subject; composed messages only. */
    preheader?: string | null;
  },
  runner: Queryable = db(),
): Promise<void> {
  /**
   * What is already there, so a field the caller did not name is kept.
   *
   * Omitting `text` used to clear the plain-text override, omitting
   * `transactional` turned a receipt back into marketing — meaning it stopped
   * reaching anyone without a marketing opt-in — and omitting `topicKey` or
   * `preheader` cleared those too. The wp-admin form happens to post most of
   * them on every save, which is why it went unnoticed; an API caller editing
   * a subject line lost the rest.
   *
   * For a built-in being overridden for the first time this is the built-in,
   * which is the right base to edit from.
   */
  const existing = await getTemplate(tenantId, key, runner);
  const named = <T>(value: T | undefined, fallback: T): T =>
    value === undefined ? fallback : value;

  let html = named(template.html, existing?.html ?? '');
  let text = named(template.text, existing?.text ?? null);
  let blocks: string | null = existing?.blocks ? JSON.stringify(existing.blocks) : null;
  const transactional = named(template.transactional, existing?.transactional ?? false);
  const topicKey = named(template.topicKey, existing?.topic_key ?? null);
  const preheader =
    template.preheader === undefined
      ? existing?.preheader ?? null
      : template.preheader?.trim() || null;

  if (template.html !== undefined) {
    // Hand-written HTML replaces a composed body: generated HTML cannot be
    // parsed back into blocks, so keeping both would leave the builder
    // reopening something the message no longer is.
    blocks = null;
  }

  if (template.blocks !== undefined && template.blocks !== null) {
    const { validateBlocks, renderDocument, blocksToText, assertSegmentsExist } =
      await import('./email-blocks.js');
    const checked = validateBlocks(template.blocks);
    if (checked.length === 0) {
      // Otherwise the stored body is the frame and nothing else: a message
      // whose only content is its own unsubscribe link.
      throw ApiError.badRequest('An email needs at least one block');
    }
    await assertSegmentsExist(tenantId, checked, runner);
    blocks = JSON.stringify(checked);
    // Rendered without any segment membership: this is the copy stored on the
    // template, and a conditional block is resolved per recipient at send time.
    html = renderDocument(checked, new Set(), preheader);
    text = blocksToText(checked);
  }

  await runner.query(
    `INSERT INTO email_templates
       (tenant_id, key, subject, html, text, transactional, topic_key, blocks, preheader)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
     ON CONFLICT (tenant_id, key) DO UPDATE SET
       subject = EXCLUDED.subject, html = EXCLUDED.html,
       text = EXCLUDED.text, transactional = EXCLUDED.transactional,
       -- Direct, not COALESCE: a template moved out of every topic has to be
       -- able to go back to belonging to none.
       topic_key = $7,
       blocks = EXCLUDED.blocks,
       preheader = EXCLUDED.preheader,
       updated_at = now()`,
    [
      tenantId,
      key,
      template.subject,
      html,
      text,
      transactional,
      topicKey,
      blocks,
      preheader,
    ],
  );
}

export async function deleteTemplate(
  tenantId: string,
  key: string,
  runner: Queryable = db(),
): Promise<boolean> {
  const { rowCount } = await runner.query(
    'DELETE FROM email_templates WHERE tenant_id = $1 AND key = $2',
    [tenantId, key],
  );
  return (rowCount ?? 0) > 0;
}

/** Templates a retailer has overridden, plus the built-in defaults. */
export async function listTemplates(
  tenantId: string,
  runner: Queryable = db(),
): Promise<Array<{ key: string; subject: string; transactional: boolean; overridden: boolean }>> {
  const { rows } = await runner.query<{ key: string; subject: string; transactional: boolean }>(
    'SELECT key, subject, transactional FROM email_templates WHERE tenant_id = $1',
    [tenantId],
  );
  const overrides = new Map(rows.map((row) => [row.key, row]));
  const keys = new Set([...Object.keys(DEFAULT_TEMPLATES), ...overrides.keys()]);

  return [...keys].sort().map((key) => {
    const override = overrides.get(key);
    const fallback = DEFAULT_TEMPLATES[key];
    return {
      key,
      subject: override?.subject ?? fallback?.subject ?? '',
      transactional: override?.transactional ?? fallback?.transactional ?? false,
      overridden: override !== undefined,
    };
  });
}

export function senderFor(tenant: Tenant): { fromName: string; fromAddress: string } {
  const cfg = config();
  return {
    fromName: (tenant.settings?.fromName as string) ?? tenant.name ?? cfg.email.fromName,
    fromAddress: (tenant.settings?.fromEmail as string) ?? cfg.email.fromAddress,
  };
}

/**
 * The frame every message shares: the card, the sender's name, and the footer
 * carrying preferences and unsubscribe.
 *
 * Exported because a composed message needs the same frame. A block list
 * renders to a fragment — headings and paragraphs — and storing that fragment
 * as the body would send marketing with no visible way out of it, which is
 * both illegal in most of the places this ships and the fastest way to be
 * marked as spam by the recipients who cannot find the link.
 */
export function layout(body: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:24px;background:#f5f5f7;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1d1d1f;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;padding:32px;">
    <tr><td>
      <p style="margin:0 0 20px;font-size:14px;color:#6e6e73;">{{tenant_name}}</p>
      ${body}
      <hr style="border:none;border-top:1px solid #e5e5ea;margin:32px 0 16px;">
      <p style="margin:0;font-size:12px;color:#8e8e93;">
        <!-- Preferences first, unsubscribe second. Most people who click the
             second one want the first: less, or one of the things this store
             sends rather than all of them. Offered only the exit, they take
             it. -->
        <a href="{{preferences_url}}" style="color:#8e8e93;">Email preferences</a>
        &nbsp;&middot;&nbsp;
        <a href="{{unsubscribe_url}}" style="color:#8e8e93;">Unsubscribe</a>
      </p>
    </td></tr>
  </table>
</body></html>`;
}

export const DEFAULT_TEMPLATES: Record<
  string,
  { subject: string; html: string; text: string | null; transactional?: boolean }
> = {
  newsletter_confirm: {
    subject: 'Confirm your subscription to {{tenant_name}}',
    html: layout(`
      <h1 style="margin:0 0 16px;font-size:22px;">One more step</h1>
      <p style="margin:0 0 20px;font-size:15px;line-height:1.55;">
        Tap the button below to confirm you want emails from {{tenant_name}}. If you did not
        request this, you can ignore this message and nothing will happen.
      </p>
      <p style="margin:0 0 24px;">
        <a href="{{confirm_url}}" style="display:inline-block;background:#1d1d1f;color:#ffffff;
           text-decoration:none;padding:12px 22px;border-radius:8px;font-size:15px;">Confirm subscription</a>
      </p>
      <p style="margin:0;font-size:13px;color:#6e6e73;">Or paste this into your browser:<br>{{confirm_url}}</p>`),
    text: null,
  },
  newsletter_welcome: {
    subject: 'You are on the list — and {{points}} points are in your account',
    html: layout(`
      <h1 style="margin:0 0 16px;font-size:22px;">Welcome aboard</h1>
      <p style="margin:0 0 20px;font-size:15px;line-height:1.55;">
        Your subscription to {{tenant_name}} is confirmed, and we have credited your rewards
        account with <strong>{{points}} points</strong>.
      </p>
      <p style="margin:0 0 20px;font-size:15px;line-height:1.55;">
        Points convert to TBAY tokens you can spend at any retailer on the TBAY network.
      </p>
      <p style="margin:0;"><a href="{{rewards_url}}" style="display:inline-block;background:#1d1d1f;
         color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:8px;font-size:15px;">View your rewards</a></p>`),
    text: null,
  },
  cart_recovery_1: {
    subject: 'You left something behind',
    html: layout(`
      <h1 style="margin:0 0 16px;font-size:22px;">Still thinking it over?</h1>
      <p style="margin:0 0 20px;font-size:15px;line-height:1.55;">
        Your cart at {{tenant_name}} is still saved — {{item_count}} item(s), {{subtotal}}.
      </p>
      <p style="margin:0 0 24px;"><a href="{{recovery_url}}" style="display:inline-block;background:#1d1d1f;
         color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:8px;font-size:15px;">Return to your cart</a></p>`),
    text: null,
  },
  cart_recovery_2: {
    subject: 'Your cart is still waiting',
    html: layout(`
      <h1 style="margin:0 0 16px;font-size:22px;">Your cart is still waiting</h1>
      <p style="margin:0 0 20px;font-size:15px;line-height:1.55;">
        We are holding {{item_count}} item(s) totalling {{subtotal}}. Stock is not reserved,
        so grab them while they are still there.
      </p>
      <p style="margin:0 0 24px;"><a href="{{recovery_url}}" style="display:inline-block;background:#1d1d1f;
         color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:8px;font-size:15px;">Complete your order</a></p>`),
    text: null,
  },
  cart_recovery_3: {
    subject: 'Last call for your cart',
    html: layout(`
      <h1 style="margin:0 0 16px;font-size:22px;">Last call</h1>
      <p style="margin:0 0 20px;font-size:15px;line-height:1.55;">
        This is the final reminder about the {{item_count}} item(s) in your cart at {{tenant_name}}.
      </p>
      <p style="margin:0 0 24px;"><a href="{{recovery_url}}" style="display:inline-block;background:#1d1d1f;
         color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:8px;font-size:15px;">Checkout now</a></p>`),
    text: null,
  },
  points_awarded: {
    subject: 'You earned {{points}} points',
    html: layout(`
      <h1 style="margin:0 0 16px;font-size:22px;">+{{points}} points</h1>
      <p style="margin:0 0 20px;font-size:15px;line-height:1.55;">
        {{reason}} — your balance is now <strong>{{balance}} points</strong>.
      </p>
      <p style="margin:0;"><a href="{{rewards_url}}" style="display:inline-block;background:#1d1d1f;
         color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:8px;font-size:15px;">View your rewards</a></p>`),
    text: null,
    // The points are the receipt for something the person just did, so this
    // ships transactional by default. A retailer who reads it as marketing can
    // flip the flag on their own copy of the template.
    transactional: true,
  },
};

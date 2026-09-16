import nodemailer, { type Transporter } from 'nodemailer';
import { db, queryOne, type Queryable } from '../db/pool.js';
import { config } from '../config.js';
import type { Tenant } from './tenants.js';

export interface OutgoingEmail {
  to: string;
  subject: string;
  html: string;
  text?: string | null;
  fromName?: string;
  fromAddress?: string;
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
    this.transporter = nodemailer.createTransport(url);
  }

  async send(message: OutgoingEmail): Promise<{ providerId: string }> {
    const cfg = config();
    const info = await this.transporter.sendMail({
      from: `"${message.fromName ?? cfg.email.fromName}" <${message.fromAddress ?? cfg.email.fromAddress}>`,
      to: message.to,
      subject: message.subject,
      html: message.html,
      text: message.text ?? stripHtml(message.html),
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
  const row = await queryOne<{ id: string }>(
    runner,
    `INSERT INTO email_messages (
       tenant_id, contact_id, template_key, to_email, subject, html, text, dedupe_key
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (tenant_id, dedupe_key) DO NOTHING
     RETURNING id`,
    [
      input.tenantId,
      input.contactId ?? null,
      input.templateKey,
      input.to,
      input.subject,
      input.html,
      input.text ?? null,
      input.dedupeKey,
    ],
  );
  return { id: row?.id ?? null, queued: row !== null };
}

/** Send up to `limit` queued messages. Returns how many went out. */
export async function flushEmailQueue(limit = 50, runner: Queryable = db()): Promise<number> {
  const { rows } = await runner.query<{
    id: string;
    tenant_id: string;
    to_email: string;
    subject: string;
    html: string;
    text: string | null;
  }>(
    // RETURNING does not inherit the subselect's ORDER BY, so the final SELECT
    // is what actually sends a batch in the order it was queued.
    `WITH claimed AS (
       SELECT id FROM email_messages
        WHERE status = 'queued' AND attempts < 5
        ORDER BY created_at
        LIMIT $1
        FOR UPDATE SKIP LOCKED
     ), bumped AS (
       UPDATE email_messages SET attempts = attempts + 1
        WHERE id IN (SELECT id FROM claimed)
        RETURNING id, tenant_id, to_email, subject, html, text, created_at
     )
     SELECT id, tenant_id, to_email, subject, html, text FROM bumped ORDER BY created_at`,
    [limit],
  );

  const sender = emailTransport();
  let sent = 0;

  for (const message of rows) {
    try {
      const { providerId } = await sender.send({
        to: message.to_email,
        subject: message.subject,
        html: message.html,
        text: message.text,
      });
      await runner.query(
        `UPDATE email_messages SET status = 'sent', sent_at = now(), provider_id = $2, error = NULL
          WHERE id = $1`,
        [message.id, providerId],
      );
      sent += 1;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      // Give up after 5 tries rather than retrying a hard bounce forever.
      await runner.query(
        `UPDATE email_messages
            SET status = CASE WHEN attempts >= 5 THEN 'failed' ELSE 'queued' END,
                error = $2
          WHERE id = $1`,
        [message.id, reason.slice(0, 500)],
      );
    }
  }

  return sent;
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
  const subject = interpolate(template.subject, vars);
  const html = interpolate(template.html, vars);
  const text = template.text ? interpolate(template.text, vars) : stripHtml(html);
  return { subject, html, text };
}

function interpolate(input: string, vars: Record<string, unknown>): string {
  return input.replace(PLACEHOLDER, (_match, key: string) => {
    const value = key.split('.').reduce<unknown>((acc, part) => {
      if (acc && typeof acc === 'object' && part in (acc as Record<string, unknown>)) {
        return (acc as Record<string, unknown>)[part];
      }
      return undefined;
    }, vars);
    // Everything interpolated lands in HTML, so escape unconditionally.
    return value === undefined || value === null ? '' : escapeHtml(String(value));
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
    'SELECT subject, html, text, transactional FROM email_templates WHERE tenant_id = $1 AND key = $2',
    [tenantId, key],
  );
  if (row) return row;
  const fallback = DEFAULT_TEMPLATES[key];
  if (!fallback) return null;
  return { ...fallback, transactional: fallback.transactional ?? false };
}

export interface EmailTemplate {
  subject: string;
  html: string;
  text: string | null;
  /** True means consent is not required; see `upsertTemplate`. */
  transactional: boolean;
}

export async function upsertTemplate(
  tenantId: string,
  key: string,
  template: {
    subject: string;
    html: string;
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
  },
  runner: Queryable = db(),
): Promise<void> {
  await runner.query(
    `INSERT INTO email_templates (tenant_id, key, subject, html, text, transactional)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (tenant_id, key) DO UPDATE SET
       subject = EXCLUDED.subject, html = EXCLUDED.html,
       text = EXCLUDED.text, transactional = EXCLUDED.transactional, updated_at = now()`,
    [tenantId, key, template.subject, template.html, template.text ?? null, template.transactional ?? false],
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

function layout(body: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:24px;background:#f5f5f7;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1d1d1f;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;padding:32px;">
    <tr><td>
      <p style="margin:0 0 20px;font-size:14px;color:#6e6e73;">{{tenant_name}}</p>
      ${body}
      <hr style="border:none;border-top:1px solid #e5e5ea;margin:32px 0 16px;">
      <p style="margin:0;font-size:12px;color:#8e8e93;">
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

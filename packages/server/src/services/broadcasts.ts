import { db, queryOne, withTransaction, type Queryable } from '../db/pool.js';
import { unsubscribeRequestUrl } from './newsletter.js';
import { mayReceive, preferencesUrl } from './preferences.js';
import { config } from '../config.js';
import { ApiError } from '../lib/errors.js';
import { limitOf } from '../lib/paging.js';
import { getTemplate, queueEmail, renderTemplate, senderFor } from './email.js';
import { shouldTrack } from './email-tracking.js';
import { assertGamificationKey } from './gamification.js';
import { getSegment, segmentAudience } from './segments.js';
import { getTenantById, type Tenant } from './tenants.js';

/**
 * Sending one message to a whole segment.
 *
 * Three things this is careful about, because each is a way to mail the wrong
 * people at scale:
 *
 *  - **Resumability.** A send walks the audience in contact-id order with a
 *    cursor on the row. A worker that dies mid-send resumes from where it
 *    stopped rather than starting again, because starting again means sending
 *    twice to everyone before the crash.
 *  - **Per-recipient idempotency.** Every message carries the dedupe key
 *    `broadcast:<id>:<contact>`, so even a resume that overlaps cannot produce
 *    a second copy — the queue's unique index refuses it.
 *  - **Frequency capping.** A contact who has already had their limit of
 *    marketing this week is skipped with a reason, not silently dropped.
 */

export type BroadcastStatus =
  | 'draft' | 'scheduled' | 'sending' | 'sent' | 'cancelled' | 'failed';

export interface Broadcast {
  id: string;
  tenant_id: string;
  key: string;
  name: string;
  segment_id: string | null;
  template_key: string;
  subject: string | null;
  status: BroadcastStatus;
  send_at: Date | null;
  started_at: Date | null;
  finished_at: Date | null;
  audience_size: number;
  queued_count: number;
  skipped_count: number;
  cursor_contact: string | null;
  error: string | null;
  created_at: Date;
  updated_at: Date;
  /** Which topic this belongs to, so a recipient's choice can be honoured. */
  topic_key: string | null;
}

export async function upsertBroadcast(
  tenantId: string,
  input: {
    key: string;
    name?: string;
    segmentKey?: string;
    templateKey?: string;
    subject?: string | null;
    sendAt?: string | null;
  },
  runner: Queryable = db(),
): Promise<Broadcast> {
  const key = assertGamificationKey(input.key, 'broadcast key');

  const existing = await getBroadcast(tenantId, key, runner);
  if (existing && existing.status !== 'draft' && existing.status !== 'scheduled') {
    // A sent broadcast is a record of what went out. Editing one would make
    // its own recipient list a lie.
    throw ApiError.conflict(`Broadcast "${key}" is ${existing.status} and can no longer be edited`);
  }

  let segmentId: string | null = existing?.segment_id ?? null;
  if (input.segmentKey) {
    const segment = await getSegment(tenantId, input.segmentKey, runner);
    if (!segment) throw ApiError.notFound(`No segment "${input.segmentKey}"`);
    segmentId = segment.id;
  }

  const templateKey = input.templateKey ?? existing?.template_key;
  if (!templateKey) throw ApiError.badRequest('A broadcast needs a templateKey');
  if (!(await getTemplate(tenantId, templateKey, runner))) {
    throw ApiError.notFound(`No email template "${templateKey}"`);
  }

  const row = await queryOne<Broadcast>(
    runner,
    `INSERT INTO broadcasts (tenant_id, key, name, segment_id, template_key, subject, send_at, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, CASE WHEN $7::timestamptz IS NULL THEN 'draft' ELSE 'scheduled' END)
     ON CONFLICT (tenant_id, key) DO UPDATE SET
       name = COALESCE(EXCLUDED.name, broadcasts.name),
       segment_id = COALESCE(EXCLUDED.segment_id, broadcasts.segment_id),
       template_key = COALESCE(EXCLUDED.template_key, broadcasts.template_key),
       subject = EXCLUDED.subject,
       send_at = EXCLUDED.send_at,
       status = CASE WHEN EXCLUDED.send_at IS NULL THEN 'draft' ELSE 'scheduled' END,
       updated_at = now()
     RETURNING *`,
    [
      tenantId,
      key,
      input.name ?? existing?.name ?? key,
      segmentId,
      templateKey,
      input.subject ?? null,
      input.sendAt ?? null,
    ],
  );
  return row!;
}

export async function getBroadcast(
  tenantId: string,
  key: string,
  runner: Queryable = db(),
): Promise<Broadcast | null> {
  return queryOne<Broadcast>(
    runner,
    'SELECT * FROM broadcasts WHERE tenant_id = $1 AND key = $2',
    [tenantId, key],
  );
}

export async function listBroadcasts(
  tenantId: string,
  runner: Queryable = db(),
): Promise<Broadcast[]> {
  const { rows } = await runner.query<Broadcast>(
    'SELECT * FROM broadcasts WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 200',
    [tenantId],
  );
  return rows;
}

/**
 * Stop a broadcast.
 *
 * Messages already written to the queue still go out: they have been accepted
 * for delivery and pulling them back would leave the recipient list claiming
 * sends that never happened. Cancelling stops the *walk*.
 */
export async function cancelBroadcast(
  tenantId: string,
  key: string,
  runner: Queryable = db(),
): Promise<Broadcast> {
  const row = await queryOne<Broadcast>(
    runner,
    `UPDATE broadcasts SET status = 'cancelled', finished_at = now(), updated_at = now()
      WHERE tenant_id = $1 AND key = $2 AND status IN ('draft', 'scheduled', 'sending')
      RETURNING *`,
    [tenantId, key],
  );
  if (!row) throw ApiError.conflict('That broadcast cannot be cancelled');
  return row;
}

/** Marketing sends per contact allowed in a rolling window. */
interface FrequencyRule {
  perDay: number | null;
  perWeek: number | null;
}

function frequencyRuleFor(tenant: Tenant): FrequencyRule {
  const positive = (value: unknown): number | null => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
  };
  return {
    perDay: positive(tenant.settings?.maxMarketingPerDay),
    perWeek: positive(tenant.settings?.maxMarketingPerWeek),
  };
}

/**
 * Has this contact had enough marketing for now?
 *
 * Counts messages this contact was *sent*, not queued: a message stuck in the
 * queue has not reached anyone, and counting it would let a backlog silently
 * suppress a campaign.
 */
async function overFrequencyCap(
  runner: Queryable,
  tenantId: string,
  contactId: string,
  rule: FrequencyRule,
): Promise<string | null> {
  for (const [window, cap, label] of [
    ['1 day', rule.perDay, 'day'],
    ['7 days', rule.perWeek, 'week'],
  ] as const) {
    if (cap === null) continue;
    const row = await queryOne<{ n: string }>(
      runner,
      `SELECT COUNT(*) AS n FROM email_messages
        WHERE tenant_id = $1 AND contact_id = $2 AND status = 'sent'
          AND unsubscribe_url IS NOT NULL
          AND sent_at >= now() - $3::interval`,
      [tenantId, contactId, window],
    );
    if (Number(row?.n ?? 0) >= cap) return `frequency_cap_${label}`;
  }
  return null;
}

export interface SendResult {
  key: string;
  status: BroadcastStatus;
  queued: number;
  skipped: number;
  done: boolean;
}

/**
 * Send one batch of a broadcast.
 *
 * Returns `done: false` while there is more audience to walk, so the worker
 * can call it again. Batching rather than one long transaction keeps a
 * hundred-thousand-recipient send from holding a connection for an hour, and
 * makes the cursor meaningful.
 */
export async function sendBroadcastBatch(
  tenantId: string,
  key: string,
  batchSize = 200,
  runner: Queryable = db(),
): Promise<SendResult> {
  const tenant = await getTenantById(tenantId);
  if (!tenant) throw ApiError.notFound('Unknown tenant');

  // Claim the broadcast so two workers cannot walk the same audience at once.
  const broadcast = await withTransaction(async (client) => {
    const row = await queryOne<Broadcast>(
      client,
      `SELECT * FROM broadcasts
        WHERE tenant_id = $1 AND key = $2 AND status IN ('scheduled', 'sending')
        FOR UPDATE`,
      [tenantId, key],
    );
    if (!row) return null;

    if (row.status === 'scheduled') {
      await client.query(
        `UPDATE broadcasts SET status = 'sending', started_at = now(), updated_at = now()
          WHERE id = $1`,
        [row.id],
      );
    }
    return row;
  });

  if (!broadcast) throw ApiError.conflict('That broadcast is not ready to send');
  if (!broadcast.segment_id) throw ApiError.badRequest('That broadcast has no segment');

  const segment = await queryOne<{ key: string }>(
    runner,
    'SELECT key FROM segments WHERE id = $1',
    [broadcast.segment_id],
  );
  if (!segment) throw ApiError.badRequest('That broadcast points at a deleted segment');

  const template = await getTemplate(tenantId, broadcast.template_key, runner);
  if (!template) throw ApiError.notFound(`No email template "${broadcast.template_key}"`);

  const audience = await audienceAfter(
    runner,
    broadcast.segment_id,
    broadcast.cursor_contact,
    batchSize,
  );

  if (audience.length === 0) {
    await runner.query(
      `UPDATE broadcasts SET status = 'sent', finished_at = now(), updated_at = now()
        WHERE id = $1`,
      [broadcast.id],
    );
    return {
      key,
      status: 'sent',
      queued: broadcast.queued_count,
      skipped: broadcast.skipped_count,
      done: true,
    };
  }

  const rule = frequencyRuleFor(tenant);
  const base = config().publicUrl;
  let queued = 0;
  let skipped = 0;
  let cursor = broadcast.cursor_contact;

  for (const contact of audience) {
    cursor = contact.id;

    const capped = await overFrequencyCap(runner, tenantId, contact.id, rule);
    if (capped) {
      await recordRecipient(runner, broadcast.id, contact.id, null, 'skipped', capped);
      skipped += 1;
      continue;
    }

    // Checked here, not when the audience was built. A large send runs over
    // minutes or hours, and somebody who pauses partway through should not
    // receive the rest of it.
    const wanted = await mayReceive(tenantId, contact.id, broadcast.topic_key ?? null, runner);
    if (!wanted.allowed) {
      await recordRecipient(runner, broadcast.id, contact.id, null, 'skipped', wanted.reason);
      skipped += 1;
      continue;
    }

    const unsubscribeUrl = unsubscribeRequestUrl(tenantId, contact.email);
    const preferenceUrl = preferencesUrl(tenantId, contact.email);

    const rendered = renderTemplate(
      broadcast.subject ? { ...template, subject: broadcast.subject } : template,
      {
        tenant_name: tenant.name,
        name: contact.name ?? '',
        email: contact.email,
        rewards_url: (tenant.settings?.siteUrl as string) ?? base,
        unsubscribe_url: unsubscribeUrl,
        preferences_url: preferenceUrl,
      },
    );

    const result = await queueEmail(
      {
        tenantId,
        contactId: contact.id,
        templateKey: broadcast.template_key,
        to: contact.email,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        // Per recipient, so a resumed send cannot write a second copy even if
        // the batch overlaps what the previous pass already did.
        dedupeKey: `broadcast:${broadcast.id}:${contact.id}`,
        track: shouldTrack(tenant),
        unsubscribeUrl,
        ...senderFor(tenant),
      },
      runner,
    );

    await recordRecipient(
      runner,
      broadcast.id,
      contact.id,
      result.id,
      result.queued ? 'queued' : 'skipped',
      result.queued ? null : 'already_queued',
    );
    if (result.queued) queued += 1;
    else skipped += 1;
  }

  await runner.query(
    `UPDATE broadcasts
        SET cursor_contact = $2,
            queued_count = queued_count + $3,
            skipped_count = skipped_count + $4,
            updated_at = now()
      WHERE id = $1`,
    [broadcast.id, cursor, queued, skipped],
  );

  return {
    key,
    status: 'sending',
    queued: broadcast.queued_count + queued,
    skipped: broadcast.skipped_count + skipped,
    done: audience.length < batchSize,
  };
}

async function audienceAfter(
  runner: Queryable,
  segmentId: string,
  after: string | null,
  limit: number,
): Promise<Array<{ id: string; email: string; name: string | null }>> {
  const { rows } = await runner.query<{ id: string; email: string; name: string | null }>(
    `SELECT c.id, c.email, c.name
       FROM segment_members m
       JOIN contacts c ON c.id = m.contact_id
      WHERE m.segment_id = $1
        AND ($2::uuid IS NULL OR c.id > $2)
        AND c.email IS NOT NULL
        AND c.marketing_consent
        AND NOT EXISTS (
          SELECT 1 FROM email_suppressions s
           WHERE s.tenant_id = c.tenant_id
             AND s.email = lower(coalesce(c.email_normalised, c.email))
             AND (s.expires_at IS NULL OR s.expires_at > now())
        )
      ORDER BY c.id
      LIMIT ${limitOf(limit, 200, 2000)}`,
    [segmentId, after],
  );
  return rows;
}

async function recordRecipient(
  runner: Queryable,
  broadcastId: string,
  contactId: string,
  messageId: string | null,
  status: 'queued' | 'skipped',
  reason: string | null,
): Promise<void> {
  await runner.query(
    `INSERT INTO broadcast_recipients (broadcast_id, contact_id, message_id, status, skip_reason)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (broadcast_id, contact_id) DO NOTHING`,
    [broadcastId, contactId, messageId, status, reason],
  );
}

/** Freeze the audience and start a scheduled broadcast now. */
export async function startBroadcast(
  tenantId: string,
  key: string,
  runner: Queryable = db(),
): Promise<Broadcast> {
  const broadcast = await getBroadcast(tenantId, key, runner);
  if (!broadcast) throw ApiError.notFound(`No broadcast "${key}"`);
  if (!broadcast.segment_id) throw ApiError.badRequest('That broadcast has no segment');
  if (broadcast.status !== 'draft' && broadcast.status !== 'scheduled') {
    throw ApiError.conflict(`That broadcast is already ${broadcast.status}`);
  }

  const segment = await queryOne<{ key: string }>(
    runner,
    'SELECT key FROM segments WHERE id = $1',
    [broadcast.segment_id],
  );
  const size = segment ? (await segmentAudience(tenantId, segment.key, { limit: 10_000 }, runner)).length : 0;

  const row = await queryOne<Broadcast>(
    runner,
    `UPDATE broadcasts
        SET status = 'scheduled', send_at = COALESCE(send_at, now()),
            audience_size = $2, updated_at = now()
      WHERE id = $1
      RETURNING *`,
    [broadcast.id, size],
  );
  return row!;
}

/** Called by the worker: advance every broadcast that is due. */
export async function runDueBroadcasts(
  batchSize = 200,
  runner: Queryable = db(),
): Promise<{ advanced: number }> {
  const { rows } = await runner.query<{ tenant_id: string; key: string }>(
    `SELECT tenant_id, key FROM broadcasts
      WHERE status = 'sending'
         OR (status = 'scheduled' AND send_at IS NOT NULL AND send_at <= now())
      ORDER BY send_at
      LIMIT 10`,
  );

  let advanced = 0;
  for (const row of rows) {
    try {
      await sendBroadcastBatch(row.tenant_id, row.key, batchSize, runner);
      advanced += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await runner.query(
        `UPDATE broadcasts SET status = 'failed', error = $2, finished_at = now(), updated_at = now()
          WHERE tenant_id = $1 AND key = $3`,
        [row.tenant_id, message.slice(0, 500), row.key],
      );
    }
  }
  return { advanced };
}

/** Who a broadcast reached, and why anyone was skipped. */
export async function broadcastReport(
  tenantId: string,
  key: string,
  runner: Queryable = db(),
): Promise<{
  broadcast: Broadcast;
  queued: number;
  sent: number;
  opened: number;
  clicked: number;
  skips: Array<{ reason: string; count: number }>;
}> {
  const broadcast = await getBroadcast(tenantId, key, runner);
  if (!broadcast) throw ApiError.notFound(`No broadcast "${key}"`);

  const totals = await queryOne<{ queued: string; sent: string; opened: string; clicked: string }>(
    runner,
    `SELECT COUNT(*) FILTER (WHERE r.status = 'queued')::text AS queued,
            COUNT(*) FILTER (WHERE m.status = 'sent')::text AS sent,
            COUNT(*) FILTER (WHERE m.opened_at IS NOT NULL)::text AS opened,
            COUNT(*) FILTER (WHERE m.first_clicked_at IS NOT NULL)::text AS clicked
       FROM broadcast_recipients r
       LEFT JOIN email_messages m ON m.id = r.message_id
      WHERE r.broadcast_id = $1`,
    [broadcast.id],
  );

  const { rows: skips } = await runner.query<{ reason: string; count: string }>(
    `SELECT COALESCE(skip_reason, 'unknown') AS reason, COUNT(*)::text AS count
       FROM broadcast_recipients
      WHERE broadcast_id = $1 AND status = 'skipped'
      GROUP BY 1 ORDER BY 2 DESC`,
    [broadcast.id],
  );

  return {
    broadcast,
    queued: Number(totals?.queued ?? 0),
    sent: Number(totals?.sent ?? 0),
    opened: Number(totals?.opened ?? 0),
    clicked: Number(totals?.clicked ?? 0),
    skips: skips.map((row) => ({ reason: row.reason, count: Number(row.count) })),
  };
}

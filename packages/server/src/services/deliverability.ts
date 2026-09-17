import { db, queryOne, type Queryable } from '../db/pool.js';

/**
 * Bounces, complaints and suppression.
 *
 * The rule this file exists to enforce: **a mailbox that told us to stop is
 * never mailed again**, whatever a list row or a consent flag says. That is
 * both the law in most of the places this ships and the only way to keep a
 * sending domain's reputation intact — a few hundred hard bounces is enough
 * for a provider to start filing everything from that domain as spam.
 *
 * Suppression is keyed on the address, not the contact. A dead mailbox is a
 * fact about the mailbox, and it must survive the contact being deleted,
 * re-imported, or existing twice under different external references.
 */

export type SuppressionReason = 'hard_bounce' | 'complaint' | 'manual' | 'repeated_failure';

export interface Suppression {
  id: string;
  tenant_id: string;
  email: string;
  reason: SuppressionReason;
  detail: string;
  expires_at: Date | null;
  created_at: Date;
}

/**
 * SMTP replies that mean "this address will never work".
 *
 * Deliberately conservative: a false hard bounce silently stops mailing a real
 * customer forever, which is far worse than retrying a dead address four more
 * times. Anything not matched here is treated as soft and retried.
 */
const HARD_BOUNCE = new RegExp(
  [
    '\\b5\\.1\\.[123]\\b', // bad destination mailbox / system
    '\\b550\\b.*\\b(?:no such user|user unknown|unknown user|does not exist|no mailbox)',
    '\\b(?:551|553)\\b.*\\b(?:not local|relay|invalid)',
    'mailbox (?:not found|unavailable|does not exist)',
    'recipient (?:address )?rejected',
    'address (?:does not exist|not found)',
    'invalid recipient',
  ].join('|'),
  'i',
);

/**
 * Rejections that are about the message or the sender, not the mailbox.
 *
 * These used to be read as complaints, which permanently suppressed the
 * address *and* withdrew that person's marketing consent. But Gmail's standard
 * block is `550-5.7.1 … likely unsolicited mail … blocked`, and a content
 * filter says `rejected as spam`: both are the receiver refusing *our*
 * message, not a recipient reporting us. An hour of that took every recipient
 * in the batch off the list permanently — which is worse than the bounce
 * storm the classifier was written to prevent.
 *
 * A real complaint is a feedback-loop report, which arrives out of band —
 * `POST /v1/email/suppressions` with `reason: complaint` is how a provider's
 * FBL handler or an operator records one. Nothing in an SMTP reply is one.
 */
const CONTENT_BLOCK = /\b(?:spam|abuse|complaint|unsolicited|blocked|blacklist|denylist|reputation|policy)\b/i;

/**
 * Failures that are about *us*, not the recipient.
 *
 * A relay that is unreachable, a TLS handshake that fails, an authentication
 * error — none of these say anything about whether a mailbox exists, so they
 * must never count toward suppressing one. Without this, a seventy-five second
 * outage retried five times permanently suppressed every recipient queued at
 * the time, which is the opposite of what a retry limit is for.
 */
const TRANSPORT_FAILURE = new RegExp(
  [
    'ECONN(?:REFUSED|RESET|ABORTED)',
    'ETIMEDOUT|ESOCKET|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|EAI_AGAIN|EPIPE',
    'socket close|connection (?:closed|timeout|refused)',
    // nodemailer raises its own timeouts as bare `Error('Timeout')` and
    // `Error('Greeting never received')`, with the detail only in `err.code`.
    // Matched on the message alone these read as soft bounces, so a relay that
    // accepted the connection and went quiet spent the attempt budget and
    // suppressed the address for thirty days -- for a fault at our end.
    '^timeout$|\\btimed out\\b|greeting (?:never received|timeout)',
    // Transient SMTP -- but not when the text says the mailbox is full or
    // over quota. Those are 4xx by the letter of the spec and permanent in
    // practice: an abandoned mailbox stays over quota, and treating it as our
    // problem meant it was retried every minute and never written off.
    '(?!.*(?:over ?quota|quota exceeded|mailbox (?:is )?full|insufficient (?:system )?storage))'
      + '^(?:.*\\b(?:421|450|451|452)\\b.*)$',
    '\\b535\\b|authentication (?:failed|required)|invalid login',
    // Word boundaries, because these are matched against a reply that quotes
    // the recipient. `SSL` unanchored matched Kessler, Hassler, Gessler and
    // Ressler, so a real "User unknown" bounce for anyone with one of those
    // surnames was read as our TLS failing: never suppressed, attempts handed
    // back, retried once a minute forever against a mailbox that does not
    // exist -- a queue that never drains and a steady stream of bounces
    // against the sending domain.
    '\\bcertificate\\b|\\bself.?signed\\b|\\bTLS\\b|\\bSSL\\b|\\bSTARTTLS\\b',
    'greylist|try again|too many connections|rate limit',
  ].join('|'),
  'i',
);

export type FailureKind = 'hard' | 'soft' | 'complaint' | 'transport';

export function classifyFailure(message: string): FailureKind {
  // Checked first: a relay that rejects everything with "spam" in the text is
  // a transport problem, not four thousand people complaining.
  if (TRANSPORT_FAILURE.test(message)) return 'transport';

  // A content or reputation block is about this message, or about our sending
  // domain. Soft, so it is retried and lapses, and — this is the part that
  // matters — it never withdraws anybody's consent. Checked before the
  // hard-bounce patterns because a block often quotes "recipient rejected"
  // alongside the real reason.
  if (CONTENT_BLOCK.test(message)) return 'soft';

  return HARD_BOUNCE.test(message) ? 'hard' : 'soft';
}

export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * How long a suppression lasts.
 *
 * A hard bounce and a complaint are permanent: the mailbox does not exist, or
 * the person said stop. A run of soft failures is a guess — the relay may have
 * been down — so it lapses, and the address is tried again rather than being
 * written off forever on the strength of one bad afternoon.
 */
const SUPPRESSION_DAYS: Partial<Record<SuppressionReason, number>> = {
  repeated_failure: 30,
};

export async function suppress(
  tenantId: string,
  email: string,
  reason: SuppressionReason,
  detail = '',
  runner: Queryable = db(),
): Promise<Suppression> {
  const address = normaliseEmail(email);
  const days = SUPPRESSION_DAYS[reason] ?? null;

  const row = await queryOne<Suppression>(
    runner,
    `INSERT INTO email_suppressions (tenant_id, email, reason, detail, expires_at)
     VALUES ($1, $2, $3, $4,
             CASE WHEN $5::int IS NULL THEN NULL
                  ELSE now() + ($5 || ' days')::interval END)
     ON CONFLICT (tenant_id, email) DO UPDATE SET
       -- A complaint outranks a bounce: it is a statement of intent, not a
       -- delivery fact, so it must not be downgraded by a later soft failure.
       reason = CASE WHEN email_suppressions.reason = 'complaint'
                     THEN email_suppressions.reason ELSE EXCLUDED.reason END,
       detail = EXCLUDED.detail,
       -- A permanent reason overrides a lapsing one, never the other way
       -- round: a hard bounce after a soft run is still a hard bounce.
       expires_at = CASE
         WHEN email_suppressions.expires_at IS NULL THEN NULL
         ELSE EXCLUDED.expires_at
       END
     RETURNING *`,
    [tenantId, address, reason, detail.slice(0, 500), days],
  );

  // Mirror onto the subscription and the consent flag so every other sender
  // in the system sees it without having to know this table exists.
  await runner.query(
    `UPDATE subscriptions s
        SET status = $3, unsubscribed_at = COALESCE(s.unsubscribed_at, now())
       FROM contacts c
      WHERE s.contact_id = c.id AND s.tenant_id = $1
        AND c.email_normalised = $2
        -- 'unsubscribed' is what the person chose; a delivery fact must not
        -- overwrite it and turn their decision into a bounce in the stats.
        AND s.status NOT IN ('bounced', 'complained', 'unsubscribed')`,
    [tenantId, address, reason === 'complaint' ? 'complained' : 'bounced'],
  );

  if (reason === 'complaint') {
    // A complaint is a withdrawal of consent in the plainest possible terms.
    await runner.query(
      `UPDATE contacts SET marketing_consent = false, updated_at = now()
        WHERE tenant_id = $1 AND email_normalised = $2 AND marketing_consent`,
      [tenantId, address],
    );
  }

  return row!;
}

export async function unsuppress(
  tenantId: string,
  email: string,
  runner: Queryable = db(),
): Promise<boolean> {
  const { rowCount } = await runner.query(
    'DELETE FROM email_suppressions WHERE tenant_id = $1 AND email = $2',
    [tenantId, normaliseEmail(email)],
  );
  return (rowCount ?? 0) > 0;
}

export async function isSuppressed(
  tenantId: string,
  email: string,
  runner: Queryable = db(),
): Promise<Suppression | null> {
  return queryOne<Suppression>(
    runner,
    `SELECT * FROM email_suppressions
      WHERE tenant_id = $1 AND email = $2
        AND (expires_at IS NULL OR expires_at > now())`,
    [tenantId, normaliseEmail(email)],
  );
}

export async function listSuppressions(
  tenantId: string,
  limit = 200,
  runner: Queryable = db(),
): Promise<Suppression[]> {
  const { rows } = await runner.query<Suppression>(
    `SELECT * FROM email_suppressions WHERE tenant_id = $1
      ORDER BY created_at DESC LIMIT $2`,
    [tenantId, Math.min(limit, 1000)],
  );
  return rows;
}

/**
 * Handle a delivery failure reported by the transport.
 *
 * Returns the classification so the caller can decide whether to retry. A hard
 * bounce or complaint suppresses the address immediately; a soft failure only
 * does so after the message has exhausted its attempts, because a mail server
 * being down for an hour is not a reason to stop mailing someone forever.
 */
export async function recordFailure(
  tenantId: string,
  email: string,
  reason: string,
  attempts: number,
  maxAttempts: number,
  runner: Queryable = db(),
): Promise<FailureKind> {
  const type = classifyFailure(reason);

  if (type === 'hard') {
    await suppress(tenantId, email, 'hard_bounce', reason, runner);
  } else if (type === 'complaint') {
    await suppress(tenantId, email, 'complaint', reason, runner);
  } else if (type === 'soft' && attempts >= maxAttempts) {
    // Only a genuinely unexplained failure counts toward suppression. A
    // transport failure says nothing about the mailbox, so it never does,
    // however many times it repeats.
    await suppress(tenantId, email, 'repeated_failure', reason, runner);
  }

  return type;
}

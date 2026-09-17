import { db, queryOne, type Queryable } from '../db/pool.js';
import {
  FALLBACK_WORDING,
  OVERRIDING_WORDING,
  matchWording,
  statusEntry,
  verdictFor,
  type FailureSubject,
} from './bounce-table.js';

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

export type FailureKind = 'hard' | 'soft' | 'complaint' | 'transport';

/**
 * How a failure is classified.
 *
 * The decision lives in bounce-table.ts, which is the specification, and this
 * file only carries it out. Read that file first: it explains why five
 * rewrites of a precedence pile were five attempts to infer a spec nobody had
 * written, and every one of its rows cites the provider that sends that
 * wording.
 *
 * What is left here is the structural reading of the reply -- pulling the code
 * and the enhanced status out of the positions SMTP puts them in -- which is
 * the part that is mechanical rather than a judgement.
 */

/**
 * The reply code, read from where a reply code actually lives.
 *
 * Not "any three digits in the text": the first token of a reply line, which
 * means the start of the string, the start of a line in a multi-line reply, or
 * straight after the prefix nodemailer puts in front ("Message failed: 550
 * ...", "Invalid login: 535-5.7.8 ..."). The port in "127.0.0.1:587", the
 * duration in "try again in 500 seconds" and the octet in "10.5.3.2" are in
 * none of those positions, which is the entire point.
 */
const REPLY_CODE = /(?:^|[\r\n]|:[ \t]|[ \t]-[ \t])[ \t]*([2-5]\d\d)(?=[ \t-]|$)/g;

/**
 * The RFC 3463 enhanced status, if the server sent one.
 *
 * The lookarounds are what keep a dotted quad out: "10.5.3.2" offers "5.3.2",
 * but it is preceded by a dot, and "5.9.3.2" is followed by one. An enhanced
 * status is a whole token or it is not an enhanced status. The detail
 * component takes up to three digits because "4.7.500" is a real reply.
 */
const ENHANCED_STATUS = /(?<![\d.])([2-5])\.(\d{1,3})\.(\d{1,3})(?![\d.])/g;

/** Reply codes that mean the relay refused *our* credentials. */
const AUTH_CODES = new Set([530, 535, 538]);

interface Reply {
  /** 4 (persistent transient) or 5 (permanent) -- the most severe present. */
  severity: 4 | 5 | null;
  /** The RFC 3463 subject digit of an enhanced status at that severity. */
  subject: number | null;
  /** Its detail digit. */
  detail: number | null;
  /** Whether a 421 appeared in reply position. */
  closing: boolean;
  /** The first reply code in the text, which is the one this reply opens with. */
  first: number | null;
}

/**
 * One pass, no arrays.
 *
 * Collecting every code and status and then spreading them into Math.max was
 * linear in the *number of matches* as well as the length, and a reply made of
 * 10,900 repetitions of "4.7.1 " spent 10 ms here -- with a spread of 10,900
 * arguments one order of magnitude away from a stack overflow.
 */
function parseReply(said: string): Reply {
  let worst = 0;
  let closing = false;
  let first: number | null = null;
  for (const match of said.matchAll(REPLY_CODE)) {
    const code = Number(match[1]);
    if (first === null) first = code;
    if (code === 421) closing = true;
    const klass = Math.floor(code / 100);
    if (klass > worst) worst = klass;
  }

  let first4: [number, number] | null = null;
  let first5: [number, number] | null = null;
  for (const match of said.matchAll(ENHANCED_STATUS)) {
    const klass = Number(match[1]);
    if (klass > worst) worst = klass;
    // The most severe thing anybody said wins. A bounce recounts its own
    // history -- "Response: 450 4.1.1 ...", "Earlier attempt: 451 4.3.0
    // deferred" -- and a 5xx anywhere in that chain means some server refused
    // permanently, whatever came before it.
    if (klass === 4 && first4 === null) first4 = [Number(match[2]), Number(match[3])];
    if (klass === 5 && first5 === null) first5 = [Number(match[2]), Number(match[3])];
  }

  const severity = worst === 4 || worst === 5 ? (worst as 4 | 5) : null;
  const status = severity === 5 ? first5 : severity === 4 ? first4 : null;

  return {
    severity,
    subject: status ? status[0] : null,
    detail: status ? status[1] : null,
    closing,
    first,
  };
}

/**
 * The reply with quoted addresses removed, and whether there were any.
 *
 * Addresses first, brackets second. Reversed, `<them@aol.com>` was eaten as a
 * bracket blob before anything could notice it was an address -- and whether
 * the reply names a mailbox is what separates AOL's dead mailbox from a relay
 * refusing our own account, which word for word are the same reply.
 *
 * `named` is the difference, not a separate pattern. Testing the raw reply
 * with `<[^<>\s]*@[^<>\s]*>` put a fresh quadratic into the one function
 * whose entire history is about not having one: two unbounded stars around an
 * `@` with a closing bracket that never arrives, measured at 4 seconds on
 * 64 KB of `<a@a@a@...` -- 4,700 times a well-formed reply, and the remote MTA
 * chooses the text. Comparing before and after costs a string compare and
 * reuses patterns that are already linear.
 */
function readReply(message: string): { said: string; named: boolean } {
  const bounded = message.slice(0, 65_536);
  const deAddressed = bounded.replace(EMAIL_SHAPED, ' ');
  return { said: deAddressed.replace(/<[^<>\s]*>/g, ' '), named: deAddressed !== bounded };
}

/**
 * Address-shaped, not merely "has an @ in it".
 *
 * The looser `\S+@\S+` retried from every start position on a long run of
 * non-space, which was seven seconds of blocked event loop on 64 KB, and ate
 * whole JSON-stringified nodemailer errors along with their error codes. The
 * lookbehind is what keeps it linear rather than sixty-four times the length:
 * a local part can only start after a character that cannot be part of one, so
 * on a run of ordinary letters every position but the first fails in constant
 * time. The {1,64} is RFC 5321's limit on a local part.
 */
const EMAIL_SHAPED =
  /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;

/**
 * What this failure is about. Exported so the tests can pin step one and step
 * two separately, which is the whole reason they are separate.
 */
export function subjectOf(message: string): FailureSubject {
  const { said, named } = readReply(message);
  const reply = parseReply(said);

  // A reply that never reached a mailbox, or that refused us, outranks
  // everything -- including the enhanced status, because providers put both
  // those refusals and a genuinely dead Yandex mailbox on 5.7.x.
  const overriding = matchWording(OVERRIDING_WORDING, said, named);
  if (overriding) return overriding;

  // An authentication code the reply *opens* with needs no wording. Position
  // is what makes the code usable: a bare 535 anywhere in the text matched
  // "original message size: 535 KB accepted" and called a dead mailbox a
  // transport fault.
  if (reply.first !== null && AUTH_CODES.has(reply.first)) return 'credentials';

  // 421 is "service not available, closing transmission channel" -- the one
  // reply code about the connection rather than about anything in the
  // envelope. Only when it is the worst thing in the reply: "Earlier attempt:
  // 421 4.7.0 too busy" above a final "550 5.1.1 User unknown" is a dead
  // mailbox recounting its history.
  if (reply.severity === 4 && reply.closing) return 'connection';

  // The status, where it settles the question outright.
  const entry = reply.subject === null ? null : statusEntry(reply.subject, reply.detail ?? 0);
  if (entry && 'decide' in entry) return entry.decide;

  // Otherwise the wording, and then whatever the status leans toward. A 5.7.x
  // with no recognisable wording is a policy refusal about us -- which is what
  // it almost always is -- rather than an unexplained failure that the attempt
  // budget would eventually suppress somebody for.
  return matchWording(FALLBACK_WORDING, said, named) ?? entry?.fallback ?? 'unknown';
}

/**
 * The severity the reply carries: 4 transient, 5 permanent, null if it said
 * neither. Exported so the policy in docs/DELIVERABILITY.md can be asserted as
 * a policy -- "a transient reply never counts" -- rather than one reply at a
 * time.
 */
export function severityOf(message: string): 4 | 5 | null {
  return parseReply(readReply(message).said).severity;
}

export function classifyFailure(message: string): FailureKind {
  return verdictFor(subjectOf(message), severityOf(message)).kind;
}

/**
 * Is this failure evidence about the recipient's mailbox at all?
 *
 * Derived from the same verdict as the classification, not decided separately.
 * A standalone predicate was added in round seven and had drifted from the
 * classifier by round ten: it excluded reputation blocks by *wording*, so
 * Exchange Online's "550 5.7.606 Access denied, banned sending IP" -- which
 * contains none of the words it looked for -- counted, and six attempts took
 * every Outlook recipient in a broadcast off the list together for thirty
 * days. One source of truth cannot drift from itself.
 */
export function saysSomethingAboutTheMailbox(message: string): boolean {
  return verdictFor(subjectOf(message), severityOf(message)).counts;
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
  } else if (type === 'soft' && attempts >= maxAttempts && saysSomethingAboutTheMailbox(reason)) {
    // Only a genuinely unexplained failure counts toward suppression. A
    // transport failure says nothing about the mailbox, so it never does,
    // however many times it repeats -- and neither does a reputation or
    // content block, however many times *it* repeats. A block is the one
    // failure that hits every recipient in a broadcast identically, so
    // counting it would take the whole audience off the list together, for
    // thirty days, on the strength of one bad afternoon at our end. That is
    // the same disaster the permanent-suppression bug caused, only slower.
    await suppress(tenantId, email, 'repeated_failure', reason, runner);
  }

  return type;
}

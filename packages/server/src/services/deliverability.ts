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

export type FailureKind = 'hard' | 'soft' | 'complaint' | 'transport';

/**
 * Why this reads the reply instead of scanning it.
 *
 * Three rewrites of this classifier had the same shape: a pile of regexes over
 * the whole reply text, and a precedence order between them. Every adversarial
 * round found a reply where two patterns overlapped and the wrong one won.
 * "450 4.7.1 Greylisted, try again in 500 seconds" read as permanent, because
 * the text contains "500". "451 4.7.0 too many errors from 10.5.3.2" read as
 * permanent, because an IP address contains "5.3.2". A Spamhaus block read as
 * a dead mailbox, because Postfix words every rejection -- reputation,
 * content, policy -- as "<addr>: Recipient address rejected: <reason>", so the
 * hard-bounce wording is present in a reply that is not about the mailbox at
 * all. Each fix reordered the tiers, and the next reply found the new seam.
 *
 * The ordering was the bug. An SMTP reply is not free text: RFC 5321 puts a
 * three-digit code in a known position, and RFC 3463 adds an enhanced status
 * whose middle digit says what the reply is *about* -- addressing, mailbox,
 * system, routing, protocol, content, policy. That digit is the question this
 * file exists to answer, and the server has already answered it.
 *
 * So the reply is parsed: code and enhanced status read positionally, the
 * verdict taken from the subject class wherever the registry and real
 * deployments agree, and wording consulted only where they do not -- routing
 * and protocol, which Exchange overloads for unknown recipients -- and for
 * replies carrying no enhanced status at all. Guessing is confined to the
 * cases that genuinely are a guess.
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
 * component takes up to three digits because "4.7.500" is a real reply and
 * reading it as "4.7.50" would leave a stray "0" to be found elsewhere.
 */
const ENHANCED_STATUS = /(?<![\d.])([2-5])\.(\d{1,3})\.(\d{1,3})(?![\d.])/g;

interface Reply {
  /** 4 (persistent transient) or 5 (permanent) -- the most severe present. */
  severity: 4 | 5 | null;
  /** The RFC 3463 subject digit of an enhanced status at that severity. */
  subject: number | null;
  /** Its detail digit. */
  detail: number | null;
  /** Whether a 421 appeared in reply position. */
  closing: boolean;
}

/**
 * One pass, no arrays.
 *
 * Collecting every code and status and then spreading them into Math.max was
 * linear in the *number of matches* as well as the length, and a reply made of
 * 10,900 repetitions of "4.7.1 " spent 10 ms here -- with a spread of 10,900
 * arguments one order of magnitude away from a stack overflow. Nothing needs
 * the full list: the verdict is the worst class present, plus the first status
 * carrying that class.
 */
function parseReply(said: string): Reply {
  let worst = 0;
  let closing = false;
  for (const match of said.matchAll(REPLY_CODE)) {
    const code = Number(match[1]);
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
    // permanently, whatever came before it. Reading only the first code sent a
    // dead mailbox round the retry loop forever; reading only the last read a
    // quoted 4xx footnote as a deferral.
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
  };
}

/**
 * Failures where no usable reply ever arrived: sockets, TLS, our own timeouts.
 *
 * None of these can be said about a mailbox, so they must never count toward
 * suppressing one. Without this rule a seventy-five second relay outage,
 * retried five times, permanently suppressed every recipient queued at the
 * time -- the opposite of what a retry limit is for.
 */
const TRANSPORT_ERRNO =
  /\bECONN(?:REFUSED|RESET|ABORTED)\b|\bE(?:TIMEDOUT|SOCKET|HOSTUNREACH|NETUNREACH|NOTFOUND|PIPE)\b|\bEAI_AGAIN\b/;

/**
 * The same faults in words.
 *
 * nodemailer raises its own timeouts as a bare Error('Timeout') and
 * Error('Greeting never received'), with the detail only in err.code. Read as
 * wording alone those look like soft bounces, so a relay that accepted the
 * connection and went quiet spent the attempt budget and suppressed the
 * address for thirty days -- for a fault at our end.
 */
const TRANSPORT_WORDS =
  /socket close|connection (?:closed|timeout|refused)|^timeout$|\btimed out\b|greeting (?:never received|timeout)|\bcertificate\b|\bself.?signed\b|\bTLS\b|\bSSL\b|\bSTARTTLS\b|insufficient (?:system )?storage/i;

/**
 * The relay refusing *us*, not refusing the recipient.
 *
 * A 535 is a real SMTP reply and carries a permanent class, but it is a
 * statement about our credentials. Suppressing a customer because our SMTP
 * password expired is the worst failure mode this file has.
 */
const AUTH_FAILURE =
  /\bauthentication\b|invalid login|username and password not accepted|\bbad credentials\b|\b5\.7\.8\b/i;

/**
 * Rejections that are about the message or about our sending domain.
 *
 * These used to be read as complaints, which permanently suppressed the
 * address *and* withdrew that person's marketing consent. But Gmail's standard
 * block is "550-5.7.1 ... likely unsolicited mail ... blocked", and a content
 * filter says "rejected as spam": both are the receiver refusing *our*
 * message, not a recipient reporting us. An hour of that took every recipient
 * in the batch off the list permanently -- worse than the bounce storm the
 * classifier was written to prevent.
 *
 * A real complaint is a feedback-loop report, which arrives out of band --
 * POST /v1/email/suppressions with reason: complaint is how a provider's FBL
 * handler or an operator records one. Nothing in an SMTP reply is one.
 */
const CONTENT_BLOCK =
  /\b(?:spam|abuse|complaint|unsolicited|blocked|blacklist|denylist|reputation|policy)\b/i;

/**
 * "Not now" -- said in words, by a server that sent no code with it.
 *
 * Greylisting and throttling are verdicts, not faults: the receiver looked at
 * the message and asked us to come back. They belong on the backoff ladder,
 * and they must never accumulate toward writing an address off, because the
 * whole point of the reply is that the mailbox is fine.
 */
const DEFERRAL =
  /greylist|graylist|try again|too many connections|rate limit|temporarily (?:deferred|rejected|unavailable|not available)|throttl/i;

/**
 * A mailbox with no room in it.
 *
 * The one reply every other rule reads wrongly. It can carry a 4xx, so the
 * transient rules claim it as our transport and retry it forever; it can quote
 * "Recipient address rejected", so the hard-bounce rules claim it and suppress
 * the address permanently. Neither is true: the mailbox exists, its owner has
 * not gone anywhere, and they may well empty it next week.
 */
const OVER_QUOTA =
  /over ?quota|quota exceeded|mailbox (?:is )?full|user'?s mailbox is full|exceeded storage allocation/i;

/**
 * Wording that means "this address will never work".
 *
 * Only consulted where the enhanced status did not decide. Deliberately
 * conservative: a false hard bounce silently stops mailing a real customer
 * forever, which is far worse than retrying a dead address four more times.
 *
 * Every alternative is a plain literal run. The previous version paired a code
 * with its reason across ".*" -- "\b550\b.*no such user" -- which made the
 * match quadratic in the length of the reply, and the reply comes from a
 * remote MTA: 64 KB of "550 " took 1.5 seconds of blocked event loop and
 * 256 KB took 24. Splitting the code out of the wording is what makes it
 * linear, and the code is parsed now anyway.
 */
const MAILBOX_GONE = new RegExp(
  [
    'no such (?:user|recipient|mailbox|address)',
    '(?:user|recipient|mailbox|address) unknown',
    'unknown (?:user|recipient|mailbox|address)',
    'mailbox (?:not found|unavailable|does not exist|disabled)',
    '(?:address|account|user|recipient|mailbox) (?:does not exist|not found|no longer exists)',
    'invalid (?:recipient|mailbox|address)',
    'no mailbox',
    'not local',
    'not our customer',
    'user (?:is )?(?:disabled|terminated|suspended)',
    // Yahoo: "This user doesn't have a yahoo.com account".
    "does ?n.?t have an? ",
    // AOL: "This account has been disabled or discontinued".
    'account has been (?:disabled|discontinued|deactivated)',
    // Exim.
    'unroute?able address',
  ].join('|'),
  'i',
);

/**
 * Postfix's wrapper, which says nothing on its own.
 *
 * Postfix words *every* rejection as "<addr>: Recipient address rejected:
 * <reason>" -- an RBL hit, a content refusal and a genuinely unknown mailbox
 * all carry it. Treating it as evidence about the mailbox is what made a
 * Spamhaus listing suppress a whole batch; treating a reply that contains only
 * it as evidence of nothing is what lets the reason decide instead.
 */
const GENERIC_REJECT = /recipient (?:address )?rejected|address rejected/i;

/**
 * Wording that means "this address will never work".
 *
 * Only consulted where the enhanced status did not decide. Deliberately
 * conservative: a false hard bounce silently stops mailing a real customer
 * forever, which is far worse than retrying a dead address four more times.
 *
 * Every alternative is a plain literal run. An earlier version paired a code
 * with its reason across ".*" -- "\b550\b.*no such user" -- which made the
 * match quadratic in the length of the reply, and the reply comes from a
 * remote MTA: 64 KB of "550 " took 1.5 seconds of blocked event loop and
 * 256 KB took 24. Splitting the code out of the wording is what makes it
 * linear, and the code is parsed now anyway.
 */
const HARD_BOUNCE = new RegExp(`${MAILBOX_GONE.source}|${GENERIC_REJECT.source}`, 'i');

/**
 * The reply with quoted addresses taken out, and bounded.
 *
 * Every rule reads this rather than the raw text, and that uniformity is
 * itself a fix: the previous version stripped addresses for some patterns and
 * not others, so "\b535\b" matched <535@163.com> and called a dead mailbox a
 * transport fault -- which never suppresses *and* refunds the attempt, so that
 * address was retried every sixty seconds forever. The same split truncated
 * the stripped copy at 2 KB while leaving the raw fallbacks unbounded, so a
 * reply whose operative line sat past the cap was classified by one rule on
 * the head and another on the tail, and came out inverted.
 *
 * The cap is generous rather than tight because nothing below is worse than
 * linear any more. An SMTP reply line is 512 octets by RFC 5321, and a
 * multi-line reply that needs more than 8 KB to say which mailbox is missing
 * is not telling the truth.
 */
function withoutAddresses(message: string): string {
  return (
    message
      .slice(0, 65_536)
      // `[^<>\s]`, not `[^>\s]`. Without the `<` in the class the engine
      // matches a `<`, consumes the entire rest of the run looking for a `>`,
      // fails, and backtracks -- from every start position. 8 KB of `<` took
      // 135 ms of blocked event loop, and recordFailure calls this twice per
      // failed send, so a batch of fifty was 13.5 seconds inside the API
      // process. A remote MTA chooses this text, and prefixing
      // "421 4.7.0 connection closed" makes it transport, which refunds the
      // attempt and retries every sixty seconds for three days.
      //
      // Excluding `<` means the class cannot cross the opening bracket, so
      // there is nothing to backtrack and the cap can be generous again: at
      // 8 KB a reply whose operative line sat past it came out inverted, which
      // is what a verbose DSN with a hundred Received headers looks like.
      .replace(/<[^<>\s]*>/g, ' ')
      // Address-shaped, not merely "has an @ in it". "\S+@\S+" retries from
      // every start position on a long run of non-space with no "@" in it,
      // which was seven seconds of blocked event loop on 64 KB; the looser
      // version also ate whole JSON-stringified nodemailer errors, taking the
      // error code with them. The character classes here cannot overlap the
      // separator, so there is nothing to backtrack.
      // The {1,64} is RFC 5321's limit on a local part, and it is load-bearing:
      // unbounded, the local part still walks the whole slice from every start
      // position when there is no "@" to stop at, which is 8 KB squared and
      // measured at 91 ms per call. A remote MTA chooses this text.
      // The lookbehind is what keeps this linear in the length of the reply
      // rather than sixty-four times it. A local part can only *start* after a
      // character that cannot be part of one, so on a long run of ordinary
      // letters every position but the first fails in constant time. Without
      // it the engine tries 64 characters at each of 65,536 positions -- 27 ms
      // per call, twice per failed send, fifty sends to a batch.
      .replace(/(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g, ' ')
  );
}

/**
 * Is this failure evidence about the recipient's mailbox at all?
 *
 * Separate from the classification because they answer different questions.
 * `classifyFailure` decides what to do with *this* attempt; this decides
 * whether the attempt may be counted toward giving up on the address after the
 * budget runs out, which is a thirty-day suppression and therefore a much
 * higher bar.
 *
 * Only an unexplained failure clears it. A deferral says "not now", a
 * reputation block is about our domain, a mail-system status is about the
 * receiving server -- none of them is a statement about a mailbox, so none of
 * them may be stacked up into one. This matters most for the failures that hit
 * every recipient of a broadcast identically: without it, an afternoon of
 * throttling or one bad sending reputation takes the entire audience off the
 * list at the same moment.
 */
export function saysSomethingAboutTheMailbox(message: string): boolean {
  const said = withoutAddresses(message);
  const reply = parseReply(said);
  if (reply.severity === 4) return false;
  // The subjects that are about something other than the recipient's mailbox:
  // 3 is the receiving mail system, 5 is the protocol, 6 is this message's
  // content and 7 is security and policy -- which is where every reputation
  // block lands.
  //
  // Checking only the *wording* was not enough and left the gate doing almost
  // nothing. Exchange Online's standard IP-reputation refusal is
  // "550 5.7.606 Access denied, banned sending IP [...]", which contains none
  // of spam, abuse, blocked, blacklist, reputation or policy -- so it counted,
  // and six attempts took every Outlook recipient in a broadcast off the list
  // together for thirty days. Measured: 5 of 5 suppressed, expires_at +30
  // days, subscriptions.status 'bounced'. That is the disaster this predicate
  // exists to prevent, arriving through the predicate.
  if (reply.subject !== null && [3, 5, 6, 7].includes(reply.subject)) return false;
  if (CONTENT_BLOCK.test(said) || DEFERRAL.test(said)) return false;
  return true;
}

export function classifyFailure(message: string): FailureKind {
  const said = withoutAddresses(message);
  const reply = parseReply(said);

  // Nothing about a mailbox can be read out of a connection that failed, or
  // out of a relay that refused our password.
  if (TRANSPORT_ERRNO.test(said) || TRANSPORT_WORDS.test(said)) return 'transport';
  // Wording only. A bare 530/535/538 used to count too, and REPLY_CODE's
  // "after a colon and a space" position matches the way a bounce quotes
  // anything: "550 5.1.1 User unknown; original message size: 535 KB" came
  // back as an authentication failure, which is transport -- never suppressed
  // and the attempt refunded, so a dead mailbox was retried for three days.
  // Every real refusal carries wording, and one that somehow does not lands on
  // 5.7.x, which never suppresses anyway.
  if (AUTH_FAILURE.test(said)) return 'transport';

  // 421 is "service not available, closing transmission channel" -- the one
  // reply code about the connection rather than about anything in the
  // envelope, so it outranks the subject digit riding along with it. An
  // overloaded relay says "421 4.7.0", and reading that as a policy decision
  // about the recipient is how a throttled hour turned into suppressions.
  //
  // Only when 421 is the worst thing in the reply. parseReply deliberately
  // takes the most severe code anywhere in the chain, and an unconditional
  // short-circuit threw that away: "Earlier attempt: 421 4.7.0 too busy" above
  // a final "550 5.1.1 User unknown" read as transport, so a dead mailbox was
  // retried every sixty seconds and never suppressed.
  if (reply.severity === 4 && reply.closing) return 'transport';

  // The enhanced status, where the registry and real deployments agree on what
  // the subject means. Subjects 4 (routing) and 5 (protocol) are deliberately
  // absent: Exchange Online answers an unknown recipient with 5.4.1, so the
  // registry meaning and the deployed meaning disagree and the wording below
  // is the better witness.
  if (reply.subject !== null) {
    switch (reply.subject) {
      case 1: // Addressing status -- the destination address itself.
        if (reply.severity === 5 && [1, 2, 3, 6, 10].includes(reply.detail!)) return 'hard';
        // 5.1.7 and 5.1.8 are the *sender's* address: about us, not them.
        return 'soft';
      case 2: // Mailbox status.
        if (reply.severity === 5 && reply.detail === 1) return 'hard'; // disabled, not accepting
        return 'soft'; // 4.2.2 / 5.2.2 full, 5.2.3 too large -- all retryable
      case 3: // Mail system status: the receiving system, never the mailbox.
        return reply.severity === 4 ? 'transport' : 'soft';
      case 6: // Message content or media.
      case 7: // Security or policy -- every reputation block lands here.
        // Unconditional `soft` was wrong for the servers that answer an
        // unknown recipient with a policy status: Yandex's standard reply is
        // "550 5.7.1 No such user!", which came back soft, so the address was
        // never permanently suppressed and bounced on every broadcast forever.
        //
        // Only the unambiguous wording counts here. Postfix's "Recipient
        // address rejected" wraps blocks and dead mailboxes alike, so it is
        // deliberately not enough -- that wrapper is what made a Spamhaus
        // listing suppress a whole batch.
        return MAILBOX_GONE.test(said) ? 'hard' : 'soft';
      default:
        break; // 4, 5 and anything unregistered fall through to the wording.
    }
  }

  // No enhanced status, or one whose subject does not settle it. Quota first,
  // because a full mailbox quotes the hard-bounce wording verbatim; then the
  // blocks, because Postfix words a reputation rejection with it too; only
  // then the mailbox wording itself.
  if (OVER_QUOTA.test(said)) return 'soft';
  if (CONTENT_BLOCK.test(said)) return 'soft';

  // A permanent refusal outranks a transient code it merely quotes, and a
  // transient one is never evidence that an address is dead.
  if (reply.severity === 4) return 'soft';
  return HARD_BOUNCE.test(said) ? 'hard' : 'soft';
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

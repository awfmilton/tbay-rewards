import type { FailureKind } from './deliverability.js';

/**
 * What a delivery failure is *about*.
 *
 * This file is the classifier's specification, and it exists because five
 * rewrites of the classifier were five attempts to infer one. Each round of
 * adversarial review probed a handful of replies, a pattern was added or
 * reordered to satisfy them, and the next round found a reply where the new
 * ordering was wrong. The ordering was never the bug; not having written down
 * what the answer should be was.
 *
 * So the decision is made in two steps, and only the first involves judgement:
 *
 *   1. What is this reply about? -- decided by the tables below, every row of
 *      which names the provider that actually sends that wording.
 *   2. Given that, what do we do? -- decided by `verdictFor`, which is eight
 *      lines with no exceptions in it.
 *
 * Adding a provider means adding a row with its reply quoted in `source`, and
 * adding that reply to the corpus in test/support/bounce-corpus.ts. It does
 * not mean touching the precedence of anything else, because there is no
 * precedence left to touch.
 *
 * See docs/DELIVERABILITY.md for the table in prose, and for the rule about
 * which of these may ever suppress an address.
 */
export type FailureSubject =
  /** No usable reply ever arrived: sockets, TLS, our own timeouts. */
  | 'connection'
  /** The relay refused *us*: authentication, not delivery. */
  | 'credentials'
  /** Our address, our domain, our reputation. Never about a recipient. */
  | 'sender'
  /** This particular message: content, size, encoding, attachments. */
  | 'message'
  /** The recipient's mailbox, or the receiving system, is full. */
  | 'capacity'
  /** The recipient's mailbox does not exist or cannot receive. */
  | 'mailbox'
  /**
   * The destination *domain*, not the mailbox.
   *
   * Its own subject because the two need different answers and three rounds
   * argued about it without settling. Exim's "550 Unrouteable address" means
   * the domain has no MX -- permanent, as far as Exim can tell -- but a
   * recipient provider with a broken DNS record produces it for every address
   * at that domain at once. Reading it as a dead mailbox suppressed all of
   * them forever on the first attempt; reading it as an ordinary deferral let
   * a genuinely dead domain bounce on every broadcast.
   *
   * So: retried like a soft failure, and allowed to count, which ends in the
   * thirty-day lapsing suppression rather than a permanent one. Bounded,
   * recoverable, and it stops the bleeding.
   */
  | 'domain'
  /**
   * "Not now" -- a greylist, a throttle, a deferral.
   *
   * Its own subject because it must never count toward writing an address
   * off, at *any* severity. Mapped to `unknown` it inherited the attempt
   * budget, so a wording-only greylist with no reply code ended in a
   * thirty-day suppression: the whole point of the reply is that the mailbox
   * is fine.
   */
  | 'deferral'
  /** Nothing in the reply identifies what it is about. */
  | 'unknown';

export interface Verdict {
  kind: FailureKind;
  /**
   * May an exhausted attempt budget suppress this address?
   *
   * Derived from the subject rather than decided separately, which is the
   * point. A standalone gate was added in round seven and immediately drifted
   * from the classifier it was meant to shadow: it excluded reputation blocks
   * by *wording*, so Exchange Online's "550 5.7.606 Access denied, banned
   * sending IP" -- which contains none of the words it looked for -- counted,
   * and six attempts took every Outlook recipient in a broadcast off the list
   * together for thirty days. One source of truth cannot drift from itself.
   */
  counts: boolean;
}

/**
 * Step two: what to do, given what the reply is about.
 *
 * Every line here is a policy decision and none of them is a pattern match.
 *
 * - A transient reply is never a verdict about anything. It is retried and it
 *   never counts, however it is worded: a deferral quoting "mailbox
 *   unavailable" is still a deferral.
 * - Only `mailbox` is evidence that an address is dead, and only permanently.
 * - `unknown` is what the attempt budget exists for: six failures nobody can
 *   explain is the one case where giving up is the honest answer.
 * - Everything else -- our connection, our credentials, our reputation, this
 *   message -- is about us, and arrives identically for every recipient of a
 *   broadcast. Counting any of it takes a whole audience off the list at once.
 */
export function verdictFor(subject: FailureSubject, severity: 4 | 5 | null): Verdict {
  if (severity === 4) {
    // A transient refusal of our credentials is our own relay's SASL backend
    // having a moment -- Postfix answers "454 4.7.0 Temporary authentication
    // failure" while its LDAP lookup is down. Classified `soft` it consumed an
    // attempt per recipient, so a five-minute outage in our own auth backend
    // spent five of every recipient's six attempts on a fault that had nothing
    // to do with them. `transport` is retried without charging anybody.
    if (subject === 'connection' || subject === 'credentials') {
      return { kind: 'transport', counts: false };
    }
    return { kind: 'soft', counts: false };
  }
  switch (subject) {
    case 'connection':
    case 'credentials':
      return { kind: 'transport', counts: false };
    case 'mailbox':
      return { kind: 'hard', counts: true };
    case 'domain':
      return { kind: 'soft', counts: true };
    case 'capacity':
      // Permanently over quota is not a dead mailbox, but a mailbox nobody has
      // emptied across the whole seventeen-hour retry ladder is an abandoned
      // one, and abandoned full mailboxes are a top-three bounce category at
      // Gmail and Yahoo. With `counts: false` they were retried on every
      // broadcast forever: six failures, no suppression, and the next campaign
      // started the ladder again. Retried, then written off on the lapsing
      // thirty-day suppression rather than permanently -- and at 4xx, above,
      // it still never counts.
      return { kind: 'soft', counts: true };
    case 'unknown':
      return { kind: 'soft', counts: true };
    case 'sender':
    case 'message':
    case 'deferral':
      return { kind: 'soft', counts: false };
  }
}

/**
 * RFC 3463 subject codes, which is the one part of an SMTP reply that already
 * answers step one.
 *
 * Keyed `class.subject.detail`; see SUBJECT_CODES below. Two subjects are
 * deliberately refined rather than taken at their registry meaning:
 *
 * - **4, Network and Routing.** Exchange Online answers an unknown recipient
 *   with 5.4.1, and Exim uses 5.4.x for a domain it cannot route to. The
 *   registry says network; the deployments disagree with each other. Wording
 *   is the better witness.
 * - **5, Mail Delivery Protocol.** Rare, and used inconsistently.
 */
type StatusEntry =
  /** The status settles what the reply is about; wording is not consulted. */
  | { decide: FailureSubject }
  /**
   * The status narrows it but does not settle it: wording is consulted first,
   * and `fallback` is what it means if no wording matches.
   *
   * Only for the subjects where the registry and real deployments disagree.
   * 7.x is the important one: it is where every provider puts a reputation
   * block, a DKIM failure *and* -- at Yandex -- a genuinely dead mailbox
   * ("550 5.7.1 No such user!"). The status alone cannot separate those, and
   * five rewrites of this classifier were five attempts to guess which way to
   * lean. It leans reputational and lets the wording say otherwise.
   */
  | { refine: true; fallback: FailureSubject | null };

/**
 * Keyed `class.subject.detail`, because the class is part of the status.
 *
 * Dropping the class was wrong twice over, and both were found by review
 * rather than by reasoning:
 *
 * - **3.x.** RFC 3463 calls it "mail system status", which at 4xx is the
 *   receiving server having a moment -- but at 5xx it is where AT&T puts its
 *   RBL refusal: "553 5.3.0 flph844 DNSBL:RBL 521< ip >_is_blocked". Read as a
 *   connection fault, which is retried without limit and refunds the attempt,
 *   a permanent reputation block was retried every sixty seconds for three
 *   days at the provider that had just blocked us -- roughly 4,320 attempts
 *   per recipient, which is how a sending reputation is destroyed rather than
 *   repaired.
 *
 * Lookup order: exact, then `*.subject.detail`, then `class.subject.*`, then
 * `*.subject.*`. A named detail outranks a class wildcard, which is the only
 * order that works: with `class.subject.*` consulted first, `5.3.*` shadowed
 * `*.3.4` completely and "552 5.3.4 Message too big for system" -- the one
 * 3.x reply that is about the message -- was read as a reputation block.
 *
 * Rows whose only effect would be to repeat the row beneath them are not
 * here. `*.4.6` and `*.5.*` would both have restated `refine, fallback: null`,
 * and `*.3.*` was unreachable once 4.3 and 5.3 were split, since `severity`
 * is only ever 4 or 5. The rows that *look* redundant and are not are the ones
 * shadowing a `decide` catch-all: `*.1.0`, `*.1.4`, `*.1.5`, `*.1.9`, `*.2.0`
 * and `*.2.4` exist precisely to stop `*.1.*` and `*.2.*` from calling an
 * ambiguous status a dead mailbox.
 */
export const SUBJECT_CODES: Record<string, StatusEntry> = {
  // 1.x Addressing status -- the destination address itself.
  '*.1.0': { refine: true, fallback: null }, // "other address status": says nothing
  '*.1.1': { decide: 'mailbox' }, // bad destination mailbox address
  '*.1.2': { decide: 'domain' }, // bad destination *system* address
  '*.1.3': { decide: 'mailbox' }, // bad destination mailbox address syntax
  '*.1.4': { refine: true, fallback: null }, // destination mailbox ambiguous
  '*.1.5': { refine: true, fallback: null }, // address valid -- not a failure
  '*.1.6': { decide: 'mailbox' }, // mailbox has moved, no forwarding address
  '*.1.7': { decide: 'sender' }, // bad sender's mailbox address syntax
  '*.1.8': { decide: 'sender' }, // bad sender's system address
  '*.1.9': { refine: true, fallback: null },
  '*.1.10': { decide: 'mailbox' }, // recipient address has null MX
  '*.1.*': { decide: 'mailbox' },

  // 2.x Mailbox status.
  '*.2.0': { refine: true, fallback: null }, // "other or undefined mailbox status"
  // Google documents two 550 5.2.1 replies: an inactive account, and "The user
  // you are trying to contact is receiving email at a rate that prevents
  // additional messages from being delivered". The second is a live customer
  // with a busy inbox, and `decide: 'mailbox'` made it a hard bounce that
  // suppressed them permanently on the first attempt, with no wording able to
  // say otherwise. It refines now, and the deferral wording below catches the
  // rate-limited one.
  '*.2.1': { refine: true, fallback: 'mailbox' }, // disabled, or rate-limited
  '*.2.2': { decide: 'capacity' }, // mailbox full
  '*.2.3': { decide: 'message' }, // message length exceeds administrative limit
  '*.2.4': { refine: true, fallback: null }, // mailing list expansion problem
  '*.2.*': { decide: 'mailbox' },

  // 3.x Mail system status. At 4xx the receiving system is having a moment; at
  // 5xx it is a permanent refusal and often a reputation block. See above.
  '4.3.*': { decide: 'connection' },
  '*.3.4': { decide: 'message' }, // message too big for system
  '5.3.*': { refine: true, fallback: 'sender' },

  // 4.x Network and routing -- where the registry and the deployments
  // disagree, and where they disagree *with each other*, so the detail digit
  // has to be read rather than the subject.
  //
  // Exchange Online's standard unknown-recipient reply is
  // "550 5.4.1 <them@x.com>: Recipient address rejected: Access denied" --
  // a very common hard bounce whose wording ("Recipient address rejected") is
  // also Postfix's universal wrapper for reputation blocks, so it cannot be
  // recognised by wording alone without taking the blocks with it. The status
  // is what separates them: 5.7.1 is policy, 5.4.1 is Exchange saying the
  // recipient is not there.
  // 5.4.1 only. A transient 4.4.1 is Postfix reporting "Host or domain name
  // not found" while DNS is unreachable, and with this row keyed `*.4.1` it
  // fell back to `mailbox` -- harmless at 4xx, where severity forces soft, and
  // a hard bounce the moment any relay sent the same wording at 5xx.
  '5.4.1': { refine: true, fallback: 'mailbox' },
  '*.4.4': { decide: 'domain' }, // unable to route
  // 4.6 is "routing loop detected" in the registry, and Zoho sends it to the
  // *sending* client instead: "550 5.4.6 Unusual sending activity detected.
  // Please try after sometime." -- a block on our own account that lifts
  // within the hour. It had its own `decide: 'domain'` row, which no wording
  // could correct and which counts, so one hour of Zoho throttling suppressed
  // every recipient for thirty days. It now falls through to this row, which
  // says what is true: the status alone does not know.
  '*.4.*': { refine: true, fallback: null },

  // 5.x Mail delivery protocol has no row: rare, used inconsistently, and
  // there is no catch-all beneath it to shadow.

  // 6.x Message content or media.
  '*.6.*': { decide: 'message' },

  // 7.x Security or policy. See StatusEntry above for why this refines.
  '*.7.*': { refine: true, fallback: 'sender' },
};

/**
 * The most specific row for a status, or null.
 *
 * `klass` is the severity digit the reply settled on, not necessarily the one
 * printed beside this subject -- a 4xx conversation that quotes an earlier
 * 5.x is read at 5, which is what "the most severe thing anybody said wins"
 * means in practice.
 */
export function statusEntry(klass: number, subject: number, detail: number): StatusEntry | null {
  return (
    SUBJECT_CODES[`${klass}.${subject}.${detail}`] ??
    SUBJECT_CODES[`*.${subject}.${detail}`] ??
    SUBJECT_CODES[`${klass}.${subject}.*`] ??
    SUBJECT_CODES[`*.${subject}.*`] ??
    null
  );
}

export interface WordingRule {
  /** The provider, and its reply verbatim. Every row cites one. */
  source: string;
  pattern: RegExp;
  subject: FailureSubject;
  /**
   * Requires the reply to quote an address.
   *
   * For wordings that are identical whether they are about a recipient or
   * about our own sending account. AOL says "<them@aol.com>: Recipient
   * address rejected: This account has been disabled or discontinued"; a relay
   * refusing our credentials says "This account has been disabled" and quotes
   * nobody.
   */
  needsNamedAddress?: boolean;
}

/**
 * Wordings that outrank the enhanced status.
 *
 * Only two things may: a reply about our own sending, and a reply that never
 * reached an SMTP conversation at all. Both arrive identically for every
 * recipient of a broadcast, so reading either as a fact about a mailbox is the
 * single most expensive mistake this file can make -- and 5.7.x, which is
 * where providers put them, is also where they put a genuinely dead mailbox at
 * Yandex. The status alone cannot separate those.
 */
export const OVERRIDING_WORDING: readonly WordingRule[] = [
  {
    source: 'Node/undici socket errors surfaced by nodemailer',
    pattern:
      /\bECONN(?:REFUSED|RESET|ABORTED)\b|\bE(?:TIMEDOUT|SOCKET|HOSTUNREACH|NETUNREACH|NOTFOUND|PIPE)\b|\bEAI_AGAIN\b/,
    subject: 'connection',
  },
  {
    source: "nodemailer's own timeouts: Error('Timeout'), Error('Greeting never received')",
    pattern:
      /socket close|connection (?:closed|timeout|refused)|^timeout$|\btimed out\b|greeting (?:never received|timeout)/i,
    subject: 'connection',
  },
  {
    source: 'TLS negotiation failures (self-signed chains, protocol mismatch)',
    pattern: /\bcertificate\b|\bself.?signed\b|\bTLS\b|\bSSL\b|\bSTARTTLS\b/i,
    subject: 'connection',
  },
  {
    // Before the credentials rule, and the order is the point. Exchange
    // Online refuses a sender it will not attribute with
    // "550 5.7.64 TenantAttribution; ... RESOLVER.RST.AuthRequired" and
    // "SenderNotAuthenticatedForFrom" -- both of which contain the word the
    // credentials rule looks for. Read as credentials it became `transport`,
    // which is retried indefinitely and refunds the attempt, so a
    // misconfigured sending domain retried every recipient forever instead of
    // reporting a configuration fault once.
    source: 'Exchange Online "550 5.7.64 TenantAttribution; RESOLVER.RST.AuthRequired"; "SenderNotAuthenticatedForFrom"; "Client does not have permissions to send as this sender"',
    pattern:
      /RESOLVER\.RST|SenderNotAuthenticatedFor|(?:does not|doesn.?t) have permissions? to send as|TenantAttribution/i,
    subject: 'sender',
  },
  {
    source: 'Gmail "535-5.7.8 Username and Password not accepted"; SES "535 Authentication Credentials Invalid"; Outlook "535 5.7.3 Authentication unsuccessful"',
    pattern:
      /authentication (?:fail(?:ed|ure)|required|unsuccessful|not enabled|temporarily)|authentication credentials|\b(?:invalid|bad|rejected) credentials\b|\bcredentials (?:invalid|rejected|incorrect)\b|invalid login|username and password not accepted|(?<![\d.])5\.7\.8(?![\d.])/i,
    subject: 'credentials',
  },
  {
    // "your message" was here and had to go. Gmail's standard hard bounce
    // opens "Your message wasn't delivered to <them@x.com> because the address
    // couldn't be found" -- so the single most common dead mailbox on the
    // internet was read as a fact about our own sending, which never counts,
    // and no Gmail address could ever be suppressed. "your account" and
    // "your domain" stay: those are about us.
    source: 'Postfix "<no-reply@ourshop>: Sender address rejected: ..."; Gmail 5.7.26 unauthenticated sender; any SPF/DKIM/DMARC refusal',
    pattern:
      /sender (?:address |verify )?(?:rejected|failed|denied|not allowed)|\bfrom address\b|\bspf\b|\bdkim\b|\bdmarc\b|sending (?:domain|account|ip)|your (?:account|domain)|does ?n.?t have a valid|unauthenticated/i,
    subject: 'sender',
  },
];

/**
 * Wordings consulted when the enhanced status did not settle it -- because it
 * was absent, or because its subject is one of the two the registry and real
 * deployments disagree about.
 *
 * Ordered, and the order is the specification: capacity before mailbox because
 * a full mailbox quotes "Recipient address rejected"; reputation before
 * mailbox because Postfix wraps *every* rejection in that same phrase.
 */
export const FALLBACK_WORDING: readonly WordingRule[] = [
  {
    source: 'Postfix/Exim over-quota: "Recipient address rejected: User\'s mailbox is full"; qmail "552 ... exceeded storage allocation"',
    pattern:
      /over ?quota|quota exceeded|mailbox (?:is )?full|user'?s mailbox is full|exceeded storage allocation|insufficient (?:system )?storage/i,
    subject: 'capacity',
  },
  {
    // Every wording here is a block on *us*, and the list is long because
    // each entry is a provider that says it without using any of the words
    // the first alternation looks for. Missing one is not a cosmetic
    // misclassification: an unexplained 5xx becomes `unknown`, which counts,
    // so six broadcasts suppressed the entire audience at that provider.
    source: 'Gmail 5.7.1 unsolicited mail; Spamhaus/Barracuda RBL refusals; SpamAssassin scores; Exchange 5.7.606 banned sending IP; AT&T "DNSBL:RBL"; SES "Email address is not verified"; SendGrid "Maximum credits exceeded"/"sending paused"; Exchange Online "A problem occurred"',
    pattern:
      /\b(?:spam|abuse|complaint|unsolicited|blocked|blacklist|denylist|reputation|policy)\b|\bDNSBL\b|\bRBL\b|block ?list|(?:not|un)[ -]?ver(?:ified|ifiable)|credits exceeded|sending (?:paused|quota|limit|activity)|unusual (?:sending|activity)|(?:relay )?not permitted(?: to relay)?|relay (?:access )?denied|a problem occurred|listed (?:in|by|at)|bad reputation|too many (?:messages|recipients)|refused to talk to me/i,
    subject: 'sender',
  },
  {
    // "receiving email at a rate that prevents additional messages from being
    // delivered" is Google's own wording for a live customer with a busy
    // inbox, and it arrives at 550 5.2.1 -- the same status as an account
    // that has been shut off. Without this the status' fallback took over and
    // a working mailbox was hard-bounced and suppressed on the first attempt.
    source: 'Greylisting (Postgrey, Exim greylist); every throttle wording; Gmail "550 5.2.1 The user you are trying to contact is receiving email at a rate that prevents additional messages from being delivered"',
    pattern:
      /greylist|graylist|try again|try (?:later|after)|too many connections|rate limit|at a rate that|receiving (?:e-?mail|messages) at a rate|temporarily (?:deferred|rejected|unavailable|not available)|throttl|deferred due to|come back later/i,
    subject: 'deferral',
  },
  {
    source: 'Gmail "550 5.1.1 The email account that you tried to reach does not exist"; Postfix "User unknown in virtual mailbox table"; Yandex "550 5.7.1 No such user!"; QQ/163 "User not found"',
    pattern:
      /no such (?:user|recipient|mailbox|address)|(?:user|recipient|mailbox|address) unknown|unknown (?:user|recipient|mailbox|address)|mailbox (?:is )?(?:not found|unavailable|does not exist|disabled|inactive)|(?:user|recipient|mailbox|address) (?:does not exist|not found|no longer exists)|invalid (?:recipient|mailbox|address)|no mailbox|RESOLVER\.ADR\.Recip\w*NotFound|RecipNotFound|user (?:is )?(?:disabled|terminated|suspended)|not our customer/i,
    subject: 'mailbox',
  },
  {
    source: 'AOL "<them@aol.com>: Recipient address rejected: This account has been disabled or discontinued"; Yahoo "554 delivery error: dd This user doesn\'t have a yahoo.com account"; Yahoo "554 30 Sorry, your message to <x> cannot be delivered. This mailbox is disabled"',
    pattern:
      /account has been (?:disabled|discontinued|deactivated|closed)|does ?n.?t have an? [\w.-]{0,40} ?account|not a valid (?:user|recipient)|delivery error: dd/i,
    subject: 'mailbox',
    needsNamedAddress: true,
  },
  {
    source: 'Exim "550 Unrouteable address"; qmail "553 sorry, that address is not local"; Postfix "450 4.4.1 Host or domain name not found. Name service error for name=..."',
    // "Relay access denied" is deliberately absent. Postfix sends it at 5.7.1
    // -- policy -- when it will not relay for a domain it does not host,
    // which is a fact about where we sent the message rather than about the
    // domain being gone.
    pattern:
      /unroute?able address|\bnot local\b|host or domain name not found|name service error|\bdns (?:query |lookup )?(?:fail|error|timed out)|no route to host|domain (?:not found|does not exist|has no mx)|mx lookup failed/i,
    subject: 'domain',
  },
  {
    source: 'Exchange/Postfix content refusals: "Message rejected due to content restrictions", "message contains bare line feeds"',
    pattern:
      /content (?:restrictions|rejected|filtering)|bare line feeds|message (?:too large|size exceeds)|attachment/i,
    subject: 'message',
  },
];

/** The first rule that matches, or null. */
export function matchWording(
  rules: readonly WordingRule[],
  said: string,
  named: boolean,
): FailureSubject | null {
  for (const rule of rules) {
    if (rule.needsNamedAddress && !named) continue;
    if (rule.pattern.test(said)) return rule.subject;
  }
  return null;
}

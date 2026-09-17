import type { FailureKind } from '../../src/services/deliverability.js';
import type { FailureSubject } from '../../src/services/bounce-table.js';

/**
 * The corpus, which is the specification.
 *
 * Every row is a reply a real mail provider sends, with the verdict it should
 * get and the reason that verdict is right. This is the artefact to review and
 * disagree with: if a row is wrong, the classifier is wrong, and the fix is to
 * change the row and then make the table in src/services/bounce-table.ts
 * reproduce it.
 *
 * `counts` is whether an exhausted attempt budget may suppress the address on
 * this reply. It matters more than `kind` for anything a provider sends
 * identically to every recipient of a broadcast, because counting one of those
 * takes a whole audience off the list at once.
 */
export interface BounceCase {
  /** The provider, and where this wording comes from. */
  provider: string;
  reply: string;
  subject: FailureSubject;
  kind: FailureKind;
  counts: boolean;
  /** Why this is the right answer. */
  because: string;
}

export const BOUNCE_CORPUS: readonly BounceCase[] = [
  // ── Dead mailboxes: the only thing that may be suppressed permanently ────
  {
    provider: 'Gmail',
    reply:
      "550-5.1.1 The email account that you tried to reach does not exist. Please try\n550-5.1.1 double-checking the recipient's email address for typos or\n550 5.1.1 unnecessary spaces.",
    subject: 'mailbox',
    kind: 'hard',
    counts: true,
    because: '5.1.1 is the registry code for a bad destination mailbox, and Gmail means it.',
  },
  {
    provider: 'Postfix',
    reply:
      '550 5.1.1 <them@example.com>: Recipient address rejected: User unknown in virtual mailbox table',
    subject: 'mailbox',
    kind: 'hard',
    counts: true,
    because: 'The status and the wording agree.',
  },
  {
    provider: 'Exchange Online',
    reply: '550 5.4.1 <them@example.com>: Recipient address rejected: Access denied',
    subject: 'mailbox',
    kind: 'hard',
    counts: true,
    because:
      'Exchange puts its unknown-recipient reply on 5.4.1. The wording is Postfix\'s universal wrapper and cannot be read on its own; the status is what separates this from a 5.7.1 policy block.',
  },
  {
    provider: 'Yandex',
    reply: '550 5.7.1 No such user!',
    subject: 'mailbox',
    kind: 'hard',
    counts: true,
    because:
      'Yandex answers a dead mailbox on 5.7.x, which is also where every reputation block lives. The wording overrides the status lean.',
  },
  {
    provider: 'AOL',
    reply:
      '554 5.7.1 <them@aol.com>: Recipient address rejected: This account has been disabled or discontinued',
    subject: 'mailbox',
    kind: 'hard',
    counts: true,
    because:
      'Identical wording to a relay refusing our own sending account, separated only by the reply naming the mailbox it is about.',
  },
  {
    provider: 'Yahoo',
    reply: "554 delivery error: dd This user doesn't have a yahoo.com account them@yahoo.com",
    subject: 'mailbox',
    kind: 'hard',
    counts: true,
    because: 'No enhanced status at all; the wording names the recipient and is unambiguous.',
  },
  {
    provider: 'QQ',
    reply: 'Message failed: 550 5.1.1 <552@qq.com>: Recipient address rejected: User unknown',
    subject: 'mailbox',
    kind: 'hard',
    counts: true,
    because:
      'A numeric local part is ordinary at QQ and 163. Nothing may read "552" out of an address.',
  },
  {
    provider: 'Exchange Online',
    reply: '550 5.2.1 The email account that you tried to reach is disabled',
    subject: 'mailbox',
    kind: 'hard',
    counts: true,
    because: '5.2.1 is "mailbox disabled, not accepting messages".',
  },
  {
    provider: 'Postfix with reject_unverified_recipient',
    reply:
      '550-Verification failed for <bob@example.com>\n550-Response: 450 4.1.1 Recipient address rejected\n550 5.1.1 Recipient verify failed',
    subject: 'mailbox',
    kind: 'hard',
    counts: true,
    because:
      'A bounce recounts its own history. The quoted 450 is a footnote; the 5xx is the verdict.',
  },
  {
    provider: 'Postfix relaying a remote bounce',
    reply:
      '550 5.1.1 host mx.example.com[192.5.7.8] said: 550 5.1.1 <them@example.com>: User unknown in virtual mailbox table',
    subject: 'mailbox',
    kind: 'hard',
    counts: true,
    because:
      'The relay IP contains "5.7.8". Nothing may read an enhanced status out of a dotted quad.',
  },

  // ── The destination domain, not the mailbox ──────────────────────────────
  {
    provider: 'Exim',
    reply: '550 Unrouteable address',
    subject: 'domain',
    kind: 'soft',
    counts: true,
    because:
      'The domain has no MX, as far as Exim can tell -- but a recipient provider with a broken DNS record produces this for every address at that domain at once. Retried and allowed to count, so it ends in the thirty-day lapsing suppression rather than a permanent one.',
  },
  {
    provider: 'qmail',
    reply: '553 sorry, that address is not local',
    subject: 'domain',
    kind: 'soft',
    counts: true,
    because: 'Same shape: a statement about the domain, not about one mailbox.',
  },
  {
    provider: 'Postfix',
    reply: '550 5.1.2 <them@nosuchdomain.example>: Recipient address rejected: Domain not found',
    subject: 'domain',
    kind: 'soft',
    counts: true,
    because: '5.1.2 is "bad destination *system* address" -- the domain, not the mailbox.',
  },

  // ── Our own sending: never evidence about anybody's mailbox ──────────────
  {
    provider: 'Gmail',
    reply:
      '550-5.7.1 [209.85.220.41] This message does not have authentication information\n550 5.7.1 or fails to pass authentication checks. The message has been blocked.',
    subject: 'sender',
    kind: 'soft',
    counts: false,
    because:
      'Contains "authentication" twice and is not an authentication failure. Read as transport it never gives up and retries every sixty seconds for three days, at the provider already refusing us.',
  },
  {
    provider: 'Gmail',
    reply: '550 5.7.26 Your message is not accepted because the sender is unauthenticated',
    subject: 'sender',
    kind: 'soft',
    counts: false,
    because: 'Our SPF/DKIM, sent identically to every recipient.',
  },
  {
    provider: 'Exchange Online',
    reply:
      '550 5.7.606 Access denied, banned sending IP [203.0.113.7]; To request removal visit https://sender.office.com',
    subject: 'sender',
    kind: 'soft',
    counts: false,
    because:
      'Contains none of spam, abuse, blocked, blacklist, reputation or policy -- which is why a wording-only gate let it count and took every Outlook recipient off the list for thirty days.',
  },
  {
    provider: 'Postfix',
    reply:
      '550 5.7.1 <no-reply@ourshop.example.com>: Sender address rejected: This account has been disabled',
    subject: 'sender',
    kind: 'soft',
    counts: false,
    because:
      'Postfix words a sender rejection exactly like a recipient one, and quotes the address while doing it. "An address appears in the reply" is not evidence about a recipient.',
  },
  {
    provider: 'Spamhaus via Postfix',
    reply:
      '554 5.7.1 Service unavailable; Client host [203.0.113.7] blocked using zen.spamhaus.org',
    subject: 'sender',
    kind: 'soft',
    counts: false,
    because: 'Our IP reputation. Every recipient of the batch gets this reply.',
  },
  {
    provider: 'Postfix',
    reply: '554 5.7.1 Relay access denied',
    subject: 'sender',
    kind: 'soft',
    counts: false,
    because:
      'Postfix refusing to relay for a domain it does not host: a fact about where we sent the message.',
  },
  {
    provider: 'Postfix',
    reply: '550 5.7.1 <them@example.com>: Recipient address rejected: Access denied',
    subject: 'sender',
    kind: 'soft',
    counts: false,
    because:
      'The same wrapper as the Exchange row above, on 5.7.1 instead of 5.4.1. The status is the only thing that separates a policy block from a dead mailbox here.',
  },

  // ── Our credentials, and our connection ──────────────────────────────────
  {
    provider: 'Amazon SES',
    reply: '535 Authentication Credentials Invalid',
    subject: 'credentials',
    kind: 'transport',
    counts: false,
    because:
      'No enhanced status to fall back on. Our password being wrong hits every address in the queue identically.',
  },
  {
    provider: 'Gmail',
    reply:
      '535-5.7.8 Username and Password not accepted. For more information, go to\n535 5.7.8  https://support.google.com/mail/?p=BadCredentials',
    subject: 'credentials',
    kind: 'transport',
    counts: false,
    because: 'Ours, not theirs.',
  },
  {
    provider: 'Exchange Online',
    reply: '535 5.7.3 Authentication unsuccessful',
    subject: 'credentials',
    kind: 'transport',
    counts: false,
    because: 'Ours.',
  },
  {
    provider: 'SMTP relay refusing an unauthenticated session',
    reply: '538 Encryption required for requested authentication mechanism',
    subject: 'credentials',
    kind: 'transport',
    counts: false,
    because:
      'Wording nothing recognises, carried by a code the reply opens with -- which is the only thing left to read it by.',
  },
  {
    provider: 'Node/undici via nodemailer',
    reply: 'Error: connect ECONNREFUSED 10.0.0.5:587',
    subject: 'connection',
    kind: 'transport',
    counts: false,
    because: 'No reply ever arrived. Nothing can be read out of it about a mailbox.',
  },
  {
    provider: 'nodemailer',
    reply: 'Timeout',
    subject: 'connection',
    kind: 'transport',
    counts: false,
    because:
      'nodemailer raises its own timeouts as a bare Error(\'Timeout\'), with the detail only in err.code.',
  },
  {
    provider: 'nodemailer',
    reply: 'Greeting never received',
    subject: 'connection',
    kind: 'transport',
    counts: false,
    because: 'The relay accepted the connection and went quiet.',
  },
  {
    provider: 'Node TLS',
    reply: 'self signed certificate in certificate chain',
    subject: 'connection',
    kind: 'transport',
    counts: false,
    because: 'Our configuration.',
  },
  {
    provider: 'Postfix',
    reply: '451 4.3.1 Insufficient system storage; try again later',
    subject: 'connection',
    kind: 'transport',
    counts: false,
    because:
      'RFC 3463 calls 4.3.x a mail *system* condition, and the system is not the recipient.',
  },
  {
    provider: 'Overloaded relay',
    reply:
      '421-4.7.0 Our system has detected an unusual rate of unsolicited mail\n421 4.7.0 originating from your IP address',
    subject: 'connection',
    kind: 'transport',
    counts: false,
    because:
      '421 is "closing transmission channel" -- about the connection rather than anything in the envelope, whatever subject digit rides along.',
  },
  {
    provider: 'Postfix relaying a bounce that quotes a 421',
    reply: 'Earlier attempt: 421 4.7.0 too busy\n550 5.1.1 <them@example.com>: User unknown',
    subject: 'mailbox',
    kind: 'hard',
    counts: true,
    because:
      'The 421 is a footnote. An unconditional short-circuit on it retried a dead mailbox for three days.',
  },

  // ── Full mailboxes and message problems: retried, never counted ──────────
  {
    provider: 'Postfix',
    reply: "452 4.2.2 <them@example.com>: Recipient address rejected: User's mailbox is full",
    subject: 'capacity',
    kind: 'soft',
    counts: false,
    because:
      'The mailbox exists, its owner has not gone anywhere, and they may well empty it next week.',
  },
  {
    provider: 'Postfix',
    reply: '552 5.2.2 <them@example.com>: Recipient address rejected: Over quota',
    subject: 'capacity',
    kind: 'soft',
    counts: false,
    because: 'Permanently over quota is still not a dead mailbox.',
  },
  {
    provider: 'qmail',
    reply: '552 Requested mail action aborted: exceeded storage allocation',
    subject: 'capacity',
    kind: 'soft',
    counts: false,
    because: 'Same, worded without a status.',
  },
  {
    provider: 'Exchange Online',
    reply: '550 5.6.11 Message contains bare line feeds and cannot be sent',
    subject: 'message',
    kind: 'soft',
    counts: false,
    because: 'About this message. Every recipient of the batch gets it.',
  },
  {
    provider: 'Postfix',
    reply: '552 5.3.4 Message size exceeds fixed limit',
    subject: 'message',
    kind: 'soft',
    counts: false,
    because:
      '5.3.4 is the one 3.x code that is about the message rather than the receiving system, and a message too large for one provider is not a dead mailbox.',
  },

  // ── Deferrals: never a verdict about anything ───────────────────────────
  {
    provider: 'Postgrey via Postfix',
    reply:
      '450 4.7.1 <them@example.com>: Recipient address rejected: Greylisted, try again in 500 seconds',
    subject: 'deferral',
    kind: 'soft',
    counts: false,
    because:
      'A greylist. Nothing may read "500 seconds" as a reply code, and a transient reply is never a verdict.',
  },
  {
    provider: 'Gmail',
    reply:
      '450-4.2.1 The user you are trying to contact is receiving mail at a rate that\n450-4.2.1 prevents additional messages from being delivered.',
    subject: 'mailbox',
    kind: 'soft',
    counts: false,
    because:
      'The status says mailbox and the mailbox is fine -- which is why severity decides before subject does.',
  },
  {
    provider: 'Postfix',
    reply: '451 4.7.0 Error: too many errors from 10.5.3.2',
    subject: 'sender',
    kind: 'soft',
    counts: false,
    because: 'The IP contains "5.3.2". Nothing may read an enhanced status out of it.',
  },
  {
    provider: 'Exchange Online',
    reply: '451 4.7.500 Server busy, try again later',
    subject: 'deferral',
    kind: 'soft',
    counts: false,
    because: 'A three-digit detail component is real. "500" is not a reply code here.',
  },
  {
    provider: 'Postfix with reject_unverified_recipient at 450',
    reply:
      '450 4.7.1 <them@example.com>: Recipient address rejected: mailbox unavailable, try again later',
    subject: 'deferral',
    kind: 'soft',
    counts: false,
    because:
      'Mailbox wording at a transient severity. Read as hard it suppressed a live customer permanently on the first attempt, bypassing the attempt budget entirely.',
  },
  {
    provider: 'Exim',
    reply: 'greylisted, try again later',
    subject: 'deferral',
    kind: 'soft',
    counts: false,
    because: 'No code at all; the wording is the only signal and it says "not now".',
  },

  // ── Genuinely unexplained: what the attempt budget is for ───────────────
  {
    provider: 'unknown relay',
    reply: 'Message could not be delivered',
    subject: 'unknown',
    kind: 'soft',
    counts: true,
    because:
      'Six failures nobody can explain is the one case where giving up on an address is the honest answer.',
  },
  {
    provider: 'unknown relay',
    reply: 'Unknown failure from the relay',
    subject: 'unknown',
    kind: 'soft',
    counts: true,
    because: 'Same.',
  },
  {
    provider: 'Postfix quoting a message size',
    reply: '550 5.1.1 User unknown; original message size: 535 KB accepted',
    subject: 'mailbox',
    kind: 'hard',
    counts: true,
    because:
      '"535" after a colon and a space is in reply-code position. Only the code a reply *opens* with may be read as an authentication refusal.',
  },
];

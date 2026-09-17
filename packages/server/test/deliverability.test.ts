import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import {
  closeApp,
  closeDb,
  db,
  makeTenant,
  setupDatabase,
  testApp,
  truncateAll,
  type TestTenant,
} from './helpers.js';
import { classifyFailure, isSuppressed, recordFailure, suppress } from '../src/services/deliverability.js';
import {
  flushEmailQueue,
  outbox,
  queueEmail,
  setEmailTransport,
  unsubscribeHeaders,
} from '../src/services/email.js';

let tenant: TestTenant;

beforeAll(async () => {
  await setupDatabase();
});

beforeEach(async () => {
  await truncateAll();
  tenant = await makeTenant();
});

afterAll(async () => {
  await closeApp();
  await closeDb();
});

async function authed(method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown) {
  const app = await testApp();
  return app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${tenant.secretKey}` },
    ...(payload === undefined ? {} : { payload }),
  });
}

describe('classifying a delivery failure', () => {
  it('treats a missing mailbox as hard', () => {
    for (const message of [
      '550 5.1.1 <nobody@example.com>: Recipient address rejected: User unknown',
      '5.1.1 no such user',
      'Mailbox not found',
      '553 sorry, that address is not local',
    ]) {
      expect(classifyFailure(message)).toBe('hard');
    }
  });

  it('never suppresses on a transient, whatever wording it carries (HIGH)', async () => {
    // `hard` suppresses on the first attempt, permanently, and never consults
    // saysSomethingAboutTheMailbox. So an arm that can return `hard` for a 4xx
    // is a hole straight through the gate -- and the subject 6/7 arm had no
    // severity check, while every other arm did. A deferral quoting mailbox
    // wording took a live customer off the list forever on one reply.
    for (const message of [
      '450 4.7.1 Recipient address rejected: mailbox unavailable, try again later',
      '451 4.7.1 <them@example.com>: Recipient address rejected: User unknown, retrying',
      '450 4.6.0 Message content deferred, mailbox not found in cache',
    ]) {
      const address = `transient-${Math.random().toString(36).slice(2)}@example.com`;
      expect(await recordFailure(tenant.id, address, message, 1, 6), message).not.toBe('hard');
      expect(await isSuppressed(tenant.id, address), message).toBeNull();
    }

    // The control: the same wording at a permanent severity is a dead mailbox
    // and is still suppressed immediately.
    const dead = `dead-${Math.random().toString(36).slice(2)}@example.com`;
    expect(await recordFailure(tenant.id, dead, '550 5.7.1 No such user!', 1, 6)).toBe('hard');
    expect(await isSuppressed(tenant.id, dead)).not.toBeNull();
  });

  it('does not read a refusal about our own account as a dead mailbox (HIGH)', async () => {
    // "This account has been disabled" is how a relay refuses the account we
    // authenticate with. It arrives identically for every recipient of a
    // broadcast, so reading it as a hard bounce suppressed the whole audience
    // permanently on the first attempt -- through `hard`, which never reaches
    // the gate that exists to stop exactly this.
    for (const message of [
      '550 5.7.1 This account has been disabled',
      '550 5.7.0 Your account has been deactivated for policy reasons',
    ]) {
      const address = `ours-${Math.random().toString(36).slice(2)}@example.com`;
      expect(await recordFailure(tenant.id, address, message, 1, 6), message).toBe('soft');
      expect(await isSuppressed(tenant.id, address), message).toBeNull();
    }

    // The control: wording that names the *recipient* still decides.
    expect(classifyFailure('550 5.7.1 <them@example.com>: mailbox unavailable')).toBe('hard');
  });

  it('does not read a policy block as an authentication failure (MEDIUM)', () => {
    // Gmail's standard block for an unauthenticated sender contains the word
    // "authentication" twice, and the bare word was enough to call it
    // transport -- which never gives up and retries every sixty seconds until
    // the three-day reaper: about 4,320 attempts per recipient, aimed at the
    // provider already refusing us on reputation grounds.
    expect(
      classifyFailure(
        '550-5.7.1 [209.85.220.41] This message does not have authentication information\n' +
          '550 5.7.1 or fails to pass authentication checks. The message has been blocked.',
      ),
    ).toBe('soft');
    expect(
      classifyFailure('550 5.7.26 Your message is not accepted because the sender is unauthenticated'),
    ).toBe('soft');

    // The controls: a real refusal of our credentials is still about us.
    expect(classifyFailure('Invalid login: 535 5.7.8 Error: authentication failed')).toBe(
      'transport',
    );
    expect(classifyFailure('535 5.7.3 Authentication unsuccessful')).toBe('transport');
  });

  it('does not read an enhanced status out of a relay IP address (MEDIUM)', () => {
    // The same class of bug the reply parser was written to end -- an IP
    // address contains three-part runs -- reintroduced by an unguarded
    // `\b5\.7\.8\b`. Postfix embeds "host NAME[IP]" in a relayed bounce, so a
    // dead mailbox behind relay 192.5.7.8 read as an authentication failure:
    // never suppressed, attempt refunded, retried for three days.
    const dead = (relay: string) =>
      `550 5.1.1 host mx.example.com[${relay}] said: 550 5.1.1 <them@example.com>: User unknown in virtual mailbox table`;
    expect(classifyFailure(dead('192.5.7.8'))).toBe('hard');
    // The control, one digit different, which always worked.
    expect(classifyFailure(dead('192.5.7.9'))).toBe('hard');
  });

  it('still suppresses a dead mailbox that arrives with a policy status (HIGH)', async () => {
    // The narrow wording set dropped everything AOL, Yahoo and Exim actually
    // say, and 5.7.x is excluded from the suppression gate -- so those
    // addresses were classified soft AND never counted, i.e. never suppressed
    // by any route at all. They bounce on every broadcast, forever, which is
    // the reputation damage this file exists to prevent.
    //
    // The distinction was unobservable where it was applied: withoutAddresses
    // strips <them@aol.com> before the wording test, so the reply that names
    // the mailbox and the relay's refusal of our own account read identically.
    // It is read before the stripping now.
    for (const message of [
      '554 5.7.1 <them@aol.com>: Recipient address rejected: This account has been disabled or discontinued',
      "550 5.7.1 This user doesn't have a yahoo.com account (them@yahoo.com)",
      '550 5.7.1 <them@example.com>: Recipient address rejected: unrouteable address',
      '550 5.7.1 <them@example.com>: Recipient address rejected: Address unknown',
      '550 5.7.1 <them@example.com>: Recipient address rejected: The email address does not exist',
    ]) {
      const address = `gone-${Math.random().toString(36).slice(2)}@example.com`;
      expect(await recordFailure(tenant.id, address, message, 1, 6), message).toBe('hard');
      expect(await isSuppressed(tenant.id, address), message).not.toBeNull();
    }

    // The controls, all of which quote nobody or say nothing about a mailbox,
    // and none of which may ever be read as a dead address.
    for (const message of [
      '550 5.7.1 This account has been disabled',
      '550 5.7.0 Your account has been deactivated for policy reasons',
      '550 5.7.1 <them@example.com>: Recipient address rejected: Access denied',
      '554 5.7.1 Service unavailable; Client host [203.0.113.7] blocked using zen.spamhaus.org',
      '550 5.7.606 Access denied, banned sending IP [203.0.113.7]',
    ]) {
      expect(classifyFailure(message), message).toBe('soft');
    }
  });

  it('reads a credential refusal that carries no enhanced status (HIGH)', () => {
    // Amazon SES answers "535 Authentication Credentials Invalid". The
    // qualified wording set missed it and there is no 5.7.x to fall back on,
    // so our own SMTP password being wrong came back soft, spent every
    // attempt, and suppressed the recipient for thirty days -- identically for
    // every address in the queue, which is the worst thing this file can do.
    for (const message of [
      '535 Authentication Credentials Invalid',
      '535 Authentication Credentials Invalid, please check your credentials',
      '535 5.7.3 Authentication unsuccessful',
      // Wording nothing recognises, carried by a code the reply opens with --
      // which is the only thing left to read it by.
      '538 Encryption required for requested authentication mechanism',
    ]) {
      expect(classifyFailure(message), message).toBe('transport');
    }

    // The control that made the bare code unusable before: a quoted number is
    // not a reply code, and the code a reply *opens* with is.
    expect(classifyFailure('550 5.1.1 User unknown; original message size: 535 KB accepted')).toBe(
      'hard',
    );
  });

  it('does not count a reputation block toward suppression either (HIGH)', async () => {
    // Classifying a block as soft is only half of it. A soft failure still
    // suppresses for thirty days once the attempts run out, so the gate that
    // decides whether a failure may be *counted* has to exclude the same
    // replies -- and checking only the wording left it doing almost nothing.
    //
    // Exchange Online's standard IP-reputation refusal contains none of spam,
    // abuse, blocked, blacklist, reputation or policy, so it counted: six
    // attempts took every Outlook recipient in a broadcast off the list
    // together, expires_at +30 days, subscription 'bounced'. That is the
    // disaster the gate exists to prevent, arriving through the gate.
    for (const message of [
      '550 5.7.606 Access denied, banned sending IP [203.0.113.7]; To request removal visit sender.office.com',
      '550 5.7.509 Access denied, sending domain does not pass DMARC verification',
      '554 5.7.1 Relay access denied',
      '550 5.6.11 Message contains bare line feeds',
    ]) {
      const address = `blocked-${Math.random().toString(36).slice(2)}@example.com`;
      expect(await recordFailure(tenant.id, address, message, 6, 6), message).toBe('soft');
      expect(await isSuppressed(tenant.id, address), message).toBeNull();
    }

    // The control, unchanged: a failure that identifies nothing is exactly
    // what the attempt budget is for, and still ends in a suppression.
    const unexplained = `nothing-${Math.random().toString(36).slice(2)}@example.com`;
    await recordFailure(tenant.id, unexplained, 'Message could not be delivered', 6, 6);
    expect(await isSuppressed(tenant.id, unexplained)).not.toBeNull();
  });

  it('reads a dead mailbox that arrives with a policy status (HIGH)', () => {
    // Returning soft for every 5.7.x was too broad in the other direction.
    // Yandex answers an unknown recipient with "550 5.7.1 No such user!", so
    // that address was never permanently suppressed and bounced on every
    // broadcast, forever, from a domain whose reputation pays for it.
    //
    // Only unambiguous wording overrides the subject. Postfix's "Recipient
    // address rejected" wraps blocks and dead mailboxes alike, so it
    // deliberately does not count -- that wrapper is what made a Spamhaus
    // listing suppress a whole batch.
    expect(classifyFailure('550 5.7.1 No such user!')).toBe('hard');
    expect(
      classifyFailure('550 5.7.1 <them@example.com>: Recipient address rejected: Access denied'),
    ).toBe('soft');

    // Three more that every earlier version read as soft.
    expect(
      classifyFailure("554 delivery error: dd This user doesn't have a yahoo.com account"),
    ).toBe('hard');
    expect(classifyFailure('550 5.1.1 This account has been disabled or discontinued')).toBe('hard');
    expect(classifyFailure('550 Unrouteable address')).toBe('hard');
  });

  it('does not let a quoted transient code outrank the final refusal (HIGH)', () => {
    // parseReply takes the most severe code anywhere in the chain on purpose,
    // because a bounce recounts its own history. An unconditional 421
    // short-circuit threw that away: read as transport, the attempt is
    // refunded, so a dead mailbox was retried every sixty seconds for three
    // days and never suppressed.
    expect(
      classifyFailure('Earlier attempt: 421 4.7.0 too busy\n550 5.1.1 <them@example.com>: User unknown'),
    ).toBe('hard');

    // And 421 on its own still means the relay closed the channel on us.
    expect(classifyFailure('421 4.7.0 Try again later')).toBe('transport');
  });

  it('does not read a quoted number as an authentication code (MEDIUM)', () => {
    // A reply code is matched after a colon and a space, which is also how a
    // bounce quotes anything at all. A bare 535 in the code set turned
    // "original message size: 535 KB" into an authentication failure -- which
    // is transport, so never suppressed and the attempt refunded.
    expect(classifyFailure('550 5.1.1 User unknown; original message size: 535 KB accepted')).toBe(
      'hard',
    );
    // The control: a real authentication refusal is still about us.
    expect(classifyFailure('Invalid login: 535 5.7.8 Error: authentication failed')).toBe(
      'transport',
    );
    expect(classifyFailure('535 5.7.3 Authentication unsuccessful')).toBe('transport');
  });

  it('reads the operative line of a verbose bounce (MEDIUM)', () => {
    // At an 8 KB cap a reply whose real reason sat past it was classified on
    // its header block alone and came out inverted. A DSN quoting a hundred
    // and forty Received headers is ordinary, not hostile.
    const verbose = `${'Received: from relay.example.com by mx.example.net\n'.repeat(300)}550 5.1.1 <them@example.com>: Recipient address rejected: User unknown`;
    expect(verbose.length).toBeGreaterThan(8_192);
    expect(classifyFailure(verbose)).toBe('hard');
  });

  it('does not read a reputation block as a dead mailbox (HIGH)', () => {
    // Postfix words *every* rejection the same way, whatever the reason:
    // "<addr>: Recipient address rejected: <reason>". So the hard-bounce
    // wording is present in an RBL hit, a content rejection and a policy
    // refusal, none of which is about the mailbox. Ranking a permanent code
    // above the block rules meant one afternoon behind a Spamhaus listing
    // permanently suppressed every recipient in the batch on their first
    // attempt -- expires_at null, subscription 'bounced', no way back without
    // a manual unsuppress per address.
    for (const message of [
      '550 5.7.1 <them@example.com>: Recipient address rejected: Access denied',
      '554 5.7.1 Service unavailable; Client host [203.0.113.7] blocked using zen.spamhaus.org',
      '550 5.7.1 <them@example.com>: Recipient address rejected: Message rejected due to content restrictions',
      '550 5.7.606 Access denied, banned sending IP [203.0.113.7]',
    ]) {
      expect(classifyFailure(message), message).toBe('soft');
    }

    // The control: the same wording with an addressing status really is a
    // dead mailbox, and still reads as one.
    expect(
      classifyFailure('550 5.1.1 <them@example.com>: Recipient address rejected: User unknown'),
    ).toBe('hard');
  });

  it('does not read an incidental number as a reply code (HIGH)', () => {
    // A reply code is the first token of a reply line, not any three digits in
    // the text. Scanning for `\b5\d\d\b` found the duration in "try again in
    // 500 seconds", and scanning for `\b5\.\d\.\d\b` found an octet inside
    // "10.5.3.2" -- so two ordinary deferrals were read as permanent refusals
    // and the recipients were suppressed on the first attempt.
    // Worded the way Postfix actually words them, because that is what made
    // the bug bite: the same reply carries "Recipient address rejected", so a
    // stray permanent code is all that stands between a greylist and a
    // permanent suppression.
    for (const message of [
      '450 4.7.1 <them@example.com>: Recipient address rejected: Greylisted, try again in 500 seconds',
      '451 4.7.1 <them@example.com>: Recipient address rejected: Service unavailable; relay 10.5.1.1 is not responding',
      '451 4.7.500 <them@example.com>: Recipient address rejected: Server busy, try again later',
      '450 4.2.0 <them@example.com>: Recipient address rejected: deferred, retry in 550 seconds, queue id 550ABC',
    ]) {
      expect(classifyFailure(message), message).not.toBe('hard');
    }

    // The control: move the permanent code into reply position and the same
    // wording is a dead mailbox again, so this is testing where the digits
    // are and not merely that they are ignored.
    expect(
      classifyFailure('550 5.1.1 <them@example.com>: Recipient address rejected: unknown user'),
    ).toBe('hard');
  });

  it('does not read a numeric mailbox as a quota reply (MEDIUM)', () => {
    // The quota rules carry a bare `552` and were matched against the raw
    // reply, so a hard bounce for <552@qq.com> -- or any numeric local part,
    // which is ordinary at QQ and 163 and on ticketing systems -- came back
    // soft. That dead address was then never suppressed: retried on every
    // broadcast, one bounce per send, forever.
    for (const message of [
      '550 5.1.1 <552@qq.com>: Recipient address rejected: User unknown',
      '550 5.1.1 <jo.552@example.com>: User unknown',
      '550 5.1.1 <552-sales@example.com>: User unknown',
    ]) {
      expect(classifyFailure(message), message).toBe('hard');
    }
  });

  it('lets a connection failure outrank a quota mention (MEDIUM)', () => {
    // Checking quota before the connection meant any relay-side failure whose
    // text happened to mention a full mailbox spent the attempt budget and
    // ended in a thirty-day suppression. `4.3.1 Insufficient system storage`
    // is a mail *system* condition in RFC 3463, and the system is not the
    // recipient.
    for (const message of [
      '452 4.3.1 Insufficient system storage; try again later',
      '421 4.3.1 Mail system full; closing connection, try again later',
      'ECONNRESET while reading greeting from relay (mailbox full warning banner)',
      '{"code":"ETIMEDOUT","command":"CONN","recipient":"bob@example.com"}',
    ]) {
      expect(classifyFailure(message), message).toBe('transport');
    }
  });

  it('lets a permanent code outrank a transient one it quotes (MEDIUM)', () => {
    // Bounces recount their own history. The final word is the 5xx.
    for (const message of [
      '550-Verification failed for <bob@example.com>\n550-Response: 450 4.1.1 Recipient address rejected\n550 Sender verify failed',
      'Delivery failed permanently.\n550 5.1.1 The email account that you tried to reach does not exist.\nEarlier attempt: 451 4.3.0 deferred',
    ]) {
      expect(classifyFailure(message), message).toBe('hard');
    }
  });

  it('does not stall on a hostile reply (MEDIUM)', () => {
    // Measured against a control of the same length rather than a fixed
    // millisecond bar, which is what let the last version of this test miss a
    // 135 ms stall: the bar was 250 ms, roughly 1,900 times the honest cost of
    // the same input, so every shape "passed". A ratio also survives being run
    // on a slower machine, which a fixed bar does not.
    //
    // Three separate quadratics have lived in this function: `\b550\b.*reason`
    // pairing a code with its wording, `\S+@\S+` walking a run of non-space,
    // and `<[^>\s]*>` backtracking a run of `<`. Each shape below defeats one
    // of them, so they are all kept, and the local-part scan is the reason the
    // fourth column is here.
    const size = 65_536;
    const control = `550 5.1.1 ${'x'.repeat(size)} user unknown`;
    const hostile: Record<string, string> = {
      'run of <': `550 ${'<'.repeat(size)}`,
      'run of non-space then @': `${'x'.repeat(size)}@`,
      'repeated codes': '550 '.repeat(size / 4),
      'repeated addresses': `550 5.1.1 ${'<a@b.example.com> '.repeat(size / 18)}`,
      'repeated enhanced statuses': `${'4.7.1 '.repeat(size / 6)}user unknown`,
      'run of colons': ':'.repeat(size),
      'unbalanced brackets': '<'.repeat(size / 2) + '>'.repeat(size / 2),
    };

    const time = (text: string) => {
      classifyFailure(text); // warm, so the first entry is not measuring JIT
      const started = performance.now();
      classifyFailure(text);
      return performance.now() - started;
    };

    const baseline = Math.max(time(control), 0.05);
    for (const [shape, text] of Object.entries(hostile)) {
      const ratio = time(text) / baseline;
      expect(ratio, `${shape}: ${ratio.toFixed(1)}x a well-formed reply`).toBeLessThan(25);
    }
  });

  it('reads a full mailbox the way a real MTA words it (HIGH)', () => {
    // A negative lookahead took over-quota out of `transport` and nothing put
    // it into `soft`, so the common Postfix wording fell through to the
    // hard-bounce patterns on the "Recipient address rejected" it quotes --
    // and a mailbox that was full for one week earned a *permanent*
    // suppression. No more receipts, confirmations or password resets, ever.
    for (const message of [
      "452 4.2.2 <them@example.com>: Recipient address rejected: User's mailbox is full",
      '452 4.2.2 <them@example.com>: Recipient address rejected: mailbox is full',
      '552 5.2.2 <them@example.com>: Recipient address rejected: Over quota',
    ]) {
      expect(classifyFailure(message), message).toBe('soft');
    }
  });

  it('still reads a multi-line deferral as transport (HIGH)', () => {
    // nodemailer joins multi-line SMTP replies with \n, which is how Gmail
    // and Outlook word every deferral. Anchoring the transient pattern with
    // ^...$ and no `m` flag meant none of them matched, so an afternoon of
    // throttling spent the attempt budget and suppressed the throttled
    // recipients for a month.
    //
    // 421 is "closing transmission channel" and 4.3.x is the receiving mail
    // *system*: both are about the connection rather than about anything in
    // the envelope, so the attempt is refunded as well as never counted.
    for (const message of [
      '421-4.7.0 Our system has detected an unusual rate of unsolicited mail\n421 4.7.0 originating',
      '451-4.3.0 Mail server temporarily rejected message.\n451 4.3.0 Please retry',
    ]) {
      expect(classifyFailure(message), message).toBe('transport');
    }
  });

  it('gives up on a message that can never leave the queue (HIGH)', async () => {
    // A transport failure refunds its attempt, so a message stuck on one has
    // no budget to run out of: retried every sixty seconds for as long as the
    // queue exists, never sent, never failed, and never visible as a problem.
    // That is the standing cost of any classifier mistake in this direction,
    // and it is why the classifier has to be right *and* bounded.
    const { queueEmail, flushEmailQueue, setEmailTransport } = await import(
      '../src/services/email.js'
    );
    await queueEmail({
      tenantId: tenant.id,
      templateKey: 'receipt',
      to: 'stuck@example.com',
      subject: 'Your order',
      html: '<p>Thanks</p>',
      dedupeKey: 'stuck-1',
    });
    setEmailTransport({
      async send() {
        throw new Error('connect ECONNREFUSED 10.0.0.5:587');
      },
    });

    // Two days of a broken relay: still trying, still no attempts spent.
    await db().query(
      `UPDATE email_messages SET created_at = now() - interval '2 days' WHERE tenant_id = $1`,
      [tenant.id],
    );
    await flushEmailQueue(50);
    const trying = await db().query<{ status: string; attempts: number }>(
      'SELECT status, attempts FROM email_messages WHERE tenant_id = $1',
      [tenant.id],
    );
    expect(trying.rows[0]!.status).toBe('queued');
    expect(trying.rows[0]!.attempts).toBe(0);

    // Four days, and it ends -- visibly, with its last error, rather than
    // cycling out of sight.
    await db().query(
      `UPDATE email_messages SET created_at = now() - interval '4 days', next_attempt_at = now()
        WHERE tenant_id = $1`,
      [tenant.id],
    );
    await flushEmailQueue(50);
    const done = await db().query<{ status: string; error: string | null }>(
      'SELECT status, error FROM email_messages WHERE tenant_id = $1',
      [tenant.id],
    );
    expect(done.rows[0]!.status).toBe('failed');
    expect(done.rows[0]!.error).toMatch(/gave up after/i);

    // And it is not a suppression: four days of a broken relay says nothing
    // about the mailbox.
    expect(await isSuppressed(tenant.id, 'stuck@example.com')).toBeNull();
  });

  it('can still record a delivery the queue-age reaper gave up on (HIGH)', async () => {
    // The `sent` write was widened to accept 'failed' precisely so that a send
    // which succeeds after the reaper has given up can still be recorded --
    // "what actually reached the customer wins". But it is a compare-and-swap
    // on claim_token, and the new three-day reaper cleared that token, so the
    // write matched nothing: the customer received the email and the
    // retailer's queue said failed, with no provider id and no sent_at to
    // trace it by. The older abandoned-claim reaper keeps the token on purpose
    // and says why.
    const { queueEmail, flushEmailQueue } = await import('../src/services/email.js');
    await queueEmail({
      tenantId: tenant.id,
      templateKey: 'receipt',
      to: 'late-delivery@example.com',
      subject: 'Your order',
      html: '<p>Thanks</p>',
      dedupeKey: 'late-1',
    });
    // Four days old, and another worker is inside its send right now.
    const claim = await db().query<{ id: string; claim_token: string }>(
      `UPDATE email_messages
          SET created_at = now() - interval '4 days', status = 'sending',
              claimed_at = now(), claim_token = gen_random_uuid()
        WHERE tenant_id = $1 RETURNING id, claim_token`,
      [tenant.id],
    );

    // The reaper runs at the top of every flush, i.e. every fifteen seconds.
    await flushEmailQueue(50);
    const reaped = await db().query<{ status: string; claim_token: string | null }>(
      'SELECT status, claim_token FROM email_messages WHERE id = $1',
      [claim.rows[0]!.id],
    );
    expect(reaped.rows[0]!.status).toBe('failed');

    // That worker's send now succeeds. The write it makes is the one in
    // flushEmailQueue, reproduced here because the send is already in flight.
    const recorded = await db().query(
      `UPDATE email_messages
          SET status = 'sent', sent_at = now(), provider_id = 'relay-ok',
              error = NULL, claimed_at = NULL, claim_token = NULL
        WHERE id = $1 AND claim_token = $2 AND status IN ('sending', 'failed')`,
      [claim.rows[0]!.id, claim.rows[0]!.claim_token],
    );
    expect(recorded.rowCount).toBe(1);

    const final = await db().query<{ status: string; provider_id: string | null }>(
      'SELECT status, provider_id FROM email_messages WHERE id = $1',
      [claim.rows[0]!.id],
    );
    expect(final.rows[0]!.status).toBe('sent');
    expect(final.rows[0]!.provider_id).toBe('relay-ok');
  });

  it('never writes off an address over a deferral, whatever the label (HIGH)', async () => {
    // The harm the deferral rules exist to prevent is not the classification,
    // it is the ending: an afternoon of throttling used to spend the attempt
    // budget and then suppress every throttled recipient for a month.
    //
    // So this asserts the ending. recordFailure is called at the last attempt,
    // which is the only moment a soft failure is allowed to suppress, and the
    // address has to come back mailable. A deferral is a verdict about the
    // message and never a statement that the mailbox is gone -- true whether
    // the reply is read as transport or as soft, which is why the label is not
    // what is checked. These are also the replies that hit every recipient of
    // a broadcast identically, so a rule that counts them takes the whole
    // audience off the list at the same moment.
    for (const message of [
      '421-4.7.0 Our system has detected an unusual rate of unsolicited mail\n421 4.7.0 originating',
      '450-4.2.1 The user you are trying to contact is receiving mail at a rate that\n450-4.2.1 prevents',
      '451-4.3.0 Mail server temporarily rejected message.\n451 4.3.0 Please retry',
      '450 4.7.1 <them@example.com>: Greylisted, try again in 500 seconds',
      'greylisted, try again later',
      '452 4.2.2 <them@example.com>: Recipient address rejected: mailbox is full',
      '550 5.7.1 Message rejected as spam by Content Filtering',
      '554 5.7.1 Service unavailable; Client host blocked using zen.spamhaus.org',
    ]) {
      const address = `deferred-${Math.random().toString(36).slice(2)}@example.com`;
      const kind = await recordFailure(tenant.id, address, message, 6, 6);
      expect(kind, message).not.toBe('hard');
      expect(await isSuppressed(tenant.id, address), message).toBeNull();
    }

    // And the control: a failure that says nothing identifiable at all is
    // exactly what the attempt budget is for, so it still ends in one.
    const unexplained = `unexplained-${Math.random().toString(36).slice(2)}@example.com`;
    await recordFailure(tenant.id, unexplained, 'Message could not be delivered', 6, 6);
    expect(await isSuppressed(tenant.id, unexplained)).not.toBeNull();
  });

  it('does not read a protocol name inside the recipient address (MEDIUM)', () => {
    // Word boundaries fixed Kessler and not <ssl@example.com>, because `<`,
    // `@` and `.` are all non-word characters. The addresses are stripped
    // before the transport patterns run, which removes the class rather than
    // the examples.
    for (const message of [
      '550 5.1.1 <ssl@example.com>: User unknown',
      '550 5.1.1 <jo@ssl.example.com>: User unknown',
      '550 5.1.1 <tls@example.com>: User unknown',
      '550 5.1.1 <certificate@example.com>: User unknown',
    ]) {
      expect(classifyFailure(message), message).toBe('hard');
    }
  });

  it('does not mistake the recipient\'s full mailbox for our transport', () => {
    // 4xx by the letter of the spec, permanent in practice: an abandoned
    // mailbox stays over quota. Read as transport it was never suppressed and
    // the attempt was handed back every time, so the queue retried a dead
    // address once a minute forever -- never draining, and bouncing against
    // the sending domain the whole while. Soft is the honest answer: backed
    // off, written off after six tries, and suppressed for thirty days rather
    // than permanently, because a mailbox can be emptied.
    for (const message of [
      '452 4.2.2 Mailbox full',
      '452 4.2.2 The email account that the user is trying to reach is over quota',
      '552 5.2.2 Over quota',
      '422 mailbox full',
    ]) {
      expect(classifyFailure(message), message).toBe('soft');
    }

    // Not this one, which an earlier version of this test had wrong: RFC 3463
    // calls 4.3.1 a mail *system* condition, and the system is not the
    // recipient. It is the destination server out of room, so it retries
    // without spending the address's budget.
    expect(classifyFailure('451 4.3.1 Insufficient system storage')).toBe('transport');
  });

  it('reads a surname that happens to contain a protocol name (MEDIUM)', () => {
    // The transport patterns are matched against a reply that quotes the
    // recipient, and `SSL` unanchored is inside Kessler, Hassler, Gessler and
    // Ressler. A real "User unknown" bounce for any of them read as our TLS
    // failing: never suppressed, never counted, retried forever.
    for (const message of [
      '550 5.1.1 <kessler@example.com>: User unknown in local recipient table',
      '550 5.1.1 <gessler@example.com>: Recipient address rejected: User unknown',
    ]) {
      expect(classifyFailure(message), message).toBe('hard');
    }
  });

  it('treats a failure about us as transport, not the recipient', () => {
    // These say nothing about whether a mailbox exists, so they must never
    // count toward suppressing one — a relay down for ninety seconds used to
    // suppress every recipient queued at the time.
    for (const message of [
      '451 4.3.0 Temporary server error',
      'ECONNREFUSED',
      'unable to verify the first certificate',
      'Client network socket disconnected before secure TLS connection was established',
    ]) {
      expect(classifyFailure(message), message).toBe('transport');
    }
  });

  it('treats anything genuinely ambiguous as soft', () => {
    // A false hard bounce silently stops mailing a real customer forever,
    // which is much worse than four more retries at a dead address.
    for (const message of [
      'Message could not be delivered',
      'Unknown failure from the relay',
    ]) {
      expect(classifyFailure(message), message).toBe('soft');
    }
  });

  it('does not read a content block as a complaint', () => {
    // Nothing in an SMTP reply is a complaint. Reading one as such suppressed
    // the address permanently AND withdrew that person's marketing consent —
    // so an hour of Gmail blocking our content took the whole batch off the
    // list. A real complaint arrives out of band through
    // `POST /v1/email/suppressions`.
    for (const reply of [
      '550-5.7.1 Our system has detected that this message is likely unsolicited mail. blocked',
      '550 5.7.1 Message rejected as spam by Content Filtering',
      '554 5.7.1 Service unavailable; Client host blocked using zen.spamhaus.org',
      '550 5.7.1 Message contains spam-like content',
      'rejected by SpamAssassin, score 9.1',
      '550 5.7.1 Rejected for policy reasons; contact abuse@example.com',
    ]) {
      expect(classifyFailure(reply), reply).toBe('soft');
    }

    // And the things that really are about the mailbox still are.
    expect(classifyFailure('550 5.1.1 The email account that you tried to reach does not exist'))
      .toBe('hard');
    expect(classifyFailure('421 4.7.0 Try again later')).toBe('transport');
  });

  it('still records a complaint that arrives out of band', async () => {
    // The feedback-loop path: a provider's FBL handler, or an operator.
    await suppress(tenant.id, 'reporter@example.com', 'complaint', 'FBL report');
    const blocked = await isSuppressed(tenant.id, 'reporter@example.com');
    expect(blocked?.reason).toBe('complaint');

    const { rows } = await db().query<{ marketing_consent: boolean }>(
      "SELECT marketing_consent FROM contacts WHERE email_normalised = 'reporter@example.com'",
    );
    // No contact seeded here, so nothing to assert about consent beyond the
    // suppression itself standing.
    expect(rows).toHaveLength(0);
  });
});

describe('suppression', () => {
  it('blocks a suppressed address and marks the message suppressed', async () => {
    await suppress(tenant.id, 'Dead@Example.com', 'hard_bounce', 'user unknown');

    // Case-insensitive: the address is normalised on both sides.
    expect(await isSuppressed(tenant.id, 'dead@example.com')).not.toBeNull();

    await db().query(
      `INSERT INTO email_messages (tenant_id, template_key, to_email, subject, html, dedupe_key)
       VALUES ($1, 'promo', 'dead@example.com', 'Hi', '<p>Hi</p>', 'd1')`,
      [tenant.id],
    );

    const { flushEmailQueue } = await import('../src/services/email.js');
    await flushEmailQueue();

    const { rows } = await db().query<{ status: string }>(
      'SELECT status FROM email_messages WHERE dedupe_key = $1',
      ['d1'],
    );
    expect(rows[0]!.status).toBe('suppressed');
  });

  it('does not let a later bounce downgrade a complaint', async () => {
    await suppress(tenant.id, 'angry@example.com', 'complaint', 'reported as spam');
    await suppress(tenant.id, 'angry@example.com', 'hard_bounce', 'user unknown');

    const row = await isSuppressed(tenant.id, 'angry@example.com');
    // A complaint is a statement of intent, not a delivery fact. It outranks.
    expect(row?.reason).toBe('complaint');
  });

  it('withdraws marketing consent on a complaint', async () => {
    await authed('POST', '/v1/contacts', {
      email: 'complainer@example.com',
      marketingConsent: true,
    });

    await suppress(tenant.id, 'complainer@example.com', 'complaint', 'reported');

    const { rows } = await db().query<{ marketing_consent: boolean }>(
      'SELECT marketing_consent FROM contacts WHERE email_normalised = $1',
      ['complainer@example.com'],
    );
    expect(rows[0]!.marketing_consent).toBe(false);
  });

  it('does not restore consent when an address is un-suppressed', async () => {
    await authed('POST', '/v1/contacts', {
      email: 'fixed@example.com',
      marketingConsent: true,
    });
    await suppress(tenant.id, 'fixed@example.com', 'complaint', 'reported');
    await authed('DELETE', `/v1/email/suppressions/${encodeURIComponent('fixed@example.com')}`);

    const { rows } = await db().query<{ marketing_consent: boolean }>(
      'SELECT marketing_consent FROM contacts WHERE email_normalised = $1',
      ['fixed@example.com'],
    );
    // Only the person themselves can give consent back.
    expect(rows[0]!.marketing_consent).toBe(false);
  });
});

describe('consent is re-checked when the message actually goes', () => {
  it('does not send marketing queued before somebody unsubscribed', async () => {
    // A broadcast queues 200 recipients a pass while the queue drains 50, so a
    // large audience spends the best part of an hour waiting. Anyone who
    // clicked unsubscribe during it was mailed anyway.
    setEmailTransport(null);
    outbox().length = 0;

    const created = await authed('POST', '/v1/contacts', {
      email: 'changed-mind@example.com',
      marketingConsent: true,
    });
    const contactId = JSON.parse(created.body).contact_id as string;

    await queueEmail({
      tenantId: tenant.id,
      contactId,
      templateKey: 'promo',
      to: 'changed-mind@example.com',
      subject: 'Our sale',
      html: '<p>Sale</p>',
      dedupeKey: 'late-unsub-1',
      // What makes it marketing.
      unsubscribeUrl: 'https://example.com/n/unsubscribe/tok',
    });

    await db().query(
      'UPDATE contacts SET marketing_consent = false WHERE tenant_id = $1 AND id = $2',
      [tenant.id, contactId],
    );

    await flushEmailQueue(50);

    expect(outbox()).toHaveLength(0);
    const { rows } = await db().query<{ status: string; error: string }>(
      "SELECT status, error FROM email_messages WHERE dedupe_key = 'late-unsub-1'",
    );
    expect(rows[0]!.status).toBe('suppressed');
    // The reason is now whichever answer the preference centre actually holds
    // -- no_consent, paused or topic_off -- rather than one word covering all
    // three, because the send-time re-check asks the same question the queue
    // did instead of only reading the consent flag.
    expect(rows[0]!.error).toMatch(/no_consent/);
  });

  it('still sends a receipt to somebody who unsubscribed from marketing', async () => {
    // Transactional mail carries no unsubscribe URL, and withdrawing marketing
    // consent does not cancel the receipt for something they just did.
    setEmailTransport(null);
    outbox().length = 0;

    const created = await authed('POST', '/v1/contacts', {
      email: 'receipts-only@example.com',
      marketingConsent: false,
    });

    await queueEmail({
      tenantId: tenant.id,
      contactId: JSON.parse(created.body).contact_id as string,
      templateKey: 'order_receipt',
      to: 'receipts-only@example.com',
      subject: 'Your order',
      html: '<p>Thanks</p>',
      dedupeKey: 'receipt-1',
    });

    await flushEmailQueue(50);
    expect(outbox().map((m) => m.to)).toEqual(['receipts-only@example.com']);
  });
});

describe('List-Unsubscribe', () => {
  it('emits both headers, since one without the other is useless', () => {
    const headers = unsubscribeHeaders('https://rewards.example.com/n/unsubscribe/abc');
    expect(headers).toEqual({
      'List-Unsubscribe': '<https://rewards.example.com/n/unsubscribe/abc>',
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    });
  });

  it('adds nothing to a message with no unsubscribe URL', () => {
    expect(unsubscribeHeaders(null)).toBeUndefined();
  });

  it('accepts the one-click POST the header advertises', async () => {
    const app = await testApp();
    const response = await app.inject({
      method: 'POST',
      url: '/n/unsubscribe/sometoken',
      payload: 'List-Unsubscribe=One-Click',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    // A client that shows an unsubscribe button and has its POST rejected is
    // worse than never advertising the header.
    expect(response.statusCode).toBe(200);
  });

  it('suppresses the address on a one-click request unsubscribe', async () => {
    await authed('POST', '/v1/contacts', { email: 'bye@example.com', marketingConsent: true });

    const { unsubscribeRequestUrl } = await import('../src/services/newsletter.js');
    const token = unsubscribeRequestUrl(tenant.id, 'bye@example.com').split('/n/u/')[1]!;

    const app = await testApp();
    await app.inject({ method: 'POST', url: `/n/u/${token}` });

    expect(await isSuppressed(tenant.id, 'bye@example.com')).not.toBeNull();
    const { rows } = await db().query<{ marketing_consent: boolean }>(
      'SELECT marketing_consent FROM contacts WHERE email_normalised = $1',
      ['bye@example.com'],
    );
    expect(rows[0]!.marketing_consent).toBe(false);
  });
});

describe('two workers do not send the same message twice', () => {
  it('claims a message out of the queue rather than leaving it there', async () => {
    // The claim used `FOR UPDATE SKIP LOCKED`, bumped `attempts` and left
    // `status = 'queued'`. Those locks last only as long as the claiming
    // statement, so the next worker's tick matched the same rows and sent
    // every one of them again. One worker never noticed; the shipped compose
    // file runs an API and a separate worker container.
    const sent: string[] = [];
    setEmailTransport({
      async send(message) {
        // Slow enough that the second flush overlaps the first, which is the
        // whole point — two ticks 15 seconds apart overlap whenever a batch
        // takes longer than that.
        await new Promise((resolve) => setTimeout(resolve, 60));
        sent.push(message.to);
        return { providerId: `p-${sent.length}` };
      },
    });

    for (const n of [1, 2, 3]) {
      await queueEmail({
        tenantId: tenant.id,
        templateKey: 'twice',
        to: `twice${n}@example.com`,
        subject: 'Only once',
        html: '<p>Only once</p>',
        dedupeKey: `twice-${n}`,
      });
    }

    await Promise.all([flushEmailQueue(50), flushEmailQueue(50)]);

    expect(sent.sort()).toEqual([
      'twice1@example.com',
      'twice2@example.com',
      'twice3@example.com',
    ]);

    const { rows } = await db().query<{ status: string; attempts: number }>(
      'SELECT status, attempts FROM email_messages WHERE tenant_id = $1 ORDER BY to_email',
      [tenant.id],
    );
    expect(rows.map((row) => row.status)).toEqual(['sent', 'sent', 'sent']);
    // One claim each, not one per worker.
    expect(rows.map((row) => row.attempts)).toEqual([1, 1, 1]);
  });

  it('takes back a message a dead worker left mid-send', async () => {
    setEmailTransport(null);
    outbox().length = 0;

    await queueEmail({
      tenantId: tenant.id,
      templateKey: 'stranded',
      to: 'stranded@example.com',
      subject: 'Still goes',
      html: '<p>Still goes</p>',
      dedupeKey: 'stranded-1',
    });

    // What a worker killed between claiming and sending leaves behind.
    await db().query(
      `UPDATE email_messages
          SET status = 'sending', attempts = 1, claimed_at = now() - interval '1 hour'
        WHERE tenant_id = $1`,
      [tenant.id],
    );

    expect(await flushEmailQueue(50)).toBe(1);
    expect(outbox().map((m) => m.to)).toEqual(['stranded@example.com']);
  });

  it('leaves a message another worker is still sending alone', async () => {
    setEmailTransport(null);
    outbox().length = 0;

    await queueEmail({
      tenantId: tenant.id,
      templateKey: 'inflight',
      to: 'inflight@example.com',
      subject: 'Being sent',
      html: '<p>Being sent</p>',
      dedupeKey: 'inflight-1',
    });
    await db().query(
      `UPDATE email_messages SET status = 'sending', attempts = 1, claimed_at = now()
        WHERE tenant_id = $1`,
      [tenant.id],
    );

    expect(await flushEmailQueue(50)).toBe(0);
    expect(outbox()).toHaveLength(0);
  });
});

describe('a stale worker cannot undo a delivery that already happened', () => {
  it('ignores a late failure from a worker whose claim was taken away', async () => {
    // The stall that produces this is ordinary: nodemailer's default socket
    // timeout is ten minutes, twice the claim window, so a relay that accepts
    // the connection and goes quiet mid-conversation is exactly it. Worker A
    // is still waiting, B reclaims the row and delivers, then A's send finally
    // fails -- and its `WHERE id = $1` wrote 'queued' over B's 'sent'. The
    // next tick sent the message a second time.
    await queueEmail({
      tenantId: tenant.id,
      templateKey: 'stale-writer',
      to: 'stale@example.com',
      subject: 'Exactly once',
      html: '<p>Exactly once</p>',
      dedupeKey: 'stale-writer-1',
    });

    const delivered: string[] = [];
    let releaseWorkerA: (() => void) | null = null;
    const workerAIsSending = new Promise<void>((resolve) => {
      setEmailTransport({
        async send(message) {
          if (releaseWorkerA === null) {
            // Worker A: hangs, then fails, like a relay that went quiet.
            await new Promise<void>((release) => {
              releaseWorkerA = release;
              resolve();
            });
            throw new Error('550 5.7.1 Message blocked');
          }
          delivered.push(message.to);
          return { providerId: `b-${delivered.length}` };
        },
      });
    });

    const workerA = flushEmailQueue(50);
    await workerAIsSending;

    // A's send outlives the claim window, so B is entitled to take the row.
    await db().query(
      `UPDATE email_messages SET claimed_at = now() - interval '6 minutes'
        WHERE tenant_id = $1`,
      [tenant.id],
    );
    expect(await flushEmailQueue(50)).toBe(1);
    expect(delivered).toEqual(['stale@example.com']);

    // Now A's send finally rejects and A writes what it believes happened.
    releaseWorkerA!();
    await workerA;

    const { rows } = await db().query<{ status: string; error: string | null }>(
      'SELECT status, error FROM email_messages WHERE tenant_id = $1',
      [tenant.id],
    );
    expect(rows[0]!.status).toBe('sent');
    expect(rows[0]!.error).toBeNull();

    // And nothing is left for the next tick to send a second time.
    expect(await flushEmailQueue(50)).toBe(0);
    expect(delivered).toEqual(['stale@example.com']);
  });

  it('fails a message whose worker died on every one of its attempts', async () => {
    // Each stale reclaim spends an attempt. Once they ran out, the claim's
    // `attempts < MAX` skipped the row and nothing else looked at `sending`ever
    // again: never sent, never failed, no error, and invisible to the retailer
    // on a queue screen that only counts 'queued' and 'failed'.
    await queueEmail({
      tenantId: tenant.id,
      templateKey: 'stuck',
      to: 'stuck@example.com',
      subject: 'Went nowhere',
      html: '<p>Went nowhere</p>',
      dedupeKey: 'stuck-1',
    });
    // Well past ABANDONED_CLAIM, which is deliberately much wider than the
    // reclaim window: reclaiming early is recoverable, writing a message off
    // is not, and the reaper used to do that to messages that had in fact
    // been delivered.
    await db().query(
      `UPDATE email_messages
          SET status = 'sending', attempts = 99, claimed_at = now() - interval '2 hours'
        WHERE tenant_id = $1`,
      [tenant.id],
    );

    setEmailTransport(null);
    outbox().length = 0;
    expect(await flushEmailQueue(50)).toBe(0);

    const { rows } = await db().query<{ status: string; error: string | null }>(
      'SELECT status, error FROM email_messages WHERE tenant_id = $1',
      [tenant.id],
    );
    expect(rows[0]!.status).toBe('failed');
    expect(rows[0]!.error).toMatch(/stopped responding/i);
  });

  it('does not reap a claim that is merely recent', async () => {
    await queueEmail({
      tenantId: tenant.id,
      templateKey: 'busy',
      to: 'busy@example.com',
      subject: 'In flight',
      html: '<p>In flight</p>',
      dedupeKey: 'busy-1',
    });
    await db().query(
      `UPDATE email_messages SET status = 'sending', attempts = 99, claimed_at = now()
        WHERE tenant_id = $1`,
      [tenant.id],
    );

    await flushEmailQueue(50);

    const { rows } = await db().query<{ status: string }>(
      'SELECT status FROM email_messages WHERE tenant_id = $1',
      [tenant.id],
    );
    expect(rows[0]!.status).toBe('sending');
  });
});

describe('a hung relay is our fault, not the recipient\'s', () => {
  it('reads nodemailer\'s own timeout messages as transport failures', () => {
    // Raised as a bare `Error('Timeout')` with the detail only in `err.code`.
    // Classified on the message alone these looked like the recipient
    // refusing us, so a quiet relay spent the attempt budget and suppressed
    // the address for thirty days.
    expect(classifyFailure('Timeout')).toBe('transport');
    expect(classifyFailure('Timeout (ETIMEDOUT)')).toBe('transport');
    expect(classifyFailure('Greeting never received')).toBe('transport');
    expect(classifyFailure('Connection timeout')).toBe('transport');

    // Still a real refusal when the far end actually says so.
    expect(classifyFailure('550 5.1.1 no such user')).toBe('hard');
  });

  it('gives a blocked address hours to recover, not a quarter of an hour', async () => {
    // 1, 2, 4, 8 minutes spent every attempt inside fifteen minutes, so an
    // afternoon on a blocklist ended in a thirty-day suppression.
    setEmailTransport({
      async send() {
        throw new Error('550 5.7.1 Our system has detected that this message is likely unsolicited mail; blocked');
      },
    });
    await queueEmail({
      tenantId: tenant.id,
      templateKey: 'blocked',
      to: 'blocked@example.com',
      subject: 'Throttled',
      html: '<p>Throttled</p>',
      dedupeKey: 'blocked-1',
    });

    const waits: number[] = [];
    for (let pass = 0; pass < 6; pass += 1) {
      await flushEmailQueue(50);
      const { rows } = await db().query<{ status: string; wait: string }>(
        `SELECT status,
                EXTRACT(EPOCH FROM (next_attempt_at - now()))::int::text AS wait
           FROM email_messages WHERE tenant_id = $1`,
        [tenant.id],
      );
      if (rows[0]!.status === 'failed') break;
      waits.push(Number(rows[0]!.wait));
      await db().query(
        `UPDATE email_messages SET next_attempt_at = now() WHERE tenant_id = $1`,
        [tenant.id],
      );
    }

    // Five backoffs before giving up, and they add up to most of a day rather
    // than to a coffee break.
    expect(waits.length).toBeGreaterThanOrEqual(5);
    expect(waits.reduce((a, b) => a + b, 0)).toBeGreaterThan(17 * 60 * 60);
  });
});

describe('a batch claim is not a licence to send the tail late (HIGH)', () => {
  it('renews the claim per message and drops one taken away mid-batch', async () => {
    // One claim covers fifty rows and stamps them all with the same
    // `claimed_at`, but they are sent serially -- so once total batch time
    // passes the stale window, every row this worker has not reached yet looks
    // abandoned to the other worker while this one still holds it. Measured
    // before the fix: two of three recipients received the campaign twice,
    // both rows ending 'sent' with no error.
    for (const n of [1, 2, 3]) {
      await queueEmail({
        tenantId: tenant.id,
        templateKey: 'campaign',
        to: `batch${n}@example.com`,
        subject: 'Our sale',
        html: '<p>Sale</p>',
        dedupeKey: `batch-${n}`,
      });
    }

    const delivered: string[] = [];
    let handled = 0;
    setEmailTransport({
      async send(message) {
        handled += 1;
        // After the first send, the batch has taken too long and the other
        // worker takes everything this one has not reached.
        if (handled === 1) {
          await db().query(
            `UPDATE email_messages
                SET claimed_at = now() - interval '6 minutes'
              WHERE tenant_id = $1 AND to_email <> $2`,
            [tenant.id, message.to],
          );
          await flushEmailQueue(50);
        }
        delivered.push(message.to);
        return { providerId: `p-${handled}` };
      },
    });

    await flushEmailQueue(50);

    // Everyone got it exactly once.
    expect([...delivered].sort()).toEqual([
      'batch1@example.com',
      'batch2@example.com',
      'batch3@example.com',
    ]);
  });

  it('records a delivery the reaper had already given up on', async () => {
    // The reaper's verdict is a guess about a worker; the send is what
    // actually reached the customer. When they disagree, the customer wins --
    // otherwise the receipt arrives, the queue says failed, and there is no
    // provider id left to trace it at the relay.
    await queueEmail({
      tenantId: tenant.id,
      templateKey: 'receipt',
      to: 'slowbutfine@example.com',
      subject: 'Your order',
      html: '<p>Thanks</p>',
      dedupeKey: 'slow-1',
    });
    await db().query(
      `UPDATE email_messages SET attempts = $2 WHERE tenant_id = $1`,
      [tenant.id, 5],
    );

    let delivered = 0;
    setEmailTransport({
      async send() {
        // While this send is in flight the claim ages out and the other
        // worker's reaper writes the message off.
        await db().query(
          `UPDATE email_messages SET claimed_at = now() - interval '2 hours'
            WHERE tenant_id = $1`,
          [tenant.id],
        );
        await flushEmailQueue(50);
        delivered += 1;
        return { providerId: 'relay-ok' };
      },
    });

    await flushEmailQueue(50);

    expect(delivered).toBe(1);
    const { rows } = await db().query<{
      status: string; provider_id: string | null; error: string | null;
    }>(
      'SELECT status, provider_id, error FROM email_messages WHERE tenant_id = $1',
      [tenant.id],
    );
    expect(rows[0]).toMatchObject({ status: 'sent', provider_id: 'relay-ok', error: null });
  });
});

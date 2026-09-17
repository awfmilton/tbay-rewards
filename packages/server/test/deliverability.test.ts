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
import { classifyFailure, isSuppressed, suppress } from '../src/services/deliverability.js';
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
      '451 4.3.1 Insufficient system storage',
    ]) {
      expect(classifyFailure(message), message).toBe('soft');
    }
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
      'greylisted, try again later',
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

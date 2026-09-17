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

  it('treats a failure about us as transport, not the recipient', () => {
    // These say nothing about whether a mailbox exists, so they must never
    // count toward suppressing one — a relay down for ninety seconds used to
    // suppress every recipient queued at the time.
    for (const message of [
      '451 4.3.0 Temporary server error',
      'ECONNREFUSED',
      '452 4.2.2 Mailbox full',
      'greylisted, try again later',
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
    expect(rows[0]!.error).toMatch(/consent_withdrawn/);
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

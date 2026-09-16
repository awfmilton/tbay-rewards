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
import { unsubscribeHeaders } from '../src/services/email.js';

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

  it('treats anything ambiguous as soft', () => {
    // A false hard bounce silently stops mailing a real customer forever,
    // which is much worse than four more retries at a dead address.
    for (const message of [
      '451 4.3.0 Temporary server error',
      'Connection timed out',
      'ECONNREFUSED',
      '452 4.2.2 Mailbox full',
      'greylisted, try again later',
    ]) {
      expect(classifyFailure(message)).toBe('soft');
    }
  });

  it('spots a complaint but is not fooled by a spam filter score', () => {
    expect(classifyFailure('Message refused: recipient reported as spam')).toBe('complaint');
    // SpamAssassin rejecting on score is a delivery problem, not somebody
    // pressing "this is junk".
    expect(classifyFailure('rejected by SpamAssassin, score 9.1')).toBe('soft');
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

    const app = await testApp();
    await app.inject({
      method: 'POST',
      url: `/n/unsubscribe-request?t=${tenant.id}&email=${encodeURIComponent('bye@example.com')}`,
    });

    expect(await isSuppressed(tenant.id, 'bye@example.com')).not.toBeNull();
    const { rows } = await db().query<{ marketing_consent: boolean }>(
      'SELECT marketing_consent FROM contacts WHERE email_normalised = $1',
      ['bye@example.com'],
    );
    expect(rows[0]!.marketing_consent).toBe(false);
  });
});

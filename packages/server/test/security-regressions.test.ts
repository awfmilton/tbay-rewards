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
import { compileGroup } from '../src/services/segment-filters.js';
import {
  unsubscribeRequestUrl,
  verifyUnsubscribeRequest,
} from '../src/services/newsletter.js';
import { bufferCells, bufferedCounts, droppedCounters, flushCounters } from '../src/services/counters.js';
import { forgetTimezone } from '../src/services/rewards.js';

/**
 * Regression tests for an adversarial review of the surface added after the
 * original security audit. Each one reproduces a specific finding.
 */

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

async function authed(method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) {
  const app = await testApp();
  return app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${tenant.secretKey}` },
    ...(payload === undefined ? {} : { payload }),
  });
}

describe('unsubscribe links are signed (HIGH)', () => {
  it('will not suppress an address from a guessed tenant id', async () => {
    await authed('POST', '/v1/contacts', { email: 'victim@example.com', marketingConsent: true });
    const app = await testApp();

    // The tenant id is printed in the unsubscribe link of every marketing
    // email, so treating it as a secret was the whole vulnerability: anyone
    // with one received message could walk a list and suppress an entire
    // audience.
    const response = await app.inject({
      method: 'POST',
      url: `/n/unsubscribe-request?t=${tenant.id}&email=${encodeURIComponent('victim@example.com')}`,
    });
    expect(response.statusCode).toBe(410);

    const { rows } = await db().query<{ marketing_consent: boolean }>(
      'SELECT marketing_consent FROM contacts WHERE email_normalised = $1',
      ['victim@example.com'],
    );
    expect(rows[0]!.marketing_consent).toBe(true);
    expect(await isSuppressed(tenant.id, 'victim@example.com')).toBeNull();
  });

  it('honours a properly signed link', async () => {
    await authed('POST', '/v1/contacts', { email: 'real@example.com', marketingConsent: true });
    const url = unsubscribeRequestUrl(tenant.id, 'real@example.com');
    const token = url.split('/n/u/')[1]!;

    const app = await testApp();
    const response = await app.inject({ method: 'POST', url: `/n/u/${token}` });
    expect(response.statusCode).toBe(200);

    const { rows } = await db().query<{ marketing_consent: boolean }>(
      'SELECT marketing_consent FROM contacts WHERE email_normalised = $1',
      ['real@example.com'],
    );
    expect(rows[0]!.marketing_consent).toBe(false);
  });

  it('asks before acting on a GET, so a link scanner cannot unsubscribe anyone', async () => {
    await authed('POST', '/v1/contacts', { email: 'scanned@example.com', marketingConsent: true });
    const token = unsubscribeRequestUrl(tenant.id, 'scanned@example.com').split('/n/u/')[1]!;

    const app = await testApp();
    // Safe Links, Proofpoint and the rest fetch every URL in every message.
    const response = await app.inject({ method: 'GET', url: `/n/u/${token}` });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('<form method="post"');

    const { rows } = await db().query<{ marketing_consent: boolean }>(
      'SELECT marketing_consent FROM contacts WHERE email_normalised = $1',
      ['scanned@example.com'],
    );
    expect(rows[0]!.marketing_consent).toBe(true);
  });

  it('rejects a tampered or foreign token', async () => {
    const token = unsubscribeRequestUrl(tenant.id, 'a@example.com').split('/n/u/')[1]!;
    const decoded = decodeURIComponent(token);
    const [body, sig] = decoded.split('.');

    // Swapping the address inside the payload invalidates the signature.
    const forged = Buffer.from(
      JSON.stringify({ t: tenant.id, e: 'someone-else@example.com', k: 'unsub' }),
    ).toString('base64url');

    expect(verifyUnsubscribeRequest(`${forged}.${sig}`)).toBeNull();
    expect(verifyUnsubscribeRequest(`${body}.deadbeef`)).toBeNull();
    expect(verifyUnsubscribeRequest('nonsense')).toBeNull();
  });

  it('will not accept a signed payload minted for another purpose', async () => {
    // A discriminator in the payload, so an attribution cookie or any other
    // signed envelope cannot be replayed at the unsubscribe endpoint.
    const { signPayload } = await import('../src/lib/crypto.js');
    const other = signPayload({ t: tenant.id, e: 'a@example.com', k: 'attribution' });
    expect(verifyUnsubscribeRequest(other)).toBeNull();
  });
});

describe('an outage does not suppress everyone (MEDIUM)', () => {
  it('classifies transport failures apart from bounces', () => {
    for (const message of [
      'connect ECONNREFUSED 10.0.0.5:587',
      'Error: getaddrinfo EAI_AGAIN smtp.example.com',
      '421 4.7.0 Try again later',
      '535 5.7.8 Authentication failed',
      'self-signed certificate in certificate chain',
    ]) {
      expect(classifyFailure(message), message).toBe('transport');
    }
  });

  it('still spots a real hard bounce, and treats a spam rejection as soft', () => {
    expect(classifyFailure('550 5.1.1 User unknown')).toBe('hard');
    // Not a complaint. An SMTP reply mentioning spam is the receiver refusing
    // our message, and reading it as a complaint suppressed the address
    // permanently and withdrew that person's consent — so Gmail blocking our
    // content for an hour took the whole batch off the list. Real complaints
    // arrive out of band.
    expect(classifyFailure('Message refused: recipient reported as spam')).toBe('soft');
  });

  it('lets a repeated-failure suppression lapse rather than lasting forever', async () => {
    await suppress(tenant.id, 'flaky@example.com', 'repeated_failure', 'timeouts');
    const row = await isSuppressed(tenant.id, 'flaky@example.com');
    // A run of soft failures is a guess about a mailbox, not a fact.
    expect(row?.expires_at).not.toBeNull();
  });

  it('keeps a hard bounce permanent', async () => {
    await suppress(tenant.id, 'gone@example.com', 'hard_bounce', 'user unknown');
    expect((await isSuppressed(tenant.id, 'gone@example.com'))?.expires_at).toBeNull();
  });

  it('does not let a lapsing reason downgrade a permanent one', async () => {
    await suppress(tenant.id, 'both@example.com', 'hard_bounce', 'user unknown');
    await suppress(tenant.id, 'both@example.com', 'repeated_failure', 'timeouts');
    expect((await isSuppressed(tenant.id, 'both@example.com'))?.expires_at).toBeNull();
  });
});

describe('segment filters reject rather than crash (LOW)', () => {
  it('answers 400 for a prototype-named field', async () => {
    for (const field of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
      expect(() =>
        compileGroup({ match: 'all', filters: [{ field, operator: 'eq', value: 1 }] }, 'UTC'),
      ).toThrow(/Unknown segment field/);
    }
  });

  it('caps the total number of filters across nested groups', () => {
    const group = {
      match: 'all',
      groups: Array.from({ length: 10 }, () => ({
        match: 'all',
        filters: Array.from({ length: 40 }, () => ({
          field: 'session_count',
          operator: 'is_set',
        })),
      })),
    };
    // Each filter is a correlated subquery re-evaluated over the whole contact
    // table on every rebuild, so the cost lands on the shared database.
    expect(() => compileGroup(group as never, 'UTC')).toThrow(/at most 200 filters/);
  });
});

describe('the counter buffer has a ceiling (MEDIUM)', () => {
  it('drops rather than growing without bound', async () => {
    // Ingest is reachable with the public site key, which is in every page's
    // source, so unbounded growth was a path from a loop to heap exhaustion in
    // the process serving every tenant.
    for (let page = 0; page < 900; page += 1) {
      bufferCells(
        tenant.id,
        `/page-${page}`,
        'desktop',
        'move',
        Array.from({ length: 100 }, (_, i) => ({ x: i % 100, y: page % 200, weight: 1 })),
      );
    }

    expect(bufferedCounts().cells).toBeLessThanOrEqual(80_000);
    expect(droppedCounters()).toBeGreaterThan(0);

    await flushCounters();
  });
});

describe('the ledger CSV is honest (LOW)', () => {
  it('exports more than a thousand rows rather than truncating silently', async () => {
    const contact = JSON.parse(
      (await authed('POST', '/v1/contacts', { email: 'many@example.com' })).body,
    ).contact_id;

    // 1,200 entries: the old clamp returned exactly 1,000 and looked complete.
    const values = Array.from({ length: 1_200 }, (_, i) =>
      `('${tenant.id}','${contact}',1,'entry ${i}','bulk-${i}','cleared',now(),'{}'::jsonb)`,
    ).join(',');
    await db().query(
      `INSERT INTO points_ledger
         (tenant_id, contact_id, delta_points, reason, idempotency_key, status, available_at, meta)
       VALUES ${values}`,
    );

    const response = await authed('GET', '/v1/rewards/ledger.csv');
    expect(response.statusCode).toBe(200);
    // Header plus every row.
    expect(response.body.trim().split('\r\n')).toHaveLength(1_201);
  });

  it('leaves a negative number as a number', async () => {
    const contact = JSON.parse(
      (await authed('POST', '/v1/contacts', { email: 'debit@example.com' })).body,
    ).contact_id;
    await authed('POST', '/v1/rewards/adjust', {
      contactId: contact, points: 500, reason: 'seed', idempotencyKey: 'seed-one',
    });
    await authed('POST', '/v1/rewards/adjust', {
      contactId: contact, points: -50, reason: 'correction', idempotencyKey: 'correction-1',
    });

    const body = (await authed('GET', '/v1/rewards/ledger.csv')).body;
    // `'-50` is not a number in any spreadsheet, which defeats the one thing
    // the export is for.
    expect(body).toContain(',-50,');
    expect(body).not.toContain("'-50");
  });

  it('still neutralises a real formula', async () => {
    const contact = JSON.parse(
      (await authed('POST', '/v1/contacts', { email: 'formula@example.com' })).body,
    ).contact_id;
    await authed('POST', '/v1/rewards/adjust', {
      contactId: contact, points: 10, reason: '=1+1', idempotencyKey: 'formula-1',
    });

    expect((await authed('GET', '/v1/rewards/ledger.csv')).body).toContain("'=1+1");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Second adversarial review — the myCred-parity surface
// ─────────────────────────────────────────────────────────────────────────────

describe('a tenant cannot name another tenant’s contact (HIGH)', () => {
  it('refuses a foreign contactId on /v1/orders instead of writing the rows anyway', async () => {
    const other = await makeTenant();
    const app = await testApp();

    const victim = JSON.parse(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/contacts',
          headers: { authorization: `Bearer ${other.secretKey}` },
          payload: { email: 'victim@other.example', name: 'Victim' },
        })
      ).body,
    ).contact_id as string;

    const res = await authed('POST', '/v1/orders', {
      orderRef: 'cross-1',
      totalCents: 10_000,
      contactId: victim,
    });
    expect(res.statusCode).toBe(404);

    // The old bug returned 404 *after* committing: the route's own contact
    // check ran once recordOrder's transaction had already closed.
    const ledger = await db().query(
      'SELECT id FROM points_ledger WHERE contact_id = $1',
      [victim],
    );
    expect(ledger.rows).toHaveLength(0);

    const balances = await db().query(
      'SELECT contact_id FROM points_balances WHERE contact_id = $1',
      [victim],
    );
    expect(balances.rows).toHaveLength(0);
  });

  it('keeps the database from accepting such a row even if a caller slips past', async () => {
    const other = await makeTenant();
    const victim = JSON.parse(
      (
        await (await testApp()).inject({
          method: 'POST',
          url: '/v1/contacts',
          headers: { authorization: `Bearer ${other.secretKey}` },
          payload: { email: 'fk@other.example' },
        })
      ).body,
    ).contact_id as string;

    // Straight past the service layer: the composite foreign key is the thing
    // under test, not the application check above it.
    await expect(
      db().query(
        `INSERT INTO points_ledger (tenant_id, contact_id, delta_points, reason, idempotency_key)
         VALUES ($1, $2, 100, 'Forced', 'forced-cross-tenant')`,
        [tenant.id, victim],
      ),
    ).rejects.toThrow(/foreign key/i);
  });

  it('does not leak another tenant’s name and email through the ledger join', async () => {
    const other = await makeTenant();
    const app = await testApp();
    const victim = JSON.parse(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/contacts',
          headers: { authorization: `Bearer ${other.secretKey}` },
          payload: { email: 'private@other.example', name: 'Private Person' },
        })
      ).body,
    ).contact_id as string;

    await app.inject({
      method: 'POST',
      url: '/v1/rewards/adjust',
      headers: { authorization: `Bearer ${other.secretKey}` },
      payload: { contactId: victim, points: 10, reason: 'Theirs', idempotencyKey: 'leak-1' },
    });

    const body = JSON.parse((await authed('GET', `/v1/rewards/ledger?contactId=${victim}`)).body);
    expect(body.entries).toHaveLength(0);
    expect(JSON.stringify(body)).not.toContain('private@other.example');
    expect(JSON.stringify(body)).not.toContain('Private Person');
  });
});

describe('the public site key cannot rewrite a known customer (MEDIUM)', () => {
  // The site key is in every page's source, so anyone who can view source
  // holds it. Knowing a customer's email was enough to rewrite the retailer's
  // own record of them — and to add tags, which drive segments, which drive
  // broadcasts and the visibility of conditional email blocks.
  const identify = async (body: Record<string, unknown>) =>
    (await testApp()).inject({
      method: 'POST',
      url: '/v1/identify',
      headers: { 'x-tbay-key': tenant.publicKey },
      payload: { key: tenant.publicKey, ...body },
    });

  it('leaves the fields the store already has alone', async () => {
    await authed('POST', '/v1/contacts', {
      email: 'known@example.com',
      name: 'Real Name',
      phone: '111',
      tags: ['customer'],
    });

    const res = await identify({
      email: 'known@example.com',
      name: 'HACKED',
      phone: '66666',
      tags: ['vip'],
      attributes: { plan: 'injected' },
    });
    expect(res.statusCode).toBe(200);

    const { rows } = await db().query<{
      name: string; phone: string; tags: string[]; attributes: Record<string, unknown>;
    }>(
      "SELECT name, phone, tags, attributes FROM contacts WHERE email_normalised = 'known@example.com'",
    );
    expect(rows[0]!.name).toBe('Real Name');
    expect(rows[0]!.phone).toBe('111');
    expect(rows[0]!.tags).toEqual(['customer']);
    expect(rows[0]!.attributes.plan).toBeUndefined();
  });

  it('still fills in what the store does not have', async () => {
    // The case this endpoint exists for: somebody logs in for the first time.
    await authed('POST', '/v1/contacts', { email: 'blank@example.com' });

    await identify({ email: 'blank@example.com', name: 'First Login', phone: '222' });

    const { rows } = await db().query<{ name: string; phone: string }>(
      "SELECT name, phone FROM contacts WHERE email_normalised = 'blank@example.com'",
    );
    expect(rows[0]!.name).toBe('First Login');
    expect(rows[0]!.phone).toBe('222');
  });

  it('still introduces somebody the store has never seen', async () => {
    const res = await identify({ email: 'brand-new@example.com', name: 'New Person' });
    expect(res.statusCode).toBe(200);

    const { rows } = await db().query<{ name: string }>(
      "SELECT name FROM contacts WHERE email_normalised = 'brand-new@example.com'",
    );
    expect(rows[0]!.name).toBe('New Person');
  });

  it('cannot switch a known customer\'s marketing consent off', async () => {
    // A subscribe form passes its list's default, which for a double-opt-in
    // list is `false`. Unguarded, that meant an unauthenticated request naming
    // a known customer's address dropped them out of every campaign and
    // rewrote the field recording how they consented in the first place.
    await authed('POST', '/v1/contacts', {
      email: 'consenting@example.com',
      marketingConsent: true,
      consentSource: 'store_import',
    });

    await (await testApp()).inject({
      method: 'POST',
      url: '/v1/newsletter/subscribe',
      headers: { 'x-tbay-key': tenant.publicKey },
      payload: { key: tenant.publicKey, email: 'consenting@example.com' },
    });

    const { rows } = await db().query<{ marketing_consent: boolean; consent_source: string }>(
      `SELECT marketing_consent, consent_source FROM contacts
        WHERE email_normalised = 'consenting@example.com'`,
    );
    expect(rows[0]!.marketing_consent).toBe(true);
    expect(rows[0]!.consent_source).toBe('store_import');
  });

  it('still lets a single opt-in form grant consent', async () => {
    // The other direction has to keep working: a form on a single-opt-in list
    // is somebody asking to be mailed.
    await authed('POST', '/v1/contacts', {
      email: 'willing@example.com',
      marketingConsent: false,
    });
    await db().query('UPDATE lists SET double_optin = false WHERE tenant_id = $1', [tenant.id]);

    await (await testApp()).inject({
      method: 'POST',
      url: '/v1/newsletter/subscribe',
      headers: { 'x-tbay-key': tenant.publicKey },
      payload: { key: tenant.publicKey, email: 'willing@example.com' },
    });

    const { rows } = await db().query<{ marketing_consent: boolean }>(
      "SELECT marketing_consent FROM contacts WHERE email_normalised = 'willing@example.com'",
    );
    expect(rows[0]!.marketing_consent).toBe(true);
  });

  it('applies the same rule to the newsletter form', async () => {
    await authed('POST', '/v1/contacts', { email: 'sub@example.com', name: 'Subscriber' });
    await (await testApp()).inject({
      method: 'POST',
      url: '/v1/newsletter/subscribe',
      headers: { 'x-tbay-key': tenant.publicKey },
      payload: { key: tenant.publicKey, email: 'sub@example.com', name: 'OVERWRITTEN' },
    });

    const { rows } = await db().query<{ name: string }>(
      "SELECT name FROM contacts WHERE email_normalised = 'sub@example.com'",
    );
    expect(rows[0]!.name).toBe('Subscriber');
  });
});

describe('the public site key cannot rewrite reward roles (HIGH)', () => {
  const identify = async (attributes: unknown) =>
    (await testApp()).inject({
      method: 'POST',
      url: '/v1/identify',
      payload: { key: tenant.publicKey, email: 'staff@example.com', attributes },
    });

  const rolesOf = async () =>
    (
      await db().query(
        `SELECT attributes -> 'roles' AS roles FROM contacts
          WHERE tenant_id = $1 AND email = 'staff@example.com'`,
        [tenant.id],
      )
    ).rows[0]?.roles;

  beforeEach(async () => {
    const excluded = await authed('POST', '/v1/rewards/exclusions', {
      kind: 'role',
      value: 'administrator',
    });
    expect(excluded.statusCode).toBe(200);
    await authed('POST', '/v1/contacts', {
      email: 'staff@example.com',
      attributes: { roles: ['administrator'] },
    });
  });

  it('will not clear an exclusion role to start earning again', async () => {
    expect((await identify({ roles: [] })).statusCode).toBe(200);
    expect(await rolesOf()).toEqual(['administrator']);

    // Still excluded, so an order for them still earns nothing.
    const order = JSON.parse(
      (await authed('POST', '/v1/orders', {
        orderRef: 'staff-1',
        totalCents: 10_000,
        email: 'staff@example.com',
      })).body,
    );
    expect(order.points_awarded).toBe(0);
  });

  it('writes no attribute at all onto a contact the store already has', async () => {
    // Stronger than stripping the reserved key: attributes drive segments the
    // same way tags do, so an unauthenticated assertion about somebody the
    // store already knows changes nothing about them.
    expect((await identify({ roles: [], plan: 'gold' })).statusCode).toBe(200);
    expect(await rolesOf()).toEqual(['administrator']);

    const { rows } = await db().query(
      `SELECT attributes ->> 'plan' AS plan FROM contacts
        WHERE tenant_id = $1 AND email = 'staff@example.com'`,
      [tenant.id],
    );
    expect(rows[0]!.plan).toBeNull();
  });

  it('still carries attributes when it introduces somebody new', async () => {
    // The first-touch case this endpoint exists for. There is no prior record
    // to corrupt, and `roles` is still stripped.
    await (await testApp()).inject({
      method: 'POST',
      url: '/v1/identify',
      payload: {
        key: tenant.publicKey,
        email: 'fresh@example.com',
        attributes: { roles: ['administrator'], plan: 'gold' },
      },
    });

    const { rows } = await db().query(
      `SELECT attributes ->> 'plan' AS plan, attributes -> 'roles' AS roles
         FROM contacts WHERE tenant_id = $1 AND email = 'fresh@example.com'`,
      [tenant.id],
    );
    expect(rows[0]!.plan).toBe('gold');
    expect(rows[0]!.roles).toBeNull();
  });

  it('survives a roles value that is not an array, whatever wrote it', async () => {
    // The public endpoint can no longer send this, but a retailer's own
    // integration can through /v1/contacts — and it used to take down every
    // order for that customer with "cannot extract elements from a scalar".
    await authed('POST', '/v1/contacts', {
      email: 'staff@example.com',
      attributes: { roles: 'administrator' },
    });

    const order = await authed('POST', '/v1/orders', {
      orderRef: 'scalar-1',
      totalCents: 10_000,
      email: 'staff@example.com',
    });
    expect(order.statusCode).toBe(200);
    // A non-array reads as no roles at all, so the exclusion no longer matches
    // and they earn — wrong-ish, but a retailer's own data error, and vastly
    // better than 500ing every checkout.
    expect(JSON.parse(order.body).points_awarded).toBeGreaterThan(0);

    // And the leaderboard, which evaluates the same predicate per row.
    const board = await authed('GET', '/v1/rewards/leaderboard');
    expect(board.statusCode).toBe(200);
  });
});

describe('bad input is a 400, not a 500 (LOW)', () => {
  it('rejects a non-uuid contactId instead of letting Postgres raise', async () => {
    for (const url of [
      '/v1/rewards/ledger?contactId=not-a-uuid',
      '/v1/rewards/leaderboard?contactId=not-a-uuid',
      '/v1/rewards/exclusions/not-a-uuid',
    ]) {
      const method = url.includes('exclusions') ? 'DELETE' : 'GET';
      const res = await (await testApp()).inject({
        method,
        url,
        headers: { authorization: `Bearer ${tenant.secretKey}` },
      });
      expect(res.statusCode, url).toBe(400);
    }
  });

  it('refuses an order total large enough to overflow the ledger', async () => {
    // Unbounded, this multiplied out to more than a signed integer and the
    // whole order transaction rolled back with "integer out of range" — the
    // store lost the order record, not just the points.
    const res = await authed('POST', '/v1/orders', {
      orderRef: 'huge-1',
      totalCents: 999_999_999_999,
    });
    expect(res.statusCode).toBe(400);
  });

  it('calls a malformed body the caller\'s mistake, not the server\'s', async () => {
    // Fastify raises its own 400 for these; the handler fell through to the
    // 500 branch and told every caller with a trailing comma that the server
    // had broken.
    for (const payload of ['{"email":', '', '[1,2']) {
      const res = await (await testApp()).inject({
        method: 'POST',
        url: '/v1/contacts',
        headers: {
          authorization: `Bearer ${tenant.secretKey}`,
          'content-type': 'application/json',
        },
        payload,
      });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(JSON.parse(res.body).error).toBe('bad_request');
    }
  });

  it('names the field when a date will not parse', async () => {
    // Unchecked, the string reached Postgres and came back as "invalid input
    // syntax for type timestamp with time zone" — a 500 for a caller's typo.
    const cases: Array<[string, string, Record<string, unknown>]> = [
      ['POST', '/v1/orders', { orderRef: 'bad-date-1', totalCents: 100, placedAt: 'yesterday' }],
      ['PUT', '/v1/broadcasts/bad_date', { name: 'x', subject: 'y', sendAt: 'soon',
        blocks: [{ type: 'text', text: 'hi' }] }],
    ];
    for (const [method, url, payload] of cases) {
      const res = await authed(method as 'POST' | 'PUT', url, payload);
      expect(res.statusCode, url).toBe(400);
      const details = JSON.parse(res.body).details as Array<{ field: string }>;
      expect(details.some((d) => d.field === 'placedAt' || d.field === 'sendAt'), url).toBe(true);
    }
  });

  it('treats a search term as text, not as a wildcard pattern', async () => {
    const contact = JSON.parse(
      (await authed('POST', '/v1/contacts', { email: 'search@example.com' })).body,
    ).contact_id;

    await authed('POST', '/v1/rewards/adjust', {
      contactId: contact, points: 10, reason: '10xoff', idempotencyKey: 'search-1',
    });
    await authed('POST', '/v1/rewards/adjust', {
      contactId: contact, points: 10, reason: '10_off', idempotencyKey: 'search-2',
    });

    const body = JSON.parse((await authed('GET', '/v1/rewards/ledger?search=10_off')).body);
    expect(body.entries.map((entry: { reason: string }) => entry.reason)).toEqual(['10_off']);
  });
});

describe('a bad tenant timezone does not abort the transaction (MEDIUM)', () => {
  it('records the order instead of rolling it back once a minute forever', async () => {
    // A zone Postgres does not know used to be discovered by running
    // `SELECT now() AT TIME ZONE $1` inside the caller's transaction. The
    // catch around it set 'UTC', but the raise had already aborted the
    // transaction, so the award, the order row, its commissions and its cart
    // conversion all went with it.
    await db().query('UPDATE tenants SET timezone = $2 WHERE id = $1', [
      tenant.id,
      'Mars/Olympus_Mons',
    ]);
    forgetTimezone(tenant.id);

    const res = await authed('POST', '/v1/orders', {
      orderRef: 'tz-1',
      totalCents: 10_000,
      email: 'tz@example.com',
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).points_awarded).toBeGreaterThan(0);
  });

  it('refuses to store an unknown zone in the first place', async () => {
    const { createTenant } = await import('../src/services/tenants.js');
    await expect(
      createTenant({ slug: `tz-bad-${Date.now()}`, name: 'Bad zone', timezone: 'Mars/Olympus_Mons' }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('an idempotency key names one operation (LOW)', () => {
  it('will not report success for an award wearing another award’s key', async () => {
    const first = JSON.parse(
      (await authed('POST', '/v1/contacts', { email: 'key-a@example.com' })).body,
    ).contact_id;
    const second = JSON.parse(
      (await authed('POST', '/v1/contacts', { email: 'key-b@example.com' })).body,
    ).contact_id;

    await authed('POST', '/v1/rewards/adjust', {
      contactId: first, points: 100, reason: 'Theirs', idempotencyKey: 'shared-key',
    });

    // Same key, different contact. This used to return 200 "applied" with
    // nobody's balance having changed.
    const res = await authed('POST', '/v1/rewards/adjust', {
      contactId: second, points: 100, reason: 'Mine', idempotencyKey: 'shared-key',
    });
    expect(res.statusCode).toBe(409);
  });
});

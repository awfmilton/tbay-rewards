import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import {
  DESKTOP_UA,
  ids,
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

describe('a referral means somebody new (HIGH)', () => {
  /**
   * `/v1/identify` takes the public site key — the one in every page's source
   * — and any email address the caller types. A member's own referral link,
   * clicked by the attacker, then identified as an existing customer, attached
   * a referral to that customer and paid the member for "introducing" somebody
   * the store had known for years. The whole customer list could be harvested
   * that way, one address at a time.
   */
  const clickThenIdentify = async (anonId: string, linkCode: string, email: string) => {
    const app = await testApp();
    await app.inject({
      method: 'POST',
      url: '/v1/collect',
      headers: { 'x-tbay-key': tenant.publicKey },
      payload: {
        key: tenant.publicKey,
        visitor: anonId,
        session: `s-${anonId}`,
        url: `https://shop.example.com/?tb_ref=${linkCode}`,
        linkCode,
        events: [{ type: 'pageview', url: `https://shop.example.com/?tb_ref=${linkCode}` }],
      },
    });
    return app.inject({
      method: 'POST',
      url: '/v1/identify',
      headers: { 'x-tbay-key': tenant.publicKey },
      payload: { key: tenant.publicKey, visitor: anonId, email },
    });
  };

  const referralsFor = async (email: string): Promise<number> => {
    const { rows } = await db().query<{ n: string }>(
      `SELECT count(*) AS n FROM referrals r
         JOIN contacts c ON c.id = r.referee_contact_id
        WHERE r.tenant_id = $1 AND c.email_normalised = $2`,
      [tenant.id, email],
    );
    return Number(rows[0]!.n);
  };

  it('is not attached to a customer the store already had', async () => {
    const member = JSON.parse(
      (await authed('POST', '/v1/contacts', { email: 'referrer@example.com' })).body,
    ).contact_id as string;
    const link = JSON.parse(
      (await authed('POST', '/v1/links', {
        kind: 'referral',
        ownerContactId: member,
        targetUrl: 'https://shop.example.com/',
        label: 'refer a friend',
      })).body,
    );
    const code = link.link?.code ?? link.code;

    await authed('POST', '/v1/contacts', { email: 'longstanding@example.com' });
    await db().query(
      "UPDATE contacts SET created_at = now() - interval '2 years' WHERE email_normalised = 'longstanding@example.com'",
    );

    expect((await clickThenIdentify('attacker', code, 'longstanding@example.com')).statusCode)
      .toBe(200);
    expect(await referralsFor('longstanding@example.com')).toBe(0);
  });

  it('is still attached to somebody the link actually brought', async () => {
    const member = JSON.parse(
      (await authed('POST', '/v1/contacts', { email: 'referrer@example.com' })).body,
    ).contact_id as string;
    const link = JSON.parse(
      (await authed('POST', '/v1/links', {
        kind: 'referral',
        ownerContactId: member,
        targetUrl: 'https://shop.example.com/',
        label: 'refer a friend',
      })).body,
    );
    const code = link.link?.code ?? link.code;

    // Never seen before: the contact is created by the identify itself.
    expect((await clickThenIdentify('newcomer', code, 'brand-new@example.com')).statusCode)
      .toBe(200);
    expect(await referralsFor('brand-new@example.com')).toBe(1);
  });
});

describe('ingest rate limiting cannot be rotated away (HIGH)', () => {
  /**
   * Both keys the limiter used to reach for are written by the caller. The
   * visitor id comes straight out of the request body, and X-Forwarded-For is
   * a header anyone can send -- nginx's $proxy_add_x_forwarded_for appends the
   * peer address to whatever arrived rather than replacing it, so the
   * left-hand entries are the client's own claim. Rotating either one bought
   * unlimited throughput: measured at 800/800 requests through a 600/minute
   * bucket.
   */
  // `visitor`, because that is the field the tracker and the collect schema
  // use. An earlier version of this suite sent `anonId` -- a name that appears
  // nowhere else in the product -- and so did the limiter, which is why both
  // agreed with each other and neither agreed with a real request.
  const collect = (
    visitor: string | null,
    forwardedFor: string,
  ) => ({
    method: 'POST' as const,
    url: '/v1/collect',
    headers: { 'x-tbay-key': tenant.publicKey, 'x-forwarded-for': forwardedFor },
    payload: {
      ...(visitor === null ? {} : { visitor, session: `${visitor}-session` }),
      url: 'https://shop.example/p',
      events: [{ type: 'pageview', url: 'https://shop.example/p' }],
    },
  });

  async function countAllowed(
    requests: number,
    key: (n: number) => { visitor: string | null; forwardedFor: string },
  ) {
    const app = await testApp();
    let allowed = 0;
    for (let n = 0; n < requests; n += 1) {
      const { visitor, forwardedFor } = key(n);
      const response = await app.inject(collect(visitor, forwardedFor));
      if (response.statusCode !== 429) allowed += 1;
    }
    return allowed;
  }

  it('still gives one steady visitor their own bucket', async () => {
    const steady = await countAllowed(650, () => ({
      visitor: 'steady-visitor',
      forwardedFor: '198.51.100.7, 10.0.0.1',
    }));

    expect(steady).toBe(600);
  });

  it('caps a visitor who rotates their visitor id at the address ceiling', async () => {
    // A fresh id per request no longer opens a fresh allowance; it spends the
    // address ceiling instead, which is the part of the key the caller does
    // not get to choose. Before this, all 3,200 went through.
    const rotating = await countAllowed(3_200, (n) => ({
      visitor: `rotating-visitor-${n}`,
      forwardedFor: '198.51.100.8, 10.0.0.1',
    }));

    expect(rotating).toBe(3_000);
  });

  it('does not mint a new bucket per spoofed X-Forwarded-For entry', async () => {
    // Every request claims a different origin address, but the entry the proxy
    // itself appended is the same throughout, and that is the one that counts.
    //
    // The visitor id is held constant on purpose: the address is part of the
    // *visitor* key too, so if the caller's claimed address were the one used,
    // one steady visitor rotating X-Forwarded-For would open a fresh
    // per-visitor bucket on every request and all 3,200 would go through. Held
    // constant, this measures the address and nothing else.
    const spoofing = await countAllowed(3_200, (n) => ({
      visitor: 'steadfast-visitor',
      forwardedFor: `203.0.113.${n % 250}, 10.0.0.2`,
    }));

    expect(spoofing).toBe(600);
  });

  it('gives a caller who sends no visitor one visitor-sized share (HIGH)', async () => {
    // Sending nothing the limiter can read used to mean no per-visitor bucket
    // at all, so that caller answered only to the per-address ceiling -- and
    // on a shared address they could spend every colleague's allowance, which
    // is precisely what the subdivision exists to stop. Padding the GET
    // beacon's `d` past its cap reached the same place, as did any honest
    // tracker batch over 8 KB.
    const anonymous = await countAllowed(1_200, () => ({
      visitor: null,
      forwardedFor: '203.0.113.9, 10.0.0.3',
    }));

    expect(anonymous).toBe(600);

    // And a colleague on the same address still has their own share, rather
    // than finding it spent by the caller with no id. (1,200 requests, not
    // 3,200: the per-address ceiling counts every attempt including the
    // rejected ones, and exhausting it stops everybody by design -- that is
    // the ceiling doing its job, not the subdivision failing at it.)
    const colleague = await countAllowed(650, () => ({
      visitor: 'colleague-visitor',
      forwardedFor: '203.0.113.9, 10.0.0.3',
    }));
    expect(colleague).toBe(600);
  });

  it('keeps genuinely separate addresses on separate buckets', async () => {
    // The NAT case the per-visitor bucket exists for: the ceiling is shared,
    // but one heavy visitor must not spend a colleague's allowance.
    const heavy = await countAllowed(650, () => ({
      visitor: 'heavy-visitor',
      forwardedFor: '198.51.100.9, 10.0.0.3',
    }));
    expect(heavy).toBe(600);

    const colleague = await countAllowed(10, () => ({
      visitor: 'colleague-visit',
      forwardedFor: '198.51.100.9, 10.0.0.3',
    }));
    expect(colleague).toBe(10);
  });
});

describe('the site key may introduce, not restate (MEDIUM)', () => {
  /**
   * The product details on an event come from the page it was sent from --
   * which means from whoever sent the request, since the key authorising it is
   * in every page's source. Allowed to overwrite, that is the retailer's
   * catalogue: their product names, their prices, the images their dashboard
   * renders, and their categories, which reward rules match on and which
   * therefore decide what a product earns.
   */
  async function collect(product: Record<string, unknown>) {
    const app = await testApp();
    return app.inject({
      method: 'POST',
      url: '/v1/collect',
      // A real user agent: ingest skips product handling for bots, and no
      // header at all reads as one.
      headers: { 'x-tbay-key': tenant.publicKey, 'user-agent': DESKTOP_UA },
      payload: {
        ...ids(),
        url: 'https://shop.example/p/1',
        events: [{ type: 'product_view', productRef: 'SKU-1', product }],
      },
    });
  }

  async function storedProduct() {
    const { rows } = await db().query<{
      name: string | null; price_cents: number | null; categories: string[];
    }>(
      'SELECT name, price_cents, categories FROM products WHERE tenant_id = $1 AND product_ref = $2',
      [tenant.id, 'SKU-1'],
    );
    return rows[0]!;
  }

  it('creates a product nobody has seen before', async () => {
    await collect({ name: 'Red Mug', priceCents: 1_200, categories: ['kitchen'] });

    expect(await storedProduct()).toMatchObject({
      name: 'Red Mug',
      price_cents: 1_200,
      categories: ['kitchen'],
    });
  });

  it('cannot rewrite one the store already has', async () => {
    await authed('PUT', '/v1/products/SKU-1', {
      name: 'Red Mug', priceCents: 1_200, categories: ['kitchen'],
    });

    await collect({ name: 'Free Mug', priceCents: 1, categories: ['clearance'] });

    // Categories especially: reward rules match on them.
    expect(await storedProduct()).toMatchObject({
      name: 'Red Mug',
      price_cents: 1_200,
      categories: ['kitchen'],
    });
  });

  it('lets the storefront correct it over the secret key', async () => {
    await collect({ name: 'Red Mug', priceCents: 1_200, categories: ['kitchen'] });

    const response = await authed('PUT', '/v1/products/SKU-1', {
      name: 'Red Mug (2024)', priceCents: 1_500, categories: ['kitchen', 'gifts'],
    });

    expect(response.statusCode).toBe(200);
    expect(await storedProduct()).toMatchObject({
      name: 'Red Mug (2024)',
      price_cents: 1_500,
      categories: ['kitchen', 'gifts'],
    });
  });
});

describe('a link owner has to be one of ours (MEDIUM)', () => {
  it('refuses a contact id belonging to another retailer', async () => {
    // `links.owner_contact_id` is a plain foreign key into a platform-wide
    // table, so a uuid from someone else's store was accepted -- and every
    // commission the link earned was booked against a stranger's customer.
    const other = await makeTenant();
    const app = await testApp();
    const stranger = JSON.parse(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/contacts',
          headers: { authorization: `Bearer ${other.secretKey}` },
          payload: { email: 'stranger@example.com' },
        })
      ).body,
    );

    const response = await authed('POST', '/v1/links', {
      targetUrl: 'https://shop.example/p/1',
      kind: 'writer',
      ownerContactId: stranger.contact_id ?? stranger.id,
    });

    expect(response.statusCode).toBe(404);
  });

  it('still accepts one of our own', async () => {
    const created = JSON.parse((await authed('POST', '/v1/contacts', { email: 'ours@example.com' })).body);

    const response = await authed('POST', '/v1/links', {
      targetUrl: 'https://shop.example/p/1',
      kind: 'writer',
      ownerContactId: created.contact_id ?? created.id,
    });

    expect(response.statusCode).toBe(200);
  });
});

describe('the client address is only as trusted as the deployment (HIGH)', () => {
  /**
   * TRUST_PROXY_HOPS used to default to 1, matching the nginx block in the
   * deployment doc. Every other topology -- a container exposed directly, a
   * developer running it on a laptop, anything behind a load balancer that
   * replaces rather than appends -- then trusted a header the caller wrote,
   * and the address in the rate limiter, the audit log and consent records was
   * whatever they typed. Measured: 1,200 requests through a 600 bucket by
   * editing one header.
   *
   * The default is 0 now. It costs accuracy behind a proxy that is not
   * configured, which is visible and fixable; the old default cost the
   * guarantee, which was neither.
   */
  it('defaults to trusting nothing', async () => {
    const { DEFAULT_TRUST_PROXY_HOPS, config } = await import('../src/config.js');

    expect(DEFAULT_TRUST_PROXY_HOPS).toBe(0);
    // And this suite's own value is set on purpose in helpers.ts, not
    // inherited -- the tests below mean "behind exactly one proxy".
    expect(config().security.trustProxyHops).toBe(1);
  });

  it('counts hops from this process outwards', async () => {
    // With one appending proxy, the rightmost entry is the only one nginx
    // wrote; everything to its left is the caller talking. Measured by
    // exhausting a bucket rather than by sending two requests and checking
    // they were accepted -- which an earlier version of this test did, and
    // which holds for every value of trustProxyHops, including the
    // over-trusting ones it claimed to detect.
    const app = await testApp();
    let allowed = 0;
    for (let n = 0; n < 700; n += 1) {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/collect',
        headers: {
          'x-tbay-key': tenant.publicKey,
          // The left-hand entry changes every time. If it were trusted, each
          // request would look like a different address and open its own
          // per-visitor bucket.
          'x-forwarded-for': `203.0.113.${n % 250}, 10.0.0.42`,
        },
        payload: {
          visitor: 'hops-visitor',
          session: 'hops-session',
          url: 'https://shop.example/p',
          events: [{ type: 'pageview', url: 'https://shop.example/p' }],
        },
      });
      if (response.statusCode !== 429) allowed += 1;
    }

    // One bucket, one allowance. Over-trusting reads 700.
    expect(allowed).toBe(600);
  });
});

describe('the site key cannot set categories on a product the store knows (MEDIUM)', () => {
  it('leaves an empty category list empty rather than treating it as unset', async () => {
    // "Empty means unset, so filling it is allowed" sounded consistent with
    // the other fill-only columns and was the opposite of safe: the tracker is
    // what introduces products, and it introduces them with no categories, so
    // the unprotected state was the normal one. Reward rules match on
    // categories, so anyone with the site key -- it is in every page's source
    // -- decided what an already-known product earned.
    const app = await testApp();
    const sighting = (categories: string[]) =>
      app.inject({
        method: 'POST',
        url: '/v1/collect',
        headers: { 'x-tbay-key': tenant.publicKey, 'user-agent': DESKTOP_UA },
        payload: {
          ...ids(),
          url: 'https://shop.example/p/2',
          events: [
            {
              type: 'product_view',
              productRef: 'SKU-CAT',
              product: { name: 'Canvas Print', priceCents: 4_999, categories },
            },
          ],
        },
      });

    // First sighting, as the tracker does it: no categories.
    await sighting([]);
    // Second sighting, with categories the caller chose.
    await sighting(['clearance', 'double-points']);

    const { rows } = await db().query<{ categories: string[] }>(
      'SELECT categories FROM products WHERE tenant_id = $1 AND product_ref = $2',
      [tenant.id, 'SKU-CAT'],
    );
    expect(rows[0]!.categories).toEqual([]);

    // The storefront still sets them, over the secret key.
    await authed('PUT', '/v1/products/SKU-CAT', { categories: ['wall-art'] });
    const { rows: after } = await db().query<{ categories: string[] }>(
      'SELECT categories FROM products WHERE tenant_id = $1 AND product_ref = $2',
      [tenant.id, 'SKU-CAT'],
    );
    expect(after[0]!.categories).toEqual(['wall-art']);
  });
});

describe('the GET beacon gets a per-visitor bucket too (MEDIUM)', () => {
  it('reads the visitor out of the packed payload', async () => {
    // `/v1/collect` also accepts its whole payload base64url-encoded in `d`,
    // for environments that block POST beacons. The limiter reads the body,
    // and a GET has none -- so one visitor on that path got the full
    // per-address ceiling instead of their own share, and the half of the
    // rate-limit fix that was announced as done was done for one of the two
    // routes.
    const app = await testApp();
    const packed = Buffer.from(
      JSON.stringify({
        visitor: 'beacon-visitor',
        session: 'beacon-session',
        url: 'https://shop.example/p',
        events: [{ type: 'pageview', url: 'https://shop.example/p' }],
      }),
    ).toString('base64url');

    let allowed = 0;
    for (let n = 0; n < 650; n += 1) {
      const response = await app.inject({
        method: 'GET',
        url: `/v1/collect?d=${packed}`,
        headers: { 'x-tbay-key': tenant.publicKey, 'x-forwarded-for': '198.51.100.20, 10.0.0.5' },
      });
      if (response.statusCode !== 429) allowed += 1;
    }

    expect(allowed).toBe(600);
  });

  it('cannot be made anonymous by padding the payload (HIGH)', async () => {
    // The limiter gave up on `d` past 8,192 characters and then skipped the
    // per-visitor bucket entirely, so the request answered only to the
    // per-address ceiling -- five times larger. Trailing whitespace is legal
    // JSON and the handler accepts it, so one space per request was the whole
    // attack.
    const app = await testApp();
    const payload = {
      visitor: 'padded-visitor',
      session: 'padded-session',
      url: 'https://shop.example/p',
      events: [{ type: 'pageview', url: 'https://shop.example/p' }],
    };
    const padded = Buffer.from(`${JSON.stringify(payload)}${' '.repeat(12_000)}`).toString(
      'base64url',
    );
    expect(padded.length).toBeGreaterThan(8_192);

    let allowed = 0;
    for (let n = 0; n < 650; n += 1) {
      const response = await app.inject({
        method: 'GET',
        url: `/v1/collect?d=${padded}`,
        headers: { 'x-tbay-key': tenant.publicKey, 'x-forwarded-for': '198.51.100.22, 10.0.0.5' },
      });
      if (response.statusCode !== 429) allowed += 1;
    }

    expect(allowed).toBe(600);
  });

  it('still gives an unreadable payload a visitor-sized share (HIGH)', async () => {
    // Nothing identifiable at all: no body field, nothing decodable in `d`.
    // Skipping the bucket there is the same bypass by a shorter route, so the
    // anonymous share is a bucket of its own rather than an exemption.
    const app = await testApp();
    let allowed = 0;
    for (let n = 0; n < 650; n += 1) {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/collect?d=not-valid-base64url-json',
        headers: { 'x-tbay-key': tenant.publicKey, 'x-forwarded-for': '198.51.100.23, 10.0.0.5' },
      });
      if (response.statusCode !== 429) allowed += 1;
    }

    // Rejected by the handler as a bad payload, but counted all the same --
    // the limiter runs first and its job is the rate, not the schema.
    expect(allowed).toBe(600);
  });

  it('keeps a full-size honest batch inside its own bucket (HIGH)', async () => {
    // The 8,192 cap fired on the tracker's own traffic, not just on an
    // attacker's: a full flush of 200 events encodes to 16,247 characters, so
    // the busiest visitors on a site were exactly the ones with no bucket.
    const app = await testApp();
    const events = Array.from({ length: 200 }, (_unused, n) => ({
      type: 'pageview',
      url: `https://shop.example/product/${n}?variant=colour-and-size-and-more-padding`,
    }));
    const packed = Buffer.from(
      JSON.stringify({
        visitor: 'busy-visitor',
        session: 'busy-session',
        url: 'https://shop.example/p',
        events,
      }),
    ).toString('base64url');
    expect(packed.length).toBeGreaterThan(16_000);

    let allowed = 0;
    for (let n = 0; n < 650; n += 1) {
      const response = await app.inject({
        method: 'GET',
        url: `/v1/collect?d=${packed}`,
        headers: { 'x-tbay-key': tenant.publicKey, 'x-forwarded-for': '198.51.100.24, 10.0.0.5' },
      });
      if (response.statusCode !== 429) allowed += 1;
    }

    expect(allowed).toBe(600);
  });

  it('ignores a query parameter the handler never reads', async () => {
    // Preferring a plain `?visitor=` made the limiter and the handler disagree
    // about who the visitor was: rotate the parameter and every request opened
    // a fresh bucket, while all the events still landed on the one real
    // visitor inside `d`.
    const app = await testApp();
    const packed = Buffer.from(
      JSON.stringify({
        visitor: 'honest-visitor',
        session: 'honest-session',
        url: 'https://shop.example/p',
        events: [{ type: 'pageview', url: 'https://shop.example/p' }],
      }),
    ).toString('base64url');

    let allowed = 0;
    for (let n = 0; n < 650; n += 1) {
      const response = await app.inject({
        method: 'GET',
        url: `/v1/collect?d=${packed}&visitor=rotating-${n}`,
        headers: { 'x-tbay-key': tenant.publicKey, 'x-forwarded-for': '198.51.100.21, 10.0.0.5' },
      });
      if (response.statusCode !== 429) allowed += 1;
    }

    expect(allowed).toBe(600);
  });
});

describe('a key flood cannot buy anybody a fresh window (HIGH)', () => {
  /**
   * Four attempts came before the one this tests. Three looked for a ranking
   * that would pick the right key to drop, and the attacker chose every
   * candidate. The fourth used least-recently-used order on the theory that a
   * key at its limit is one being sent to constantly -- which is false in the
   * one case that matters, because a caller being rejected stops sending.
   *
   * These test the property directly rather than a traffic pattern that
   * happens to be safe.
   */
  it('keeps blocking a caller who backs off after their 429', async () => {
    const { rateLimit, resetRateLimits } = await import('../src/lib/ratelimit.js');
    resetRateLimits();

    // A caller who has spent their allowance -- and then, as the tracker does
    // on a 429, stops. Not one further request from them during the flood.
    // The previous version re-touched this key every thousand flood keys,
    // which is exactly the interleaving where LRU cannot fail.
    for (let n = 0; n < 12; n += 1) rateLimit('ingest:victim:i:1.2.3.4', 10);
    expect(rateLimit('ingest:victim:i:1.2.3.4', 10).allowed).toBe(false);

    // A flood large enough to turn the map over several times, under a
    // different tenant -- a public site key is in every storefront's page
    // source, so this is not a privileged position to attack from.
    for (let n = 0; n < 600_000; n += 1) {
      rateLimit(`ingest:flooder:i:10.0.0.1:a:v${n}`, 1_000_000);
      rateLimit(`ingest:flooder:i:10.0.0.1:a:v${n}`, 1_000_000);
    }

    const after = rateLimit('ingest:victim:i:1.2.3.4', 10);
    expect(after.allowed).toBe(false);
    expect(after.remaining).toBe(0);
  });

  it('cannot reach the tenant bucket from the ingest class at all', async () => {
    const { rateLimit, resetRateLimits, rateLimitSizes } = await import(
      '../src/lib/ratelimit.js'
    );
    resetRateLimits();

    // Every tenant on the box, idle: one admin call each and nothing since.
    for (let t = 0; t < 20; t += 1) rateLimit(`admin:tenant-${t}`, 10);

    for (let n = 0; n < 600_000; n += 1) {
      rateLimit(`ingest:flooder:i:10.0.0.1:a:v${n}`, 1_000_000);
    }

    // Not one was evicted: a surviving bucket remembers its count, an evicted
    // one starts again at 1.
    for (let t = 0; t < 20; t += 1) {
      const admin = rateLimit(`admin:tenant-${t}`, 10);
      expect(10 - admin.remaining, `tenant-${t}`).toBe(2);
    }

    // And the flood is held at its own ceiling rather than growing without
    // bound: sweeping alone frees nothing while the keys are still live.
    const sizes = rateLimitSizes();
    expect(sizes.ingest).toBeLessThanOrEqual(400_000); // two generations
    expect(sizes.admin).toBe(20);
  });

  it('does not let a key class be invented by its name', async () => {
    // `name in CEILINGS` is true for 'toString', 'constructor' and 'valueOf',
    // and the ceiling then comes back as a *function* -- so `size >= ceiling`
    // is NaN, nothing rotates, and that class grows without bound. No call
    // site mints such a key today, which is exactly why it would have gone
    // unnoticed.
    const { rateLimit, resetRateLimits, rateLimitSizes } = await import(
      '../src/lib/ratelimit.js'
    );
    resetRateLimits();
    for (let n = 0; n < 120_000; n += 1) rateLimit(`toString:${n}`, 10);
    expect(Object.keys(rateLimitSizes())).toEqual(['other']);
    expect(rateLimitSizes().other).toBeLessThanOrEqual(100_000);
  });

  it('does not spend the event loop on the flood it is absorbing', async () => {
    // Keeping LRU order cost a `delete` and a `set` on every touch, and
    // evicting walked `keys()` from the front. Both leave tombstones in V8's
    // Map that later iteration must walk past: measured at 40 us per insert
    // and 58 us per touch on a map at its ceiling, against 1.8 us for the same
    // Map operations in isolation. Two calls per ingest request made the
    // limiter the denial of service.
    const { rateLimit, resetRateLimits } = await import('../src/lib/ratelimit.js');
    resetRateLimits();

    for (let n = 0; n < 220_000; n += 1) rateLimit(`ingest:t1:i:10.0.0.1:a:v${n}`, 1_000_000);

    // Both paths, at the ceiling, where the cost used to live. Timed in bulk
    // rather than per call: a per-call worst case is a GC pause, while a mean
    // over 20,000 is the throughput the API actually gets.
    const insertStart = performance.now();
    for (let n = 0; n < 20_000; n += 1) rateLimit(`ingest:t1:i:10.0.0.2:a:w${n}`, 1_000_000);
    const perInsert = ((performance.now() - insertStart) * 1000) / 20_000;

    const touchStart = performance.now();
    for (let n = 0; n < 20_000; n += 1) rateLimit('ingest:t1:i:10.0.0.3:a:steady', 10_000_000);
    const perTouch = ((performance.now() - touchStart) * 1000) / 20_000;

    // Two of these run per ingest request. The bar is roughly four times what
    // generations measure and a tenth of what the LRU version did, so it
    // separates the two designs rather than merely being satisfiable.
    expect(perInsert, `${perInsert.toFixed(1)}us per insert`).toBeLessThan(6);
    expect(perTouch, `${perTouch.toFixed(1)}us per touch`).toBeLessThan(6);
  });
});

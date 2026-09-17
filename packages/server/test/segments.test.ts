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
import { compileGroup } from '../src/services/segment-filters.js';
import {
  buildSegment,
  countMatching,
  segmentAudience,
  upsertSegment,
} from '../src/services/segments.js';
import { suppress } from '../src/services/deliverability.js';

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

async function authed(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) {
  const app = await testApp();
  return app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${tenant.secretKey}` },
    ...(payload === undefined ? {} : { payload }),
  });
}

async function makeContact(input: Record<string, unknown>): Promise<string> {
  const response = await authed('POST', '/v1/contacts', input);
  return JSON.parse(response.body).contact_id as string;
}

describe('the filter compiler', () => {
  it('never puts a value in the SQL string', () => {
    const compiled = compileGroup(
      {
        match: 'all',
        filters: [{ field: 'email', operator: 'contains', value: "'; DROP TABLE contacts; --" }],
      },
      'UTC',
    );
    // A segment definition is admin-supplied data that is stored and replayed
    // later, so interpolating it would be a stored injection with a delay fuse.
    expect(compiled.sql).not.toContain('DROP TABLE');
    expect(compiled.sql).toContain('$1');
    expect(compiled.params[0]).toContain('DROP TABLE');
  });

  it('refuses an unknown field', () => {
    expect(() =>
      compileGroup({ match: 'all', filters: [{ field: 'pii_salt', operator: 'eq', value: 'x' }] }, 'UTC'),
    ).toThrow(/Unknown segment field/);
  });

  it('refuses an operator the field type does not allow', () => {
    expect(() =>
      compileGroup(
        { match: 'all', filters: [{ field: 'order_count', operator: 'contains', value: 'x' }] },
        'UTC',
      ),
    ).toThrow(/cannot be used/);
  });

  it('escapes LIKE wildcards so "contains %" is not "contains everything"', () => {
    const compiled = compileGroup(
      { match: 'all', filters: [{ field: 'email', operator: 'contains', value: '%' }] },
      'UTC',
    );
    expect(compiled.params[0]).toBe('%\\%%');
  });

  it('refuses to nest beyond the depth limit', () => {
    let group: Record<string, unknown> = { match: 'all', filters: [] };
    for (let i = 0; i < 8; i += 1) group = { match: 'all', groups: [group] };
    expect(() => compileGroup(group as never, 'UTC')).toThrow(/nest/);
  });

  it('treats an empty definition as everyone, not nobody', () => {
    // A segment saved before its filters are written should read as "all
    // contacts". Matching nobody silently sends to zero people and looks like
    // a broken send rather than an unfinished segment.
    const compiled = compileGroup({ match: 'all', filters: [] }, 'UTC');
    expect(compiled.sql).toBe('TRUE');
  });
});

describe('matching contacts', () => {
  beforeEach(async () => {
    await makeContact({ email: 'vip@example.com', tags: ['vip'], marketingConsent: true });
    await makeContact({ email: 'regular@example.com', tags: ['newsletter'], marketingConsent: true });
    await makeContact({ email: 'quiet@example.com', marketingConsent: false });
  });

  it('matches on a tag', async () => {
    const count = await countMatching(tenant.id, {
      match: 'all',
      filters: [{ field: 'tags', operator: 'contains', value: ['vip'] }],
    });
    expect(count).toBe(1);
  });

  it('keeps a segment\'s name and description when only its rules change (HIGH)', async () => {
    // Editing a segment's rules is a PUT carrying a definition and nothing
    // else, which is the shape the admin screen sends. The upsert substituted
    // its own defaults in JavaScript -- `input.name ?? key`,
    // `input.description ?? ''` -- so by the time the statement ran there was
    // no NULL left for the DO UPDATE's COALESCE to preserve: the segment was
    // renamed to its own key and its description erased, silently, on every
    // rule edit.
    await upsertSegment(tenant.id, {
      key: 'vips',
      name: 'Our best customers',
      description: 'Anyone tagged vip, for the quarterly thank-you',
      definition: { match: 'all', filters: [{ field: 'tags', operator: 'contains', value: ['vip'] }] },
    });

    const edited = await upsertSegment(tenant.id, {
      key: 'vips',
      definition: {
        match: 'all',
        filters: [{ field: 'tags', operator: 'contains', value: ['platinum'] }],
      },
    });

    expect(edited.name).toBe('Our best customers');
    expect(edited.description).toBe('Anyone tagged vip, for the quarterly thank-you');
    expect(JSON.stringify(edited.definition)).toContain('platinum');

    // And a rename still renames, rather than the fix turning into "ignore
    // everything optional".
    const renamed = await upsertSegment(tenant.id, {
      key: 'vips', name: 'Platinum tier' });
    expect(renamed.name).toBe('Platinum tier');
    expect(renamed.description).toBe('Anyone tagged vip, for the quarterly thank-you');
    expect(JSON.stringify(renamed.definition)).toContain('platinum');
  });

  it('still counts a segment when the retailer runs a second currency (HIGH)', async () => {
    // `points_balances` has been keyed (tenant_id, contact_id, point_type)
    // since migration 0013; `points_balance`, `lifetime_points` and `rank_key`
    // were still written as if a contact had one row. A scalar subquery that
    // returns two rows does not quietly take the first -- Postgres raises
    // "more than one row returned by a subquery used as an expression" -- so
    // the moment one customer earned in two currencies, the segment count,
    // the preview and every rebuild 500'd. Multi-currency is a shipped
    // feature; this is the crash that met anybody who used it.
    const contactId = await makeContact({ email: 'two-currencies@example.com' });
    await db().query(
      `INSERT INTO point_types (tenant_id, key, name, is_default)
       VALUES ($1, 'gems', 'Gems', false) ON CONFLICT (tenant_id, key) DO NOTHING`,
      [tenant.id],
    );
    for (const [type, balance] of [
      ['points', 400],
      ['gems', 90],
    ] as const) {
      await db().query(
        `INSERT INTO points_balances (tenant_id, contact_id, point_type, balance, lifetime_earned)
         VALUES ($1, $2, $3, $4, $4)
         ON CONFLICT (tenant_id, contact_id, point_type)
           DO UPDATE SET balance = EXCLUDED.balance, lifetime_earned = EXCLUDED.lifetime_earned`,
        [tenant.id, contactId, type, balance],
      );
    }

    // The default currency is what "points balance" has always meant, so the
    // 400 counts and the 90 does not -- not "either" and certainly not a 500.
    for (const field of ['points_balance', 'lifetime_points'] as const) {
      expect(
        await countMatching(tenant.id, {
          match: 'all',
          filters: [{ field, operator: 'gte', value: 300 }],
        }),
        field,
      ).toBe(1);
      expect(
        await countMatching(tenant.id, {
          match: 'all',
          filters: [{ field, operator: 'gte', value: 500 }],
        }),
        field,
      ).toBe(0);
    }

    // And the rank field, which joins through the same points_balances row and
    // was the third subquery that raised. Earning assigns a rank, and everyone
    // here has earned, so what this pins is that the join resolves to one row
    // per contact rather than throwing -- the count is the whole audience, not
    // nobody.
    const ranked = await countMatching(tenant.id, {
      match: 'all',
      filters: [{ field: 'rank_key', operator: 'is_set', value: null }],
    });
    expect(ranked).toBeGreaterThan(0);
  });

  it('excludes on a tag, and includes contacts with no tags at all', async () => {
    const count = await countMatching(tenant.id, {
      match: 'all',
      filters: [{ field: 'tags', operator: 'not_contains', value: ['vip'] }],
    });
    // regular + quiet. Someone with no tags is "not tagged vip".
    expect(count).toBe(2);
  });

  it('combines filters with all and any', async () => {
    const all = await countMatching(tenant.id, {
      match: 'all',
      filters: [
        { field: 'marketing_consent', operator: 'eq', value: true },
        { field: 'tags', operator: 'contains', value: ['vip'] },
      ],
    });
    expect(all).toBe(1);

    const any = await countMatching(tenant.id, {
      match: 'any',
      filters: [
        { field: 'tags', operator: 'contains', value: ['vip'] },
        { field: 'tags', operator: 'contains', value: ['newsletter'] },
      ],
    });
    expect(any).toBe(2);
  });

  it('counts a contact with no balance row as having zero points', async () => {
    const count = await countMatching(tenant.id, {
      match: 'all',
      filters: [{ field: 'points_balance', operator: 'lt', value: 100 }],
    });
    // "Fewer than 100 points" plainly includes people who have never earned
    // any, who have no points_balances row at all.
    expect(count).toBe(3);
  });

  it('treats "never ordered" as not having ordered recently', async () => {
    const count = await countMatching(tenant.id, {
      match: 'all',
      filters: [{ field: 'last_order_at', operator: 'not_in_last_days', value: 30 }],
    });
    expect(count).toBe(3);
  });

  it('matches on order history', async () => {
    await authed('POST', '/v1/orders', {
      orderRef: 'o1',
      email: 'vip@example.com',
      totalCents: 50_000,
      subtotalCents: 50_000,
    });

    const spenders = await countMatching(tenant.id, {
      match: 'all',
      filters: [{ field: 'total_spent_cents', operator: 'gte', value: 50_000 }],
    });
    expect(spenders).toBe(1);

    const recent = await countMatching(tenant.id, {
      match: 'all',
      filters: [{ field: 'last_order_at', operator: 'in_last_days', value: 30 }],
    });
    expect(recent).toBe(1);
  });
});

describe('building and sending to a segment', () => {
  it('materialises membership and keeps it current on rebuild', async () => {
    const vip = await makeContact({ email: 'a@example.com', tags: ['vip'], marketingConsent: true });
    await makeContact({ email: 'b@example.com', tags: ['other'], marketingConsent: true });

    await authed('PUT', '/v1/segments/vips', {
      name: 'VIPs',
      definition: { match: 'all', filters: [{ field: 'tags', operator: 'contains', value: ['vip'] }] },
    });

    const first = await buildSegment(tenant.id, 'vips');
    expect(first.members).toBe(1);
    expect(first.added).toBe(1);

    // Drop the tag: the next build must remove them.
    await db().query(`UPDATE contacts SET tags = '{}' WHERE id = $1`, [vip]);
    const second = await buildSegment(tenant.id, 'vips');
    expect(second.members).toBe(0);
    expect(second.removed).toBe(1);
  });

  it('holds consent and suppression outside the segment definition', async () => {
    await makeContact({ email: 'yes@example.com', tags: ['promo'], marketingConsent: true });
    await makeContact({ email: 'no@example.com', tags: ['promo'], marketingConsent: false });
    await makeContact({ email: 'bounced@example.com', tags: ['promo'], marketingConsent: true });
    await suppress(tenant.id, 'bounced@example.com', 'hard_bounce', 'user unknown');

    await authed('PUT', '/v1/segments/promo', {
      name: 'Promo',
      definition: { match: 'all', filters: [{ field: 'tags', operator: 'contains', value: ['promo'] }] },
    });
    const build = await buildSegment(tenant.id, 'promo');

    // All three are members of the segment — that is who they are.
    expect(build.members).toBe(3);

    // Only one may lawfully be mailed. Keeping this out of the definition means
    // an admin cannot build a segment that forgets the rule.
    const audience = await segmentAudience(tenant.id, 'promo');
    expect(audience.map((row) => row.email)).toEqual(['yes@example.com']);
  });

  it('records a build failure on the segment instead of only throwing', async () => {
    await authed('PUT', '/v1/segments/broken', { name: 'Broken' });
    // Bypass the save-time check to simulate a definition that stopped
    // compiling, e.g. after a field was retired.
    await db().query(
      `UPDATE segments SET definition = '{"match":"all","filters":[{"field":"gone","operator":"eq","value":1}]}'::jsonb
        WHERE tenant_id = $1 AND key = 'broken'`,
      [tenant.id],
    );

    await expect(buildSegment(tenant.id, 'broken')).rejects.toThrow();

    const { rows } = await db().query<{ build_error: string | null }>(
      'SELECT build_error FROM segments WHERE tenant_id = $1 AND key = $2',
      [tenant.id, 'broken'],
    );
    // A segment that silently stopped rebuilding is how a broadcast reaches a
    // stale audience with nobody noticing.
    expect(rows[0]!.build_error).toContain('gone');
  });

  it('rejects a bad definition when it is saved, not when it is sent', async () => {
    const response = await authed('PUT', '/v1/segments/bad', {
      name: 'Bad',
      definition: { match: 'all', filters: [{ field: 'nope', operator: 'eq', value: 1 }] },
    });
    expect(response.statusCode).toBe(400);
  });

  it('previews a definition without saving it', async () => {
    await makeContact({ email: 'p@example.com', tags: ['vip'], marketingConsent: true });

    const response = await authed('POST', '/v1/segments/preview', {
      definition: { match: 'all', filters: [{ field: 'tags', operator: 'contains', value: ['vip'] }] },
    });
    const body = JSON.parse(response.body);
    expect(body.count).toBe(1);
    expect(body.sample[0].email).toBe('p@example.com');

    const saved = await db().query('SELECT 1 FROM segments WHERE tenant_id = $1', [tenant.id]);
    expect(saved.rowCount).toBe(0);
  });
});

describe('a filter that would build the wrong audience is refused', () => {
  it('will not read the string "false" as true', async () => {
    // `Boolean("false")` is true, and a form posts strings. A builder sending
    // `"false"` built the exact inverse of the audience somebody asked for.
    const asBool = (value: unknown) =>
      compileGroup(
        { match: 'all', filters: [{ field: 'marketing_consent', operator: 'eq', value }] },
        'UTC',
      ).sql;

    expect(asBool(false)).toContain('NOT TRUE');
    expect(asBool('false')).toContain('NOT TRUE');
    expect(asBool('no')).toContain('NOT TRUE');
    expect(asBool(true)).toMatch(/IS TRUE/);
    expect(asBool('true')).toMatch(/IS TRUE/);

    // And something that means neither is an error rather than a guess.
    expect(() => asBool('maybe')).toThrow(/takes true or false/i);
  });

  it('refuses an empty group nested inside another', () => {
    // Under `match: any` an empty group contributes TRUE, so one stray click
    // in a builder turned a careful segment into "everybody".
    expect(() =>
      compileGroup(
        {
          match: 'any',
          filters: [{ field: 'tags', operator: 'contains', value: ['vip'] }],
          groups: [{ match: 'all', filters: [] }],
        },
        'UTC',
      ),
    ).toThrow(/needs at least one condition/i);
  });

  it('still treats a segment with no filters at all as everybody', () => {
    // Which is what an admin means by an empty segment.
    expect(compileGroup({ match: 'all', filters: [] }, 'UTC').sql).toBe('TRUE');
  });
});

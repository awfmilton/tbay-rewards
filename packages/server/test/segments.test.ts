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
import { buildSegment, countMatching, segmentAudience } from '../src/services/segments.js';
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

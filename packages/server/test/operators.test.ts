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
import { upsertContact } from '../src/services/contacts.js';
import { atLeast, listOperators, upsertOperator } from '../src/services/operators.js';
import { requiredRole } from '../src/lib/authorise.js';
import { clearTenantCache } from '../src/services/tenants.js';

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

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

const call = async (key: string, method: Method, url: string, payload?: unknown) => {
  const app = await testApp();
  return app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${key}` },
    ...(payload === undefined ? {} : { payload }),
  });
};

const authed = (method: Method, url: string, payload?: unknown) =>
  call(tenant.secretKey, method, url, payload);

/** A key limited to one role, the way an owner would issue one. */
async function keyFor(role: 'owner' | 'manager' | 'support' | 'readonly'): Promise<string> {
  const res = await authed('POST', '/v1/keys', { label: `${role} key`, role });
  expect(res.statusCode).toBe(200);
  clearTenantCache();
  return JSON.parse(res.body).secret as string;
}

describe('the guard matches the route, not the spelling', () => {
  it('refuses an owner-only route however the path is encoded', async () => {
    // The router percent-decodes before it dispatches, so `/v1/%6beys` reached
    // the `/v1/keys` handler while the guard — matching the raw target —
    // saw no rule and fell through to "a write needs manager". A manager
    // minted itself an owner key through it.
    const manager = await keyFor('manager');

    for (const path of ['/v1/keys', '/v1/%6beys', '/v1/ke%79s', '/v1/%6B%65%79%73']) {
      const res = await call(manager, 'POST', path, { label: 'sneaky', role: 'owner' });
      expect(res.statusCode, path).toBe(403);
    }

    for (const path of ['/v1/operators', '/v1/%6fperators']) {
      expect((await call(manager, 'GET', path)).statusCode, path).toBe(403);
    }

    for (const path of ['/v1/settings', '/v1/%73ettings']) {
      const res = await call(manager, 'PUT', path, { transferMinimum: 5 });
      expect(res.statusCode, path).toBe(403);
    }
  });

  it('records the route it matched, not what the caller typed', async () => {
    // An encoded path written into the audit log verbatim is an entry nobody
    // searching for the real one will find.
    const manager = await keyFor('manager');
    await call(manager, 'POST', '/v1/%6beys', { label: 'sneaky', role: 'owner' });

    const { rows } = await db().query<{ action: string }>(
      "SELECT action FROM audit_log WHERE tenant_id = $1 AND action LIKE '%keys%'",
      [tenant.id],
    );
    expect(rows.map((row) => row.action)).toContain('POST /v1/keys');
  });

  it('still lets each role do its own work', async () => {
    const manager = await keyFor('manager');
    const support = await keyFor('support');
    const readonly = await keyFor('readonly');

    expect((await call(manager, 'POST', '/v1/contacts', { email: 'm@example.com' })).statusCode)
      .toBe(200);
    expect((await call(support, 'POST', '/v1/contacts', { email: 's@example.com' })).statusCode)
      .toBe(200);
    expect((await call(readonly, 'GET', '/v1/contacts/fields')).statusCode).toBe(200);
    expect((await call(readonly, 'POST', '/v1/contacts', { email: 'r@example.com' })).statusCode)
      .toBe(403);
  });
});

describe('the role ladder', () => {
  it('contains everything below it', () => {
    expect(atLeast('owner', 'manager')).toBe(true);
    expect(atLeast('manager', 'support')).toBe(true);
    expect(atLeast('support', 'readonly')).toBe(true);
    expect(atLeast('support', 'manager')).toBe(false);
    expect(atLeast('readonly', 'support')).toBe(false);
  });

  it('defaults an unlisted route by its method, not by leaving it open', () => {
    // The property that matters: a route added next month is covered before
    // anybody remembers to list it.
    expect(requiredRole('GET', '/v1/something/brand/new')).toBe('readonly');
    expect(requiredRole('POST', '/v1/something/brand/new')).toBe('manager');
    expect(requiredRole('DELETE', '/v1/something/brand/new')).toBe('manager');
  });

  it('puts credentials and people behind the owner', () => {
    expect(requiredRole('GET', '/v1/operators')).toBe('owner');
    expect(requiredRole('POST', '/v1/keys')).toBe('owner');
    expect(requiredRole('PUT', '/v1/settings')).toBe('owner');
  });
});

describe('a key carries a role', () => {
  it('leaves an existing key able to do what it always could', async () => {
    // Every key issued before roles existed has neither an operator nor a
    // role, and reads as owner. Nothing about an upgrade may take a store's
    // integration offline.
    const res = await authed('GET', '/v1/operators');
    expect(res.statusCode).toBe(200);
  });

  it('refuses a support key the things support may not do', async () => {
    const support = await keyFor('support');
    const contact = await upsertContact(tenant.id, { email: 'someone@example.com' });

    // Allowed: the daily work of answering a customer.
    const adjust = await call(support, 'POST', '/v1/rewards/adjust', {
      contactId: contact.id,
      points: 50,
      reason: 'Goodwill',
      idempotencyKey: 'support-1',
    });
    expect(adjust.statusCode).toBe(200);

    // Refused: irreversible, outward-facing, or credential-issuing.
    for (const [method, url, payload] of [
      ['POST', '/v1/privacy/erase', { contactId: contact.id }],
      ['POST', '/v1/keys', { label: 'self-issued' }],
      ['GET', '/v1/operators', undefined],
    ] as const) {
      const res = await call(support, method, url, payload);
      expect(res.statusCode, `${method} ${url}`).toBe(403);
      expect(JSON.parse(res.body).error).toBe('forbidden');
    }
  });

  it('refuses a readonly key every write', async () => {
    const readonly = await keyFor('readonly');
    const contact = await upsertContact(tenant.id, { email: 'ro@example.com' });

    const read = await call(readonly, 'GET', '/v1/rewards/rules');
    expect(read.statusCode).toBe(200);

    const write = await call(readonly, 'POST', '/v1/rewards/adjust', {
      contactId: contact.id,
      points: 10,
      reason: 'Should not happen',
      idempotencyKey: 'ro-1',
    });
    expect(write.statusCode).toBe(403);
  });

  it('lets a manager do the operational work but not issue keys', async () => {
    const manager = await keyFor('manager');
    const contact = await upsertContact(tenant.id, { email: 'mgr@example.com' });

    const erase = await call(manager, 'POST', '/v1/privacy/erase', { contactId: contact.id });
    expect(erase.statusCode).toBe(200);

    const keys = await call(manager, 'POST', '/v1/keys', { label: 'nope' });
    expect(keys.statusCode).toBe(403);
  });

  it('takes the narrower of the key’s role and the operator’s', async () => {
    await upsertOperator(tenant.id, { email: 'sam@shop.example', role: 'manager' });

    const res = await authed('POST', '/v1/keys', {
      operatorEmail: 'sam@shop.example',
      role: 'readonly',
      label: "Sam's reporting script",
    });
    const key = JSON.parse(res.body).secret as string;
    clearTenantCache();

    const contact = await upsertContact(tenant.id, { email: 'narrow@example.com' });
    const write = await call(key, 'POST', '/v1/rewards/adjust', {
      contactId: contact.id,
      points: 5,
      reason: 'x',
      idempotencyKey: 'narrow-1',
    });
    // Sam is a manager; this particular key is not.
    expect(write.statusCode).toBe(403);
  });

  it('inherits the operator’s role when the key names none', async () => {
    await upsertOperator(tenant.id, { email: 'pat@shop.example', role: 'support' });
    const res = await authed('POST', '/v1/keys', { operatorEmail: 'pat@shop.example' });
    const key = JSON.parse(res.body).secret as string;
    clearTenantCache();

    const contact = await upsertContact(tenant.id, { email: 'inherit@example.com' });
    expect(
      (
        await call(key, 'POST', '/v1/rewards/adjust', {
          contactId: contact.id,
          points: 5,
          reason: 'x',
          idempotencyKey: 'inherit-1',
        })
      ).statusCode,
    ).toBe(200);
    expect((await call(key, 'GET', '/v1/operators')).statusCode).toBe(403);
  });

  it('stops a disabled operator’s keys working', async () => {
    await upsertOperator(tenant.id, { email: 'leaver@shop.example', role: 'manager' });
    const res = await authed('POST', '/v1/keys', { operatorEmail: 'leaver@shop.example' });
    const key = JSON.parse(res.body).secret as string;
    clearTenantCache();

    expect((await call(key, 'GET', '/v1/rewards/rules')).statusCode).toBe(200);

    await upsertOperator(tenant.id, { email: 'leaver@shop.example', disabled: true });
    clearTenantCache();

    // Disabling somebody while the credential they carry still works is the
    // appearance of removing access rather than removing it.
    expect((await call(key, 'GET', '/v1/rewards/rules')).statusCode).toBe(401);
  });

  it('brings them back when re-enabled', async () => {
    await upsertOperator(tenant.id, { email: 'back@shop.example', role: 'support' });
    const key = JSON.parse(
      (await authed('POST', '/v1/keys', { operatorEmail: 'back@shop.example' })).body,
    ).secret as string;

    await upsertOperator(tenant.id, { email: 'back@shop.example', disabled: true });
    clearTenantCache();
    expect((await call(key, 'GET', '/v1/rewards/rules')).statusCode).toBe(401);

    await upsertOperator(tenant.id, { email: 'back@shop.example', disabled: false });
    clearTenantCache();
    expect((await call(key, 'GET', '/v1/rewards/rules')).statusCode).toBe(200);
  });

  it('never returns a secret twice', async () => {
    const created = JSON.parse((await authed('POST', '/v1/keys', { label: 'once' })).body);
    expect(created.secret).toContain('.');

    const list = JSON.parse((await authed('GET', '/v1/keys')).body).keys;
    const row = list.find((one: { key_id: string }) => one.key_id === created.key_id);
    expect(row).toBeTruthy();
    expect(JSON.stringify(row)).not.toContain(created.secret.split('.')[1]);
    expect(JSON.stringify(row)).not.toContain('secret_hash');
  });

  it('revokes a key', async () => {
    const created = JSON.parse((await authed('POST', '/v1/keys', { label: 'doomed' })).body);
    clearTenantCache();
    expect((await call(created.secret, 'GET', '/v1/rewards/rules')).statusCode).toBe(200);

    await authed('DELETE', `/v1/keys/${created.key_id}`);
    clearTenantCache();
    expect((await call(created.secret, 'GET', '/v1/rewards/rules')).statusCode).toBe(401);
  });
});

describe('operators', () => {
  it('rejects an address that is not one', async () => {
    await expect(upsertOperator(tenant.id, { email: 'not-an-email' })).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it('matches on the address regardless of case', async () => {
    await upsertOperator(tenant.id, { email: 'Casey@Shop.Example', role: 'manager' });
    await upsertOperator(tenant.id, { email: 'casey@shop.example', name: 'Casey' });

    const operators = await listOperators(tenant.id);
    expect(operators).toHaveLength(1);
    expect(operators[0]!.name).toBe('Casey');
    // A partial update must not reset the role it did not mention.
    expect(operators[0]!.role).toBe('manager');
  });

  it('keeps their keys when they are removed, stripped of the attribution', async () => {
    await upsertOperator(tenant.id, { email: 'gone@shop.example', role: 'manager' });
    const created = JSON.parse(
      (await authed('POST', '/v1/keys', { operatorEmail: 'gone@shop.example' })).body,
    );

    await authed('DELETE', '/v1/operators/gone@shop.example');

    const { rows } = await db().query(
      'SELECT operator_id, revoked_at FROM tenant_keys WHERE key_id = $1',
      [created.key_id],
    );
    // Revoking somebody's access and silently revoking an integration key they
    // happened to issue are different decisions; doing the second while
    // meaning the first takes a storefront down.
    expect(rows[0]!.operator_id).toBeNull();
    expect(rows[0]!.revoked_at).toBeNull();
  });

  it('does not reach another tenant’s operators', async () => {
    const other = await makeTenant();
    await upsertOperator(other.id, { email: 'theirs@shop.example', role: 'owner' });

    expect(JSON.parse((await authed('GET', '/v1/operators')).body).operators).toHaveLength(0);
  });
});

describe('the audit log', () => {
  it('records a change with who, what and about whom', async () => {
    await upsertOperator(tenant.id, { email: 'auditor@shop.example', role: 'manager' });
    const key = JSON.parse(
      (await authed('POST', '/v1/keys', { operatorEmail: 'auditor@shop.example' })).body,
    ).secret as string;
    clearTenantCache();

    const contact = await upsertContact(tenant.id, { email: 'audited@example.com' });
    await call(key, 'POST', '/v1/rewards/adjust', {
      contactId: contact.id,
      points: 250,
      reason: 'Goodwill after a delay',
      idempotencyKey: 'audit-1',
    });

    const entries = JSON.parse((await authed('GET', '/v1/audit')).body).entries;
    const entry = entries.find(
      (row: { action: string }) => row.action === 'POST /v1/rewards/adjust',
    );
    expect(entry).toBeTruthy();
    expect(entry.operator_email).toBe('auditor@shop.example');
    expect(entry.role).toBe('manager');
    expect(entry.status).toBe(200);
    expect(entry.target).toBe(contact.id);
    expect(entry.detail.points).toBe(250);
    expect(entry.detail.reason).toBe('Goodwill after a delay');
  });

  it('records a refusal, which is the entry somebody most wants to find', async () => {
    const support = await keyFor('support');
    const contact = await upsertContact(tenant.id, { email: 'refused@example.com' });

    await call(support, 'POST', '/v1/privacy/erase', { contactId: contact.id });

    const entries = JSON.parse((await authed('GET', '/v1/audit')).body).entries;
    const entry = entries.find(
      (row: { action: string }) => row.action === 'POST /v1/privacy/erase',
    );
    expect(entry).toBeTruthy();
    expect(entry.status).toBe(403);
    expect(entry.role).toBe('support');
  });

  it('does not copy the whole request body into a second store of personal data', async () => {
    const contact = await upsertContact(tenant.id, { email: 'private@example.com' });
    await authed('POST', '/v1/contacts', {
      email: 'private@example.com',
      name: 'Very Private Person',
      phone: '+1 807 555 0133',
    });

    const entries = JSON.parse((await authed('GET', '/v1/audit')).body).entries;
    const blob = JSON.stringify(entries.map((row: { detail: unknown }) => row.detail));
    expect(blob).not.toContain('Very Private Person');
    expect(blob).not.toContain('555 0133');
    // The email is kept as the target, because "what happened to this
    // customer" is the question the log exists to answer.
    expect(JSON.stringify(entries)).toContain('private@example.com');
    expect(contact.id).toBeTruthy();
  });

  it('does not log reads', async () => {
    await authed('GET', '/v1/rewards/rules');
    await authed('GET', '/v1/segments/fields');

    const entries = JSON.parse((await authed('GET', '/v1/audit')).body).entries;
    expect(entries.some((row: { action: string }) => row.action.startsWith('GET'))).toBe(false);
  });

  it('filters by action prefix, so one filter covers a whole area', async () => {
    const contact = await upsertContact(tenant.id, { email: 'filter@example.com' });
    await authed('POST', '/v1/rewards/adjust', {
      contactId: contact.id,
      points: 10,
      reason: 'a',
      idempotencyKey: 'f1',
    });
    await authed('PUT', '/v1/rewards/rules', { key: 'purchase', points: 5 });

    const res = await authed('GET', '/v1/audit?action=POST /v1/rewards');
    const entries = JSON.parse(res.body).entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]!.action).toBe('POST /v1/rewards/adjust');
  });

  it('answers “everything that touched this customer”', async () => {
    const contact = await upsertContact(tenant.id, { email: 'traced@example.com' });
    await authed('POST', '/v1/rewards/adjust', {
      contactId: contact.id,
      points: 10,
      reason: 'a',
      idempotencyKey: 't1',
    });

    const res = await authed('GET', `/v1/audit?target=${contact.id}`);
    expect(JSON.parse(res.body).entries).toHaveLength(1);
  });

  it('does not reach another tenant’s log', async () => {
    const other = await makeTenant();
    const theirs = await upsertContact(other.id, { email: 'theirs@example.com' });
    await call(other.secretKey, 'POST', '/v1/rewards/adjust', {
      contactId: theirs.id,
      points: 10,
      reason: 'theirs',
      idempotencyKey: 'other-1',
    });

    expect(JSON.parse((await authed('GET', '/v1/audit')).body).entries).toHaveLength(0);
  });

  it('stays append-only: a failed write never fails the request', async () => {
    // The log is observability. Losing a line is bad; losing the customer's
    // order because the log table was full is worse.
    const contact = await upsertContact(tenant.id, { email: 'resilient@example.com' });
    await db().query('ALTER TABLE audit_log RENAME TO audit_log_hidden');
    try {
      const res = await authed('POST', '/v1/rewards/adjust', {
        contactId: contact.id,
        points: 10,
        reason: 'Still works',
        idempotencyKey: 'resilient-1',
      });
      expect(res.statusCode).toBe(200);
    } finally {
      await db().query('ALTER TABLE audit_log_hidden RENAME TO audit_log');
    }
  });
});

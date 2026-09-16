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
import {
  deleteField,
  getFieldValues,
  listFields,
  setFieldValues,
  upsertField,
} from '../src/services/contact-fields.js';
import { countMatching } from '../src/services/segments.js';
import { compileGroup } from '../src/services/segment-filters.js';
import { eraseContact, exportContact } from '../src/services/privacy.js';

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

const authed = async (
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  payload?: unknown,
) => {
  const app = await testApp();
  return app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${tenant.secretKey}` },
    ...(payload === undefined ? {} : { payload }),
  });
};

async function standardFields() {
  await upsertField(tenant.id, { key: 'province', label: 'Province', kind: 'text' });
  await upsertField(tenant.id, { key: 'tier', label: 'Tier', kind: 'number' });
  await upsertField(tenant.id, { key: 'joined_club', label: 'Joined the club', kind: 'date' });
  await upsertField(tenant.id, { key: 'trade', label: 'Trade account', kind: 'boolean' });
  await upsertField(tenant.id, {
    key: 'fabric',
    label: 'Preferred fabric',
    kind: 'select',
    options: ['Nylon', 'Polyester'],
  });
}

describe('defining fields', () => {
  it('rejects a key that is not a key', async () => {
    for (const key of ['A', 'has spaces', 'x', 'way-too-punctuated!']) {
      await expect(upsertField(tenant.id, { key })).rejects.toMatchObject({ statusCode: 400 });
    }
  });

  it('will not create a list with nothing to choose from', async () => {
    await expect(
      upsertField(tenant.id, { key: 'fabric', kind: 'select', options: [] }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('refuses to change the type of a field that already holds values', async () => {
    await upsertField(tenant.id, { key: 'tier', label: 'Tier', kind: 'text' });
    const contact = await upsertContact(tenant.id, { email: 'typed@example.com' });
    await setFieldValues(tenant.id, contact.id, { tier: 'gold' });

    // Silently switching would leave "gold" in a column the new type never
    // reads: the field would look empty for everybody, with no error anywhere.
    await expect(
      upsertField(tenant.id, { key: 'tier', kind: 'number' }),
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it('allows a type change while nothing has been stored', async () => {
    await upsertField(tenant.id, { key: 'tier', kind: 'text' });
    const changed = await upsertField(tenant.id, { key: 'tier', kind: 'number' });
    expect(changed.kind).toBe('number');
  });

  it('takes the values with it when the field is removed', async () => {
    await standardFields();
    const contact = await upsertContact(tenant.id, { email: 'gone@example.com' });
    await setFieldValues(tenant.id, contact.id, { province: 'Ontario' });

    expect(await deleteField(tenant.id, 'province')).toBe(true);

    const { rows } = await db().query(
      "SELECT 1 FROM contact_field_values WHERE tenant_id = $1 AND field_key = 'province'",
      [tenant.id],
    );
    // A value whose field is gone has no type, so nothing can read it — and a
    // key reused later would inherit it.
    expect(rows).toHaveLength(0);
  });
});

describe('storing values', () => {
  beforeEach(standardFields);

  it('round-trips each type as its own type', async () => {
    const contact = await upsertContact(tenant.id, { email: 'typed@example.com' });
    await setFieldValues(tenant.id, contact.id, {
      province: 'Ontario',
      tier: 3,
      joined_club: '2026-02-01',
      trade: true,
      fabric: 'Nylon',
    });

    const values = await getFieldValues(tenant.id, contact.id);
    expect(values.province).toBe('Ontario');
    // A number, not the string "3": "tier > 10" over text puts 10 below 9.
    expect(values.tier).toBe(3);
    expect(values.joined_club).toBeInstanceOf(Date);
    expect(values.trade).toBe(true);
    expect(values.fabric).toBe('Nylon');
  });

  it('refuses a value the field cannot hold, at write time', async () => {
    const contact = await upsertContact(tenant.id, { email: 'bad@example.com' });

    // The whole reason for typed columns: this is a 400 to whoever wrote it,
    // not a 500 in the middle of an audience build hours later.
    await expect(
      setFieldValues(tenant.id, contact.id, { tier: 'lots' }),
    ).rejects.toMatchObject({ statusCode: 400 });

    await expect(
      setFieldValues(tenant.id, contact.id, { joined_club: 'whenever' }),
    ).rejects.toMatchObject({ statusCode: 400 });

    await expect(
      setFieldValues(tenant.id, contact.id, { fabric: 'Silk' }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('refuses a key the retailer has not defined', async () => {
    const contact = await upsertContact(tenant.id, { email: 'typo@example.com' });
    await expect(
      setFieldValues(tenant.id, contact.id, { provnice: 'Ontario' }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('takes a list value in whatever case it arrives, and stores one spelling', async () => {
    const contact = await upsertContact(tenant.id, { email: 'case@example.com' });
    await setFieldValues(tenant.id, contact.id, { fabric: 'nylon' });
    // Otherwise "Nylon", "nylon" and "NYLON" are three different segments.
    expect((await getFieldValues(tenant.id, contact.id)).fabric).toBe('Nylon');
  });

  it('reads yes and no the way a spreadsheet writes them', async () => {
    const contact = await upsertContact(tenant.id, { email: 'bools@example.com' });
    for (const [input, expected] of [['yes', true], ['NO', false], ['1', true], ['off', false]] as const) {
      await setFieldValues(tenant.id, contact.id, { trade: input });
      expect((await getFieldValues(tenant.id, contact.id)).trade).toBe(expected);
    }
  });

  it('clears a value rather than storing an empty one', async () => {
    const contact = await upsertContact(tenant.id, { email: 'clear@example.com' });
    await setFieldValues(tenant.id, contact.id, { province: 'Ontario' });
    await setFieldValues(tenant.id, contact.id, { province: null });

    expect((await getFieldValues(tenant.id, contact.id)).province).toBeNull();
    const { rows } = await db().query(
      "SELECT 1 FROM contact_field_values WHERE tenant_id = $1 AND field_key = 'province'",
      [tenant.id],
    );
    expect(rows).toHaveLength(0);
  });

  it('shows every defined field, set or not', async () => {
    const contact = await upsertContact(tenant.id, { email: 'partial@example.com' });
    await setFieldValues(tenant.id, contact.id, { province: 'Ontario' });

    const values = await getFieldValues(tenant.id, contact.id);
    expect(Object.keys(values).sort()).toEqual([
      'fabric',
      'joined_club',
      'province',
      'tier',
      'trade',
    ]);
    expect(values.tier).toBeNull();
  });

  it('moves a value between columns when the type was changed first', async () => {
    await upsertField(tenant.id, { key: 'note', kind: 'text' });
    const contact = await upsertContact(tenant.id, { email: 'move@example.com' });
    await setFieldValues(tenant.id, contact.id, { note: 'hello' });
    await setFieldValues(tenant.id, contact.id, { note: 'goodbye' });

    // One row per (contact, field), with exactly one populated column.
    const { rows } = await db().query(
      `SELECT text_value, number_value, date_value, bool_value FROM contact_field_values
        WHERE tenant_id = $1 AND contact_id = $2 AND field_key = 'note'`,
      [tenant.id, contact.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.text_value).toBe('goodbye');
    expect(rows[0]!.number_value).toBeNull();
  });
});

describe('segmenting on them', () => {
  beforeEach(standardFields);

  async function member(email: string, values: Record<string, unknown>) {
    const contact = await upsertContact(tenant.id, { email, marketingConsent: true });
    await setFieldValues(tenant.id, contact.id, values);
    return contact;
  }

  it('matches on a text field', async () => {
    await member('on@example.com', { province: 'Ontario' });
    await member('bc@example.com', { province: 'British Columbia' });

    const n = await countMatching(tenant.id, {
      match: 'all',
      filters: [{ field: 'cf_province', operator: 'eq', value: 'ontario' }],
    });
    expect(n).toBe(1);
  });

  it('compares a number as a number', async () => {
    await member('nine@example.com', { tier: 9 });
    await member('ten@example.com', { tier: 10 });

    // The reason for a numeric column: over text, "10" sorts below "9".
    const n = await countMatching(tenant.id, {
      match: 'all',
      filters: [{ field: 'cf_tier', operator: 'gt', value: 9 }],
    });
    expect(n).toBe(1);
  });

  it('compares a date as a date', async () => {
    await member('old@example.com', { joined_club: '2020-01-01' });
    await member('new@example.com', { joined_club: '2026-06-01' });

    const n = await countMatching(tenant.id, {
      match: 'all',
      filters: [{ field: 'cf_joined_club', operator: 'after', value: '2025-01-01' }],
    });
    expect(n).toBe(1);
  });

  it('matches a boolean, and is_set for one nobody filled in', async () => {
    await member('trade@example.com', { trade: true });
    await member('retail@example.com', { trade: false });
    await member('unknown@example.com', {});

    expect(
      await countMatching(tenant.id, {
        match: 'all',
        filters: [{ field: 'cf_trade', operator: 'eq', value: true }],
      }),
    ).toBe(1);

    expect(
      await countMatching(tenant.id, {
        match: 'all',
        filters: [{ field: 'cf_trade', operator: 'is_not_set' }],
      }),
    ).toBe(1);
  });

  it('combines a custom field with a platform one', async () => {
    await member('both@example.com', { province: 'Ontario' });
    await member('neither@example.com', { province: 'Ontario' });
    await db().query(
      "UPDATE contacts SET marketing_consent = false WHERE email = 'neither@example.com'",
    );

    const n = await countMatching(tenant.id, {
      match: 'all',
      filters: [
        { field: 'cf_province', operator: 'eq', value: 'Ontario' },
        { field: 'marketing_consent', operator: 'eq', value: true },
      ],
    });
    expect(n).toBe(1);
  });

  it('refuses a custom field the retailer does not have', async () => {
    await expect(
      countMatching(tenant.id, {
        match: 'all',
        filters: [{ field: 'cf_nonsense', operator: 'eq', value: 'x' }],
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('never puts the field key into the SQL string', () => {
    // The rule the whole compiler exists to enforce, and custom fields are the
    // one place a *name* is caller data rather than a fixed table entry.
    const compiled = compileGroup(
      {
        match: 'all',
        filters: [{ field: "cf_evil", operator: 'eq', value: 'x' }],
      },
      'UTC',
      0,
      0,
      undefined,
      new Map([['evil', 'text']]),
    );
    expect(compiled.sql).not.toContain('evil');
    expect(compiled.params).toContain('evil');
  });

  it('cannot be made to read a column it was not given', () => {
    // A kind that is not in the fixed table is refused rather than used to
    // pick a column name.
    expect(() =>
      compileGroup(
        { match: 'all', filters: [{ field: 'cf_x', operator: 'eq', value: 'y' }] },
        'UTC',
        0,
        0,
        undefined,
        new Map([['x', 'pii_salt' as never]]),
      ),
    ).toThrow(/Unknown segment field/);
  });

  it('does not let a custom field shadow a platform one', async () => {
    await upsertField(tenant.id, { key: 'email', label: 'Their other email', kind: 'text' });
    await member('shadow@example.com', { email: 'other@example.com' });

    // `email` still means the platform's address; the retailer's is `cf_email`.
    expect(
      await countMatching(tenant.id, {
        match: 'all',
        filters: [{ field: 'email', operator: 'eq', value: 'shadow@example.com' }],
      }),
    ).toBe(1);
    expect(
      await countMatching(tenant.id, {
        match: 'all',
        filters: [{ field: 'cf_email', operator: 'eq', value: 'other@example.com' }],
      }),
    ).toBe(1);
  });
});

describe('they are personal data like any other', () => {
  beforeEach(standardFields);

  it('appears in a subject access export', async () => {
    const contact = await upsertContact(tenant.id, { email: 'sar@example.com' });
    await setFieldValues(tenant.id, contact.id, { province: 'Ontario', tier: 2 });

    const data = await exportContact(tenant.id, contact.id);
    expect(data.custom_fields).toMatchObject({ province: 'Ontario', tier: 2 });
  });

  it('is deleted by an erasure', async () => {
    const contact = await upsertContact(tenant.id, { email: 'erase-fields@example.com' });
    await setFieldValues(tenant.id, contact.id, { province: 'Ontario' });

    await eraseContact(tenant.id, contact.id);

    const { rows } = await db().query(
      'SELECT 1 FROM contact_field_values WHERE tenant_id = $1 AND contact_id = $2',
      [tenant.id, contact.id],
    );
    expect(rows).toHaveLength(0);
  });
});

describe('over the API', () => {
  it('defines a field, sets a value and lists it as filterable', async () => {
    const created = await authed('PUT', '/v1/contacts/fields/province', {
      label: 'Province',
      kind: 'text',
    });
    expect(created.statusCode).toBe(200);

    await authed('POST', '/v1/contacts', { email: 'api@example.com' });
    const set = await authed('PUT', '/v1/contacts/field-values', {
      email: 'api@example.com',
      values: { province: 'Ontario' },
    });
    expect(set.statusCode).toBe(200);
    expect(JSON.parse(set.body).values.province).toBe('Ontario');

    const fields = JSON.parse((await authed('GET', '/v1/segments/fields')).body).fields;
    const custom = fields.find((field: { key: string }) => field.key === 'cf_province');
    expect(custom).toMatchObject({ label: 'Province', kind: 'text', custom: true });
  });

  it('reports a bad value as a 400 with the field named', async () => {
    await authed('PUT', '/v1/contacts/fields/tier', { label: 'Tier', kind: 'number' });
    await authed('POST', '/v1/contacts', { email: 'api2@example.com' });

    const res = await authed('PUT', '/v1/contacts/field-values', {
      email: 'api2@example.com',
      values: { tier: 'gold' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('Tier');
  });

  it('does not reach another tenant’s fields', async () => {
    const other = await makeTenant();
    await upsertField(other.id, { key: 'secret', label: 'Secret', kind: 'text' });

    const fields = JSON.parse((await authed('GET', '/v1/contacts/fields')).body).fields;
    expect(fields).toHaveLength(0);
  });
});

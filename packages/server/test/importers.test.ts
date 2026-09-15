import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { closeApp, closeDb, db, makeTenant, setupDatabase, truncateAll, type TestTenant } from './helpers.js';
import { parseCsv, parseCsvTable, pick } from '../src/importers/csv.js';
import { importMauticContacts } from '../src/importers/mautic.js';
import { importMyCredBalances } from '../src/importers/mycred.js';
import { importFlagswagCommissions, importFlagswagLinks } from '../src/importers/flagswag.js';
import { getBalance } from '../src/services/points.js';
import { findContactByEmail } from '../src/services/contacts.js';
import { getLinkByCode } from '../src/services/links.js';
import { subscribersFor } from '../src/services/newsletter.js';

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

describe('csv parsing', () => {
  it('handles quotes, embedded commas and newlines', () => {
    const rows = parseCsv('a,b\n"x,1","say ""hi"""\n"multi\nline",2\n');
    expect(rows).toEqual([
      ['a', 'b'],
      ['x,1', 'say "hi"'],
      ['multi\nline', '2'],
    ]);
  });

  it('strips a BOM and a missing trailing newline', () => {
    const table = parseCsvTable('﻿Email,Name\na@example.com,Ann');
    expect(table.headers).toEqual(['email', 'name']);
    expect(table.rows[0]).toEqual({ email: 'a@example.com', name: 'Ann' });
  });

  it('picks the first populated column', () => {
    expect(pick({ a: '', b: 'x' }, 'a', 'b')).toBe('x');
    expect(pick({ a: '', b: '' }, 'a', 'b')).toBe('');
  });
});

describe('mautic import', () => {
  const CSV = [
    'id,email,firstname,lastname,tags,dnc_status,date_added',
    '1,ann@example.com,Ann,Smith,"vip|newsletter",,2021-03-04T10:00:00Z',
    '2,bob@example.com,Bob,Jones,,unsubscribed,2022-01-01T10:00:00Z',
    '3,carl@example.com,Carl,,,bounced,2022-06-01T10:00:00Z',
    '4,,No,Email,,,2023-01-01T10:00:00Z',
  ].join('\n');

  it('reports without writing on a dry run', async () => {
    const report = await importMauticContacts({ tenantId: tenant.id, csv: CSV }, { dryRun: true });

    expect(report.dryRun).toBe(true);
    expect(report.read).toBe(4);
    expect(report.skipped).toBe(1);

    const { rows } = await db().query('SELECT COUNT(*)::int AS n FROM contacts WHERE tenant_id = $1', [
      tenant.id,
    ]);
    expect(rows[0].n).toBe(0);
  });

  it('imports contacts and preserves the original consent date', async () => {
    await importMauticContacts({ tenantId: tenant.id, csv: CSV });

    const ann = await findContactByEmail(tenant.id, 'ann@example.com');
    expect(ann).not.toBeNull();
    expect(ann!.name).toBe('Ann Smith');
    expect(ann!.marketing_consent).toBe(true);
    expect(ann!.tags.sort()).toEqual(['newsletter', 'vip']);
    // The 2021 opt-in date carries over rather than being stamped today.
    expect(new Date(ann!.consent_at as unknown as string).getUTCFullYear()).toBe(2021);
  });

  it('keeps unsubscribed and bounced people out of the mailable list', async () => {
    await importMauticContacts({ tenantId: tenant.id, csv: CSV });

    const mailable = await subscribersFor(tenant.id, 'newsletter');
    expect(mailable.map((row) => row.email)).toEqual(['ann@example.com']);

    const { rows } = await db().query(
      `SELECT c.email, s.status FROM subscriptions s
         JOIN contacts c ON c.id = s.contact_id
        WHERE s.tenant_id = $1 ORDER BY c.email`,
      [tenant.id],
    );
    expect(rows).toEqual([
      { email: 'ann@example.com', status: 'subscribed' },
      { email: 'bob@example.com', status: 'unsubscribed' },
      { email: 'carl@example.com', status: 'bounced' },
    ]);
  });

  it('is safe to run twice', async () => {
    await importMauticContacts({ tenantId: tenant.id, csv: CSV });
    await importMauticContacts({ tenantId: tenant.id, csv: CSV });

    const { rows } = await db().query('SELECT COUNT(*)::int AS n FROM contacts WHERE tenant_id = $1', [
      tenant.id,
    ]);
    expect(rows[0].n).toBe(3);
  });

  it('refuses a file that is not a contact export', async () => {
    const report = await importMauticContacts({ tenantId: tenant.id, csv: 'foo,bar\n1,2' });
    expect(report.warnings[0]).toContain('No email column');
    expect(report.read).toBe(0);
  });
});

describe('mycred import', () => {
  const CSV = [
    'user_id,user_email,display_name,balance,badges',
    '7,ann@example.com,Ann,2500,"connector|nonexistent_badge"',
    '8,bob@example.com,Bob,0,',
    '9,carl@example.com,Carl,150,',
  ].join('\n');

  it('creates one opening balance per member', async () => {
    const report = await importMyCredBalances({ tenantId: tenant.id, csv: CSV });
    expect(report.created).toBe(2);
    expect(report.skipped).toBe(1); // zero balance

    const ann = await findContactByEmail(tenant.id, 'ann@example.com');
    expect((await getBalance(tenant.id, ann!.id)).balance).toBe(2500);
  });

  it('does not double a balance when re-run', async () => {
    await importMyCredBalances({ tenantId: tenant.id, csv: CSV });
    await importMyCredBalances({ tenantId: tenant.id, csv: CSV });

    const ann = await findContactByEmail(tenant.id, 'ann@example.com');
    expect((await getBalance(tenant.id, ann!.id)).balance).toBe(2500);

    const { rows } = await db().query(
      `SELECT COUNT(*)::int AS n FROM points_ledger WHERE tenant_id = $1 AND ref_id = 'mycred'`,
      [tenant.id],
    );
    expect(rows[0].n).toBe(2);
  });

  it('recalculates rank from the imported balance', async () => {
    await importMyCredBalances({ tenantId: tenant.id, csv: CSV });
    const ann = await findContactByEmail(tenant.id, 'ann@example.com');

    const { rows } = await db().query(
      `SELECT r.key FROM points_balances b
         JOIN ranks r ON r.id = b.current_rank_id
        WHERE b.tenant_id = $1 AND b.contact_id = $2`,
      [tenant.id, ann!.id],
    );
    expect(rows[0].key).toBe('insider'); // 2500 lifetime points
  });

  it('grants only badges that already exist, ignoring unknown slugs', async () => {
    await importMyCredBalances({ tenantId: tenant.id, csv: CSV });
    const ann = await findContactByEmail(tenant.id, 'ann@example.com');

    const { rows } = await db().query(
      `SELECT b.key FROM badge_awards a JOIN badges b ON b.id = a.badge_id
        WHERE a.contact_id = $1`,
      [ann!.id],
    );
    expect(rows.map((row) => row.key)).toEqual(['connector']);
  });
});

describe('flagswag import', () => {
  const LINKS = [
    'code,target_url,owner_email,post_id,product_id,rate_bps,clicks',
    'MAPLE4K7Q,https://shop.example.com/product/flag,writer@example.com,12,45,750,318',
    'BADROW,,writer@example.com,,,500,0',
  ].join('\n');

  it('recreates links with their original codes so published links keep working', async () => {
    const report = await importFlagswagLinks({ tenantId: tenant.id, csv: LINKS });
    expect(report.created).toBe(1);
    expect(report.skipped).toBe(1);

    const link = await getLinkByCode('MAPLE4K7Q');
    expect(link).not.toBeNull();
    expect(link!.kind).toBe('writer');
    expect(link!.commission_rate_bps).toBe(750);
    expect(link!.post_ref).toBe('12');
    // Historical clicks carry over so reports have no cliff at the cutover.
    expect(link!.clicks).toBe(318);

    const writer = await findContactByEmail(tenant.id, 'writer@example.com');
    expect(writer!.is_writer).toBe(true);
    expect(link!.owner_contact_id).toBe(writer!.id);
  });

  it('skips a link whose code is already taken rather than clobbering it', async () => {
    await importFlagswagLinks({ tenantId: tenant.id, csv: LINKS });
    const report = await importFlagswagLinks({ tenantId: tenant.id, csv: LINKS });

    expect(report.created).toBe(0);
    expect(report.updated).toBe(1);
  });

  it('imports commission history as already paid', async () => {
    const csv = [
      'order_ref,owner_email,amount_cents,subtotal_cents,status,created_at',
      'wc-1001,writer@example.com,1250,25000,,2024-02-01',
      'wc-1002,writer@example.com,500,10000,pending,2024-06-01',
      'wc-1003,,500,10000,,2024-06-02',
    ].join('\n');

    const report = await importFlagswagCommissions({ tenantId: tenant.id, csv });
    expect(report.created).toBe(2);
    expect(report.skipped).toBe(1);

    const { rows } = await db().query(
      'SELECT order_ref, status, amount_cents FROM commissions WHERE tenant_id = $1 ORDER BY order_ref',
      [tenant.id],
    );
    expect(rows).toEqual([
      { order_ref: 'wc-1001', status: 'paid', amount_cents: 1250 },
      { order_ref: 'wc-1002', status: 'pending', amount_cents: 500 },
    ]);
  });

  it('does not duplicate commission rows on a re-run', async () => {
    const csv = [
      'order_ref,owner_email,amount_cents',
      'wc-1001,writer@example.com,1250',
    ].join('\n');

    await importFlagswagCommissions({ tenantId: tenant.id, csv });
    await importFlagswagCommissions({ tenantId: tenant.id, csv });

    const { rows } = await db().query(
      'SELECT COUNT(*)::int AS n FROM commissions WHERE tenant_id = $1',
      [tenant.id],
    );
    expect(rows[0].n).toBe(1);
  });
});

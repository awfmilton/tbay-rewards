import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { closeApp, closeDb, db, makeTenant, setupDatabase, truncateAll, type TestTenant } from './helpers.js';
import { parseCsv, parseCsvTable, pick } from '../src/importers/csv.js';
import { importMauticContacts } from '../src/importers/mautic.js';
import { importMyCredBalances, importMyCredHistory } from '../src/importers/mycred.js';
import { importFlagswagCommissions, importFlagswagLinks } from '../src/importers/flagswag.js';
import { award, getBalance } from '../src/services/points.js';
import { findContactByEmail, upsertContact } from '../src/services/contacts.js';
import { trigger } from '../src/services/rewards.js';
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

describe('myCred log history', () => {
  it('brings the history across without moving the balance', async () => {
    const { importMyCredBalances, importMyCredHistory } = await import(
      '../src/importers/mycred.js'
    );

    await importMyCredBalances({
      tenantId: tenant.id,
      csv: 'user_email,balance\nveteran@example.com,750\n',
    });

    const history = await importMyCredHistory({
      tenantId: tenant.id,
      csv:
        'id,user_email,creds,entry,ref,ctime\n' +
        '1,veteran@example.com,100,Signed up,registration,1600000000\n' +
        '2,veteran@example.com,250,Bought something,woocommerce_payment,1610000000\n' +
        '3,veteran@example.com,400,Referred a friend,referral,1620000000\n',
    });

    expect(history.created).toBe(3);

    const { rows } = await db().query<{ balance: number }>(
      `SELECT balance FROM points_balances b
         JOIN contacts c ON c.id = b.contact_id
        WHERE c.email_normalised = 'veteran@example.com'`,
    );
    // The opening balance already accounts for every one of those entries.
    // Replaying the deltas as well would double it.
    expect(rows[0]!.balance).toBe(750);

    const entries = await db().query<{ reason: string; delta_points: number; meta: { original_points: number } }>(
      `SELECT reason, delta_points, meta FROM points_ledger
        WHERE ref_type = 'import_history' ORDER BY created_at`,
    );
    expect(entries.rows.map((row) => row.reason)).toEqual([
      'Signed up',
      'Bought something',
      'Referred a friend',
    ]);
    expect(entries.rows.every((row) => row.delta_points === 0)).toBe(true);
    // The real number is kept so the history can still be read and reported on.
    expect(entries.rows.map((row) => row.meta.original_points)).toEqual([100, 250, 400]);
  });

  it('keeps the original timestamps so history reads in order', async () => {
    const { importMyCredBalances, importMyCredHistory } = await import(
      '../src/importers/mycred.js'
    );
    await importMyCredBalances({
      tenantId: tenant.id,
      csv: 'user_email,balance\nold@example.com,10\n',
    });
    await importMyCredHistory({
      tenantId: tenant.id,
      csv: 'id,user_email,creds,entry,ctime\n9,old@example.com,10,Ancient,1600000000\n',
    });

    const { rows } = await db().query<{ created_at: Date }>(
      `SELECT created_at FROM points_ledger WHERE ref_type = 'import_history'`,
    );
    expect(new Date(rows[0]!.created_at).getUTCFullYear()).toBe(2020);
  });

  it('re-runs without duplicating anything', async () => {
    const { importMyCredBalances, importMyCredHistory } = await import(
      '../src/importers/mycred.js'
    );
    const csv = 'id,user_email,creds,entry,ctime\n1,rerun@example.com,50,Thing,1600000000\n';

    await importMyCredBalances({
      tenantId: tenant.id,
      csv: 'user_email,balance\nrerun@example.com,50\n',
    });
    await importMyCredHistory({ tenantId: tenant.id, csv });
    const second = await importMyCredHistory({ tenantId: tenant.id, csv });

    expect(second.created).toBe(0);
    expect(second.skipped).toBe(1);
  });

  it('says so when a history row has no matching contact', async () => {
    const { importMyCredHistory } = await import('../src/importers/mycred.js');
    const report = await importMyCredHistory({
      tenantId: tenant.id,
      csv: 'id,user_email,creds,entry,ctime\n1,ghost@example.com,50,Thing,1600000000\n',
    });

    // Two exports that disagree is worth reporting, not silently creating a
    // member out of a log line.
    expect(report.created).toBe(0);
    expect(report.warnings.join(' ')).toContain('import balances first');
  });
});

describe('imported history stays in the past', () => {
  it('does not let a future-dated row sit inside every cooldown window', async () => {
    const contact = await upsertContact(tenant.id, { email: 'future@example.com' });
    await award(tenant.id, {
      contactId: contact.id,
      points: 500,
      reason: 'Opening balance',
      idempotencyKey: 'future-open',
    });

    const year = new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString();
    await importMyCredHistory({
      tenantId: tenant.id,
      csv: [
        'id,user_email,ref,entry,creds,ctime',
        `9001,future@example.com,purchase,Historic purchase,100,${year}`,
      ].join('\n'),
    });

    const { rows } = await db().query(
      `SELECT created_at FROM points_ledger
        WHERE tenant_id = $1 AND ref_type = 'import_history'`,
      [tenant.id],
    );
    expect(rows).toHaveLength(1);
    expect(new Date(rows[0]!.created_at).getTime()).toBeLessThanOrEqual(Date.now() + 5_000);

    // And the rule it names still fires, rather than being cooled down for a
    // year by a row dated next spring.
    const outcome = await trigger(tenant.id, {
      contactId: contact.id,
      ruleKey: 'purchase',
      refId: 'order-after-import',
      valueCents: 5_000,
    });
    expect(outcome.awarded).toBe(true);
  });
});

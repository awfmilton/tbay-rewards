import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import {
  BOT_UA,
  DESKTOP_UA,
  closeApp,
  closeDb,
  db,
  ids,
  makeTenant,
  setupDatabase,
  testApp,
  truncateAll,
  type TestTenant,
} from './helpers.js';
import { upsertContact } from '../src/services/contacts.js';
import { createLink, linkReport } from '../src/services/links.js';
import {
  approveMaturedCommissions,
  commissionSummary,
  listCommissions,
  recordOrder,
  refundOrder,
} from '../src/services/commissions.js';
import { getBalance } from '../src/services/points.js';
import { getTenantById } from '../src/services/tenants.js';
import { createShare } from '../src/services/shares.js';

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

const tenantObject = async () => (await getTenantById(tenant.id))!;

async function writer(email = 'writer@example.com') {
  const contact = await upsertContact(tenant.id, { email, name: 'Blog Writer' });
  await db().query('UPDATE contacts SET is_writer = true WHERE id = $1', [contact.id]);
  return contact;
}

describe('trackable links', () => {
  it('redirects, records the click and sets an attribution cookie', async () => {
    const author = await writer();
    const link = await createLink(tenant.id, {
      targetUrl: 'https://shop.example.com/product/flag',
      kind: 'writer',
      ownerContactId: author.id,
      postRef: 'post-12',
    });

    const app = await testApp();
    const response = await app.inject({
      method: 'GET',
      url: `/r/${link.code}`,
      headers: { 'user-agent': DESKTOP_UA },
    });

    expect(response.statusCode).toBe(302);
    // The code rides along so the tracker can pick it up on the landing page.
    expect(response.headers.location).toContain('tb_ref=' + link.code);
    expect(response.headers['set-cookie']).toContain('tbay_attr=');
    expect(response.headers['cache-control']).toBe('no-store');

    const { rows } = await db().query('SELECT clicks FROM links WHERE id = $1', [link.id]);
    expect(rows[0].clicks).toBe(1);
  });

  it('records a bot click without inflating the click count', async () => {
    const link = await createLink(tenant.id, { targetUrl: 'https://shop.example.com/' });
    const app = await testApp();
    await app.inject({ method: 'GET', url: `/r/${link.code}`, headers: { 'user-agent': BOT_UA } });

    const { rows: links } = await db().query('SELECT clicks FROM links WHERE id = $1', [link.id]);
    expect(links[0].clicks).toBe(0);

    const { rows: clicks } = await db().query('SELECT is_bot FROM link_clicks WHERE link_id = $1', [link.id]);
    expect(clicks[0].is_bot).toBe(true);
  });

  it('404s an unknown code', async () => {
    const app = await testApp();
    const response = await app.inject({ method: 'GET', url: '/r/NOSUCHCODE' });
    expect(response.statusCode).toBe(404);
  });
});

describe('writer commissions', () => {
  it('accrues commission on an order attributed to a writer link', async () => {
    const author = await writer();
    const link = await createLink(tenant.id, {
      targetUrl: 'https://shop.example.com/product/flag',
      kind: 'writer',
      ownerContactId: author.id,
      commissionRateBps: 1000, // 10%
    });

    const result = await recordOrder(await tenantObject(), {
      orderRef: 'order-1',
      totalCents: 10_000,
      subtotalCents: 10_000,
      email: 'buyer@example.com',
      linkCode: link.code,
      items: [{ productRef: 'flag-1', quantity: 1, subtotalCents: 10_000 }],
    });

    expect(result.commissions).toHaveLength(1);
    expect(result.commissions[0]).toMatchObject({ amount_cents: 1000, rate_bps: 1000, status: 'pending' });

    const summary = await commissionSummary(tenant.id, author.id);
    expect(summary).toMatchObject({ pending_cents: 1000, orders: 1 });
  });

  it('only pays a product-specific link on its own product', async () => {
    const author = await writer();
    const link = await createLink(tenant.id, {
      targetUrl: 'https://shop.example.com/product/flag',
      kind: 'writer',
      ownerContactId: author.id,
      productRef: 'flag-1',
      commissionRateBps: 1000,
    });

    const result = await recordOrder(await tenantObject(), {
      orderRef: 'order-2',
      totalCents: 30_000,
      email: 'buyer@example.com',
      linkCode: link.code,
      items: [
        { productRef: 'flag-1', quantity: 1, subtotalCents: 10_000 },
        { productRef: 'mug-9', quantity: 1, subtotalCents: 20_000 },
      ],
    });

    expect(result.commissions).toHaveLength(1);
    expect(result.commissions[0].amount_cents).toBe(1000); // 10% of the flag only
  });

  it('pays a general writer link across the whole basket', async () => {
    const author = await writer();
    const link = await createLink(tenant.id, {
      targetUrl: 'https://shop.example.com/',
      kind: 'writer',
      ownerContactId: author.id,
      commissionRateBps: 500,
    });

    const result = await recordOrder(await tenantObject(), {
      orderRef: 'order-3',
      totalCents: 30_000,
      email: 'buyer@example.com',
      linkCode: link.code,
      items: [
        { productRef: 'flag-1', quantity: 1, subtotalCents: 10_000 },
        { productRef: 'mug-9', quantity: 1, subtotalCents: 20_000 },
      ],
    });

    const total = result.commissions.reduce((sum, row) => sum + row.amount_cents, 0);
    expect(total).toBe(1500);
  });

  it('never pays a writer for buying through their own link', async () => {
    const author = await writer('selfbuyer@example.com');
    const link = await createLink(tenant.id, {
      targetUrl: 'https://shop.example.com/',
      kind: 'writer',
      ownerContactId: author.id,
      commissionRateBps: 1000,
    });

    const result = await recordOrder(await tenantObject(), {
      orderRef: 'order-4',
      totalCents: 10_000,
      email: 'selfbuyer@example.com',
      linkCode: link.code,
    });

    expect(result.commissions).toHaveLength(0);
  });

  it('is idempotent when a storefront retries the order webhook', async () => {
    const author = await writer();
    const link = await createLink(tenant.id, {
      targetUrl: 'https://shop.example.com/',
      kind: 'writer',
      ownerContactId: author.id,
      commissionRateBps: 1000,
    });
    const tenantRow = await tenantObject();

    const order = {
      orderRef: 'order-5',
      totalCents: 10_000,
      email: 'buyer@example.com',
      linkCode: link.code,
      items: [{ productRef: 'flag-1', quantity: 1, subtotalCents: 10_000 }],
    };

    await recordOrder(tenantRow, order);
    const second = await recordOrder(tenantRow, order);

    expect(second.commissions).toHaveLength(0);
    expect(await listCommissions(tenant.id, { ownerContactId: author.id })).toHaveLength(1);

    const { rows } = await db().query('SELECT COUNT(*)::int AS n FROM orders WHERE tenant_id = $1', [
      tenant.id,
    ]);
    expect(rows[0].n).toBe(1);
  });

  it('holds a commission until the refund window closes', async () => {
    const author = await writer();
    const link = await createLink(tenant.id, {
      targetUrl: 'https://shop.example.com/',
      kind: 'writer',
      ownerContactId: author.id,
      commissionRateBps: 1000,
    });

    const result = await recordOrder(await tenantObject(), {
      orderRef: 'order-6',
      totalCents: 10_000,
      email: 'buyer@example.com',
      linkCode: link.code,
    });

    expect(await approveMaturedCommissions()).toBe(0);

    await db().query(`UPDATE commissions SET hold_until = now() - interval '1 day' WHERE id = $1`, [
      result.commissions[0].id,
    ]);
    expect(await approveMaturedCommissions()).toBe(1);

    expect(await commissionSummary(tenant.id, author.id)).toMatchObject({
      pending_cents: 0,
      approved_cents: 1000,
    });
  });

  it('voids commissions and claws back points on a refund', async () => {
    const author = await writer();
    const link = await createLink(tenant.id, {
      targetUrl: 'https://shop.example.com/',
      kind: 'writer',
      ownerContactId: author.id,
      commissionRateBps: 1000,
    });
    const tenantRow = await tenantObject();

    const result = await recordOrder(tenantRow, {
      orderRef: 'order-7',
      totalCents: 10_000,
      email: 'buyer@example.com',
      linkCode: link.code,
    });
    expect(result.pointsAwarded).toBe(100); // 1 point per currency unit

    const buyerId = result.contactId!;
    expect((await getBalance(tenant.id, buyerId)).pending).toBe(100);

    const refund = await refundOrder(tenantRow, 'order-7');
    expect(refund).toMatchObject({ voided: 1, pointsReversed: true });

    // The purchase points are clawed back. The 50-point "first purchase" badge
    // bonus is not: the badge was genuinely earned, and unearning achievements
    // on a refund is punitive rather than corrective.
    expect(await getBalance(tenant.id, buyerId)).toMatchObject({ balance: 50, pending: 0 });
    expect(await commissionSummary(tenant.id, author.id)).toMatchObject({ pending_cents: 0 });
  });

  it('reports clicks, orders and earnings per link', async () => {
    const author = await writer();
    const link = await createLink(tenant.id, {
      targetUrl: 'https://shop.example.com/',
      kind: 'writer',
      ownerContactId: author.id,
      postRef: 'post-42',
      commissionRateBps: 1000,
    });

    const app = await testApp();
    await app.inject({ method: 'GET', url: `/r/${link.code}`, headers: { 'user-agent': DESKTOP_UA } });
    await recordOrder(await tenantObject(), {
      orderRef: 'order-8',
      totalCents: 20_000,
      email: 'buyer@example.com',
      linkCode: link.code,
    });

    const report = await linkReport(tenant.id, { ownerContactId: author.id });
    expect(report[0]).toMatchObject({
      code: link.code,
      post_ref: 'post-42',
      human_clicks: 1,
      orders: 1,
      commission_cents: 2000,
    });
  });
});

describe('attribution from browsing', () => {
  it('credits the last touch when the order carries no link code', async () => {
    const app = await testApp();
    const { visitor, session } = ids();

    await app.inject({
      method: 'POST',
      url: '/v1/collect',
      headers: { 'x-tbay-key': tenant.publicKey, 'user-agent': DESKTOP_UA },
      payload: {
        visitor,
        session,
        url: 'https://shop.example.com/?utm_source=instagram&utm_medium=social&utm_campaign=spring',
        events: [{ type: 'pageview' }],
      },
    });

    await recordOrder(await tenantObject(), {
      orderRef: 'order-9',
      totalCents: 5000,
      email: 'buyer@example.com',
      visitorAnonId: visitor,
    });

    const { rows } = await db().query('SELECT last_touch, first_touch FROM orders WHERE order_ref = $1', [
      'order-9',
    ]);
    expect(rows[0].last_touch).toMatchObject({ source: 'instagram', medium: 'social', campaign: 'spring' });
    expect(rows[0].first_touch).toMatchObject({ source: 'instagram' });
  });
});

describe('social shares', () => {
  it('pays only once someone actually clicks the shared link', async () => {
    const sharer = await upsertContact(tenant.id, { email: 'sharer@example.com' });
    const tenantRow = await tenantObject();

    const share = await createShare(tenantRow, {
      contactId: sharer.id,
      network: 'x',
      targetUrl: 'https://shop.example.com/product/flag',
    });

    expect(share.share.status).toBe('pending');
    expect(share.intentUrl).toContain('x.com/intent/tweet');
    // Creating a share earns nothing on its own.
    expect((await getBalance(tenant.id, sharer.id)).balance).toBe(0);

    const app = await testApp();
    await app.inject({
      method: 'GET',
      url: `/r/${share.link.code}`,
      headers: { 'user-agent': DESKTOP_UA },
    });

    expect((await getBalance(tenant.id, sharer.id)).balance).toBe(25);
    const { rows } = await db().query('SELECT status, points_awarded FROM share_events WHERE id = $1', [
      share.share.id,
    ]);
    expect(rows[0]).toMatchObject({ status: 'verified', points_awarded: 25 });
  });

  it('does not pay for a bot click on a shared link', async () => {
    const sharer = await upsertContact(tenant.id, { email: 'sharer2@example.com' });
    const share = await createShare(await tenantObject(), {
      contactId: sharer.id,
      network: 'facebook',
      targetUrl: 'https://shop.example.com/product/flag',
    });

    const app = await testApp();
    await app.inject({ method: 'GET', url: `/r/${share.link.code}`, headers: { 'user-agent': BOT_UA } });

    expect((await getBalance(tenant.id, sharer.id)).balance).toBe(0);
  });

  it('pays a share only once no matter how many clicks it gets', async () => {
    const sharer = await upsertContact(tenant.id, { email: 'sharer3@example.com' });
    const share = await createShare(await tenantObject(), {
      contactId: sharer.id,
      network: 'linkedin',
      targetUrl: 'https://shop.example.com/product/flag',
    });

    const app = await testApp();
    for (let i = 0; i < 4; i += 1) {
      await app.inject({ method: 'GET', url: `/r/${share.link.code}`, headers: { 'user-agent': DESKTOP_UA } });
    }

    expect((await getBalance(tenant.id, sharer.id)).balance).toBe(25);
  });

  it('rejects an unsupported network', async () => {
    const sharer = await upsertContact(tenant.id, { email: 'sharer4@example.com' });
    await expect(
      createShare(await tenantObject(), {
        contactId: sharer.id,
        network: 'myspace',
        targetUrl: 'https://shop.example.com/',
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});

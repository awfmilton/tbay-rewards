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
  it('pays only once somebody else actually lands on the shared link', async () => {
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

    // Nor does the redirect. It knows an address and a user agent and nothing
    // else, so it cannot tell a stranger from the sharer in a private window
    // -- and one click is all a share needs to be paid.
    expect((await getBalance(tenant.id, sharer.id)).balance).toBe(0);

    // The landing page's tracker is the first thing that knows who arrived.
    const { visitor, session } = ids();
    await app.inject({
      method: 'POST',
      url: '/v1/collect',
      headers: { 'x-tbay-key': tenant.publicKey, 'user-agent': DESKTOP_UA },
      payload: {
        visitor,
        session,
        url: 'https://shop.example.com/product/flag',
        events: [{ type: 'share_click', linkCode: share.link.code }],
      },
    });

    // 25 for the share rule, and 25 for the Social Butterfly badge it earns.
    // The badge counts verified shares rather than points, so it is evaluated
    // when the share verifies -- before, it only moved if the rule happened to
    // award, and a capped or cooled-down share left it behind.
    expect((await getBalance(tenant.id, sharer.id)).balance).toBe(50);
    const { rows } = await db().query('SELECT status, points_awarded FROM share_events WHERE id = $1', [
      share.share.id,
    ]);
    expect(rows[0]).toMatchObject({ status: 'verified', points_awarded: 25 });

    const badges = await db().query<{ key: string }>(
      `SELECT b.key FROM badge_awards a
         JOIN badges b ON b.id = a.badge_id
        WHERE a.tenant_id = $1 AND a.contact_id = $2`,
      [tenant.id, sharer.id],
    );
    expect(badges.rows.map((row) => row.key)).toContain('social_butterfly');
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
      const { visitor, session } = ids();
      await app.inject({ method: 'GET', url: `/r/${share.link.code}`, headers: { 'user-agent': DESKTOP_UA } });
      await app.inject({
        method: 'POST',
        url: '/v1/collect',
        headers: { 'x-tbay-key': tenant.publicKey, 'user-agent': DESKTOP_UA },
        payload: {
          visitor,
          session,
          url: 'https://shop.example.com/product/flag',
          events: [{ type: 'share_click', linkCode: share.link.code }],
        },
      });
    }

    // Paid once: 25 for the share, 25 for the badge it earned, and nothing
    // more however many people click.
    expect((await getBalance(tenant.id, sharer.id)).balance).toBe(50);
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

describe('a refund takes back what the order paid out (MEDIUM)', () => {
  it('unwinds the referral bonus its qualifying order earned', async () => {
    // Refer yourself, place an order, collect the referrer's bonus, refund the
    // order. The purchase points went back; the 250-point referral bonus did
    // not, because it is keyed on the referral rather than on the order. The
    // loop paid out every time it was run.
    const referrer = await upsertContact(tenant.id, { email: 'referrer@example.com' });
    const referee = await upsertContact(tenant.id, { email: 'referee@example.com' });
    await db().query(
      `INSERT INTO referrals (tenant_id, referrer_contact_id, referee_contact_id, status)
       VALUES ($1, $2, $3, 'pending')`,
      [tenant.id, referrer.id, referee.id],
    );

    const tenantRow = await tenantObject();
    await recordOrder(tenantRow, {
      orderRef: 'referred-1',
      totalCents: 5_000,
      contactId: referee.id,
      email: 'referee@example.com',
    });

    // Measured as a change, because qualifying also earns the referrer a
    // badge -- which a refund leaves alone, the same way it leaves the buyer's
    // first-purchase badge alone.
    const earned = await getBalance(tenant.id, referrer.id);
    const held = earned.balance + earned.pending;
    expect(held).toBeGreaterThanOrEqual(250);

    await refundOrder(tenantRow, 'referred-1');

    const after = await getBalance(tenant.id, referrer.id);
    expect(after.balance + after.pending).toBe(held - 250);

    const { rows } = await db().query<{ status: string }>(
      'SELECT status FROM referrals WHERE tenant_id = $1',
      [tenant.id],
    );
    expect(rows[0]!.status).toBe('pending');
  });

  it('leaves the referral alone when another order still stands', async () => {
    // One kept order is reason enough for the referral on its own.
    const referrer = await upsertContact(tenant.id, { email: 'referrer2@example.com' });
    const referee = await upsertContact(tenant.id, { email: 'referee2@example.com' });
    await db().query(
      `INSERT INTO referrals (tenant_id, referrer_contact_id, referee_contact_id, status)
       VALUES ($1, $2, $3, 'pending')`,
      [tenant.id, referrer.id, referee.id],
    );

    const tenantRow = await tenantObject();
    await recordOrder(tenantRow, {
      orderRef: 'referred-2a', totalCents: 5_000, contactId: referee.id, email: 'referee2@example.com',
    });
    await recordOrder(tenantRow, {
      orderRef: 'referred-2b', totalCents: 3_000, contactId: referee.id, email: 'referee2@example.com',
    });

    const before = await getBalance(tenant.id, referrer.id);
    const held = before.balance + before.pending;

    await refundOrder(tenantRow, 'referred-2a');

    const after = await getBalance(tenant.id, referrer.id);
    expect(after.balance + after.pending).toBe(held);

    const { rows } = await db().query<{ status: string }>(
      'SELECT status FROM referrals WHERE tenant_id = $1',
      [tenant.id],
    );
    expect(rows[0]!.status).toBe('qualified');
  });
});

describe('a refunded order stops counting as a sale (LOW)', () => {
  it('unwinds the product figures on the day the order was placed', async () => {
    // A refunded order kept its purchase and its revenue in product_stats, so
    // a product with a heavy return rate read as a bestseller on the very
    // screen buyers restock from.
    const tenantRow = await tenantObject();
    await recordOrder(tenantRow, {
      orderRef: 'returned-1',
      totalCents: 5_000,
      email: 'returner@example.com',
      items: [{ productRef: 'flag-9', quantity: 2, subtotalCents: 5_000 }],
    });

    const sold = await productStats('flag-9');
    expect(sold).toMatchObject({ purchases: '2', revenue_cents: '5000' });

    await refundOrder(tenantRow, 'returned-1');

    // Netted out on the original day, not pushed into a week nobody is
    // looking at.
    const after = await productStats('flag-9');
    expect(after).toMatchObject({ purchases: '0', revenue_cents: '0' });
    const { rows } = await db().query<{ n: string }>(
      'SELECT count(*) AS n FROM product_stats WHERE tenant_id = $1 AND product_ref = $2',
      [tenant.id, 'flag-9'],
    );
    expect(Number(rows[0]!.n)).toBe(1);
  });

  it('does not push a count below zero', async () => {
    const tenantRow = await tenantObject();
    await recordOrder(tenantRow, {
      orderRef: 'returned-2',
      totalCents: 1_000,
      email: 'returner2@example.com',
      items: [{ productRef: 'flag-8', quantity: 1, subtotalCents: 1_000 }],
    });
    // Somebody refunds twice, or the stats were reset in between.
    await db().query(
      'UPDATE product_stats SET purchases = 0, revenue_cents = 0 WHERE tenant_id = $1',
      [tenant.id],
    );

    await refundOrder(tenantRow, 'returned-2');

    expect(await productStats('flag-8')).toMatchObject({ purchases: '0', revenue_cents: '0' });
  });
});

async function productStats(productRef: string) {
  const { rows } = await db().query<{ purchases: string; revenue_cents: string }>(
    `SELECT SUM(purchases)::text AS purchases, SUM(revenue_cents)::text AS revenue_cents
       FROM product_stats WHERE tenant_id = $1 AND product_ref = $2`,
    [tenant.id, productRef],
  );
  return rows[0]!;
}

describe('a referral unwound by a refund can be earned again (MEDIUM)', () => {
  it('pays the affiliate when the referee comes back and keeps an order', async () => {
    // The unwind reversed the bonus and set the referral back to pending, but
    // the award's idempotency key is rule:referral:<referrer>:<referral_id>,
    // which does not change. So re-qualifying found the reversed row, said
    // "already done", and paid nothing -- the referral read `qualified` and
    // the affiliate had nothing for it, permanently, because a customer
    // returned one item and bought another.
    const referrer = await upsertContact(tenant.id, { email: 'affiliate@example.com' });
    const referee = await upsertContact(tenant.id, { email: 'referred@example.com' });
    await db().query(
      `INSERT INTO referrals (tenant_id, referrer_contact_id, referee_contact_id, status)
       VALUES ($1, $2, $3, 'pending')`,
      [tenant.id, referrer.id, referee.id],
    );

    const tenantRow = await tenantObject();
    const held = async () => {
      const balance = await getBalance(tenant.id, referrer.id);
      return balance.balance + balance.pending;
    };

    await recordOrder(tenantRow, {
      orderRef: 'again-1', totalCents: 5_000, contactId: referee.id, email: 'referred@example.com',
    });
    const afterFirst = await held();
    expect(afterFirst).toBeGreaterThanOrEqual(250);

    await refundOrder(tenantRow, 'again-1');
    expect(await held()).toBe(afterFirst - 250);

    // They come back and buy something they keep.
    await recordOrder(tenantRow, {
      orderRef: 'again-2', totalCents: 8_000, contactId: referee.id, email: 'referred@example.com',
    });

    expect(await held()).toBe(afterFirst);
    const { rows } = await db().query<{ status: string }>(
      'SELECT status FROM referrals WHERE tenant_id = $1',
      [tenant.id],
    );
    expect(rows[0]!.status).toBe('qualified');
  });
});

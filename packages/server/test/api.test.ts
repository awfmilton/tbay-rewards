import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import {
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
import { setEmailTransport, outbox, flushEmailQueue } from '../src/services/email.js';
import { confirmSubscription } from '../src/services/newsletter.js';

let tenant: TestTenant;

beforeAll(async () => {
  await setupDatabase();
});

beforeEach(async () => {
  await truncateAll();
  setEmailTransport(null);
  outbox().length = 0;
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

describe('authentication', () => {
  it('rejects a report request with no credentials', async () => {
    const app = await testApp();
    const response = await app.inject({ method: 'GET', url: '/v1/reports/overview' });
    expect(response.statusCode).toBe(401);
  });

  it('rejects a secret key with the wrong secret half', async () => {
    const app = await testApp();
    const keyId = tenant.secretKey.split('.')[0];
    const response = await app.inject({
      method: 'GET',
      url: '/v1/reports/overview',
      headers: { authorization: `Bearer ${keyId}.wrong-secret` },
    });
    expect(response.statusCode).toBe(401);
  });

  it('refuses to accept a public site key on the reporting API', async () => {
    const app = await testApp();
    const response = await app.inject({
      method: 'GET',
      url: '/v1/reports/overview',
      headers: { authorization: `Bearer ${tenant.publicKey}` },
    });
    expect(response.statusCode).toBe(401);
  });

  it('never returns another retailer’s data', async () => {
    const other = await makeTenant();
    await authed('POST', '/v1/contacts', { email: 'mine@example.com', name: 'Mine' });

    const app = await testApp();
    const response = await app.inject({
      method: 'GET',
      url: '/v1/contacts/lookup?email=mine@example.com',
      headers: { authorization: `Bearer ${other.secretKey}` },
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('health', () => {
  it('reports database and chain configuration', async () => {
    const app = await testApp();
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'ok', database: 'ok', signer_configured: true });
  });
});

describe('tracker asset', () => {
  it('serves the tracker script', async () => {
    const app = await testApp();
    const response = await app.inject({ method: 'GET', url: '/tbay.js' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('application/javascript');
    expect(response.body).toContain('TBAY Rewards tracker');
  });

  it('serves the dashboard', async () => {
    const app = await testApp();
    const response = await app.inject({ method: 'GET', url: '/' });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('TBAY Rewards');
  });
});

describe('full customer journey', () => {
  it('runs browse → subscribe → share → buy → redeem end to end', async () => {
    const app = await testApp();
    const { visitor, session } = ids();

    // 1. Arrive from a social post and browse a product.
    await app.inject({
      method: 'POST',
      url: '/v1/collect',
      headers: { 'x-tbay-key': tenant.publicKey, 'user-agent': DESKTOP_UA },
      payload: {
        visitor,
        session,
        url: 'https://shop.example.com/product/flag?utm_source=instagram&utm_medium=social',
        events: [
          { type: 'pageview' },
          { type: 'product_view', productRef: 'flag-1', product: { name: 'Red Ensign', priceCents: 4999 } },
          { type: 'add_to_cart', productRef: 'flag-1', valueCents: 4999 },
        ],
        heatmap: [
          {
            page: 'https://shop.example.com/product/flag',
            kind: 'click',
            samples: [{ x: 0.5, y: 0.3 }, { x: 0.51, y: 0.31 }],
            docHeight: 3000,
            viewportWidth: 1440,
          },
        ],
        cart: {
          cartToken: 'cart-journey',
          items: [{ productRef: 'flag-1', name: 'Red Ensign', quantity: 1, priceCents: 4999 }],
        },
      },
    });

    // 2. Sign up for the newsletter and confirm.
    const signup = await app.inject({
      method: 'POST',
      url: '/v1/newsletter/subscribe',
      headers: { 'x-tbay-key': tenant.publicKey },
      payload: { email: 'journey@example.com', name: 'Journey', visitor, source: 'product-page' },
    });
    const contactId = signup.json().contact_id as string;
    await confirmSubscription(signup.json().confirm_token as string);

    let balance = await authed('GET', `/v1/rewards/balance?contactId=${contactId}`);
    expect(balance.json().points.balance).toBe(100); // newsletter reward

    // 3. Share the product, and have somebody click it.
    const share = await authed('POST', '/v1/shares', {
      contactId,
      network: 'x',
      targetUrl: 'https://shop.example.com/product/flag',
      productRef: 'flag-1',
    });
    expect(share.statusCode).toBe(200);
    await app.inject({
      method: 'GET',
      url: `/r/${share.json().link_code}`,
      headers: { 'user-agent': DESKTOP_UA },
    });

    balance = await authed('GET', `/v1/rewards/balance?contactId=${contactId}`);
    expect(balance.json().points.balance).toBe(125); // + 25 for the verified share

    // 4. Buy, which converts the cart and grants held purchase points.
    const order = await authed('POST', '/v1/orders', {
      orderRef: 'journey-1',
      totalCents: 4999,
      subtotalCents: 4999,
      email: 'journey@example.com',
      cartToken: 'cart-journey',
      visitorAnonId: visitor,
      items: [{ productRef: 'flag-1', quantity: 1, subtotalCents: 4999 }],
    });
    expect(order.statusCode).toBe(200);
    expect(order.json().points_awarded).toBe(49);

    const { rows: carts } = await db().query('SELECT status FROM carts WHERE cart_token = $1', [
      'cart-journey',
    ]);
    expect(carts[0].status).toBe('converted');

    // 5. Connect a wallet and redeem points for TBAY.
    await authed('POST', '/v1/contacts/wallet', {
      contactId,
      walletAddress: '0x2222222222222222222222222222222222222222',
    });

    const redeem = await authed('POST', '/v1/token/redeem', {
      contactId,
      points: 125,
      walletAddress: '0x2222222222222222222222222222222222222222',
    });
    expect(redeem.statusCode).toBe(200);
    const voucher = redeem.json();
    expect(voucher.transaction.method).toBe('claim');
    expect(voucher.transaction.amountTokens).toBe('1.25');
    expect(voucher.balance.balance).toBe(0);

    // 6. The reports reflect all of it.
    const reports = await authed('GET', '/v1/reports/overview');
    expect(reports.json().overview).toMatchObject({ sessions: 1, orders: 1, revenue_cents: 4999 });

    const sources = await authed('GET', '/v1/reports/sources');
    expect(sources.json().sources[0]).toMatchObject({ source: 'instagram', medium: 'social', orders: 1 });

    const products = await authed('GET', '/v1/reports/products');
    expect(products.json().products[0]).toMatchObject({
      product_ref: 'flag-1',
      views: 1,
      add_to_carts: 1,
      purchases: 1,
    });

    const heatPages = await authed('GET', '/v1/reports/heatmap/pages');
    expect(heatPages.json().pages[0].page_key).toBe('/product/flag');

    const heatmap = await authed('GET', '/v1/reports/heatmap?page=/product/flag&kind=click');
    expect(heatmap.json().heatmap.cells.length).toBeGreaterThan(0);
    expect(heatmap.json().heatmap.xBins).toBe(100);

    const rewards = await authed('GET', '/v1/reports/rewards');
    expect(rewards.json().rewards).toMatchObject({ claims_signed: 1, shares_verified: 1 });
  });
});

describe('writer link workflow over the API', () => {
  it('mints a link, tracks a click and pays commission', async () => {
    const app = await testApp();

    await authed('POST', '/v1/contacts', { email: 'writer@example.com', name: 'Writer', isWriter: true });
    const link = await authed('POST', '/v1/links', {
      targetUrl: 'https://shop.example.com/product/flag',
      kind: 'writer',
      ownerEmail: 'writer@example.com',
      postRef: 'post-7',
      commissionRateBps: 800,
    });

    expect(link.statusCode).toBe(200);
    const code = link.json().code as string;
    expect(link.json().url).toContain(`/r/${code}`);

    await app.inject({ method: 'GET', url: `/r/${code}`, headers: { 'user-agent': DESKTOP_UA } });

    await authed('POST', '/v1/orders', {
      orderRef: 'writer-order-1',
      totalCents: 20_000,
      email: 'reader@example.com',
      linkCode: code,
      items: [{ productRef: 'flag-1', quantity: 1, subtotalCents: 20_000 }],
    });

    const commissions = await authed('GET', '/v1/commissions?email=writer@example.com');
    expect(commissions.json().summary).toMatchObject({ pending_cents: 1600, orders: 1 });

    const report = await authed('GET', '/v1/reports/blog-links');
    expect(report.json().links[0]).toMatchObject({
      post_ref: 'post-7',
      writer_name: 'Writer',
      clicks: 1,
      orders: 1,
      commission_cents: 1600,
    });
  });
});

describe('validation', () => {
  it('rejects a malformed collect payload with a field-level error', async () => {
    const app = await testApp();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/collect',
      headers: { 'x-tbay-key': tenant.publicKey },
      payload: { visitor: 'short', session: 'also-short' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('bad_request');
    expect(response.json().details).toBeInstanceOf(Array);
  });

  it('rejects a link with a non-http target', async () => {
    const response = await authed('POST', '/v1/links', { targetUrl: 'javascript:alert(1)' });
    expect(response.statusCode).toBe(400);
  });

  it('404s an unknown route as JSON', async () => {
    const app = await testApp();
    const response = await app.inject({ method: 'GET', url: '/v1/nope' });
    expect(response.statusCode).toBe(404);
    expect(response.json().error).toBe('not_found');
  });
});

describe('reward rule administration', () => {
  it('updates a rule and applies the new value immediately', async () => {
    await authed('POST', '/v1/contacts', { email: 'member@example.com' });

    const updated = await authed('PUT', '/v1/rewards/rules', {
      key: 'review',
      points: 500,
      dailyCap: null,
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().rule.points).toBe(500);

    const triggered = await authed('POST', '/v1/rewards/trigger', {
      email: 'member@example.com',
      ruleKey: 'review',
      refId: 'review-1',
    });
    expect(triggered.json()).toMatchObject({ awarded: true, points: 500 });
  });

  it('reports why an award was declined instead of failing', async () => {
    await authed('POST', '/v1/contacts', { email: 'member@example.com' });
    await authed('POST', '/v1/rewards/trigger', {
      email: 'member@example.com',
      ruleKey: 'account_created',
      refId: 'a',
    });

    const second = await authed('POST', '/v1/rewards/trigger', {
      email: 'member@example.com',
      ruleKey: 'account_created',
      refId: 'b',
    });
    expect(second.json()).toMatchObject({ awarded: false, reason: 'lifetime_cap' });
  });
});

describe('automations', () => {
  it('tags a big spender on order completion', async () => {
    await authed('POST', '/v1/orders', {
      orderRef: 'big-1',
      totalCents: 25_000,
      subtotalCents: 25_000,
      email: 'vip@example.com',
    });

    const { rows } = await db().query('SELECT tags FROM contacts WHERE email_normalised = $1', [
      'vip@example.com',
    ]);
    expect(rows[0].tags).toContain('vip');
  });

  it('leaves a small order untagged', async () => {
    await authed('POST', '/v1/orders', {
      orderRef: 'small-1',
      totalCents: 1000,
      subtotalCents: 1000,
      email: 'regular@example.com',
    });

    const { rows } = await db().query('SELECT tags FROM contacts WHERE email_normalised = $1', [
      'regular@example.com',
    ]);
    expect(rows[0].tags).toEqual([]);
  });

  it('runs an automation at most once per trigger occurrence', async () => {
    const order = {
      orderRef: 'repeat-1',
      totalCents: 25_000,
      subtotalCents: 25_000,
      email: 'vip2@example.com',
    };
    await authed('POST', '/v1/orders', order);
    await authed('POST', '/v1/orders', order);

    const { rows } = await db().query(
      `SELECT COUNT(*)::int AS n FROM automation_runs WHERE tenant_id = $1`,
      [tenant.id],
    );
    expect(rows[0].n).toBe(1);
  });
});

describe('email consent in automations', () => {
  it('will not send automation email to a contact without consent', async () => {
    await authed('PUT', '/v1/rewards/rules', { key: 'review', points: 100 });
    await authed('POST', '/v1/contacts', { email: 'noconsent@example.com' });

    await db().query(
      `UPDATE automations SET enabled = true WHERE tenant_id = $1 AND key = 'welcome_points_email'`,
      [tenant.id],
    );

    await authed('POST', '/v1/rewards/trigger', {
      email: 'noconsent@example.com',
      ruleKey: 'review',
      refId: 'r1',
    });

    await flushEmailQueue();
    expect(outbox()).toHaveLength(0);
  });
});

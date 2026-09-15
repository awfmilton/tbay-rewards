import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import {
  BOT_UA,
  DESKTOP_UA,
  MOBILE_UA,
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

async function post(body: unknown, ua = DESKTOP_UA) {
  const app = await testApp();
  return app.inject({
    method: 'POST',
    url: '/v1/collect',
    headers: { 'x-tbay-key': tenant.publicKey, 'user-agent': ua },
    payload: body,
  });
}

describe('event ingestion', () => {
  it('rejects an unknown site key', async () => {
    const app = await testApp();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/collect',
      headers: { 'x-tbay-key': 'tbp_nope' },
      payload: { visitor: 'visitor-1234', session: 'session-1234' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('creates a visitor, a session and events from one batch', async () => {
    const { visitor, session } = ids();
    const response = await post({
      visitor,
      session,
      url: 'https://shop.example.com/shop?utm_source=newsletter&utm_medium=email',
      referrer: null,
      events: [
        { type: 'pageview', url: 'https://shop.example.com/shop' },
        { type: 'click', props: { text: 'Buy' } },
      ],
    });

    expect(response.statusCode).toBe(204);

    const { rows: sessions } = await db().query(
      'SELECT * FROM sessions WHERE tenant_id = $1',
      [tenant.id],
    );
    expect(sessions).toHaveLength(1);
    expect(sessions[0].source).toBe('newsletter');
    expect(sessions[0].medium).toBe('email');
    expect(sessions[0].device_class).toBe('desktop');
    expect(sessions[0].pageviews).toBe(1);
    expect(sessions[0].events).toBe(2);

    const { rows: events } = await db().query('SELECT type FROM events WHERE tenant_id = $1 ORDER BY id', [
      tenant.id,
    ]);
    expect(events.map((row) => row.type)).toEqual(['pageview', 'click']);
  });

  it('keeps the first-touch source when a session continues', async () => {
    const { visitor, session } = ids();
    await post({
      visitor,
      session,
      url: 'https://shop.example.com/?utm_source=google&utm_medium=cpc',
      events: [{ type: 'pageview' }],
    });
    await post({
      visitor,
      session,
      url: 'https://shop.example.com/product/flag',
      referrer: 'https://shop.example.com/',
      events: [{ type: 'pageview' }],
    });

    const { rows } = await db().query('SELECT source, medium, pageviews FROM sessions WHERE tenant_id = $1', [
      tenant.id,
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe('google');
    expect(rows[0].pageviews).toBe(2);

    const { rows: touches } = await db().query('SELECT * FROM touchpoints WHERE tenant_id = $1', [
      tenant.id,
    ]);
    // One session start = one acquisition touchpoint, not one per pageview.
    expect(touches).toHaveLength(1);
  });

  it('classifies a social referrer without UTM parameters', async () => {
    const { visitor, session } = ids();
    await post({
      visitor,
      session,
      url: 'https://shop.example.com/product/flag',
      referrer: 'https://www.facebook.com/somepage',
      events: [{ type: 'pageview' }],
    });

    const { rows } = await db().query('SELECT source, medium FROM sessions WHERE tenant_id = $1', [
      tenant.id,
    ]);
    expect(rows[0].source).toBe('facebook');
    expect(rows[0].medium).toBe('social');
  });

  it('treats a same-site referrer as direct, not referral', async () => {
    const { visitor, session } = ids();
    await post({
      visitor,
      session,
      url: 'https://shop.example.com/checkout',
      referrer: 'https://shop.example.com/cart',
      events: [{ type: 'pageview' }],
    });

    const { rows } = await db().query('SELECT source, medium FROM sessions WHERE tenant_id = $1', [
      tenant.id,
    ]);
    expect(rows[0].source).toBe('direct');
    expect(rows[0].medium).toBe('none');
  });

  it('records bot traffic but keeps it out of heatmaps and product stats', async () => {
    const { visitor, session } = ids();
    await post(
      {
        visitor,
        session,
        url: 'https://shop.example.com/product/flag',
        events: [{ type: 'product_view', productRef: 'flag-1' }],
        heatmap: [{ page: 'https://shop.example.com/product/flag', kind: 'click', samples: [{ x: 0.5, y: 0.5 }] }],
      },
      BOT_UA,
    );

    const { rows: sessions } = await db().query('SELECT is_bot FROM sessions WHERE tenant_id = $1', [
      tenant.id,
    ]);
    expect(sessions[0].is_bot).toBe(true);

    const { rows: cells } = await db().query('SELECT * FROM heatmap_cells WHERE tenant_id = $1', [
      tenant.id,
    ]);
    expect(cells).toHaveLength(0);

    const { rows: stats } = await db().query('SELECT * FROM product_stats WHERE tenant_id = $1', [
      tenant.id,
    ]);
    expect(stats).toHaveLength(0);

    const { rows: touches } = await db().query('SELECT * FROM touchpoints WHERE tenant_id = $1', [
      tenant.id,
    ]);
    expect(touches).toHaveLength(0);
  });
});

describe('heatmap aggregation', () => {
  it('bins normalised samples into the grid and sums repeat hits', async () => {
    const { visitor, session } = ids();
    await post({
      visitor,
      session,
      url: 'https://shop.example.com/shop',
      events: [{ type: 'pageview' }],
      heatmap: [
        {
          page: 'https://shop.example.com/shop',
          kind: 'click',
          docHeight: 4000,
          viewportWidth: 1440,
          samples: [
            { x: 0.5, y: 0.25 },
            { x: 0.503, y: 0.2505 }, // same cell
            { x: 0.9, y: 0.8 },
          ],
        },
      ],
    });

    const { rows } = await db().query(
      'SELECT x_bin, y_bin, weight FROM heatmap_cells WHERE tenant_id = $1 ORDER BY weight DESC',
      [tenant.id],
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ x_bin: 50, y_bin: 50, weight: 2 });
    expect(rows[1]).toMatchObject({ x_bin: 90, y_bin: 160, weight: 1 });

    const { rows: pages } = await db().query('SELECT * FROM heatmap_pages WHERE tenant_id = $1', [
      tenant.id,
    ]);
    expect(pages[0].page_key).toBe('/shop');
    expect(pages[0].avg_doc_height).toBe(4000);
    expect(pages[0].sample_sessions).toBe(1);
  });

  it('separates heatmaps by device class', async () => {
    const desktop = ids();
    const mobile = ids();
    const batch = (page: string) => ({
      page,
      kind: 'click' as const,
      samples: [{ x: 0.1, y: 0.1 }],
    });

    await post(
      { ...desktop, url: 'https://shop.example.com/shop', heatmap: [batch('https://shop.example.com/shop')] },
      DESKTOP_UA,
    );
    await post(
      { ...mobile, url: 'https://shop.example.com/shop', heatmap: [batch('https://shop.example.com/shop')] },
      MOBILE_UA,
    );

    const { rows } = await db().query(
      'SELECT device_class FROM heatmap_cells WHERE tenant_id = $1 ORDER BY device_class',
      [tenant.id],
    );
    expect(rows.map((row) => row.device_class)).toEqual(['desktop', 'mobile']);
  });

  it('groups templated pages under a configured page-key pattern', async () => {
    const patterned = await makeTenant({ settings: { pageKeyPatterns: ['/product/:slug'] } });
    const app = await testApp();

    for (const slug of ['red-ensign', 'blue-ensign']) {
      const { visitor, session } = ids();
      await app.inject({
        method: 'POST',
        url: '/v1/collect',
        headers: { 'x-tbay-key': patterned.publicKey, 'user-agent': DESKTOP_UA },
        payload: {
          visitor,
          session,
          url: `https://shop.example.com/product/${slug}`,
          heatmap: [
            {
              page: `https://shop.example.com/product/${slug}`,
              kind: 'click',
              samples: [{ x: 0.5, y: 0.5 }],
            },
          ],
        },
      });
    }

    const { rows } = await db().query(
      'SELECT page_key, weight FROM heatmap_cells WHERE tenant_id = $1',
      [patterned.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].page_key).toBe('/product/:slug');
    expect(rows[0].weight).toBe(2);
  });

  it('clamps out-of-range coordinates instead of dropping the sample', async () => {
    const { visitor, session } = ids();
    await post({
      visitor,
      session,
      url: 'https://shop.example.com/shop',
      heatmap: [
        {
          page: 'https://shop.example.com/shop',
          kind: 'click',
          samples: [{ x: 1.4, y: -0.2 }],
        },
      ],
    });

    const { rows } = await db().query('SELECT x_bin, y_bin FROM heatmap_cells WHERE tenant_id = $1', [
      tenant.id,
    ]);
    expect(rows[0]).toMatchObject({ x_bin: 99, y_bin: 0 });
  });
});

describe('product engagement', () => {
  it('rolls up views, clicks and add-to-carts per product per day', async () => {
    const { visitor, session } = ids();
    await post({
      visitor,
      session,
      url: 'https://shop.example.com/product/flag',
      events: [
        {
          type: 'product_view',
          productRef: 'flag-1',
          product: { name: 'Red Ensign', priceCents: 4999 },
        },
        { type: 'product_click', productRef: 'flag-1' },
        { type: 'product_click', productRef: 'flag-1' },
        { type: 'add_to_cart', productRef: 'flag-1', valueCents: 4999 },
      ],
    });

    const { rows } = await db().query(
      'SELECT views, clicks, add_to_carts FROM product_stats WHERE tenant_id = $1 AND product_ref = $2',
      [tenant.id, 'flag-1'],
    );
    expect(rows[0]).toMatchObject({ views: 1, clicks: 2, add_to_carts: 1 });

    const { rows: products } = await db().query(
      'SELECT name, price_cents FROM products WHERE tenant_id = $1',
      [tenant.id],
    );
    expect(products[0]).toMatchObject({ name: 'Red Ensign', price_cents: 4999 });
  });
});

describe('cart tracking', () => {
  it('stores a cart and expires it when emptied', async () => {
    const { visitor, session } = ids();
    const cart = (items: unknown[]) => ({
      visitor,
      session,
      url: 'https://shop.example.com/cart',
      cart: { cartToken: 'cart-abc', items, currency: 'CAD' },
    });

    await post(cart([{ productRef: 'flag-1', quantity: 2, priceCents: 4999 }]));
    let { rows } = await db().query('SELECT * FROM carts WHERE tenant_id = $1', [tenant.id]);
    expect(rows[0]).toMatchObject({
      status: 'active',
      item_count: 2,
      subtotal_cents: 9998,
      currency: 'CAD',
    });

    await post(cart([]));
    ({ rows } = await db().query('SELECT status, item_count FROM carts WHERE tenant_id = $1', [
      tenant.id,
    ]));
    expect(rows[0]).toMatchObject({ status: 'expired', item_count: 0 });
  });
});

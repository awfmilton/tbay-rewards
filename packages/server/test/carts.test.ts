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
import { cartStats, getCartByToken, sweepAbandonedCarts, upsertCart } from '../src/services/carts.js';
import { upsertContact } from '../src/services/contacts.js';
import { recordOrder } from '../src/services/commissions.js';
import { runCartRecovery } from '../src/workers/cart-recovery.js';
import { flushEmailQueue, outbox, setEmailTransport } from '../src/services/email.js';
import { getTenantById } from '../src/services/tenants.js';
import { confirmSubscription, subscribe } from '../src/services/newsletter.js';

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

const tenantObject = async () => (await getTenantById(tenant.id))!;

const ITEMS = [
  { productRef: 'flag-1', name: 'Red Ensign', quantity: 2, priceCents: 4999 },
  { productRef: 'mug-9', name: 'Mug', quantity: 1, priceCents: 1500 },
];

/** A contact who has confirmed marketing consent, so recovery mail is allowed. */
async function consentedContact(email = 'shopper@example.com') {
  const result = await subscribe(await tenantObject(), { email });
  await confirmSubscription(result.confirmToken!);
  // Drain the opt-in and welcome mail so the outbox only holds recovery sends.
  await flushEmailQueue();
  outbox().length = 0;
  return result.contact;
}

async function ageCart(cartToken: string, minutes: number) {
  await db().query(
    `UPDATE carts SET updated_at = now() - ($2 || ' minutes')::interval WHERE cart_token = $1`,
    [cartToken, String(minutes)],
  );
}

async function ageAbandonment(cartToken: string, hours: number) {
  await db().query(
    `UPDATE carts SET abandoned_at = now() - ($2 || ' hours')::interval WHERE cart_token = $1`,
    [cartToken, String(hours)],
  );
}

describe('abandoned cart detection', () => {
  it('leaves a fresh cart alone', async () => {
    await upsertCart(db(), tenant.id, { cartToken: 'cart-1', items: ITEMS });
    expect(await sweepAbandonedCarts()).toHaveLength(0);
  });

  it('marks a quiet cart abandoned after the configured delay', async () => {
    await upsertCart(db(), tenant.id, { cartToken: 'cart-1', items: ITEMS });
    await ageCart('cart-1', 90); // default threshold is 60 minutes

    const swept = await sweepAbandonedCarts();
    expect(swept).toHaveLength(1);
    expect(swept[0].subtotal_cents).toBe(2 * 4999 + 1500);

    const cart = await getCartByToken(tenant.id, 'cart-1');
    expect(cart?.status).toBe('abandoned');
    expect(cart?.abandoned_at).not.toBeNull();
  });

  it('never abandons an empty cart', async () => {
    await upsertCart(db(), tenant.id, { cartToken: 'cart-empty', items: [] });
    await ageCart('cart-empty', 300);
    expect(await sweepAbandonedCarts()).toHaveLength(0);
  });

  it('returns an abandoned cart to active when the shopper comes back', async () => {
    await upsertCart(db(), tenant.id, { cartToken: 'cart-1', items: ITEMS });
    await ageCart('cart-1', 90);
    await sweepAbandonedCarts();

    await upsertCart(db(), tenant.id, {
      cartToken: 'cart-1',
      items: [...ITEMS, { productRef: 'pin-3', quantity: 1, priceCents: 900 }],
    });

    const cart = await getCartByToken(tenant.id, 'cart-1');
    expect(cart?.status).toBe('active');
    expect(cart?.abandoned_at).toBeNull();
  });

  it('closes the cart out when the order arrives', async () => {
    const contact = await upsertContact(tenant.id, { email: 'shopper@example.com' });
    await upsertCart(db(), tenant.id, { cartToken: 'cart-1', items: ITEMS, contactId: contact.id });

    await recordOrder(await tenantObject(), {
      orderRef: 'order-1',
      totalCents: 11_498,
      email: 'shopper@example.com',
      cartToken: 'cart-1',
    });

    const cart = await getCartByToken(tenant.id, 'cart-1');
    expect(cart?.status).toBe('converted');
    expect(cart?.converted_order_ref).toBe('order-1');
  });
});

describe('cart recovery emails', () => {
  it('sends stage one after the first interval, and not before', async () => {
    const contact = await consentedContact();
    await upsertCart(db(), tenant.id, { cartToken: 'cart-1', items: ITEMS, contactId: contact.id });
    await ageCart('cart-1', 90);

    // Abandoned, but the stage-1 delay (1 hour) has not elapsed yet.
    let run = await runCartRecovery();
    expect(run.abandoned).toBe(1);
    expect(run.queued).toBe(0);

    await ageAbandonment('cart-1', 2);
    run = await runCartRecovery();
    expect(run.queued).toBe(1);

    await flushEmailQueue();
    expect(outbox()).toHaveLength(1);
    expect(outbox()[0].subject).toBe('You left something behind');
    expect(outbox()[0].html).toContain('/c/');
  });

  it('does not send the same stage twice', async () => {
    const contact = await consentedContact();
    await upsertCart(db(), tenant.id, { cartToken: 'cart-1', items: ITEMS, contactId: contact.id });
    await ageCart('cart-1', 90);
    await runCartRecovery();
    await ageAbandonment('cart-1', 2);

    await runCartRecovery();
    await runCartRecovery();
    await runCartRecovery();

    await flushEmailQueue();
    expect(outbox()).toHaveLength(1);
  });

  it('advances through the stages as time passes', async () => {
    const contact = await consentedContact();
    await upsertCart(db(), tenant.id, { cartToken: 'cart-1', items: ITEMS, contactId: contact.id });
    await ageCart('cart-1', 90);
    await runCartRecovery();

    for (const hours of [2, 25, 80]) {
      await ageAbandonment('cart-1', hours);
      await runCartRecovery();
    }

    await flushEmailQueue();
    expect(outbox().map((message) => message.subject)).toEqual([
      'You left something behind',
      'Your cart is still waiting',
      'Last call for your cart',
    ]);

    // Three stages configured; a fourth pass sends nothing.
    await ageAbandonment('cart-1', 500);
    await runCartRecovery();
    await flushEmailQueue();
    expect(outbox()).toHaveLength(3);
  });

  it('never mails a shopper who has not opted in', async () => {
    const contact = await upsertContact(tenant.id, { email: 'noconsent@example.com' });
    await upsertCart(db(), tenant.id, { cartToken: 'cart-1', items: ITEMS, contactId: contact.id });
    await ageCart('cart-1', 90);
    await runCartRecovery();
    await ageAbandonment('cart-1', 2);

    const run = await runCartRecovery();
    expect(run.queued).toBe(0);
    await flushEmailQueue();
    expect(outbox()).toHaveLength(0);
  });

  it('skips a cart with no known email address', async () => {
    await upsertCart(db(), tenant.id, { cartToken: 'cart-anon', items: ITEMS });
    await ageCart('cart-anon', 90);
    await runCartRecovery();
    await ageAbandonment('cart-anon', 5);

    expect((await runCartRecovery()).queued).toBe(0);
  });

  it('follows the recovery link back to checkout', async () => {
    const contact = await consentedContact();
    await upsertCart(db(), tenant.id, {
      cartToken: 'cart-1',
      items: ITEMS,
      contactId: contact.id,
      checkoutUrl: 'https://shop.example.com/checkout',
    });
    const cart = await getCartByToken(tenant.id, 'cart-1');

    const app = await testApp();
    const response = await app.inject({ method: 'GET', url: `/c/${cart!.recovery_token}` });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toContain('https://shop.example.com/checkout');
    expect(response.headers.location).toContain('tb_cart=cart-1');
  });

  it('counts a mailed cart that later converts as recovered', async () => {
    const contact = await consentedContact();
    await upsertCart(db(), tenant.id, { cartToken: 'cart-1', items: ITEMS, contactId: contact.id });
    await ageCart('cart-1', 90);
    await runCartRecovery();
    await ageAbandonment('cart-1', 2);
    await runCartRecovery();

    await recordOrder(await tenantObject(), {
      orderRef: 'order-2',
      totalCents: 11_498,
      email: 'shopper@example.com',
      cartToken: 'cart-1',
    });

    const cart = await getCartByToken(tenant.id, 'cart-1');
    expect(cart?.status).toBe('recovered');
    expect(cart?.recovered_at).not.toBeNull();

    const stats = await cartStats(tenant.id, new Date(Date.now() - 86_400_000), new Date());
    expect(stats.recovered).toBe(1);
    expect(stats.recovered_value_cents).toBe(11_498);
    expect(stats.recovery_rate).toBe(1);
  });

  it('reports abandonment and recovery rates', async () => {
    const contact = await consentedContact();
    for (const token of ['a', 'b', 'c']) {
      await upsertCart(db(), tenant.id, { cartToken: token, items: ITEMS, contactId: contact.id });
      await ageCart(token, 90);
    }
    await sweepAbandonedCarts();

    await recordOrder(await tenantObject(), {
      orderRef: 'order-3',
      totalCents: 11_498,
      email: 'shopper@example.com',
      cartToken: 'c',
    });

    const stats = await cartStats(tenant.id, new Date(Date.now() - 86_400_000), new Date());
    expect(stats.abandoned).toBe(2);
    expect(stats.converted).toBe(1);
    expect(stats.abandonment_rate).toBeCloseTo(0.6667, 3);
  });
});

import { upsertContact } from '../src/services/contacts.js';
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

async function authed(method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) {
  const app = await testApp();
  return app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${tenant.secretKey}` },
    ...(payload === undefined ? {} : { payload }),
  });
}

async function funded(email: string, points: number): Promise<string> {
  // Quietly: POST /v1/contacts pays the shipped signup rule now, and `funded`
  // exists to give a contact an exact opening balance.
  const { id } = await upsertContact(tenant.id, {
    email,
    name: null,
    phone: null,
    externalRef: null,
    attributes: {},
    tags: [],
  });
  await authed('POST', '/v1/rewards/adjust', {
    contactId: id,
    points,
    reason: 'seed',
    idempotencyKey: `seed-${email}`,
  });
  return id;
}

describe('spending points for store credit', () => {
  it('quotes what points are worth before anything is spent', async () => {
    const quote = JSON.parse((await authed('GET', '/v1/credit/quote?points=550')).body);
    // 100 points per token, 100 cents per token: 500 points is $5, and the
    // leftover 50 are reported as unusable rather than silently rounded in.
    expect(quote.points).toBe(500);
    expect(quote.amount_cents).toBe(500);
    expect(quote.points_per_token).toBe(100);
  });

  it('issues a credit code and debits the points', async () => {
    const contact = await funded('spend@example.com', 1000);

    const response = await authed('POST', '/v1/credit/redeem', { contactId: contact, points: 500 });
    expect(response.statusCode).toBe(200);

    const body = JSON.parse(response.body);
    expect(body.code).toMatch(/^PTS-/);
    expect(body.amount_cents).toBe(500);
    expect(body.balance.balance).toBe(500);

    const { rows } = await db().query<{ status: string; source: string }>(
      'SELECT status, source FROM store_credits WHERE tenant_id = $1',
      [tenant.id],
    );
    expect(rows[0]).toMatchObject({ status: 'active', source: 'points' });
  });

  it('refuses more points than the customer has', async () => {
    const contact = await funded('poor@example.com', 100);
    const response = await authed('POST', '/v1/credit/redeem', { contactId: contact, points: 500 });
    expect(response.statusCode).toBe(422);
    expect(JSON.parse(response.body).error).toBe('unprocessable');
  });

  it('refuses an amount that is not a whole number of tokens', async () => {
    const contact = await funded('odd@example.com', 1000);
    const response = await authed('POST', '/v1/credit/redeem', { contactId: contact, points: 150 });
    expect(response.statusCode).toBe(422);
    expect(JSON.parse(response.body).message).toContain('blocks of 100');
  });

  it('cannot issue two credits from one debit in the same second', async () => {
    const contact = await funded('double@example.com', 1000);

    // The same guard the voucher path needed: an idempotency hit means the
    // points were not debited again, so a second credit would be free money.
    const [first, second] = await Promise.all([
      authed('POST', '/v1/credit/redeem', { contactId: contact, points: 500 }),
      authed('POST', '/v1/credit/redeem', { contactId: contact, points: 500 }),
    ]);

    const codes = [first, second].filter((r) => r.statusCode === 200);
    expect(codes).toHaveLength(1);

    const { rows } = await db().query<{ n: string }>(
      'SELECT COUNT(*) AS n FROM store_credits WHERE tenant_id = $1',
      [tenant.id],
    );
    expect(Number(rows[0]!.n)).toBe(1);

    const balance = await db().query<{ balance: number }>(
      'SELECT balance FROM points_balances WHERE contact_id = $1',
      [contact],
    );
    expect(balance.rows[0]!.balance).toBe(500);
  });

  it('is worth the same as the TBAY route, so neither can be arbitraged', async () => {
    await authed('PUT', '/v1/settings', { creditBonusBps: 1000 }); // a 10% retailer bonus
    const quote = JSON.parse((await authed('GET', '/v1/credit/quote?points=1000')).body);

    // 10 tokens x 100 cents x 1.10 — the same arithmetic the TBAY spend path
    // applies, so a customer choosing between them is choosing convenience.
    expect(quote.amount_cents).toBe(1100);
  });

  it('redeems the whole code against an order exactly once', async () => {
    const contact = await funded('once@example.com', 500);
    const { code } = JSON.parse(
      (await authed('POST', '/v1/credit/redeem', { contactId: contact, points: 500 })).body,
    );

    const { redeemStoreCredit } = await import('../src/services/token.js');
    expect(await redeemStoreCredit(tenant.id, code, 'order-1')).not.toBeNull();
    // Nothing left, so a different order is refused.
    await expect(redeemStoreCredit(tenant.id, code, 'order-2'))
      .rejects.toThrow(/already been used/i);
  });

  it('draws the credit down instead of destroying the remainder', async () => {
    // A $5 credit spent on a 50c basket used to burn the whole code. The
    // customer lost $4.50 and the store looked like it had taken it.
    const contact = await funded('partial@example.com', 500);
    const { code, amount_cents } = JSON.parse(
      (await authed('POST', '/v1/credit/redeem', { contactId: contact, points: 500 })).body,
    );
    expect(amount_cents).toBe(500);

    const { redeemStoreCredit } = await import('../src/services/token.js');
    const first = await redeemStoreCredit(tenant.id, code, 'order-a', 50);
    expect(first).toMatchObject({ amount_cents: 50, remaining_cents: 450 });

    const second = await redeemStoreCredit(tenant.id, code, 'order-b', 450);
    expect(second).toMatchObject({ amount_cents: 450, remaining_cents: 0 });

    // Now it really is spent — and says so, rather than "no such code",
    // which would send a customer to support over a credit they used.
    await expect(redeemStoreCredit(tenant.id, code, 'order-c', 1))
      .rejects.toThrow(/already been used/i);
    expect(await redeemStoreCredit(tenant.id, 'PTS-NOSUCHCODE', 'order-d', 1)).toBeNull();
  });

  it('answers a repeated redemption for one order without taking more', async () => {
    // A checkout retried after a timeout cannot tell "that did not go through"
    // from "that went through and the reply was lost".
    const contact = await funded('retry@example.com', 500);
    const { code } = JSON.parse(
      (await authed('POST', '/v1/credit/redeem', { contactId: contact, points: 500 })).body,
    );

    const { redeemStoreCredit } = await import('../src/services/token.js');
    const first = await redeemStoreCredit(tenant.id, code, 'order-retry', 200);
    const again = await redeemStoreCredit(tenant.id, code, 'order-retry', 200);

    expect(first).toMatchObject({ amount_cents: 200, already_redeemed: false });
    expect(again).toMatchObject({ amount_cents: 200, already_redeemed: true });

    const { rows } = await db().query<{ redeemed_cents: string }>(
      'SELECT redeemed_cents FROM store_credits WHERE tenant_id = $1 AND code = $2',
      [tenant.id, code],
    );
    expect(Number(rows[0]!.redeemed_cents)).toBe(200);
  });

  it('refuses to spend more of a credit than is left', async () => {
    const contact = await funded('over@example.com', 500);
    const { code } = JSON.parse(
      (await authed('POST', '/v1/credit/redeem', { contactId: contact, points: 500 })).body,
    );

    const { redeemStoreCredit } = await import('../src/services/token.js');
    await redeemStoreCredit(tenant.id, code, 'order-1', 400);
    await expect(redeemStoreCredit(tenant.id, code, 'order-2', 200)).rejects.toThrow(/100 cents left/);
  });

  it('two checkouts racing the same credit cannot both spend it', async () => {
    const contact = await funded('race@example.com', 500);
    const { code } = JSON.parse(
      (await authed('POST', '/v1/credit/redeem', { contactId: contact, points: 500 })).body,
    );

    const { redeemStoreCredit } = await import('../src/services/token.js');
    const results = await Promise.allSettled([
      redeemStoreCredit(tenant.id, code, 'race-a', 500),
      redeemStoreCredit(tenant.id, code, 'race-b', 500),
    ]);

    const won = results.filter((r) => r.status === 'fulfilled' && r.value !== null);
    expect(won).toHaveLength(1);
    // The loser is told the credit is spent, not that it never existed.
    const lost = results.find((r) => r.status === 'rejected');
    expect(String((lost as PromiseRejectedResult).reason)).toMatch(/already been used/i);

    const { rows } = await db().query<{ redeemed_cents: string }>(
      'SELECT redeemed_cents FROM store_credits WHERE tenant_id = $1 AND code = $2',
      [tenant.id, code],
    );
    expect(Number(rows[0]!.redeemed_cents)).toBe(500);
  });

  it('offers what is left of a credit, not its face value', async () => {
    const contact = await funded('quote@example.com', 500);
    const { code } = JSON.parse(
      (await authed('POST', '/v1/credit/redeem', { contactId: contact, points: 500 })).body,
    );

    const { redeemStoreCredit } = await import('../src/services/token.js');
    await redeemStoreCredit(tenant.id, code, 'order-part', 300);

    const reserved = JSON.parse(
      (await authed('POST', '/v1/token/credit/reserve', { contactId: contact })).body,
    );
    // A storefront quoting the face value offers a discount the platform
    // would then refuse, and the customer sees the checkout fail.
    expect(reserved.remaining_cents).toBe(200);
    expect(reserved.amount_cents).toBe(200);
    expect(reserved.face_value_cents).toBe(500);
  });
});

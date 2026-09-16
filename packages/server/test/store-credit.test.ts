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
  const id = JSON.parse((await authed('POST', '/v1/contacts', { email })).body).contact_id;
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

  it('redeems the code against an order exactly once', async () => {
    const contact = await funded('once@example.com', 500);
    const { code } = JSON.parse(
      (await authed('POST', '/v1/credit/redeem', { contactId: contact, points: 500 })).body,
    );

    const { redeemStoreCredit } = await import('../src/services/token.js');
    expect(await redeemStoreCredit(tenant.id, code, 'order-1')).not.toBeNull();
    expect(await redeemStoreCredit(tenant.id, code, 'order-2')).toBeNull();
  });
});

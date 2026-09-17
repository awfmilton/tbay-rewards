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
import { award, getBalance, listLedger, releaseMaturedPoints, reverse, spend } from '../src/services/points.js';
import { trigger, upsertRule } from '../src/services/rewards.js';
import { getTenantById } from '../src/services/tenants.js';

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

async function contact(email = 'buyer@example.com') {
  return upsertContact(tenant.id, { email, name: 'Test Buyer' });
}

describe('points ledger', () => {
  it('credits points and keeps the balance cache in step', async () => {
    const person = await contact();
    const result = await award(tenant.id, {
      contactId: person.id,
      points: 150,
      reason: 'Manual grant',
      idempotencyKey: 'grant-1',
    });

    expect(result.created).toBe(true);
    expect(result.balance).toMatchObject({ balance: 150, lifetime_earned: 150, pending: 0 });

    const balance = await getBalance(tenant.id, person.id);
    expect(balance.balance).toBe(150);
  });

  it('is idempotent on a repeated key', async () => {
    const person = await contact();
    const key = 'order-42';

    const first = await award(tenant.id, { contactId: person.id, points: 100, reason: 'Order', idempotencyKey: key });
    const second = await award(tenant.id, { contactId: person.id, points: 100, reason: 'Order', idempotencyKey: key });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect((await getBalance(tenant.id, person.id)).balance).toBe(100);

    const entries = await listLedger(tenant.id, person.id);
    expect(entries).toHaveLength(1);
  });

  it('refuses to spend more than the balance', async () => {
    const person = await contact();
    await award(tenant.id, { contactId: person.id, points: 50, reason: 'Grant', idempotencyKey: 'g1' });

    await expect(
      spend(tenant.id, { contactId: person.id, points: 80, reason: 'Redeem', idempotencyKey: 's1' }),
    ).rejects.toMatchObject({ statusCode: 422 });

    expect((await getBalance(tenant.id, person.id)).balance).toBe(50);
  });

  it('holds points until they mature, then releases them', async () => {
    const person = await contact();
    const result = await award(tenant.id, {
      contactId: person.id,
      points: 200,
      reason: 'Purchase',
      idempotencyKey: 'purchase-1',
      holdSeconds: 3600,
    });

    expect(result.balance).toMatchObject({ balance: 0, pending: 200 });
    // Held points cannot be spent.
    await expect(
      spend(tenant.id, { contactId: person.id, points: 100, reason: 'Redeem', idempotencyKey: 's2' }),
    ).rejects.toMatchObject({ statusCode: 422 });

    await db().query(
      `UPDATE points_ledger SET available_at = now() - interval '1 minute' WHERE id = $1`,
      [result.entry.id],
    );
    const released = await releaseMaturedPoints();
    expect(released).toBe(1);

    expect(await getBalance(tenant.id, person.id)).toMatchObject({ balance: 200, pending: 0 });
  });

  it('reverses an award with a compensating entry rather than deleting it', async () => {
    const person = await contact();
    const granted = await award(tenant.id, {
      contactId: person.id,
      points: 300,
      reason: 'Purchase',
      idempotencyKey: 'purchase-2',
    });

    const compensation = await reverse(tenant.id, granted.entry.id, 'Refunded');
    expect(compensation?.delta_points).toBe(-300);
    expect(await getBalance(tenant.id, person.id)).toMatchObject({ balance: 0, lifetime_earned: 0 });

    const { rows } = await db().query('SELECT status FROM points_ledger WHERE id = $1', [granted.entry.id]);
    expect(rows[0].status).toBe('reversed');

    const entries = await listLedger(tenant.id, person.id);
    expect(entries).toHaveLength(2);
  });

  it('unwinds a held award from the pending bucket only', async () => {
    const person = await contact();
    const granted = await award(tenant.id, {
      contactId: person.id,
      points: 120,
      reason: 'Purchase',
      idempotencyKey: 'purchase-3',
      holdSeconds: 600,
    });

    await reverse(tenant.id, granted.entry.id, 'Refunded before maturity');
    expect(await getBalance(tenant.id, person.id)).toMatchObject({ balance: 0, pending: 0 });
  });
});

describe('reward rules', () => {
  it('awards the configured points for a rule', async () => {
    const person = await contact();
    const outcome = await trigger(tenant.id, {
      contactId: person.id,
      ruleKey: 'account_created',
      refId: person.id,
    });

    expect(outcome.awarded).toBe(true);
    if (outcome.awarded) expect(outcome.points).toBe(50);
  });

  it('scales per_currency_unit rules by order value', async () => {
    const person = await contact();
    const outcome = await trigger(tenant.id, {
      contactId: person.id,
      ruleKey: 'purchase',
      refId: 'order-1',
      valueCents: 12_345, // $123.45 → 123 whole units → 123 points
    });

    expect(outcome.awarded).toBe(true);
    if (outcome.awarded) expect(outcome.points).toBe(123);
    // Purchase points are held through the refund window.
    expect((await getBalance(tenant.id, person.id)).pending).toBe(123);
  });

  it('enforces a cooldown between awards', async () => {
    const person = await contact();
    await upsertRule(tenant.id, { key: 'daily_visit', name: 'Daily visit', event_key: 'visit',
      points: 10, cooldown_seconds: 3600, enabled: true } as never);

    const first = await trigger(tenant.id, { contactId: person.id, ruleKey: 'daily_visit', refId: 'v1' });
    const second = await trigger(tenant.id, { contactId: person.id, ruleKey: 'daily_visit', refId: 'v2' });

    expect(first.awarded).toBe(true);
    expect(second.awarded).toBe(false);
    if (!second.awarded) expect(second.reason).toBe('cooldown');
    expect((await getBalance(tenant.id, person.id)).balance).toBe(10);
  });

  it('enforces a daily cap', async () => {
    const person = await contact();
    await upsertRule(tenant.id, { key: 'capped', name: 'Capped', event_key: 'capped',
      points: 40, daily_cap: 100, enabled: true } as never);

    const outcomes = [];
    for (let i = 0; i < 4; i += 1) {
      outcomes.push(await trigger(tenant.id, { contactId: person.id, ruleKey: 'capped', refId: `c${i}` }));
    }

    expect(outcomes.filter((o) => o.awarded)).toHaveLength(2); // 40 + 40, third would exceed 100
    expect((await getBalance(tenant.id, person.id)).balance).toBe(80);
  });

  it('enforces a lifetime cap so one-time rewards stay one-time', async () => {
    const person = await contact();
    const first = await trigger(tenant.id, { contactId: person.id, ruleKey: 'account_created', refId: 'a' });
    const second = await trigger(tenant.id, { contactId: person.id, ruleKey: 'account_created', refId: 'b' });

    expect(first.awarded).toBe(true);
    expect(second.awarded).toBe(false);
    if (!second.awarded) expect(second.reason).toBe('lifetime_cap');
  });

  it('does not double-award the same occurrence', async () => {
    const person = await contact();
    await trigger(tenant.id, { contactId: person.id, ruleKey: 'referral', refId: 'ref-1' });
    await trigger(tenant.id, { contactId: person.id, ruleKey: 'referral', refId: 'ref-1' });

    expect((await getBalance(tenant.id, person.id)).balance).toBe(250);
  });

  it('reports a missing rule instead of throwing', async () => {
    const person = await contact();
    const outcome = await trigger(tenant.id, { contactId: person.id, ruleKey: 'nope', refId: 'x' });
    expect(outcome.awarded).toBe(false);
    if (!outcome.awarded) expect(outcome.reason).toBe('rule_missing');
  });

  it('keeps balances isolated between retailers', async () => {
    const other = await makeTenant();
    const here = await contact('shared@example.com');
    const there = await upsertContact(other.id, { email: 'shared@example.com' });

    await award(tenant.id, { contactId: here.id, points: 500, reason: 'Grant', idempotencyKey: 'g' });

    expect((await getBalance(tenant.id, here.id)).balance).toBe(500);
    expect((await getBalance(other.id, there.id)).balance).toBe(0);
    // ...but both profiles resolve to the same global member, which is what
    // makes one TBAY balance spendable across retailers.
    expect(here.member_id).toBe(there.member_id);
    expect(here.member_id).not.toBeNull();
  });
});

describe('a rule earns on the event it names (HIGH)', () => {
  it('awards the shipped account_created rule when a contact is created', async () => {
    // `event_key` was decorative. Every rule carried one, the admin API let a
    // retailer set one, `rulesForEvent` existed to look one up -- and nothing
    // called it, so a rule only ever fired when some call site named its key
    // as a literal. Six of the seven shipped rules have such a call site. The
    // seventh, `account_created`, ships enabled on every tenant with 50 points
    // on it and awarded nobody anything: two independent reviewers reproduced
    // signup end to end and found zero ledger rows.
    const app = await testApp();
    const created = await app.inject({
      method: 'POST',
      url: '/v1/contacts',
      headers: { authorization: `Bearer ${tenant.secretKey}` },
      payload: { email: 'newcomer@example.com' },
    });
    expect(created.statusCode).toBe(200);
    const contactId = JSON.parse(created.body).contact_id as string;

    const balance = await getBalance(tenant.id, contactId);
    expect(balance.balance).toBe(50);

    // And only once, however many times the same person is upserted.
    await app.inject({
      method: 'POST',
      url: '/v1/contacts',
      headers: { authorization: `Bearer ${tenant.secretKey}` },
      payload: { email: 'newcomer@example.com', name: 'Newcomer' },
    });
    expect((await getBalance(tenant.id, contactId)).balance).toBe(50);
  });

  it('earns a retailer\'s own rule on an event nothing names by key', async () => {
    // The gap behind the shipped-rule bug: a retailer could create a rule with
    // its own eventKey through the admin API and it could never be earned,
    // because the only dispatcher was a literal key in our source.
    await upsertRule(tenant.id, {
      key: 'birthday_bonus',
      name: 'Birthday bonus',
      event_key: 'contact.created',
      points: 25,
      enabled: true,
    });

    const app = await testApp();
    const created = await app.inject({
      method: 'POST',
      url: '/v1/contacts',
      headers: { authorization: `Bearer ${tenant.secretKey}` },
      payload: { email: 'custom-rule@example.com' },
    });
    const contactId = JSON.parse(created.body).contact_id as string;

    // Both rules listening for contact.created: the shipped 50 and the
    // retailer's 25.
    expect((await getBalance(tenant.id, contactId)).balance).toBe(75);
  });

  it('does not pay a rule twice when a call site already awards it by name', async () => {
    // The ledger's idempotency key is rule:<key>:<contact>:<refId>, and the
    // call sites use their own refIds -- a subscription id, an order id --
    // which would not collide with an event-dispatched one. So event dispatch
    // has to skip the six rules that a named call site owns, or a newsletter
    // confirmation pays twice.
    const { awardRulesForEvent } = await import('../src/services/rewards.js');
    const app = await testApp();
    const created = await app.inject({
      method: 'POST',
      url: '/v1/contacts',
      headers: { authorization: `Bearer ${tenant.secretKey}` },
      payload: { email: 'owned@example.com' },
    });
    const contactId = JSON.parse(created.body).contact_id as string;

    const paid = await awardRulesForEvent(
      tenant.id,
      'newsletter.confirmed',
      contactId,
      'occurrence-1',
      {},
    );
    expect(paid).toEqual([]);
  });
});

describe('editing one field of a rule does not reset the rest (HIGH)', () => {
  it('keeps points, mode and event key when a partial update arrives', async () => {
    // The WordPress earning-rules screen edits one field at a time, which is a
    // PUT carrying that field and nothing else. Every default was applied in
    // JavaScript before the statement ran -- points to zero, mode to fixed,
    // event_key to custom.<key> -- so the COALESCE in the DO UPDATE had no
    // NULL left to fall back from, and the omitted fields were overwritten.
    // Toggling a rule on set its points to zero and rewrote the event it
    // listens for: purchase earning stopped on a Save that looked harmless
    // and reported success.
    await upsertRule(tenant.id, {
      key: 'purchase',
      name: 'Purchase reward',
      event_key: 'order.completed',
      mode: 'per_currency_unit',
      points_per_unit: 5,
      points: 100,
      cooldown_seconds: 60,
      daily_cap: 500,
      enabled: true,
    });

    const toggled = await upsertRule(tenant.id, { key: 'purchase', enabled: false });

    expect(toggled.enabled).toBe(false);
    expect(toggled.name).toBe('Purchase reward');
    expect(toggled.event_key).toBe('order.completed');
    expect(toggled.mode).toBe('per_currency_unit');
    expect(Number(toggled.points)).toBe(100);
    expect(Number(toggled.points_per_unit)).toBe(5);
    expect(Number(toggled.cooldown_seconds)).toBe(60);

    // And an edit still edits, rather than the fix turning into "ignore
    // everything the caller sent".
    const repriced = await upsertRule(tenant.id, { key: 'purchase', points: 250 });
    expect(Number(repriced.points)).toBe(250);
    expect(repriced.event_key).toBe('order.completed');
    expect(repriced.enabled).toBe(false);
  });

  it('still lets an admin remove a cap by passing null', async () => {
    // The caps are deliberately pass-through: null is how a cap is *removed*,
    // so they must not be swept into the COALESCE treatment with the rest.
    await upsertRule(tenant.id, {
      key: 'capped_rule',
      name: 'Capped',
      event_key: 'thing',
      points: 10,
      daily_cap: 50,
    });
    const uncapped = await upsertRule(tenant.id, {
      key: 'capped_rule',
      name: 'Capped',
      event_key: 'thing',
      points: 10,
      daily_cap: null,
    });
    expect(uncapped.daily_cap).toBeNull();
  });
});

describe('concurrency', () => {
  it('never lets parallel redemptions overdraw a balance', async () => {
    const person = await contact();
    await award(tenant.id, { contactId: person.id, points: 100, reason: 'Grant', idempotencyKey: 'g' });

    const attempts = await Promise.allSettled(
      Array.from({ length: 5 }, (_unused, index) =>
        spend(tenant.id, {
          contactId: person.id,
          points: 60,
          reason: 'Redeem',
          idempotencyKey: `redeem-${index}`,
        }),
      ),
    );

    const succeeded = attempts.filter((result) => result.status === 'fulfilled');
    expect(succeeded).toHaveLength(1);
    expect((await getBalance(tenant.id, person.id)).balance).toBe(40);
  });

  it('applies a daily cap correctly under concurrent triggers', async () => {
    const person = await contact();
    await upsertRule(tenant.id, { key: 'race', name: 'Race', event_key: 'race',
      points: 30, daily_cap: 60, enabled: true } as never);

    await Promise.all(
      Array.from({ length: 6 }, (_unused, index) =>
        trigger(tenant.id, { contactId: person.id, ruleKey: 'race', refId: `r${index}` }),
      ),
    );

    expect((await getBalance(tenant.id, person.id)).balance).toBe(60);
  });
});

describe('tenant settings', () => {
  it('provisions default rules for a new retailer', async () => {
    const fresh = await getTenantById(tenant.id);
    expect(fresh).not.toBeNull();

    const { rows } = await db().query('SELECT key FROM reward_rules WHERE tenant_id = $1 ORDER BY key', [
      tenant.id,
    ]);
    expect(rows.map((row) => row.key)).toEqual([
      'account_created', 'form_submission', 'newsletter_signup', 'purchase',
      'referral', 'review', 'social_share',
    ]);
  });
});

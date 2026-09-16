import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import {
  BOT_UA,
  DESKTOP_UA,
  closeApp,
  closeDb,
  db,
  makeTenant,
  setupDatabase,
  testApp,
  truncateAll,
  type TestTenant,
} from './helpers.js';
import { planTracking, shouldTrack } from '../src/services/email-tracking.js';
import { queueEmail } from '../src/services/email.js';

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

describe('link rewriting', () => {
  it('rewrites http links and folds duplicate destinations onto one index', () => {
    const plan = planTracking(
      `<a href="https://shop.example.com/sale">Sale</a>` +
        `<a href="https://shop.example.com/sale">Sale again</a>` +
        `<a href="https://shop.example.com/new">New</a>`,
      'tok123456',
    );

    expect(plan.links).toEqual([
      'https://shop.example.com/sale',
      'https://shop.example.com/new',
    ]);
    expect(plan.html).toContain('/e/tok123456/c/0');
    expect(plan.html).toContain('/e/tok123456/c/1');
    // Same destination twice, one index — a header and footer link to the same
    // page should report as one link, not two.
    expect(plan.html.match(/\/c\/0/g)).toHaveLength(2);
  });

  it('leaves mailto, tel and anchors alone', () => {
    const html =
      `<a href="mailto:hi@example.com">Mail</a>` +
      `<a href="tel:+15551234">Call</a>` +
      `<a href="#top">Top</a>`;
    const plan = planTracking(html, 'tok123456');
    expect(plan.links).toEqual([]);
    expect(plan.html).toBe(html); // no pixel either, since nothing is tracked
  });

  it('never rewrites its own unsubscribe links', () => {
    const plan = planTracking(
      `<a href="http://localhost:3000/n/unsubscribe/abc">Unsubscribe</a>` +
        `<a href="https://shop.example.com/x">Shop</a>`,
      'tok123456',
    );
    // Wrapping a one-click unsubscribe would break RFC 8058 and put the
    // customer's opt-out behind our own availability.
    expect(plan.links).toEqual(['https://shop.example.com/x']);
    expect(plan.html).toContain('/n/unsubscribe/abc');
  });

  it('adds the pixel inside body when there is one', () => {
    const plan = planTracking(
      `<html><body><a href="https://x.example.com/">x</a></body></html>`,
      'tok123456',
    );
    expect(plan.html).toContain('/e/tok123456/o.gif');
    expect(plan.html.indexOf('o.gif')).toBeLessThan(plan.html.indexOf('</body>'));
  });
});

describe('what gets tracked', () => {
  it('never tracks a transactional message', () => {
    expect(shouldTrack({ settings: {} }, { transactional: true })).toBe(false);
  });

  it('tracks marketing by default and obeys the tenant switch', () => {
    expect(shouldTrack({ settings: {} })).toBe(true);
    expect(shouldTrack({ settings: { emailTracking: false } })).toBe(false);
  });
});

describe('recording engagement', () => {
  async function sendTracked(): Promise<{ token: string; messageId: string }> {
    await queueEmail(
      {
        tenantId: tenant.id,
        templateKey: 'promo',
        to: 'reader@example.com',
        subject: 'Sale',
        html: '<p><a href="https://shop.example.com/sale">Shop the sale</a></p>',
        dedupeKey: `promo-${Date.now()}-${Math.random()}`,
        track: true,
      },
      db(),
    );
    const { rows } = await db().query<{ id: string; tracking_token: string }>(
      'SELECT id, tracking_token FROM email_messages ORDER BY created_at DESC LIMIT 1',
    );
    return { token: rows[0]!.tracking_token, messageId: rows[0]!.id };
  }

  it('records an open and returns a real GIF', async () => {
    const { token, messageId } = await sendTracked();
    const app = await testApp();

    const response = await app.inject({
      method: 'GET',
      url: `/e/${token}/o.gif`,
      headers: { 'user-agent': DESKTOP_UA },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('image/gif');
    expect(response.rawPayload.subarray(0, 3).toString()).toBe('GIF');

    const { rows } = await db().query<{ open_count: number; opened_at: Date | null }>(
      'SELECT open_count, opened_at FROM email_messages WHERE id = $1',
      [messageId],
    );
    expect(rows[0]!.open_count).toBe(1);
    expect(rows[0]!.opened_at).not.toBeNull();
  });

  it('counts a scanner open separately from a human one', async () => {
    const { token, messageId } = await sendTracked();
    const app = await testApp();

    await app.inject({ method: 'GET', url: `/e/${token}/o.gif`, headers: { 'user-agent': BOT_UA } });

    const { rows } = await db().query<{ open_count: number; bot_open_count: number }>(
      'SELECT open_count, bot_open_count FROM email_messages WHERE id = $1',
      [messageId],
    );
    // An unfiltered open rate is close to meaningless once mail privacy
    // proxies prefetch every pixel, so bots must not inflate the real number.
    expect(rows[0]!.open_count).toBe(0);
    expect(rows[0]!.bot_open_count).toBe(1);
  });

  it('redirects a click to the stored destination and marks the message opened', async () => {
    const { token, messageId } = await sendTracked();
    const app = await testApp();

    const response = await app.inject({
      method: 'GET',
      url: `/e/${token}/c/0`,
      headers: { 'user-agent': DESKTOP_UA },
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe('https://shop.example.com/sale');

    const { rows } = await db().query<{ click_count: number; opened_at: Date | null }>(
      'SELECT click_count, opened_at FROM email_messages WHERE id = $1',
      [messageId],
    );
    expect(rows[0]!.click_count).toBe(1);
    // A click proves the open even when the pixel was blocked, which it
    // usually is.
    expect(rows[0]!.opened_at).not.toBeNull();
  });

  it('cannot be turned into an open redirect', async () => {
    const { token } = await sendTracked();
    const app = await testApp();

    // No index maps to an attacker's URL, and the endpoint takes no URL at all.
    for (const url of [
      `/e/${token}/c/99`,
      `/e/${token}/c/-1`,
      `/e/${token}/c/0?url=https://evil.test`,
    ]) {
      const response = await app.inject({ method: 'GET', url });
      const location = response.headers.location;
      expect(location === undefined || location === 'https://shop.example.com/sale').toBe(true);
    }
  });

  it('serves the pixel for an unknown token rather than leaking which are real', async () => {
    const app = await testApp();
    const response = await app.inject({ method: 'GET', url: '/e/notarealtoken/o.gif' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('image/gif');
  });
});

describe('automations on engagement', () => {
  it('fires email.clicked once, on the first human click only', async () => {
    await db().query(
      `INSERT INTO automations (tenant_id, key, name, trigger_type, conditions, actions, enabled)
       VALUES ($1, 'thanks', 'Thanks', 'email.clicked', '[]'::jsonb,
               '[{"type":"add_tag","tag":"clicked"}]'::jsonb, true)`,
      [tenant.id],
    );

    await queueEmail(
      {
        tenantId: tenant.id,
        contactId: null,
        templateKey: 'promo',
        to: 'c@example.com',
        subject: 'Sale',
        html: '<a href="https://shop.example.com/sale">Sale</a>',
        dedupeKey: 'promo-auto',
        track: true,
      },
      db(),
    );
    const { rows } = await db().query<{ tracking_token: string }>(
      'SELECT tracking_token FROM email_messages LIMIT 1',
    );
    const token = rows[0]!.tracking_token;

    const app = await testApp();
    for (let i = 0; i < 3; i += 1) {
      await app.inject({
        method: 'GET',
        url: `/e/${token}/c/0`,
        headers: { 'user-agent': DESKTOP_UA },
      });
    }

    const runs = await db().query('SELECT 1 FROM automation_runs WHERE tenant_id = $1', [tenant.id]);
    expect(runs.rowCount).toBe(1);
  });
});

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
import {
  expirePauses,
  getPreferences,
  mayReceive,
  preferencesUrl,
  setPreferences,
  upsertTopic,
  verifyPreferencesToken,
} from '../src/services/preferences.js';
import { renderTemplate } from '../src/services/email.js';

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

const authed = async (method: 'GET' | 'PUT' | 'DELETE', url: string, payload?: unknown) => {
  const app = await testApp();
  return app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${tenant.secretKey}` },
    ...(payload === undefined ? {} : { payload }),
  });
};

const tokenFor = (email: string): string => {
  const url = preferencesUrl(tenant.id, email);
  return decodeURIComponent(url.split('/n/prefs/')[1]!);
};

async function member(email = 'reader@example.com') {
  return upsertContact(tenant.id, { email, name: 'Reader', marketingConsent: true });
}

describe('a store with no topics behaves exactly as before', () => {
  it('sends everything to a consenting contact', async () => {
    const contact = await member();
    expect(await mayReceive(tenant.id, contact.id, null)).toEqual({ allowed: true, reason: null });
    // Even a topic the retailer has never defined filters nothing: a template
    // naming a deleted topic must not silently send to nobody.
    expect((await mayReceive(tenant.id, contact.id, 'ghost')).allowed).toBe(true);
  });

  it('still refuses somebody who never consented', async () => {
    const contact = await upsertContact(tenant.id, { email: 'noconsent@example.com' });
    expect(await mayReceive(tenant.id, contact.id, null)).toEqual({
      allowed: false,
      reason: 'no_consent',
    });
  });
});

describe('topics', () => {
  beforeEach(async () => {
    await upsertTopic(tenant.id, { key: 'sales', name: 'Sales and offers' });
    await upsertTopic(tenant.id, { key: 'digest', name: 'Monthly digest' });
  });

  it('sends a topic nobody has expressed a view on', async () => {
    const contact = await member();
    expect((await mayReceive(tenant.id, contact.id, 'sales')).allowed).toBe(true);
  });

  it('stops exactly the topic that was turned off', async () => {
    const contact = await member();
    await setPreferences(tenant.id, contact.id, { topics: { sales: false } });

    expect(await mayReceive(tenant.id, contact.id, 'sales')).toEqual({
      allowed: false,
      reason: 'topic_off',
    });
    // The point of the whole feature: the other one still arrives.
    expect((await mayReceive(tenant.id, contact.id, 'digest')).allowed).toBe(true);
    expect((await mayReceive(tenant.id, contact.id, null)).allowed).toBe(true);
  });

  it('honours a default-off topic until somebody opts in', async () => {
    await upsertTopic(tenant.id, { key: 'beta', name: 'Beta invites', defaultOn: false });
    const contact = await member();

    expect((await mayReceive(tenant.id, contact.id, 'beta')).allowed).toBe(false);
    await setPreferences(tenant.id, contact.id, { topics: { beta: true } });
    expect((await mayReceive(tenant.id, contact.id, 'beta')).allowed).toBe(true);
  });

  it('ignores a key the retailer does not have', async () => {
    const contact = await member();
    await setPreferences(tenant.id, contact.id, { topics: { nonsense: false } });

    const { rows } = await db().query(
      'SELECT topic_key FROM contact_topic_prefs WHERE tenant_id = $1 AND contact_id = $2',
      [tenant.id, contact.id],
    );
    expect(rows.map((row) => row.topic_key)).not.toContain('nonsense');
  });

  it('forgets the choices when the topic is deleted', async () => {
    const contact = await member();
    await setPreferences(tenant.id, contact.id, { topics: { sales: false } });

    const res = await authed('DELETE', '/v1/email/topics/sales');
    expect(res.statusCode).toBe(200);

    const { rows } = await db().query(
      "SELECT 1 FROM contact_topic_prefs WHERE tenant_id = $1 AND topic_key = 'sales'",
      [tenant.id],
    );
    // A stored opinion about a topic that no longer exists would be inherited
    // by whatever reused the key later.
    expect(rows).toHaveLength(0);
  });
});

describe('pausing is not unsubscribing', () => {
  it('stops mail without touching consent, and lifts by itself', async () => {
    const contact = await member();
    await setPreferences(tenant.id, contact.id, { pauseDays: 30 });

    expect(await mayReceive(tenant.id, contact.id, null)).toEqual({
      allowed: false,
      reason: 'paused',
    });

    const prefs = await getPreferences(tenant.id, contact.id);
    // The difference that matters: they are still a subscriber.
    expect(prefs.marketing_consent).toBe(true);
    expect(prefs.paused_until).not.toBeNull();

    // Wind the clock back past the pause rather than waiting a month.
    await db().query(
      `UPDATE contacts SET marketing_paused_until = now() - interval '1 day'
        WHERE tenant_id = $1 AND id = $2`,
      [tenant.id, contact.id],
    );
    expect((await mayReceive(tenant.id, contact.id, null)).allowed).toBe(true);
    expect((await getPreferences(tenant.id, contact.id)).paused_until).toBeNull();
  });

  it('resumes on request', async () => {
    const contact = await member();
    await setPreferences(tenant.id, contact.id, { pauseDays: 90 });
    await setPreferences(tenant.id, contact.id, { pauseDays: 0 });

    expect((await mayReceive(tenant.id, contact.id, null)).allowed).toBe(true);
    expect((await getPreferences(tenant.id, contact.id)).paused_until).toBeNull();
  });

  it('caps a pause at a year', async () => {
    const contact = await member();
    await setPreferences(tenant.id, contact.id, { pauseDays: 99_999 });

    const prefs = await getPreferences(tenant.id, contact.id);
    const days = (prefs.paused_until!.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeLessThanOrEqual(366);
  });

  it('tidies lapsed pauses so the column says what it means', async () => {
    const contact = await member();
    await db().query(
      `UPDATE contacts SET marketing_paused_until = now() - interval '1 day'
        WHERE tenant_id = $1 AND id = $2`,
      [tenant.id, contact.id],
    );

    expect(await expirePauses()).toBeGreaterThan(0);
    const { rows } = await db().query(
      'SELECT marketing_paused_until FROM contacts WHERE id = $1',
      [contact.id],
    );
    expect(rows[0]!.marketing_paused_until).toBeNull();
  });
});

describe('the page itself', () => {
  it('renders the topics and the pause, and does not change anything on GET', async () => {
    await upsertTopic(tenant.id, {
      key: 'sales',
      name: 'Sales and offers',
      description: 'Discounts and new arrivals',
    });
    const contact = await member();

    const app = await testApp();
    const res = await app.inject({ method: 'GET', url: `/n/prefs/${tokenFor('reader@example.com')}` });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Sales and offers');
    expect(res.body).toContain('Discounts and new arrivals');
    expect(res.body).toContain('Pause for a month');
    // The exit is present and findable — the argument for this page is that
    // people choose to stay, not that they cannot leave.
    expect(res.body).toContain('stop all marketing email');

    // A corporate link scanner fetches every URL in every message. A GET that
    // changed anything would rewrite the preferences of exactly the people
    // whose employer scans their mail.
    expect((await getPreferences(tenant.id, contact.id)).topics[0]!.chosen).toBe(false);
  });

  it('applies a POST, including the boxes that were unticked', async () => {
    await upsertTopic(tenant.id, { key: 'sales', name: 'Sales' });
    await upsertTopic(tenant.id, { key: 'digest', name: 'Digest' });
    const contact = await member();

    const app = await testApp();
    const res = await app.inject({
      method: 'POST',
      url: `/n/prefs/${tokenFor('reader@example.com')}`,
      payload: 'topic_digest=on&pause_days=0',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Saved.');

    // An unticked checkbox sends nothing at all, so reading only what arrived
    // would make turning a topic off impossible.
    expect((await mayReceive(tenant.id, contact.id, 'sales')).allowed).toBe(false);
    expect((await mayReceive(tenant.id, contact.id, 'digest')).allowed).toBe(true);
  });

  it('pauses from the page', async () => {
    const contact = await member();
    const app = await testApp();
    await app.inject({
      method: 'POST',
      url: `/n/prefs/${tokenFor('reader@example.com')}`,
      payload: 'pause_days=30',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });

    expect((await mayReceive(tenant.id, contact.id, null)).reason).toBe('paused');
  });

  it('leaves entirely when that is what they choose', async () => {
    const contact = await member();
    const app = await testApp();
    const res = await app.inject({
      method: 'POST',
      url: `/n/prefs/${tokenFor('reader@example.com')}`,
      payload: 'unsubscribe=1',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });

    expect(res.body).toContain('Unsubscribed');
    expect((await mayReceive(tenant.id, contact.id, null)).reason).toBe('no_consent');

    const { rows } = await db().query(
      'SELECT 1 FROM email_suppressions WHERE tenant_id = $1',
      [tenant.id],
    );
    // Suppressed too, so a re-import cannot put them back.
    expect(rows).toHaveLength(1);
  });

  it('refuses a token that was not signed for it', async () => {
    const app = await testApp();
    for (const token of ['nonsense', 'a.b.c']) {
      const res = await app.inject({ method: 'GET', url: `/n/prefs/${token}` });
      expect(res.statusCode).toBe(400);
    }
  });

  it('will not accept an unsubscribe token in its place', async () => {
    const { unsubscribeRequestUrl } = await import('../src/services/newsletter.js');
    const unsubToken = decodeURIComponent(
      unsubscribeRequestUrl(tenant.id, 'reader@example.com').split('/n/u/')[1]!,
    );
    // Both are signed over the same (tenant, address) pair; only the purpose
    // discriminator stops one standing in for the other.
    expect(verifyPreferencesToken(unsubToken)).toBeNull();
  });

  it('answers the same for an address it does not hold', async () => {
    const app = await testApp();
    const res = await app.inject({ method: 'GET', url: `/n/prefs/${tokenFor('nobody@example.com')}` });
    expect(res.statusCode).toBe(200);
    // Not a 404: the page must not become a way to test which addresses a
    // store holds.
    expect(res.body).toContain('Nothing to change');
  });
});

describe('the link in the email', () => {
  it('appears beside unsubscribe when there is a page to point at', () => {
    const rendered = renderTemplate(
      { subject: 'Hi', html: '<a href="{{preferences_url}}">Email preferences</a>' },
      { preferences_url: 'https://example.com/n/prefs/abc' },
    );
    expect(rendered.html).toContain('https://example.com/n/prefs/abc');
  });

  it('is dropped rather than left pointing at nothing', () => {
    // Confirmation and cart-recovery mail has no preference page to point at.
    // An empty href is a link back to the email itself, which is worse than
    // no link.
    const rendered = renderTemplate(
      {
        subject: 'Hi',
        html: '<p><a href="{{preferences_url}}">Email preferences</a>&nbsp;&middot;&nbsp;<a href="https://x/u">Unsubscribe</a></p>',
      },
      {},
    );
    expect(rendered.html).not.toContain('href=""');
    expect(rendered.html).toContain('Unsubscribe');
    expect(rendered.html).not.toContain('Email preferences');
  });
});

describe('the retailer’s side', () => {
  it('manages topics over the API', async () => {
    const created = await authed('PUT', '/v1/email/topics/sales', {
      name: 'Sales and offers',
      description: 'Discounts and new arrivals',
    });
    expect(created.statusCode).toBe(200);
    expect(JSON.parse(created.body).topic.name).toBe('Sales and offers');

    const list = await authed('GET', '/v1/email/topics');
    expect(JSON.parse(list.body).topics).toHaveLength(1);
  });

  it('reads and sets one contact’s preferences', async () => {
    await upsertTopic(tenant.id, { key: 'sales', name: 'Sales' });
    await member();

    const set = await authed('PUT', '/v1/email/preferences', {
      email: 'reader@example.com',
      topics: { sales: false },
      pauseDays: 14,
    });
    expect(set.statusCode).toBe(200);

    const read = await authed('GET', '/v1/email/preferences?email=reader@example.com');
    const prefs = JSON.parse(read.body).preferences;
    expect(prefs.topics.find((t: { key: string }) => t.key === 'sales').subscribed).toBe(false);
    expect(prefs.paused_until).not.toBeNull();
  });

  it('counts what people chose instead of leaving', async () => {
    await upsertTopic(tenant.id, { key: 'sales', name: 'Sales' });
    const contact = await member();
    await setPreferences(tenant.id, contact.id, { topics: { sales: false } });
    await setPreferences(tenant.id, contact.id, { pauseDays: 30 });

    const res = await authed('GET', '/v1/email/preferences/report');
    const byAction = Object.fromEntries(
      JSON.parse(res.body).changes.map((row: { action: string; n: number }) => [row.action, row.n]),
    );
    expect(byAction.topics).toBe(1);
    expect(byAction.paused).toBe(1);
  });

  it('refuses a nonsensical topic key', async () => {
    await expect(upsertTopic(tenant.id, { key: 'A' })).rejects.toMatchObject({ statusCode: 400 });
    await expect(upsertTopic(tenant.id, { key: 'has spaces' })).rejects.toMatchObject({
      statusCode: 400,
    });
  });
});

describe('transactional mail ignores all of it', () => {
  it('sends a receipt to somebody who has paused everything', async () => {
    const contact = await member('receipts@example.com');
    await setPreferences(tenant.id, contact.id, { pauseDays: 90 });

    // Marketing is off.
    expect((await mayReceive(tenant.id, contact.id, null)).reason).toBe('paused');
    // The receipt is not. Withholding "here are the points from your order"
    // because somebody paused the newsletter is withholding a receipt for want
    // of a marketing opt-in.
    expect(await mayReceive(tenant.id, contact.id, null, undefined, true)).toEqual({
      allowed: true,
      reason: null,
    });
  });

  it('sends a receipt to somebody who never consented at all', async () => {
    const contact = await upsertContact(tenant.id, { email: 'nomarketing@example.com' });
    expect((await mayReceive(tenant.id, contact.id, null)).reason).toBe('no_consent');
    expect((await mayReceive(tenant.id, contact.id, null, undefined, true)).allowed).toBe(true);
  });
});

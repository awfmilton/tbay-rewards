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
import { buildSegment } from '../src/services/segments.js';
import {
  broadcastReport,
  cancelBroadcast,
  sendBroadcastBatch,
  startBroadcast,
} from '../src/services/broadcasts.js';
import { suppress } from '../src/services/deliverability.js';

let tenant: TestTenant;

beforeAll(async () => {
  await setupDatabase();
});

beforeEach(async () => {
  await truncateAll();
  tenant = await makeTenant();

  await authed('PUT', '/v1/email/templates/promo', {
    subject: 'Our sale',
    html: '<p>Hello {{name}}, <a href="https://shop.example.com/sale">shop the sale</a></p>',
  });
});

afterAll(async () => {
  await closeApp();
  await closeDb();
});

async function authed(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) {
  const app = await testApp();
  return app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${tenant.secretKey}` },
    ...(payload === undefined ? {} : { payload }),
  });
}

async function seedAudience(count: number, consent = true): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await authed('POST', '/v1/contacts', {
      email: `person${i}@example.com`,
      name: `Person ${i}`,
      tags: ['promo'],
      marketingConsent: consent,
    });
  }
  await authed('PUT', '/v1/segments/promo', {
    name: 'Promo list',
    definition: { match: 'all', filters: [{ field: 'tags', operator: 'contains', value: ['promo'] }] },
  });
  await buildSegment(tenant.id, 'promo');
}

describe('sending a broadcast', () => {
  it('queues one message per consenting recipient', async () => {
    await seedAudience(3);

    await authed('PUT', '/v1/broadcasts/sale', {
      name: 'Spring sale',
      segmentKey: 'promo',
      templateKey: 'promo',
    });
    await startBroadcast(tenant.id, 'sale');

    const first = await sendBroadcastBatch(tenant.id, 'sale', 100);
    expect(first.queued).toBe(3);
    expect(first.done).toBe(true);

    const { rows } = await db().query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM email_messages WHERE dedupe_key LIKE 'broadcast:%'`,
    );
    expect(Number(rows[0]!.n)).toBe(3);
  });

  it('resumes from its cursor instead of starting over', async () => {
    await seedAudience(5);
    await authed('PUT', '/v1/broadcasts/sale', { segmentKey: 'promo', templateKey: 'promo' });
    await startBroadcast(tenant.id, 'sale');

    const first = await sendBroadcastBatch(tenant.id, 'sale', 2);
    expect(first.queued).toBe(2);
    expect(first.done).toBe(false);

    const second = await sendBroadcastBatch(tenant.id, 'sale', 2);
    // Cumulative, and the second batch covered new people rather than the
    // same two again — restarting would mail everyone before the crash twice.
    expect(second.queued).toBe(4);

    await sendBroadcastBatch(tenant.id, 'sale', 2);
    const final = await sendBroadcastBatch(tenant.id, 'sale', 2);
    expect(final.status).toBe('sent');

    const { rows } = await db().query<{ n: string }>(
      `SELECT COUNT(DISTINCT to_email) AS n FROM email_messages WHERE dedupe_key LIKE 'broadcast:%'`,
    );
    expect(Number(rows[0]!.n)).toBe(5);
  });

  it('cannot mail the same person twice even if a batch is replayed', async () => {
    await seedAudience(2);
    await authed('PUT', '/v1/broadcasts/sale', { segmentKey: 'promo', templateKey: 'promo' });
    await startBroadcast(tenant.id, 'sale');

    await sendBroadcastBatch(tenant.id, 'sale', 100);
    // Rewind the cursor, as a crashed-and-resumed worker would if the cursor
    // write was the thing that did not land.
    await db().query(`UPDATE broadcasts SET cursor_contact = NULL, status = 'sending'`);
    await sendBroadcastBatch(tenant.id, 'sale', 100);

    const { rows } = await db().query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM email_messages WHERE dedupe_key LIKE 'broadcast:%'`,
    );
    expect(Number(rows[0]!.n)).toBe(2);
  });

  it('never mails someone without consent or on the suppression list', async () => {
    await authed('POST', '/v1/contacts', {
      email: 'yes@example.com', tags: ['promo'], marketingConsent: true,
    });
    await authed('POST', '/v1/contacts', {
      email: 'no@example.com', tags: ['promo'], marketingConsent: false,
    });
    await authed('POST', '/v1/contacts', {
      email: 'bounced@example.com', tags: ['promo'], marketingConsent: true,
    });
    await suppress(tenant.id, 'bounced@example.com', 'hard_bounce', 'user unknown');

    await authed('PUT', '/v1/segments/promo', {
      name: 'Promo',
      definition: { match: 'all', filters: [{ field: 'tags', operator: 'contains', value: ['promo'] }] },
    });
    await buildSegment(tenant.id, 'promo');
    await authed('PUT', '/v1/broadcasts/sale', { segmentKey: 'promo', templateKey: 'promo' });
    await startBroadcast(tenant.id, 'sale');
    await sendBroadcastBatch(tenant.id, 'sale', 100);

    const { rows } = await db().query<{ to_email: string }>(
      `SELECT to_email FROM email_messages WHERE dedupe_key LIKE 'broadcast:%'`,
    );
    expect(rows.map((row) => row.to_email)).toEqual(['yes@example.com']);
  });

  it('skips a contact over the frequency cap and says why', async () => {
    await authed('PUT', '/v1/settings', { maxMarketingPerDay: 1 });
    await seedAudience(1);

    // A marketing message already sent today. unsubscribe_url is what marks a
    // message as marketing rather than a receipt.
    const { rows: contacts } = await db().query<{ id: string }>('SELECT id FROM contacts LIMIT 1');
    await db().query(
      `INSERT INTO email_messages
         (tenant_id, contact_id, template_key, to_email, subject, html, dedupe_key,
          status, sent_at, unsubscribe_url)
       VALUES ($1, $2, 'promo', 'person0@example.com', 'Earlier', '<p>x</p>', 'earlier',
               'sent', now(), 'https://x.test/u')`,
      [tenant.id, contacts[0]!.id],
    );

    await authed('PUT', '/v1/broadcasts/sale', { segmentKey: 'promo', templateKey: 'promo' });
    await startBroadcast(tenant.id, 'sale');
    const result = await sendBroadcastBatch(tenant.id, 'sale', 100);

    expect(result.queued).toBe(0);
    expect(result.skipped).toBe(1);

    const report = await broadcastReport(tenant.id, 'sale');
    expect(report.skips).toEqual([{ reason: 'frequency_cap_day', count: 1 }]);
  });

  it('carries a one-click unsubscribe and tracking on every message', async () => {
    await seedAudience(1);
    await authed('PUT', '/v1/broadcasts/sale', { segmentKey: 'promo', templateKey: 'promo' });
    await startBroadcast(tenant.id, 'sale');
    await sendBroadcastBatch(tenant.id, 'sale', 100);

    const { rows } = await db().query<{
      unsubscribe_url: string | null;
      tracking_token: string | null;
      html: string;
    }>(`SELECT unsubscribe_url, tracking_token, html FROM email_messages
         WHERE dedupe_key LIKE 'broadcast:%'`);

    // Signed now: the address is inside an HMAC, so the link only works for
    // the person it was minted for.
    expect(rows[0]!.unsubscribe_url).toContain('/n/u/');
    expect(rows[0]!.tracking_token).not.toBeNull();
    expect(rows[0]!.html).toContain('/c/0');
  });

  it('refuses to edit a broadcast that has already gone out', async () => {
    await seedAudience(1);
    await authed('PUT', '/v1/broadcasts/sale', { segmentKey: 'promo', templateKey: 'promo' });
    await startBroadcast(tenant.id, 'sale');
    await sendBroadcastBatch(tenant.id, 'sale', 100);
    await sendBroadcastBatch(tenant.id, 'sale', 100); // walks to the end

    const response = await authed('PUT', '/v1/broadcasts/sale', { subject: 'New subject' });
    // A sent broadcast is a record of what went out; editing one makes its own
    // recipient list a lie.
    expect(response.statusCode).toBe(409);
  });

  it('stops the walk when cancelled', async () => {
    await seedAudience(4);
    await authed('PUT', '/v1/broadcasts/sale', { segmentKey: 'promo', templateKey: 'promo' });
    await startBroadcast(tenant.id, 'sale');
    await sendBroadcastBatch(tenant.id, 'sale', 2);

    await cancelBroadcast(tenant.id, 'sale');
    await expect(sendBroadcastBatch(tenant.id, 'sale', 2)).rejects.toThrow();

    const { rows } = await db().query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM email_messages WHERE dedupe_key LIKE 'broadcast:%'`,
    );
    // The two already accepted for delivery still stand; the rest never go.
    expect(Number(rows[0]!.n)).toBe(2);
  });

  it('reports opens and clicks against the broadcast', async () => {
    await seedAudience(1);
    await authed('PUT', '/v1/broadcasts/sale', { segmentKey: 'promo', templateKey: 'promo' });
    await startBroadcast(tenant.id, 'sale');
    await sendBroadcastBatch(tenant.id, 'sale', 100);

    const { flushEmailQueue } = await import('../src/services/email.js');
    await flushEmailQueue();

    const { rows } = await db().query<{ tracking_token: string }>(
      `SELECT tracking_token FROM email_messages WHERE dedupe_key LIKE 'broadcast:%'`,
    );
    const app = await testApp();
    await app.inject({
      method: 'GET',
      url: `/e/${rows[0]!.tracking_token}/c/0`,
      headers: { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' },
    });

    const report = await broadcastReport(tenant.id, 'sale');
    expect(report.sent).toBe(1);
    expect(report.clicked).toBe(1);
    expect(report.opened).toBe(1);
  });
});

describe('a send honours what people chose per topic', () => {
  it('inherits the template\'s topic and skips anyone who turned it off', async () => {
    // The column existed and nothing ever wrote it, so the preference centre
    // worked for automations and did nothing for campaigns — the one kind of
    // mail people actually turn off.
    await authed('PUT', '/v1/email/topics/offers', { name: 'Offers' });
    await authed('PUT', '/v1/email/templates/promo', {
      subject: 'Our sale',
      html: '<p>Sale</p>',
      topicKey: 'offers',
    });

    await seedAudience(2);
    const { rows } = await db().query<{ id: string; email: string }>(
      'SELECT id, email FROM contacts WHERE tenant_id = $1 ORDER BY email',
      [tenant.id],
    );
    const optedOut = rows[0]!;

    await authed('PUT', '/v1/email/preferences', {
      contactId: optedOut.id,
      topics: { offers: false },
    });

    const saved = await authed('PUT', '/v1/broadcasts/sale', {
      name: 'Sale',
      segmentKey: 'promo',
      templateKey: 'promo',
    });
    expect(saved.json().broadcast.topic_key).toBe('offers');

    await startBroadcast(tenant.id, 'sale');
    await sendBroadcastBatch(tenant.id, 'sale', 100);

    const { rows: mailed } = await db().query<{ to_email: string }>(
      'SELECT to_email FROM email_messages WHERE tenant_id = $1',
      [tenant.id],
    );
    expect(mailed.map((row) => row.to_email)).not.toContain(optedOut.email);
    expect(mailed).toHaveLength(1);

    const { rows: skipped } = await db().query<{ reason: string }>(
      `SELECT skip_reason AS reason FROM broadcast_recipients
        WHERE broadcast_id = (SELECT id FROM broadcasts WHERE tenant_id = $1 AND key = 'sale')
          AND status = 'skipped'`,
      [tenant.id],
    );
    expect(skipped.map((row) => row.reason)).toEqual(['topic_off']);
  });

  it('lets a send be put in no topic on purpose', async () => {
    await authed('PUT', '/v1/email/topics/offers', { name: 'Offers' });
    await authed('PUT', '/v1/email/templates/promo', {
      subject: 'Our sale', html: '<p>Sale</p>', topicKey: 'offers',
    });
    const saved = await authed('PUT', '/v1/broadcasts/everyone', {
      name: 'Everyone',
      templateKey: 'promo',
      topicKey: null,
    });
    expect(saved.json().broadcast.topic_key).toBeNull();
  });
});

describe('arming a send that would reach nobody', () => {
  it('refuses a segment the builder has not materialised yet', async () => {
    // The builder runs every ten minutes and saving a segment does not build
    // it, so "create the segment, then send" inside that window walked an
    // empty audience, marked the broadcast `sent`, and reported success. The
    // retailer found out when the campaign produced no orders.
    await authed('PUT', '/v1/email/templates/promo', { subject: 'Sale', html: '<p>Sale</p>' });
    await authed('PUT', '/v1/segments/fresh', {
      name: 'Fresh',
      definition: { match: 'all', filters: [{ field: 'order_count', operator: 'gte', value: 0 }] },
    });
    await authed('PUT', '/v1/broadcasts/premature', {
      name: 'Premature',
      segmentKey: 'fresh',
      templateKey: 'promo',
    });

    await expect(startBroadcast(tenant.id, 'premature')).rejects.toThrow(/has not been built/i);

    // Built, and it arms.
    await buildSegment(tenant.id, 'fresh');
    await expect(startBroadcast(tenant.id, 'premature')).resolves.toMatchObject({
      status: 'scheduled',
    });
  });

  it('still arms a built segment that is empty right now', async () => {
    // A send scheduled for Friday does not need its audience to exist today.
    await authed('PUT', '/v1/email/templates/promo', { subject: 'Sale', html: '<p>Sale</p>' });
    await authed('PUT', '/v1/segments/nobody', {
      name: 'Nobody',
      definition: {
        match: 'all',
        filters: [{ field: 'order_count', operator: 'gte', value: 9999 }],
      },
    });
    await buildSegment(tenant.id, 'nobody');

    await authed('PUT', '/v1/broadcasts/later', {
      name: 'Later',
      segmentKey: 'nobody',
      templateKey: 'promo',
    });
    await expect(startBroadcast(tenant.id, 'later')).resolves.toMatchObject({
      status: 'scheduled',
    });
  });

  it('lets a failed send be armed again instead of stranding its audience', async () => {
    await authed('PUT', '/v1/email/templates/promo', { subject: 'Sale', html: '<p>Sale</p>' });
    await seedAudience(2);
    await authed('PUT', '/v1/broadcasts/broken', {
      name: 'Broken',
      segmentKey: 'promo',
      templateKey: 'promo',
    });
    await startBroadcast(tenant.id, 'broken');

    // What an exception mid-walk leaves behind.
    await db().query(
      "UPDATE broadcasts SET status = 'failed', error = 'connection timeout' WHERE tenant_id = $1",
      [tenant.id],
    );

    // Its key could not be reused, it could not be edited, and it could not be
    // cancelled — the rest of the audience simply never heard from it.
    await expect(startBroadcast(tenant.id, 'broken')).resolves.toMatchObject({
      status: 'scheduled',
    });
  });
});

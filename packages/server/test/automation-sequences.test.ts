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
import { fire, runDueAutomations } from '../src/services/automations.js';
import { upsertContact } from '../src/services/contacts.js';
import { flushEmailQueue, outbox, setEmailTransport } from '../src/services/email.js';

let tenant: TestTenant;

beforeAll(async () => {
  await setupDatabase();
});

beforeEach(async () => {
  await truncateAll();
  setEmailTransport(null);
  outbox().length = 0;
  tenant = await makeTenant();
  await authed('PUT', '/v1/email/templates/step_one', {
    subject: 'First', html: '<p>First</p>', transactional: true,
  });
  await authed('PUT', '/v1/email/templates/step_two', {
    subject: 'Second', html: '<p>Second</p>', transactional: true,
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

async function makeContact(input: Record<string, unknown>): Promise<string> {
  const response = await authed('POST', '/v1/contacts', input);
  return JSON.parse(response.body).contact_id as string;
}

/**
 * A contact, without the event.
 *
 * POST /v1/contacts fires `contact.created` now -- that was the fix for
 * WooCommerce customers never triggering a welcome sequence -- so a test that
 * creates a contact through the route and *then* fires the same event by hand
 * is describing two occurrences, not one. With the same dedupe key the second
 * is correctly swallowed and the run looks like it never happened; with a
 * different one the sequence correctly runs twice.
 *
 * These tests are about the engine, not about contact creation, so they take
 * the contact straight from the service and keep firing the event themselves.
 */
async function quietContact(email: string): Promise<string> {
  const contact = await upsertContact(tenant.id, { email, name: null, phone: null,
    externalRef: null, attributes: {}, tags: [] });
  return contact.id;
}

/** Pull a parked run's resume time into the past so the worker picks it up. */
async function fastForward(): Promise<void> {
  await db().query(
    `UPDATE automation_runs SET resume_at = now() - interval '1 minute' WHERE status = 'waiting'`,
  );
}

describe('waits', () => {
  it('parks a run and finishes it when the wait elapses', async () => {
    await authed('PUT', '/v1/automations/welcome', {
      name: 'Welcome series',
      triggerType: 'contact.created',
      actions: [
        { type: 'send_email', template: 'step_one' },
        { type: 'wait', days: 1 },
        { type: 'send_email', template: 'step_two' },
      ],
    });

    const contactId = await quietContact('new@example.com');
    const contact = { id: contactId, email: 'new@example.com' } as never;

    const result = await fire(tenant.id, 'contact.created', {
      contact,
      data: {},
      dedupeKey: `contact:${contactId}`,
    });

    expect(result.waiting).toEqual(['welcome']);

    await flushEmailQueue();
    expect(outbox().map((m) => m.subject)).toEqual(['First']);

    await fastForward();
    const resumed = await runDueAutomations();
    expect(resumed.completed).toBe(1);

    await flushEmailQueue();
    expect(outbox().map((m) => m.subject)).toEqual(['First', 'Second']);
  });

  it('gives each step its own idempotency key', async () => {
    await authed('PUT', '/v1/automations/double', {
      name: 'Two awards',
      triggerType: 'contact.created',
      actions: [
        { type: 'award_points', points: 10, reason: 'first' },
        { type: 'award_points', points: 25, reason: 'second' },
      ],
    });

    const contactId = await quietContact('two@example.com');
    await fire(tenant.id, 'contact.created', {
      contact: { id: contactId } as never,
      data: {},
      dedupeKey: `contact:${contactId}`,
    });

    // The automation's own two awards, named, rather than the balance total.
    //
    // Firing contact.created also pays the shipped `account_created` rule now
    // -- that is the point of event dispatch -- so a total would be asserting
    // the signup bonus as much as the thing this test is about. Sharing one
    // key across steps would silently drop the second award: a bug that only
    // appears once a sequence can hold two of the same action.
    const { rows } = await db().query<{ delta_points: number; reason: string }>(
      `SELECT delta_points, reason FROM points_ledger
        WHERE contact_id = $1 AND reason IN ('first', 'second')
        ORDER BY reason`,
      [contactId],
    );
    expect(rows.map((r) => Number(r.delta_points))).toEqual([10, 25]);
  });
});

describe('branches', () => {
  async function buildWinBack(): Promise<string> {
    await authed('PUT', '/v1/automations/winback', {
      name: 'Win back',
      triggerType: 'contact.created',
      actions: [
        { type: 'wait', hours: 1 },
        {
          type: 'if',
          filter: {
            match: 'all',
            filters: [{ field: 'order_count', operator: 'eq', value: 0 }],
          },
          else: 'stop',
        },
        { type: 'send_email', template: 'step_two' },
      ],
    });
    return quietContact('maybe@example.com');
  }

  it('sends the follow-up when the condition still holds', async () => {
    const contactId = await buildWinBack();
    await fire(tenant.id, 'contact.created', {
      contact: { id: contactId } as never,
      data: {},
      dedupeKey: `c:${contactId}`,
    });

    await fastForward();
    await runDueAutomations();
    await flushEmailQueue();

    expect(outbox().map((m) => m.subject)).toEqual(['Second']);
  });

  it('stops when the contact acted during the wait', async () => {
    const contactId = await buildWinBack();
    await fire(tenant.id, 'contact.created', {
      contact: { id: contactId } as never,
      data: {},
      dedupeKey: `c:${contactId}`,
    });

    // They bought something while the run was parked.
    await authed('POST', '/v1/orders', {
      orderRef: 'o1',
      email: 'maybe@example.com',
      totalCents: 5_000,
      subtotalCents: 5_000,
    });

    await fastForward();
    await runDueAutomations();
    await flushEmailQueue();

    // The condition is evaluated against live data, not the day-old trigger
    // payload — which is the whole point of a branch after a wait.
    expect(outbox()).toHaveLength(0);
  });

  it('takes the else branch when told to continue', async () => {
    await authed('PUT', '/v1/automations/either', {
      name: 'Either',
      triggerType: 'contact.created',
      actions: [
        {
          type: 'if',
          filter: { match: 'all', filters: [{ field: 'order_count', operator: 'gte', value: 5 }] },
          else: { goto: 2 },
        },
        { type: 'send_email', template: 'step_one' },
        { type: 'send_email', template: 'step_two' },
      ],
    });

    const contactId = await quietContact('either@example.com');
    await fire(tenant.id, 'contact.created', {
      contact: { id: contactId } as never,
      data: {},
      dedupeKey: `c:${contactId}`,
    });
    await flushEmailQueue();

    // Not a five-time buyer, so it jumped past step one.
    expect(outbox().map((m) => m.subject)).toEqual(['Second']);
  });
});

describe('a branch that gates nothing, and a send that reaches nobody', () => {
  it('refuses an "if" whose filter decides nothing (HIGH)', async () => {
    // `typeof step.filter !== 'object'` let three shapes through and each one
    // gated nobody. `typeof null` is 'object', so a null filter passed and
    // then failed at two in the morning inside a customer's run instead of in
    // front of the admin who saved it. `{}` and an empty filter list compile
    // to TRUE -- correct for a segment, where an empty definition means
    // everyone and is the default a new one is created with, and exactly
    // wrong for a branch. "If tagged vip, send the VIP offer", saved with the
    // filter row still blank, sent the VIP offer to the whole list.
    for (const filter of [null, {}, { match: 'all', filters: [] }, { match: 'any', filters: [] },
                          { match: 'all', filters: [], groups: [] }, []] as const) {
      const response = await authed('PUT', '/v1/automations/blank_gate', {
        name: 'Blank gate',
        triggerType: 'contact.created',
        actions: [{ type: 'if', filter, else: 'stop' }, { type: 'send_email', template: 'step_two' }],
      });
      expect(response.statusCode, JSON.stringify(filter)).toBe(400);
    }

    // A nested group with a real condition in it is still accepted, so the
    // check is "decides something", not "has a top-level filter".
    const nested = await authed('PUT', '/v1/automations/nested_gate', {
      name: 'Nested gate',
      triggerType: 'contact.created',
      actions: [
        {
          type: 'if',
          filter: {
            match: 'all',
            filters: [],
            groups: [{ match: 'any', filters: [{ field: 'order_count', operator: 'eq', value: 0 }] }],
          },
          else: 'stop',
        },
        { type: 'send_email', template: 'step_two' },
      ],
    });
    expect(nested.statusCode).toBe(200);
  });

  it('sends a dedupe-keyed step to every contact, not to the first one (HIGH)', async () => {
    // `email_messages` is UNIQUE (tenant_id, dedupe_key) with ON CONFLICT DO
    // NOTHING, and a caller-supplied `dedupe` went in unscoped. So the obvious
    // thing to write for "only send this once" delivered to whichever contact
    // the scheduler reached first and silently dropped it for everybody else
    // -- while every run still reported `completed`, so nothing anywhere said
    // the campaign had reached one person.
    await authed('PUT', '/v1/automations/one_off', {
      name: 'One off',
      triggerType: 'contact.created',
      actions: [{ type: 'send_email', template: 'step_two', dedupe: 'spring_offer' }],
    });

    for (const email of ['a@example.com', 'b@example.com', 'c@example.com']) {
      const contactId = await quietContact(email);
      await fire(tenant.id, 'contact.created', {
        contact: { id: contactId } as never,
        data: {},
        dedupeKey: `c:${contactId}`,
      });
    }
    await flushEmailQueue();

    expect(outbox().map((m) => m.to).sort()).toEqual([
      'a@example.com',
      'b@example.com',
      'c@example.com',
    ]);

    // And it is still a dedupe: the same contact triggering again gets nothing
    // more, which is what the field is for.
    const again = await quietContact('a@example.com');
    await fire(tenant.id, 'contact.created', {
      contact: { id: again } as never,
      data: {},
      dedupeKey: `c:${again}:second`,
    });
    await flushEmailQueue();
    expect(outbox().filter((m) => m.to === 'a@example.com')).toHaveLength(1);
  });

  it('honours the retailer\'s frequency cap in automation mail too (HIGH)', async () => {
    // The cap was private to the broadcast sender. A cap one of four senders
    // obeys is not a cap -- and automations are where mail actually stacks up:
    // a welcome series, an abandoned-cart sequence and a points email can all
    // fire for the same person on the same afternoon.
    await authed('PUT', '/v1/email/templates/promo_one', {
      subject: 'Promo one', html: '<p>One</p>', transactional: false,
    });
    await authed('PUT', '/v1/email/templates/promo_two', {
      subject: 'Promo two', html: '<p>Two</p>', transactional: false,
    });
    await db().query(
      `UPDATE tenants SET settings = COALESCE(settings, '{}'::jsonb) || '{"maxMarketingPerDay": 1}'::jsonb
        WHERE id = $1`,
      [tenant.id],
    );

    // Through the route, with consent: this test fires its own cap_one and
    // cap_two events, so the route's contact.created costs it nothing, and
    // marketing consent is the whole precondition for the mail it counts.
    const contactId = await makeContact({
      email: 'capped@example.com',
      marketingConsent: true,
    });
    for (const [key, template, trigger] of [
      ['cap_first', 'promo_one', 'cap_one'],
      ['cap_second', 'promo_two', 'cap_two'],
    ] as const) {
      await authed('PUT', `/v1/automations/${key}`, {
        name: key,
        triggerType: trigger,
        actions: [{ type: 'send_email', template }],
      });
    }

    // The cap counts mail already *sent*, not queued -- a backlog must not be
    // able to suppress a campaign -- so the first message has to land before
    // the second is queued, which is exactly the sequence a welcome series
    // and an abandoned-cart sequence produce hours apart.
    await fire(tenant.id, 'cap_one', {
      contact: { id: contactId } as never,
      data: {},
      dedupeKey: `c:${contactId}:first`,
    });
    await flushEmailQueue();
    expect(outbox().filter((m) => m.to === 'capped@example.com')).toHaveLength(1);

    await fire(tenant.id, 'cap_two', {
      contact: { id: contactId } as never,
      data: {},
      dedupeKey: `c:${contactId}:second`,
    });
    await flushEmailQueue();

    // Still one. Before this, the second automation sent regardless: the cap
    // was private to the broadcast sender and no automation ever asked it.
    expect(outbox().filter((m) => m.to === 'capped@example.com')).toHaveLength(1);
  });
});

describe('safety', () => {
  it('rejects a goto that points outside the sequence', async () => {
    const response = await authed('PUT', '/v1/automations/bad', {
      name: 'Bad',
      triggerType: 'contact.created',
      actions: [{ type: 'send_email', template: 'step_one' }, { type: 'goto', step: 9 }],
    });
    expect(response.statusCode).toBe(400);
  });

  it('rejects a wait with no duration', async () => {
    const response = await authed('PUT', '/v1/automations/bad', {
      name: 'Bad',
      triggerType: 'contact.created',
      actions: [{ type: 'wait' }, { type: 'send_email', template: 'step_one' }],
    });
    expect(response.statusCode).toBe(400);
  });

  it('rejects a sequence that only waits', async () => {
    const response = await authed('PUT', '/v1/automations/bad', {
      name: 'Bad',
      triggerType: 'contact.created',
      actions: [{ type: 'wait', days: 1 }, { type: 'stop' }],
    });
    expect(response.statusCode).toBe(400);
  });

  it('stops an endless goto loop instead of spinning the worker', async () => {
    await db().query(
      `INSERT INTO automations (tenant_id, key, name, trigger_type, conditions, actions, enabled)
       VALUES ($1, 'loop', 'Loop', 'contact.created', '[]'::jsonb,
               '[{"type":"add_tag","tag":"x"},{"type":"goto","step":0}]'::jsonb, true)`,
      [tenant.id],
    );

    const contactId = await quietContact('loop@example.com');
    const result = await fire(tenant.id, 'contact.created', {
      contact: { id: contactId } as never,
      data: {},
      dedupeKey: `c:${contactId}`,
    });

    expect(result.skipped).toContain('loop');
    const { rows } = await db().query<{ error: string }>(
      `SELECT error FROM automation_runs WHERE status = 'failed'`,
    );
    expect(rows[0]!.error).toContain('exceeded');
  });

  it('cancels a parked run when the contact unsubscribes', async () => {
    await authed('PUT', '/v1/automations/series', {
      name: 'Series',
      triggerType: 'contact.created',
      actions: [
        { type: 'add_tag', tag: 'started' },
        { type: 'wait', days: 1 },
        { type: 'send_email', template: 'step_two' },
      ],
    });

    const contactId = await quietContact('quit@example.com');
    await fire(tenant.id, 'contact.created', {
      contact: { id: contactId } as never,
      data: {},
      dedupeKey: `c:${contactId}`,
    });

    const { unsubscribeRequestUrl } = await import('../src/services/newsletter.js');
    const token = unsubscribeRequestUrl(tenant.id, 'quit@example.com').split('/n/u/')[1]!;

    const app = await testApp();
    await app.inject({ method: 'POST', url: `/n/u/${token}` });

    await fastForward();
    await runDueAutomations();
    await flushEmailQueue();

    // A welcome series that keeps arriving after someone unsubscribed is the
    // complaint that becomes a spam report.
    expect(outbox()).toHaveLength(0);
    const { rows } = await db().query<{ status: string }>(
      'SELECT status FROM automation_runs WHERE contact_id = $1',
      [contactId],
    );
    expect(rows[0]!.status).toBe('cancelled');
  });

  it('cancels parked runs when the automation is disabled', async () => {
    await authed('PUT', '/v1/automations/off', {
      name: 'Off',
      triggerType: 'contact.created',
      actions: [
        { type: 'add_tag', tag: 'x' },
        { type: 'wait', days: 1 },
        { type: 'send_email', template: 'step_two' },
      ],
    });

    const contactId = await quietContact('off@example.com');
    await fire(tenant.id, 'contact.created', {
      contact: { id: contactId } as never,
      data: {},
      dedupeKey: `c:${contactId}`,
    });

    await authed('PUT', '/v1/automations/off', { enabled: false });
    await fastForward();
    await runDueAutomations();
    await flushEmailQueue();

    // Turning an automation off should stop the sequences it already started;
    // that is what an admin means by the switch.
    expect(outbox()).toHaveLength(0);
  });
});

describe('attempts count failures, not waits (MEDIUM)', () => {
  /**
   * `attempts` was bumped on every resumption, including the ones that
   * succeeded -- so every wait in a sequence spent a retry. A sequence with
   * three waits arrived at its first real error already out of budget and was
   * written off without a single retry, which is exactly backwards: the longer
   * a sequence runs, the more likely it is to meet a transient failure.
   */
  async function start(key: string, actions: unknown[], email: string): Promise<void> {
    await authed('PUT', `/v1/automations/${key}`, {
      name: key,
      triggerType: 'contact.created',
      actions,
    });
    const contactId = await quietContact(email);
    await fire(tenant.id, 'contact.created', {
      contact: { id: contactId, email } as never,
      data: {},
      dedupeKey: `contact:${contactId}`,
    });
  }

  it('still retries a sequence that has already waited three times', async () => {
    await start(
      'patient',
      [
        { type: 'wait', seconds: 1 },
        { type: 'wait', seconds: 1 },
        { type: 'wait', seconds: 1 },
        { type: 'send_email', template: 'not_yet_written' },
      ],
      'patient@example.com',
    );

    // Three waits: the first runs on the trigger, two more on resumption.
    for (let step = 0; step < 2; step += 1) {
      await fastForward();
      await runDueAutomations();
    }

    const waited = await runState();
    expect(waited.status).toBe('waiting');
    expect(waited.step_index).toBe(3);
    // Nothing has gone wrong yet, so nothing has been spent. Before this, the
    // three waits had already used the whole budget.
    expect(waited.attempts).toBe(0);

    // Now the step that fails, three times over.
    for (const expected of [1, 2, 3]) {
      await fastForward();
      await runDueAutomations();
      expect((await runState()).attempts).toBe(expected);
    }

    // Three real retries before giving up, which is what the limit is for.
    expect((await runState()).status).toBe('failed');
  });

  it('clears the count once a step works again', async () => {
    await start(
      'recovering',
      [
        { type: 'wait', seconds: 1 },
        { type: 'send_email', template: 'written_later' },
        { type: 'wait', seconds: 1 },
      ],
      'recovering@example.com',
    );

    // One failure against a template that does not exist yet.
    await fastForward();
    await runDueAutomations();
    expect((await runState()).attempts).toBe(1);

    // The retailer writes it.
    await authed('PUT', '/v1/email/templates/written_later', {
      subject: 'Here now', html: '<p>Here now</p>', transactional: true,
    });
    await fastForward();
    await runDueAutomations();

    // Consecutive failures, so a step that works clears the slate: two bad
    // afternoons weeks apart are not three.
    expect((await runState()).attempts).toBe(0);
  });
});

async function runState(): Promise<{
  status: string; attempts: number; step_index: number; error: string | null;
}> {
  const { rows } = await db().query<{
    status: string; attempts: number; step_index: number; error: string | null;
  }>(
    'SELECT status, attempts, step_index, error FROM automation_runs WHERE tenant_id = $1',
    [tenant.id],
  );
  return rows[0]!;
}

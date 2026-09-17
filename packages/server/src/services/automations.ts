import { db, queryOne, type Queryable } from '../db/pool.js';
import { unsubscribeRequestUrl } from './newsletter.js';
import { mayReceive, preferencesUrl } from './preferences.js';
import { personalise, pointsBalanceFor } from './email-blocks.js';
import { config } from '../config.js';
import { ApiError } from '../lib/errors.js';
import { getTemplate, queueEmail, renderTemplate, senderFor } from './email.js';
import { frequencyRuleFor, overFrequencyCap } from './frequency.js';
import { shouldTrack } from './email-tracking.js';
import {
  actionsHash,
  advanceRun,
  resumeDueRuns,
  waitSeconds,
  type Step,
} from './automation-runner.js';
import { award } from './points.js';
import { getTenantById, type Tenant } from './tenants.js';
import type { Contact } from './contacts.js';

/**
 * A small, explicit automation engine: trigger → conditions → actions.
 *
 * Deliberately not a general workflow builder. Mautic's campaign canvas is the
 * thing this replaces, and almost all of its real-world use is "when X happens
 * to a contact, check a couple of facts, then email them or tag them". Keeping
 * the model this small means every run is a single pass with no scheduler state
 * to get stuck in.
 */

export type TriggerType =
  | 'contact.created'
  | 'newsletter.confirmed'
  | 'cart.abandoned'
  | 'order.completed'
  | 'points.awarded'
  | 'share.verified'
  | 'token.claimed'
  // Fired only on the first *human* engagement with a tracked message, so a
  // mail client rendering the pixel repeatedly cannot re-enter a sequence.
  | 'email.opened'
  | 'email.clicked';

export interface Condition {
  field: string;
  op: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'exists' | 'not_exists';
  value?: unknown;
}

export type Action =
  | { type: 'send_email'; template: string; dedupe?: string }
  | { type: 'award_points'; points: number; reason?: string }
  | { type: 'add_tag'; tag: string }
  | { type: 'remove_tag'; tag: string }
  | { type: 'webhook'; topic: string };

/**
 * What an automation's `actions` array may hold.
 *
 * Control steps (`wait`, `if`, `goto`, `stop`) are handled by the step machine
 * and never reach `runActionStep`; see `automation-runner.ts`.
 */
export type AutomationStep = Step;

export interface Automation {
  id: string;
  tenant_id: string;
  key: string;
  name: string;
  trigger_type: string;
  trigger_config: Record<string, unknown>;
  conditions: Condition[];
  actions: Action[];
  enabled: boolean;
}

export interface AutomationContext {
  contact?: Contact | null;
  /** Free-form payload from the triggering event, available to conditions and templates. */
  data: Record<string, unknown>;
  /** Makes each run idempotent: the same trigger occurrence runs at most once. */
  dedupeKey: string;
}

export async function listAutomations(
  tenantId: string,
  runner: Queryable = db(),
): Promise<Automation[]> {
  const { rows } = await runner.query<Automation>(
    'SELECT * FROM automations WHERE tenant_id = $1 ORDER BY key',
    [tenantId],
  );
  return rows;
}

export async function upsertAutomation(
  tenantId: string,
  input: {
    key: string;
    name: string;
    triggerType: TriggerType | string;
    triggerConfig?: Record<string, unknown>;
    conditions?: Condition[];
    actions: Action[];
    enabled?: boolean;
  },
  runner: Queryable = db(),
): Promise<Automation> {
  const row = await queryOne<Automation>(
    runner,
    `INSERT INTO automations (
       tenant_id, key, name, trigger_type, trigger_config, conditions, actions, enabled
     ) VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8)
     ON CONFLICT (tenant_id, key) DO UPDATE SET
       name = EXCLUDED.name,
       trigger_type = EXCLUDED.trigger_type,
       trigger_config = EXCLUDED.trigger_config,
       conditions = EXCLUDED.conditions,
       actions = EXCLUDED.actions,
       enabled = EXCLUDED.enabled,
       updated_at = now()
     RETURNING *`,
    [
      tenantId,
      input.key,
      input.name,
      input.triggerType,
      JSON.stringify(input.triggerConfig ?? {}),
      JSON.stringify(input.conditions ?? []),
      JSON.stringify(input.actions),
      input.enabled ?? true,
    ],
  );
  return row!;
}

export interface FireResult {
  ran: string[];
  skipped: string[];
  /** Runs parked on a wait; the worker finishes them later. */
  waiting: string[];
}

/**
 * Run every enabled automation listening for `triggerType`.
 *
 * One automation failing is logged against that run and does not stop the rest:
 * a broken email template should not block the points award behind it.
 */
export async function fire(
  tenantId: string,
  triggerType: TriggerType | string,
  ctx: AutomationContext,
  runner: Queryable = db(),
): Promise<FireResult> {
  const { rows: automations } = await runner.query<Automation>(
    'SELECT * FROM automations WHERE tenant_id = $1 AND trigger_type = $2 AND enabled',
    [tenantId, triggerType],
  );
  if (automations.length === 0) return { ran: [], skipped: [], waiting: [] };

  const tenant = await getTenantById(tenantId);
  if (!tenant) return { ran: [], skipped: [], waiting: [] };

  const ran: string[] = [];
  const skipped: string[] = [];
  /** Runs that parked on a wait and will finish later. */
  const waiting: string[] = [];

  for (const automation of automations) {
    if (!evaluateConditions(automation.conditions ?? [], ctx)) {
      skipped.push(automation.key);
      continue;
    }

    const claim = await queryOne<{ id: string }>(
      runner,
      // `status` named rather than left to the column default, which is
      // 'completed'. A crash between claiming the run and finishing it left a
      // row saying the automation had completed when it had never started —
      // and its dedupe key spent, so it could never be retried.
      `INSERT INTO automation_runs
         (tenant_id, automation_id, contact_id, dedupe_key, context, status)
       VALUES ($1, $2, $3, $4, $5::jsonb, 'running')
       ON CONFLICT (automation_id, dedupe_key) DO NOTHING
       RETURNING id`,
      [
        tenantId,
        automation.id,
        ctx.contact?.id ?? null,
        ctx.dedupeKey,
        JSON.stringify(ctx.data ?? {}),
      ],
    );
    if (!claim) {
      skipped.push(automation.key);
      continue;
    }

    try {
      // Runs through the step machine even when there is no wait in the list,
      // so there is one execution path rather than two that drift.
      const result = await advanceRun(
        runner,
        tenant,
        automation,
        {
          id: claim.id,
          tenant_id: tenantId,
          automation_id: automation.id,
          contact_id: ctx.contact?.id ?? null,
          dedupe_key: ctx.dedupeKey,
          status: 'running',
          step_index: 0,
          resume_at: null,
          attempts: 0,
          steps_executed: 0,
          actions_hash: actionsHash(automation.actions),
          context: ctx.data ?? {},
          error: null,
        },
        runActionStep,
      );

      await runner.query(
        `UPDATE automation_runs
            SET status = $2, step_index = $3, resume_at = $4,
                steps_executed = $5, actions_hash = $6, updated_at = now()
          WHERE id = $1`,
        [
          claim.id,
          result.status,
          result.stepIndex,
          result.resumeAt,
          result.stepsExecuted,
          actionsHash(automation.actions),
        ],
      );

      if (result.status === 'waiting') waiting.push(automation.key);
      else ran.push(automation.key);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await runner.query(
        `UPDATE automation_runs SET status = 'failed', error = $2, updated_at = now() WHERE id = $1`,
        [claim.id, message.slice(0, 500)],
      );
      skipped.push(automation.key);
    }
  }

  return { ran, skipped, waiting };
}

/**
 * Perform one action.
 *
 * The sequencing — order, waits, branches — belongs to the step machine in
 * `automation-runner.ts`. This only knows how to do one thing to one contact.
 */
async function runActionStep(
  runner: Queryable,
  tenant: Tenant,
  automation: Automation,
  action: Action,
  ctx: AutomationContext,
  stepIndex: number,
): Promise<void> {
  {
    switch (action.type) {
      case 'send_email':
        await sendEmailAction(runner, tenant, automation, action, ctx, stepIndex);
        break;

      case 'award_points':
        if (ctx.contact) {
          await award(
            tenant.id,
            {
              contactId: ctx.contact.id,
              points: action.points,
              reason: action.reason ?? automation.name,
              refType: 'automation',
              refId: automation.id,
              idempotencyKey: `automation:${automation.key}:${stepIndex}:${ctx.dedupeKey}`,
            },
            runner,
          );
        }
        break;

      case 'add_tag':
        if (ctx.contact) {
          await runner.query(
            `UPDATE contacts SET tags = (
               SELECT COALESCE(array_agg(DISTINCT tag), '{}') FROM unnest(tags || $2::text[]) AS tag
             ), updated_at = now() WHERE id = $1`,
            [ctx.contact.id, [action.tag]],
          );
        }
        break;

      case 'remove_tag':
        if (ctx.contact) {
          await runner.query(
            `UPDATE contacts SET tags = array_remove(tags, $2), updated_at = now() WHERE id = $1`,
            [ctx.contact.id, action.tag],
          );
        }
        break;

      case 'webhook':
        await enqueueWebhook(runner, tenant.id, action.topic, {
          automation: automation.key,
          contact_id: ctx.contact?.id ?? null,
          ...ctx.data,
        });
        break;
    }
  }
}

async function sendEmailAction(
  runner: Queryable,
  tenant: Tenant,
  automation: Automation,
  action: Extract<Action, { type: 'send_email' }>,
  ctx: AutomationContext,
  stepIndex: number,
): Promise<void> {
  if (!ctx.contact?.email) return;

  const template = await getTemplate(tenant.id, action.template, runner);
  if (!template) throw new Error(`Unknown email template "${action.template}"`);

  // Marketing needs consent; a transactional message does not. Gating both on
  // the same flag meant "you earned 250 points on your order" was suppressed
  // for anyone who had not also opted into marketing — a receipt withheld for
  // want of a marketing opt-in. See `upsertTemplate` for where the line sits.
  if (!template.transactional && !ctx.contact.marketing_consent) return;

  // A paused contact, or one who turned this topic off, is skipped here rather
  // than at the trigger — a sequence that waits three days should re-check
  // before each step instead of acting on what was true when it started.
  //
  // Transactional mail passes straight through, for the same reason as the
  // consent check above it.
  //
  // On `runner`, not the pool. Passing `undefined` sent this read outside the
  // caller's transaction, and the callers that matter fire from inside the
  // transaction that just created the contact or granted consent —
  // `newsletter.confirmed`, single-opt-in `subscribe`, `contact.created` from
  // `/v1/identify`. The pool saw the pre-commit row: consent still false, or no
  // row at all. So every welcome series built on those triggers silently sent
  // nothing, and the run was recorded as completed.
  const wanted = await mayReceive(
    tenant.id,
    ctx.contact.id,
    template.topic_key ?? null,
    runner,
    template.transactional,
  );
  if (!wanted.allowed) return;

  // And the retailer's frequency cap, which until now only broadcasts
  // honoured. A cap one of four senders obeys is not a cap: a welcome series,
  // an abandoned-cart sequence and a points-awarded email can all fire for the
  // same person on the same afternoon, each certain it is the only message
  // being sent, while the tenant's setting says one a day. Transactional mail
  // is exempt, because it carries no unsubscribe link and the cap counts only
  // messages that do.
  if (!template.transactional) {
    const over = await overFrequencyCap(
      runner,
      tenant.id,
      ctx.contact.id,
      frequencyRuleFor(tenant),
    );
    if (over) return;
  }

  // Built once and used twice: in the body and in the List-Unsubscribe header,
  // so the mail client's own button and the link in the message agree.
  const unsubscribeUrl = unsubscribeRequestUrl(tenant.id, ctx.contact.email);
  const preferenceUrl = preferencesUrl(tenant.id, ctx.contact.email);

  // A template built from blocks, where some block is conditional, has to be
  // re-rendered for this recipient: the stored HTML shows every block, because
  // it was rendered with nobody's membership.
  const body = await personalise(tenant.id, ctx.contact.id, template, runner);

  // Read, never taken from the trigger. `order.completed` carries `points` as
  // the amount that order *earned*, and `points.awarded` carries the balance of
  // whichever currency that rule pays — neither is "your balance" in the
  // default currency, which is what the block says. Looked up only when the
  // message holds the block, so a template without one costs no extra query,
  // and on `runner` so an award still inside its own transaction is counted.
  const pointsBalance = body.html.includes('{{points_balance}}')
    ? await pointsBalanceFor(tenant.id, ctx.contact.id, runner)
    : '';

  const rendered = renderTemplate(body, {
    tenant_name: tenant.name,
    name: ctx.contact.name ?? '',
    email: ctx.contact.email,
    rewards_url: (tenant.settings?.siteUrl as string) ?? config().publicUrl,
    // The `points` block emits {{points_balance}}. Resolved here rather than
    // inside the renderer so a block stays a description of what to show,
    // with no way to reach the database of its own.
    points_balance: pointsBalance,
    unsubscribe_url: unsubscribeUrl,
    preferences_url: preferenceUrl,
    ...ctx.data,
  });

  await queueEmail(
    {
      tenantId: tenant.id,
      contactId: ctx.contact.id,
      templateKey: action.template,
      to: ctx.contact.email,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      // A caller-supplied dedupe is scoped to the contact, and has to be.
      //
      // `email_messages` is UNIQUE (tenant_id, dedupe_key) and the insert is
      // ON CONFLICT DO NOTHING, so a fixed string here -- which is the obvious
      // thing to write for "only send this once" -- delivered the message to
      // whichever contact the scheduler reached first and silently dropped it
      // for everybody else, while every run still reported `completed`. The
      // only sane reading of a per-contact action's dedupe is "once per
      // contact"; "once per tenant" is what the automation's own enrolment
      // key already provides.
      dedupeKey: action.dedupe
        ? `automation:${automation.key}:${action.dedupe}:${ctx.contact.id}`
        : `automation:${automation.key}:${stepIndex}:${ctx.dedupeKey}`,
      // Marketing mail is tracked; a transactional receipt is not. The same
      // flag that decides whether consent is required decides this, because
      // the two questions have the same answer: is this a campaign or a
      // receipt for something the person just did.
      track: shouldTrack(tenant, { transactional: template.transactional }),
      // Transactional mail has nothing to unsubscribe from, so it gets no
      // header — a receipt offering to stop sending receipts is nonsense.
      unsubscribeUrl: template.transactional ? null : unsubscribeUrl,
      ...senderFor(tenant),
    },
    runner,
  );
}

export async function enqueueWebhook(
  runner: Queryable,
  tenantId: string,
  topic: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const { rows } = await runner.query<{ id: string }>(
    `SELECT id FROM webhooks
      WHERE tenant_id = $1 AND enabled AND (topics = '{}' OR $2 = ANY(topics))`,
    [tenantId, topic],
  );
  for (const hook of rows) {
    await runner.query(
      `INSERT INTO webhook_deliveries (tenant_id, webhook_id, topic, payload)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [tenantId, hook.id, topic, JSON.stringify(payload)],
    );
  }
}

export function evaluateConditions(conditions: Condition[], ctx: AutomationContext): boolean {
  return conditions.every((condition) => evaluateCondition(condition, ctx));
}

function evaluateCondition(condition: Condition, ctx: AutomationContext): boolean {
  const actual = resolveField(condition.field, ctx);

  switch (condition.op) {
    case 'exists':
      return actual !== undefined && actual !== null && actual !== '';
    case 'not_exists':
      return actual === undefined || actual === null || actual === '';
    case 'eq':
      return looseEqual(actual, condition.value);
    case 'ne':
      return !looseEqual(actual, condition.value);
    case 'gt':
      return numeric(actual) > numeric(condition.value);
    case 'gte':
      return numeric(actual) >= numeric(condition.value);
    case 'lt':
      return numeric(actual) < numeric(condition.value);
    case 'lte':
      return numeric(actual) <= numeric(condition.value);
    case 'contains':
      if (Array.isArray(actual)) return actual.some((item) => looseEqual(item, condition.value));
      return String(actual ?? '')
        .toLowerCase()
        .includes(String(condition.value ?? '').toLowerCase());
    default:
      return false;
  }
}

function resolveField(field: string, ctx: AutomationContext): unknown {
  const [head, ...rest] = field.split('.');
  const root: Record<string, unknown> =
    head === 'contact'
      ? ((ctx.contact ?? {}) as unknown as Record<string, unknown>)
      : { ...ctx.data, contact: ctx.contact };

  const path = head === 'contact' ? rest : field.split('.');
  return path.reduce<unknown>((acc, part) => {
    if (acc && typeof acc === 'object' && part in (acc as Record<string, unknown>)) {
      return (acc as Record<string, unknown>)[part];
    }
    return undefined;
  }, root as unknown);
}

function looseEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || a === undefined || b === null || b === undefined) return false;
  return String(a).toLowerCase() === String(b).toLowerCase();
}

function numeric(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

/** The automations a new retailer gets out of the box. */
export async function installDefaultAutomations(
  tenantId: string,
  runner: Queryable = db(),
): Promise<void> {
  await upsertAutomation(
    tenantId,
    {
      key: 'welcome_points_email',
      name: 'Tell customers when they earn points',
      triggerType: 'points.awarded',
      conditions: [{ field: 'points', op: 'gte', value: 50 }],
      actions: [{ type: 'send_email', template: 'points_awarded' }],
      enabled: false,
    },
    runner,
  );

  await upsertAutomation(
    tenantId,
    {
      key: 'tag_big_spender',
      name: 'Tag customers who spend over 200',
      triggerType: 'order.completed',
      conditions: [{ field: 'subtotal_cents', op: 'gte', value: 20_000 }],
      actions: [{ type: 'add_tag', tag: 'vip' }],
      enabled: true,
    },
    runner,
  );
}

/**
 * Resume parked runs whose wait has elapsed.
 *
 * Lives here rather than in the runner so the action implementations stay
 * private to this module; the runner only ever receives them as a callback.
 */
export async function runDueAutomations(limit = 50): Promise<{
  resumed: number;
  completed: number;
  failed: number;
}> {
  return resumeDueRuns(runActionStep, limit);
}

export async function deleteAutomation(
  tenantId: string,
  key: string,
  runner: Queryable = db(),
): Promise<boolean> {
  const { rowCount } = await runner.query(
    'DELETE FROM automations WHERE tenant_id = $1 AND key = $2',
    [tenantId, key],
  );
  return (rowCount ?? 0) > 0;
}

/** Runs, newest first — mostly so an admin can see a sequence actually parked. */
export async function listRuns(
  tenantId: string,
  automationKey?: string,
  runner: Queryable = db(),
): Promise<
  Array<{
    id: string;
    automation_key: string;
    contact_id: string | null;
    status: string;
    step_index: number;
    resume_at: Date | null;
    error: string | null;
    created_at: Date;
  }>
> {
  const { rows } = await runner.query(
    `SELECT r.id, a.key AS automation_key, r.contact_id, r.status, r.step_index,
            r.resume_at, r.error, r.created_at
       FROM automation_runs r JOIN automations a ON a.id = r.automation_id
      WHERE r.tenant_id = $1 AND ($2::text IS NULL OR a.key = $2)
      ORDER BY r.created_at DESC
      LIMIT 200`,
    [tenantId, automationKey ?? null],
  );
  return rows as never;
}

const ACTION_TYPES = ['send_email', 'award_points', 'add_tag', 'remove_tag', 'webhook'];
const CONTROL_TYPES = ['wait', 'if', 'goto', 'stop'];

/**
 * Check a step list before it is saved.
 *
 * Validating here rather than at run time means a bad sequence is rejected
 * while an admin is looking at the form, not silently parked forever when a
 * customer triggers it at two in the morning.
 */
/**
 * Does this filter actually decide anything?
 *
 * `typeof step.filter !== 'object'` accepted three shapes that gate nobody.
 * `typeof null` is `'object'`, so a null filter passed and then failed at two
 * in the morning inside a customer's run rather than in front of the admin who
 * saved it. `{}` and `{ match: 'all', filters: [] }` are worse: they compile
 * to `TRUE`, which is the right answer for a *segment* -- an empty definition
 * means everyone, and that is the default a new segment is created with -- and
 * exactly the wrong one for a branch. An admin who builds "if tagged vip, send
 * the VIP offer", saves it with the filter row still blank, and sees no error,
 * has sent the VIP offer to the whole list.
 *
 * So the branch asks a stricter question than the compiler does, at save time,
 * where the answer is useful.
 */
function gatesAnything(filter: unknown): boolean {
  if (typeof filter !== 'object' || filter === null || Array.isArray(filter)) return false;
  const group = filter as { filters?: unknown; groups?: unknown };
  if (Array.isArray(group.filters) && group.filters.length > 0) return true;
  return Array.isArray(group.groups) && group.groups.some((nested) => gatesAnything(nested));
}

export function validateSteps(steps: Array<Record<string, unknown>>): void {
  steps.forEach((step, index) => {
    const type = String(step.type ?? '');

    if (CONTROL_TYPES.includes(type)) {
      if (type === 'wait') {
        // Throws on a zero or absurd duration.
        waitSeconds(step as never);
      }
      if (type === 'if' && !gatesAnything(step.filter)) {
        throw ApiError.badRequest(
          `Step ${index}: an "if" needs a filter with at least one condition`,
        );
      }
      if (type === 'goto') {
        const target = Number(step.step);
        if (!Number.isInteger(target) || target < 0 || target >= steps.length) {
          throw ApiError.badRequest(`Step ${index}: "goto" points outside the sequence`);
        }
      }
      return;
    }

    if (!ACTION_TYPES.includes(type)) {
      throw ApiError.badRequest(`Step ${index}: unknown step type "${type}"`);
    }
    if (type === 'send_email' && typeof step.template !== 'string') {
      throw ApiError.badRequest(`Step ${index}: "send_email" needs a template`);
    }
    if (type === 'award_points' && !Number.isFinite(Number(step.points))) {
      throw ApiError.badRequest(`Step ${index}: "award_points" needs points`);
    }
    if ((type === 'add_tag' || type === 'remove_tag') && typeof step.tag !== 'string') {
      throw ApiError.badRequest(`Step ${index}: "${type}" needs a tag`);
    }
    if (type === 'webhook' && typeof step.topic !== 'string') {
      throw ApiError.badRequest(`Step ${index}: "webhook" needs a topic`);
    }
  });

  // A sequence that only waits does nothing but occupy the worker.
  if (steps.length > 0 && steps.every((step) => CONTROL_TYPES.includes(String(step.type)))) {
    throw ApiError.badRequest('A sequence needs at least one action');
  }
}

import { db, queryOne, type Queryable } from '../db/pool.js';
import { config } from '../config.js';
import { getTemplate, queueEmail, renderTemplate, senderFor } from './email.js';
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
  | 'token.claimed';

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
  if (automations.length === 0) return { ran: [], skipped: [] };

  const tenant = await getTenantById(tenantId);
  if (!tenant) return { ran: [], skipped: [] };

  const ran: string[] = [];
  const skipped: string[] = [];

  for (const automation of automations) {
    if (!evaluateConditions(automation.conditions ?? [], ctx)) {
      skipped.push(automation.key);
      continue;
    }

    const claim = await queryOne<{ id: string }>(
      runner,
      `INSERT INTO automation_runs (tenant_id, automation_id, contact_id, dedupe_key, context)
       VALUES ($1, $2, $3, $4, $5::jsonb)
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
      await runActions(runner, tenant, automation, ctx);
      ran.push(automation.key);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await runner.query(
        `UPDATE automation_runs SET status = 'failed', error = $2 WHERE id = $1`,
        [claim.id, message.slice(0, 500)],
      );
      skipped.push(automation.key);
    }
  }

  return { ran, skipped };
}

async function runActions(
  runner: Queryable,
  tenant: Tenant,
  automation: Automation,
  ctx: AutomationContext,
): Promise<void> {
  for (const action of automation.actions ?? []) {
    switch (action.type) {
      case 'send_email':
        await sendEmailAction(runner, tenant, automation, action, ctx);
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
              idempotencyKey: `automation:${automation.key}:${ctx.dedupeKey}`,
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
): Promise<void> {
  if (!ctx.contact?.email) return;
  // Never mail someone who has not opted in.
  if (!ctx.contact.marketing_consent) return;

  const template = await getTemplate(tenant.id, action.template, runner);
  if (!template) throw new Error(`Unknown email template "${action.template}"`);

  const rendered = renderTemplate(template, {
    tenant_name: tenant.name,
    name: ctx.contact.name ?? '',
    email: ctx.contact.email,
    rewards_url: (tenant.settings?.siteUrl as string) ?? config().publicUrl,
    unsubscribe_url: `${config().publicUrl}/n/unsubscribe-request?t=${tenant.id}&email=${encodeURIComponent(ctx.contact.email)}`,
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
      dedupeKey: action.dedupe ?? `automation:${automation.key}:${ctx.dedupeKey}`,
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

import { createHash } from 'node:crypto';
import { db, queryOne, withTransaction, type Queryable } from '../db/pool.js';
import { ApiError } from '../lib/errors.js';
import { compileGroup, type FilterGroup } from './segment-filters.js';
import { getContact } from './contacts.js';
import { customFieldsFor } from './segments.js';
import { getTenantById, type Tenant } from './tenants.js';
import type { Automation, AutomationContext, Action } from './automations.js';

/**
 * Running an automation as a resumable sequence.
 *
 * Before this, an automation was a trigger and a flat list of actions that all
 * ran at once. So "send the cart email, wait a day, and if they still have not
 * bought, send another" was not expressible — which is exactly why cart
 * recovery is a hand-written worker with its stages in environment variables.
 * A welcome series, a review request and a win-back all have that shape.
 *
 * Execution model: the action list is flat and `step_index` is the program
 * counter. A `wait` parks the run with a `resume_at` and the worker picks it
 * up later. That keeps the whole state of a paused sequence in one row, which
 * is what makes it survivable across restarts.
 *
 * The property that matters most: **a condition after a wait is evaluated
 * against live data, not the frozen trigger payload**. "If they still have not
 * bought" is a question about now, and answering it from a day-old snapshot
 * would send the follow-up to everyone who did buy.
 */

/** How many steps one run may execute, across all its resumptions. */
const MAX_STEPS = 100;

/**
 * How many times a parked run may fail before it stops being retried.
 *
 * A run that throws every time — a template deleted after it parked, a `goto`
 * that names nothing — is not going to start working, and retrying it forever
 * spends the batch that healthy runs need.
 */
const MAX_RESUME_ATTEMPTS = 3;

/** Longest a run may be parked. Two years is far past any real sequence. */
const MAX_WAIT_SECONDS = 60 * 60 * 24 * 730;

export type RunStatus =
  | 'running' | 'waiting' | 'completed' | 'failed' | 'skipped' | 'cancelled';

export interface AutomationRun {
  id: string;
  tenant_id: string;
  automation_id: string;
  contact_id: string | null;
  dedupe_key: string;
  status: RunStatus;
  step_index: number;
  resume_at: Date | null;
  attempts: number;
  /** Steps executed across every resumption, not just this one. */
  steps_executed: number;
  /** Digest of the action list this run started under. */
  actions_hash: string | null;
  context: Record<string, unknown>;
  error: string | null;
}

/** Steps that control the sequence rather than doing something to a contact. */
export type ControlAction =
  | { type: 'wait'; seconds?: number; minutes?: number; hours?: number; days?: number }
  | {
      type: 'if';
      /** Evaluated live against the contact, using the segment field catalogue. */
      filter: FilterGroup;
      /** Where to go when the filter does not match. Default: stop. */
      else?: 'stop' | 'continue' | { goto: number };
    }
  | { type: 'goto'; step: number }
  | { type: 'stop' };

export type Step = Action | ControlAction;

export function isControlAction(step: Step): step is ControlAction {
  return ['wait', 'if', 'goto', 'stop'].includes(step.type);
}

export function waitSeconds(step: Extract<ControlAction, { type: 'wait' }>): number {
  const seconds =
    (step.seconds ?? 0) +
    (step.minutes ?? 0) * 60 +
    (step.hours ?? 0) * 3600 +
    (step.days ?? 0) * 86_400;

  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw ApiError.badRequest('A wait needs a positive duration');
  }
  if (seconds > MAX_WAIT_SECONDS) {
    throw ApiError.badRequest('A wait may not exceed two years');
  }
  return Math.trunc(seconds);
}

/**
 * Does this contact match a filter, right now?
 *
 * Reuses the segment compiler, so an `if` step can ask anything a segment can
 * — "has ordered in the last day", "balance above 500", "still has an
 * abandoned cart" — and there is one field catalogue rather than two that
 * drift apart.
 */
export async function contactMatches(
  runner: Queryable,
  tenantId: string,
  contactId: string,
  filter: FilterGroup,
): Promise<boolean> {
  const tenant = await queryOne<{ timezone: string | null }>(
    runner,
    'SELECT timezone FROM tenants WHERE id = $1',
    [tenantId],
  );
  // With the retailer's own fields, like every other compile site. Without
  // them a `cf_*` filter — legal in a segment, and offered by the same builder
  // — threw "Unknown segment field" when the run resumed, which failed the run
  // rather than the form.
  const compiled = compileGroup(
    filter,
    tenant?.timezone?.trim() || 'UTC',
    2,
    0,
    undefined,
    await customFieldsFor(tenantId, runner),
  );

  const row = await queryOne<{ matched: boolean }>(
    runner,
    `SELECT TRUE AS matched FROM contacts c
      WHERE c.tenant_id = $1 AND c.id = $2 AND (${compiled.sql})`,
    [tenantId, contactId, ...compiled.params],
  );
  return row !== null;
}

export interface StepOutcome {
  status: RunStatus;
  stepIndex: number;
  resumeAt: Date | null;
  /** Total steps this run has executed, to persist on the row. */
  stepsExecuted: number;
}

/**
 * A digest of the action list.
 *
 * A run stores an integer index against a live action list, so editing the
 * list while runs are parked shifts what that index points at. Because
 * idempotency keys embed the index, an `award_points` step could land at a
 * position that had already run, under a new key, and hand out points nobody
 * earned. Comparing this on resume is how a run notices.
 */
export function actionsHash(actions: unknown): string {
  return createHash('sha256').update(JSON.stringify(actions ?? [])).digest('hex').slice(0, 32);
}

export type ActionRunner = (
  runner: Queryable,
  tenant: Tenant,
  automation: Automation,
  action: Action,
  ctx: AutomationContext,
  /**
   * Which step this is.
   *
   * Part of every idempotency and dedupe key the action writes. Without it, a
   * sequence with two `award_points` steps would give them the same key and
   * only the first would land — a bug that only appears once sequences exist,
   * because before this an action list ran exactly once each.
   */
  stepIndex: number,
) => Promise<void>;

/**
 * Execute a run from its current step until it finishes or parks.
 *
 * `performAction` is injected rather than imported so this module does not
 * depend on the one that owns the action implementations — they already depend
 * on this one for the types.
 */
export async function advanceRun(
  runner: Queryable,
  tenant: Tenant,
  automation: Automation,
  run: AutomationRun,
  performAction: ActionRunner,
): Promise<StepOutcome> {
  const steps = (automation.actions ?? []) as Step[];
  let index = run.step_index;
  // Carried on the row, not reset per resumption. A `wait 1s` + `goto 0` cycle
  // would otherwise re-park forever and monopolise the shared worker across
  // every tenant on the platform.
  let executed = run.steps_executed ?? 0;

  // The contact is re-read on every resumption, never taken from the stored
  // context: a sequence that waits a week and then mails a name from a week
  // ago is a bug the customer sees.
  const contact = run.contact_id
    ? await getContact(tenant.id, run.contact_id, runner)
    : null;

  const ctx: AutomationContext = {
    contact,
    data: run.context ?? {},
    dedupeKey: run.dedupe_key,
  };

  while (index < steps.length) {
    if (executed >= MAX_STEPS) {
      // A goto loop that never terminates would otherwise spin a worker
      // forever. Failing loudly is better than a silent cap.
      throw new Error(`Automation "${automation.key}" exceeded ${MAX_STEPS} steps`);
    }
    executed += 1;

    const step = steps[index]!;

    if (!isControlAction(step)) {
      await performAction(runner, tenant, automation, step, ctx, index);
      index += 1;
      continue;
    }

    switch (step.type) {
      case 'stop':
        return { status: 'completed', stepIndex: index, resumeAt: null, stepsExecuted: executed };

      case 'goto': {
        const target = Number(step.step);
        if (!Number.isInteger(target) || target < 0 || target >= steps.length) {
          throw new Error(`Automation "${automation.key}" jumps to a step that does not exist`);
        }
        index = target;
        continue;
      }

      case 'wait': {
        const seconds = waitSeconds(step);
        const resumeAt = new Date(Date.now() + seconds * 1000);
        // Park *after* the wait step, so resuming does not wait again.
        return { status: 'waiting', stepIndex: index + 1, resumeAt, stepsExecuted: executed };
      }

      case 'if': {
        if (!contact) {
          // Nothing to evaluate against. Treating an absent contact as "does
          // not match" is the conservative reading: the branch exists to gate
          // a further message, and we do not send it on a guess.
          return { status: 'completed', stepIndex: index, resumeAt: null, stepsExecuted: executed };
        }

        const matched = await contactMatches(runner, tenant.id, contact.id, step.filter);
        if (matched) {
          index += 1;
          continue;
        }

        const fallback = step.else ?? 'stop';
        if (fallback === 'stop') {
          return { status: 'completed', stepIndex: index, resumeAt: null, stepsExecuted: executed };
        }
        if (fallback === 'continue') {
          index += 1;
          continue;
        }
        const target = Number(fallback.goto);
        if (!Number.isInteger(target) || target < 0 || target >= steps.length) {
          throw new Error(`Automation "${automation.key}" branches to a step that does not exist`);
        }
        index = target;
        continue;
      }
    }
  }

  return { status: 'completed', stepIndex: index, resumeAt: null, stepsExecuted: executed };
}

export interface ResumeResult {
  resumed: number;
  completed: number;
  failed: number;
}

/**
 * Resume every run whose wait has elapsed.
 *
 * Claimed with `FOR UPDATE SKIP LOCKED` so several workers can share the load,
 * and each run is advanced in its own transaction: one broken sequence must
 * not roll back the others in the batch.
 */
export async function resumeDueRuns(
  performAction: ActionRunner,
  limit = 50,
  runner: Queryable = db(),
): Promise<ResumeResult> {
  const { rows } = await runner.query<{ id: string }>(
    `SELECT id FROM automation_runs
      WHERE status IN ('waiting', 'running')
        AND resume_at IS NOT NULL AND resume_at <= now()
      ORDER BY resume_at
      LIMIT $1
      FOR UPDATE SKIP LOCKED`,
    [limit],
  );

  let resumed = 0;
  let completed = 0;
  let failed = 0;

  for (const { id } of rows) {
    try {
      const outcome = await withTransaction(async (client) => {
        // `resume_at <= now()` is re-checked *inside* the lock, not just in
        // the selection above. The selection runs on the pool in autocommit,
        // so its row locks are released the moment it returns — two workers
        // can both select the same run. Without this clause the second one
        // would acquire the lock after the first had just parked the run on a
        // fresh wait, see status 'waiting', and execute the post-wait steps
        // immediately: every delay in a sequence silently skipped.
        const run = await queryOne<AutomationRun>(
          client,
          `SELECT * FROM automation_runs
            WHERE id = $1
              AND status IN ('waiting', 'running')
              AND resume_at IS NOT NULL AND resume_at <= now()
            FOR UPDATE`,
          [id],
        );
        if (!run) return null;

        const automation = await queryOne<Automation>(
          client,
          'SELECT * FROM automations WHERE id = $1 AND enabled',
          [run.automation_id],
        );
        // A disabled or deleted automation cancels its parked runs rather than
        // resuming them: turning an automation off should stop the sequences
        // it already started, which is what an admin means by switching it off.
        if (!automation) {
          await client.query(
            `UPDATE automation_runs SET status = 'cancelled', resume_at = NULL, updated_at = now()
              WHERE id = $1`,
            [run.id],
          );
          return 'cancelled' as const;
        }

        // The sequence was edited while this run was parked. `step_index` is
        // an integer into a list that has changed shape, so resuming would run
        // whatever now sits at that position — and because idempotency keys
        // embed the index, an `award_points` step landing there would execute
        // again under a fresh key and hand out points nobody earned.
        //
        // Cancelling is the conservative choice: a half-finished sequence that
        // stops is recoverable, points issued twice are not.
        if (run.actions_hash && run.actions_hash !== actionsHash(automation.actions)) {
          await client.query(
            `UPDATE automation_runs
                SET status = 'cancelled', resume_at = NULL,
                    error = 'The sequence was edited while this run was waiting',
                    updated_at = now()
              WHERE id = $1`,
            [run.id],
          );
          return 'cancelled' as const;
        }

        const tenant = await getTenantById(run.tenant_id);
        if (!tenant) return null;

        // No attempt counted here. It used to be, on the reasoning that a run
        // which throws rolls this back and the catch counts it instead -- but
        // a run that commits has *succeeded*, and charging it an attempt made
        // `attempts` a count of resumptions rather than of failures. Every
        // wait in a sequence is a resumption, so a sequence with three waits
        // arrived at its first real error already out of budget and was
        // written off without a single retry. The catch below is the only
        // place a failure is counted.

        const result = await advanceRun(client, tenant, automation, run, performAction);

        await client.query(
          `UPDATE automation_runs
              SET status = $2, step_index = $3, resume_at = $4,
                  steps_executed = $5, error = NULL,
                  -- Consecutive failures, so a step that works clears the
                  -- slate: two bad afternoons weeks apart are not three.
                  attempts = 0,
                  updated_at = now()
            WHERE id = $1`,
          [run.id, result.status, result.stepIndex, result.resumeAt, result.stepsExecuted],
        );

        return result.status;
      });

      if (outcome === null) continue;
      resumed += 1;
      if (outcome === 'completed') completed += 1;
    } catch (err) {
      failed += 1;
      const message = err instanceof Error ? err.message : String(err);
      // Recorded on its own connection: the run's transaction is already
      // rolled back, so writing the reason inside it would be lost.
      await db().query(
        // The increment happens here, not only inside the transaction above:
        // that one rolled back with everything else, so `attempts` stayed 0,
        // `attempts >= 3` never fired, and `now() + 0 minutes` made the run due
        // again immediately. A run that always throws — a deleted template, a
        // bad `goto` — was re-selected every thirty seconds forever, filling
        // the batch of 50 and starving every healthy run behind it. It never
        // showed up as failed, because it never stopped being "waiting".
        `UPDATE automation_runs
            SET attempts = attempts + 1,
                status = CASE WHEN attempts + 1 >= $3 THEN 'failed' ELSE 'waiting' END,
                error = $2,
                -- Back off rather than retrying in a tight loop against
                -- whatever is broken.
                resume_at = now() + ((attempts + 1) * interval '5 minutes'),
                updated_at = now()
          WHERE id = $1`,
        [id, message.slice(0, 500), MAX_RESUME_ATTEMPTS],
      );
    }
  }

  return { resumed, completed, failed };
}

/** Stop a contact's parked runs, e.g. when they convert or unsubscribe. */
export async function cancelRunsFor(
  tenantId: string,
  contactId: string,
  automationKey?: string,
  runner: Queryable = db(),
): Promise<number> {
  const { rowCount } = await runner.query(
    `UPDATE automation_runs r
        SET status = 'cancelled', resume_at = NULL, updated_at = now()
       FROM automations a
      WHERE r.automation_id = a.id
        AND r.tenant_id = $1 AND r.contact_id = $2
        AND r.status IN ('waiting', 'running')
        AND ($3::text IS NULL OR a.key = $3)`,
    [tenantId, contactId, automationKey ?? null],
  );
  return rowCount ?? 0;
}

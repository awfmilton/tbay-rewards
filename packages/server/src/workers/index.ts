import { runCartRecovery } from './cart-recovery.js';
import { deliverWebhooks } from './webhooks.js';
import { flushEmailQueue } from '../services/email.js';
import { releaseMaturedPoints } from '../services/points.js';
import { approveMaturedCommissions } from '../services/commissions.js';
import { expireStaleShares } from '../services/shares.js';
import { expireStaleClaims, expireStaleSpendIntents, reconcileClaims } from '../services/token.js';
import { purgeExpiredChallenges } from '../services/wallets.js';
import { buildAllSegments } from '../services/segments.js';
import { runDueBroadcasts } from '../services/broadcasts.js';
import { runDueAutomations } from '../services/automations.js';
import { flushCounters, startCounterBuffer, stopCounterBuffer } from '../services/counters.js';
import { runRetentionSweep } from '../services/privacy.js';
import { expirePauses } from '../services/preferences.js';
import { runDueReports } from '../services/report-schedules.js';
import { config } from '../config.js';

/**
 * Background jobs.
 *
 * Every job is idempotent and safe to run concurrently on several nodes — they
 * all claim work with `FOR UPDATE SKIP LOCKED` or a unique key — so this can run
 * inside the API process for a small deployment or as a separate `npm run
 * worker` process for a larger one.
 */

export interface Logger {
  info(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

export interface Job {
  name: string;
  intervalMs: number;
  run(): Promise<unknown>;
}

export const JOBS: Job[] = [
  { name: 'email_queue', intervalMs: 15_000, run: () => flushEmailQueue(50) },
  { name: 'cart_recovery', intervalMs: 60_000, run: () => runCartRecovery() },
  { name: 'points_release', intervalMs: 60_000, run: () => releaseMaturedPoints() },
  { name: 'commission_release', intervalMs: 300_000, run: () => approveMaturedCommissions() },
  { name: 'share_expiry', intervalMs: 300_000, run: () => expireStaleShares() },
  { name: 'claim_expiry', intervalMs: 60_000, run: () => expireStaleClaims() },
  // Without this a pending spend intent never left `pending`, which is what
  // let one abandoned checkout block a customer's erasure forever.
  { name: 'spend_intent_expiry', intervalMs: 300_000, run: () => expireStaleSpendIntents() },
  { name: 'claim_reconcile', intervalMs: 120_000, run: () => reconcileClaims() },
  { name: 'webhook_delivery', intervalMs: 20_000, run: () => deliverWebhooks() },
  { name: 'challenge_purge', intervalMs: 3_600_000, run: () => purgeExpiredChallenges() },
  // Every ten minutes rather than every minute: a segment is a marketing
  // audience, not a real-time signal, and rebuilding one is a full scan of
  // contacts per segment. Anything needing to act the moment a contact changes
  // should be an automation trigger instead.
  { name: 'segment_build', intervalMs: 600_000, run: () => buildAllSegments() },
  // Every 30 seconds: a scheduled broadcast should go out close to its time,
  // and a send in progress should keep moving.
  { name: 'broadcast_send', intervalMs: 30_000, run: () => runDueBroadcasts() },
  // Every 30 seconds: a sequence that says "wait one hour" should resume close
  // to the hour, not up to ten minutes late.
  { name: 'automation_resume', intervalMs: 30_000, run: () => runDueAutomations() },
  // A belt-and-braces flush. The buffer has its own timer; this catches the
  // case where that timer was never started because buffering is off in this
  // process but another one wrote into the maps.
  { name: 'counter_flush', intervalMs: 10_000, run: () => flushCounters() },
  // Hourly, and deliberately bounded per pass. A retailer that turns on a
  // 30-day event policy after two years of collection has tens of millions of
  // rows to shed; taking a bite each hour catches up over a day or two without
  // ever holding locks on the largest table in the schema for minutes.
  { name: 'retention_sweep', intervalMs: 3_600_000, run: () => runRetentionSweep() },
  // Clearing the column is tidiness, not correctness: every read compares the
  // timestamp to now(), so a lapsed pause already sends. Doing it hourly means
  // "is this contact paused" is answerable by looking at the row.
  { name: 'pause_expiry', intervalMs: 3_600_000, run: () => expirePauses() },
  // Every fifteen minutes. A scheduled report is due from its hour onwards, so
  // the worst case is a Monday report arriving at 07:14 rather than 07:00 —
  // which nobody notices, unlike a report that runs on the minute and misses
  // its window entirely when the worker was restarting.
  { name: 'report_schedules', intervalMs: 900_000, run: () => runDueReports() },
];

const timers: NodeJS.Timeout[] = [];

export function startWorkers(logger: Logger): void {
  // Counter buffering is started here rather than at import time so a CLI
  // script or a test that pulls in these modules never accumulates state it
  // will not flush. See services/counters.ts for why only analytics counters
  // are ever buffered.
  if (config().tracking.bufferCounters) {
    startCounterBuffer(config().tracking.counterFlushMs);
    logger.info(
      { intervalMs: config().tracking.counterFlushMs },
      'counter buffering on: heatmap and product counters are eventually consistent',
    );
  }

  for (const job of JOBS) {
    let running = false;

    const tick = async (): Promise<void> => {
      // Skip rather than queue up: a slow pass should not stack passes behind it.
      if (running) return;
      running = true;
      try {
        await job.run();
      } catch (err) {
        logger.error({ err, job: job.name }, 'background job failed');
      } finally {
        running = false;
      }
    };

    const timer = setInterval(() => void tick(), job.intervalMs);
    timer.unref();
    timers.push(timer);
  }
  logger.info({ jobs: JOBS.map((job) => job.name) }, 'background workers started');
}

export function stopWorkers(): void {
  for (const timer of timers) clearInterval(timer);
  timers.length = 0;
  // Write out whatever is buffered before the process goes. A clean shutdown
  // losing three seconds of counters would be an avoidable loss.
  void stopCounterBuffer();
}

/** Run every job once. Used by the standalone worker entrypoint and by tests. */
export async function runAllJobsOnce(): Promise<Record<string, unknown>> {
  const results: Record<string, unknown> = {};
  for (const job of JOBS) {
    try {
      results[job.name] = await job.run();
    } catch (err) {
      results[job.name] = { error: err instanceof Error ? err.message : String(err) };
    }
  }
  return results;
}

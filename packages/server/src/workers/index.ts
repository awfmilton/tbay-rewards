import { runCartRecovery } from './cart-recovery.js';
import { deliverWebhooks } from './webhooks.js';
import { flushEmailQueue } from '../services/email.js';
import { releaseMaturedPoints } from '../services/points.js';
import { approveMaturedCommissions } from '../services/commissions.js';
import { expireStaleShares } from '../services/shares.js';
import { expireStaleClaims, reconcileClaims } from '../services/token.js';
import { purgeExpiredChallenges } from '../services/wallets.js';
import { buildAllSegments } from '../services/segments.js';
import { runDueBroadcasts } from '../services/broadcasts.js';

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
];

const timers: NodeJS.Timeout[] = [];

export function startWorkers(logger: Logger): void {
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

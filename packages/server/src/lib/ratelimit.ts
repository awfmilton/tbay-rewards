/**
 * Fixed-window in-process rate limiter.
 *
 * Deliberately not distributed: it exists to stop a single misbehaving site or
 * script from flooding ingest, and each API node enforcing its own share of the
 * budget is good enough for that. Put a shared limiter at the edge if you need
 * exact global limits.
 */
interface Window {
  count: number;
  resetAt: number;
}

const windows = new Map<string, Window>();
let lastSweep = Date.now();

/**
 * Sweep on size as well as on time, so a burst of distinct keys inside one
 * window cannot grow the map unchecked between scheduled sweeps. The tenant
 * and address ceilings bound how many keys a caller can mint, so this is
 * belt-and-braces rather than the actual defence.
 */
const SWEEP_AT_SIZE = 50_000;

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
}

export function rateLimit(key: string, limit: number, windowMs = 60_000): RateLimitResult {
  const now = Date.now();

  // Amortised cleanup so the map cannot grow without bound.
  if (now - lastSweep > windowMs || windows.size > SWEEP_AT_SIZE) {
    for (const [existing, window] of windows) {
      if (window.resetAt <= now) windows.delete(existing);
    }
    lastSweep = now;
  }

  const current = windows.get(key);
  if (!current || current.resetAt <= now) {
    const resetAt = now + windowMs;
    windows.set(key, { count: 1, resetAt });
    return { allowed: true, remaining: limit - 1, resetAt };
  }

  current.count += 1;
  return {
    allowed: current.count <= limit,
    remaining: Math.max(0, limit - current.count),
    resetAt: current.resetAt,
  };
}

export function resetRateLimits(): void {
  windows.clear();
}

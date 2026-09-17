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

/**
 * Where the map stops growing, whatever the sweep managed to free.
 *
 * Sweeping only deletes windows that have already expired, so a map of live
 * keys frees nothing however often it runs. A caller who can mint keys (a
 * spoofable address, a routed IPv6 /64) would otherwise grow it without
 * bound.
 */
const HARD_CEILING = 200_000;

/**
 * The shortest gap between two size-triggered sweeps.
 *
 * Without it, "sweep whenever the map is large" meant a full walk on *every*
 * call once past SWEEP_AT_SIZE -- measured at 0.65 ms per call at 52,000 keys
 * and rising linearly, on a path that runs twice per ingest request. The
 * ceiling bounded the memory and not the work. One walk a second is
 * amortised; one per request is the load itself.
 */
const MIN_SWEEP_GAP_MS = 1_000;
let lastSizeSweep = 0;

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
}

export function rateLimit(key: string, limit: number, windowMs = 60_000): RateLimitResult {
  const now = Date.now();

  // Amortised cleanup so the map cannot grow without bound.
  const onSchedule = now - lastSweep > windowMs;
  const tooBig = windows.size > SWEEP_AT_SIZE && now - lastSizeSweep > MIN_SWEEP_GAP_MS;
  if (onSchedule || tooBig) {
    // One pass, collecting the barely-used keys as it goes.
    const barelyUsed: string[] = [];
    for (const [existing, window] of windows) {
      if (window.resetAt <= now) windows.delete(existing);
      else if (window.count <= 1) barelyUsed.push(existing);
    }
    lastSweep = now;
    if (tooBig) lastSizeSweep = now;

    // Evict by how little a key has been used, not by how long it has been
    // there.
    //
    // Insertion order put the *longest-lived* buckets at the front -- the
    // tenant's admin key, every steady visitor -- so the eviction fell on
    // exactly the callers who had done nothing wrong, handing them a fresh
    // window while the flood that caused it kept its own. A key seen once is
    // what a flood is made of, and dropping it costs its owner a single
    // request of accounting.
    if (windows.size > HARD_CEILING) {
      let excess = windows.size - HARD_CEILING;
      for (const existing of barelyUsed) {
        if (excess <= 0) break;
        if (windows.delete(existing)) excess -= 1;
      }
      // Still over: a map genuinely full of busy keys. Take from the front,
      // which is the best that is left.
      for (const existing of windows.keys()) {
        if (excess <= 0) break;
        windows.delete(existing);
        excess -= 1;
      }
    }
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

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

/**
 * One map per key class, and that is the actual defence.
 *
 * Three rounds were spent looking for a ranking that would decide which key to
 * drop when the map is full, and every candidate was chosen by the attacker.
 * Insertion order took the longest-lived buckets, which are the tenant's own.
 * "count <= 1" was beaten by touching each minted key twice, at no cost.
 * Ranking by count was beaten the same way, because an idle admin bucket sits
 * at count 1 and a flood key touched twice sits above it -- measured at admin
 * evicted in every configuration and 200,000 of 210,000 flood keys kept.
 *
 * The mistake was looking for a ranking at all. The keys are not
 * interchangeable: `admin:<tenant>` is minted by provisioning a tenant, and
 * there is one per tenant, while `ingest:...:<address>:<visitor>` is minted by
 * whoever is calling. Only the second kind is unbounded, so only the second
 * kind needs a ceiling, and a flood confined to its own class cannot reach the
 * tenant's bucket however it is shaped.
 *
 * Within a class the order is least-recently-used, which is the one statistic
 * that cannot be gamed in the attacker's favour: to keep a key out of reach of
 * eviction they have to keep sending to it, and a key being sent to constantly
 * is a key the limiter is already rejecting. Being evicted hands out a fresh
 * window, so the keys that must survive are the ones at their limit -- and
 * those are, by definition, the most recently used.
 */
const CEILINGS: Record<string, number> = {
  // One key per tenant, minted by provisioning rather than by a caller. The
  // ceiling is a backstop, not a budget anyone can spend.
  admin: 100_000,
  // Per address and per visitor. This is the only unbounded class, so it is
  // the one a flood is confined to.
  ingest: 200_000,
  // Anything else, including keys added later that nobody thought to classify.
  other: 50_000,
};

const classes = new Map<string, Map<string, Window>>();
let lastSweep = Date.now();

function classOf(key: string): string {
  const separator = key.indexOf(':');
  const name = separator === -1 ? key : key.slice(0, separator);
  return name in CEILINGS ? name : 'other';
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
}

export function rateLimit(key: string, limit: number, windowMs = 60_000): RateLimitResult {
  const now = Date.now();

  // Scheduled reclamation only.
  //
  // There used to be a second, size-triggered sweep that ran a full walk and
  // then a full sort whenever the map was large. Past the threshold that meant
  // one sort of 200,000 entries per second on a path that runs twice per
  // ingest request -- measured at 60 ms of blocked event loop per second and
  // 15 MB of garbage per sweep, which is a bigger denial of service than the
  // one it was guarding against. The ceilings below bound the size exactly, in
  // constant time per insert, so there is nothing left for it to do.
  if (now - lastSweep > windowMs) {
    for (const windows of classes.values()) {
      for (const [existing, window] of windows) {
        if (window.resetAt <= now) windows.delete(existing);
      }
    }
    lastSweep = now;
  }

  const klass = classOf(key);
  let windows = classes.get(klass);
  if (!windows) {
    windows = new Map();
    classes.set(klass, windows);
  }

  const current = windows.get(key);
  if (current && current.resetAt > now) {
    current.count += 1;
    // Move to the back, so "least recently used" means what it says. A Map
    // keeps insertion order and `set` on an existing key does not change it,
    // so without the delete this would be first-seen order -- which is how
    // the very first version of this evicted the steady callers and kept the
    // flood.
    windows.delete(key);
    windows.set(key, current);
    return {
      allowed: current.count <= limit,
      remaining: Math.max(0, limit - current.count),
      resetAt: current.resetAt,
    };
  }

  const resetAt = now + windowMs;
  windows.delete(key);
  windows.set(key, { count: 1, resetAt });

  // Constant work: drop from the front, which is the end nobody has touched.
  // Sweeping alone could never do this -- it only deletes windows that have
  // already expired, so a map of live keys frees nothing however often it
  // runs, and a caller who can mint keys (a spoofable address, a routed IPv6
  // /64) would grow it without bound.
  const ceiling = CEILINGS[klass]!;
  let over = windows.size - ceiling;
  if (over > 0) {
    for (const oldest of windows.keys()) {
      if (over <= 0) break;
      windows.delete(oldest);
      over -= 1;
    }
  }

  return { allowed: 1 <= limit, remaining: Math.max(0, limit - 1), resetAt };
}

export function resetRateLimits(): void {
  classes.clear();
  lastSweep = Date.now();
}

/** Live key counts per class. Test and diagnostics helper. */
export function rateLimitSizes(): Record<string, number> {
  const sizes: Record<string, number> = {};
  for (const [klass, windows] of classes) sizes[klass] = windows.size;
  return sizes;
}

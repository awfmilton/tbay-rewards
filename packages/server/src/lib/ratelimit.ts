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
  /** The ceiling this key was last measured against; see rotate(). */
  limit: number;
}

/**
 * Two generations per class, rotated. Four attempts came before this one.
 *
 * The first three looked for a *ranking* that would pick the right key to drop
 * when the map is full, and the attacker chose every candidate: insertion order
 * took the longest-lived buckets, which are the tenant's own; "count <= 1" and
 * then ranking by count were both beaten by touching each minted key twice,
 * which costs nothing.
 *
 * The fourth used least-recently-used order, on the theory that a key at its
 * limit is one being sent to constantly and therefore safe. That theory was
 * wrong in the one case that matters: a caller who is being rejected *stops
 * sending* -- the tracker drops a 429 silently -- so their bucket becomes the
 * least recently used thing in the map and is the first to go, which hands them
 * a brand-new window. Measured: at limit, allowed=false; after an unrelated
 * flood, allowed=true with a full allowance restored.
 *
 * It was also slow. Keeping LRU order meant `delete` then `set` on every touch,
 * and evicting meant walking `keys()` from the front. Both leave tombstones in
 * V8's Map, and an iterator has to walk past them: measured at 40 us per insert
 * and 58 us per touch on a map at its ceiling, against 1.8 us for the same Map
 * operations in isolation. Two calls per ingest request made the limiter itself
 * the denial of service.
 *
 * So: no ranking and no deletes. New keys land in `live`; when `live` fills, it
 * becomes `old` and a fresh `live` starts, carrying over the buckets that are
 * at their limit. A key touched during either generation survives; a key nobody
 * has touched for two generations is gone. Dropping a generation is one
 * assignment, a touch is a field write, and a caller being rejected is carried
 * over by name rather than by hoping their traffic pattern protects them.
 */
interface Klass {
  live: Map<string, Window>;
  old: Map<string, Window>;
}

/**
 * Where each class stops growing.
 *
 * The classes are the actual defence against a key flood: `admin:<tenant>` is
 * minted by provisioning a tenant and there is one per tenant, while
 * `ingest:...:<address>:<visitor>` is minted by whoever is calling. Only the
 * second is unbounded, so a flood is confined to it and cannot reach a tenant's
 * own bucket however it is shaped.
 *
 * Within the ingest class every tenant shares one budget, which is safe only
 * because of the carry-over above: one site's flood can drop another site's
 * *idle* buckets -- handing a fresh window to somebody who was not being
 * limited, which costs nothing -- but it cannot drop a bucket that is at its
 * limit, which is the only eviction that would actually buy anybody throughput.
 */
const CEILINGS: Record<string, number> = {
  admin: 100_000,
  ingest: 200_000,
  other: 50_000,
};

/**
 * How much of a generation may be carried over for being at its limit.
 *
 * A bucket only qualifies by exceeding its own limit, which costs the caller
 * that many requests, so in practice this is far out of reach -- 200,000
 * blocked ingest buckets would take 120 million requests inside one window. It
 * is here so that a full carry cannot rotate the generation on every insert.
 */
const CARRY_FRACTION = 0.25;

const classes = new Map<string, Klass>();
let lastSweep = Date.now();

function classOf(key: string): string {
  const separator = key.indexOf(':');
  const name = separator === -1 ? key : key.slice(0, separator);
  // Own property only. `name in CEILINGS` is true for 'toString' and
  // 'constructor', and the ceiling then comes back as a function, so
  // `size > ceiling` is NaN and nothing is ever evicted.
  return Object.hasOwn(CEILINGS, name) ? name : 'other';
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
}

/**
 * Start a new generation, keeping the buckets that are at their limit.
 *
 * Rebuilt rather than filtered in place: every delete leaves a tombstone that
 * later iteration has to walk past, which is what made the previous version
 * quadratic in practice. This runs once per ceiling-worth of inserts, so it is
 * one carried entry per insert amortised.
 */
function rotate(klass: Klass, ceiling: number, now: number): void {
  const carried = new Map<string, Window>();
  const carryCap = Math.floor(ceiling * CARRY_FRACTION);
  for (const [key, window] of klass.live) {
    if (carried.size >= carryCap) break;
    if (window.resetAt > now && window.count >= window.limit) carried.set(key, window);
  }
  klass.old = klass.live;
  klass.live = carried;
}

export function rateLimit(key: string, limit: number, windowMs = 60_000): RateLimitResult {
  const now = Date.now();

  // Scheduled reclamation, by rebuild. A generation rotation already frees
  // whatever a busy class stops touching; this is for a quiet one, where the
  // map never fills and expired windows would otherwise sit there until it
  // did.
  if (now - lastSweep > windowMs) {
    for (const klass of classes.values()) {
      klass.old = new Map();
      const keep = new Map<string, Window>();
      for (const [existing, window] of klass.live) {
        if (window.resetAt > now) keep.set(existing, window);
      }
      klass.live = keep;
    }
    lastSweep = now;
  }

  const name = classOf(key);
  let klass = classes.get(name);
  if (!klass) {
    klass = { live: new Map(), old: new Map() };
    classes.set(name, klass);
  }

  // A hit in `live` is a field write and nothing else: no map mutation, so no
  // tombstone and no rehash on the hottest path in the system.
  const current = klass.live.get(key);
  if (current && current.resetAt > now) {
    current.count += 1;
    current.limit = limit;
    return {
      allowed: current.count <= limit,
      remaining: Math.max(0, limit - current.count),
      resetAt: current.resetAt,
    };
  }

  // A hit in the previous generation is promoted, which is what makes this
  // approximate least-recently-used rather than a fixed lifetime.
  if (!current) {
    const previous = klass.old.get(key);
    if (previous && previous.resetAt > now) {
      previous.count += 1;
      previous.limit = limit;
      klass.live.set(key, previous);
      if (klass.live.size >= CEILINGS[name]!) rotate(klass, CEILINGS[name]!, now);
      return {
        allowed: previous.count <= limit,
        remaining: Math.max(0, limit - previous.count),
        resetAt: previous.resetAt,
      };
    }
  }

  const resetAt = now + windowMs;
  klass.live.set(key, { count: 1, resetAt, limit });
  if (klass.live.size >= CEILINGS[name]!) rotate(klass, CEILINGS[name]!, now);

  return { allowed: 1 <= limit, remaining: Math.max(0, limit - 1), resetAt };
}

export function resetRateLimits(): void {
  classes.clear();
  lastSweep = Date.now();
}

/** Live key counts per class. Test and diagnostics helper. */
export function rateLimitSizes(): Record<string, number> {
  // Null-prototype, so a class named after an Object method cannot be
  // confused with the method it is named after -- the same trap classOf sits
  // next to.
  const sizes: Record<string, number> = Object.create(null) as Record<string, number>;
  for (const [name, klass] of classes) sizes[name] = klass.live.size + klass.old.size;
  return sizes;
}

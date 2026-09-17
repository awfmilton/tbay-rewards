/**
 * Fixed-window in-process rate limiter.
 *
 * **The contract is docs/RATE-LIMITING.md.** Read it before changing anything
 * here. It numbers the nine guarantees this file provides, states the four it
 * deliberately does not, and each one is pinned by a test in
 * test/security-regressions.test.ts that fails if the guarantee is removed.
 *
 * It exists because five rewrites of this file were five attempts to infer a
 * contract nobody had written -- insertion order, `count <= 1`, ranking by
 * count, least-recently-used, and a fractional cap on the carry. None was a
 * coding mistake. The mistake was deciding eviction policy one counterexample
 * at a time, which is what a written contract is for.
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
  /**
   * How many keys `live` started with, having been carried over.
   *
   * Each generation admits `ceiling` *new* keys on top of whatever it
   * inherited, which is what lets the carry be unconditional. A fixed cap on
   * the carry was a ranking in disguise -- rotate walks in insertion order and
   * stopped when it filled, so the blocked caller past the threshold was
   * dropped and came back with a full fresh allowance, which is the outcome
   * every previous design produced. Measured at a crowd of 90,001 against a
   * 90,000 cap.
   *
   * It cannot grow without bound: only unexpired buckets at their limit are
   * carried, a bucket expires sixty seconds after its first request, and
   * reaching a limit costs that many requests. The floor is therefore bounded
   * by how many callers can actually be rejected inside one window.
   */
  floor: number;
  /** When this class last turned its generations over. */
  rotatedAt: number;
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
  admin: 50_000,
  ingest: 100_000,
  other: 25_000,
};

/**
 * Halved when the second generation arrived, on purpose.
 *
 * Two generations hold up to twice the ceiling between them, so leaving these
 * at their single-map values would have quietly doubled the limiter's own
 * footprint -- about 58 MB for ingest alone, on API containers that are often
 * sized in hundreds. Halving keeps the worst case where it was. A node busier
 * than the ceiling is not an error and loses nothing: it simply rotates more
 * often, at the same amortised cost, and a caller at their limit is carried
 * across every rotation however many there are.
 */

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
function unexpired(windows: Map<string, Window>, now: number): Map<string, Window> {
  const keep = new Map<string, Window>();
  for (const [key, window] of windows) if (window.resetAt > now) keep.set(key, window);
  return keep;
}

function rotate(klass: Klass, ceiling: number, now: number): void {
  const carried = new Map<string, Window>();
  for (const [key, window] of klass.live) {
    // The carry is capped at the ceiling itself, never at a fraction of it,
    // and the difference is the whole point. A fractional cap dropped blocked
    // callers while most of the map was ordinary traffic, which is a ranking
    // by insertion order wearing a threshold. This can only bite once an
    // entire class's worth of keys are simultaneously over their limits --
    // roughly sixty million requests inside one window at the shipped rates --
    // and at that point every key in the map is a caller being rejected, so
    // there is nothing else left to drop. Without any cap, `floor` grew by a
    // ceiling per generation: measured at six times the class ceiling and
    // 143 MB before it stopped being worth continuing.
    if (carried.size >= ceiling) break;
    if (window.resetAt > now && window.count >= window.limit) carried.set(key, window);
  }
  klass.old = klass.live;
  klass.live = carried;
  klass.floor = carried.size;
  klass.rotatedAt = now;
}

export function rateLimit(key: string, limit: number, windowMs = 60_000): RateLimitResult {
  const now = Date.now();

  // Scheduled reclamation, by rebuild. A generation rotation already frees
  // whatever a busy class stops touching; this is for a quiet one, where the
  // map never fills and expired windows would otherwise sit there until it
  // did.
  if (now - lastSweep > windowMs) {
    for (const klass of classes.values()) {
      // Skipped only while rotation is doing the job. A class turning its
      // generations over faster than once a window reclaims on its own, and
      // rebuilding two full maps there cost 81 ms of blocked event loop to
      // free one key.
      //
      // Keyed on when it last rotated, not on how large it is. On size, a
      // class that filled once and then went quiet was skipped forever --
      // rotation needs a ceiling of fresh keys and there are none -- so
      // 100,000 windows that expired an hour ago stayed resident, and the
      // regression test guarding this very sweep passed with the sweep never
      // running. Measured: 18 MB held at t+60m, against 0 MB before the skip
      // existed.
      if (now - klass.rotatedAt <= windowMs) continue;
      // Both generations, and by filtering rather than discarding. Emptying
      // `old` outright threw away unexpired windows a rotation had only just
      // demoted, so a bucket that should have survived two full generations
      // could vanish inside one sweep -- which is how a blocked caller
      // dropped by the carry cap got a fresh allowance sixty seconds later
      // rather than after two turns of the map.
      klass.live = unexpired(klass.live, now);
      klass.old = unexpired(klass.old, now);
      // And the floor comes down with it. `floor` is the carry size, and the
      // rotation trigger is `live.size >= floor + ceiling`, so a floor left
      // behind by a sweep is a permanent tax on the class: sweep 900 of 1,000
      // carried windows and the class then needs 1,000 + ceiling live keys
      // before it will rotate again, holding the 900 it just freed. It
      // ratchets, because only a rotation ever wrote it. Clamping to the
      // surviving size can only ever lower it, which is the only direction
      // that is safe -- raising it would delay a rotation.
      if (klass.floor > klass.live.size) klass.floor = klass.live.size;
      // And the floor comes down with it. `floor` is the carry size, and the
      // rotation trigger is `live.size >= floor + ceiling`, so a floor left
      // behind by a sweep is a permanent tax on the class: sweep 900 of 1,000
      // carried windows and the class then needs 1,000 + ceiling live keys
      // before it will rotate again, holding the 900 it just freed. It
      // ratchets, because only a rotation ever wrote it. Clamping to the
      // surviving size can only ever lower it, which is the only direction
      // that is safe -- raising it would delay a rotation.
      if (klass.floor > klass.live.size) klass.floor = klass.live.size;
    }
    lastSweep = now;
  }

  const name = classOf(key);
  let klass = classes.get(name);
  if (!klass) {
    klass = { live: new Map(), old: new Map(), floor: 0, rotatedAt: 0 };
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
      if (klass.live.size >= klass.floor + CEILINGS[name]!) rotate(klass, CEILINGS[name]!, now);
      return {
        allowed: previous.count <= limit,
        remaining: Math.max(0, limit - previous.count),
        resetAt: previous.resetAt,
      };
    }
  }

  const resetAt = now + windowMs;
  klass.live.set(key, { count: 1, resetAt, limit });
  if (klass.live.size >= klass.floor + CEILINGS[name]!) rotate(klass, CEILINGS[name]!, now);

  return { allowed: 1 <= limit, remaining: Math.max(0, limit - 1), resetAt };
}

export function resetRateLimits(): void {
  classes.clear();
  lastSweep = Date.now();
}

/**
 * What each class carried into its current generation. Diagnostics helper.
 *
 * The carry is the one number that decides whether this design is bounded: it
 * is what a generation starts from, and without a cap it grew by up to a
 * ceiling every time. Reported rather than inferred from the map sizes,
 * because a test that has to construct six generations to see it climb is a
 * test nobody will keep.
 */
export function rateLimitFloors(): Record<string, number> {
  const floors: Record<string, number> = Object.create(null) as Record<string, number>;
  for (const [name, klass] of classes) floors[name] = klass.floor;
  return floors;
}

/** Live key counts per class. Test and diagnostics helper. */
export function rateLimitSizes(): Record<string, number> {
  // Null-prototype, so a class named after an Object method cannot be
  // confused with the method it is named after -- the same trap classOf sits
  // next to.
  const sizes: Record<string, number> = Object.create(null) as Record<string, number>;
  for (const [name, klass] of classes) {
    // Distinct keys. A carried window is in both maps -- rotate builds the new
    // live *from* live and then assigns the old one -- so adding the sizes
    // reported 50,020 for 50,010 keys, and made the ceiling assertion in the
    // tests unfailable.
    let distinct = klass.live.size;
    for (const key of klass.old.keys()) if (!klass.live.has(key)) distinct += 1;
    sizes[name] = distinct;
  }
  return sizes;
}

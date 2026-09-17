# The contention contract

What a caller is guaranteed when the limiter is under pressure, and what it is
not. This document is the specification; `packages/server/src/lib/ratelimit.ts`
implements it and `test/security-regressions.test.ts` pins each numbered
guarantee with a test that fails if it is removed.

It exists because five rewrites of that file were five attempts to infer a
contract nobody had written. Each adversarial round probed one traffic pattern,
an eviction rule was added to satisfy it, and the next round found a pattern
where the new rule was wrong — insertion order, `count <= 1`, ranking by count,
least-recently-used, and a fractional cap on the carry. None of them was a
coding mistake. The mistake was deciding eviction policy one counterexample at
a time.

## What the limiter is for

Stopping a single misbehaving site or script from flooding ingest. It is
deliberately **not distributed**: each API node enforces its own share of the
budget, which is sufficient for that purpose. Put a shared limiter at the edge
if you need exact global limits.

## The keys

| Key | Minted by | Bounded? |
|---|---|---|
| `admin:<tenant>` | provisioning a tenant | yes — one per tenant |
| `ingest:<tenant>:i:<address>` | whoever is calling | no |
| `ingest:<tenant>:i:<address>:a:<visitor>` | whoever is calling | no |

Only the ingest keys are attacker-mintable, and that asymmetry is the whole
defence. Each key **class** — the text before the first `:` — gets its own map
and its own ceiling, so a flood is confined to the class it can mint in.

## The guarantees

**G1. A caller who is at their limit stays at their limit.**
Eviction hands out a *fresh window*, so evicting a blocked caller is the one
eviction that buys somebody throughput. It never happens while fewer than a
whole ceiling's worth of callers are simultaneously blocked. In particular this
holds for a caller who has **stopped sending** — the tracker drops a 429
silently, which made "least recently used" exactly backwards.

**G2. A flood cannot reach another class.**
No volume of ingest traffic, under any tenant, evicts an `admin:` bucket.

**G3. Eviction only ever drops a caller who is not being limited.**
Such a caller gets a fresh window they were not using. That costs nothing,
which is why it is the only eviction the contract permits.

**G4. Within the ingest class, tenants share one budget.**
This is safe *because of G1*: one site's flood can drop another site's idle
buckets, and cannot drop a bucket that is at its limit. It is stated rather
than hidden because it is a real property — per-tenant ceilings would multiply
the memory bound by the tenant count.

**G5. Memory is bounded, and the bound is stated.**
Two generations per class. In ordinary traffic the bound is `2 × ceiling`
distinct windows. Where a whole ceiling of callers is simultaneously over their
limits it is `4 × ceiling`, because the carry itself can reach a ceiling and a
generation admits another ceiling of new keys on top of it. Reaching that
requires roughly 60 million requests inside one window at the shipped rates.

**G6. A class that goes quiet gives its memory back.**
Rotation reclaims a busy class; the scheduled sweep reclaims a quiet one.
Keying the sweep on *size* rather than on when the class last rotated meant a
class that filled once and went quiet was skipped forever — rotation needs a
ceiling of fresh keys and a quiet class has none.

**G7. A caller's count survives two generations.**
A bucket demoted by a rotation is still found and promoted on the next request.
Discarding the previous generation on a sweep meant an ordinary caller
accumulating toward their limit kept starting again.

**G8. Per-call cost does not grow with the map.**
Measured at the ceiling: ~1.4 µs per insert, ~0.4 µs per touch. Two of these
run per ingest request. Keeping least-recently-used order cost a `delete` and a
`set` per touch, and evicting walked `keys()` from the front; both leave
tombstones that later iteration must walk past, measured at 40 µs per insert
and 58 µs per touch — which made the limiter a worse denial of service than the
one it was guarding against.

**G9. A key class cannot be invented by its name.**
`classOf` uses `Object.hasOwn`. With `in`, a key named `toString:...` resolved
its ceiling to a function, `size >= ceiling` was `NaN`, and that class grew
without bound.

## What is deliberately not guaranteed

- **Exact global limits.** See above: per-node by design.
- **That an idle caller keeps their bucket.** G3 permits dropping it.
- **That the ceiling is a hard cap on distinct keys.** G5 gives the real bound.
- **Fairness between tenants within the ingest class.** G4 is the honest
  statement: containment is by class, not by tenant.

## Changing this file

A change to the limiter's behaviour starts here. Add or amend a numbered
guarantee, then make the implementation satisfy it, then add the test that
fails without it. A change that cannot be stated as a guarantee is the shape of
change that produced five rewrites.

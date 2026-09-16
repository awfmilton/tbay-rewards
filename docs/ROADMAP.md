# What is built, and what is not

Three independent reviews read this platform against its two predecessors —
myCred 2.6.3 and Mautic 7.2 — and against a seeded load test. This file tracks
what they found.

Most of it is now built. What remains is listed below with why it is open and
what it would take.

The bugs those reviews found are all fixed; see the commit history for
`unsubscribe consent`, `lock ordering`, `coupon min_balance` and
`reconcileClaims`.

---

## Closed since the reviews

| Gap | What exists now |
|---|---|
| **Dynamic segments** | A filter tree over 24 fields compiled to SQL with every value bound, relative dates in the tenant's timezone, materialised by a worker. `docs/API.md` |
| **Audience broadcasts** | Resumable with a cursor, per-recipient idempotent, frequency capped, consent and suppression re-checked as the audience is walked |
| **Email open and click tracking** | Link rewriting through the existing redirect and an open pixel; scanner hits counted separately, since privacy proxies prefetch every pixel |
| **Bounce and complaint handling** | Conservative SMTP classification, an address-keyed suppression list, and RFC 8058 one-click `List-Unsubscribe` |
| **Campaign delays and branching** | Automations are resumable step sequences: waits, branches evaluated against live data, gotos, and per-run step caps |
| **Contact timeline** | One endpoint merging eleven sources, each limited before the union so a noisy source cannot crowd out a rare one |
| **WordPress admin screens** | Six screens: customers, ledger, earning rules, badges and ranks, segments and sends, email |
| **Counter write amplification** | In-process buffering flushed on a timer, off the request path entirely |
| **myCred control surfaces** | Exclusions, per-product overrides, weekly/monthly caps, per-award clamps, badge and rank CRUD, manual rank pinning, coupon balance bands and grants |

---

## Still open

### Multiple point types

One ledger per tenant, no `point_type` column. Store credit and the TBAY token
are separate stores of value, but there is no second *earn-and-spend* currency
with its own rules, ranks and leaderboard.

This is the largest remaining myCred gap and it touches every table that
references points. Worth doing when a retailer asks for it, not before.

### Earning hooks beyond commerce

Points come from orders, opt-ins, shares, referrals, accounts and reviews.
myCred also awards for comments, viewing or publishing content, video watching
and arbitrary link clicks, and integrates with fifteen third-party plugins.

The one worth adding for a WordPress store is **form submissions** — Ninja
Forms, Gravity, Contact Form 7 — because the sites this ships to use them. The
rest are fair to leave out.

### buyCRED and a points checkout gateway

Points cannot be spent directly at checkout; spending goes through the TBAY
store-credit round trip. Buying points for money is absent entirely.

### Log history import

The myCred importer brings balances and badge keys with one opening ledger
entry per member. Per-entry history does not come across, so a migrated store
starts with a correct balance and an empty history. Documented in
`docs/MIGRATION.md`.

### Deliberately omitted, and staying omitted

Forms, landing pages, A/B tests, SMS, web push, stages, dynamic web content,
assets, the integrations framework, and users/roles/SSO. A WooCommerce store
has forms and pages from WordPress; signed webhooks cover Zapier-shaped needs.

Two are worth revisiting when there is demand: **exit-intent capture**, a
mainstream list-growth tool, and **SMS cart recovery**, which converts well.

---

## On scale

The load review seeded a scratch database — 1M events, 300k sessions, 300k
ledger rows, 200k carts — and ran `EXPLAIN (ANALYZE, BUFFERS)` over every hot
query. Its critical findings are fixed: the rate-limiter scope, two lock-order
deadlocks, twelve missing indexes, pool timeouts, the reconcile starvation and
the counter write amplification.

What that leaves:

| Scale | Load | What it needs |
|---|---|---|
| **1×** ≈100 concurrent visitors | ~12 batches/s | What is built. A 2 vCPU VPS is fine. |
| **10×** | ~125 batches/s, ~7 MB/s WAL before buffering | Partition `events` by month with 90-day retention. Do it while the table is small: the primary key has to become `(id, occurred_at)`, which is cheap now and painful later. No new infrastructure. |
| **100×** | ~1,250 batches/s | PgBouncer in transaction mode, a read replica for reports, Redis for a shared rate limiter, and `events` on a TimescaleDB hypertable with compression. |
| **1000×** | ~12.5k batches/s | A stream between ingest and storage, ClickHouse for events and heatmap cells. Postgres keeps tenancy, contacts, carts, the ledger and token tables. |

### The stack

No measured bottleneck was language-bound: one Node process pushed 314
batches/s through the *unoptimised* design. TypeScript, Fastify and Postgres
stay.

The one component worth swapping, and not before roughly 100× load, is the
*events* store. TimescaleDB is a drop-in with the same driver and SQL. **The
ledger never moves** — it needs row locks, unique idempotency keys and real
transactions, which is exactly what Postgres is for.

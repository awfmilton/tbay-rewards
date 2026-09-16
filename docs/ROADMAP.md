# What is not built yet

Three independent reviews read this platform against its two predecessors and
against a seeded load test. This is what they found that is still open, why it
is open, and what it would take.

Nothing here is a bug. The bugs they found are fixed; see the commit history
for `unsubscribe consent`, `lock ordering`, `coupon min_balance` and
`reconcileClaims`.

---

## From the Mautic 7.2 review

Read: the campaign bundle, segment filters, email model, tracking, DNC
handling, reports and the plugin bundles.

### 1. Dynamic segments — not built

Contacts carry `tags` and `attributes`, and the newsletter selects an audience
by list membership plus consent. There is no way to express "customers who
ordered in the last 90 days and are not tagged vip".

Mautic has 22 operators over roughly 45 filter families with relative dates in
the contact's timezone, and a batched rebuild job.

**What it needs:** a `segments` table holding a filter tree, a query compiler,
and a membership rebuild worker. Large but well understood.

### 2. Audience broadcasts — not built

Every email the platform sends is triggered by one contact's own action: an
opt-in confirmation, a cart recovery, an automation. There is no "send this to
that segment on Tuesday".

**Blocked on segments.** Adding broadcasts first would mean sending to lists,
which is the thing segments exist to replace.

### 3. Open and click tracking — not built

Nothing rewrites links in outgoing email, and there is no open pixel. So there
is no engagement signal for automations, no win-back on "opened but did not
buy", and email clicks do not identify an anonymous visitor.

**Worth noting:** the `/r/:code` redirect and click-recording machinery already
exists for writer links. Applying it to outgoing email HTML is a smaller job
than it sounds, and it is the highest-value item on this list.

### 4. Bounce and complaint processing — not built

`subscriptions.status` allows `bounced` and `complained` and nothing ever sets
them. There is also no `List-Unsubscribe` header, which Gmail and Yahoo require
of bulk senders — that becomes blocking the day broadcasts ship, not before.

### 5. Campaign delays and branching — not built

An automation is one trigger, an AND list of conditions, and a linear list of
actions, run once immediately. Mautic has a branching canvas with per-event
delays, absolute dates, send-hour windows and days-of-week in the contact's
timezone, plus decisions that wait for a subsequent behaviour.

This is why cart recovery is a hand-written worker with its stages in
environment variables rather than an automation. Anything with the same shape —
a welcome series, a post-purchase review request, a replenishment nudge — is
currently not expressible.

**What it needs:** `run_at` on `automation_runs`, a scheduler, and a `wait`
action. The engine is otherwise close.

### 6. Contact timeline — not built

Sessions, events, orders, carts, emails and automation runs are all stored per
contact, and there is no endpoint that shows them together. Support answering
"what happened to this customer" has to query several places.

### 7. Deliberately omitted, and staying omitted

Forms, landing pages, A/B tests, SMS, web push, stages, dynamic web content,
assets, the integrations framework, and users/roles/SSO. A WooCommerce store
has forms and pages from WordPress; signed webhooks cover Zapier-shaped needs.

The two worth revisiting: **exit-intent capture**, which is a mainstream list
growth tool, and **SMS cart recovery**, which converts well.

---

## From the myCred 2.6.3 review

Read: the hook abstract, all core and external hooks, every addon, the
shortcodes, widgets and query classes.

Most of what it found is now built. What is not:

### 8. Multiple point types — not built

One ledger per tenant, no `point_type` column. Store credit and the TBAY token
are separate stores of value, but there is no second *earn-and-spend* currency
with its own rules, ranks and leaderboard.

This is the largest remaining myCred gap and it touches every table that
references points. Worth doing only if a retailer actually asks.

### 9. Earning hooks beyond commerce — partly built

Points come from orders, opt-ins, shares, referrals, accounts and now reviews.
myCred also awards for comments, viewing or publishing content, video watching
and arbitrary link clicks, and integrates with 15 third-party plugins.

Worth adding for a WordPress store: **form submissions** (Ninja Forms, Gravity,
Contact Form 7), since the sites this ships to use them. The rest are fair to
leave out.

### 10. No WordPress admin screens — not built

Everything new is an API endpoint behind the tenant's secret key: exclusions,
product rules, badge and rank CRUD, ledger search, template editing. There is
no wp-admin UI for any of it, so support cannot look up a customer's history or
adjust a balance without an API client.

**This is the most valuable thing left on either list.** The capability exists;
only the screens are missing.

### 11. buyCRED and a points checkout gateway — not built

Points cannot be spent directly at checkout; spending goes through the TBAY
store-credit round trip. Buying points for money is absent entirely.

### 12. Log history import — not built

The myCred importer brings balances and badge keys, with one opening ledger
entry per member. Per-entry history does not come across, so a migrated store
starts with a correct balance and an empty history. Documented in
`docs/MIGRATION.md`.

---

## From the load review

Seeded a scratch database (1M events, 300k sessions, 300k ledger rows, 200k
carts) and ran `EXPLAIN (ANALYZE, BUFFERS)` over every hot query. Its critical
findings — the rate-limiter scope, the two deadlocks, twelve missing indexes,
pool timeouts and the reconcile starvation — are fixed.

What remains is one structural item:

### 13. Counter writes still go through the request transaction

Each heatmap cell increment is a full MVCC update: measured 370 bytes of WAL
and one dead tuple per cell, with a 0% HOT ratio before the fillfactor change.
A realistic batch touches ~142 cells. At 1,000 concurrent visitors that is
roughly 19k row-versions per second from heatmaps alone.

**The fix, when it is needed:** buffer `heatmap_cells`, `heatmap_pages` and
`product_stats` in process, flushed every 2-5 seconds as one sorted
multi-row upsert per table. The write rate then becomes *distinct active cells
per interval* instead of *visitors × samples* — a thousand visitors on one page
collapse to one update per cell. The review measured this as worth 50-100×
fewer row-versions.

The cost is up to five seconds of counters lost on a crash. That is acceptable
for analytics and must never be applied to the ledger.

**When:** at roughly 10× current load. The fillfactor and lock-ordering changes
already shipped buy the headroom to get there.

### On the stack

The review's verdict was that no measured bottleneck is language-bound: one
Node process pushed 314 batches/s through the current design. TypeScript,
Fastify and Postgres stay.

The one component worth swapping, and not before roughly 100× load, is the
*events* store — TimescaleDB is a drop-in with the same driver and SQL, and
gives compression and retention policies. The ledger never moves.

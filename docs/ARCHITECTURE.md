# Architecture

## The shape of it

```
   Browser (any site)                     WordPress / WooCommerce
   ┌──────────────────┐                   ┌──────────────────────┐
   │ tbay.js tracker  │                   │  TBAY Rewards plugin │
   │  site key only   │                   │  site key + secret   │
   └────────┬─────────┘                   └──────────┬───────────┘
            │ POST /v1/collect                       │ server-to-server
            │ (ingest writes only)                   │ (orders, points, tokens)
            ▼                                        ▼
   ┌─────────────────────────────────────────────────────────────┐
   │                      TBAY Rewards API                       │
   │                                                             │
   │  routes/     collect · redirect · api · reports ·           │
   │              gamification · health                          │
   │  services/   ingest · heatmap · products · carts ·          │
   │              contacts · newsletter · automations ·          │
   │              links · commissions · points · rewards ·       │
   │              gamification · token · bridge · analytics      │
   │  workers/    email · cart recovery · point release ·        │
   │              commission release · claim expiry ·            │
   │              claim reconcile · webhooks                     │
   └───────────┬─────────────────────────────────┬───────────────┘
               │                                 │
               ▼                                 ▼
        ┌─────────────┐                  ┌────────────────┐
        │  Postgres   │                  │  zkSync Era    │
        │ (all state) │                  │  TBAY L2       │
        └─────────────┘                  └────────────────┘
```

Two trust levels, and the split is the backbone of the security model:

- **Site key** (`tbp_…`) is public, sits in page source, and can only *write*
  first-party analytics — events, carts, newsletter signups. It cannot read a
  report, see another visitor, or move a single point.
- **API secret** (`tbs_…`) is server-to-server, stored hashed, and can do
  everything else.

---

## Data model

Every customer-facing table is tenant-scoped. One deliberate exception:

### `members` — the cross-retailer identity

TBAY spends at any retailer, so one person needs one balance-bearing identity
across all of them. `members` is that identity, keyed on a wallet address and/or
a platform-salted hash of the email.

The hash is salted platform-wide rather than per tenant, which is exactly what
lets retailer B recognise the same person as retailer A — **without** ever
sharing A's plaintext email address. `contacts` stay tenant-scoped and hold the
actual PII; `member_id` is the thread between them.

### Core groups

| Group | Tables |
|---|---|
| Tenancy | `tenants`, `tenant_keys`, `tenant_domains` |
| Identity | `members`, `contacts`, `visitors`, `sessions` |
| Behaviour | `events`, `heatmap_cells`, `heatmap_pages`, `touchpoints` |
| Commerce | `products`, `product_stats`, `carts`, `orders` |
| Attribution | `links`, `link_clicks`, `commissions` |
| Messaging | `lists`, `subscriptions`, `email_templates`, `email_messages` |
| Automation | `automations`, `automation_runs`, `webhooks`, `webhook_deliveries` |
| Rewards | `reward_rules`, `points_ledger`, `points_balances`, `share_events`, `referrals` |
| Gamification | `badges`, `badge_awards`, `ranks`, `rank_awards`, `streaks`, `point_transfers`, `point_coupons`, `coupon_redemptions`, `content_unlocks`, `notifications` |
| Token | `token_claims`, `token_mint_windows`, `token_supply_budget`, `token_spend_intents`, `store_credits`, `bridge_withdrawals` |

---

## Decisions worth knowing

### The points ledger is append-only

`points_ledger` is the source of truth and is never mutated in place. Corrections
are compensating entries, so history stays auditable — which matters when the
thing being tracked converts into a real crypto asset.

`points_balances` is a cache, written in the *same transaction* as the ledger
entry, so a balance can never drift from its ledger. Debits take a row lock, so
two concurrent redemptions cannot both see the same balance and overspend it.

Every entry carries a tenant-unique idempotency key. Retrying a webhook, a worker
pass or a double-clicked form can never book the same thing twice.

### Heatmaps are aggregated at write time

Raw pointer traces are never stored — they are re-identifying, and they grow
without bound. The tracker normalises each sample to 0–1 of document width and
height; the server bins them into a 100 × 200 grid per (page, device, kind) and
increments counters.

A page costs at most 20,000 rows per device class no matter how much traffic it
gets, and the grid is resolution-independent, so a phone and a 4K monitor
contribute to the same map correctly.

### Sessionisation happens in the browser

The tracker owns session identity — it knows about tab focus and the idle
timeout, and the server does not. The server trusts the session id and
reconstructs the acquisition context on first sight.

A touchpoint is recorded once per session, never per pageview, so internal
navigation can't overwrite the original source.

### Social sharing pays on clicks, not intent

Clicking a share button proves nothing: the post may never happen. So a share
mints a unique tracked link and stays *pending* until somebody else actually
clicks it. Faking shares is therefore worthless — you would have to generate real
referred traffic to earn anything.

### An automation is a resumable sequence, not a single pass

Trigger → conditions → a list of *steps*, where a step is an action or one of
`wait`, `if`, `goto`, `stop`. The action list is flat and `step_index` is the
program counter, so the entire state of a paused sequence is one row — which is
what makes it survive a restart.

It started as a single pass, and that was wrong for the obvious case: "send the
cart email, wait a day, and if they still have not bought, send another" could
not be expressed, which is exactly why cart recovery had to be a hand-written
worker with its stages in environment variables. A welcome series, a review
request and a win-back all have that shape.

The property to hold on to: **a condition after a wait is evaluated against
live data**, not the frozen trigger payload. "If they still have not bought" is
a question about now; answering it from a day-old snapshot sends the follow-up
to everyone who did buy. The `if` step reuses the segment filter compiler, so it
can ask anything a segment can and there is one field catalogue rather than two
that drift.

Every run is still idempotent through a dedupe key, and every *step* now
contributes to the keys its actions write — without that, a sequence holding two
`award_points` steps would give them the same key and silently drop the second.

### Segments define who; consent decides whether

A segment is a filter tree compiled to SQL, materialised by a worker. Consent
and suppression are applied when an *audience is read*, never in the definition.

That split is deliberate. A segment answers "who are these people"; consent
answers "may we mail them". Folding the second into the first means every
segment an admin builds has to remember the rule, and the one that forgets mails
people who opted out.

The compiler's own rule: no value from a definition ever reaches the SQL string.
Fields come from a closed catalogue, operators from a per-type allow-list, and
every value is bound. A definition is admin-supplied data that gets stored and
replayed later, so treating it as trusted would be a stored injection with a
delay fuse — and a catalogue that allowed arbitrary columns would turn a
settings screen into an arbitrary read over the whole schema.

### Analytics counters are eventually consistent; the ledger is not

Heatmap cells, page rollups and product stats are folded in memory and flushed
on a timer. A load review measured each increment as a full MVCC update — 370
bytes of WAL and a dead tuple — and buffering changes what the write rate is
proportional to: not visitors × samples, but distinct active cells per interval.

The boundary matters more than the technique. The points ledger, balances,
orders and token claims keep writing synchronously inside their transaction,
because the cost of buffering is losing up to one interval on a crash. An
approximate heatmap weight is fine. An approximate balance is not.

### The platform never custodies tokens (in mint mode)

It signs vouchers; customers submit them and pay the gas. There is no hot wallet
on the redemption path and nothing to drain. `treasury` mode trades that for a
non-inflationary supply and is opt-in.

---

## Request lifecycles

### Tracker batch

```
POST /v1/collect  (site key)
  └─ one transaction:
       upsert visitor
       resolve or open session  → new session records a touchpoint
       insert events            → bot traffic stops here
       aggregate heatmap cells
       roll up product stats
       upsert cart
```

All or nothing, so a retried batch can never leave half-counted statistics.

### Order

```
POST /v1/orders  (API secret)
  └─ one transaction:
       upsert contact
       snapshot first/last touch
       upsert order              → idempotent on (tenant, order_ref)
       roll up product purchases
       close out the cart
       accrue writer commission  → holds for the refund window
       award purchase points     → held through the same window
       qualify any referral
  └─ then: fire order.completed automations
```

### Redemption

Covered in [TOKEN.md](TOKEN.md).

---

## Background jobs

| Job | Every | What it does |
|---|---|---|
| `email_queue` | 15s | Sends queued mail, backs off, gives up after 5 tries |
| `cart_recovery` | 60s | Marks quiet carts abandoned, queues the due recovery stage |
| `points_release` | 60s | Matures held points into spendable balance |
| `commission_release` | 5m | Approves commissions past their refund hold |
| `share_expiry` | 5m | Closes shares nobody clicked |
| `claim_expiry` | 60s | Expires unclaimed vouchers, refunds points, frees budget |
| `claim_reconcile` | 2m | Asks the chain which vouchers were actually claimed |
| `webhook_delivery` | 20s | Delivers signed webhooks with exponential backoff |
| `challenge_purge` | 1h | Drops expired wallet-ownership challenges |
| `segment_build` | 10m | Recomputes segment membership differentially |
| `broadcast_send` | 30s | Advances a scheduled or in-flight broadcast one batch |
| `automation_resume` | 30s | Resumes sequences whose wait has elapsed |
| `counter_flush` | 10s | Safety net for the in-process counter buffer |

Every job claims work with `FOR UPDATE SKIP LOCKED` or a unique key, so they are
safe to run on several nodes. They run in-process by default and as a separate
container under Docker.

---

## Scaling notes

The API is stateless — scale it horizontally behind any load balancer. Run
exactly one worker container (more is safe, just unnecessary).

`events` is the table that grows fastest. It is indexed for the queries the
reports actually run; at high volume, partition it by month and drop old
partitions. The heatmap, product and daily-rollup tables are pre-aggregated and
do not grow with traffic.

Rate limiting is per-process and deliberately approximate — it exists to stop one
misbehaving site flooding ingest. Put a shared limiter at the edge if you need
exact global limits.

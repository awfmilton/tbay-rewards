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

### Automations are deliberately small

Trigger → conditions → actions, evaluated in a single pass. Mautic's campaign
canvas is what this replaces, and nearly all real-world use is "when X happens to
a contact, check a couple of facts, then email or tag them". Keeping the model
this small means there is no scheduler state to get stuck in, and every run is
idempotent through a dedupe key.

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

# API reference

Base URL: your `PUBLIC_URL`, e.g. `https://rewards.example.com`.

## Authentication

| Scope | Header | Can do |
|---|---|---|
| **Public** | `X-TBAY-Key: tbp_…` | Write ingest data only |
| **Secret** | `Authorization: Bearer tbs_….…` | Everything else, for one tenant |
| **Operator** | `X-TBAY-Operator: …` | Record L1 bridge releases |

Errors are `{ "error": "code", "message": "…", "details": … }` with a matching
HTTP status: `400` bad request, `401` unauthorized, `403` forbidden, `404` not
found, `409` conflict, `422` unprocessable, `429` rate limited.

Most endpoints accept a contact by any of `contactId`, `email` or `externalRef`.

---

## Public (site key)

### `POST /v1/collect`
The tracker batch. Responds `204`.

```json
{
  "visitor": "…", "session": "…",
  "url": "https://shop.example/product/flag",
  "referrer": "https://x.com/…",
  "events": [
    { "type": "pageview" },
    { "type": "product_view", "productRef": "42",
      "product": { "name": "Red Ensign", "priceCents": 4999 } },
    { "type": "add_to_cart", "productRef": "42", "valueCents": 4999 }
  ],
  "heatmap": [
    { "page": "https://shop.example/product/flag", "kind": "click",
      "samples": [{ "x": 0.5, "y": 0.3 }], "docHeight": 3000, "viewportWidth": 1440 }
  ],
  "cart": {
    "cartToken": "guest-abc",
    "items": [{ "productRef": "42", "quantity": 1, "priceCents": 4999 }]
  }
}
```

Heatmap `x`/`y` are 0–1 fractions of document width and height. Event types:
`pageview`, `click`, `product_view`, `product_click`, `add_to_cart`,
`remove_from_cart`, `begin_checkout`, `search`, `blog_link_click`, `share_click`,
`form_submit`, `custom`.

### `GET /v1/collect?d=<base64url-json>`
Same payload for environments that block POST beacons. Returns a 1×1 GIF.

### `POST /v1/identify`
Attach an identity to the current visitor, keeping earlier anonymous attribution.

### `POST /v1/newsletter/subscribe`
`{ email, name?, list?, source?, visitor? }` → `{ status, contact_id }`.
`status` is `pending`, `subscribed` or `already_subscribed`.

### `GET /v1/config`
Chain ids, contract addresses, `wallet_addEthereumChain` parameters, the thirdweb
client id and the effective conversion rates.

---

## Human-facing (no auth)

| Route | Purpose |
|---|---|
| `GET /r/:code` | Trackable-link redirect; records the click, sets attribution |
| `GET /n/confirm/:token` | Confirms a double opt-in |
| `GET /n/unsubscribe/:token` | One-click unsubscribe |
| `GET /n/unsubscribe-request` | Unsubscribe by address, for automation mail |
| `GET /c/:token` | Cart recovery link back to checkout |
| `GET /health` | Liveness and configuration |
| `GET /tbay.js` | The tracker script |

---

## Commerce (secret)

### `POST /v1/orders`
Idempotent on `(tenant, orderRef)`.

```json
{
  "orderRef": "wc-1001", "totalCents": 4999, "subtotalCents": 4999,
  "currency": "CAD", "email": "buyer@example.com",
  "items": [{ "productRef": "42", "quantity": 1, "subtotalCents": 4999 }],
  "cartToken": "guest-abc", "visitorAnonId": "…", "linkCode": "MAPLE4K7Q"
}
```

→ `{ order_id, contact_id, points_awarded, commissions[] }`

### `POST /v1/orders/:orderRef/refund`
Voids commissions and reverses purchase points.

---

## Contacts and newsletter (secret)

| Route | Purpose |
|---|---|
| `POST /v1/contacts` | Create or merge a contact |
| `GET /v1/contacts/lookup` | Contact plus points balance |
| `POST /v1/wallet/challenge` | Issue a message for the holder to sign |
| `POST /v1/contacts/wallet` | Verify the signature and bind the wallet |
| `POST /v1/newsletter/subscriptions` | Server-side subscribe |
| `POST /v1/newsletter/unsubscribe` | Unsubscribe by email |
| `GET /v1/newsletter/lists` | Per-list subscriber counts |

---

## Links and commissions (secret)

| Route | Purpose |
|---|---|
| `POST /v1/links` | Mint a trackable link (`campaign`, `writer`, `referral`, `share`) |
| `GET /v1/links` | List links |
| `GET /v1/links/report` | Clicks, orders and earnings per link |
| `GET /v1/commissions` | One writer's commissions and summary |
| `POST /v1/commissions/pay` | Mark approved commissions paid |

---

## Rewards (secret)

| Route | Purpose |
|---|---|
| `GET` / `PUT /v1/rewards/rules` | Read and configure reward rules |
| `POST /v1/rewards/trigger` | Apply a rule to a contact |
| `GET /v1/rewards/balance` | Balance, conversion quote, recent ledger |
| `GET /v1/rewards/leaderboard` | Top earners |
| `POST` / `GET /v1/shares` | Create a share link; list shares |

`POST /v1/rewards/trigger` returns `{ awarded: false, reason }` rather than
failing when a cap or cooldown declines the award. Reasons: `rule_missing`,
`rule_disabled`, `cooldown`, `daily_cap`, `lifetime_cap`, `zero_points`.

---

## Gamification (secret)

| Route | Purpose |
|---|---|
| `GET /v1/gamification/profile` | Rank, badges, streaks, unread count |
| `GET /v1/gamification/badges` | Badges with per-member progress |
| `GET /v1/gamification/ranks` | Rank ladder |
| `POST /v1/gamification/evaluate` | Re-run badge and rank evaluation |
| `POST /v1/gamification/badges/award` | Grant a badge manually |
| `POST /v1/gamification/streak` | Record a day of activity |
| `POST /v1/gamification/transfer` | Move points between members |
| `POST /v1/gamification/coupons` | Create a coupon |
| `POST /v1/gamification/coupons/redeem` | Redeem a coupon |
| `POST /v1/gamification/content/unlock` | Spend points to unlock content |
| `GET /v1/gamification/content/access` | Check access |
| `GET /v1/gamification/notifications` | List notifications |
| `POST /v1/gamification/notifications/read` | Mark read |

---

## Token (secret)

### Linking a wallet

Two steps, because a wallet address supplied in a request is a claim, not proof.

```
POST /v1/wallet/challenge { contactId, walletAddress }
  → { nonce, message, expires_at }

# the holder signs `message` with personal_sign

POST /v1/contacts/wallet { contactId, nonce, message, signature }
  → { wallet_address, wallet_verified: true }
```

The challenge is single-use, expires in ten minutes and is scoped to the
contact it was issued for. **Redemption, spending and bridging all require a
verified wallet** and always pay out to that address — never to one named in the
request.

### `POST /v1/token/redeem`
`{ contactId, points }` — the destination is the verified wallet →

```json
{
  "claim_id": "…", "status": "signed", "expires_at": "…",
  "points_spent": 500, "balance": { "balance": 0, "pending": 0 },
  "delivery": "wallet_claim",
  "transaction": {
    "chainId": 300,
    "contractAddress": "0x74eb…",
    "method": "claim",
    "args": { "amount": "5000000000000000000", "nonce": "…", "signature": "0x…" },
    "amountTokens": "5"
  }
}
```

In treasury mode `delivery` is `treasury_transfer`, `transaction` is `null` and
`txHash` carries the completed transfer.

| Route | Purpose |
|---|---|
| `POST /v1/token/claims/:id/tx` | Report the submitted transaction hash |
| `GET /v1/token/claims/outstanding` | Vouchers the member can still submit |
| `GET /v1/token/claims` | A member's claim history |
| `POST /v1/token/spend` | Open a spend intent; returns the payout wallet |
| `POST /v1/token/spend/:id/verify` | Verify the transfer, issue store credit |
| `POST /v1/token/credit/redeem` | Burn a store credit against an order |

---

## Bridge

| Route | Auth | Purpose |
|---|---|---|
| `POST /v1/bridge/quote` | secret | What will cross, and what is dust |
| `POST /v1/bridge/withdrawals` | secret | Submit a burn for verification |
| `GET /v1/bridge/withdrawals` | secret | List withdrawals |
| `GET /v1/bridge/withdrawals/:id` | secret | One withdrawal |
| `POST /v1/bridge/withdrawals/:id/release` | **operator** | Record the L1 release |
| `POST /v1/bridge/withdrawals/:id/reject` | **operator** | Reject a withdrawal |

---

## Reports (secret)

All accept `from`, `to` (ISO 8601) and `limit`; the default window is 30 days.

| Route | Returns |
|---|---|
| `GET /v1/reports/overview` | Headline metrics plus a daily series |
| `GET /v1/reports/sources` | Traffic sources with last-touch revenue |
| `GET /v1/reports/pages` | Top pages |
| `GET /v1/reports/products` | Product engagement (`metric=` to rank) |
| `GET /v1/reports/carts` | Abandonment and recovery rates |
| `GET /v1/reports/blog-links` | Writer link performance |
| `GET /v1/reports/rewards` | Points, claims and shares |
| `GET /v1/reports/heatmap/pages` | Pages with heatmap data |
| `GET /v1/reports/heatmap` | Grid cells for one page (`page`, `device`, `kind`) |

Heatmap responses give `xBins` (100), `yBins` (200), `maxWeight` and the
populated cells — enough to render without transferring the empty grid.

---

## Outbound webhooks

Deliveries are signed:

```
X-TBAY-Topic: points_awarded
X-TBAY-Timestamp: 1730000000
X-TBAY-Signature: sha256=<hmac(secret, "<timestamp>.<body>")>
```

Verify the HMAC **and** reject timestamps older than a few minutes — the
timestamp is inside the signed material precisely so a captured delivery cannot
be replayed later.

---

## Admin endpoints

Added after a parity review against myCred and Mautic found several tables
reachable only by writing SQL. All of these take the tenant's **secret** key,
never the public site key.

### Email templates

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/v1/email/templates` | Every template, built-in and overridden |
| `GET` | `/v1/email/templates/:key` | One template's current content |
| `PUT` | `/v1/email/templates/:key` | Override it |
| `DELETE` | `/v1/email/templates/:key` | Revert to the built-in |

`PUT` takes `{ subject, html, text?, transactional? }`.

`transactional` decides whether the message needs marketing consent. A receipt
for something the person just did — the points their order earned — is
transactional; anything they did not ask for is not, and stays consent-gated.
It defaults to `false`, so opting a template out of consent is always a
deliberate act. Where the line sits legally is the retailer's call, which is
why this is a switch rather than a hardcoded list.

### Who does not earn

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/v1/rewards/exclusions` | List |
| `POST` | `/v1/rewards/exclusions` | `{ kind, value, note? }` |
| `DELETE` | `/v1/rewards/exclusions/:id` | Remove |

`kind` is one of `contact`, `email`, `email_domain`, `role` or `tag`. Values are
lower-cased on write, so matching never depends on how it was typed. `role`
matches WordPress roles the plugin syncs into `attributes.roles`.

Exclusion suppresses **earning only**. An excluded contact is still tracked,
still receives email, and keeps whatever balance they already had — voiding
history retroactively would be worse than never awarding.

### Per-product point overrides

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/v1/rewards/product-rules?ruleKey=` | List |
| `POST` | `/v1/rewards/product-rules` | Create or update |
| `DELETE` | `/v1/rewards/product-rules/:id` | Remove |

```jsonc
{
  "ruleKey": "purchase",        // defaults to purchase
  "matchKind": "product",       // or "category"
  "matchValue": "gift-card",
  "mode": "exclude",            // or "multiplier" / "fixed"
  "multiplier": 2,              // mode: multiplier — scales the line's value
  "points": 5                   // mode: fixed — points per unit sold
}
```

A product rule beats a category rule, and `exclude` beats everything. Lines
with no match earn the rule's base rate, so a tenant that configures nothing
behaves exactly as before.

Send `categoryRefs` on order items for category rules to have anything to match.

### Badges and ranks

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/v1/gamification/badges/admin` | Every badge, including disabled |
| `PUT` | `/v1/gamification/badges/:key` | Create or update |
| `DELETE` | `/v1/gamification/badges/:key` | Remove |
| `POST` | `/v1/gamification/badges/:key/revoke` | Take one back |
| `GET` | `/v1/gamification/ranks/admin` | Every rank |
| `PUT` | `/v1/gamification/ranks/:key` | Create or update |
| `DELETE` | `/v1/gamification/ranks/:key` | Remove |
| `POST` | `/v1/gamification/ranks/assign` | Pin a member to a rank |
| `POST` | `/v1/gamification/ranks/unassign` | Release the pin and recompute |
| `POST` | `/v1/gamification/reevaluate` | Recompute everyone |

Badge criteria may be a single measure or a compound:

```jsonc
{
  "type": "compound",
  "compare": "and",             // or "or"
  "requires": [
    { "type": "lifetime_points", "threshold": 500 },
    { "type": "order_count", "threshold": 3 }
  ]
}
```

`and` measures 1 when every requirement is met, so a single tier at threshold 1
is the myCred behaviour. `or` measures *how many* are met, so tiers can award
"any one of these" at 1 and "all three" at 3.

Revoking a badge leaves the points alone by default — they were earned under
the rules as they stood. Pass `reclaimPoints: true` to reverse them, clamped so
a member who already spent them lands at zero rather than negative.

A pinned rank sets `rank_locked`, and no automatic evaluation moves that member
until it is released. Run `reevaluate` after editing thresholds or importing
balances; it is batched and safe to repeat.

### Ledger search and export

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/v1/rewards/ledger` | Search across contacts |
| `GET` | `/v1/rewards/ledger.csv` | The same query as CSV |

Query parameters: `contactId`, `ruleKey`, `refType`, `status`, `direction`
(`credit`/`debit`), `from`, `to` (ISO dates), `search` (reason, name or email),
`limit`, `offset`. An unparseable date is a `400` rather than a silent empty
result.

The CSV is capped at 50,000 rows and refuses rather than truncating, because a
short export that looks complete is worse than a refusal. Cells beginning `=`,
`+`, `-` or `@` are prefixed with an apostrophe so a spreadsheet treats them as
text — the reason field carries content from the public internet.

The ledger stays append-only. There is deliberately no edit or delete, unlike
myCred's admin log: a mistake is corrected with a reversal, which leaves both
entries visible.

### Leaderboard

`GET /v1/rewards/leaderboard?window=month&limit=10&contactId=…`

`window` is `all` (default), `day`, `week`, `month` or `year`. Passing
`contactId` returns `you` with that member's rank even when they are below the
cut. Excluded contacts never appear.

### Reward rule fields

`PUT /v1/rewards/rules` now also accepts `weeklyCap`, `monthlyCap`,
`maxPerAward` and `logTemplate`. Cap windows are evaluated in the **tenant's**
timezone, not the server's. `logTemplate` substitutes `%amount%`, `%rule%`,
`%ref%`, `%ref_type%` and `%value%`.

### Transfer limits

`PUT /v1/settings` accepts `transferMinimum`, `transferDailyLimit`,
`transferWeeklyLimit` and `transferMonthlyLimit`. Unset means unlimited.

---

## Marketing

### Segments

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/v1/segments/fields` | The field catalogue, for building a filter UI |
| `GET` | `/v1/segments` | List |
| `GET` | `/v1/segments/:key` | One segment with its definition |
| `PUT` | `/v1/segments/:key` | Create or update |
| `DELETE` | `/v1/segments/:key` | Remove |
| `POST` | `/v1/segments/preview` | Count and sample a definition without saving it |
| `POST` | `/v1/segments/:key/build` | Recompute membership now |
| `GET` | `/v1/segments/:key/audience` | How many could actually be mailed |

A definition is a filter group:

```jsonc
{
  "match": "all",                 // or "any"
  "filters": [
    { "field": "order_count",  "operator": "gte",              "value": 1 },
    { "field": "last_order_at","operator": "not_in_last_days", "value": 90 },
    { "field": "tags",         "operator": "not_contains",     "value": ["vip"] }
  ],
  "groups": []                    // nested groups, up to 4 deep
}
```

`GET /v1/segments/fields` is the authoritative list of what `field` and
`operator` may be — the compiler rejects anything outside it, so read the
catalogue rather than guessing. Relative dates resolve in the tenant's
timezone.

**Preview before you save.** A count alone does not catch "I meant *not*
tagged vip", which is why the preview endpoint returns a sample of real
contacts alongside the number.

Consent and suppression are *not* part of a definition. They are applied when
an audience is read, so a segment cannot be built that forgets them.

### Broadcasts

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/v1/broadcasts` | List |
| `GET` | `/v1/broadcasts/:key` | Delivery report, including why anyone was skipped |
| `PUT` | `/v1/broadcasts/:key` | Create or update a draft |
| `POST` | `/v1/broadcasts/:key/send` | Arm it; a worker walks the audience |
| `POST` | `/v1/broadcasts/:key/cancel` | Stop the walk |

Sending is a separate call from saving on purpose: mailing a whole segment is
not something to do by accident while editing a subject line.

A send resumes from a cursor if a worker dies, and every message carries the
dedupe key `broadcast:<id>:<contact>`, so even an overlapping resume cannot
produce a second copy. `maxMarketingPerDay` and `maxMarketingPerWeek` in
settings cap how much marketing one contact receives; a capped contact is
recorded as skipped with a reason rather than silently dropped.

A **sent** broadcast cannot be edited. It is the record of what went out.

### Automations

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/v1/automations` | List |
| `PUT` | `/v1/automations/:key` | Create or update |
| `DELETE` | `/v1/automations/:key` | Remove |
| `GET` | `/v1/automations/runs?key=` | Runs, including sequences currently parked |

`actions` is a step list. An action step is one of `send_email`,
`award_points`, `add_tag`, `remove_tag`, `webhook`. A control step is one of:

```jsonc
{ "type": "wait", "days": 1 }                       // or hours/minutes/seconds
{ "type": "if", "filter": { … }, "else": "stop" }   // or "continue" / {"goto": N}
{ "type": "goto", "step": 0 }
{ "type": "stop" }
```

An `if` filter uses the same shape and field catalogue as a segment, evaluated
against that one contact **at the moment the step runs** — which is the point
of putting one after a wait.

A cart-recovery sequence, expressed properly:

```jsonc
{
  "triggerType": "cart.abandoned",
  "actions": [
    { "type": "send_email", "template": "cart_recovery_1" },
    { "type": "wait", "days": 1 },
    { "type": "if",
      "filter": { "match": "all",
                  "filters": [{ "field": "last_order_at",
                                "operator": "not_in_last_days", "value": 1 }] },
      "else": "stop" },
    { "type": "send_email", "template": "cart_recovery_2" }
  ]
}
```

Parked runs are cancelled when the contact unsubscribes and when the automation
is disabled. Waits are capped at two years, sequences at 100 executed steps, and
a `goto` outside the sequence is rejected when the automation is *saved* rather
than when a customer triggers it at two in the morning.

### Email engagement

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/v1/email/engagement?days=30` | Sent, open rate and click rate per template |
| `GET` | `/v1/email/suppressions` | Addresses that will not be mailed |
| `POST` | `/v1/email/suppressions` | Suppress one |
| `DELETE` | `/v1/email/suppressions/:email` | Allow it again |

Marketing mail is tracked; transactional mail never is. Scanner and
privacy-proxy hits are counted separately, so an open rate here is not the
inflated number most tools report. Un-suppressing does **not** restore
marketing consent — only the person can give that back.

Turn tracking off entirely with `emailTracking: false` in settings.

### Contact timeline

`GET /v1/contacts/timeline?email=…&limit=50&kinds=order,points&before=…`

Everything that happened to one contact, newest first, merged from sessions,
orders, carts, points, email sends, opens and clicks, badges, ranks, shares,
token claims and automation runs. `kinds` filters to a comma-separated subset.

### Spending points

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/v1/credit/quote?points=500` | What those points are worth, before spending |
| `POST` | `/v1/credit/redeem` | Spend them for a store credit code |

The short path to money off an order: no wallet, no chain, no gas. The rate is
the same one TBAY converts at, including any retailer bonus, so neither route
can be arbitraged against the other. Points convert in whole blocks of
`pointsPerToken`; the quote reports how many of the points supplied are usable.

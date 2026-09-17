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
Voids commissions, reverses every reward the order paid, and takes the
purchase back out of the product figures on the day it was placed. A referral
the order qualified is unwound too, unless the customer has another order that
still stands.

### `PUT /v1/products/:productRef`
The catalogue, stated by the store.

```json
{
  "name": "Red Ensign",
  "url": "https://shop.example.com/product/flag",
  "imageUrl": "https://shop.example.com/img/flag.jpg",
  "priceCents": 4999,
  "currency": "CAD",
  "categories": ["flags", "heritage"]
}
```

The tracker also reports products it sees, but under the public site key —
which is in every page's source, so those details are whatever the caller
sent. A tracked product is therefore only ever *introduced*: it may fill in a
product nobody has seen before, never restate one the store already has. This
route is how a correction actually lands, and it is the only way to change a
product's categories, which reward rules match on and which therefore decide
what buying it earns.

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
| `GET /v1/rewards/leaderboard` | Top earners, per currency |
| `GET` / `PUT` / `DELETE /v1/point-types` | Currencies — see below |
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
| `POST /v1/token/spend/:id/cancel` | Close an intent settled or abandoned another way |
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

`PUT` takes `{ subject, html?, blocks?, text?, transactional?, topicKey?, preheader? }`.
A template being created needs a body — `html` or `blocks`. One that already
exists can be edited a field at a time.

Fields left out are left alone; `null` clears. That distinction matters most
for `transactional`: omitting it used to mean `false`, which turns a receipt
back into marketing and stops it reaching anyone without a marketing opt-in.
`topicKey: null` removes the template from every topic.

Saving `html` over a composed template drops its blocks, because generated HTML
cannot be parsed back into them. See [the email builder](#the-email-builder)
for what `blocks` holds.

`preheader` is the line a mail client shows beside the subject. Left unset, the
client shows the first words of the body instead, which for a message that
opens with an image is its alt text.

`transactional` decides whether the message needs marketing consent. A receipt
for something the person just did — the points their order earned — is
transactional; anything they did not ask for is not, and stays consent-gated.
It defaults to `false`, so opting a template out of consent is always a
deliberate act. Where the line sits legally is the retailer's call, which is
why this is a switch rather than a hardcoded list.

### The email builder

A message somebody can compose without writing HTML: a list of typed blocks
with typed fields, rendered server-side.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/v1/email/blocks` | Every block type, and the fields each takes |
| `POST` | `/v1/email/preview` | Render blocks without saving or sending |

The catalogue is fetched rather than hard-coded, so a builder UI is driven by
the platform: add a field server-side and the UI offers it, instead of
silently dropping what it does not know.

```json
{ "blocks": [
    { "type": "heading", "text": "September", "level": 2 },
    { "type": "text", "text": "Thanks for a good month, {{name}}." },
    { "type": "products", "items": [
        { "title": "Maple syrup", "price": "$12", "url": "https://shop.example/p/1" }
    ] },
    { "type": "button", "label": "Shop", "url": "https://shop.example" },
    { "type": "points", "heading": "Your balance" }
] }
```

Types are `heading`, `text`, `button`, `image`, `divider`, `spacer`, `products`
and `points`. At most 60 blocks, 12 products in a product block, and at least
one block — a message whose only content is its own unsubscribe link is refused
rather than stored.

Fields are checked, not coerced. A value of the wrong type is a 400 rather than
`[object Object]` in a sent newsletter, and a heading, a paragraph, a button
label and a product name may not be blank.

**The admin never writes HTML, which is the security property.** An HTML
textarea in wp-admin is a stored XSS vector against the next admin who opens
the preview; a list of blocks with escaped values is not, whatever anybody
types into it. Links must be `http`, `https` or `mailto` — `javascript:` is
mostly inert in a mail client and entirely live in an admin's preview pane, and
`data:` is a phishing page that never leaves the message.

Merge fields (`{{name}}`, `{{tenant_name}}`, `{{points_balance}}`,
`{{rewards_url}}`) survive escaping and are substituted at send time. A merge
field is also accepted where a URL goes.

#### Dynamic content

Any block may carry `visibleTo` or `hiddenFrom`, naming a segment key:

```json
{ "type": "text", "text": "Your VIP early access opens Friday", "visibleTo": "vip" }
```

That is what makes one message serve two audiences — a VIP paragraph above the
same three products everybody gets — rather than sending two. Membership is
resolved per recipient at send time from `segment_members`, one query for the
whole message however many conditional blocks it holds.

The segment has to exist. A typo is otherwise invisible and silent in the worst
direction — `visibleTo: "vips"` hides the block from everybody, `hiddenFrom:
"vips"` shows it to everybody — so an unknown key is refused when the message is
saved.

The copy stored on the template shows every block, because it was rendered
against nobody. What a given person receives is rendered when the message is
queued for them.

#### Preview

`POST /v1/email/preview` takes `{ blocks, subject?, preheader?, as? }` and
returns `{ subject, html, text, segments_used, segments_matched }`. `as` is a
contact id: naming somebody renders the blocks *that person* would get, so a
conditional block can be checked rather than guessed at. The preview's
unsubscribe and preferences links are inert `#` — a preview must not contain a
working unsubscribe link that somebody clicks while checking their own
newsletter.


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

`GET /v1/rewards/leaderboard?window=month&limit=10&contactId=…&pointType=status`

`window` is `all` (default), `day`, `week`, `month` or `year`. Passing
`contactId` returns `you` with that member's rank even when they are below the
cut. Excluded contacts never appear.

`pointType` picks the currency to rank; omitting it gives the retailer's
default. One board per currency — summing them would rank a member's
unspendable status credits against another's spendable points. The response
echoes `point_type`.

---

## Saved reports and scheduled exports (secret)

The fixed analytics under `/v1/reports` answer the questions we thought of. A
retailer wants "revenue by campaign, monthly, for the last year" or "points
issued per rule since we changed the rates" — questions nobody can enumerate in
advance, and which are otherwise answered by somebody writing SQL against
production.

Mounted at **`/v1/saved-reports`**, deliberately: a `:key` parameter under
`/v1/reports` would shadow every fixed report, including `/v1/reports/sources`.

| Route | Purpose |
|---|---|
| `GET /v1/saved-reports/catalogue` | Sources, and what each can group by and measure |
| `GET /v1/saved-reports` | Saved reports and their schedules |
| `PUT` / `DELETE /v1/saved-reports/:key` | Save or remove one |
| `POST /v1/saved-reports/run` | Run a definition without saving it |
| `GET /v1/saved-reports/:key/run` | Run a saved one |
| `GET /v1/saved-reports/:key/run.csv` | The same as a CSV download |
| `PUT` / `DELETE /v1/saved-reports/:key/schedule` | Email it on a cadence |
| `POST /v1/saved-reports/:key/send` | Send it now |
| `GET /v1/saved-reports/runs` | What went out, and to whom |

### The definition

```json
{
  "source": "orders",
  "dimensions": ["month", "campaign"],
  "measures": ["orders", "revenue"],
  "days": 365,
  "filters": { "match": "all", "filters": [{ "field": "country", "operator": "eq", "value": "CA" }] }
}
```

The definition is the retailer's; the **shape** of it is not. Every source,
dimension and measure name is looked up in a fixed catalogue — the same
discipline the segment filter compiler is built on, and for the same reason.
"Let admins pick any column" is how a reporting screen becomes an
arbitrary-read primitive over the whole schema, including other tenants' rows,
pii salts and key hashes.

Sources: `orders`, `points`, `commissions`, `email`, `contacts`. At most four
dimensions and eight measures. `days` is a rolling window, defaulting to 90;
`null` means everything.

`filters` is a **contact segment**, compiled by the same compiler segments use
— including the retailer's own `cf_<key>` fields — rather than a second filter
language that would need auditing separately.

A definition is validated **on save**, so a broken report is rejected while an
admin is looking at the form rather than three weeks later when its schedule
fires at 6am and nobody is watching.

Date buckets are in the **retailer's** timezone. A "day" that rolls over at
20:00 local is a daily report nobody can reconcile against their till.

### Schedules

`daily`, `weekly` or `monthly` at an hour in the retailer's timezone —
deliberately not cron. An admin screen with a cron field is one where somebody
schedules a report for 03:17 every 13th of the month by accident and does not
find out for a year. The monthly day is capped at 28, so February never
silently skips a send.

A send is claimed by writing the **period key** — `2026-W38`, `2026-09` —
rather than a timestamp. Two workers racing produce one send and one no-op, and
"have we sent since 07:00" cannot drift across a clock change. Sending by hand
uses a distinct key, so it does not consume Monday's.

Scheduled reports carry **no unsubscribe link**, which is what marks a message
transactional here. A report to the retailer's own staff must not consume a
customer-facing frequency allowance, nor offer a member of staff a link that
suppresses them from the store's own mail.

---

## Operators, roles and the audit log (secret)

Every secret key could do everything, which is fine for one person running one
store. It stops being fine the moment a second person has the key — that is
when "who adjusted this balance" becomes unanswerable, and when a support
contractor needs to look things up without also being able to erase a customer
or issue themselves a key.

**No login layer was added.** The platform is API-first with WordPress as its
front end; a session system nobody asked for would be the wrong feature. What
was added is a key attributable to a named person and limited to a role, plus a
record of what was done.

| Route | Purpose |
|---|---|
| `GET` / `PUT /v1/operators` | Named people and their roles |
| `DELETE /v1/operators/:email` | Remove one (their keys survive, unattributed) |
| `GET` / `POST /v1/keys` | List and issue keys |
| `DELETE /v1/keys/:keyId` | Revoke one |
| `GET /v1/audit` | What was done, by whom |

### Roles

A ladder, not a matrix — a store has four people, not four hundred, and
"support can do everything readonly can" is what an owner actually means.

| Role | May |
|---|---|
| `owner` | Everything, including operators, keys and settings |
| `manager` | Every operational change: points, rules, badges, broadcasts, erasure, merge |
| `support` | Read everything; adjust a balance, award a badge, set a field or preference |
| `readonly` | Read |

Enforced by **one hook**, not a guard per route. A check written at each call
site is one somebody forgets on the route they add next month, and nobody
notices until the support contractor deletes a customer. Anything not named in
the rule list falls to the default — a read needs `readonly`, a write needs
`manager` — so a new route is protected before anybody remembers it exists.

A key takes the **narrower** of its own role and its operator's. A key with
neither reads as `owner`, so every key issued before this existed keeps doing
exactly what it did.

A **disabled operator's keys stop working**. Disabling somebody while the
credential they carry still works is the appearance of removing access rather
than removing it.

Removing an operator does **not** revoke their keys — it strips the
attribution. Revoking somebody's access and silently revoking an integration
key they happened to issue are different decisions, and doing the second while
meaning the first takes a storefront down.

### The audit log

Append-only, like the points ledger and for the same reason: a log somebody can
rewrite answers no question worth asking. There is no edit or delete path.

Recorded: who (operator and key), what (method and path), the outcome status,
who it was about, and a **short allow-list** of request fields — the amount and
the reason, not the customer's address again. An audit log that copies every
field becomes a second store of the personal data the first one is careful
about.

Refusals are recorded too; a 403 is the entry somebody most wants to find.
Reads are not — a log of every GET buries the twelve entries that matter.

A failed audit write never fails the request. Losing a line is bad; losing the
customer's order because the log table was full is worse.

Filters: `operatorId`, `target` (a contact), `action` (a **prefix**, so
`POST /v1/rewards` covers the area), `from`, `to`.

---

## Webhooks, settings and store credit (secret)

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/v1/webhooks` | Registered endpoints, without their signing secrets |
| `POST` | `/v1/webhooks` | `{ url, secret, topics? }` — https only |
| `DELETE` | `/v1/webhooks/:id` | Remove one |
| `GET` | `/v1/settings` | The retailer's settings |
| `PUT` | `/v1/settings` | Change them (owner only) |
| `POST` | `/v1/token/credit/reserve` | The oldest usable store credit for a contact |
| `POST` | `/v1/token/credit/redeem` | `{ code, orderRef, amountCents? }` |

A store credit is a balance, not a token. `reserve` reports what is **left**
(`remaining_cents`, and `amount_cents` for compatibility), not the face value,
and `redeem` draws that balance down by `amountCents` — omitted means all of
it. A $50 credit spent on a $10 basket leaves $40 on the account instead of
destroying it.

Redemption is idempotent per order: asking twice for the same `orderRef`
returns what the first call took, with `already_redeemed: true`, and takes
nothing more. A checkout retried after a timeout cannot tell "that did not go
through" from "that went through and the reply was lost", so the platform
decides.

---

## Merging duplicates (secret)

Somebody checks out as a guest with one address and signs up with another; an
import brings the same customer in twice. Until now the choice was to leave
both — their points split across two balances, neither showing the truth — or
delete one and lose whatever history it held.

| Route | Purpose |
|---|---|
| `GET /v1/contacts/duplicates` | Records that look like the same person |
| `GET /v1/contacts/merge/preview` | What a merge would do, without doing it |
| `POST /v1/contacts/merge` | `{ "keep": "<uuid>", "merge": "<uuid>" }` |

The survivor **keeps its own id**, so every link a retailer has already saved —
a WordPress user meta, a webhook payload, a printed card — still resolves.

What happens:

- **Points are added, not picked.** Two balance rows for one person are two
  halves of one balance, and the ledger behind both moves to the survivor, so
  the totals have to sum or the balance stops matching its own history. Per
  currency.
- **Rows that could collide are reconciled, not blindly updated.** A badge
  earned to level 3 on one record and level 1 on the other becomes level 3 —
  taking the survivor's blindly would demote somebody for having been merged.
  The same for streaks. A subscription, topic preference or custom field the
  survivor already has is kept; a blind `UPDATE` would trip the unique
  constraint and fail for exactly the customer who was active on both.
- **Contact details fill gaps.** Whoever the operator chose to keep is the one
  whose details they meant to keep, so the loser only supplies what the
  survivor lacks. Marketing consent is the exception and the direction is
  deliberate: either record having given it is enough, but a *withdrawal* is
  never overridden by the other's yes, and the **earlier** consent date wins —
  those dates prove how long a permission has been held. A pause on either side
  survives at its later date.

Refused: merging a contact into itself, across tenants, or with an erased
record — the last would carry what the erased one still holds onto a live
record, which is the erasure undone by another route.

Duplicate detection is deliberately narrow: a shared wallet (its holder signed
a challenge to bind it) and a shared platform `member_id`. Not a shared name or
phone — that is a household, and a merge is irreversible. Not `external_ref` or
`email` either: both are uniquely indexed per tenant, so neither can duplicate.

---

## The retailer's own contact fields (secret)

Segments filter over a fixed catalogue of platform fields. A flag store wants
"province" and "preferred fabric"; a rewards programme wants "membership tier".

| Route | Purpose |
|---|---|
| `GET /v1/contacts/fields` | The retailer's field definitions |
| `PUT /v1/contacts/fields/:key` | Create or update one |
| `DELETE /v1/contacts/fields/:key` | Remove one, and every value under it |
| `GET` / `PUT /v1/contacts/field-values` | One contact's values |
| `GET /v1/segments/fields` | Platform and custom fields together |

A key is 2–40 characters of `a-z`, `0-9` or underscore. `kind` is `text`,
`number`, `date`, `boolean` or `select`; a `select` needs `options`.

```json
PUT /v1/contacts/fields/fabric
{ "label": "Preferred fabric", "kind": "select", "options": ["Nylon", "Polyester"] }
```

Values are **typed columns, not jsonb**, and the reason is where the error
lands. With jsonb the value is text and a segment filtering "tier > 3" casts at
read time, so one contact whose tier is "gold" raises in the middle of an
audience build — a 500 from a screen that did nothing wrong, hours after the
bad value was written. Typed columns move that failure to the write, where it
is a 400 naming the field.

Consequences worth knowing:

- Numbers compare as numbers. Over text, "10" sorts below "9".
- A `select` value is matched case-insensitively and stored in the option's own
  spelling, so "Nylon", "nylon" and "NYLON" are one segment rather than three.
- A field's type **cannot change once values are stored under it**. There is no
  correct automatic answer — "gold" is not a number — so the request is refused
  rather than silently leaving every value in a column the new type never
  reads.
- An unknown key on a write is a 400, not a silent no-op. A typo'd key that
  quietly does nothing is an integration that looks like it works.

### Segmenting on them

Custom fields are addressed **`cf_<key>`** in a filter, so a retailer defining a
field called `email` gets `cf_email` and the platform's `email` still means the
address.

The compiler's rule — no value from a definition ever reaches the SQL string —
holds here too. A custom field's *name* is retailer data, so it is **bound as a
parameter**; only the kind, looked up in a fixed table, picks the column.

---

## Preferences and topics (secret)

Unsubscribe is binary, and most people who click it do not want silence. They
want less, or the one thing they signed up for and not the other three. A store
that defines no topics keeps today's behaviour exactly: the page then offers a
pause and an exit, which is still more than a bare unsubscribe link.

| Route | Purpose |
|---|---|
| `GET /v1/email/topics` | The retailer's topics |
| `PUT /v1/email/topics/:key` | Create or update one |
| `DELETE /v1/email/topics/:key` | Remove one, and the choices about it |
| `GET` / `PUT /v1/email/preferences` | One contact's preferences |
| `GET /v1/email/preferences/report` | What people chose instead of leaving |

A topic key is 2–40 characters of `a-z`, `0-9` or underscore. `defaultOn`
decides what somebody who has never expressed a view receives — on by default,
because a topic nobody has opted into yet should still send.

`email_templates.topic_key` and `broadcasts.topic_key` say which topic a
message belongs to. A message with no topic goes to everyone who has consented,
which is every message a retailer sends until they define one.

### The page

`GET /n/prefs/:token` renders; `POST` applies. The token is signed over exactly
the (tenant, address) pair, the same construction the unsubscribe link uses and
for the same reason — the tenant id is printed in every marketing email, so
anything taking it from a query string could be walked over a list of
addresses. It does not expire: somebody digging out a two-year-old message to
turn one thing off is exactly who the page is for.

GET renders, POST acts, deliberately. Corporate link scanners fetch every URL
in every message, so a page that changed anything on GET would rewrite the
preferences of precisely the recipients whose employer scans their mail.

The link sits beside Unsubscribe in every marketing email's footer, first.

### Pausing

A pause is not an unsubscribe: consent is untouched and it lifts by itself.
Capped at a year. Checked **at send time**, not when an audience was built — a
large broadcast runs over minutes or hours and somebody who pauses partway
through should not receive the rest of it.

### What ignores all of this

Transactional mail. A receipt, a confirmation, a token claim is the answer to
something the customer did, and withholding it because they paused the
newsletter would be withholding a receipt for want of a marketing opt-in.

---

## Privacy (secret)

| Route | Purpose |
|---|---|
| `GET /v1/privacy/export` | Everything held about one person |
| `POST /v1/privacy/erase` | Erase a person, keeping the retailer's books |
| `GET /v1/privacy/erasures` | Proof that erasures were carried out |
| `GET` / `PUT /v1/privacy/retention` | How long each category of data is kept |

### Erasure

```json
POST /v1/privacy/erase
{ "email": "someone@example.com", "reason": "request", "requestedBy": "ticket-4471" }
```

The contact row **survives, stripped**. Deleting it would cascade through
`points_ledger` and take the retailer's own financial record with it, which is
not what anybody is asking for and in most places is itself unlawful.

What goes: name, address, phone, wallet, external reference, attributes, tags,
and every row that is personal data and nothing else (events, sessions,
touchpoints, carts, notifications, wallet challenges, shares, email events,
automation runs, segment and broadcast membership). Email bodies are blanked
while delivery metadata survives — a suppression list whose reasons have been
deleted is a list nobody can audit.

What stays: orders, the points ledger, commissions, store credits and token
claims. Those are the retailer's accounts.

`forfeitPoints` defaults to **true**. An anonymised row with a spendable
balance is a liability nobody can ever reconcile: the person it belonged to is
gone, so nobody can claim it and nobody can write it off. The forfeit is a
ledger entry reading "Balance forfeited on erasure", so the history explains
itself. Pass `false` when the retailer is settling the balance separately —
and settle it *first*.

#### On-chain obligations outlive the account

A row on the chain tables is two things: a link to a person and a debt to a
wallet. Erasure removes the link — `member_id`, which is the platform-wide
identity — and keeps the wallet wherever money is still owed to it.

| State | What happens |
|---|---|
| Spend intent `pending`/`verifying`, still live | **Refused**, with the intent named. A checkout is in progress and erasing mid-payment loses the store credit the customer is about to be owed. `POST /v1/token/spend/{id}/cancel` clears an open intent now, and one stuck mid-verification ten minutes after the request that abandoned it; otherwise it clears itself. |
| Spend intent lapsed inside 30 days | Erased, with `from_address` replaced by a **tenant-salted digest**. `expires_at` bounds the quote, not the money: a customer who sent their TBAY and lost the tab has tokens at the retailer's payout wallet. The digest answers the only question a settlement asks — "did this transfer come from the wallet this intent was opened for?" — so `POST .../verify` still works, while the address itself is gone and cannot be joined back to anyone. |
| Spend intent `verified`, `cancelled`, or lapsed over 30 days ago | Fully scrubbed. Nothing is owed. |
| Bridge withdrawal, any state | Fully scrubbed, links included, and an unsettled one is counted in `obligations_kept` on the response. The obligation survives: `burn_tx_hash` stays, and `GET /v1/bridge/withdrawals/{id}` returns `payable_to`, read back from the burn transaction. That is where the address came from — `recordWithdrawal` derives it from the burn because the burn event is the only proof of who owned the tokens — so nothing is lost by not storing it. |

A wallet address is never kept in a form that can be joined back to a person.
`members.wallet_address` is plaintext, unique and platform-wide, and it is only
cleared when the erased contact was that person's last one anywhere — so a kept
raw address joined straight to their live, fully identified record at another
retailer, whether or not the row's own `contact_id` was nulled. The spend
intent therefore keeps a digest keyed outside the database (not the tenant's
`pii_salt`, which sits in the same database as the wallet table it would be
matched against), and the bridge withdrawal keeps nothing at all, because the
chain already holds what it needs.

Erasure never refuses indefinitely and never destroys a payout address. An
earlier version refused on any unsettled withdrawal and named "release or
reject" as the remedy — both operator-only routes needing
`BRIDGE_OPERATOR_TOKEN`, which a retailer does not hold, so the erasure could
not be carried out at all.

An erased address cannot be re-added. `/v1/contacts` and the public
`/v1/identify` both return **422** for it, matched against a per-tenant salted
hash so the address itself is not kept. The same person at another retailer on
the same platform is unaffected.

### Retention

```json
PUT /v1/privacy/retention
{ "eventDays": 365, "sessionDays": 365, "emailBodyDays": 90, "notificationDays": 180 }
```

`null` on any field means keep indefinitely, which is what every tenant has
until they say otherwise. Windows are 1–3650 days. A background job sweeps
hourly, bounded per pass: a retailer turning on a 30-day policy after two years
of collection catches up over a day rather than holding locks on the largest
table in the schema for minutes.

Heatmap and product aggregates are never swept — they are counts and carry no
identifier. Neither are orders, points or commissions.

---

## Point types (secret)

More than one currency per retailer. A retailer who never creates a second one
never touches this: the default `points` currency is installed with the tenant
and every endpoint below falls back to it.

| Route | Purpose |
|---|---|
| `GET /v1/point-types` | List the retailer's currencies |
| `PUT /v1/point-types/:key` | Create or update one |
| `DELETE /v1/point-types/:key` | Remove one nobody holds |

A key is 2–32 characters of `a-z`, `0-9` or underscore. The body takes `name`,
`singular`, `plural`, `isDefault`, `convertible`, `transferable`,
`displayOrder` and `enabled`.

```json
{
  "name": "Status Credits",
  "singular": "status credit",
  "plural": "status credits",
  "convertible": false,
  "transferable": false
}
```

`convertible` decides whether it can become store credit or TBAY;
`transferable` whether it can be sent to another member. Both default to
**false** on a new currency, because a status currency that can be cashed out
is just a second wallet. The default `points` currency has both.

Deleting a currency members still hold is refused — the ledger is append-only
and a balance is a claim on the retailer. Zero the balances first. The default
currency cannot be deleted at all.

### Naming a currency elsewhere

Every points-bearing endpoint takes an optional `pointType` (or `point_type`
on a stored record), and falls back to the default when it is absent:

| Where | Field |
|---|---|
| `PUT /v1/rewards/rules` | `pointType` — which currency the rule pays |
| `POST /v1/rewards/adjust` | `pointType` |
| `GET /v1/rewards/balance`, `GET /v1/rewards/ledger` | `pointType` filters the ledger |
| `GET /v1/rewards/leaderboard` | `pointType` |
| `PUT /v1/gamification/badges/:key`, `/ranks/:key` | `pointType` — which ladder |
| `POST /v1/gamification/transfer` | `pointType` (refused unless transferable) |
| `POST /v1/gamification/coupons` | `pointType` — what the code pays out |
| `POST /v1/gamification/content/unlock` | `pointType` |
| `POST /v1/token/redeem`, `POST /v1/credit/redeem` | `pointType` (refused unless convertible) |

An **unknown key is a 400**, never a silent fall back to the default: quietly
awarding the wrong currency is worse than refusing, because nobody notices
until a status board has spendable points on it.

An update that does not name a currency leaves the record's alone. Renaming a
status rule does not move it onto the default currency.

`GET /v1/rewards/balance` and `GET /v1/contacts/lookup` both return `points`
(the default currency, unchanged for existing callers) alongside `balances`,
one row per enabled currency carrying the retailer's own wording.

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

`PUT` takes `{ name?, segmentKey?, templateKey?, subject?, sendAt?, blocks?, preheader?, topicKey? }`.

`topicKey` omitted is inherited from the template, so a send honours what people
chose in the preference centre without anybody having to remember. `null` puts
the send in no topic, reaching everyone who consents whatever they chose.

Arming a send whose segment has never been built is refused: the builder runs
every ten minutes and saving a segment does not build it, so "create the
segment, then send" used to walk an empty audience and report success.

A broadcast either names a template or carries its own body. Sending `blocks`
clears the template it named, and naming a template clears the blocks; sending
both in one call is a 400, because a message has one body and picking for you
would make the answer depend on the order of two `if`s. A composed broadcast
needs its own `subject`, and a `preheader` only means something on one — on a
template-backed send it is refused, since the template's own preheader is
already part of the body that goes out.

A draft may have neither: that is what "create it, then write it" looks like
between the two steps. Arming one is refused until it has a message.

Fields left out are left alone. In particular `sendAt` omitted keeps the time
already set, so editing a scheduled send's message does not quietly
un-schedule it; `sendAt: null` clears it and returns the send to a draft.

Composing on the send is there because the monthly newsletter is a one-off, and
making a retailer create a template for each one is how a "send" screen grows a
"template" screen nobody wanted — and a template list that is really a send
history. Conditional blocks work the same way here as on a template: one
message, two audiences.

Sending is a separate call from saving on purpose: mailing a whole segment is
not something to do by accident while editing a subject line. Arming resolves
the body first, so a deleted template or an empty composed message stops the
send before anybody is mailed rather than failing it halfway through.

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

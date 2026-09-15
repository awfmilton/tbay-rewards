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

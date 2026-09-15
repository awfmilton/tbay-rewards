# TBAY Rewards

A unified marketing-automation, on-site analytics and token-backed loyalty
platform. It replaces Mautic and myCred with one system, and settles its rewards
in TBAY — an ERC-20 that spends at any retailer on the network and bridges to
Ethereum.

Built for [tbay.tk LLC](https://tbay.tk).

---

## What it does

**Analytics and attribution**
- Heatmaps of clicks, pointer movement and scroll depth, aggregated into a
  resolution-independent grid (raw cursor traces are never stored)
- Where customers came from — UTM, referrer classification, multi-touch
  touchpoints, last-touch revenue attribution
- Most-clicked, most-viewed and most-purchased products, with click-through and
  cart-conversion rates
- Abandoned carts, with a staged recovery email sequence and recovery reporting

**Marketing automation (the Mautic replacement)**
- Contacts, segments, tags and custom attributes
- Newsletter with double opt-in, one-click unsubscribe and consent auditing
- A trigger → conditions → actions automation engine
- Transactional and broadcast email with a dedupe-keyed queue

**Rewards and gamification (the myCred replacement)**
- An append-only points ledger with idempotency keys and transactional balances
- Reward rules with cooldowns, daily and lifetime caps, and hold periods
- Badges with tiers, balance ranks, daily-login streaks, leaderboards
- Member-to-member point transfers, coupon codes, points-gated content
- Social sharing that pays only when the shared link is actually clicked
- Blog-writer commission links with refund-protection holds

**TBAY token**
- Points → TBAY via EIP-712 claim vouchers the customer submits themselves
- TBAY → store credit at any retailer on the network
- L2 → L1 bridging with on-chain burn verification
- thirdweb and zkSync (Sepolia and Era) support

**Integration**
- A WordPress/WooCommerce plugin
- A dependency-free browser tracker for any site
- Importers for Mautic, myCred and the flagswag theme

---

## Repository layout

```
tbay-rewards/
├── packages/
│   ├── server/                  TypeScript API, workers and operator dashboard
│   │   ├── src/
│   │   │   ├── routes/          HTTP surface
│   │   │   ├── services/        Domain logic
│   │   │   ├── importers/       Mautic / myCred / flagswag migration
│   │   │   ├── workers/         Background jobs
│   │   │   └── lib/             Crypto, chain, auth, attribution helpers
│   │   ├── migrations/          Postgres schema
│   │   ├── public/              Operator dashboard
│   │   └── test/                Integration tests against real Postgres
│   ├── tracker/                 tbay.js — the browser tracker
│   └── wordpress-plugin/        The WordPress/WooCommerce plugin
└── docs/                        Architecture, deployment, API, security, token
```

---

## Quick start

```bash
# 1. Dependencies
npm install

# 2. Database
createdb tbay_rewards
cp packages/server/.env.example packages/server/.env   # then fill it in
npm run migrate

# 3. Provision your first retailer
npm run cli --workspace @tbay/rewards-server -- tenant:create \
  --slug my-shop --name "My Shop" --site-url https://my-shop.example

# 4. Run it
npm run dev
```

`tenant:create` prints a **site key** (safe in page source, ingest-only) and an
**API secret** (server-to-server, shown once).

Then drop the tracker onto any site:

```html
<script src="https://rewards.example.com/tbay.js" data-key="tbp_…" defer></script>
```

…or install the WordPress plugin from `packages/wordpress-plugin/tbay-rewards`
and paste both keys into **Settings → TBAY Rewards**.

---

## Deployment

Docker on a VPS is the supported path:

```bash
cp .env.docker.example .env      # fill in secrets
docker compose up -d
```

That brings up the API, a worker and Postgres. Put TLS in front of it. See
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for the reverse-proxy config, backups
and upgrades.

---

## Documentation

| Document | What's in it |
|---|---|
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | How the pieces fit, the data model, and why |
| [API.md](docs/API.md) | Every endpoint, with auth scope and payloads |
| [TOKEN.md](docs/TOKEN.md) | Token economics, claim vouchers, the bridge, supply safety |
| [SECURITY.md](docs/SECURITY.md) | Threat model, what protects what, operator duties |
| [DEPLOYMENT.md](docs/DEPLOYMENT.md) | Docker, TLS, backups, scaling, upgrades |
| [MIGRATION.md](docs/MIGRATION.md) | Moving off Mautic, myCred and the flagswag theme |
| [WORDPRESS.md](docs/WORDPRESS.md) | Plugin install, shortcodes, hooks and theming |

---

## Development

```bash
npm run dev         # API with reload
npm run worker      # background jobs only
npm run typecheck
npm test            # integration tests — needs a Postgres it can reset
npm run build
```

Tests run against a real database. Point `TEST_DATABASE_URL` at a throwaway one:
the suite drops and recreates its schema on every run.

---

## Licence

Proprietary — tbay.tk LLC. All rights reserved.

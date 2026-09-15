# Deployment

Docker on a VPS. Two containers plus Postgres, behind a TLS terminator.

---

## Requirements

- A Linux VPS with Docker and the Compose plugin (2 vCPU / 4 GB is plenty to
  start)
- A domain pointed at it, e.g. `rewards.example.com`
- Ports 80 and 443 open

---

## First deploy

```bash
git clone <repo> tbay-rewards && cd tbay-rewards

cp .env.docker.example .env
openssl rand -hex 32   # → IDENTITY_SALT
openssl rand -hex 32   # → TOKEN_SECRET
openssl rand -hex 32   # → POSTGRES_PASSWORD
openssl rand -hex 32   # → BRIDGE_OPERATOR_TOKEN
$EDITOR .env           # also set PUBLIC_URL

docker compose up -d --build
docker compose logs -f app
```

The API applies migrations on boot. `PUBLIC_URL` must be the real external HTTPS
origin — tracking, opt-in and share links are all built from it.

Provision your first retailer:

```bash
docker compose exec app node packages/server/dist/cli.js tenant:create \
  --slug my-shop --name "My Shop" --site-url https://my-shop.example
```

Keep the printed **API secret**. It is not shown again.

Configure the retailer (a payout wallet is required before customers can spend
TBAY at this shop):

```bash
docker compose exec app node packages/server/dist/cli.js settings:set \
  --slug my-shop --payout-wallet 0x… --page-pattern /product/:slug
```

---

## TLS

The app binds to `127.0.0.1` only, so it is never directly exposed. Put a proxy
in front.

### Caddy (simplest — automatic certificates)

```caddyfile
rewards.example.com {
    encode zstd gzip

    # The tracker is served to every storefront, so let it be cached.
    @tracker path /tbay.js
    header @tracker Cache-Control "public, max-age=3600"

    reverse_proxy 127.0.0.1:4000
}
```

### nginx

```nginx
server {
    listen 443 ssl http2;
    server_name rewards.example.com;

    ssl_certificate     /etc/letsencrypt/live/rewards.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/rewards.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:4000;
        proxy_set_header Host              $host;
        # The app trusts one proxy hop for the client IP.
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Behind Cloudflare, `CF-IPCountry` is read automatically for country reporting.

---

## Configuration

Everything is environment variables; `.env.docker.example` documents each one.
The ones that matter most:

| Variable | Why it matters |
|---|---|
| `PUBLIC_URL` | Every generated link. Wrong value = broken opt-in and share links |
| `IDENTITY_SALT` | Changing it un-links members across retailers. Set once |
| `TOKEN_SECRET` | Signs attribution cookies and opt-in tokens |
| `TBAY_CHAIN_ID` | 300 = zkSync Sepolia, 324 = Era mainnet |
| `TBAY_CLAIM_SIGNER_KEY` | Must hold `CLAIMER_ROLE`. Signing only — no gas needed |
| `TBAY_REWARD_SUPPLY_CAP_WEI` | **Set before mainnet.** See [TOKEN.md](TOKEN.md) |
| `BRIDGE_OPERATOR_TOKEN` | Required before any L1 release can be recorded |
| `EMAIL_TRANSPORT` | Use `smtp` in production — `log` writes bodies to the log |

### Secrets

Compose reads `.env`, which is fine for a single VPS. For anything larger, use
Docker secrets or your platform's secret store — particularly for
`TBAY_CLAIM_SIGNER_KEY` and `TBAY_TREASURY_KEY`.

---

## Operations

### Health

```bash
curl -s https://rewards.example.com/health | jq
```

Reports database reachability, the configured chain, the reward-supply headroom
and a `preflight` list of configuration problems. `status` is `misconfigured`
when any of those is an error — most importantly an uncapped reward budget on a
mainnet chain. The container healthcheck polls the same endpoint.

### Logs

```bash
docker compose logs -f app worker
```

### Backups

All state is in Postgres.

```bash
docker compose exec -T postgres pg_dump -U tbay tbay_rewards | gzip > backup-$(date +%F).sql.gz
```

Restore:

```bash
gunzip -c backup-2026-01-01.sql.gz | docker compose exec -T postgres psql -U tbay tbay_rewards
```

Back up daily and keep copies off the box. Losing this database loses every
customer's points balance.

### Upgrades

```bash
git pull
docker compose up -d --build
```

Migrations run on boot and each one is transactional, so a failure leaves the
database on the last complete migration. Take a backup first anyway.

### Scaling

The API is stateless:

```bash
docker compose up -d --scale app=3
```

Run exactly one `worker` container. More is safe (every job claims work with
`FOR UPDATE SKIP LOCKED`) but pointless.

---

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `signer_unavailable` on redemption | `TBAY_CLAIM_SIGNER_KEY` not set |
| Claims never move to `claimed` | `TBAY_RPC_URL` unreachable — reconciliation is skipped rather than guessing |
| No recovery emails | `EMAIL_TRANSPORT=log`, or contacts have no `marketing_consent` |
| Tracker 404s | `PUBLIC_URL` wrong, or the proxy is not forwarding `/tbay.js` |
| `chain_unavailable` on bridging | No RPC configured; burns cannot be verified without one |
| Reward allocation exhausted | `TBAY_REWARD_SUPPLY_CAP_WEI` reached — see [TOKEN.md](TOKEN.md) |

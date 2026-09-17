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
        # $proxy_add_x_forwarded_for appends the peer address to any header
        # the caller already sent, so the rightmost entry is the only one
        # nginx wrote. TRUST_PROXY_HOPS=1 tells the app to read that one and
        # ignore whatever the caller put to its left. Set it: the default is 0.
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Set `TRUST_PROXY_HOPS` to the number of proxies actually in front of the app —
1 here, 2 behind Cloudflare in front of nginx. **It defaults to 0**, meaning no
header is trusted at all, so this is a line you have to write: without it every
visitor behind your proxy shares one address, and the per-visitor rate limit
becomes a per-site one.

The default is 0 rather than 1 because the two mistakes are not the same size.
Setting it too low costs accuracy, visibly. Setting it too high hands the client
address to the caller — they send their own `X-Forwarded-For`, and that is what
lands in the rate limiter, the audit log and consent records — and nothing about
that is visible until somebody looks.

Behind Cloudflare, `CF-IPCountry` is read automatically for country reporting.

---

## Configuration

Everything is environment variables; `.env.docker.example` documents each one.
The ones that matter most:

| Variable | Why it matters |
|---|---|
| `PUBLIC_URL` | Every generated link. Wrong value = broken opt-in and share links. **https in production** — cookies are set `Secure`, so over plain http the browser never sends them back and attribution stops |
| `IDENTITY_SALT` | Changing it un-links members across retailers. Set once. At least 32 random characters |
| `TOKEN_SECRET` | Signs attribution cookies and opt-in tokens, and keys the wallet digests left by an erasure. Must **not** be the same value as `IDENTITY_SALT`. **Rotating it makes every already-erased spend intent unsettleable and every already-erased bridge withdrawal unpayable** — settle anything outstanding first. |
| `TBAY_CHAIN_ID` | 300 = zkSync Sepolia, 324 = Era mainnet |
| `TBAY_CLAIM_SIGNER_KEY` | Must hold `CLAIMER_ROLE`. Signing only — no gas needed |
| `TBAY_REWARD_SUPPLY_CAP_WEI` | **Set before mainnet.** See [TOKEN.md](TOKEN.md) |
| `TBAY_TENANT_MINT_PER_WINDOW_WEI` | What one retailer may issue per window, in front of the shared ceiling. Default 25,000 TBAY/hour; `0` disables it, which suits a single-tenant deployment |
| `TBAY_TENANT_SUPPLY_CAP_WEI` | Lifetime issuance ceiling per retailer. Default `0`, unlimited |
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
| One store hits its allowance for the hour | `TBAY_TENANT_MINT_PER_WINDOW_WEI` reached. Working as intended: check that store's `pointsPerToken` before raising it |

---

## Verified build

The image has been built and run end to end, not just written:

```
docker build -t tbay-rewards .          # 345 MB, node:22-alpine, non-root
docker run  -e DATABASE_URL=... tbay-rewards
```

On a first boot against an empty database it applies all eleven migrations,
runs preflight, starts thirteen background jobs, and answers `/health`. A round
trip through the running container — tracker served, a tracked pageview
accepted with the public key, an order recorded with the secret key, a segment
built, a timeline read — behaves exactly as the test suite says it does.

Preflight is not decorative. On that first boot it refused the shipped
defaults:

```
[ERROR] default_secret: IDENTITY_SALT is still the development default in production.
[ERROR] default_secret: TOKEN_SECRET is still the development default in production.
[WARNING] email_to_log: EMAIL_TRANSPORT is "log" in production: message bodies go to the application log.
```

Set those before you put anything real behind it. `/health` reports
`status: "misconfigured"` until you do.

### Behind a TLS-inspecting proxy

If your build network intercepts TLS, `npm ci` fails inside the build with
`SELF_SIGNED_CERT_IN_CHAIN` — and npm reports it unhelpfully as
`Exit handler never called!`, which reads like an out-of-memory error and is
not one. Supply your CA rather than disabling verification:

```bash
docker build --secret id=ca,src=/path/to/ca-bundle.crt .
```

and in a local override of the build stage:

```dockerfile
RUN --mount=type=secret,id=ca,target=/ca.crt NODE_EXTRA_CA_CERTS=/ca.crt npm ci
```

The shipped Dockerfile deliberately does not require a secret, so an ordinary
build stays a plain `docker build .`.

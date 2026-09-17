# Security

The platform converts loyalty points into a real crypto asset. That makes points
worth stealing and makes correctness a security property, not just a quality one.

---

## Trust boundaries

| Credential | Where it lives | What it can do |
|---|---|---|
| Site key `tbp_…` | Page source, any browser | **Write ingest only** — events, carts, newsletter signups |
| API secret `tbs_…` | Retailer's server | Read reports, move points, sign vouchers, for **one tenant** |
| Bridge operator token | Operator's tooling | Record L1 releases. Nothing else |
| Claim signer key | Platform secrets store | Sign claim vouchers. Holds no funds, needs no gas |
| Treasury key (optional) | Platform secrets store | Send TBAY from the reward treasury |

Secret keys are stored as an HMAC, never plaintext, so a database leak yields
nothing usable. They are presented as `<key_id>.<secret>`; only the secret half
is hashed and compared.

---

## What protects what

### Nobody can spend another person's points

- The points ledger is append-only with a tenant-unique idempotency key on every
  entry — one occurrence can be booked exactly once.
- Debits take `SELECT … FOR UPDATE` on the balance row before checking it, so
  concurrent redemptions serialise instead of both passing the same check. A
  `balance >= 0` check constraint is the backstop.
- The WordPress plugin resolves the contact from the **session cookie**, never
  from a request field. Editing a form cannot act on someone else's account.
- Transfers debit and credit inside one transaction, so points cannot be
  duplicated or destroyed by a half-applied transfer.

### A wallet must be proved before it can receive anything

Binding a wallet requires signing a server-issued, single-use, ten-minute
challenge with the private key. Redemption, TBAY spending and bridging all pay
out to that proved address and ignore any address supplied in the request.

Without this, "my wallet is 0xVICTIM" is an unverified assertion, and anything
downstream that trusts the stored address can be pointed at someone else's
tokens. Signing costs nothing, needs no gas, and grants no spending permission.

### Nobody can steal a claim voucher

- A signature authorises exactly one `(user, amount, nonce)` on one chain and one
  contract. Changing any of them yields a signature that recovers to a different
  address, which the contract rejects with `InvalidSigner`.
- The `user` field is the only address that can be credited, so an intercepted
  voucher is worthless to the interceptor.
- Nonces are 256 bits of CSPRNG entropy, unique-constrained on
  `(chain_id, contract_address, nonce)` in the database and `isNonceUsed` on
  chain.
- Ageing out a voucher does **not** refund the points. The deployed
  `TBAYL2.claim()` takes no deadline, so a signature stays valid on-chain
  forever; refunding on a timer would let someone take the points back and still
  mint. The voucher stays claimable and `GET /v1/token/claims/outstanding`
  surfaces it. `CLAIM_REFUND_ON_EXPIRY` exists for a future contract that
  enforces a deadline inside `claim()`.

### Nobody can hijack a bridge withdrawal

- A withdrawal requires a burn **verified on-chain** whose sender matches the
  member's proved wallet. Watching the chain for someone else's burn gets you
  nothing.
- The L1 release always goes to the address that burned. There is no way to
  nominate a different recipient, because the burn event is the only evidence of
  who owned the tokens.
- `(l2_chain_id, burn_tx_hash)` is unique — one burn funds one withdrawal.
- Resubmitting an existing burn cannot change its L1 recipient.
- `crosschainBurn` itself only permits `_from == msg.sender` (absent
  `BRIDGE_ROLE`), so nobody can burn someone else's balance to begin with.

### Nobody can buy store credit twice with one payment

Verification requires a real Transfer to the retailer's payout wallet, from the
declared sender, for at least the promised amount, with confirmations.
`(chain_id, tx_hash)` is unique.

### A role is a role however the path is spelled

The guard that decides what a key may do matches the route the **router**
resolved, not the string the caller sent. Those differ: the router
percent-decodes before it dispatches, so `POST /v1/%6beys` reaches the
`/v1/keys` handler while a raw-string match against `/v1/keys` finds nothing,
falls through to the default for a write — manager — and lets a manager mint
itself an owner key.

Matching the registered pattern closes the whole class rather than the one
spelling: there is no list of encodings, cases or trailing slashes to keep
complete. The audit log records the matched route too, so an action cannot be
hidden from a search by encoding the path it was performed on.

### The site key can introduce somebody, not rewrite them

The public key is in every page's source, so anything it can write is
world-writable. It may create a contact, and fill in a field the retailer does
not have yet — a first login supplying a name. It may not change a name, phone,
locale or country the store already holds, and it may not add tags or
attributes to an existing contact at all.

Tags and attributes are what segments are built from, and segments decide who
receives a campaign and which blocks of it they see. Letting an unauthenticated
assertion write them is letting anyone who knows an email address put that
person into, or out of, a mailing.

### An email cannot attack the admin who previews it

A message composed in wp-admin is a list of typed blocks with typed fields, not
HTML. The server renders the HTML and escapes every value, so there is no way
to type markup into a field and have it reach anyone as markup.

This is the reason the builder exists in the form it does. An HTML textarea in
wp-admin is a stored cross-site-scripting vector against the *next* admin who
opens the message — one compromised or careless author, and the payload runs
with whatever capabilities the next person to look at it has. Blocks remove the
vector rather than filtering it.

Two further limits back it up. A link must be `http`, `https` or `mailto`:
`javascript:` is mostly inert in a mail client and entirely live in a preview
pane, and `data:` is a phishing page that never leaves the message. And the
preview is displayed in a `sandbox=""` iframe, so even a rendering bug cannot
reach the surrounding page.

### Tenants are isolated

Every customer-facing query filters on `tenant_id`. The only cross-tenant object
is `members`, which by design holds no PII beyond a salted hash and an optional
wallet address.

---

## Application security

| Area | Measure |
|---|---|
| Input | Every request body and query string parsed with a schema; nothing is cast |
| SQL | Parameterised queries throughout; no string interpolation of user input |
| Output | WordPress output escaped at every boundary (`esc_html`, `esc_attr`, `esc_url`) |
| Email templates | All interpolated values HTML-escaped unconditionally |
| Composed email | Built from typed blocks, never from admin-authored HTML; every field escaped, and links restricted to `http`, `https` and `mailto` |
| Role checks | Matched against the router's resolved route, so no encoding of the path reaches a weaker rule |
| Third-party scripts | The wallet library is pinned to an exact version and checked with Subresource Integrity; the ESM module it cannot check is pinned to an exact build |
| Analytics URLs | The tracker reports origin + path plus an allow-list of campaign parameters, so order keys, reset keys and session fragments are never stored |
| Consent | No identifier is written — cookie or localStorage — until consent is given, and withdrawing it removes what was written |
| Email preview | Rendered server-side and shown in a `sandbox=""` iframe, so a message cannot run script in the admin's session |
| CSRF | WordPress REST nonces on every member action; nonce checks on form posts |
| Webhooks | HMAC-SHA256 over `timestamp.body`, with a 5-minute freshness window to stop replay |
| Attribution cookies | HMAC-signed, `HttpOnly`, `SameSite=Lax`, `Secure` in production |
| Opt-in and unsubscribe tokens | Stored hashed; plaintext exists only in the email |
| Rate limiting | Per-tenant on ingest and admin; per-IP on newsletter signup |
| Timing | Constant-time comparison for signatures and the operator token |
| Enumeration | Coupon redemption and unsubscribe return identical responses for every failure mode |
| Bots | Filtered from heatmaps, product stats, share verification and click counts |

## Privacy

- IP addresses and user agents are stored as a **per-tenant salted hash**, never
  raw. Enough to count uniques and spot abuse; not enough to re-identify.
- Raw pointer traces are never persisted — only grid aggregates.
- Country comes from a CDN header when present; the platform never geolocates an
  IP itself.
- Newsletter uses double opt-in by default and records the consent source and
  timestamp. Imports preserve the original consent date rather than restamping.
- Automation email checks `marketing_consent` before every send.
- Uninstalling the WordPress plugin deletes its own settings and local pointers,
  and deliberately does **not** delete platform-side points, commissions or
  contacts.

---

## Operator responsibilities

1. **Leave `CLAIM_REFUND_ON_EXPIRY` off** unless you have deployed a contract
   whose `claim()` enforces a deadline. Turning it on against the current
   contract lets a voucher be refunded and then still claimed.
2. **Set `TBAY_REWARD_SUPPLY_CAP_WEI` before mainnet.** L1 cannot mint; an
   unbounded reward programme can promise more than the bridge can honour. See
   [TOKEN.md](TOKEN.md).
3. **Grant `CLAIMER_ROLE` and nothing else** to the platform signing key. It
   should not hold `BRIDGE_ROLE`, `PAUSER_ROLE` or `DEFAULT_ADMIN_ROLE`.
4. **Keep `IDENTITY_SALT` stable.** Changing it un-links every member across
   retailers.
5. **Rotate API secrets** with `key:issue` then `key:revoke` — both keys work
   during the overlap.
6. **Guard the bridge operator token.** It is the only thing standing between a
   request and a recorded L1 release.
7. **Use `EMAIL_TRANSPORT=smtp` in production.** The `log` transport writes
   message bodies to the application log.
8. **Size `TBAY_TENANT_MINT_PER_WINDOW_WEI` for your busiest retailer.** It is
   what stops one store's misconfigured conversion rate consuming the hourly
   mint allowance every other store's customers redeem against. Setting it to
   `0` removes that protection, which is correct only when a single retailer
   runs on the deployment.
9. **Issue narrow keys.** The first key a tenant has must be an owner key —
   there is nobody to issue the second otherwise — but a reporting script, a
   storefront integration and a support contractor should each hold the
   narrowest role that does their job. `key:issue --role readonly` or
   `POST /v1/keys` with a role.
10. **Keep tenant timezones to IANA names.** The platform validates them at
   tenant creation; a zone written straight into the database is checked at
   award time and falls back to UTC, which silently shifts every daily cap.

---

## Who may do what

A secret key carries a **role**, and one hook enforces it for every route —
`preHandler` on the root instance, after each plugin's `onRequest`
authentication and before any handler runs. A check written per route is one
somebody forgets on the route they add next month, and nobody notices until the
support contractor deletes a customer.

Anything the rule list does not name falls to the default: a read needs
`readonly`, a write needs `manager`. A route added later is protected before
anybody remembers it exists.

| Role | May |
|---|---|
| `owner` | Everything, including operators, keys and settings |
| `manager` | Every operational change: points, rules, badges, broadcasts, erasure, merge |
| `support` | Read everything; adjust a balance, award a badge, set a field or preference |
| `readonly` | Read |

A key takes the narrower of its own role and its operator's, and a key with
neither reads as `owner` — so nothing about this upgrade takes an existing
integration offline. A disabled operator's keys stop authenticating.

Every mutating request is recorded to an append-only audit log: who, what, the
outcome status, who it was about, and a short allow-list of request fields.
Refusals are recorded as well as changes. A failed audit write never fails the
request.

---

## Tenant isolation

A retailer's API key reaches that retailer's data and nothing else. Two layers
enforce it, deliberately:

- **Every query is tenant-scoped**, including the joins. A contact join matches
  on `(id, tenant_id)`, not on `id` alone — otherwise a ledger row naming
  another tenant's contact would hand the caller that stranger's name and
  email.
- **Composite foreign keys**, `(contact_id, tenant_id) -> contacts (id,
  tenant_id)`, on the fifteen tables that hold money, a claim on the retailer,
  or personal data. An endpoint that forgets to resolve a caller-supplied
  contact id against the tenant gets a constraint violation rather than quietly
  writing across the boundary.

Contact ids supplied in a request body are resolved against the calling
tenant *before* anything is written, not after — a check that runs once the
transaction has committed reports an error while the rows persist.

## What a public site key can and cannot do

The public key sits in every page's source, so what it can reach is the
platform's real anonymous attack surface. It can identify a contact by email,
subscribe them to a list, and record events. It **cannot** write reserved
contact attributes: `roles` in particular drives reward exclusions, so a
visitor who could set it could clear an excluded staff account's exclusion, or
set one on a customer's address to stop them earning. Reserved keys are
dropped from public writes; the secret-key `/v1/contacts` endpoint still writes
them.

Separately, anything that is not a JSON array in `attributes.roles` reads as no
roles at all, wherever it came from. A retailer's own integration can still
write a bad value; it cannot turn that into an exception in the middle of a
customer's checkout.

## Reporting a vulnerability

Email security@tbay.tk. Please do not open a public issue.

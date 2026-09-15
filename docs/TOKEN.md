# TBAY token economics and mechanics

How points become tokens, how tokens become store credit, and how tokens get
back to Ethereum — plus the supply arithmetic that keeps all of it solvent.

---

## The two contracts

| | L1 (Ethereum) | L2 (zkSync Era) |
|---|---|---|
| Address | `0xC17e078E914aB6023dd48831358067d428409116` | `0x74eb73ACa939Fc911f79D9589e808f0207684D09` |
| Decimals | **9** | **18** |
| Supply | **Fixed 1,000,000**, minted once in the constructor | `MAX_SUPPLY` of **100,000,000** |
| Mint function | **None.** Not even the owner can create tokens | `claim()`, `bridgeMint()`, `crosschainMint()` |
| Burn function | **None** | `crosschainBurn()`, `ERC20Burnable` |
| Contract | plain `ERC20 + Ownable` | `ERC20 + Burnable + Pausable + Permit + AccessControl + IERC7802` |

The decimal gap is deliberate and the bridge scales by `10^9` in both
directions. `TBAYL2.getL1Info()` returns `(l1Address, 9, 18)`, which matches.

### The constraint that shapes everything

**L1 cannot mint.** The entire 1,000,000 supply exists already, and there is no
function — owner-gated or otherwise — that can create more. So every L2→L1
withdrawal is a *release from a reserve someone already holds*, never a mint.

Meanwhile L2 *can* mint, up to 100,000,000. That is 100× the L1 supply.

Left unbounded, a successful rewards programme would issue L2 tokens that
collectively have a claim on an L1 reserve one hundred times too small. The
first holders to bridge would be fine; the last would find nothing there.

---

## The supply budget

`TBAY_REWARD_SUPPLY_CAP_WEI` is the lifetime ceiling, in wei, on reward tokens
the platform will ever issue. It is the control that ties L2 issuance to L1
reality.

```
TBAY_REWARD_SUPPLY_CAP_WEI=1000000000000000000000000   # the full 1,000,000
TBAY_REWARD_SUPPLY_CAP_WEI=0                           # unlimited (testnet only)
```

Set it to the L1 reserve you actually hold for bridging, minus anything already
circulating on L2 that could bridge (the L2 constructor minted 1,000,000 to the
deployer wallet on day one — those count).

```
reward budget  =  L1 tokens held for bridging
                − L2 tokens already circulating that could bridge
```

Every redemption books against the budget before a voucher is signed. When it is
exhausted, redemption fails with a clear message for the person redeeming — which
is the right place for the failure to land, rather than on whoever tries to
withdraw last. An expired voucher returns its budget.

`GET /health` and the dashboard's Bridge tab both show current headroom.

The platform *separately* mirrors the contract's own hourly cap
(`MAX_MINT_PER_WINDOW`, 100,000 TBAY/hour) so it never signs a voucher the chain
would reject with `RateLimitExceeded`.

---

## Points → TBAY

Default rate: **100 points = 1 TBAY**, overridable per retailer via
`settings.pointsPerToken`.

```
        redeem(points)
              │
              ▼
   ┌──────────────────────────────┐
   │ 1. Reserve hourly mint quota │  mirrors the contract's rate limit
   │ 2. Reserve supply budget     │  the L1-solvency guard
   │ 3. Debit points (locked row) │  fails loudly rather than going negative
   │ 4. Sign EIP-712 voucher      │  CLAIMER_ROLE key; signing only, no gas
   └──────────────────────────────┘
              │
              ▼
   customer's wallet calls
   TBAYL2.claim(amount, nonce, signature)
```

**The platform never sends the transaction.** It signs; the customer's own wallet
submits and pays the gas. So the platform holds no funds on the redemption path,
and a voucher that is never submitted simply expires — the points are returned
and the budget released.

### The voucher

The contract builds its digest with `ERC20Permit`'s `_hashTypedDataV4`:

```
domain = { name: "Thunder Bay Token", version: "1",
           chainId: <L2 chain>, verifyingContract: <L2 address> }

Claim(address user, uint256 amount, uint256 nonce)
```

A signature therefore authorises exactly one `(user, amount, nonce)` triple on
exactly one chain and contract. It is worthless to anyone else: the contract
recovers the signer, checks `CLAIMER_ROLE`, and the `user` field is the only
address that can be credited. `isNonceUsed` gives replay protection on-chain, and
the platform additionally enforces uniqueness with a database constraint on
`(chain_id, contract_address, nonce)`.

Bounds mirrored from the contract so customers get readable errors instead of
reverted transactions:

| Bound | Value |
|---|---|
| Minimum claim | `1e15` wei (0.001 TBAY) |
| Maximum claim | `1e4 * 1e18` wei (10,000 TBAY) |
| Hourly mint window | `1e5 * 1e18` wei (100,000 TBAY) |
| Voucher presented as current for | 60 minutes (`CLAIM_TTL_MINUTES`) |

### Vouchers do not expire on-chain

`claim()` takes no deadline, so a signature stays valid forever. The platform
therefore **never refunds an aged-out voucher** — doing so would let someone
collect the refund and still mint. An aged-out voucher stays claimable and
appears in `GET /v1/token/claims/outstanding` so the member can submit it later.

**The fix belongs in the contract.** A v2 `Claim` struct should carry a
`deadline` that `claim()` enforces:

```solidity
bytes32 claimTypeHash =
    keccak256("Claim(address user,uint256 amount,uint256 nonce,uint256 deadline)");
if (block.timestamp > deadline) revert ClaimExpired();
```

With that deployed, set `CLAIM_REFUND_ON_EXPIRY=true` and expiry becomes safe.

### Supply modes

| Mode | How tokens arrive | Trade-off |
|---|---|---|
| `mint` (default) | Customer calls `claim()`, minting new L2 supply | No platform funds at risk; inflates L2 supply against the cap |
| `treasury` | Platform transfers from a pre-funded wallet | Non-inflationary and visibly budgeted on-chain; needs a hot wallet with gas |

In `treasury` mode the on-chain send happens strictly **after** the ledger
transaction commits, and a failed transfer returns the points and releases the
budget. Sending inside the transaction would risk delivering tokens against a
rolled-back debit — the one direction that cannot be undone.

---

## TBAY → store credit

TBAY spends at **any** retailer on the network.

```
1. Customer opens a spend intent for N TBAY at retailer R
2. Platform quotes the credit and returns R's payout wallet
3. Customer transfers TBAY to that wallet from their own
4. Customer submits the tx hash
5. Platform verifies the Transfer on-chain — right sender, right recipient,
   enough value, enough confirmations
6. Store credit is issued
```

Credit is never granted on the customer's say-so, and `(chain_id, tx_hash)` is
unique, so one payment can only ever buy one credit.

**Pricing is a network floor plus an optional retailer bonus.** The platform sets
`CREDIT_CENTS_PER_TOKEN` and every retailer honours at least that, so a customer
always knows the minimum their TBAY is worth anywhere. A retailer may set
`settings.creditBonusBps` to offer *more* — there is no configuration that puts a
retailer below the network rate.

---

## L2 → L1 bridging

```
1. Platform quotes the withdrawal, showing exactly what will cross and what
   will not (see dust, below)
2. Customer's wallet calls crosschainBurn(theirAddress, amount) on L2
3. Platform verifies the burn on-chain — a Transfer to the zero address FROM
   the address claiming it
4. A withdrawal is recorded as burn_verified
5. The bridge operator releases L1 tokens from reserve and records the tx
```

Two things the platform refuses, by design:

- a burn it has not seen on-chain, and
- a burn performed by an address other than the one claiming it.

Either would let one person withdraw against another's burn. `(l2_chain_id,
burn_tx_hash)` is unique, so one burn funds one withdrawal, and a resubmission
cannot redirect an existing withdrawal to a new recipient.

Releasing on L1 is an assertion the platform cannot verify from L2, so it sits
behind a separate `BRIDGE_OPERATOR_TOKEN` rather than any retailer's API secret.

### Dust

L1 has 9 decimals, L2 has 18. Anything below `1e9` wei — a billionth of a
token — has no L1 representation and cannot cross. `crosschainBurn` sweeps that
remainder to the treasury wallet rather than silently rounding it into the
bridged amount.

The quote endpoint returns the exact dust amount and a plain-language note, and
the storefront shows both **before** the customer signs anything.

---

## Chains

| Chain | ID | Hex | Role |
|---|---|---|---|
| zkSync Sepolia | 300 | `0x12c` | Pre-launch (current default) |
| zkSync Era | 324 | `0x144` | Mainnet at launch |
| Ethereum | 1 | `0x1` | L1 TBAY |

`GET /v1/config` returns full `wallet_addEthereumChain` parameters, so a wallet
that has never seen zkSync can add it in one prompt instead of dead-ending.

## thirdweb

Set `THIRDWEB_CLIENT_ID` to enable thirdweb Connect in the storefront, which adds
in-app wallets, social login and smart accounts for customers who have never
installed MetaMask. Without it the UI falls back to the injected EIP-1193
provider and everything still works.

The L2 contract exposes `contractURI()` for thirdweb dashboards, and
`/v1/config` returns the thirdweb chain slug and a direct contract link.

---

## Launch checklist

- [ ] Confirm `0xC17e…9116` is verified on Etherscan and `decimals()` really is 9
- [ ] Decide the L1 bridge reserve and set `TBAY_REWARD_SUPPLY_CAP_WEI`
- [ ] Move the reserve to a wallet the bridge operator controls
- [ ] Switch `TBAY_CHAIN_ID` to 324 and deploy the L2 contract to Era mainnet
- [ ] Grant `CLAIMER_ROLE` to the platform signing key; grant nothing else
- [ ] Consider redeploying L2 with a `deadline` in the Claim struct, so unclaimed
      vouchers can be safely refunded
- [ ] Set `BRIDGE_OPERATOR_TOKEN` and rehearse a release end to end
- [ ] Decide `mint` vs `treasury` and, for treasury, fund the wallet with gas
- [ ] Set the network `CREDIT_CENTS_PER_TOKEN`

# TBAY token economics and mechanics

How points become tokens, how tokens become store credit, and how tokens get
back to Ethereum — plus the supply arithmetic that keeps all of it solvent.

---

## Verified on-chain

Read from Ethereum mainnet, not assumed from source:

```
0xC17e078E914aB6023dd48831358067d428409116
  name()          Thunder Bay Token
  symbol()        TBAY
  decimals()      9
  totalSupply()   1,000,000 TBAY          (1000000000000000 base units)
  owner()         0x33ea3c51…ccdee
  bytecode        2,614 bytes

  mint(address,uint256)       absent
  burn(uint256)               absent
  burnFrom(address,uint256)   absent
  pause()                     absent
  renounceOwnership()         absent
  transferOwnership(address)  present
```

Two things worth saying plainly about that:

**The owner has no power over the token.** `TBAY` declares no `onlyOwner`
functions at all, so ownership confers nothing but the title. The owner cannot
mint, burn, pause, freeze or blacklist. That is unusually good for holder
confidence — worth saying so publicly.

**`renounceOwnership` was removed** from the OpenZeppelin `Ownable` copy, so
`owner()` will always return an address. Some token scanners flag "ownership not
renounced" as a risk; here it is cosmetic, because there is nothing to renounce
power over.

## The two contracts

| | L1 (Ethereum) | L2 (zkSync Era) |
|---|---|---|
| Address | `0xC17e078E914aB6023dd48831358067d428409116` | `0x74eb73ACa939Fc911f79D9589e808f0207684D09` |
| Decimals | **9** | **18** |
| Supply | **Fixed 1,000,000**, minted once in the constructor | `MAX_SUPPLY` of **100,000,000** |
| Mint function | **None.** Not even the owner can create tokens | `claim()`, `bridgeMint()`, `crosschainMint()` |
| Burn function | **None** | `crosschainBurn()`, `ERC20Burnable` |
| Contract | plain `ERC20 + Ownable` | `ERC20 + Burnable + Pausable + Permit + AccessControl + IERC7802` |

The decimal gap is deliberate and the deployed bridge scales by `10^9` in both
directions. `TBAYL2.getL1Info()` returns `(l1Address, 9, 18)`, which matches.

**`10^9` is a decimal conversion, not an exchange rate.** Nine decimals to
eighteen is exactly `10^9`, so as deployed the bridge is a strict **1 L1 TBAY
⇄ 1 L2 TBAY**. See *The exchange rate* below for what changes if the L2 supply
is meant to be larger than the L1 supply.

### The constraint that shapes everything

**L1 cannot mint.** The entire 1,000,000 supply exists already, and there is no
function — owner-gated or otherwise — that can create more. So every L2→L1
withdrawal is a *release from a reserve someone already holds*, never a mint.

Meanwhile L2 *can* mint, up to 100,000,000. That is 100× the L1 supply.

Left unbounded, a successful rewards programme would issue L2 tokens that
collectively have a claim on an L1 reserve one hundred times too small. The
first holders to bridge would be fine; the last would find nothing there.

---

## The exchange rate

`TBAY_BRIDGE_L2_PER_L1` is how many whole L2 TBAY one whole L1 TBAY is worth.

```
TBAY_BRIDGE_L2_PER_L1=1        # default; matches the contract as deployed
TBAY_BRIDGE_L2_PER_L1=10000    # 10,000 L2 TBAY = 1 L1 TBAY
```

The number falls out of the two supplies. If every L2 token has to be
redeemable, then:

```
rate  =  total L2 supply  ÷  L1 tokens held for bridging
```

So a 10,000,000,000 L2 supply against the whole 1,000,000 L1 supply gives:

```
10,000,000,000  ÷  1,000,000  =  10,000
```

**Yes — at that rate 10,000 L2 TBAY buys 1 L1 TBAY**, and the full 10 billion
L2 is exactly backed by the full 1 million L1. Burn 10,000 on zkSync, receive 1
on Ethereum.

The rate is a *policy* number, not a law of the contracts. A smaller L2 supply,
or a decision to back only part of it, moves it. What cannot move is the
inequality the platform enforces:

```
total L2 supply  ≤  rate  ×  L1 tokens held for bridging
```

`TBAY_L1_RESERVE_TOKENS` is the right-hand side — how many of the 1,000,000 L1
TBAY are actually set aside for bridging. Left at `0` the platform assumes the
full supply. At boot, preflight checks the inequality against
`TBAY_REWARD_SUPPLY_CAP_WEI` and refuses to pretend if it does not hold
(`reserve_exceeds_l1_supply`, `cap_exceeds_backing`).

### The deployed contract does not implement a rate

This matters before anyone sets `10000` in production:

```solidity
// TBAY-L2-1-0-1.sol — as deployed
uint256 private constant MAX_SUPPLY = 100_000_000 * 1e18;   // 100M ceiling
function bridgeMint(...)     { uint256 l2Amount = l1Amount * 10**9; }
function crosschainBurn(...) { uint256 l1Amount = _amount / 10**9; }
```

`10**9` is the decimal conversion and nothing else, so the chain performs a 1:1
swap no matter what the platform is configured to quote. And `MAX_SUPPLY` caps
L2 at 100,000,000 — **10 billion cannot be minted at all**.

Two constants make the 10,000:1 design real, and both need a redeploy:

```solidity
uint256 private constant MAX_SUPPLY = 10_000_000_000 * 1e18;   // was 100_000_000
uint256 private constant L2_PER_L1  = 10_000;                  // new

// bridgeMint:      l2Amount = l1Amount * 10**9 * L2_PER_L1;
// crosschainBurn:  l1Amount = _amount / (10**9 * L2_PER_L1);
```

Until that ships, setting `TBAY_BRIDGE_L2_PER_L1` above `1` logs a
`bridge_rate_not_one` warning at boot: the platform would be quoting a
conversion the chain will not perform, and every withdrawal would release the
wrong amount of L1.

### What the rate does to precision

One L1 base unit is the smallest thing that can cross. In L2 wei that is
`rate × 10^9`:

| Rate | Minimum bridgeable L2 | In L1 |
|---|---|---|
| 1 | `1e9` wei = 0.000000001 TBAY | 0.000000001 TBAY |
| 10,000 | `1e13` wei = 0.00001 TBAY | 0.000000001 TBAY |

Anything below that floor is dust — see below.

---

## The supply budget

`TBAY_REWARD_SUPPLY_CAP_WEI` is the lifetime ceiling, in wei, on reward tokens
the platform will ever issue. It is the control that ties L2 issuance to L1
reality.

```
TBAY_REWARD_SUPPLY_CAP_WEI=1000000000000000000000000   # the full 1,000,000
TBAY_REWARD_SUPPLY_CAP_WEI=0                           # unlimited (testnet only)
```

Set it to what the L1 reserve you actually hold can back at the configured
rate, minus anything already circulating on L2 that could bridge (the L2
constructor minted 1,000,000 to the deployer wallet on day one — those count).

```
reward budget  =  rate × L1 tokens held for bridging
                − L2 tokens already circulating that could bridge
```

`TBAY_L1_RESERVE_TOKENS` tells preflight the first term so it can check the
arithmetic for you at boot instead of leaving it to a spreadsheet. At the
default rate of 1 the two numbers are the same; at 10,000:1 a 1,000,000 reserve
backs 10,000,000,000 L2.

### The arithmetic today

All 1,000,000 L1 TBAY sit in the treasury wallet; none are circulating. So the
maximum possible reserve is the full supply:

```
TBAY_REWARD_SUPPLY_CAP_WEI=1000000000000000000000000   # 1,000,000 TBAY
```

**But the L2 contract's constructor mints another 1,000,000 to the deployer:**

```solidity
// TBAY-L2-1-0-1.sol:144
_mint(myWallet, 1_000_000 * 10**18);
```

Those L2 tokens can be bridged to L1 and draw on the same reserve. If that line
ships unchanged to Era mainnet, the constructor alone consumes the entire L1
backing capacity and the reward budget is **zero** before a single point is
redeemed.

Three ways out, in rough order of preference:

1. **Drop or shrink the constructor mint** before deploying to Era mainnet. The
   L2 supply then grows only as rewards are earned, and every L2 token is backed
   1:1 by held L1. Cleanest story, and it needs a one-line contract change.
2. **Treat the constructor mint as the reward pool.** Deploy as-is, run
   `TBAY_SUPPLY_MODE=treasury` so redemptions transfer from that 1,000,000
   instead of minting, and never bridge it. Rewards are then non-inflationary
   and visibly budgeted on-chain. No contract change, but the platform needs a
   funded hot wallet.
3. **Split the L1 million explicitly.** Decide how much is bridge reserve (say
   600,000) and how much is treasury, set `TBAY_L1_RESERVE_TOKENS` to the
   reserve, set the cap to what it backs, and accept that the L2 constructor
   mint is not fully bridgeable.

At a 10,000:1 rate the problem mostly evaporates: the constructor's 1,000,000
L2 is a claim on just **100 L1 TBAY**, or 0.01% of the reserve, so option 1
stops being urgent. The discipline survives the rate change though — total L2
supply divided by the rate still has to fit inside the L1 held for bridging,
and that is the inequality preflight enforces.

The platform refuses to pretend either way: booting on a mainnet chain with no
cap set logs an `uncapped_on_mainnet` error and `/health` reports
`status: "misconfigured"`.

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

### Dust, and the wrapper that recovers it

L1 has 9 decimals, L2 has 18, so the smallest thing that can cross is one L1
base unit — `rate × 10^9` wei on L2. A burn of any other amount carries a
remainder with no L1 representation.

`crosschainBurn` is the wrapper that handles it, in one transaction:

```solidity
uint256 l1Amount   = _amount / 10**9;        // whole units that can cross
uint256 burnAmount = l1Amount * 10**9;
uint256 dust       = _amount - burnAmount;

_burn(_from, burnAmount);                     // leaves L2 supply, releases L1
if (dust > 0) _transfer(_from, TREASURY_WALLET, dust);
```

So the remainder is **not** burned and **not** stranded — it moves back into the
company's L2 supply at `TREASURY_WALLET`
(`0x33ea3C510337dC8F7938e2aB2b4678F2bc9ccdEE`), where it can be reissued as
rewards. Total L2 supply falls by exactly the bridged amount and not a wei more,
which is what keeps the backing inequality above exact.

**The client therefore submits the full requested amount, not the rounded-down
one.** Passing `bridgeableWei` would skip the sweep and leave an unspendable
crumb in the holder's wallet; passing `amountWei` lets the contract do the job it
was written to do.

Verification mirrors this: `recordWithdrawal` looks for the burn leg (a Transfer
to the zero address from the declared wallet) and separately sums the non-burn
legs from the same wallet as the dust, so the recorded `dust_wei` is what the
chain actually moved rather than what the quote predicted.

The quote endpoint returns the exact dust amount and a plain-language note, and
the storefront shows both **before** the customer signs anything — rendered at
full 18-decimal precision, since dust is by definition smaller than the bridge
unit and any shorter display would read as a misleading `0`.

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
- [ ] Decide the L1 bridge reserve and set `TBAY_L1_RESERVE_TOKENS`
- [ ] Decide the L2:L1 rate, set `TBAY_BRIDGE_L2_PER_L1`, and make sure the
      deployed L2 contract applies the *same* rate in `bridgeMint` and
      `crosschainBurn` — it does not by default
- [ ] Set `TBAY_REWARD_SUPPLY_CAP_WEI` to what the reserve backs at that rate
- [ ] Move the reserve to a wallet the bridge operator controls
- [ ] Switch `TBAY_CHAIN_ID` to 324 and deploy the L2 contract to Era mainnet
- [ ] Grant `CLAIMER_ROLE` to the platform signing key; grant nothing else
- [ ] Consider redeploying L2 with a `deadline` in the Claim struct, so unclaimed
      vouchers can be safely refunded
- [ ] Set `BRIDGE_OPERATOR_TOKEN` and rehearse a release end to end
- [ ] Decide `mint` vs `treasury` and, for treasury, fund the wallet with gas
- [ ] Set the network `CREDIT_CENTS_PER_TOKEN`

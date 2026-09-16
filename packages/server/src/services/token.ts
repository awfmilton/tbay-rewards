import { randomBytes } from 'node:crypto';
import { db, queryOne, withTransaction, type Queryable } from '../db/pool.js';
import { config } from '../config.js';
import { ApiError } from '../lib/errors.js';
import {
  assertAddress,
  chain,
  claimSigner,
  tokensToWei,
  treasurySender,
  weiToTokenString,
} from '../lib/chain.js';
import { getBalance, reverse, spend, type Balance } from './points.js';
import { randomCode } from '../lib/crypto.js';
import type { Tenant } from './tenants.js';
import type { Contact } from './contacts.js';

/**
 * Points → TBAY, and TBAY → store credit.
 *
 * Redemption never sends a transaction. The platform debits points and signs an
 * EIP-712 voucher; the customer's own wallet calls TBAYL2.claim(amount, nonce,
 * signature) and pays the gas. That keeps the platform off the critical path and
 * means a failed or abandoned claim costs nothing — the voucher simply expires
 * and the points are returned.
 */

export interface TokenClaim {
  id: string;
  tenant_id: string;
  contact_id: string;
  member_id: string | null;
  points_spent: number;
  token_amount_wei: string;
  chain_id: number;
  contract_address: string;
  wallet_address: string;
  nonce: string;
  signature: string;
  status: 'signed' | 'claimed' | 'expired' | 'cancelled';
  ledger_entry_id: string | null;
  tx_hash: string | null;
  expires_at: Date;
  /** When the reconcile sweep last asked the chain about this voucher. */
  last_checked_at: Date | null;
  created_at: Date;
}

export interface RedeemInput {
  contact: Contact;
  points: number;
  walletAddress: string;
}

export interface RedeemResult {
  claim: TokenClaim;
  /**
   * How the tokens reach the customer.
   *   'wallet_claim'      — they submit the signed voucher themselves (default).
   *   'treasury_transfer' — the platform already sent them; nothing to sign.
   */
  delivery: 'wallet_claim' | 'treasury_transfer';
  /** Everything the browser needs to call claim(). Null in treasury mode. */
  transaction: {
    chainId: number;
    contractAddress: string;
    method: 'claim';
    args: { amount: string; nonce: string; signature: string };
    amountTokens: string;
  } | null;
  /** Set in treasury mode once the transfer is on-chain. */
  txHash: string | null;
  amountTokens: string;
  balance: { balance: number; pending: number };
}

function pointsPerToken(tenant: Tenant): number {
  const override = tenant.settings?.pointsPerToken;
  const value = typeof override === 'number' && override > 0 ? override : config().rewards.pointsPerToken;
  return value;
}

/** Points → wei, floor-divided so we never mint more than the points bought. */
export function quote(tenant: Tenant, points: number): bigint {
  const rate = pointsPerToken(tenant);
  const whole = Math.floor(points / rate);
  const remainderPoints = points - whole * rate;
  // Keep the sub-token remainder at full precision instead of dropping it.
  const fractionWei = (BigInt(remainderPoints) * 10n ** 18n) / BigInt(rate);
  return BigInt(whole) * 10n ** 18n + fractionWei;
}

/** A uint256 nonce with enough entropy that collisions are not a concern. */
function mintNonce(): bigint {
  return BigInt('0x' + randomBytes(32).toString('hex'));
}

export async function redeemPointsForTokens(
  tenant: Tenant,
  input: RedeemInput,
  runner?: Queryable,
): Promise<RedeemResult> {
  const cfg = config();
  const wallet = assertAddress(input.walletAddress, 'wallet_address');

  if (!Number.isInteger(input.points) || input.points <= 0) {
    throw ApiError.badRequest('points must be a positive integer');
  }
  if (input.points < cfg.rewards.minRedeemPoints) {
    throw ApiError.unprocessable(
      `Minimum redemption is ${cfg.rewards.minRedeemPoints} points`,
      { minimum: cfg.rewards.minRedeemPoints },
    );
  }

  const amountWei = quote(tenant, input.points);
  const minWei = BigInt(cfg.chain.minClaimWei);
  const maxWei = BigInt(cfg.chain.maxClaimWei);

  // These bounds are enforced by the contract itself (AmountOutOfBounds); check
  // them here so the customer gets a readable error instead of a failed tx.
  if (amountWei < minWei) {
    throw ApiError.unprocessable('Redemption is below the contract minimum', {
      amount_wei: amountWei.toString(),
      minimum_wei: minWei.toString(),
    });
  }
  if (amountWei > maxWei) {
    throw ApiError.unprocessable('Redemption exceeds the per-claim contract maximum', {
      amount_wei: amountWei.toString(),
      maximum_wei: maxWei.toString(),
    });
  }

  // Treasury mode delivers tokens directly, so it needs no CLAIMER_ROLE signer.
  const signer = cfg.chain.supplyMode === 'treasury' ? null : claimSigner();

  const run = async (client: Queryable): Promise<RedeemResult> => {
    await reserveMintCapacity(client, amountWei);
    await reserveSupplyBudget(client, amountWei);

    const debit = await spend(
      tenant.id,
      {
        contactId: input.contact.id,
        points: input.points,
        reason: 'Redeemed for TBAY',
        refType: 'token_claim',
        refId: wallet,
        // Keyed on the exact operation — contact, amount and destination — so a
        // double-submitted form is idempotent while two DIFFERENT redemptions
        // in the same second get distinct keys instead of colliding.
        idempotencyKey: `redeem:${input.contact.id}:${input.points}:${wallet.toLowerCase()}:${Math.floor(
          Date.now() / 1000,
        )}`,
        meta: { wallet_address: wallet, amount_wei: amountWei.toString() },
      },
      client,
    );

    // A replayed submission must not produce a second voucher against one debit.
    // Without this, concurrent redemptions that share an idempotency key would
    // each go on to sign a claim while only the first actually spent points.
    if (!debit.created) {
      throw ApiError.conflict(
        'A redemption for this amount is already in flight. Check your rewards history before trying again.',
      );
    }

    const nonce = mintNonce();
    const signature = signer
      ? await signer.signClaim(
          { user: wallet, amount: amountWei, nonce },
          cfg.chain.chainId,
          cfg.chain.l2Contract,
        )
      : '';

    const claim = await queryOne<TokenClaim>(
      client,
      `INSERT INTO token_claims (
         tenant_id, contact_id, member_id, points_spent, token_amount_wei, chain_id,
         contract_address, wallet_address, nonce, signature, ledger_entry_id, supply_mode, expires_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $13, now() + ($12 || ' minutes')::interval)
       RETURNING *`,
      [
        tenant.id,
        input.contact.id,
        input.contact.member_id,
        input.points,
        amountWei.toString(),
        cfg.chain.chainId,
        cfg.chain.l2Contract.toLowerCase(),
        wallet.toLowerCase(),
        nonce.toString(),
        signature,
        debit.entry.id,
        String(cfg.rewards.claimTtlMinutes),
        cfg.chain.supplyMode,
      ],
    );

    return {
      claim: claim!,
      delivery: cfg.chain.supplyMode === 'treasury' ? 'treasury_transfer' : 'wallet_claim',
      transaction:
        cfg.chain.supplyMode === 'treasury'
          ? null
          : {
              chainId: cfg.chain.chainId,
              contractAddress: cfg.chain.l2Contract,
              method: 'claim',
              args: { amount: amountWei.toString(), nonce: nonce.toString(), signature },
              amountTokens: weiToTokenString(amountWei),
            },
      txHash: null,
      amountTokens: weiToTokenString(amountWei),
      balance: { balance: debit.balance.balance, pending: debit.balance.pending },
    };
  };

  const result = runner ? await run(runner) : await withTransaction(run);

  if (result.delivery !== 'treasury_transfer') return result;

  // The on-chain send happens strictly AFTER the ledger transaction commits.
  // Sending inside the transaction would risk a rollback that leaves tokens
  // delivered but points un-spent, which is the one direction we cannot undo.
  return deliverFromTreasury(result, wallet, amountWei, tenant.id);
}

/**
 * Announce a settled claim.
 *
 * `token.claimed` was a declared trigger type nothing ever fired, so "email
 * them when their tokens land" could not be built. Both paths that mark a
 * claim settled — the treasury transfer and the on-chain nonce sweep — come
 * through here, so neither can quietly skip it.
 *
 * Never allowed to throw: the tokens are already delivered by this point, and
 * a broken automation must not turn a successful redemption into an error.
 */
async function announceClaimed(
  tenantId: string,
  claim: Pick<TokenClaim, 'id' | 'contact_id' | 'token_amount_wei'> & { tx_hash?: string | null },
  runner: Queryable = db(),
): Promise<void> {
  try {
    const { fire } = await import('./automations.js');
    const { getContact } = await import('./contacts.js');
    await fire(
      tenantId,
      'token.claimed',
      {
        contact: claim.contact_id ? await getContact(tenantId, claim.contact_id, runner) : null,
        data: {
          claim_id: claim.id,
          amount_wei: claim.token_amount_wei,
          amount_tokens: weiToTokenString(BigInt(claim.token_amount_wei)),
          tx_hash: claim.tx_hash ?? null,
        },
        dedupeKey: `claim:${claim.id}`,
      },
      runner,
    );
  } catch (err) {
    console.error(
      JSON.stringify({
        level: 'error',
        msg: 'token.claimed automation failed after a successful claim',
        claim_id: claim.id,
        err: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}

/**
 * Send a treasury-funded redemption and settle the record either way.
 *
 * On failure the points are returned and the budget released, so a treasury
 * that runs dry costs the customer nothing.
 */
async function deliverFromTreasury(
  result: RedeemResult,
  wallet: string,
  amountWei: bigint,
  tenantId: string,
): Promise<RedeemResult> {
  try {
    const { txHash } = await treasurySender().transfer(wallet, amountWei);
    await db().query(
      `UPDATE token_claims SET status = 'claimed', tx_hash = $2, claimed_at = now()
        WHERE id = $1`,
      [result.claim.id, txHash],
    );
    await announceClaimed(tenantId, { ...result.claim, tx_hash: txHash });
    return { ...result, txHash, claim: { ...result.claim, status: 'claimed', tx_hash: txHash } };
  } catch (err) {
    await db().query(`UPDATE token_claims SET status = 'cancelled' WHERE id = $1`, [
      result.claim.id,
    ]);
    await releaseSupplyBudget(db(), amountWei);
    if (result.claim.ledger_entry_id) {
      await reverse(tenantId, result.claim.ledger_entry_id, 'Treasury transfer failed');
    }
    throw err instanceof ApiError
      ? err
      : new ApiError(
          503,
          'treasury_transfer_failed',
          'The reward transfer could not be sent. Your points have not been spent.',
        );
  }
}

/**
 * Mirror the contract's hourly mint ceiling.
 *
 * TBAYL2 reverts with RateLimitExceeded once MAX_MINT_PER_WINDOW is minted in an
 * hour. We book capacity when the voucher is signed so the platform never issues
 * more vouchers in a window than the chain will honour.
 */
async function reserveMintCapacity(client: Queryable, amountWei: bigint): Promise<void> {
  const cfg = config();
  const windowMs = cfg.chain.rateLimitWindowSeconds * 1000;
  const windowStart = new Date(Math.floor(Date.now() / windowMs) * windowMs);
  const cap = BigInt(cfg.chain.maxMintPerWindowWei);

  const row = await queryOne<{ minted_wei: string }>(
    client,
    `INSERT INTO token_mint_windows (chain_id, contract_address, window_start, minted_wei)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (chain_id, contract_address, window_start) DO UPDATE
       SET minted_wei = token_mint_windows.minted_wei + EXCLUDED.minted_wei
     RETURNING minted_wei`,
    [cfg.chain.chainId, cfg.chain.l2Contract.toLowerCase(), windowStart, amountWei.toString()],
  );

  if (BigInt(row!.minted_wei) > cap) {
    throw ApiError.tooManyRequests(
      'The TBAY hourly mint allowance is exhausted; please try again shortly',
    );
  }
}

/**
 * Book against the platform's lifetime reward-supply budget.
 *
 * L1 TBAY is a fixed 1,000,000-token supply that is already fully minted, so
 * every reward token that might later be bridged L2→L1 has to be covered by an
 * L1 reserve. Setting TBAY_REWARD_SUPPLY_CAP_WEI to the size of that reserve
 * makes it impossible for the platform to promise more TBAY than the bridge can
 * actually honour — the failure lands here, on the person redeeming, instead of
 * on whoever tries to withdraw last.
 *
 * A cap of '0' disables the check, which is the right setting on a testnet.
 */
async function reserveSupplyBudget(client: Queryable, amountWei: bigint): Promise<void> {
  const cfg = config();
  const cap = BigInt(cfg.chain.rewardSupplyCapWei);
  if (cap <= 0n) return;

  const row = await queryOne<{ issued_wei: string; reversed_wei: string }>(
    client,
    `INSERT INTO token_supply_budget (chain_id, contract_address, issued_wei)
     VALUES ($1, $2, $3)
     ON CONFLICT (chain_id, contract_address) DO UPDATE
       SET issued_wei = token_supply_budget.issued_wei + EXCLUDED.issued_wei,
           updated_at = now()
     RETURNING issued_wei, reversed_wei`,
    [cfg.chain.chainId, cfg.chain.l2Contract.toLowerCase(), amountWei.toString()],
  );

  const outstanding = BigInt(row!.issued_wei) - BigInt(row!.reversed_wei);
  if (outstanding > cap) {
    throw ApiError.unprocessable(
      'The reward token allocation for this period is fully committed. Please try again later.',
      { cap_wei: cap.toString(), committed_wei: outstanding.toString() },
    );
  }
}

/** Give budget back when a voucher expires or is cancelled. */
async function releaseSupplyBudget(client: Queryable, amountWei: bigint): Promise<void> {
  const cfg = config();
  if (BigInt(cfg.chain.rewardSupplyCapWei) <= 0n) return;
  await client.query(
    `UPDATE token_supply_budget
        SET reversed_wei = reversed_wei + $3, updated_at = now()
      WHERE chain_id = $1 AND contract_address = $2`,
    [cfg.chain.chainId, cfg.chain.l2Contract.toLowerCase(), amountWei.toString()],
  );
}

/** Reward-supply headroom, for the operator dashboard and health checks. */
export async function supplyStatus(runner: Queryable = db()): Promise<{
  mode: string;
  cap_wei: string;
  committed_wei: string;
  remaining_wei: string | null;
}> {
  const cfg = config();
  const row = await queryOne<{ issued_wei: string; reversed_wei: string }>(
    runner,
    `SELECT issued_wei, reversed_wei FROM token_supply_budget
      WHERE chain_id = $1 AND contract_address = $2`,
    [cfg.chain.chainId, cfg.chain.l2Contract.toLowerCase()],
  );

  const committed = BigInt(row?.issued_wei ?? '0') - BigInt(row?.reversed_wei ?? '0');
  const cap = BigInt(cfg.chain.rewardSupplyCapWei);

  return {
    mode: cfg.chain.supplyMode,
    cap_wei: cap.toString(),
    committed_wei: committed.toString(),
    remaining_wei: cap > 0n ? (cap > committed ? cap - committed : 0n).toString() : null,
  };
}

/**
 * Age out vouchers the customer never submitted.
 *
 * Crucially this does NOT return their points by default. The deployed
 * TBAYL2.claim() takes no deadline, so a signed voucher remains valid on-chain
 * forever — refunding on a timer would hand back the points while leaving a
 * live voucher that still mints. The voucher therefore stays claimable and the
 * points stay spent; `outstandingClaims()` surfaces it so the member can submit
 * it whenever they like.
 *
 * Set CLAIM_REFUND_ON_EXPIRY=true only against a contract that enforces a
 * deadline inside claim().
 */
export async function expireStaleClaims(runner: Queryable = db()): Promise<number> {
  const cfg = config();

  const { rows } = await runner.query<TokenClaim>(
    `UPDATE token_claims SET status = 'expired'
      WHERE status = 'signed' AND expires_at <= now()
      RETURNING *`,
  );

  if (!cfg.rewards.refundExpiredClaims) {
    // Nothing is released and nothing is reversed: those tokens can still be
    // minted, so the supply budget stays committed too.
    return rows.length;
  }

  for (const claim of rows) {
    await releaseSupplyBudget(runner, BigInt(claim.token_amount_wei));
    if (!claim.ledger_entry_id) continue;
    const compensation = await reverse(
      claim.tenant_id,
      claim.ledger_entry_id,
      'TBAY claim expired unclaimed',
    );
    if (compensation) {
      await runner.query('UPDATE token_claims SET reversal_entry_id = $2 WHERE id = $1', [
        claim.id,
        compensation.id,
      ]);
    }
  }
  return rows.length;
}

/**
 * Vouchers a member can still submit — signed or aged out, but not yet claimed.
 * Aged-out vouchers are still valid on-chain, so hiding them would lose the
 * customer real tokens.
 */
export async function outstandingClaims(
  tenantId: string,
  contactId: string,
  runner: Queryable = db(),
): Promise<TokenClaim[]> {
  const { rows } = await runner.query<TokenClaim>(
    `SELECT * FROM token_claims
      WHERE tenant_id = $1 AND contact_id = $2
        AND status IN ('signed', 'expired')
        AND reversal_entry_id IS NULL
      ORDER BY created_at DESC`,
    [tenantId, contactId],
  );
  return rows;
}

/**
 * Ask the chain whether outstanding vouchers have been claimed.
 *
 * `isNonceUsed` is the authoritative signal: it is set by claim() itself, so it
 * cannot be forged and does not depend on log retention.
 */
export async function reconcileClaims(limit = 100, runner: Queryable = db()): Promise<number> {
  const client = chain();
  if (!client) return 0;

  // 'expired' is included on purpose: an aged-out voucher is still claimable
  // on-chain, so we keep watching for it rather than losing track of the mint.
  // Ordered by when we last looked, not by age. An expired voucher stays
  // claimable on-chain and is never refunded, so expired rows pile up at the
  // head of a created_at ordering — past `limit` of them, every pass re-checked
  // the same oldest hundred and no newer voucher was ever reconciled. Rotating
  // on last_checked_at gives every open claim a turn.
  const { rows } = await runner.query<TokenClaim>(
    `SELECT * FROM token_claims
      WHERE status IN ('signed', 'expired')
      ORDER BY last_checked_at NULLS FIRST, created_at
      LIMIT $1`,
    [limit],
  );

  if (rows.length > 0) {
    await runner.query(
      'UPDATE token_claims SET last_checked_at = now() WHERE id = ANY($1::uuid[])',
      [rows.map((row) => row.id)],
    );
  }

  let settled = 0;
  for (const claim of rows) {
    let used = false;
    try {
      used = await client.isNonceUsed(BigInt(claim.nonce));
    } catch {
      // An RPC hiccup must not expire a valid voucher; try again next pass.
      continue;
    }
    if (!used) continue;
    const { rowCount } = await runner.query(
      `UPDATE token_claims SET status = 'claimed', claimed_at = now()
        WHERE id = $1 AND status IN ('signed', 'expired')`,
      [claim.id],
    );
    // Only announce a claim this pass actually settled, so a repeated sweep
    // does not re-fire for vouchers already handled.
    if ((rowCount ?? 0) > 0) {
      await announceClaimed(claim.tenant_id, claim, runner);
    }
    settled += 1;
  }
  return settled;
}

/** Let the storefront report the tx hash as soon as the wallet returns it. */
export async function attachClaimTx(
  tenantId: string,
  claimId: string,
  txHash: string,
  // Scoped to the owner: without this, anyone holding a claim id could mark
  // someone else's voucher settled.
  contactId: string,
  runner: Queryable = db(),
): Promise<TokenClaim | null> {
  return queryOne<TokenClaim>(
    runner,
    `UPDATE token_claims
        SET tx_hash = $4,
            status = CASE WHEN status IN ('signed', 'expired') THEN 'claimed' ELSE status END,
            claimed_at = COALESCE(claimed_at, now())
      WHERE tenant_id = $1 AND id = $2 AND contact_id = $3
      RETURNING *`,
    [tenantId, claimId, contactId, txHash],
  );
}

export async function listClaims(
  tenantId: string,
  contactId: string,
  limit = 50,
  runner: Queryable = db(),
): Promise<TokenClaim[]> {
  const { rows } = await runner.query<TokenClaim>(
    `SELECT * FROM token_claims WHERE tenant_id = $1 AND contact_id = $2
      ORDER BY created_at DESC LIMIT $3`,
    [tenantId, contactId, Math.min(limit, 200)],
  );
  return rows;
}

// ─────────────────────────────────────────────────────────────────────────────
// Spending TBAY at any retailer on the network
// ─────────────────────────────────────────────────────────────────────────────

export interface SpendIntent {
  id: string;
  tenant_id: string;
  contact_id: string | null;
  token_amount_wei: string;
  from_address: string;
  to_address: string;
  chain_id: number;
  contract_address: string;
  credit_cents: number;
  currency: string;
  status: 'pending' | 'verified' | 'expired' | 'cancelled';
  tx_hash: string | null;
  expires_at: Date;
}

/**
 * What one whole TBAY is worth as store credit at this retailer.
 *
 * The network rate is a floor every retailer honours, so a customer always
 * knows the minimum their TBAY is worth anywhere. A retailer may add a bonus on
 * top to compete on generosity, but `creditBonusBps` can only ever increase the
 * value — there is no way to configure a retailer below the network rate.
 */
function creditCentsPerToken(tenant: Tenant): number {
  const network = config().rewards.creditCentsPerToken;
  const rawBonus = tenant.settings?.creditBonusBps;
  const bonusBps =
    typeof rawBonus === 'number' && Number.isFinite(rawBonus)
      ? Math.min(100_000, Math.max(0, Math.trunc(rawBonus)))
      : 0;
  return Math.floor((network * (10_000 + bonusBps)) / 10_000);
}

export function quoteCredit(tenant: Tenant, amountWei: bigint): number {
  const perToken = BigInt(Math.trunc(creditCentsPerToken(tenant)));
  return Number((amountWei * perToken) / 10n ** 18n);
}

/**
 * Open an intent to spend TBAY at this retailer.
 *
 * The customer transfers TBAY to the retailer's payout wallet from their own
 * wallet; we then verify that transfer on-chain and issue store credit. Credit
 * is never granted on the customer's say-so.
 */
export async function createSpendIntent(
  tenant: Tenant,
  input: { contact: Contact; amountTokens: number; fromAddress: string },
  runner: Queryable = db(),
): Promise<{ intent: SpendIntent; payTo: string; amountWei: string; creditCents: number }> {
  const payoutWallet = tenant.settings?.payoutWallet;
  if (typeof payoutWallet !== 'string' || payoutWallet.length === 0) {
    throw ApiError.unprocessable('This retailer has not configured a TBAY payout wallet');
  }

  const cfg = config();
  const to = assertAddress(payoutWallet, 'payout wallet');
  const from = assertAddress(input.fromAddress, 'from_address');
  const amountWei = tokensToWei(input.amountTokens);
  if (amountWei <= 0n) throw ApiError.badRequest('amount must be greater than zero');

  const creditCents = quoteCredit(tenant, amountWei);
  if (creditCents <= 0) throw ApiError.unprocessable('Amount is too small to earn store credit');

  const intent = await queryOne<SpendIntent>(
    runner,
    `INSERT INTO token_spend_intents (
       tenant_id, contact_id, member_id, token_amount_wei, from_address, to_address,
       chain_id, contract_address, credit_cents, currency, expires_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now() + ($11 || ' minutes')::interval)
     RETURNING *`,
    [
      tenant.id,
      input.contact.id,
      input.contact.member_id,
      amountWei.toString(),
      from.toLowerCase(),
      to.toLowerCase(),
      cfg.chain.chainId,
      cfg.chain.l2Contract.toLowerCase(),
      creditCents,
      tenant.currency,
      String(cfg.rewards.spendTtlMinutes),
    ],
  );

  return { intent: intent!, payTo: to, amountWei: amountWei.toString(), creditCents };
}

export interface VerifySpendResult {
  intent: SpendIntent;
  credit: { code: string; amount_cents: number; currency: string } | null;
}

/**
 * Verify the on-chain transfer behind a spend intent and issue store credit.
 *
 * Requires a real TBAY Transfer from the declared wallet to the retailer's
 * payout wallet for at least the promised amount. The (chain_id, tx_hash) unique
 * index means one transaction can only ever be redeemed once.
 */
export async function verifySpendIntent(
  tenant: Tenant,
  intentId: string,
  txHash: string,
  opts: { minConfirmations?: number } = {},
): Promise<VerifySpendResult> {
  const client = chain();
  if (!client) throw new ApiError(503, 'chain_unavailable', 'No RPC endpoint configured');

  const intent = await queryOne<SpendIntent>(
    db(),
    `SELECT * FROM token_spend_intents WHERE tenant_id = $1 AND id = $2`,
    [tenant.id, intentId],
  );
  if (!intent) throw ApiError.notFound('Spend intent not found');
  if (intent.status === 'verified') {
    return { intent, credit: null };
  }
  if (intent.status !== 'pending') throw ApiError.unprocessable(`Intent is ${intent.status}`);
  if (new Date(intent.expires_at).getTime() < Date.now()) {
    throw ApiError.unprocessable('Spend intent has expired');
  }

  const transfers = await client.transfersInTx(txHash);
  const required = BigInt(intent.token_amount_wei);
  const minConfirmations = opts.minConfirmations ?? 1;

  const match = transfers.find(
    (transfer) =>
      transfer.from.toLowerCase() === intent.from_address.toLowerCase() &&
      transfer.to.toLowerCase() === intent.to_address.toLowerCase() &&
      transfer.value >= required &&
      transfer.confirmations >= minConfirmations,
  );
  if (!match) {
    throw ApiError.unprocessable('No matching TBAY transfer found in that transaction', {
      expected_to: intent.to_address,
      expected_amount_wei: intent.token_amount_wei,
    });
  }

  return withTransaction(async (tx) => {
    const updated = await queryOne<SpendIntent>(
      tx,
      `UPDATE token_spend_intents
          SET status = 'verified', verified_at = now(), tx_hash = $2
        WHERE id = $1 AND status = 'pending'
        RETURNING *`,
      [intent.id, txHash],
    );
    if (!updated) throw ApiError.conflict('Spend intent was already settled');

    const code = `TBAY-${randomCode(10)}`;
    const credit = await queryOne<{ code: string; amount_cents: number; currency: string }>(
      tx,
      `INSERT INTO store_credits (
         tenant_id, contact_id, code, amount_cents, currency, source, spend_intent_id
       ) VALUES ($1, $2, $3, $4, $5, 'token_spend', $6)
       RETURNING code, amount_cents, currency`,
      [tenant.id, intent.contact_id, code, intent.credit_cents, intent.currency, intent.id],
    );

    const { enqueueWebhook } = await import('./automations.js');
    await enqueueWebhook(tx, tenant.id, 'store_credit_issued', {
      contact_id: intent.contact_id,
      code: credit!.code,
      amount_cents: credit!.amount_cents,
      currency: credit!.currency,
    });

    return { intent: updated, credit: credit! };
  });
}

/**
 * Spend points directly for store credit.
 *
 * myCred lets a customer pay with points at checkout; here that went through a
 * TBAY round trip — redeem points for tokens, connect a wallet, send them, get
 * credit — which is a lot to ask of someone who just wants money off a jumper.
 * This is the short path: points in, a credit code out, no wallet involved.
 *
 * The rate is deliberately the same one TBAY converts at
 * (`CREDIT_CENTS_PER_TOKEN`, plus any retailer bonus), so a customer cannot
 * arbitrage the two routes against each other. Spending points here and
 * spending them via TBAY are worth exactly the same.
 */
export async function redeemPointsForCredit(
  tenant: Tenant,
  contactId: string,
  points: number,
  runner?: Queryable,
): Promise<{ code: string; amount_cents: number; currency: string; balance: Balance }> {
  const cfg = config();

  if (!Number.isInteger(points) || points <= 0) {
    throw ApiError.badRequest('points must be a positive integer');
  }

  const pointsPerToken = Math.max(
    1,
    Number(tenant.settings?.pointsPerToken ?? cfg.rewards.pointsPerToken),
  );
  if (points % pointsPerToken !== 0) {
    throw ApiError.unprocessable(
      `Points convert in blocks of ${pointsPerToken}`,
      { points_per_token: pointsPerToken },
    );
  }

  const bonusBps = Math.max(0, Number(tenant.settings?.creditBonusBps ?? 0));
  const tokens = points / pointsPerToken;
  const amountCents = Math.floor(
    tokens * cfg.rewards.creditCentsPerToken * (1 + bonusBps / 10_000),
  );

  if (amountCents <= 0) {
    throw ApiError.unprocessable('That is not enough points to be worth any credit');
  }

  const run = async (client: Queryable) => {
    // One second of granularity in the key, matching the voucher path: it
    // makes an accidental double-submit idempotent while still letting someone
    // deliberately redeem twice.
    const second = Math.floor(Date.now() / 1000);
    const debit = await spend(
      tenant.id,
      {
        contactId,
        points,
        reason: 'Redeemed for store credit',
        refType: 'store_credit',
        refId: `credit:${second}`,
        idempotencyKey: `credit:${contactId}:${points}:${second}`,
      },
      client,
    );

    // The same guard the voucher path needed: an idempotency hit means the
    // points were never debited a second time, so issuing a second credit
    // would hand out value for free.
    if (!debit.created) {
      throw ApiError.conflict(
        'That redemption was already made. Wait a moment before redeeming again.',
      );
    }

    const code = `PTS-${randomCode(10)}`;
    const credit = await queryOne<{ code: string; amount_cents: number; currency: string }>(
      client,
      `INSERT INTO store_credits (
         tenant_id, contact_id, code, amount_cents, currency, source
       ) VALUES ($1, $2, $3, $4, $5, 'points')
       RETURNING code, amount_cents, currency`,
      [tenant.id, contactId, code, amountCents, tenant.currency],
    );

    const { enqueueWebhook } = await import('./automations.js');
    await enqueueWebhook(client, tenant.id, 'store_credit_issued', {
      contact_id: contactId,
      code: credit!.code,
      amount_cents: credit!.amount_cents,
      currency: credit!.currency,
      source: 'points',
    });

    return { ...credit!, balance: debit.balance };
  };

  return runner ? run(runner) : withTransaction(run);
}

/**
 * What a customer would get for their points, without spending any.
 *
 * The storefront shows this before the button, because "redeem 500 points"
 * means nothing until it says what 500 points buys.
 */
export function creditQuote(
  tenant: Tenant,
  points: number,
): { points: number; amount_cents: number; currency: string; points_per_token: number } {
  const cfg = config();
  const pointsPerToken = Math.max(
    1,
    Number(tenant.settings?.pointsPerToken ?? cfg.rewards.pointsPerToken),
  );
  const bonusBps = Math.max(0, Number(tenant.settings?.creditBonusBps ?? 0));
  const usable = Math.floor(Math.max(0, points) / pointsPerToken) * pointsPerToken;
  const tokens = usable / pointsPerToken;

  return {
    points: usable,
    amount_cents: Math.floor(tokens * cfg.rewards.creditCentsPerToken * (1 + bonusBps / 10_000)),
    currency: tenant.currency,
    points_per_token: pointsPerToken,
  };
}

export async function redeemStoreCredit(
  tenantId: string,
  code: string,
  orderRef: string,
  runner: Queryable = db(),
): Promise<{ amount_cents: number; currency: string } | null> {
  return queryOne<{ amount_cents: number; currency: string }>(
    runner,
    `UPDATE store_credits
        SET status = 'redeemed', redeemed_at = now(), order_ref = $3
      WHERE tenant_id = $1 AND code = $2 AND status = 'active'
        AND (expires_at IS NULL OR expires_at > now())
      RETURNING amount_cents, currency`,
    [tenantId, code, orderRef],
  );
}

export async function walletSummary(
  tenant: Tenant,
  contact: Contact,
): Promise<{
  points: { balance: number; pending: number; lifetime_earned: number; lifetime_spent: number };
  conversion: { points_per_token: number; credit_cents_per_token: number };
  quote_wei: string;
  quote_tokens: string;
  wallet_address: string | null;
  onchain_balance_wei: string | null;
  store_credit_cents: number;
}> {
  const points = await getBalance(tenant.id, contact.id);
  const amountWei = quote(tenant, points.balance);

  let onchain: string | null = null;
  const client = chain();
  if (client && contact.wallet_address) {
    try {
      onchain = (await client.balanceOf(contact.wallet_address)).toString();
    } catch {
      onchain = null;
    }
  }

  const credit = await queryOne<{ total: string }>(
    db(),
    `SELECT COALESCE(SUM(amount_cents), 0) AS total FROM store_credits
      WHERE tenant_id = $1 AND contact_id = $2 AND status = 'active'`,
    [tenant.id, contact.id],
  );

  return {
    points,
    conversion: {
      points_per_token: pointsPerToken(tenant),
      credit_cents_per_token: creditCentsPerToken(tenant),
    },
    quote_wei: amountWei.toString(),
    quote_tokens: weiToTokenString(amountWei),
    wallet_address: contact.wallet_address,
    onchain_balance_wei: onchain,
    store_credit_cents: Number(credit?.total ?? 0),
  };
}

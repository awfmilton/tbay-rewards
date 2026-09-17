import { db, queryOne, withTransaction, type Queryable } from '../db/pool.js';
import { config } from '../config.js';
import { ApiError } from '../lib/errors.js';
import {
  assertAddress,
  chain,
  weiToTokenString,
  withChainTimeout,
  type TokenTransfer,
} from '../lib/chain.js';
import { walletDigest } from '../lib/crypto.js';
import { splitBridgeAmount, txUrl } from '../lib/chains.js';

/**
 * Moving TBAY from zkSync Era (L2) back to Ethereum (L1).
 *
 * The platform never holds anyone's tokens. The holder calls
 * `crosschainBurn(theirAddress, amount)` on the L2 contract from their own
 * wallet — the contract explicitly allows self-burn — and the platform then
 * *verifies the burn on-chain* and records a withdrawal for the L1 bridge
 * operator to release.
 *
 * Two things this code will not do, on purpose:
 *  - accept a burn it has not seen on-chain, and
 *  - accept a burn performed by anyone other than the address claiming it.
 * Both are what would otherwise let one person withdraw against another's burn.
 */

export interface BridgeWithdrawal {
  id: string;
  tenant_id: string | null;
  contact_id: string | null;
  member_id: string | null;
  from_address: string;
  l1_recipient: string;
  l2_amount_wei: string;
  l1_amount: string;
  dust_wei: string;
  l2_chain_id: number;
  l1_chain_id: number;
  burn_tx_hash: string;
  release_tx_hash: string | null;
  status: 'pending' | 'burn_verified' | 'released' | 'rejected';
  rejected_reason: string | null;
  created_at: Date;
}

export const BURN_ADDRESS = '0x0000000000000000000000000000000000000000';

/** What the browser needs to call crosschainBurn itself. */
export function bridgeRate(): bigint {
  return BigInt(Math.max(1, Math.trunc(config().chain.bridgeL2PerL1)));
}

export function withdrawalInstructions(amountWei: bigint): {
  chainId: number;
  contractAddress: string;
  method: 'crosschainBurn';
  amountWei: string;
  bridgeableWei: string;
  bridgeableTokens: string;
  l1Amount: string;
  dustWei: string;
  l2PerL1: string;
  dustNote: string | null;
} {
  const cfg = config();
  const rate = bridgeRate();
  const { l1Amount, burnable, dust } = splitBridgeAmount(amountWei, rate);

  if (l1Amount <= 0n) {
    // The smallest bridgeable amount is one L1 base unit's worth of L2.
    throw ApiError.unprocessable(
      'That amount is below the smallest amount the bridge can carry',
      { minimum_wei: (rate * 10n ** 9n).toString() },
    );
  }

  return {
    chainId: cfg.chain.chainId,
    contractAddress: cfg.chain.l2Contract,
    method: 'crosschainBurn',
    amountWei: amountWei.toString(),
    bridgeableWei: burnable.toString(),
    bridgeableTokens: weiToTokenString(burnable),
    l1Amount: l1Amount.toString(),
    dustWei: dust.toString(),
    l2PerL1: rate.toString(),
    // `crosschainBurn` burns the whole L1 units and sweeps the sub-unit
    // remainder to the treasury wallet, returning it to the company's L2
    // supply rather than leaving an unbridgeable crumb in the holder's wallet.
    // That happens inside the contract, so the only honest thing to do is say
    // it before they sign. Full precision on the amount: the remainder is by
    // definition smaller than one bridge unit, so a 6-decimal display would
    // print it as a misleading "0".
    dustNote:
      dust > 0n
        ? `${weiToTokenString(dust, 18)} TBAY is smaller than the bridge can carry. ` +
          'The contract returns it to the treasury wallet as part of the same ' +
          'transaction, so nothing is left stranded.'
        : null,
  };
}

export interface RecordWithdrawalInput {
  burnTxHash: string;
  fromAddress: string;
  tenantId?: string | null;
  contactId?: string | null;
  memberId?: string | null;
}

/**
 * Verify a burn transaction and open a withdrawal.
 *
 * Verification requires a Transfer to the zero address *from the declared
 * wallet* inside the given transaction. Because the record is keyed on
 * (chain, tx hash) with a unique index, one burn can only ever fund one
 * withdrawal, and because the `from` must match the burn's sender, a third
 * party cannot point a withdrawal at someone else's burn.
 */
export async function recordWithdrawal(
  input: RecordWithdrawalInput,
  runner?: Queryable,
): Promise<{ withdrawal: BridgeWithdrawal; explorerUrl: string | null }> {
  const cfg = config();
  const client = chain();
  if (!client) {
    throw new ApiError(503, 'chain_unavailable', 'No RPC endpoint configured, so burns cannot be verified');
  }

  const from = assertAddress(input.fromAddress, 'from_address');

  // The L1 release always goes to the address that burned. There is deliberately
  // no way to nominate a different recipient: the burn event proves who owned
  // the tokens and nothing else does, so accepting a recipient from the request
  // would let anyone who spots a burn on-chain redirect it to themselves.
  const recipient = from;

  if (!/^0x[0-9a-fA-F]{64}$/.test(input.burnTxHash)) {
    throw ApiError.badRequest('burn_tx_hash must be a 32-byte transaction hash');
  }

  const transfers = await client.transfersInTx(input.burnTxHash);
  const burn = transfers.find(
    (transfer) =>
      transfer.to.toLowerCase() === BURN_ADDRESS &&
      transfer.from.toLowerCase() === from.toLowerCase() &&
      transfer.value > 0n,
  );

  if (!burn) {
    throw ApiError.unprocessable(
      'No TBAY burn from that wallet was found in this transaction',
      { expected_from: from, tx_hash: input.burnTxHash },
    );
  }

  // Recompute rather than trust the caller: the burn is already a whole
  // multiple of the bridge unit (the contract enforces it), and the dust leg is
  // a separate Transfer.
  const { l1Amount } = splitBridgeAmount(burn.value, bridgeRate());
  if (l1Amount <= 0n) {
    throw ApiError.unprocessable('That burn is below one whole L1 unit');
  }

  const dust = transfers
    .filter(
      (transfer) =>
        transfer.from.toLowerCase() === from.toLowerCase() &&
        transfer.to.toLowerCase() !== BURN_ADDRESS,
    )
    .reduce((sum, transfer) => sum + transfer.value, 0n);

  const run = async (tx: Queryable) => {
    const row = await queryOne<BridgeWithdrawal>(
      tx,
      `INSERT INTO bridge_withdrawals (
         tenant_id, contact_id, member_id, from_address, l1_recipient,
         l2_amount_wei, l1_amount, dust_wei, l2_chain_id, l1_chain_id,
         burn_tx_hash, status, verified_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'burn_verified', now())
       ON CONFLICT (l2_chain_id, burn_tx_hash) DO NOTHING
       RETURNING *`,
      [
        input.tenantId ?? null,
        input.contactId ?? null,
        input.memberId ?? null,
        from.toLowerCase(),
        recipient.toLowerCase(),
        burn.value.toString(),
        l1Amount.toString(),
        dust.toString(),
        cfg.chain.chainId,
        1,
        input.burnTxHash,
      ],
    );

    if (!row) {
      const existing = await queryOne<BridgeWithdrawal>(
        tx,
        'SELECT * FROM bridge_withdrawals WHERE l2_chain_id = $1 AND burn_tx_hash = $2',
        [cfg.chain.chainId, input.burnTxHash],
      );
      // Already recorded. Returned as-is and never re-pointed — the recipient is
      // derived from the burn, so there is nothing a later caller could change.
      if (existing) {
        return existing;
      }
      throw ApiError.conflict('That burn has already been submitted');
    }

    return row;
  };

  const withdrawal = runner ? await run(runner) : await withTransaction(run);

  return {
    withdrawal,
    explorerUrl: txUrl(cfg.chain.chainId, input.burnTxHash),
  };
}

export async function listWithdrawals(
  filter: { fromAddress?: string; tenantId?: string; status?: string; limit?: number } = {},
  runner: Queryable = db(),
): Promise<BridgeWithdrawal[]> {
  const { rows } = await runner.query<BridgeWithdrawal>(
    `SELECT * FROM bridge_withdrawals
      WHERE ($1::text IS NULL OR from_address = lower($1))
        AND ($2::uuid IS NULL OR tenant_id = $2)
        AND ($3::text IS NULL OR status = $3)
      ORDER BY created_at DESC
      LIMIT $4`,
    [
      filter.fromAddress ?? null,
      filter.tenantId ?? null,
      filter.status ?? null,
      Math.min(filter.limit ?? 50, 200),
    ],
  );
  return rows;
}

export async function getWithdrawal(
  id: string,
  runner: Queryable = db(),
): Promise<BridgeWithdrawal | null> {
  return queryOne<BridgeWithdrawal>(runner, 'SELECT * FROM bridge_withdrawals WHERE id = $1', [id]);
}

/**
 * Mark a withdrawal released on L1.
 *
 * Only the bridge operator can call this (it is gated behind the operator
 * credential at the route layer), because it asserts that L1 tokens have
 * actually moved — something this service cannot observe from L2.
 */
/**
 * The wallet an L1 release must actually reach, and proof that it is the
 * right one.
 *
 * Normally `l1_recipient`, which recordWithdrawal derived from the burn. After
 * an erasure that column holds a keyed digest instead, because keeping the
 * address left a join from this row to the erased person's live record at
 * another retailer -- `members.wallet_address` is plaintext, unique and
 * platform-wide, and nulling this row's own links did nothing about it.
 *
 * The digest is what makes recovery safe. Reading the burn back and taking
 * whichever transfer came first reproduced the very hole recordWithdrawal's
 * `from` constraint exists to close: a transaction carrying two burns paid the
 * wrong wallet, and a wrong or hostile node could redirect the payout with
 * nothing to compare against. Here every burn in the transaction is checked
 * against the commitment, so the chain supplies the candidate and the database
 * decides which one is right.
 *
 * Never throws: this is read on an ordinary API route, and a node that is
 * down, slow or lying must produce a null and a reason rather than a 500 with
 * the provider's error in it.
 */
export type PayableTo =
  | { address: string; reason?: undefined }
  | { address: null; reason: 'chain_unavailable' | 'chain_error' | 'burn_not_found' | 'no_match' };

export async function recipientFor(
  withdrawal: Pick<BridgeWithdrawal, 'l1_recipient' | 'burn_tx_hash'>,
): Promise<PayableTo> {
  const digest = ERASED_RECIPIENT.exec(withdrawal.l1_recipient);
  if (!digest) return { address: withdrawal.l1_recipient };

  const client = chain();
  if (!client) return { address: null, reason: 'chain_unavailable' };

  let transfers: TokenTransfer[];
  try {
    transfers = await withChainTimeout(
      client.transfersInTx(withdrawal.burn_tx_hash),
      RECIPIENT_LOOKUP_TIMEOUT_MS,
      'The chain did not answer in time',
    );
  } catch {
    return { address: null, reason: 'chain_error' };
  }

  const burns = transfers.filter(
    (transfer) => transfer.to.toLowerCase() === BURN_ADDRESS && transfer.value > 0n,
  );
  if (burns.length === 0) return { address: null, reason: 'burn_not_found' };

  const match = burns.find(
    (burn) => `erased:${digest[1]!}:${walletDigest(burn.from, digest[1]!)}` === withdrawal.l1_recipient,
  );
  return match ? { address: match.from.toLowerCase() } : { address: null, reason: 'no_match' };
}

/** What privacy.ts writes over an erased person's wallet: erased:<tenant>:<digest>. */
const ERASED_RECIPIENT = /^erased:([0-9a-f-]{36}):[0-9a-f]{32}$/i;

/** A read-only route may not hang on a slow node. */
const RECIPIENT_LOOKUP_TIMEOUT_MS = 15_000;

export async function markReleased(
  id: string,
  l1TxHash: string,
  runner: Queryable = db(),
): Promise<BridgeWithdrawal | null> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(l1TxHash)) {
    throw ApiError.badRequest('l1_tx_hash must be a 32-byte transaction hash');
  }
  return queryOne<BridgeWithdrawal>(
    runner,
    `UPDATE bridge_withdrawals
        SET status = 'released', release_tx_hash = $2, released_at = now()
      WHERE id = $1 AND status = 'burn_verified'
      RETURNING *`,
    [id, l1TxHash],
  );
}

export async function rejectWithdrawal(
  id: string,
  reason: string,
  runner: Queryable = db(),
): Promise<BridgeWithdrawal | null> {
  return queryOne<BridgeWithdrawal>(
    runner,
    `UPDATE bridge_withdrawals
        SET status = 'rejected', rejected_reason = $2
      WHERE id = $1 AND status <> 'released'
      RETURNING *`,
    [id, reason.slice(0, 500)],
  );
}

/** Totals for the operator dashboard. */
export async function bridgeSummary(runner: Queryable = db()): Promise<{
  pending: number;
  awaiting_release: number;
  released: number;
  awaiting_release_l1_amount: string;
}> {
  const row = await queryOne<Record<string, string>>(
    runner,
    `SELECT
       COUNT(*) FILTER (WHERE status = 'pending')::text                      AS pending,
       COUNT(*) FILTER (WHERE status = 'burn_verified')::text                AS awaiting_release,
       COUNT(*) FILTER (WHERE status = 'released')::text                     AS released,
       COALESCE(SUM(l1_amount) FILTER (WHERE status = 'burn_verified'), 0)::text AS awaiting_release_l1_amount
     FROM bridge_withdrawals`,
  );
  return {
    pending: Number(row?.pending ?? 0),
    awaiting_release: Number(row?.awaiting_release ?? 0),
    released: Number(row?.released ?? 0),
    awaiting_release_l1_amount: String(row?.awaiting_release_l1_amount ?? '0'),
  };
}

import { db, queryOne, withTransaction, type Queryable } from '../db/pool.js';
import { config } from '../config.js';
import { ApiError } from '../lib/errors.js';
import { assertAddress, chain, weiToTokenString } from '../lib/chain.js';
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
export function withdrawalInstructions(amountWei: bigint): {
  chainId: number;
  contractAddress: string;
  method: 'crosschainBurn';
  amountWei: string;
  bridgeableWei: string;
  bridgeableTokens: string;
  l1Amount: string;
  dustWei: string;
  dustNote: string | null;
} {
  const cfg = config();
  const { l1Amount, burnable, dust } = splitBridgeAmount(amountWei);

  if (l1Amount <= 0n) {
    throw ApiError.unprocessable(
      'That amount is below one whole L1 unit, so nothing would cross the bridge',
      { minimum_wei: (10n ** 9n).toString() },
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
    // The contract sweeps any sub-L1-unit remainder to the treasury rather than
    // silently rounding it into the bridged amount. Say so before they sign.
    dustNote:
      dust > 0n
        ? `${weiToTokenString(dust)} TBAY cannot cross (below one L1 unit) and will be sent to the treasury wallet by the contract.`
        : null,
  };
}

export interface RecordWithdrawalInput {
  burnTxHash: string;
  fromAddress: string;
  l1Recipient?: string | null;
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
  const recipient = assertAddress(input.l1Recipient ?? input.fromAddress, 'l1_recipient');

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

  // The burn amount is already a whole multiple of 10^9 (the contract enforces
  // it), but recompute rather than trust: the dust leg is a separate Transfer.
  const { l1Amount } = splitBridgeAmount(burn.value);
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
      // Already recorded. Return it, but never re-point it at a new recipient:
      // that would let a later caller redirect someone else's withdrawal.
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

import { verifyMessage, getAddress } from 'ethers';
import { db, queryOne, withTransaction, type Queryable } from '../db/pool.js';
import { randomToken } from '../lib/crypto.js';
import { ApiError } from '../lib/errors.js';
import { assertAddress } from '../lib/chain.js';
import { upsertMember, type Contact } from './contacts.js';
import type { Tenant } from './tenants.js';

/**
 * Proving that a wallet belongs to the person connecting it.
 *
 * Without this, "my wallet is 0xVICTIM" is an unverified claim, and anything
 * downstream that trusts the stored address — most importantly bridge
 * withdrawals — can be pointed at someone else's tokens. The holder now signs a
 * server-issued, single-use, short-lived challenge with the private key, which
 * only the real owner can do.
 *
 * Deliberately plain EIP-191 `personal_sign`: every wallet supports it,
 * including hardware wallets and thirdweb's in-app accounts.
 */

const CHALLENGE_TTL_MINUTES = 10;

export interface WalletChallenge {
  nonce: string;
  message: string;
  walletAddress: string;
  expiresAt: Date;
}

export function challengeMessage(opts: {
  tenantName: string;
  walletAddress: string;
  nonce: string;
  issuedAt: string;
}): string {
  // Human-readable, and it names what is being authorised — a wallet prompt
  // that just shows a random hex blob teaches people to sign anything.
  return [
    `${opts.tenantName} wants to link this wallet to your rewards account.`,
    '',
    `Wallet: ${opts.walletAddress}`,
    `Nonce: ${opts.nonce}`,
    `Issued: ${opts.issuedAt}`,
    '',
    'Signing costs nothing and grants no permission to move your funds.',
  ].join('\n');
}

export async function createChallenge(
  tenant: Tenant,
  contact: Contact,
  walletAddress: string,
  runner: Queryable = db(),
): Promise<WalletChallenge> {
  const wallet = assertAddress(walletAddress, 'wallet_address');
  const nonce = randomToken(24);
  const issuedAt = new Date().toISOString();

  const row = await queryOne<{ expires_at: Date }>(
    runner,
    `INSERT INTO wallet_challenges (tenant_id, contact_id, wallet_address, nonce, expires_at)
     VALUES ($1, $2, $3, $4, now() + ($5 || ' minutes')::interval)
     RETURNING expires_at`,
    [tenant.id, contact.id, wallet.toLowerCase(), nonce, String(CHALLENGE_TTL_MINUTES)],
  );

  return {
    nonce,
    walletAddress: wallet,
    expiresAt: row!.expires_at,
    message: challengeMessage({
      tenantName: tenant.name,
      walletAddress: wallet,
      nonce,
      issuedAt,
    }),
  };
}

/**
 * Verify a signed challenge and bind the wallet.
 *
 * The challenge is consumed inside the same transaction as the binding, so a
 * captured signature cannot be replayed, and it is scoped to the contact it was
 * issued for, so one member cannot redeem another's challenge.
 */
export async function verifyChallenge(
  tenant: Tenant,
  contact: Contact,
  input: { nonce: string; signature: string; message: string },
): Promise<Contact> {
  return withTransaction(async (client) => {
    const challenge = await queryOne<{
      id: string;
      contact_id: string;
      wallet_address: string;
      consumed_at: Date | null;
      expires_at: Date;
    }>(
      client,
      'SELECT * FROM wallet_challenges WHERE nonce = $1 AND tenant_id = $2 FOR UPDATE',
      [input.nonce, tenant.id],
    );

    // One message for every failure, so this cannot be used to probe which
    // nonces exist or which wallets a contact has attempted.
    const invalid = ApiError.forbidden('That wallet signature could not be verified');

    if (!challenge) throw invalid;
    if (challenge.contact_id !== contact.id) throw invalid;
    if (challenge.consumed_at) throw invalid;
    if (new Date(challenge.expires_at).getTime() < Date.now()) throw invalid;

    // The signed message must contain this exact nonce, so a signature captured
    // from some other prompt cannot be repurposed.
    if (!input.message.includes(input.nonce)) throw invalid;

    let recovered: string;
    try {
      recovered = verifyMessage(input.message, input.signature);
    } catch {
      throw invalid;
    }

    if (getAddress(recovered).toLowerCase() !== challenge.wallet_address.toLowerCase()) {
      throw invalid;
    }

    await client.query('UPDATE wallet_challenges SET consumed_at = now() WHERE id = $1', [
      challenge.id,
    ]);

    const memberId =
      (await upsertMember(client, {
        email: contact.email_normalised,
        walletAddress: challenge.wallet_address,
      })) ?? contact.member_id;

    const updated = await queryOne<Contact>(
      client,
      `UPDATE contacts
          SET wallet_address = $3,
              wallet_verified_at = now(),
              member_id = COALESCE($4, member_id),
              updated_at = now()
        WHERE tenant_id = $1 AND id = $2
        RETURNING *`,
      [tenant.id, contact.id, challenge.wallet_address, memberId],
    );

    return updated!;
  });
}

/** The proved wallet for a contact, or null when none has been verified. */
export async function verifiedWallet(
  tenantId: string,
  contactId: string,
  runner: Queryable = db(),
): Promise<string | null> {
  const row = await queryOne<{ wallet_address: string | null }>(
    runner,
    `SELECT wallet_address FROM contacts
      WHERE tenant_id = $1 AND id = $2 AND wallet_verified_at IS NOT NULL`,
    [tenantId, contactId],
  );
  return row?.wallet_address ?? null;
}

/** Housekeeping for challenges nobody signed. */
export async function purgeExpiredChallenges(runner: Queryable = db()): Promise<number> {
  const { rowCount } = await runner.query(
    `DELETE FROM wallet_challenges WHERE expires_at < now() - interval '1 day'`,
  );
  return rowCount ?? 0;
}

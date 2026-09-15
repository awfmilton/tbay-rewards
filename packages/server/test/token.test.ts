import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import {
  AbiCoder,
  TypedDataEncoder,
  getAddress,
  keccak256,
  recoverAddress,
  toUtf8Bytes,
} from 'ethers';
import {
  TEST_SIGNER,
  closeApp,
  closeDb,
  db,
  makeTenant,
  setupDatabase,
  truncateAll,
  type TestTenant,
} from './helpers.js';
import { upsertContact } from '../src/services/contacts.js';
import { award, getBalance } from '../src/services/points.js';
import {
  createSpendIntent,
  expireStaleClaims,
  quote,
  reconcileClaims,
  redeemPointsForTokens,
  redeemStoreCredit,
  verifySpendIntent,
} from '../src/services/token.js';
import {
  CLAIM_TYPES,
  claimDomain,
  recoverClaimSigner,
  setChainClient,
  tokensToWei,
  weiToTokenString,
  type ChainClient,
} from '../src/lib/chain.js';
import { getTenantById, updateTenantSettings } from '../src/services/tenants.js';

const CHAIN_ID = 300;
const CONTRACT = '0x74eb73ACa939Fc911f79D9589e808f0207684D09';

let tenant: TestTenant;

beforeAll(async () => {
  await setupDatabase();
});

beforeEach(async () => {
  await truncateAll();
  tenant = await makeTenant();
});

afterAll(async () => {
  await closeApp();
  await closeDb();
});

async function fundedContact(points: number, email = 'holder@example.com') {
  const contact = await upsertContact(tenant.id, { email, name: 'Token Holder' });
  if (points > 0) {
    await award(tenant.id, { contactId: contact.id, points, reason: 'Test grant', idempotencyKey: `g-${email}` });
  }
  return contact;
}

async function tenantObject() {
  return (await getTenantById(tenant.id))!;
}

describe('EIP-712 claim signatures', () => {
  /**
   * The contract computes its digest as:
   *   structHash = keccak256(abi.encode(
   *     keccak256("Claim(address user,uint256 amount,uint256 nonce)"), user, amount, nonce))
   *   digest = _hashTypedDataV4(structHash)
   * This rebuilds that from first principles and checks ethers' typed-data
   * encoder agrees, so a drift in either direction is caught here rather than
   * by a reverted transaction.
   */
  it('produces the same digest the contract derives', () => {
    const user = getAddress('0x1111111111111111111111111111111111111111');
    const amount = 5n * 10n ** 18n;
    const nonce = 123_456_789n;

    const typeHash = keccak256(toUtf8Bytes('Claim(address user,uint256 amount,uint256 nonce)'));
    const structHash = keccak256(
      AbiCoder.defaultAbiCoder().encode(
        ['bytes32', 'address', 'uint256', 'uint256'],
        [typeHash, user, amount, nonce],
      ),
    );

    const domain = claimDomain(CHAIN_ID, CONTRACT);
    const domainSeparator = TypedDataEncoder.hashDomain(domain);
    const expectedDigest = keccak256(
      Buffer.concat([
        Buffer.from('1901', 'hex'),
        Buffer.from(domainSeparator.slice(2), 'hex'),
        Buffer.from(structHash.slice(2), 'hex'),
      ]),
    );

    const ethersDigest = TypedDataEncoder.hash(domain, CLAIM_TYPES as never, { user, amount, nonce });
    expect(ethersDigest).toBe(expectedDigest);
  });

  it('signs a claim that recovers to the CLAIMER_ROLE wallet', async () => {
    const contact = await fundedContact(500);
    const result = await redeemPointsForTokens(await tenantObject(), {
      contact,
      points: 500,
      walletAddress: '0x2222222222222222222222222222222222222222',
    });

    const recovered = recoverClaimSigner(
      {
        user: '0x2222222222222222222222222222222222222222',
        amount: BigInt(result.transaction.args.amount),
        nonce: BigInt(result.transaction.args.nonce),
      },
      result.transaction.args.signature,
      CHAIN_ID,
      CONTRACT,
    );

    expect(recovered).toBe(TEST_SIGNER.address);
  });

  it('binds the signature to the exact user, amount and nonce', async () => {
    const contact = await fundedContact(500);
    const result = await redeemPointsForTokens(await tenantObject(), {
      contact,
      points: 500,
      walletAddress: '0x2222222222222222222222222222222222222222',
    });

    // Anyone tampering with the amount gets a signature that recovers to a
    // different address, which the contract rejects with InvalidSigner.
    const tampered = recoverClaimSigner(
      {
        user: '0x2222222222222222222222222222222222222222',
        amount: BigInt(result.transaction.args.amount) * 2n,
        nonce: BigInt(result.transaction.args.nonce),
      },
      result.transaction.args.signature,
      CHAIN_ID,
      CONTRACT,
    );
    expect(tampered).not.toBe(TEST_SIGNER.address);

    const otherWallet = recoverClaimSigner(
      {
        user: '0x3333333333333333333333333333333333333333',
        amount: BigInt(result.transaction.args.amount),
        nonce: BigInt(result.transaction.args.nonce),
      },
      result.transaction.args.signature,
      CHAIN_ID,
      CONTRACT,
    );
    expect(otherWallet).not.toBe(TEST_SIGNER.address);
  });

  it('rejects a signature made for a different chain', async () => {
    const contact = await fundedContact(500);
    const result = await redeemPointsForTokens(await tenantObject(), {
      contact,
      points: 500,
      walletAddress: '0x2222222222222222222222222222222222222222',
    });

    const wrongChain = recoverClaimSigner(
      {
        user: '0x2222222222222222222222222222222222222222',
        amount: BigInt(result.transaction.args.amount),
        nonce: BigInt(result.transaction.args.nonce),
      },
      result.transaction.args.signature,
      324, // zkSync Era mainnet
      CONTRACT,
    );
    expect(wrongChain).not.toBe(TEST_SIGNER.address);
  });

  it('produces a raw signature the contract can ECDSA.recover directly', async () => {
    const contact = await fundedContact(500);
    const result = await redeemPointsForTokens(await tenantObject(), {
      contact,
      points: 500,
      walletAddress: '0x2222222222222222222222222222222222222222',
    });

    const digest = TypedDataEncoder.hash(claimDomain(CHAIN_ID, CONTRACT), CLAIM_TYPES as never, {
      user: getAddress('0x2222222222222222222222222222222222222222'),
      amount: BigInt(result.transaction.args.amount),
      nonce: BigInt(result.transaction.args.nonce),
    });

    expect(recoverAddress(digest, result.transaction.args.signature)).toBe(TEST_SIGNER.address);
    // 65-byte r,s,v — exactly what ECDSA.recover(bytes) expects.
    expect(result.transaction.args.signature).toMatch(/^0x[0-9a-f]{130}$/i);
  });
});

describe('points to TBAY conversion', () => {
  it('converts at the configured rate', async () => {
    const tenantRow = await tenantObject();
    // Default: 100 points per whole TBAY.
    expect(quote(tenantRow, 100)).toBe(10n ** 18n);
    expect(quote(tenantRow, 250)).toBe(25n * 10n ** 17n);
    expect(quote(tenantRow, 1)).toBe(10n ** 16n);
  });

  it('honours a per-retailer conversion rate', async () => {
    await updateTenantSettings(db(), tenant.id, { pointsPerToken: 500 });
    const tenantRow = await tenantObject();
    expect(quote(tenantRow, 500)).toBe(10n ** 18n);
  });

  it('never loses value to floating point', async () => {
    const tenantRow = await tenantObject();
    // 333 points at 100/token is 3.33 TBAY exactly.
    expect(quote(tenantRow, 333)).toBe(3_330_000_000_000_000_000n);
    expect(weiToTokenString(quote(tenantRow, 333))).toBe('3.33');
  });
});

describe('redemption', () => {
  it('debits points and records a signed voucher', async () => {
    const contact = await fundedContact(1000);
    const result = await redeemPointsForTokens(await tenantObject(), {
      contact,
      points: 400,
      walletAddress: '0x2222222222222222222222222222222222222222',
    });

    expect(result.claim.status).toBe('signed');
    expect(result.claim.points_spent).toBe(400);
    expect(result.transaction.amountTokens).toBe('4');
    expect(await getBalance(tenant.id, contact.id)).toMatchObject({
      balance: 600,
      lifetime_spent: 400,
    });
  });

  it('refuses to redeem more points than the member holds', async () => {
    const contact = await fundedContact(100);
    await expect(
      redeemPointsForTokens(await tenantObject(), {
        contact,
        points: 900,
        walletAddress: '0x2222222222222222222222222222222222222222',
      }),
    ).rejects.toMatchObject({ statusCode: 422 });

    expect((await getBalance(tenant.id, contact.id)).balance).toBe(100);
    const { rows } = await db().query('SELECT * FROM token_claims WHERE tenant_id = $1', [tenant.id]);
    expect(rows).toHaveLength(0);
  });

  it('enforces the minimum redemption', async () => {
    const contact = await fundedContact(1000);
    await expect(
      redeemPointsForTokens(await tenantObject(), {
        contact,
        points: 5,
        walletAddress: '0x2222222222222222222222222222222222222222',
      }),
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it('rejects an invalid wallet address', async () => {
    const contact = await fundedContact(1000);
    await expect(
      redeemPointsForTokens(await tenantObject(), {
        contact,
        points: 500,
        walletAddress: '0xnot-an-address',
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('refuses an amount above the contract per-claim ceiling', async () => {
    const contact = await fundedContact(2_000_000);
    // 2,000,000 points at 100/token is 20,000 TBAY — over the contract's 10,000 cap.
    await expect(
      redeemPointsForTokens(await tenantObject(), {
        contact,
        points: 2_000_000,
        walletAddress: '0x2222222222222222222222222222222222222222',
      }),
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it('mints a unique nonce per voucher', async () => {
    const contact = await fundedContact(1000);
    const tenantRow = await tenantObject();

    const first = await redeemPointsForTokens(tenantRow, {
      contact,
      points: 200,
      walletAddress: '0x2222222222222222222222222222222222222222',
    });
    await new Promise((resolve) => setTimeout(resolve, 1100)); // distinct idempotency window
    const second = await redeemPointsForTokens(tenantRow, {
      contact,
      points: 200,
      walletAddress: '0x2222222222222222222222222222222222222222',
    });

    expect(first.claim.nonce).not.toBe(second.claim.nonce);
    expect(await getBalance(tenant.id, contact.id)).toMatchObject({ balance: 600 });
  });

  it('returns the points when a voucher expires unclaimed', async () => {
    const contact = await fundedContact(1000);
    const result = await redeemPointsForTokens(await tenantObject(), {
      contact,
      points: 500,
      walletAddress: '0x2222222222222222222222222222222222222222',
    });
    expect((await getBalance(tenant.id, contact.id)).balance).toBe(500);

    await db().query(`UPDATE token_claims SET expires_at = now() - interval '1 minute' WHERE id = $1`, [
      result.claim.id,
    ]);
    expect(await expireStaleClaims()).toBe(1);

    expect((await getBalance(tenant.id, contact.id)).balance).toBe(1000);
    const { rows } = await db().query('SELECT status, reversal_entry_id FROM token_claims WHERE id = $1', [
      result.claim.id,
    ]);
    expect(rows[0].status).toBe('expired');
    expect(rows[0].reversal_entry_id).not.toBeNull();
  });

  it('marks a voucher claimed once the chain reports its nonce used', async () => {
    const contact = await fundedContact(1000);
    const result = await redeemPointsForTokens(await tenantObject(), {
      contact,
      points: 500,
      walletAddress: '0x2222222222222222222222222222222222222222',
    });

    const used = new Set([result.claim.nonce]);
    setChainClient(stubChain({ isNonceUsed: async (nonce) => used.has(nonce.toString()) }));

    expect(await reconcileClaims()).toBe(1);
    const { rows } = await db().query('SELECT status FROM token_claims WHERE id = $1', [result.claim.id]);
    expect(rows[0].status).toBe('claimed');
  });

  it('does not expire a voucher when the RPC is unreachable', async () => {
    const contact = await fundedContact(1000);
    await redeemPointsForTokens(await tenantObject(), {
      contact,
      points: 500,
      walletAddress: '0x2222222222222222222222222222222222222222',
    });

    setChainClient(stubChain({
      isNonceUsed: async () => { throw new Error('RPC timeout'); },
    }));

    expect(await reconcileClaims()).toBe(0);
    const { rows } = await db().query('SELECT status FROM token_claims WHERE tenant_id = $1', [tenant.id]);
    expect(rows[0].status).toBe('signed');
  });

  it('stops issuing vouchers once the contract hourly mint cap is booked', async () => {
    // The contract allows 100,000 TBAY per hour; 10,000,000 points at 100/token
    // is exactly that, so the next redemption must be refused.
    const whale = await fundedContact(10_100_000, 'whale@example.com');
    const tenantRow = await tenantObject();

    for (let i = 0; i < 10; i += 1) {
      await db().query(
        `INSERT INTO token_mint_windows (chain_id, contract_address, window_start, minted_wei)
         VALUES ($1, $2, date_trunc('hour', now()), $3)
         ON CONFLICT (chain_id, contract_address, window_start)
         DO UPDATE SET minted_wei = token_mint_windows.minted_wei + EXCLUDED.minted_wei`,
        [CHAIN_ID, CONTRACT.toLowerCase(), (10_000n * 10n ** 18n).toString()],
      );
    }

    await expect(
      redeemPointsForTokens(tenantRow, {
        contact: whale,
        points: 1000,
        walletAddress: '0x2222222222222222222222222222222222222222',
      }),
    ).rejects.toMatchObject({ statusCode: 429 });
  });
});

describe('spending TBAY at a retailer', () => {
  const CUSTOMER = '0x4444444444444444444444444444444444444444';
  const PAYOUT = '0x5555555555555555555555555555555555555555';

  it('refuses a spend when the retailer has no payout wallet', async () => {
    const contact = await fundedContact(0, 'spender@example.com');
    await expect(
      createSpendIntent(await tenantObject(), { contact, amountTokens: 5, fromAddress: CUSTOMER }),
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it('issues store credit against a verified on-chain transfer', async () => {
    await updateTenantSettings(db(), tenant.id, { payoutWallet: PAYOUT });
    const contact = await fundedContact(0, 'spender@example.com');
    const tenantRow = await tenantObject();

    const { intent, creditCents } = await createSpendIntent(tenantRow, {
      contact,
      amountTokens: 5,
      fromAddress: CUSTOMER,
    });
    expect(creditCents).toBe(500); // 100 cents per TBAY by default

    setChainClient(
      stubChain({
        transfersInTx: async () => [
          {
            from: getAddress(CUSTOMER),
            to: getAddress(PAYOUT),
            value: tokensToWei(5),
            blockNumber: 100,
            confirmations: 3,
          },
        ],
      }),
    );

    const result = await verifySpendIntent(tenantRow, intent.id, '0xdeadbeefdeadbeef');
    expect(result.intent.status).toBe('verified');
    expect(result.credit?.amount_cents).toBe(500);

    const redeemed = await redeemStoreCredit(tenant.id, result.credit!.code, 'order-99');
    expect(redeemed?.amount_cents).toBe(500);
    // A credit is single-use.
    expect(await redeemStoreCredit(tenant.id, result.credit!.code, 'order-100')).toBeNull();
  });

  it('rejects a transfer that went to the wrong address', async () => {
    await updateTenantSettings(db(), tenant.id, { payoutWallet: PAYOUT });
    const contact = await fundedContact(0, 'spender@example.com');
    const tenantRow = await tenantObject();
    const { intent } = await createSpendIntent(tenantRow, {
      contact,
      amountTokens: 5,
      fromAddress: CUSTOMER,
    });

    setChainClient(
      stubChain({
        transfersInTx: async () => [
          {
            from: getAddress(CUSTOMER),
            to: getAddress('0x6666666666666666666666666666666666666666'),
            value: tokensToWei(5),
            blockNumber: 100,
            confirmations: 3,
          },
        ],
      }),
    );

    await expect(verifySpendIntent(tenantRow, intent.id, '0xdeadbeef')).rejects.toMatchObject({
      statusCode: 422,
    });
  });

  it('rejects a transfer smaller than the intent', async () => {
    await updateTenantSettings(db(), tenant.id, { payoutWallet: PAYOUT });
    const contact = await fundedContact(0, 'spender@example.com');
    const tenantRow = await tenantObject();
    const { intent } = await createSpendIntent(tenantRow, {
      contact,
      amountTokens: 5,
      fromAddress: CUSTOMER,
    });

    setChainClient(
      stubChain({
        transfersInTx: async () => [
          {
            from: getAddress(CUSTOMER),
            to: getAddress(PAYOUT),
            value: tokensToWei(4.9),
            blockNumber: 100,
            confirmations: 3,
          },
        ],
      }),
    );

    await expect(verifySpendIntent(tenantRow, intent.id, '0xdeadbeef')).rejects.toMatchObject({
      statusCode: 422,
    });
  });

  it('cannot settle the same transaction twice', async () => {
    await updateTenantSettings(db(), tenant.id, { payoutWallet: PAYOUT });
    const contact = await fundedContact(0, 'spender@example.com');
    const tenantRow = await tenantObject();

    const transfers = async () => [
      {
        from: getAddress(CUSTOMER),
        to: getAddress(PAYOUT),
        value: tokensToWei(5),
        blockNumber: 100,
        confirmations: 3,
      },
    ];
    setChainClient(stubChain({ transfersInTx: transfers }));

    const first = await createSpendIntent(tenantRow, { contact, amountTokens: 5, fromAddress: CUSTOMER });
    const second = await createSpendIntent(tenantRow, { contact, amountTokens: 5, fromAddress: CUSTOMER });

    await verifySpendIntent(tenantRow, first.intent.id, '0xsametxsametxsametx');
    // The (chain_id, tx_hash) unique index is what stops one payment buying two credits.
    await expect(verifySpendIntent(tenantRow, second.intent.id, '0xsametxsametxsametx')).rejects.toThrow();
  });
});

describe('wei helpers', () => {
  it('converts whole and fractional TBAY without precision loss', () => {
    expect(tokensToWei(1)).toBe(10n ** 18n);
    expect(tokensToWei(0.5)).toBe(5n * 10n ** 17n);
    expect(tokensToWei(1234.567891)).toBe(1_234_567_891_000_000_000_000n);
    expect(weiToTokenString(1_234_567_891_000_000_000_000n)).toBe('1234.567891');
    expect(weiToTokenString(10n ** 18n)).toBe('1');
  });
});

function stubChain(overrides: Partial<ChainClient>): ChainClient {
  return {
    isNonceUsed: async () => false,
    isPaused: async () => false,
    balanceOf: async () => 0n,
    transfersInTx: async () => [],
    ...overrides,
  };
}

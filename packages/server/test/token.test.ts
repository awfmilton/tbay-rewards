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
  outstandingClaims,
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

  /**
   * The deployed contract's claim() has no deadline, so a signed voucher stays
   * valid on-chain forever. Refunding on a timer would let someone take the
   * points back AND still mint, so ageing out must not refund.
   */
  it('does not refund an aged-out voucher, because it is still claimable on-chain', async () => {
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

    // Points stay spent and no compensating entry is written.
    expect((await getBalance(tenant.id, contact.id)).balance).toBe(500);
    const { rows } = await db().query('SELECT status, reversal_entry_id FROM token_claims WHERE id = $1', [
      result.claim.id,
    ]);
    expect(rows[0].status).toBe('expired');
    expect(rows[0].reversal_entry_id).toBeNull();

    // …and the member can still see and submit it.
    const outstanding = await outstandingClaims(tenant.id, contact.id);
    expect(outstanding).toHaveLength(1);
    expect(outstanding[0].signature).toBe(result.claim.signature);
  });

  it('still notices an aged-out voucher being claimed on-chain', async () => {
    const contact = await fundedContact(1000);
    const result = await redeemPointsForTokens(await tenantObject(), {
      contact,
      points: 500,
      walletAddress: '0x2222222222222222222222222222222222222222',
    });

    await db().query(`UPDATE token_claims SET expires_at = now() - interval '1 minute' WHERE id = $1`, [
      result.claim.id,
    ]);
    await expireStaleClaims();

    setChainClient(stubChain({ isNonceUsed: async () => true }));
    expect(await reconcileClaims()).toBe(1);

    const { rows } = await db().query('SELECT status FROM token_claims WHERE id = $1', [result.claim.id]);
    expect(rows[0].status).toBe('claimed');
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
    expect(redeemed?.remaining_cents).toBe(0);
    // Spent in full, so a second order is refused — and told it was spent,
    // not that the code never existed.
    await expect(redeemStoreCredit(tenant.id, result.credit!.code, 'order-100'))
      .rejects.toThrow(/already been used/i);
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

describe('token amounts convert exactly (LOW)', () => {
  /**
   * `String(n)` renders very large and very small numbers in exponent form,
   * which BigInt cannot parse, so this normalises first. `toFixed(20)` was
   * doing the normalising and does not: the spec says toFixed returns
   * String(x) unchanged once |x| >= 1e21, so the exponent survived and the
   * replace chain chewed on it -- `1.5e21` came out as "5e+210000000000000".
   * A different number, not an error, and only BigInt rejecting the letter e
   * kept it from being minted.
   *
   * The first version of this test asserted none of that: every value in it
   * either had no exponent to expand or was caught by a ceiling that sat above
   * where exponents even begin, so all nine assertions passed with the fix
   * reverted. These are the values that actually go through the branch.
   */
  it('expands a positive exponent, which is where the bug was', () => {
    // String(1e21) is "1e+21" and String(1.5e21) is "1.5e+21": both reach
    // toPlainDecimal, and both were wrong before.
    expect(tokensToWei(1e21).toString()).toBe(`1${'0'.repeat(21)}${'0'.repeat(18)}`);
    expect(tokensToWei(1.5e21).toString()).toBe(`15${'0'.repeat(20)}${'0'.repeat(18)}`);
    expect(tokensToWei(1.234e22).toString()).toBe(`1234${'0'.repeat(19)}${'0'.repeat(18)}`);
  });

  it('expands a negative exponent too', () => {
    expect(tokensToWei(1e-7).toString()).toBe('100000000000');
    expect(tokensToWei(1.5e-7).toString()).toBe('150000000000');
    expect(tokensToWei(1e-18).toString()).toBe('1');
    // Below one wei is dust, and rounds to nothing rather than erroring.
    expect(tokensToWei(1e-19).toString()).toBe('0');
  });

  it('leaves values that need no expansion alone', () => {
    expect(tokensToWei(0).toString()).toBe('0');
    expect(tokensToWei(1).toString()).toBe('1000000000000000000');
    expect(tokensToWei(123.456).toString()).toBe('123456000000000000000');
    // Exactly representable, and previously refused by a ceiling that had no
    // business being there.
    expect(tokensToWei(1e16).toString()).toBe(`1${'0'.repeat(16)}${'0'.repeat(18)}`);
    expect(tokensToWei(2 ** 53).toString()).toBe(`${2 ** 53}${'0'.repeat(18)}`);
  });

  it('takes the number the customer typed, not its binary residue', () => {
    // 0.1 is not exactly 0.1 in binary, and toFixed(20) says
    // 0.10000000000000000555. Somebody who asks for a tenth of a token means
    // a tenth of a token.
    expect(tokensToWei(0.1).toString()).toBe('100000000000000000');
    expect(tokensToWei(123.456789).toString()).toBe('123456789000000000000');
  });

  it('still refuses what is not a number at all', () => {
    expect(() => tokensToWei(-1)).toThrow(/positive number/);
    expect(() => tokensToWei(Number.NaN)).toThrow(/positive number/);
    expect(() => tokensToWei(Number.POSITIVE_INFINITY)).toThrow(/positive number/);
  });
});

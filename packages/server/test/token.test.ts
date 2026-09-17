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
  cancelSpendIntent,
  createSpendIntent,
  expireStaleClaims,
  expireStaleSpendIntents,
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

  it('survives the expiry worker running mid-verification (HIGH)', async () => {
    // Two writers, one predicate, a network call in between.
    //
    // verifySpendIntent read the intent, went to the chain, and only then
    // wrote 'verified' behind `WHERE status = 'pending'`. expireStaleSpendIntents
    // writes 'expired' over that same predicate on a five-minute tick. A verify
    // that starts a second before the deadline and spends three seconds on the
    // RPC loses its row -- and the customer's TBAY is already at the retailer's
    // payout wallet, so the losing side of the race is money taken with no
    // credit issued.
    //
    // The worker is fired from inside the stubbed RPC, which is exactly where
    // it lands in production: after the read, before the write.
    await updateTenantSettings(db(), tenant.id, { payoutWallet: PAYOUT });
    const contact = await fundedContact(0, 'racing@example.com');
    const tenantRow = await tenantObject();
    const { intent } = await createSpendIntent(tenantRow, {
      contact,
      amountTokens: 5,
      fromAddress: CUSTOMER,
    });
    // The quote lapses while the customer is signing in their wallet app.
    await db().query(
      `UPDATE token_spend_intents SET expires_at = now() - interval '1 minute' WHERE id = $1`,
      [intent.id],
    );

    let sweptDuringRpc = 0;
    setChainClient(
      stubChain({
        transfersInTx: async () => {
          sweptDuringRpc = await expireStaleSpendIntents();
          return [
            {
              from: getAddress(CUSTOMER),
              to: getAddress(PAYOUT),
              value: tokensToWei(5),
              blockNumber: 100,
              confirmations: 3,
            },
          ];
        },
      }),
    );

    const result = await verifySpendIntent(tenantRow, intent.id, '0xdeadbeefdeadbeef');
    // The worker ran and found nothing to take, because the row was claimed.
    expect(sweptDuringRpc).toBe(0);
    expect(result.intent.status).toBe('verified');
    expect(result.credit?.amount_cents).toBe(500);

    const { rows } = await db().query<{ n: string }>(
      'SELECT count(*)::text AS n FROM store_credits WHERE spend_intent_id = $1',
      [intent.id],
    );
    expect(rows[0]!.n).toBe('1');
  });

  it('bounds how many verifications wait on the chain at once (MEDIUM)', async () => {
    // withChainTimeout abandons the losing promise rather than cancelling it,
    // and the error says "try again" -- so a caller retrying a timeout stacks
    // sockets and ethers queue slots against a node already too slow to
    // answer. Measured: five bounded retries in half a second left five calls
    // in flight, every one of which ran to completion afterwards.
    await updateTenantSettings(db(), tenant.id, { payoutWallet: PAYOUT });
    const tenantRow = await tenantObject();
    const intents: string[] = [];
    for (let n = 0; n < 6; n += 1) {
      const contact = await fundedContact(0, `queue${n}@example.com`);
      const { intent } = await createSpendIntent(tenantRow, {
        contact,
        amountTokens: 5,
        fromAddress: CUSTOMER,
      });
      intents.push(intent.id);
    }

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = 0;
    setChainClient(
      stubChain({
        transfersInTx: async () => {
          started += 1;
          await gate;
          return [];
        },
      }),
    );

    const running = intents.map((id) =>
      verifySpendIntent(tenantRow, id, `0x${id.slice(0, 8)}`).catch((err: { statusCode?: number }) => err),
    );
    // Let them all reach the chain call.
    await new Promise((resolve) => setTimeout(resolve, 200));
    release();
    const results = await Promise.all(running);

    const refused = results.filter(
      (r) => (r as { statusCode?: number }).statusCode === 429,
    ).length;
    expect(refused).toBeGreaterThan(0);
    expect(started).toBeLessThanOrEqual(4);

    // And a refusal does not strand the intent: it is claimable again.
    const { rows } = await db().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM token_spend_intents
        WHERE tenant_id = $1 AND status = 'verifying'`,
      [tenant.id],
    );
    expect(rows[0]!.n).toBe('0');
  });

  it('puts the claim back when the verification does not settle (HIGH)', async () => {
    // A claim that is not released is a strand: the customer cannot retry with
    // the right hash, and nothing but the ten-minute reaper would ever free it.
    await updateTenantSettings(db(), tenant.id, { payoutWallet: PAYOUT });
    const contact = await fundedContact(0, 'retrying@example.com');
    const tenantRow = await tenantObject();
    const { intent } = await createSpendIntent(tenantRow, {
      contact,
      amountTokens: 5,
      fromAddress: CUSTOMER,
    });

    setChainClient(stubChain({ transfersInTx: async () => [] }));
    await expect(verifySpendIntent(tenantRow, intent.id, '0xnope')).rejects.toMatchObject({
      statusCode: 422,
    });
    const afterMiss = await db().query<{ status: string }>(
      'SELECT status FROM token_spend_intents WHERE id = $1',
      [intent.id],
    );
    expect(afterMiss.rows[0]!.status).toBe('pending');

    // An RPC that throws has to release it too.
    setChainClient(
      stubChain({
        transfersInTx: async () => {
          throw new Error('RPC unavailable');
        },
      }),
    );
    await expect(verifySpendIntent(tenantRow, intent.id, '0xnope')).rejects.toThrow(/RPC/);
    const afterThrow = await db().query<{ status: string }>(
      'SELECT status FROM token_spend_intents WHERE id = $1',
      [intent.id],
    );
    expect(afterThrow.rows[0]!.status).toBe('pending');

    // And the customer's real transaction still settles afterwards.
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
    const settled = await verifySpendIntent(tenantRow, intent.id, '0xdeadbeefdeadbeef');
    expect(settled.intent.status).toBe('verified');
  });

  it('settles a transfer that arrived after the quote lapsed (HIGH)', async () => {
    // `expires_at` bounds how long the quote stands; it does not bound the
    // money. A customer who sent their TBAY and lost the tab has tokens at the
    // retailer's payout wallet, and refusing to settle because a sixty-minute
    // timer ran out is keeping it.
    await updateTenantSettings(db(), tenant.id, { payoutWallet: PAYOUT });
    const contact = await fundedContact(0, 'late@example.com');
    const tenantRow = await tenantObject();
    const { intent } = await createSpendIntent(tenantRow, {
      contact,
      amountTokens: 5,
      fromAddress: CUSTOMER,
    });
    await db().query(
      `UPDATE token_spend_intents SET status = 'expired', expires_at = now() - interval '3 days'
        WHERE id = $1`,
      [intent.id],
    );

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

    // Past the settlement window it is closed, and says so rather than
    // silently issuing credit against a year-old quote.
    const { intent: ancient } = await createSpendIntent(tenantRow, {
      contact,
      amountTokens: 5,
      fromAddress: CUSTOMER,
    });
    await db().query(
      `UPDATE token_spend_intents SET status = 'expired', expires_at = now() - interval '400 days'
        WHERE id = $1`,
      [ancient.id],
    );
    await expect(verifySpendIntent(tenantRow, ancient.id, '0xfeedfacefeedface')).rejects.toThrow(
      /can no longer be settled/i,
    );
  });

  it('does not let one verification release another one\'s claim (HIGH)', async () => {
    // `release()` said only "whatever claim exists on this row", so a failing
    // request released a claim a *different*, still-running verification was
    // holding. That one came back from the chain with the customer's real
    // transfer and was told 409 "Spend intent was already settled" -- the
    // opposite of the truth, with the tokens at the retailer's payout wallet
    // and a caller that treats 409 as terminal stopping there.
    await updateTenantSettings(db(), tenant.id, { payoutWallet: PAYOUT });
    const contact = await fundedContact(0, 'contended@example.com');
    const tenantRow = await tenantObject();
    const { intent } = await createSpendIntent(tenantRow, {
      contact,
      amountTokens: 5,
      fromAddress: CUSTOMER,
    });

    let interloper: Promise<unknown> | null = null;
    setChainClient(
      stubChain({
        transfersInTx: async (hash: string) => {
          if (hash === '0xreal' && interloper === null) {
            // While the real verification is on the chain, the worker reaps
            // its claim and a second request with a stale hash takes the row,
            // misses, and releases it.
            await db().query(
              `UPDATE token_spend_intents SET verify_claimed_at = now() - interval '20 minutes'
                WHERE id = $1`,
              [intent.id],
            );
            await expireStaleSpendIntents();
            interloper = verifySpendIntent(tenantRow, intent.id, '0xstale').catch(() => null);
            await interloper;
          }
          return hash === '0xreal'
            ? [
                {
                  from: getAddress(CUSTOMER),
                  to: getAddress(PAYOUT),
                  value: tokensToWei(5),
                  blockNumber: 100,
                  confirmations: 3,
                },
              ]
            : [];
        },
      }),
    );

    // The real settlement must still land, or be refused for a reason that is
    // true. It must never be told the intent was settled when it was not.
    const settled = await verifySpendIntent(tenantRow, intent.id, '0xreal').catch(
      (err: { message?: string }) => ({ error: err.message ?? String(err) }),
    );
    // `message` explicitly, not JSON.stringify: an Error's message is
    // non-enumerable, so stringifying it yields "{}" and the assertion passes
    // whatever went wrong.
    expect(JSON.stringify(settled)).not.toMatch(/already settled/i);

    const { rows } = await db().query<{ status: string; n: string }>(
      `SELECT i.status, (SELECT count(*)::text FROM store_credits WHERE spend_intent_id = i.id) AS n
         FROM token_spend_intents i WHERE i.id = $1`,
      [intent.id],
    );
    expect(rows[0]!.status).toBe('verified');
    expect(rows[0]!.n).toBe('1');
  });

  it('bounds a pending intent by the settlement window too (HIGH)', async () => {
    // The 30-day bound was written into the `expired` arm only, so it leaned
    // entirely on a five-minute worker. With the worker process down -- or
    // RUN_WORKERS=false, which is how the API is meant to run beside a
    // separate worker -- every open intent stayed `pending` and was settleable
    // indefinitely, at a quote that may have carried a promotion since ended.
    await updateTenantSettings(db(), tenant.id, { payoutWallet: PAYOUT });
    const contact = await fundedContact(0, 'ancient@example.com');
    const tenantRow = await tenantObject();
    const { intent } = await createSpendIntent(tenantRow, {
      contact,
      amountTokens: 5,
      fromAddress: CUSTOMER,
    });
    // 400 days past the quote, and the worker never ran: still `pending`.
    await db().query(
      `UPDATE token_spend_intents SET expires_at = now() - interval '400 days' WHERE id = $1`,
      [intent.id],
    );
    expect(
      (await db().query<{ status: string }>('SELECT status FROM token_spend_intents WHERE id = $1', [
        intent.id,
      ])).rows[0]!.status,
    ).toBe('pending');

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
    await expect(verifySpendIntent(tenantRow, intent.id, '0xtoolate')).rejects.toThrow(
      /can no longer be settled/i,
    );

    // The control: the same intent inside the window still settles.
    await db().query(
      `UPDATE token_spend_intents SET expires_at = now() - interval '3 days' WHERE id = $1`,
      [intent.id],
    );
    expect((await verifySpendIntent(tenantRow, intent.id, '0xintime')).intent.status).toBe(
      'verified',
    );
  });

  it('cannot have a live verification cancelled out from under it (HIGH)', async () => {
    // Two rules were shipped together that cannot both be true: the settle
    // says a proved transfer outranks the claim taken to look for it, and
    // cancel says a claim older than ten minutes is abandoned and may be
    // closed -- which the erasure error tells retailers to do. The settle's
    // own justification was that the RPC can outlive that window, because
    // transfersInTx makes several sequential ethers calls whose default
    // timeout is five minutes each. So a cancel taken in good faith voided a
    // transfer already proved on the chain: tokens at the payout wallet,
    // credit unissuable, no reopen path.
    //
    // The RPC is bounded well inside the claim window now, so a stale claim
    // means what the other three places assume. This asserts the bound rather
    // than the race, because the bound is what makes the race impossible.
    await updateTenantSettings(db(), tenant.id, { payoutWallet: PAYOUT });
    const contact = await fundedContact(0, 'slow-rpc@example.com');
    const tenantRow = await tenantObject();
    const { intent } = await createSpendIntent(tenantRow, {
      contact,
      amountTokens: 5,
      fromAddress: CUSTOMER,
    });

    setChainClient(
      stubChain({
        transfersInTx: async () => new Promise(() => {}) as never, // never answers
      }),
    );
    // The *default* bound, exercised. Comparing the two exported constants to
    // each other tests no product code at all: a version that exported the
    // constant and then applied a thirty-minute one instead -- fully
    // reinstating the defect -- passed that assertion unchanged.
    //
    // Fake timers with shouldAdvanceTime, so the database keeps working while
    // the clock jumps.
    const { VERIFY_RPC_TIMEOUT_MS, STALE_VERIFY_CLAIM_MS } = await import(
      '../src/services/token.js'
    );
    expect(VERIFY_RPC_TIMEOUT_MS).toBeLessThan(STALE_VERIFY_CLAIM_MS / 2);

    // And the window the reaper and cancelSpendIntent actually compare against
    // is the same number, not a second literal beside it. As two literals they
    // drifted silently -- a three-minute interval against a ten-minute
    // constant violates the invariant above while every assertion about the
    // constants stays true. Postgres is asked, because Postgres is what reads
    // the interval.
    const { STALE_VERIFY_CLAIM } = await import('../src/services/token.js');
    const parsed = await db().query<{ ms: string }>(
      'SELECT (EXTRACT(EPOCH FROM $1::interval) * 1000)::text AS ms',
      [STALE_VERIFY_CLAIM],
    );
    expect(Number(parsed.rows[0]!.ms)).toBe(STALE_VERIFY_CLAIM_MS);

    // The bound the code actually arms, read off the timer it sets. Waiting
    // two minutes for it is not a test anybody will keep, and faking the clock
    // deadlocks against the database this path queries either side of the RPC.
    const armed: number[] = [];
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: () => void, ms?: number, ...rest: unknown[]) => {
      if (typeof ms === 'number') armed.push(ms);
      return realSetTimeout(fn, ms, ...(rest as []));
    }) as typeof globalThis.setTimeout;
    try {
      await expect(
        verifySpendIntent(tenantRow, intent.id, '0xhangs', { rpcTimeoutMs: 300 }),
      ).rejects.toMatchObject({ statusCode: 504 });
      expect(armed).toContain(300);

      armed.length = 0;
      setChainClient(
        stubChain({
          transfersInTx: async () =>
            new Promise((resolve) => realSetTimeout(() => resolve([]), 50)) as never,
        }),
      );
      await expect(verifySpendIntent(tenantRow, intent.id, '0xslow')).rejects.toMatchObject({
        statusCode: 422,
      });
      // No override: the default is what was armed.
      expect(armed).toContain(VERIFY_RPC_TIMEOUT_MS);
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }

    // And it released the claim, so the customer can retry.
    const { rows } = await db().query<{ status: string; verify_token: string | null }>(
      'SELECT status, verify_token FROM token_spend_intents WHERE id = $1',
      [intent.id],
    );
    expect(rows[0]!.status).toBe('pending');
    expect(rows[0]!.verify_token).toBeNull();
  });

  it('can close an intent stranded mid-verification (MEDIUM)', async () => {
    // Erasure refuses while an intent is being verified and names the cancel
    // route as the remedy -- and the cancel route refused a `verifying` row,
    // so the remedy the error gave could not be carried out. That is the same
    // defect an earlier round fixed, one state narrower.
    await updateTenantSettings(db(), tenant.id, { payoutWallet: PAYOUT });
    const contact = await fundedContact(0, 'stranded@example.com');
    const tenantRow = await tenantObject();
    const { intent } = await createSpendIntent(tenantRow, {
      contact,
      amountTokens: 5,
      fromAddress: CUSTOMER,
    });
    await db().query(
      `UPDATE token_spend_intents
          SET status = 'verifying', verify_claimed_at = now(), verify_token = gen_random_uuid()
        WHERE id = $1`,
      [intent.id],
    );

    // A verification genuinely in progress is left alone.
    expect(await cancelSpendIntent(tenant.id, intent.id)).toBeNull();

    // One whose request never came back is not a verification in progress.
    await db().query(
      `UPDATE token_spend_intents SET verify_claimed_at = now() - interval '20 minutes'
        WHERE id = $1`,
      [intent.id],
    );
    expect((await cancelSpendIntent(tenant.id, intent.id))?.status).toBe('cancelled');
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

describe('an absurd amount is refused, not leaked as a database error (MEDIUM)', () => {
  it('says so in words rather than in Postgres syntax', async () => {
    // Removing tokensToWei's ceiling was right -- it refused amounts a double
    // holds exactly and made the expansion it guarded unreachable -- but it
    // also removed the only thing turning nonsense into a 400. The first
    // objection then came from the bigint column: a 500 reading "invalid input
    // syntax for type bigint: 1e+23", on an endpoint the caller controls. The
    // question belongs where the answer is a number of cents.
    const { quoteCredit } = await import('../src/services/token.js');
    const tenantRow = (await getTenantById(tenant.id))!;

    for (const tokens of [1e21, 1e60, 1e308]) {
      expect(() => quoteCredit(tenantRow, tokensToWei(tokens))).toThrow(
        /more TBAY than this retailer can credit/i,
      );
    }

    // And an amount somebody might actually spend still quotes.
    expect(quoteCredit(tenantRow, tokensToWei(5))).toBeGreaterThan(0);
  });
});

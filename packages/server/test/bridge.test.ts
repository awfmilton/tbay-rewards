import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { getAddress } from 'ethers';
import {
  closeApp,
  closeDb,
  db,
  makeTenant,
  setupDatabase,
  testApp,
  truncateAll,
  type TestTenant,
} from './helpers.js';
import { upsertContact } from '../src/services/contacts.js';
import { award } from '../src/services/points.js';
import { getTenantById } from '../src/services/tenants.js';
import {
  BURN_ADDRESS,
  bridgeSummary,
  listWithdrawals,
  markReleased,
  recordWithdrawal,
  rejectWithdrawal,
  withdrawalInstructions,
} from '../src/services/bridge.js';
import { setChainClient, tokensToWei, type ChainClient, type TokenTransfer } from '../src/lib/chain.js';
import {
  addChainParams,
  bridgeScale,
  chainInfo,
  maxBackedL2Wei,
  splitBridgeAmount,
  txUrl,
} from '../src/lib/chains.js';
import { expireStaleClaims, redeemPointsForTokens, supplyStatus } from '../src/services/token.js';
import { resetConfig } from '../src/config.js';

const HOLDER = getAddress('0x4444444444444444444444444444444444444444');
const OTHER = getAddress('0x7777777777777777777777777777777777777777');
const TREASURY = getAddress('0x33ea3C510337dC8F7938e2aB2b4678F2bc9ccdEE');
const TX = '0x' + 'ab'.repeat(32);
const TX2 = '0x' + 'cd'.repeat(32);

let tenant: TestTenant;

beforeAll(async () => {
  await setupDatabase();
});

beforeEach(async () => {
  await truncateAll();
  await db().query('TRUNCATE bridge_withdrawals, token_supply_budget');
  tenant = await makeTenant();
});

afterAll(async () => {
  await closeApp();
  await closeDb();
});

function stubChain(transfers: TokenTransfer[]): ChainClient {
  return {
    isNonceUsed: async () => false,
    isPaused: async () => false,
    balanceOf: async () => 0n,
    transfersInTx: async () => transfers,
  };
}

function burnEvent(from: string, value: bigint): TokenTransfer {
  return { from: getAddress(from), to: getAddress(BURN_ADDRESS), value, blockNumber: 10, confirmations: 5 };
}

describe('the payout survives an erasure without the wallet doing so (HIGH)', () => {
  /**
   * `payable_to` is the only route by which a recipient destroyed by an
   * erasure can be recovered, and nothing tested it -- the privacy suite
   * imports recipientFor directly and never goes through the API that the
   * documentation points operators at. Deleting the field from the route left
   * every test green while making an outstanding obligation unpayable.
   */
  it('never offers the burn hole as a payout address (HIGH)', async () => {
    // A build before commitments overwrote the wallet with a well-formed
    // 0x...ff. Read back verbatim, that is the operator's answer to "where do
    // I send this L1 release?" -- and a TBAY transfer there is irreversible.
    // Those rows cannot heal themselves either: the erasure that would
    // re-digest them matches on contact_id, which the same statement nulled,
    // and erasure is one-shot.
    const { recipientFor } = await import('../src/services/bridge.js');
    const legacy = { l1_recipient: '0x00000000000000000000000000000000000000ff', burn_tx_hash: TX };

    const chainOf = (transfers: unknown[]) => ({
      isNonceUsed: async () => false,
      isPaused: async () => false,
      balanceOf: async () => 0n,
      transfersInTx: async () => transfers as never,
    });
    const burnFrom = (from: string, value: bigint) => ({
      from, to: BURN_ADDRESS, value, blockNumber: 1, confirmations: 3,
    });

    // One burn in the transaction is unambiguous, and is exactly what
    // recordWithdrawal would have recorded -- but it is not *checked*, so it
    // says so.
    setChainClient(chainOf([burnFrom(HOLDER, 1n)]));
    expect(await recipientFor(legacy)).toEqual({
      address: HOLDER.toLowerCase(),
      verified: false,
    });

    // Several burns and no commitment to break the tie: nobody is paid.
    setChainClient(chainOf([burnFrom(OTHER, 5n), burnFrom(HOLDER, 1n)]));
    expect(await recipientFor(legacy)).toEqual({ address: null, reason: 'ambiguous_legacy' });

    // And anything that is neither an address nor a commitment is refused
    // rather than handed back as one.
    for (const broken of ['', 'erased:9682', 'not-an-address']) {
      expect(await recipientFor({ l1_recipient: broken, burn_tx_hash: TX }), broken).toEqual({
        address: null,
        reason: 'unreadable',
      });
    }
    setChainClient(null);
  });

  it('gives the operator a payout address and nobody else', async () => {
    const app = await testApp();
    const contact = await upsertContact(tenant.id, { email: 'erased-bridge@example.com' });
    await db().query(
      `INSERT INTO bridge_withdrawals (
         tenant_id, contact_id, member_id, from_address, l1_recipient,
         l2_amount_wei, l1_amount, dust_wei, burn_tx_hash, status, l2_chain_id, l1_chain_id
       )
       SELECT $1, $2, c.member_id, $3, $3, 1, 1, 0, $4, 'burn_verified', 300, 1
         FROM contacts c WHERE c.id = $2`,
      [tenant.id, contact.id, HOLDER.toLowerCase(), TX],
    );
    const { eraseContact } = await import('../src/services/privacy.js');
    await eraseContact(tenant.id, contact.id);

    const { rows } = await db().query<{ id: string }>(
      'SELECT id FROM bridge_withdrawals WHERE burn_tx_hash = $1',
      [TX],
    );
    setChainClient({
      isNonceUsed: async () => false,
      isPaused: async () => false,
      balanceOf: async () => 0n,
      transfersInTx: async () => [
        { from: HOLDER, to: BURN_ADDRESS, value: 1n, blockNumber: 1, confirmations: 3 },
      ],
    });

    const get = (headers: Record<string, string>) =>
      app.inject({
        method: 'GET',
        url: `/v1/bridge/withdrawals/${rows[0]!.id}`,
        headers: { authorization: `Bearer ${tenant.secretKey}`, ...headers },
      });

    // The retailer sees the withdrawal but not the wallet: handing an erased
    // person's address back on request is the erasure undone by its own API.
    const plain = JSON.parse((await get({})).body);
    expect(plain.withdrawal.l1_recipient).toMatch(/^erased:/);
    expect(plain.payable_to).toBeUndefined();

    // The operator, who is the only party that can actually send the L1
    // release, gets the address -- checked against the commitment, so a node
    // answering with somebody else's burn cannot redirect it.
    process.env.BRIDGE_OPERATOR_TOKEN = 'operator-test-token';
    const operator = JSON.parse(
      (await get({ 'x-tbay-operator': 'operator-test-token' })).body,
    );
    expect(operator.payable_to).toEqual({ address: HOLDER.toLowerCase(), verified: true });

    const wrong = await get({ 'x-tbay-operator': 'not-the-token' });
    expect(wrong.statusCode).toBe(403);
    delete process.env.BRIDGE_OPERATOR_TOKEN;
    setChainClient(null);
  });
});

describe('bridge rate', () => {
  /**
   * The 10^9 in the deployed contract is decimal conversion, not an exchange
   * rate: 1 whole L1 token becomes exactly 1 whole L2 token. A two-tier design
   * layers a rate on top, and the split has to follow it.
   */
  it('is 1:1 by default, matching the deployed contract', () => {
    const split = splitBridgeAmount(tokensToWei(1));
    expect(split.l1Amount).toBe(10n ** 9n); // one whole L1 token in base units
    expect(split.dust).toBe(0n);
    expect(bridgeScale(1n)).toBe(10n ** 9n);
  });

  it('scales the bridge unit with the rate', () => {
    // At 10,000 L2 per L1, one L1 base unit is worth 10^13 wei.
    expect(bridgeScale(10_000n)).toBe(10n ** 13n);

    const split = splitBridgeAmount(tokensToWei(10_000), 10_000n);
    expect(split.l1Amount).toBe(10n ** 9n); // still exactly one L1 token
    expect(split.dust).toBe(0n);
  });

  it('raises the dust threshold as the rate rises', () => {
    // 10^12 wei crosses at 1:1 but is below the unit at 10,000:1.
    expect(splitBridgeAmount(10n ** 12n, 1n).l1Amount).toBeGreaterThan(0n);
    expect(splitBridgeAmount(10n ** 12n, 10_000n).l1Amount).toBe(0n);
  });

  it('computes what an L1 reserve can back', () => {
    // The whole L1 supply at 1:1 backs 1,000,000 L2 tokens…
    expect(maxBackedL2Wei(1_000_000n, 1n)).toBe(1_000_000n * 10n ** 18n);
    // …and at 10,000:1 it backs 10 billion, which is the two-tier target.
    expect(maxBackedL2Wei(1_000_000n, 10_000n)).toBe(10_000_000_000n * 10n ** 18n);
  });

  it('rejects a nonsensical rate', () => {
    expect(() => bridgeScale(0n)).toThrow();
  });
});

describe('bridge arithmetic', () => {
  it('splits an L2 amount into bridgeable value and dust', () => {
    // L1 has 9 decimals, L2 has 18, so anything below 1e9 wei cannot cross.
    expect(splitBridgeAmount(tokensToWei(1))).toEqual({
      l1Amount: 10n ** 9n,
      burnable: 10n ** 18n,
      dust: 0n,
    });

    const awkward = tokensToWei(1) + 12345n;
    const split = splitBridgeAmount(awkward);
    expect(split.dust).toBe(12345n);
    expect(split.burnable).toBe(10n ** 18n);
  });

  it('quotes a withdrawal and warns about dust before signing', () => {
    const clean = withdrawalInstructions(tokensToWei(5));
    expect(clean.method).toBe('crosschainBurn');
    expect(clean.bridgeableTokens).toBe('5');
    expect(clean.dustNote).toBeNull();

    const dusty = withdrawalInstructions(tokensToWei(5) + 999n);
    expect(dusty.dustWei).toBe('999');
    // Rendered at full precision: at six decimals a 999-wei remainder would
    // read as "0 TBAY", which tells the customer nothing.
    expect(dusty.dustNote).toContain('0.000000000000000999');
    // The contract's dust wrapper returns the remainder to the treasury in the
    // same transaction, so the quote must not imply it stays with the holder.
    expect(dusty.dustNote).toContain('treasury');
    expect(dusty.dustNote).not.toContain('stays in your wallet');
  });

  it('refuses an amount too small to cross at all', () => {
    // Below 1e9 wei there is no whole L1 unit to release.
    expect(() => withdrawalInstructions(999_999_999n)).toThrow();
  });
});

describe('chain registry', () => {
  it('describes zkSync Sepolia the way a wallet expects', () => {
    const chain = chainInfo(300)!;
    expect(chain.chainIdHex).toBe('0x12c');
    expect(chain.rpcUrls[0]).toBe('https://sepolia.era.zksync.dev');
    expect(chain.thirdwebSlug).toBe('zksync-sepolia-testnet');
    expect(chain.testnet).toBe(true);

    const params = addChainParams(300)!;
    expect(params).toMatchObject({ chainId: '0x12c', chainName: 'zkSync Sepolia Testnet' });
    expect(params.blockExplorerUrls).toEqual(['https://sepolia.explorer.zksync.io']);
  });

  it('knows zkSync Era mainnet for launch', () => {
    const chain = chainInfo(324)!;
    expect(chain.chainIdHex).toBe('0x144');
    expect(chain.testnet).toBe(false);
  });

  it('builds explorer links', () => {
    expect(txUrl(300, TX)).toBe(`https://sepolia.explorer.zksync.io/tx/${TX}`);
  });
});

describe('withdrawal recording', () => {
  it('records a verified burn', async () => {
    setChainClient(stubChain([burnEvent(HOLDER, tokensToWei(10))]));

    const { withdrawal, explorerUrl } = await recordWithdrawal({
      burnTxHash: TX,
      fromAddress: HOLDER,
      tenantId: tenant.id,
    });

    expect(withdrawal.status).toBe('burn_verified');
    expect(withdrawal.l2_amount_wei).toBe(tokensToWei(10).toString());
    expect(withdrawal.l1_amount).toBe((10n * 10n ** 9n).toString());
    expect(withdrawal.l1_recipient).toBe(HOLDER.toLowerCase());
    expect(explorerUrl).toContain(TX);
  });

  it('rejects a transaction with no burn in it', async () => {
    setChainClient(stubChain([]));
    await expect(
      recordWithdrawal({ burnTxHash: TX, fromAddress: HOLDER, tenantId: tenant.id }),
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  /**
   * The theft case: someone watches the chain, sees a stranger's burn, and tries
   * to claim the L1 release for themselves.
   */
  it('refuses to credit a burn performed by a different wallet', async () => {
    setChainClient(stubChain([burnEvent(HOLDER, tokensToWei(10))]));

    await expect(
      recordWithdrawal({ burnTxHash: TX, fromAddress: OTHER, tenantId: tenant.id }),
    ).rejects.toMatchObject({ statusCode: 422 });

    expect(await listWithdrawals({})).toHaveLength(0);
  });

  it('cannot reuse one burn for two withdrawals', async () => {
    setChainClient(stubChain([burnEvent(HOLDER, tokensToWei(10))]));

    const first = await recordWithdrawal({ burnTxHash: TX, fromAddress: HOLDER, tenantId: tenant.id });
    const second = await recordWithdrawal({ burnTxHash: TX, fromAddress: HOLDER, tenantId: tenant.id });

    expect(second.withdrawal.id).toBe(first.withdrawal.id);
    expect(await listWithdrawals({})).toHaveLength(1);
  });

  /**
   * The redirection case: a second submission must not be able to point an
   * existing withdrawal at an attacker's L1 address.
   */
  it('does not let a resubmission change the L1 recipient', async () => {
    setChainClient(stubChain([burnEvent(HOLDER, tokensToWei(10))]));

    await recordWithdrawal({ burnTxHash: TX, fromAddress: HOLDER, tenantId: tenant.id });
    const again = await recordWithdrawal({
      burnTxHash: TX,
      fromAddress: HOLDER,
      tenantId: tenant.id,
    });

    expect(again.withdrawal.l1_recipient).toBe(HOLDER.toLowerCase());
  });

  /**
   * The L1 release always goes to whoever burned. Accepting a recipient from
   * the request would let anyone watching the chain redirect a stranger's
   * withdrawal to themselves.
   */
  it('always releases to the burner, never to a nominated address', async () => {
    setChainClient(stubChain([burnEvent(HOLDER, tokensToWei(10))]));
    const { withdrawal } = await recordWithdrawal({
      burnTxHash: TX,
      fromAddress: HOLDER,
      tenantId: tenant.id,
    });
    expect(withdrawal.l1_recipient).toBe(HOLDER.toLowerCase());
    expect(withdrawal.l1_recipient).not.toBe(OTHER.toLowerCase());
  });

  it('rejects a malformed transaction hash', async () => {
    setChainClient(stubChain([]));
    await expect(
      recordWithdrawal({ burnTxHash: '0xtooshort', fromAddress: HOLDER }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('records dust swept to the treasury alongside the burn', async () => {
    setChainClient(
      stubChain([
        burnEvent(HOLDER, tokensToWei(5)),
        { from: HOLDER, to: TREASURY, value: 777n, blockNumber: 10, confirmations: 5 },
      ]),
    );

    const { withdrawal } = await recordWithdrawal({
      burnTxHash: TX,
      fromAddress: HOLDER,
      tenantId: tenant.id,
    });
    expect(withdrawal.dust_wei).toBe('777');
  });
});

describe('withdrawal settlement', () => {
  it('moves to released only from burn_verified, once', async () => {
    setChainClient(stubChain([burnEvent(HOLDER, tokensToWei(10))]));
    const { withdrawal } = await recordWithdrawal({
      burnTxHash: TX,
      fromAddress: HOLDER,
      tenantId: tenant.id,
    });

    const released = await markReleased(withdrawal.id, TX2);
    expect(released?.status).toBe('released');
    expect(released?.release_tx_hash).toBe(TX2);

    // A replayed release must not re-settle an already-released withdrawal.
    expect(await markReleased(withdrawal.id, TX2)).toBeNull();
  });

  it('cannot release a rejected withdrawal', async () => {
    setChainClient(stubChain([burnEvent(HOLDER, tokensToWei(10))]));
    const { withdrawal } = await recordWithdrawal({
      burnTxHash: TX,
      fromAddress: HOLDER,
      tenantId: tenant.id,
    });

    await rejectWithdrawal(withdrawal.id, 'suspected duplicate');
    expect(await markReleased(withdrawal.id, TX2)).toBeNull();
  });

  it('cannot reject an already-released withdrawal', async () => {
    setChainClient(stubChain([burnEvent(HOLDER, tokensToWei(10))]));
    const { withdrawal } = await recordWithdrawal({
      burnTxHash: TX,
      fromAddress: HOLDER,
      tenantId: tenant.id,
    });

    await markReleased(withdrawal.id, TX2);
    expect(await rejectWithdrawal(withdrawal.id, 'too late')).toBeNull();
  });

  it('reports what the operator still owes on L1', async () => {
    setChainClient(stubChain([burnEvent(HOLDER, tokensToWei(10))]));
    await recordWithdrawal({ burnTxHash: TX, fromAddress: HOLDER, tenantId: tenant.id });

    const summary = await bridgeSummary();
    expect(summary.awaiting_release).toBe(1);
    expect(summary.awaiting_release_l1_amount).toBe((10n * 10n ** 9n).toString());
  });

  it('rejects a malformed L1 release hash', async () => {
    setChainClient(stubChain([burnEvent(HOLDER, tokensToWei(10))]));
    const { withdrawal } = await recordWithdrawal({
      burnTxHash: TX,
      fromAddress: HOLDER,
      tenantId: tenant.id,
    });
    await expect(markReleased(withdrawal.id, '0xnope')).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('reward supply budget', () => {
  /**
   * L1 TBAY is a fixed 1,000,000 with no mint function, while L2 MAX_SUPPLY is
   * 100,000,000. The budget is what stops the platform promising more reward
   * tokens than the L1 reserve can ever honour.
   */
  it('stops issuing vouchers once the lifetime cap is committed', async () => {
    process.env.TBAY_REWARD_SUPPLY_CAP_WEI = (2n * 10n ** 18n).toString();
    resetConfig();

    try {
      const contact = await upsertContact(tenant.id, { email: 'whale@example.com' });
      await award(tenant.id, {
        contactId: contact.id,
        points: 100_000,
        reason: 'Grant',
        idempotencyKey: 'g',
      });
      const tenantRow = (await getTenantById(tenant.id))!;

      // 100 points = 1 TBAY, so a 2 TBAY cap allows 200 points of redemption.
      await redeemPointsForTokens(tenantRow, { contact, points: 100, walletAddress: HOLDER });
      await new Promise((resolve) => setTimeout(resolve, 1100));
      await redeemPointsForTokens(tenantRow, { contact, points: 100, walletAddress: HOLDER });
      await new Promise((resolve) => setTimeout(resolve, 1100));

      await expect(
        redeemPointsForTokens(tenantRow, { contact, points: 100, walletAddress: HOLDER }),
      ).rejects.toMatchObject({ statusCode: 422 });

      const status = await supplyStatus();
      expect(status.remaining_wei).toBe('0');
    } finally {
      delete process.env.TBAY_REWARD_SUPPLY_CAP_WEI;
      resetConfig();
    }
  });

  it('keeps budget committed for an aged-out but still-claimable voucher', async () => {
    process.env.TBAY_REWARD_SUPPLY_CAP_WEI = (10n * 10n ** 18n).toString();
    resetConfig();

    try {
      const contact = await upsertContact(tenant.id, { email: 'whale@example.com' });
      await award(tenant.id, {
        contactId: contact.id,
        points: 1000,
        reason: 'Grant',
        idempotencyKey: 'g',
      });
      const tenantRow = (await getTenantById(tenant.id))!;

      const result = await redeemPointsForTokens(tenantRow, {
        contact,
        points: 500,
        walletAddress: HOLDER,
      });
      expect((await supplyStatus()).committed_wei).toBe((5n * 10n ** 18n).toString());

      await db().query(
        `UPDATE token_claims SET expires_at = now() - interval '1 minute' WHERE id = $1`,
        [result.claim.id],
      );
      await expireStaleClaims();

      // Budget stays committed: an aged-out voucher can still be minted, so
      // releasing its allocation would let the platform over-promise.
      expect((await supplyStatus()).committed_wei).toBe((5n * 10n ** 18n).toString());
    } finally {
      delete process.env.TBAY_REWARD_SUPPLY_CAP_WEI;
      resetConfig();
    }
  });

  it('is unlimited when the cap is zero', async () => {
    const status = await supplyStatus();
    expect(status.cap_wei).toBe('0');
    expect(status.remaining_wei).toBeNull();
  });
});

describe('a retailer cannot spend the platform’s allowance (HIGH)', () => {
  /**
   * The hourly mint window and the supply budget are keyed (chain, contract),
   * so every tenant shares them. One store setting pointsPerToken to 1 and
   * redeeming a few million self-adjusted points would lock every OTHER
   * store's customers out with "the TBAY hourly mint allowance is exhausted".
   * A misconfigured conversion rate does that as readily as a malicious one.
   */
  it('stops at its own hourly budget, leaving the shared window intact', async () => {
    // 3 TBAY an hour per retailer; the platform default stays where it is.
    process.env.TBAY_TENANT_MINT_PER_WINDOW_WEI = (3n * 10n ** 18n).toString();
    resetConfig();

    try {
      const greedy = await makeTenant();
      const neighbour = await makeTenant();

      const seed = async (t: TestTenant, email: string) => {
        const contact = await upsertContact(t.id, { email });
        await award(t.id, {
          contactId: contact.id,
          points: 1_000_000,
          reason: 'Grant',
          idempotencyKey: `seed-${t.id}`,
        });
        return contact;
      };

      const hog = await seed(greedy, 'hog@example.com');
      const bystander = await seed(neighbour, 'bystander@example.com');

      const greedyRow = (await getTenantById(greedy.id))!;
      const neighbourRow = (await getTenantById(neighbour.id))!;

      // 100 points = 1 TBAY. Three redemptions fit the 3 TBAY budget.
      for (let i = 0; i < 3; i += 1) {
        await redeemPointsForTokens(greedyRow, {
          contact: hog,
          points: 100,
          walletAddress: HOLDER,
        });
        await new Promise((resolve) => setTimeout(resolve, 1100));
      }

      await expect(
        redeemPointsForTokens(greedyRow, { contact: hog, points: 100, walletAddress: HOLDER }),
      ).rejects.toMatchObject({ statusCode: 429 });

      // The neighbour is entirely unaffected — that is the whole point.
      const ok = await redeemPointsForTokens(neighbourRow, {
        contact: bystander,
        points: 100,
        walletAddress: HOLDER,
      });
      expect(ok.claim.status).toBe('signed');
    } finally {
      delete process.env.TBAY_TENANT_MINT_PER_WINDOW_WEI;
      resetConfig();
    }
  });

  it('gives the refused reservation back rather than counting it', async () => {
    process.env.TBAY_TENANT_MINT_PER_WINDOW_WEI = (2n * 10n ** 18n).toString();
    resetConfig();

    try {
      const contact = await upsertContact(tenant.id, { email: 'refund@example.com' });
      await award(tenant.id, {
        contactId: contact.id,
        points: 100_000,
        reason: 'Grant',
        idempotencyKey: 'refund-seed',
      });
      const tenantRow = (await getTenantById(tenant.id))!;

      // 3 TBAY against a 2 TBAY budget: refused, and the booking must roll
      // back with the transaction or the next, smaller redemption would find
      // the budget already spent by an attempt that never issued anything.
      await expect(
        redeemPointsForTokens(tenantRow, { contact, points: 300, walletAddress: HOLDER }),
      ).rejects.toMatchObject({ statusCode: 429 });

      const booked = await db().query(
        'SELECT minted_wei FROM tenant_token_windows WHERE tenant_id = $1',
        [tenant.id],
      );
      expect(booked.rows.map((row) => row.minted_wei)).toEqual([]);

      const ok = await redeemPointsForTokens(tenantRow, {
        contact,
        points: 100,
        walletAddress: HOLDER,
      });
      expect(ok.claim.status).toBe('signed');
    } finally {
      delete process.env.TBAY_TENANT_MINT_PER_WINDOW_WEI;
      resetConfig();
    }
  });
});

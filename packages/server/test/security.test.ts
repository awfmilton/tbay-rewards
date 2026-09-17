import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { Wallet, getAddress } from 'ethers';
import {
  DESKTOP_UA,
  TEST_WALLET,
  closeApp,
  closeDb,
  db,
  makeTenant,
  setupDatabase,
  testApp,
  truncateAll,
  verifyWalletFor,
  type TestTenant,
} from './helpers.js';
import { upsertContact } from '../src/services/contacts.js';
import { award, getBalance, spend } from '../src/services/points.js';
import { getTenantById } from '../src/services/tenants.js';
import { redeemPointsForTokens } from '../src/services/token.js';
import { recordWithdrawal, BURN_ADDRESS } from '../src/services/bridge.js';
import { setChainClient, tokensToWei, type ChainClient, type TokenTransfer } from '../src/lib/chain.js';
import { createChallenge, verifiedWallet, verifyChallenge } from '../src/services/wallets.js';

/**
 * Regression tests for vulnerabilities found in adversarial review.
 *
 * Each of these was exploitable at some point: they are written from the
 * attacker's side and assert that the attack now fails.
 */

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

const tenantObject = async () => (await getTenantById(tenant.id))!;

function stubChain(transfers: TokenTransfer[]): ChainClient {
  return {
    isNonceUsed: async () => false,
    isPaused: async () => false,
    balanceOf: async () => 0n,
    transfersInTx: async () => transfers,
  };
}

describe('identity takeover via the public site key', () => {
  /**
   * The site key is printed in every page's source. It must never be able to
   * move an existing contact — and the points attached to it — onto an
   * attacker's email address.
   */
  it('cannot repoint an existing contact at an attacker email', async () => {
    const victim = await upsertContact(tenant.id, {
      email: 'victim@example.com',
      name: 'Victim',
      externalRef: '1',
    });
    await award(tenant.id, {
      contactId: victim.id,
      points: 5000,
      reason: 'Loyal customer',
      idempotencyKey: 'v',
    });

    const app = await testApp();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/identify',
      headers: { 'x-tbay-key': tenant.publicKey },
      payload: { email: 'attacker@evil.com', externalRef: '1' },
    });

    // externalRef is not even accepted on this endpoint any more.
    expect(response.statusCode).toBe(400);

    const { rows } = await db().query(
      'SELECT email, external_ref FROM contacts WHERE tenant_id = $1 ORDER BY email',
      [tenant.id],
    );
    expect(rows).toEqual([{ email: 'victim@example.com', external_ref: '1' }]);
    expect((await getBalance(tenant.id, victim.id)).balance).toBe(5000);
  });

  it('refuses to attach an existing email to a different account', async () => {
    await upsertContact(tenant.id, { email: 'victim@example.com', externalRef: '1' });

    const app = await testApp();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/contacts',
      headers: { authorization: `Bearer ${tenant.secretKey}` },
      payload: { email: 'victim@example.com', externalRef: '57' },
    });

    // Even with the secret key this is a merge, not a takeover — it must not
    // silently move the victim's contact under the attacker's user id unless
    // the caller explicitly asked for an identity change.
    expect(response.statusCode).toBe(200);
    const { rows } = await db().query(
      'SELECT COUNT(*)::int AS n FROM contacts WHERE tenant_id = $1',
      [tenant.id],
    );
    expect(rows[0].n).toBe(1);
  });

  it('still lets a brand-new visitor identify themselves', async () => {
    const app = await testApp();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/identify',
      headers: { 'x-tbay-key': tenant.publicKey },
      payload: { email: 'newcomer@example.com', name: 'Newcomer' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().contact_id).toBeTruthy();
  });
});

describe('redemption cannot mint more than it spends', () => {
  it('signs exactly one voucher per points debit under a burst', async () => {
    const contact = await upsertContact(tenant.id, { email: 'holder@example.com' });
    await award(tenant.id, { contactId: contact.id, points: 100, reason: 'g', idempotencyKey: 'g' });
    await verifyWalletFor(tenant.id, contact.id, TEST_WALLET);
    const t = await tenantObject();

    // One honest redemption plus two inflated ones, fired together.
    const results = await Promise.allSettled([
      redeemPointsForTokens(t, { contact, points: 100, walletAddress: TEST_WALLET.address }),
      redeemPointsForTokens(t, { contact, points: 100_000, walletAddress: TEST_WALLET.address }),
      redeemPointsForTokens(t, { contact, points: 100_000, walletAddress: TEST_WALLET.address }),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);

    const { rows } = await db().query(
      'SELECT token_amount_wei FROM token_claims WHERE tenant_id = $1',
      [tenant.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].token_amount_wei).toBe(tokensToWei(1).toString());
    expect((await getBalance(tenant.id, contact.id)).balance).toBe(0);
  });

  it('rejects a borrowed idempotency key for a different debit', async () => {
    const a = await upsertContact(tenant.id, { email: 'a@example.com' });
    const b = await upsertContact(tenant.id, { email: 'b@example.com' });
    await award(tenant.id, { contactId: a.id, points: 100, reason: 'g', idempotencyKey: 'ga' });

    await spend(tenant.id, {
      contactId: a.id,
      points: 100,
      reason: 'Redeemed',
      idempotencyKey: 'shared-key',
    });

    // b has no points at all; reusing a's key must not buy them a free pass.
    await expect(
      spend(tenant.id, {
        contactId: b.id,
        points: 100,
        reason: 'Redeemed',
        idempotencyKey: 'shared-key',
      }),
    ).rejects.toMatchObject({ statusCode: 409 });

    expect((await getBalance(tenant.id, b.id)).balance).toBe(0);
  });
});

describe('wallet ownership', () => {
  it('refuses to bind a wallet without a valid signature', async () => {
    const contact = await upsertContact(tenant.id, { email: 'holder@example.com' });
    const t = await tenantObject();
    const challenge = await createChallenge(t, contact, TEST_WALLET.address);

    const impostor = Wallet.createRandom();
    const signature = await impostor.signMessage(challenge.message);

    await expect(
      verifyChallenge(t, contact, { nonce: challenge.nonce, signature, message: challenge.message }),
    ).rejects.toMatchObject({ statusCode: 403 });

    expect(await verifiedWallet(tenant.id, contact.id)).toBeNull();
  });

  it('will not let one member redeem another member’s challenge', async () => {
    const owner = await upsertContact(tenant.id, { email: 'owner@example.com' });
    const attacker = await upsertContact(tenant.id, { email: 'attacker@example.com' });
    const t = await tenantObject();

    const challenge = await createChallenge(t, owner, TEST_WALLET.address);
    const signature = await TEST_WALLET.signMessage(challenge.message);

    await expect(
      verifyChallenge(t, attacker, { nonce: challenge.nonce, signature, message: challenge.message }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('consumes a challenge so a captured signature cannot be replayed', async () => {
    const contact = await upsertContact(tenant.id, { email: 'holder@example.com' });
    const t = await tenantObject();

    const challenge = await createChallenge(t, contact, TEST_WALLET.address);
    const signature = await TEST_WALLET.signMessage(challenge.message);

    await verifyChallenge(t, contact, { nonce: challenge.nonce, signature, message: challenge.message });

    await expect(
      verifyChallenge(t, contact, { nonce: challenge.nonce, signature, message: challenge.message }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('rejects an expired challenge', async () => {
    const contact = await upsertContact(tenant.id, { email: 'holder@example.com' });
    const t = await tenantObject();
    const challenge = await createChallenge(t, contact, TEST_WALLET.address);
    const signature = await TEST_WALLET.signMessage(challenge.message);

    await db().query(
      `UPDATE wallet_challenges SET expires_at = now() - interval '1 minute' WHERE nonce = $1`,
      [challenge.nonce],
    );

    await expect(
      verifyChallenge(t, contact, { nonce: challenge.nonce, signature, message: challenge.message }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('blocks redemption until a wallet is proved', async () => {
    const contact = await upsertContact(tenant.id, { email: 'holder@example.com' });
    await award(tenant.id, { contactId: contact.id, points: 1000, reason: 'g', idempotencyKey: 'g' });

    const app = await testApp();
    const before = await app.inject({
      method: 'POST',
      url: '/v1/token/redeem',
      headers: { authorization: `Bearer ${tenant.secretKey}` },
      payload: { contactId: contact.id, points: 500, walletAddress: TEST_WALLET.address },
    });
    expect(before.statusCode).toBe(403);

    await verifyWalletFor(tenant.id, contact.id, TEST_WALLET);

    const after = await app.inject({
      method: 'POST',
      url: '/v1/token/redeem',
      headers: { authorization: `Bearer ${tenant.secretKey}` },
      payload: { contactId: contact.id, points: 500, walletAddress: TEST_WALLET.address },
    });
    expect(after.statusCode).toBe(200);
  });

  it('refuses to mint to an address other than the proved one', async () => {
    const contact = await upsertContact(tenant.id, { email: 'holder@example.com' });
    await award(tenant.id, { contactId: contact.id, points: 1000, reason: 'g', idempotencyKey: 'g' });
    await verifyWalletFor(tenant.id, contact.id, TEST_WALLET);

    const app = await testApp();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/token/redeem',
      headers: { authorization: `Bearer ${tenant.secretKey}` },
      payload: {
        contactId: contact.id,
        points: 500,
        walletAddress: '0x9999999999999999999999999999999999999999',
      },
    });

    expect(response.statusCode).toBe(403);
    expect((await getBalance(tenant.id, contact.id)).balance).toBe(1000);
  });
});

describe('bridge withdrawals cannot be hijacked', () => {
  const VICTIM = getAddress('0x4444444444444444444444444444444444444444');
  const ATTACKER = getAddress('0x7777777777777777777777777777777777777777');
  const TX = '0x' + 'ab'.repeat(32);

  it('cannot claim a stranger’s burn by naming their address', async () => {
    setChainClient(
      stubChain([
        {
          from: VICTIM,
          to: getAddress(BURN_ADDRESS),
          value: tokensToWei(10),
          blockNumber: 1,
          confirmations: 5,
        },
      ]),
    );

    // The attacker submits the victim's burn, declaring themselves the burner.
    await expect(
      recordWithdrawal({ burnTxHash: TX, fromAddress: ATTACKER, tenantId: tenant.id }),
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it('releases only to the burner even when submitted by someone else', async () => {
    setChainClient(
      stubChain([
        {
          from: VICTIM,
          to: getAddress(BURN_ADDRESS),
          value: tokensToWei(10),
          blockNumber: 1,
          confirmations: 5,
        },
      ]),
    );

    const { withdrawal } = await recordWithdrawal({
      burnTxHash: TX,
      fromAddress: VICTIM,
      tenantId: tenant.id,
    });

    expect(withdrawal.l1_recipient).toBe(VICTIM.toLowerCase());
  });

  it('requires a proved wallet before an identified member can bridge', async () => {
    const contact = await upsertContact(tenant.id, { email: 'holder@example.com' });
    setChainClient(stubChain([]));

    const app = await testApp();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/bridge/withdrawals',
      headers: { authorization: `Bearer ${tenant.secretKey}` },
      payload: { contactId: contact.id, burnTxHash: TX },
    });

    expect(response.statusCode).toBe(403);
  });
});

describe('share rewards need a genuine third-party click', () => {
  it('pays nothing when the sharer clicks their own link', async () => {
    const { createShare } = await import('../src/services/shares.js');
    const { recordLinkClickForShare } = await import('../src/services/shares.js');

    const sharer = await upsertContact(tenant.id, { email: 'sharer@example.com' });
    const share = await createShare(await tenantObject(), {
      contactId: sharer.id,
      network: 'x',
      targetUrl: 'https://shop.example.com/product/flag',
    });

    await recordLinkClickForShare(db(), tenant.id, share.link.code, { contactId: sharer.id });

    expect((await getBalance(tenant.id, sharer.id)).balance).toBe(0);
  });

  it('still pays when a different person clicks', async () => {
    const { createShare, recordLinkClickForShare } = await import('../src/services/shares.js');

    const sharer = await upsertContact(tenant.id, { email: 'sharer@example.com' });
    const friend = await upsertContact(tenant.id, { email: 'friend@example.com' });
    const share = await createShare(await tenantObject(), {
      contactId: sharer.id,
      network: 'x',
      targetUrl: 'https://shop.example.com/product/flag',
    });

    await recordLinkClickForShare(db(), tenant.id, share.link.code, { contactId: friend.id });

    expect((await getBalance(tenant.id, sharer.id)).balance).toBe(25);
  });
});

describe('tenant isolation', () => {
  it('will not let one retailer read another retailer’s contact', async () => {
    const other = await makeTenant();
    await upsertContact(tenant.id, { email: 'mine@example.com' });

    const app = await testApp();
    const response = await app.inject({
      method: 'GET',
      url: '/v1/contacts/lookup?email=mine@example.com',
      headers: { authorization: `Bearer ${other.secretKey}` },
    });
    expect(response.statusCode).toBe(404);
  });

  it('will not let one retailer see another retailer’s withdrawal', async () => {
    const other = await makeTenant();
    const TX = '0x' + 'cd'.repeat(32);
    setChainClient(
      stubChain([
        {
          from: getAddress('0x4444444444444444444444444444444444444444'),
          to: getAddress(BURN_ADDRESS),
          value: tokensToWei(1),
          blockNumber: 1,
          confirmations: 5,
        },
      ]),
    );
    const { withdrawal } = await recordWithdrawal({
      burnTxHash: TX,
      fromAddress: '0x4444444444444444444444444444444444444444',
      tenantId: tenant.id,
    });

    const app = await testApp();
    const response = await app.inject({
      method: 'GET',
      url: `/v1/bridge/withdrawals/${withdrawal.id}`,
      headers: { authorization: `Bearer ${other.secretKey}` },
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('ingest scope', () => {
  it('cannot reach the reporting API with a site key', async () => {
    const app = await testApp();
    for (const url of ['/v1/reports/overview', '/v1/rewards/balance?email=a@b.com', '/v1/orders']) {
      const response = await app.inject({
        method: url === '/v1/orders' ? 'POST' : 'GET',
        url,
        headers: { authorization: `Bearer ${tenant.publicKey}`, 'user-agent': DESKTOP_UA },
        ...(url === '/v1/orders' ? { payload: { orderRef: 'x', totalCents: 1 } } : {}),
      });
      expect(response.statusCode).toBe(401);
    }
  });
});

describe('configuration preflight', () => {
  /**
   * The expensive launch mistakes here are all silent: a mainnet deployment
   * with no reward budget works perfectly until the first person tries to
   * bridge and finds the reserve empty.
   */
  it('refuses to call an uncapped mainnet deployment healthy', async () => {
    const { resetConfig } = await import('../src/config.js');
    const { preflight } = await import('../src/lib/preflight.js');

    process.env.TBAY_CHAIN_ID = '324'; // zkSync Era mainnet
    process.env.TBAY_REWARD_SUPPLY_CAP_WEI = '0';
    resetConfig();

    try {
      const codes = preflight().map((f) => f.code);
      expect(codes).toContain('uncapped_on_mainnet');
      expect(preflight().find((f) => f.code === 'uncapped_on_mainnet')!.level).toBe('error');
    } finally {
      delete process.env.TBAY_CHAIN_ID;
      delete process.env.TBAY_REWARD_SUPPLY_CAP_WEI;
      resetConfig();
    }
  });

  it('refuses a production deployment with weak or shared secrets', async () => {
    const { resetConfig } = await import('../src/config.js');
    const { preflight } = await import('../src/lib/preflight.js');

    const saved = {
      env: process.env.NODE_ENV,
      salt: process.env.IDENTITY_SALT,
      token: process.env.TOKEN_SECRET,
      url: process.env.PUBLIC_URL,
    };

    try {
      process.env.NODE_ENV = 'production';

      // Short enough to brute-force. TOKEN_SECRET signs unsubscribe and
      // preference links; IDENTITY_SALT is what stops a hashed email being
      // reversed with a wordlist.
      process.env.IDENTITY_SALT = 'short';
      process.env.TOKEN_SECRET = 'alsoshort';
      process.env.PUBLIC_URL = 'https://rewards.example.com';
      resetConfig();
      expect(preflight().map((f) => f.code)).toContain('weak_secret');

      // One value doing two jobs: a weakness in either is a weakness in both.
      const shared = 'a'.repeat(48);
      process.env.IDENTITY_SALT = shared;
      process.env.TOKEN_SECRET = shared;
      resetConfig();
      expect(preflight().map((f) => f.code)).toContain('shared_secret');

      // Cookies are Secure in production, so over plain http the browser never
      // sends them back and attribution silently stops.
      process.env.IDENTITY_SALT = 'a'.repeat(48);
      process.env.TOKEN_SECRET = 'b'.repeat(48);
      process.env.PUBLIC_URL = 'http://rewards.example.com';
      resetConfig();
      expect(preflight().map((f) => f.code)).toContain('insecure_public_url');

      // And a sound configuration raises none of them.
      process.env.PUBLIC_URL = 'https://rewards.example.com';
      resetConfig();
      const codes = preflight().map((f) => f.code);
      expect(codes).not.toContain('weak_secret');
      expect(codes).not.toContain('shared_secret');
      expect(codes).not.toContain('insecure_public_url');
    } finally {
      if (saved.env === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = saved.env;
      if (saved.salt === undefined) delete process.env.IDENTITY_SALT;
      else process.env.IDENTITY_SALT = saved.salt;
      if (saved.token === undefined) delete process.env.TOKEN_SECRET;
      else process.env.TOKEN_SECRET = saved.token;
      if (saved.url === undefined) delete process.env.PUBLIC_URL;
      else process.env.PUBLIC_URL = saved.url;
      resetConfig();
    }
  });

  it('rejects a cap larger than the L1 reserve can back', async () => {
    const { resetConfig } = await import('../src/config.js');
    const { preflight } = await import('../src/lib/preflight.js');

    // 2,000,000 L2 TBAY at 1:1, against an L1 supply fixed at 1,000,000.
    process.env.TBAY_REWARD_SUPPLY_CAP_WEI = (2_000_000n * 10n ** 18n).toString();
    resetConfig();

    try {
      expect(preflight().map((f) => f.code)).toContain('cap_exceeds_backing');
    } finally {
      delete process.env.TBAY_REWARD_SUPPLY_CAP_WEI;
      resetConfig();
    }
  });

  it('accepts the same cap once the bridge rate backs it', async () => {
    const { resetConfig } = await import('../src/config.js');
    const { preflight } = await import('../src/lib/preflight.js');

    // 10 billion L2 is fine at 10,000:1 against the full million.
    process.env.TBAY_REWARD_SUPPLY_CAP_WEI = (10_000_000_000n * 10n ** 18n).toString();
    process.env.TBAY_BRIDGE_L2_PER_L1 = '10000';
    process.env.TBAY_L1_RESERVE_TOKENS = '1000000';
    resetConfig();

    try {
      const codes = preflight().filter((f) => f.level === 'error').map((f) => f.code);
      expect(codes).not.toContain('cap_exceeds_backing');
      // …but the deployed contract is still 1:1, and that is worth saying.
      expect(preflight().map((f) => f.code)).toContain('bridge_rate_not_one');
    } finally {
      delete process.env.TBAY_REWARD_SUPPLY_CAP_WEI;
      delete process.env.TBAY_BRIDGE_L2_PER_L1;
      delete process.env.TBAY_L1_RESERVE_TOKENS;
      resetConfig();
    }
  });

  it('refuses a reserve larger than the L1 supply', async () => {
    const { resetConfig } = await import('../src/config.js');
    const { preflight } = await import('../src/lib/preflight.js');

    process.env.TBAY_L1_RESERVE_TOKENS = '5000000';
    resetConfig();

    try {
      expect(preflight().map((f) => f.code)).toContain('reserve_exceeds_l1_supply');
    } finally {
      delete process.env.TBAY_L1_RESERVE_TOKENS;
      resetConfig();
    }
  });

  it('flags claim refunds as unsafe against a contract with no deadline', async () => {
    const { resetConfig } = await import('../src/config.js');
    const { preflight } = await import('../src/lib/preflight.js');

    process.env.CLAIM_REFUND_ON_EXPIRY = 'true';
    resetConfig();

    try {
      const finding = preflight().find((f) => f.code === 'unsafe_claim_refunds');
      expect(finding?.level).toBe('error');
    } finally {
      delete process.env.CLAIM_REFUND_ON_EXPIRY;
      resetConfig();
    }
  });

  it('is quiet on a correctly configured testnet', async () => {
    const { preflight } = await import('../src/lib/preflight.js');
    // The test environment is zkSync Sepolia with an uncapped budget, which is
    // exactly right for a testnet.
    expect(preflight().filter((f) => f.level === 'error')).toHaveLength(0);
  });

  it('reports preflight findings on /health', async () => {
    const app = await testApp();
    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toHaveProperty('preflight');
    expect(response.json()).toHaveProperty('supply');
    expect(response.json().status).toBe('ok');
  });
});

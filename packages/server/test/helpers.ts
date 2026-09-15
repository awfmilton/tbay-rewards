import { Wallet } from 'ethers';
import type { FastifyInstance } from 'fastify';

// Configure the environment before anything imports ./src/config.js.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://root:root@localhost:5432/tbay_rewards_test';
process.env.IDENTITY_SALT = 'test-identity-salt';
process.env.TOKEN_SECRET = 'test-token-secret';
process.env.PUBLIC_URL = 'http://localhost:4000';
process.env.LOG_LEVEL = 'silent';
process.env.EMAIL_TRANSPORT = 'log';
process.env.RUN_WORKERS = 'false';
process.env.MIGRATE_ON_BOOT = 'false';
// Deterministic key so signature assertions are stable. Test-only.
process.env.TBAY_CLAIM_SIGNER_KEY =
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';

const { migrate, resetDatabase } = await import('../src/db/migrate.js');
const { db, closeDb } = await import('../src/db/pool.js');
const { provisionTenant } = await import('../src/services/provision.js');
const { clearTenantCache } = await import('../src/services/tenants.js');
const { resetRateLimits } = await import('../src/lib/ratelimit.js');
const { setChainClient, setClaimSigner } = await import('../src/lib/chain.js');
const { buildApp } = await import('../src/app.js');

export { db, closeDb };
export type { FastifyInstance };

export const TEST_SIGNER = new Wallet(process.env.TBAY_CLAIM_SIGNER_KEY);

let migrated = false;

/** Drop and re-migrate once per test process. */
export async function setupDatabase(): Promise<void> {
  if (migrated) return;
  await resetDatabase();
  await migrate();
  migrated = true;
}

/** Wipe all tenant-scoped data between tests, keeping the schema. */
export async function truncateAll(): Promise<void> {
  await db().query(`
    TRUNCATE tenants, members, token_mint_windows RESTART IDENTITY CASCADE
  `);
  clearTenantCache();
  resetRateLimits();
  setChainClient(null);
  setClaimSigner(null);
}

export interface TestTenant {
  id: string;
  slug: string;
  publicKey: string;
  secretKey: string;
}

let tenantCounter = 0;

export async function makeTenant(
  overrides: { settings?: Record<string, unknown>; currency?: string } = {},
): Promise<TestTenant> {
  tenantCounter += 1;
  const slug = `test-${tenantCounter}-${Date.now().toString(36)}`;
  const created = await provisionTenant({
    slug,
    name: `Test Retailer ${tenantCounter}`,
    currency: overrides.currency ?? 'USD',
    settings: { siteUrl: 'https://shop.example.com', ...(overrides.settings ?? {}) },
  });
  return {
    id: created.tenant.id,
    slug,
    publicKey: created.publicKey,
    secretKey: created.secretKey,
  };
}

let app: FastifyInstance | null = null;

export async function testApp(): Promise<FastifyInstance> {
  if (!app) {
    app = await buildApp();
    await app.ready();
  }
  return app;
}

export async function closeApp(): Promise<void> {
  if (app) {
    await app.close();
    app = null;
  }
}

/** Reload a tenant row, e.g. after changing settings. */
export async function tenantRow(tenantId: string) {
  const { rows } = await db().query('SELECT * FROM tenants WHERE id = $1', [tenantId]);
  return rows[0]!;
}

export function ids(): { visitor: string; session: string } {
  const suffix = Math.random().toString(36).slice(2, 10);
  return { visitor: `visitor-${suffix}-aaaa`, session: `session-${suffix}-aaaa` };
}

/**
 * Bind a wallet to a contact by actually signing the challenge, the same way a
 * customer's wallet would. Redemption and bridging both require a proved wallet,
 * so most token tests need this.
 */
export async function verifyWalletFor(
  tenantId: string,
  contactId: string,
  wallet: Wallet,
): Promise<string> {
  const { getTenantById } = await import('../src/services/tenants.js');
  const { getContact } = await import('../src/services/contacts.js');
  const { createChallenge, verifyChallenge } = await import('../src/services/wallets.js');

  const tenant = (await getTenantById(tenantId))!;
  const contact = (await getContact(tenantId, contactId))!;

  const challenge = await createChallenge(tenant, contact, wallet.address);
  const signature = await wallet.signMessage(challenge.message);

  const updated = await verifyChallenge(tenant, contact, {
    nonce: challenge.nonce,
    signature,
    message: challenge.message,
  });
  return updated.wallet_address!;
}

/** A deterministic customer wallet for tests that need one. */
export const TEST_WALLET = new Wallet(
  '0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356',
);

export const DESKTOP_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
export const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
export const BOT_UA = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

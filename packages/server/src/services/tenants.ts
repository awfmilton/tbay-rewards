import { db, queryOne } from '../db/pool.js';
import type { Queryable } from '../db/pool.js';
import { hashToken, randomToken, sha256 } from '../lib/crypto.js';
import { ApiError } from '../lib/errors.js';

export interface Tenant {
  id: string;
  slug: string;
  name: string;
  status: string;
  timezone: string;
  currency: string;
  pii_salt: string;
  settings: TenantSettings;
}

export interface TenantSettings {
  /** Page-key patterns like "/product/:slug" so heatmaps group templated pages. */
  pageKeyPatterns?: string[];
  /** Wallet that receives TBAY when a customer spends it at this retailer. */
  payoutWallet?: string;
  /** Overrides for the platform reward economics. */
  pointsPerToken?: number;
  creditCentsPerToken?: number;
  commissionRateBps?: number;
  /** Sender identity for this retailer's transactional email. */
  fromName?: string;
  fromEmail?: string;
  brandColor?: string;
  logoUrl?: string;
  siteUrl?: string;
  [key: string]: unknown;
}

const cache = new Map<string, { tenant: Tenant; expires: number }>();
const CACHE_TTL_MS = 30_000;

export function clearTenantCache(): void {
  cache.clear();
}

export async function getTenantById(id: string): Promise<Tenant | null> {
  return queryOne<Tenant>(db(), 'SELECT * FROM tenants WHERE id = $1', [id]);
}

export async function getTenantBySlug(slug: string): Promise<Tenant | null> {
  return queryOne<Tenant>(db(), 'SELECT * FROM tenants WHERE slug = $1', [slug]);
}

/**
 * Resolve a public (browser-safe) key. These only authorise ingest writes, so a
 * short positive cache is fine — revocation takes effect within CACHE_TTL_MS.
 */
export async function resolvePublicKey(keyId: string): Promise<Tenant | null> {
  const cached = cache.get(keyId);
  if (cached && cached.expires > Date.now()) return cached.tenant;

  const tenant = await queryOne<Tenant>(
    db(),
    `SELECT t.*
       FROM tenant_keys k
       JOIN tenants t ON t.id = k.tenant_id
      WHERE k.key_id = $1
        AND k.kind = 'public'
        AND k.revoked_at IS NULL
        AND t.status = 'active'`,
    [keyId],
  );
  if (!tenant) return null;
  cache.set(keyId, { tenant, expires: Date.now() + CACHE_TTL_MS });
  return tenant;
}

/**
 * Resolve a secret key presented as `<key_id>.<secret>`. The secret half is
 * compared against a stored HMAC, never a plaintext column.
 */
export async function resolveSecretKey(presented: string): Promise<Tenant | null> {
  const dot = presented.indexOf('.');
  if (dot <= 0) return null;
  const keyId = presented.slice(0, dot);
  const secret = presented.slice(dot + 1);

  const row = await queryOne<Tenant & { secret_hash: string }>(
    db(),
    `SELECT t.*, k.secret_hash
       FROM tenant_keys k
       JOIN tenants t ON t.id = k.tenant_id
      WHERE k.key_id = $1
        AND k.kind = 'secret'
        AND k.revoked_at IS NULL
        AND t.status = 'active'`,
    [keyId],
  );
  if (!row || row.secret_hash !== hashToken(secret)) return null;

  // Fire-and-forget: last-used is observability, not correctness.
  void db()
    .query('UPDATE tenant_keys SET last_used_at = now() WHERE key_id = $1', [keyId])
    .catch(() => {});

  const { secret_hash: _ignored, ...tenant } = row;
  return tenant as Tenant;
}

export interface CreatedTenant {
  tenant: Tenant;
  publicKey: string;
  secretKey: string;
}

/** Provision a retailer with a fresh public/secret key pair and default content. */
export async function createTenant(input: {
  slug: string;
  name: string;
  currency?: string;
  timezone?: string;
  settings?: TenantSettings;
  domains?: string[];
}): Promise<CreatedTenant> {
  const existing = await getTenantBySlug(input.slug);
  if (existing) throw ApiError.conflict(`Tenant "${input.slug}" already exists`);

  const tenant = await queryOne<Tenant>(
    db(),
    `INSERT INTO tenants (slug, name, currency, timezone, pii_salt, settings)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [
      input.slug,
      input.name,
      input.currency ?? 'USD',
      input.timezone ?? 'UTC',
      randomToken(16),
      JSON.stringify(input.settings ?? {}),
    ],
  );
  if (!tenant) throw new Error('Failed to create tenant');

  const publicKey = `tbp_${randomToken(16)}`;
  const secretId = `tbs_${randomToken(8)}`;
  const secretValue = randomToken(24);

  await db().query(
    `INSERT INTO tenant_keys (tenant_id, kind, key_id, label)
     VALUES ($1, 'public', $2, 'default')`,
    [tenant.id, publicKey],
  );
  await db().query(
    `INSERT INTO tenant_keys (tenant_id, kind, key_id, secret_hash, label)
     VALUES ($1, 'secret', $2, $3, 'default')`,
    [tenant.id, secretId, hashToken(secretValue)],
  );

  for (const domain of input.domains ?? []) {
    await db().query(
      `INSERT INTO tenant_domains (tenant_id, domain) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [tenant.id, domain.toLowerCase()],
    );
  }

  return { tenant, publicKey, secretKey: `${secretId}.${secretValue}` };
}

export async function tenantDomains(tenantId: string): Promise<string[]> {
  const { rows } = await db().query<{ domain: string }>(
    'SELECT domain FROM tenant_domains WHERE tenant_id = $1',
    [tenantId],
  );
  return rows.map((row) => row.domain);
}

export async function updateTenantSettings(
  runner: Queryable,
  tenantId: string,
  patch: TenantSettings,
): Promise<void> {
  await runner.query(
    `UPDATE tenants
        SET settings = settings || $2::jsonb, updated_at = now()
      WHERE id = $1`,
    [tenantId, JSON.stringify(patch)],
  );
  clearTenantCache();
}

/** Stable fingerprint of a tenant's settings, handy for cache keys in reports. */
export function settingsFingerprint(tenant: Tenant): string {
  return sha256(JSON.stringify(tenant.settings ?? {})).slice(0, 12);
}


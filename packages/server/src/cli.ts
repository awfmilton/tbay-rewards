/**
 * Operator CLI.
 *
 *   npm run cli -- tenant:create --slug flagswag --name "Flag Swag" --domain flagswag.ca
 *   npm run cli -- tenant:list
 *   npm run cli -- key:issue --slug flagswag --kind secret
 */
import { db, closeDb } from './db/pool.js';
import { config } from './config.js';
import { provisionTenant } from './services/provision.js';
import { getTenantBySlug } from './services/tenants.js';
import { hashToken, randomToken } from './lib/crypto.js';

function flag(name: string, fallback?: string): string {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1 || index === process.argv.length - 1) {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing required flag --${name}`);
  }
  return process.argv[index + 1]!;
}

function flags(name: string): string[] {
  const values: string[] = [];
  process.argv.forEach((arg, index) => {
    if (arg === `--${name}` && process.argv[index + 1]) values.push(process.argv[index + 1]!);
  });
  return values;
}

const command = process.argv[2];

try {
  switch (command) {
    case 'tenant:create': {
      const created = await provisionTenant({
        slug: flag('slug'),
        name: flag('name'),
        currency: flag('currency', 'USD'),
        timezone: flag('timezone', 'UTC'),
        domains: flags('domain'),
        settings: { siteUrl: flag('site-url', '') || undefined },
      });
      console.log('\nTenant provisioned.\n');
      console.log(`  id          ${created.tenant.id}`);
      console.log(`  slug        ${created.tenant.slug}`);
      console.log(`  public key  ${created.publicKey}      (safe in page source)`);
      console.log(`  secret key  ${created.secretKey}   (server only — shown once)\n`);
      console.log('Embed the tracker with:\n');
      console.log(
        `  <script src="${config().publicUrl}/tbay.js" data-key="${created.publicKey}" defer></script>\n`,
      );
      break;
    }

    case 'tenant:list': {
      const { rows } = await db().query<{ slug: string; name: string; status: string; created_at: Date }>(
        'SELECT slug, name, status, created_at FROM tenants ORDER BY created_at',
      );
      if (rows.length === 0) console.log('No tenants yet.');
      for (const row of rows) {
        console.log(`${row.slug.padEnd(24)} ${row.status.padEnd(10)} ${row.name}`);
      }
      break;
    }

    case 'key:issue': {
      const slug = flag('slug');
      const kind = flag('kind', 'secret');
      const tenant = await getTenantBySlug(slug);
      if (!tenant) throw new Error(`No tenant with slug "${slug}"`);

      if (kind === 'public') {
        const key = `tbp_${randomToken(16)}`;
        await db().query(
          `INSERT INTO tenant_keys (tenant_id, kind, key_id, label) VALUES ($1, 'public', $2, $3)`,
          [tenant.id, key, flag('label', 'cli')],
        );
        console.log(`public key  ${key}`);
      } else {
        const keyId = `tbs_${randomToken(8)}`;
        const secretValue = randomToken(24);
        await db().query(
          `INSERT INTO tenant_keys (tenant_id, kind, key_id, secret_hash, label)
           VALUES ($1, 'secret', $2, $3, $4)`,
          [tenant.id, keyId, hashToken(secretValue), flag('label', 'cli')],
        );
        console.log(`secret key  ${keyId}.${secretValue}   (shown once)`);
      }
      break;
    }

    case 'key:revoke': {
      const { rowCount } = await db().query(
        'UPDATE tenant_keys SET revoked_at = now() WHERE key_id = $1 AND revoked_at IS NULL',
        [flag('key')],
      );
      console.log(rowCount ? 'Key revoked.' : 'No matching active key.');
      break;
    }

    default:
      console.log(`Usage:
  tenant:create --slug <slug> --name <name> [--currency USD] [--domain example.com ...] [--site-url https://…]
  tenant:list
  key:issue --slug <slug> [--kind public|secret] [--label <label>]
  key:revoke --key <key_id>`);
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await closeDb();
}

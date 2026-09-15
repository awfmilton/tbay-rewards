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

    case 'settings:set': {
      const slug = flag('slug');
      const tenant = await getTenantBySlug(slug);
      if (!tenant) throw new Error(`No tenant with slug "${slug}"`);

      const patch: Record<string, unknown> = {};
      if (process.argv.includes('--payout-wallet')) patch.payoutWallet = flag('payout-wallet');
      if (process.argv.includes('--site-url')) patch.siteUrl = flag('site-url');
      if (process.argv.includes('--points-per-token')) {
        patch.pointsPerToken = Number(flag('points-per-token'));
      }
      if (process.argv.includes('--credit-bonus-bps')) {
        patch.creditBonusBps = Number(flag('credit-bonus-bps'));
      }
      if (process.argv.includes('--commission-rate-bps')) {
        patch.commissionRateBps = Number(flag('commission-rate-bps'));
      }
      for (const pattern of flags('page-pattern')) {
        patch.pageKeyPatterns = [...((patch.pageKeyPatterns as string[]) ?? []), pattern];
      }

      if (Object.keys(patch).length === 0) {
        console.log('Nothing to change. Current settings:');
        console.log(JSON.stringify(tenant.settings, null, 2));
        break;
      }

      const { updateTenantSettings } = await import('./services/tenants.js');
      await updateTenantSettings(db(), tenant.id, patch);
      const updated = await getTenantBySlug(slug);
      console.log(JSON.stringify(updated?.settings, null, 2));
      break;
    }

    case 'webhook:add': {
      const slug = flag('slug');
      const tenant = await getTenantBySlug(slug);
      if (!tenant) throw new Error(`No tenant with slug "${slug}"`);

      const secret = flag('secret');
      await db().query(
        `INSERT INTO webhooks (tenant_id, url, secret, topics) VALUES ($1, $2, $3, $4::text[])`,
        [tenant.id, flag('url'), secret, flags('topic')],
      );
      console.log('Webhook registered. Use the same secret in the WordPress settings screen.');
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
  key:revoke --key <key_id>
  settings:set --slug <slug> [--payout-wallet 0x…] [--site-url https://…]
               [--points-per-token 100] [--credit-bonus-bps 0]
               [--commission-rate-bps 500] [--page-pattern /product/:slug ...]
  webhook:add --slug <slug> --url https://shop.example/wp-json/tbay/v1/webhook
              --secret <signing secret> [--topic points_awarded ...]`);
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await closeDb();
}

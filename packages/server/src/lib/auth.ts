import type { FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { ApiError } from './errors.js';
import { rateLimit } from './ratelimit.js';
import { resolvePublicKey, resolveSecretKey, type Tenant } from '../services/tenants.js';

declare module 'fastify' {
  interface FastifyRequest {
    tenant?: Tenant;
    authScope?: 'public' | 'secret';
  }
}

function bearer(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (!header) return null;
  const [scheme, value] = header.split(' ');
  if (!value || scheme?.toLowerCase() !== 'bearer') return null;
  return value.trim();
}

/**
 * Public-key auth for the browser tracker. The key is visible in page source, so
 * it may only write ingest data — never read reports or move points.
 */
export async function requirePublicKey(request: FastifyRequest): Promise<Tenant> {
  const key =
    (request.headers['x-tbay-key'] as string | undefined) ??
    (request.query as Record<string, string> | undefined)?.key ??
    (request.body as Record<string, string> | undefined)?.key;

  if (!key) throw ApiError.unauthorized('Missing x-tbay-key');

  const tenant = await resolvePublicKey(key);
  if (!tenant) throw ApiError.unauthorized('Unknown or revoked site key');

  // Two buckets, because neither key works alone.
  //
  // Per tenant is too coarse: one allowance split across every visitor at once
  // means, at the tracker's 8-second flush, that the default 600/minute is 80
  // concurrent visitors for the entire store, and the tracker drops a 429
  // silently. Per visitor is not a limit at all: the id comes out of the
  // request body, so rotating it buys unlimited throughput -- measured at
  // 800/800 requests through a 600/minute bucket.
  //
  // So the address, which the caller cannot choose, carries the ceiling, and
  // the visitor id only subdivides it. Behind NAT everyone shares the ceiling
  // but gets their own small bucket; rotating the id now just fills the
  // address bucket faster.
  const security = config().security;
  const address = clientIp(request);

  const addressLimit = rateLimit(
    `ingest:${tenant.id}:i:${address}`,
    security.ingestRatePerAddressPerMinute,
  );
  if (!addressLimit.allowed) throw ApiError.tooManyRequests();

  const visitor = visitorKey(request);
  if (visitor !== null) {
    const visitorLimit = rateLimit(
      `ingest:${tenant.id}:i:${address}:a:${visitor}`,
      security.ingestRatePerMinute,
    );
    if (!visitorLimit.allowed) throw ApiError.tooManyRequests();
  }

  request.tenant = tenant;
  request.authScope = 'public';
  return tenant;
}

/** Secret-key auth for server-to-server calls from the storefront. */
export async function requireSecretKey(request: FastifyRequest): Promise<Tenant> {
  const key = bearer(request) ?? (request.headers['x-tbay-secret'] as string | undefined);
  if (!key) throw ApiError.unauthorized('Missing API secret');

  const tenant = await resolveSecretKey(key);
  if (!tenant) throw ApiError.unauthorized('Invalid API secret');

  const limit = rateLimit(`admin:${tenant.id}`, config().security.adminRatePerMinute);
  if (!limit.allowed) throw ApiError.tooManyRequests();

  request.tenant = tenant;
  request.authScope = 'secret';
  // The role guard and the audit log both read these; see lib/authorise.ts.
  request.role = tenant.keyContext?.role ?? 'owner';
  request.operatorId = tenant.keyContext?.operatorId ?? null;
  request.keyId = tenant.keyContext?.keyId ?? null;
  request.actorLabel = tenant.keyContext?.label ?? '';
  return tenant;
}

export function tenantOf(request: FastifyRequest): Tenant {
  if (!request.tenant) throw ApiError.unauthorized();
  return request.tenant;
}

/**
 * The client address.
 *
 * Reads request.ip rather than the header, because Fastify resolves that
 * against the configured number of trusted proxy hops. Taking the leftmost
 * X-Forwarded-For entry by hand -- which this used to do -- returns whatever
 * the caller put there: nginx appends to the header rather than replacing it,
 * so the left-hand end is the client's own claim. See
 * config.security.trustProxyHops.
 */
export function clientIp(request: FastifyRequest): string {
  return request.ip;
}

/**
 * The visitor id the tracker sent, when it sent a usable one.
 *
 * Only ever used to subdivide an address bucket, never as a bucket of its own:
 * it is a string from the request body, so a caller who wants more allowance
 * writes a different one. Rotating it used to buy unlimited throughput.
 *
 * The field is `visitor`, which is what the tracker and the collect schema
 * actually use. This read `anonId` -- a name that appears nowhere else in the
 * product -- so it returned null on every real request and the per-visitor
 * bucket simply did not exist: everyone behind one address shared a single
 * ceiling with no subdivision, which is the exact failure the bucket is for.
 * The tests passed because they sent `anonId` too.
 */
function visitorKey(request: FastifyRequest): string | null {
  const body = request.body as Record<string, unknown> | undefined;
  const id = typeof body?.visitor === 'string' ? body.visitor : null;
  return id !== null && id !== '' && id.length <= 64 ? id : null;
}

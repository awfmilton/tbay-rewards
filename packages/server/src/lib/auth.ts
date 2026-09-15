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

  const limit = rateLimit(`ingest:${tenant.id}`, config().security.ingestRatePerMinute);
  if (!limit.allowed) throw ApiError.tooManyRequests();

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
  return tenant;
}

export function tenantOf(request: FastifyRequest): Tenant {
  if (!request.tenant) throw ApiError.unauthorized();
  return request.tenant;
}

/** Client IP, trusting one layer of reverse proxy. */
export function clientIp(request: FastifyRequest): string {
  const forwarded = request.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0]!.trim();
  }
  return request.ip;
}

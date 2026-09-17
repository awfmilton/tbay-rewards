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
export async function requirePublicKey(
  request: FastifyRequest,
  options: { expectVisitor?: boolean } = {},
): Promise<Tenant> {
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

  // On the ingest routes, a request with no readable visitor id still gets a
  // visitor-sized bucket rather than no bucket at all.
  //
  // Skipping it made "send nothing the limiter can read" a way out of the
  // subdivision: the request then answered only to the per-address ceiling,
  // which is five times a visitor's share. Padding the GET beacon's `d` with
  // trailing whitespace -- legal JSON, decodes fine, and the handler accepts it
  // -- did exactly that on every request, and so did any tracker batch over
  // 8 KB. The cost is not extra throughput (rotating the id reaches the same
  // ceiling) but the fairness the subdivision exists for: on one shared
  // address, the caller with no id could spend every colleague's allowance.
  //
  // Only where a visitor is expected. `/v1/config` and the subscribe endpoints
  // are page-level calls with nobody to identify, and pooling every browser
  // behind one egress address into a single visitor-sized bucket would be a
  // limit on the storefront rather than on an abuser.
  const visitor = visitorKey(request) ?? (options.expectVisitor ? '-' : null);
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
  const fromBody = typeof body?.visitor === 'string' ? body.visitor : null;
  return usable(fromBody) ?? usable(visitorFromQuery(request));
}

function usable(id: string | null): string | null {
  return id !== null && id !== '' && id.length <= 64 ? id : null;
}

/**
 * The visitor id on the GET fallback, which has no body to read.
 *
 * `/v1/collect` also accepts its whole payload base64url-encoded in `d`, for
 * environments that block POST beacons — and there the per-visitor bucket
 * silently did not apply, so one visitor on that path got the full per-address
 * ceiling instead of their own share. Decoded here rather than left to the
 * handler because this is where the limiter decides, and the handler runs
 * after it.
 *
 * Bounded and forgiving: this is a rate-limit key, so a payload that will not
 * decode simply has no visitor and falls back to the address on its own. The
 * handler is what reports the error.
 */
function visitorFromQuery(request: FastifyRequest): string | null {
  // Only what is inside `d`, which is the only thing the handler reads.
  //
  // Preferring a plain `?visitor=` meant the limiter and the handler disagreed
  // about who the visitor was: rotate the query parameter and every request
  // opened a fresh bucket while all the events still landed on the one real
  // visitor. That is the bypass this function was added to close, reopened by
  // a line meant as a convenience.
  const query = request.query as Record<string, unknown> | undefined;
  const packed = query?.d;
  // Sized so it never fires on anything that can actually arrive, rather than
  // on anything anyone would send.
  //
  // At 8192 it fired constantly and in both directions. An attacker padded `d`
  // with trailing whitespace past the cap -- still valid JSON, still accepted
  // by the handler -- and bought themselves the whole per-address ceiling; and
  // a legitimate full batch of 200 events encodes to 16,247 characters, so the
  // tracker's own large flushes lost their bucket too. A cap that the honest
  // path trips over is not a defence, it is the bypass with extra steps.
  //
  // Node caps a request line and its headers at 16 KB by default, so 64 KB is
  // past anything a GET can carry; the decode below is a few microseconds on
  // input that size and the handler is about to do exactly the same one. If a
  // deployment does raise that limit, an oversized `d` falls through to the
  // anonymous bucket rather than to no bucket at all.
  if (typeof packed !== 'string' || packed === '' || packed.length > 65_536) return null;
  try {
    const decoded: unknown = JSON.parse(Buffer.from(packed, 'base64url').toString('utf8'));
    const visitor = (decoded as Record<string, unknown> | null)?.visitor;
    return typeof visitor === 'string' ? visitor : null;
  } catch {
    return null;
  }
}

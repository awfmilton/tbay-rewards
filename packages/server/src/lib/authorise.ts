import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ApiError } from './errors.js';
import { clientIp } from './auth.js';
import { hashPii } from './crypto.js';
import { atLeast, recordAudit, type Role } from '../services/operators.js';

/**
 * What a key may do, and a record of what it did.
 *
 * One hook rather than a guard per route, and that is the whole point: a
 * permission check written at each call site is a permission check somebody
 * forgets on the route they add next month, and nobody notices until the
 * support contractor deletes a customer. Here there is one place to read, one
 * place to audit, and a new route is covered the moment it exists.
 */

declare module 'fastify' {
  interface FastifyRequest {
    /** The role this credential carries. Legacy keys read as `owner`. */
    role?: Role;
    operatorId?: string | null;
    keyId?: string | null;
    actorLabel?: string;
  }
}

/**
 * Routes that need more than the default.
 *
 * Ordered, first match wins. Everything unlisted falls to the defaults below:
 * a read needs `readonly`, a write needs `manager`. That way a route added
 * later is protected rather than open, and the list only has to name the
 * exceptions — the things narrower or broader than "an operational change".
 */
const RULES: Array<{ method?: string; prefix: string; role: Role }> = [
  // Issuing credentials and naming people is the owner's, always. A manager
  // who can mint an owner key is an owner.
  { prefix: '/v1/operators', role: 'owner' },
  { prefix: '/v1/keys', role: 'owner' },
  { prefix: '/v1/settings', method: 'PUT', role: 'owner' },

  // Irreversible or outward-facing. Support can look at anything and correct a
  // balance; it cannot delete a person, send to the whole list, or merge two
  // records into one.
  { prefix: '/v1/privacy/erase', role: 'manager' },
  { prefix: '/v1/contacts/merge', method: 'POST', role: 'manager' },
  { prefix: '/v1/broadcasts', method: 'POST', role: 'manager' },
  { prefix: '/v1/privacy/retention', method: 'PUT', role: 'manager' },

  // The daily work of answering a customer.
  { prefix: '/v1/rewards/adjust', role: 'support' },
  { prefix: '/v1/gamification/badges/award', role: 'support' },
  { prefix: '/v1/contacts/field-values', method: 'PUT', role: 'support' },
  { prefix: '/v1/email/preferences', method: 'PUT', role: 'support' },
  { prefix: '/v1/contacts', method: 'POST', role: 'support' },
];

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function requiredRole(method: string, path: string): Role {
  for (const rule of RULES) {
    if (rule.method && rule.method !== method) continue;
    if (path.startsWith(rule.prefix)) return rule.role;
  }
  return READ_METHODS.has(method) ? 'readonly' : 'manager';
}

/**
 * The path to match the rules against.
 *
 * The router percent-decodes before it dispatches, so `/v1/%6beys` reaches the
 * `/v1/keys` handler. Matching the *raw* target against `/v1/keys` therefore
 * failed, the request fell through to the defaults — a write needs `manager` —
 * and a manager minted itself an owner key. Case and trailing slashes were
 * never the hole; the encoding was, and any list of variants to normalise is a
 * list somebody has to keep complete.
 *
 * So this asks the router what it matched. `routeOptions.url` is the registered
 * pattern (`/v1/keys`, `/v1/point-types/:key`) — already decoded, already
 * canonical, and the same string however the caller spelled it.
 *
 * The fallbacks are for a request that matched no route, where there is no
 * pattern to read. Decoding can itself throw on a malformed escape, and the
 * safe answer to "I cannot tell what this is" is the strictest rule, not the
 * loosest.
 */
export function guardPath(request: FastifyRequest): string {
  const pattern = request.routeOptions?.url;
  if (typeof pattern === 'string' && pattern !== '') return pattern;

  const raw = request.url.split('?')[0] ?? '';
  try {
    return decodeURIComponent(raw);
  } catch {
    return '';
  }
}

/**
 * Which of a request's fields are worth keeping.
 *
 * Deliberately a short allow-list rather than the whole body. An audit log that
 * copies every field becomes a second store of the personal data the first one
 * is careful about — and the useful answer to "what did they change" is the
 * amount and the reason, not the customer's address again.
 */
const AUDITED_FIELDS = [
  'points',
  'pointType',
  'reason',
  'idempotencyKey',
  'key',
  'rankKey',
  'badgeKey',
  'keep',
  'merge',
  'role',
  'forfeitPoints',
  'enabled',
  'segment',
  'templateKey',
] as const;

function summarise(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object') return {};
  const source = body as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const field of AUDITED_FIELDS) {
    if (Object.hasOwn(source, field)) out[field] = source[field];
  }
  return out;
}

/** The customer an action was about, when there is one. */
function targetOf(request: FastifyRequest): string | null {
  const body = (request.body ?? {}) as Record<string, unknown>;
  const query = (request.query ?? {}) as Record<string, unknown>;
  for (const key of ['contactId', 'keep', 'email']) {
    const value = body[key] ?? query[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return null;
}

/**
 * Attach the guard and the log to every route registered on `app`.
 *
 * The check runs `onRequest`, before a handler does any work; the log is
 * written `onResponse`, so it records what actually happened rather than what
 * was attempted — including a refusal, which is the entry somebody most wants
 * to find.
 */
export function withAuthorisation(app: FastifyInstance): void {
  // `preHandler`, not `onRequest`.
  //
  // Each route plugin authenticates in its own `onRequest` hook, and a hook on
  // the root instance runs *before* a plugin's — so an onRequest check here
  // would read the role before anything had set it, and pass everything. The
  // preHandler phase is after every onRequest hook and before the handler,
  // which is exactly the window this needs.
  app.addHook('preHandler', async (request: FastifyRequest) => {
    // Only credentialed routes. Public ingest has no operator and no role.
    if (request.authScope !== 'secret') return;

    const path = guardPath(request);
    // A request that matched no route and will not decode: there is no way to
    // know which rule covers it, so it gets the strictest one.
    const need = path === '' ? 'owner' : requiredRole(request.method, path);
    const have = request.role ?? 'owner';

    if (!atLeast(have, need)) {
      throw ApiError.forbidden(
        `This key has the "${have}" role; that needs "${need}"`,
        { role: have, required: need },
      );
    }
  });

  app.addHook('onResponse', async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.authScope !== 'secret') return;
    // Reads are not logged. A log of every GET buries the twelve entries that
    // matter under a hundred thousand that do not, and the reads are covered
    // by the access log anyway.
    if (READ_METHODS.has(request.method)) return;

    const tenant = request.tenant;
    if (!tenant) return;

    await recordAudit(tenant.id, {
      operatorId: request.operatorId ?? null,
      keyId: request.keyId ?? null,
      actorLabel: request.actorLabel ?? '',
      role: request.role ?? null,
      // The matched route, not what the caller typed: an encoded path recorded
      // verbatim is an entry nobody searching for the real one will find.
      action: `${request.method} ${guardPath(request)}`,
      status: reply.statusCode,
      target: targetOf(request),
      detail: summarise(request.body),
      ipHash: hashPii(clientIp(request), tenant.pii_salt),
    });
  });
}

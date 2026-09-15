import type { FastifyInstance } from 'fastify';
import { withTransaction } from '../db/pool.js';
import { clientIp } from '../lib/auth.js';
import { ApiError } from '../lib/errors.js';
import { config } from '../config.js';
import { getLinkByCode, issueAttributionCookie, recordClick } from '../services/links.js';
import { creditShareClick } from '../services/shares.js';
import { getTenantById } from '../services/tenants.js';
import { confirmSubscription, unsubscribeByEmail, unsubscribeByToken } from '../services/newsletter.js';
import { getCartByRecoveryToken } from '../services/carts.js';

/**
 * Human-facing endpoints: link redirects, opt-in confirmation, unsubscribe and
 * cart recovery. All GET, all safe to hit from an email client's link scanner
 * (which is why the destructive ones are idempotent).
 */
export async function redirectRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { code: string } }>('/r/:code', async (request, reply) => {
    const link = await getLinkByCode(request.params.code);
    if (!link || link.disabled_at) throw ApiError.notFound('Unknown link');

    const tenant = await getTenantById(link.tenant_id);
    if (!tenant) throw ApiError.notFound('Unknown link');

    const { clickUuid, isBot } = await withTransaction(async (client) => {
      const recorded = await recordClick(client, tenant, link, {
        ip: clientIp(request),
        userAgent: request.headers['user-agent'] ?? null,
        referrer: request.headers.referer ?? null,
        landingUrl: link.target_url,
      });

      // A share only pays out on a genuine human click.
      if (!recorded.isBot && link.kind === 'share') {
        await creditShareClick(client, tenant.id, link.id);
      }
      // The tracker credits the click with visitor context once the landing
      // page loads, which is where a self-click is actually detectable.
      return recorded;
    });

    const target = appendTracking(link.target_url, link.code);

    if (!isBot) {
      const cookie = issueAttributionCookie(tenant.id, link, clickUuid);
      reply.header(
        'set-cookie',
        serializeCookie(cookie.name, cookie.value, {
          maxAge: cookie.maxAge,
          path: '/',
          sameSite: 'Lax',
          httpOnly: true,
          secure: config().isProduction,
        }),
      );
    }

    // 302, not 301: a cached permanent redirect would stop click tracking dead.
    return reply.code(302).header('cache-control', 'no-store').redirect(target);
  });

  app.get<{ Params: { token: string } }>('/n/confirm/:token', async (request, reply) => {
    const result = await confirmSubscription(request.params.token);
    if (!result) {
      return reply.type('text/html').code(404).send(
        page('Link expired', 'That confirmation link is no longer valid. Please sign up again.'),
      );
    }
    const tenant = await getTenantById(result.tenant_id);
    return reply
      .type('text/html')
      .send(
        page(
          'You are subscribed',
          `Thanks for confirming. You are now on the ${tenant?.name ?? ''} list, and any signup reward has been added to your account.`,
        ),
      );
  });

  app.get<{ Params: { token: string } }>('/n/unsubscribe/:token', async (request, reply) => {
    await unsubscribeByToken(request.params.token);
    // Always the same answer: the token must not become an address oracle.
    return reply
      .type('text/html')
      .send(page('Unsubscribed', 'You will not receive any further marketing email from us.'));
  });

  /**
   * Email-address unsubscribe, for messages sent outside a list subscription.
   *
   * Automation and cart-recovery mail is addressed to a contact rather than a
   * list subscription, so there is no per-subscription token to embed. This
   * gives those messages a working one-click opt-out — which the law requires
   * and which was previously a 404.
   *
   * Answers identically whether or not the address exists, so it cannot be used
   * to test which addresses are on file.
   */
  app.get<{ Querystring: { email?: string; t?: string } }>(
    '/n/unsubscribe-request',
    async (request, reply) => {
      const email = String(request.query.email ?? '').trim();
      const tenantId = String(request.query.t ?? '').trim();

      if (email !== '' && tenantId !== '') {
        await unsubscribeByEmail(tenantId, email).catch(() => false);
      }

      return reply
        .type('text/html')
        .send(page('Unsubscribed', 'You will not receive any further marketing email from us.'));
    },
  );

  app.get<{ Params: { token: string } }>('/c/:token', async (request, reply) => {
    const cart = await getCartByRecoveryToken(request.params.token);
    if (!cart) throw ApiError.notFound('That cart link has expired');

    const tenant = await getTenantById(cart.tenant_id);
    const destination =
      cart.checkout_url ?? (tenant?.settings?.siteUrl as string | undefined) ?? config().publicUrl;

    return reply
      .code(302)
      .header('cache-control', 'no-store')
      .redirect(appendParam(destination, 'tb_cart', cart.cart_token));
  });
}

/** Carry the link code onto the destination so the tracker can pick it up. */
function appendTracking(targetUrl: string, code: string): string {
  return appendParam(targetUrl, 'tb_ref', code);
}

function appendParam(rawUrl: string, key: string, value: string): string {
  try {
    const url = new URL(rawUrl);
    url.searchParams.set(key, value);
    return url.toString();
  } catch {
    return rawUrl;
  }
}

function serializeCookie(
  name: string,
  value: string,
  opts: { maxAge: number; path: string; sameSite: string; httpOnly: boolean; secure: boolean },
): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Max-Age=${opts.maxAge}`,
    `Path=${opts.path}`,
    `SameSite=${opts.sameSite}`,
  ];
  if (opts.httpOnly) parts.push('HttpOnly');
  if (opts.secure) parts.push('Secure');
  return parts.join('; ');
}

function page(title: string, body: string): string {
  const esc = (value: string) =>
    value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin:0; min-height:100vh; display:grid; place-items:center;
         font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;
         background:#f5f5f7; color:#1d1d1f; padding:24px; }
  main { background:#fff; border-radius:14px; padding:40px; max-width:460px; text-align:center;
         box-shadow:0 1px 3px rgba(0,0,0,.08); }
  h1 { margin:0 0 12px; font-size:22px; }
  p { margin:0; font-size:15px; line-height:1.55; color:#3a3a3c; }
  @media (prefers-color-scheme: dark) {
    body { background:#000; color:#f5f5f7; }
    main { background:#1c1c1e; box-shadow:none; }
    p { color:#aeaeb2; }
  }
</style></head>
<body><main><h1>${esc(title)}</h1><p>${esc(body)}</p></main></body></html>`;
}

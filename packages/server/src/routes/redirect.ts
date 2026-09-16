import type { FastifyInstance, FastifyRequest } from 'fastify';
import { withTransaction } from '../db/pool.js';
import { clientIp } from '../lib/auth.js';
import { ApiError } from '../lib/errors.js';
import { config } from '../config.js';
import { getLinkByCode, issueAttributionCookie, recordClick } from '../services/links.js';
import { creditShareClick } from '../services/shares.js';
import { getTenantById } from '../services/tenants.js';
import { confirmSubscription, unsubscribeByEmail, unsubscribeByToken } from '../services/newsletter.js';
import { getCartByRecoveryToken } from '../services/carts.js';
import { messageByToken, recordEngagement } from '../services/email-tracking.js';
import { fire } from '../services/automations.js';
import { getContact } from '../services/contacts.js';
import { suppress } from '../services/deliverability.js';

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

  /**
   * The open pixel.
   *
   * Always returns the GIF, even for an unknown token: a 404 here would tell
   * an email client (and anyone probing) which tokens are real, and a broken
   * image in a customer's inbox is a worse outcome than an unrecorded open.
   */
  app.get<{ Params: { token: string } }>('/e/:token/o.gif', async (request, reply) => {
    await recordEmailHit(request, request.params.token, 'open', null);

    return reply
      .type('image/gif')
      .header('cache-control', 'no-store, no-cache, must-revalidate, private')
      .header('pragma', 'no-cache')
      .send(TRANSPARENT_GIF);
  });

  /**
   * A tracked link from an email.
   *
   * The destination comes from the message's stored link list by index, never
   * from the request. Taking a URL from the query string would make this an
   * open redirect on a domain customers have been told to trust, which is the
   * raw material of a phishing campaign.
   */
  app.get<{ Params: { token: string; index: string } }>(
    '/e/:token/c/:index',
    async (request, reply) => {
      const index = Number(request.params.index);
      if (!Number.isInteger(index) || index < 0) throw ApiError.notFound('Unknown link');

      const hit = await recordEmailHit(request, request.params.token, 'click', index);
      if (!hit?.url) throw ApiError.notFound('Unknown link');

      return reply.code(302).header('cache-control', 'no-store').redirect(hit.url);
    },
  );

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

  /**
   * One-click unsubscribe, GET and POST.
   *
   * RFC 8058 requires the URL in `List-Unsubscribe` to accept a POST carrying
   * `List-Unsubscribe=One-Click`, which is how a mail client's own unsubscribe
   * button works without the recipient visiting anything. Advertising the
   * header and then only handling GET is worse than not advertising it: the
   * client shows a button whose POST is silently ignored.
   *
   * POST answers 200 with no body, because nothing renders it.
   */
  app.route<{ Params: { token: string } }>({
    method: ['GET', 'POST'],
    url: '/n/unsubscribe/:token',
    handler: async (request, reply) => {
      await unsubscribeByToken(request.params.token);

      if (request.method === 'POST') {
        return reply.code(200).send();
      }
      // Always the same answer: the token must not become an address oracle.
      return reply
        .type('text/html')
        .send(page('Unsubscribed', 'You will not receive any further marketing email from us.'));
    },
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
  app.route<{ Querystring: { email?: string; t?: string } }>({
    method: ['GET', 'POST'],
    url: '/n/unsubscribe-request',
    handler: async (request, reply) => {
      const email = String(request.query.email ?? '').trim();
      const tenantId = String(request.query.t ?? '').trim();

      if (email !== '' && tenantId !== '') {
        await unsubscribeByEmail(tenantId, email).catch(() => false);
        // Suppress the address as well, so the decision survives a later
        // re-import of the contact or a second subscription row.
        await suppress(tenantId, email, 'manual', 'Unsubscribed from an email link').catch(
          () => null,
        );
      }

      if (request.method === 'POST') {
        return reply.code(200).send();
      }
      return reply
        .type('text/html')
        .send(page('Unsubscribed', 'You will not receive any further marketing email from us.'));
    },
  });

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

/** 1x1 transparent GIF, the smallest thing that renders in every mail client. */
const TRANSPARENT_GIF = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64',
);

/**
 * Record one open or click and fire its automation.
 *
 * Never throws for a missing message: both callers are reached from a mail
 * client, where an error page or a broken image is visible to the customer and
 * an unrecorded hit is not.
 */
async function recordEmailHit(
  request: FastifyRequest,
  token: string,
  kind: 'open' | 'click',
  linkIndex: number | null,
): Promise<{ url: string | null } | null> {
  const message = await messageByToken(token);
  if (!message) return null;

  const tenant = await getTenantById(message.tenant_id);
  if (!tenant) return null;

  const result = await recordEngagement(tenant, message, kind, linkIndex, {
    ip: clientIp(request),
    userAgent: request.headers['user-agent'] ?? null,
  });

  // Only the first human engagement fires an automation. Without that, a
  // client that renders the pixel on every scroll would re-trigger a
  // follow-up sequence for as long as the message stayed open.
  if (result.first && !result.isBot) {
    const contact = message.contact_id
      ? await getContact(tenant.id, message.contact_id)
      : null;

    await fire(tenant.id, kind === 'open' ? 'email.opened' : 'email.clicked', {
      contact,
      data: {
        template_key: message.template_key,
        message_id: message.id,
        url: result.url,
      },
      dedupeKey: `email:${kind}:${message.id}`,
    });
  }

  return { url: result.url };
}

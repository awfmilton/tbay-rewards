import type { FastifyInstance, FastifyRequest } from 'fastify';
import { withTransaction } from '../db/pool.js';
import { clientIp } from '../lib/auth.js';
import { ApiError } from '../lib/errors.js';
import { config } from '../config.js';
import { getLinkByCode, issueAttributionCookie, recordClick } from '../services/links.js';
import { creditShareClick } from '../services/shares.js';
import { getTenantById } from '../services/tenants.js';
import {
  confirmSubscription,
  unsubscribeByEmail,
  unsubscribeByToken,
  verifyUnsubscribeRequest,
} from '../services/newsletter.js';
import { getCartByRecoveryToken } from '../services/carts.js';
import { messageByToken, recordEngagement } from '../services/email-tracking.js';
import { fire } from '../services/automations.js';
import { findContactByEmail, getContact } from '../services/contacts.js';
import {
  getPreferences,
  recordUnsubscribe,
  setPreferences,
  verifyPreferencesToken,
  type Preferences,
} from '../services/preferences.js';
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
  /**
   * Unsubscribe from a signed link.
   *
   * The signature covers exactly the (tenant, address) pair being acted on.
   * The previous form took both from the query string with no authentication
   * at all — and the tenant id is printed in the unsubscribe link of every
   * marketing email, so one received message revealed it and anyone could walk
   * a list and suppress a competitor's whole audience with a shell loop.
   *
   * GET asks; POST acts. That split is not decoration either: corporate link
   * scanners (Safe Links, Proofpoint and the rest) fetch every URL in every
   * message, so a destructive GET unsubscribes precisely the recipients whose
   * employer scans their mail. RFC 8058 one-click sends POST, so the mail
   * client's own unsubscribe button still works in one step.
   */
  app.route<{ Params: { token: string } }>({
    method: ['GET', 'POST'],
    url: '/n/u/:token',
    handler: async (request, reply) => {
      const verified = verifyUnsubscribeRequest(request.params.token);
      if (!verified) {
        return reply
          .type('text/html')
          .code(400)
          .send(
            page(
              'Link not valid',
              'That unsubscribe link is not one we recognise. If you received email you did not ask for, reply to it and we will remove you.',
            ),
          );
      }

      if (request.method === 'GET') {
        return reply.type('text/html').send(
          confirmPage(
            'Unsubscribe?',
            `This will stop all marketing email to ${escapeHtml(verified.email)}.`,
            `${config().publicUrl}/n/u/${encodeURIComponent(request.params.token)}`,
          ),
        );
      }

      await unsubscribeByEmail(verified.tenantId, verified.email).catch(() => false);
      // Suppressed as well, so the decision survives a later re-import of the
      // contact or a second subscription row.
      await suppress(
        verified.tenantId,
        verified.email,
        'manual',
        'Unsubscribed from an email link',
      ).catch(() => null);

      return reply
        .type('text/html')
        .send(page('Unsubscribed', 'You will not receive any further marketing email from us.'));
    },
  });


  /**
   * The preference centre.
   *
   * Unsubscribe is binary, and most people who click it do not want silence —
   * they want less, or they want one of the four things a store sends. Offered
   * only the binary choice they take it, and the list loses somebody who would
   * have stayed on a monthly digest.
   *
   * Signed exactly like the unsubscribe link, and split the same way: GET
   * renders, POST acts. Corporate link scanners fetch every URL in every
   * message, so a page that changed anything on GET would rewrite the
   * preferences of precisely the recipients whose employer scans their mail.
   */
  app.get<{ Params: { token: string } }>('/n/prefs/:token', async (request, reply) => {
    const verified = verifyPreferencesToken(request.params.token);
    if (!verified) {
      return reply
        .type('text/html')
        .code(400)
        .send(
          page(
            'Link not valid',
            'That link is not one we recognise. If you received email you did not ask for, reply to it and we will remove you.',
          ),
        );
    }

    const contact = await findContactByEmail(verified.tenantId, verified.email);
    if (!contact) {
      // The same answer either way: the page must not become a way to test
      // which addresses a store holds.
      return reply
        .type('text/html')
        .send(page('Nothing to change', 'We do not have any email preferences on file for you.'));
    }

    const prefs = await getPreferences(verified.tenantId, contact.id);
    const tenant = await getTenantById(verified.tenantId);
    return reply
      .type('text/html')
      .send(preferencesPage(prefs, tenant?.name ?? '', request.params.token));
  });

  app.post<{
    Params: { token: string };
    Body: Record<string, string | string[] | undefined>;
  }>('/n/prefs/:token', async (request, reply) => {
    const verified = verifyPreferencesToken(request.params.token);
    if (!verified) {
      return reply.type('text/html').code(400).send(page('Link not valid', 'That link is not one we recognise.'));
    }

    const contact = await findContactByEmail(verified.tenantId, verified.email);
    if (!contact) {
      return reply.type('text/html').send(page('Nothing to change', 'We do not have any email preferences on file for you.'));
    }

    const body = request.body ?? {};

    // Leaving entirely is still one click from here. Somebody who came to turn
    // one thing off and decided otherwise should not have to hunt for it.
    if (body.unsubscribe) {
      await recordUnsubscribe(verified.tenantId, contact.id);
      await unsubscribeByEmail(verified.tenantId, verified.email).catch(() => false);
      await suppress(
        verified.tenantId,
        verified.email,
        'manual',
        'Unsubscribed from the preference centre',
      ).catch(() => null);
      return reply
        .type('text/html')
        .send(page('Unsubscribed', 'You will not receive any further marketing email from us.'));
    }

    // Every checkbox that was shown, whether or not it came back: an unticked
    // box sends nothing, so reading only what arrived would make turning a
    // topic off impossible.
    const current = await getPreferences(verified.tenantId, contact.id);
    const topics: Record<string, boolean> = {};
    for (const topic of current.topics) {
      if (!topic.selectable) continue;
      topics[topic.key] = body[`topic_${topic.key}`] !== undefined;
    }

    const pauseRaw = typeof body.pause_days === 'string' ? Number(body.pause_days) : 0;
    const pauseDays = Number.isFinite(pauseRaw) ? pauseRaw : 0;

    await setPreferences(verified.tenantId, contact.id, { topics, pauseDays });

    const saved = await getPreferences(verified.tenantId, contact.id);
    const tenant = await getTenantById(verified.tenantId);
    return reply
      .type('text/html')
      .send(preferencesPage(saved, tenant?.name ?? '', request.params.token, true));
  });

  /**
   * The old unsigned endpoint, kept only to answer links already in inboxes.
   *
   * It no longer unsubscribes anyone: it cannot, because it has no way to tell
   * the person who received the email from anyone else who guessed the tenant
   * id. It explains itself and points at the signed link in a newer message.
   */
  app.route<{ Querystring: { email?: string; t?: string } }>({
    method: ['GET', 'POST'],
    url: '/n/unsubscribe-request',
    handler: async (_request, reply) =>
      reply
        .type('text/html')
        .code(410)
        .send(
          page(
            'This link has been replaced',
            'Unsubscribe links are now signed, so this older one no longer works. ' +
              'Use the link in any more recent email from us, or reply to one and we will remove you.',
          ),
        ),
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

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * The same page with a single button that POSTs.
 *
 * One extra click, and it buys two things: a link scanner fetching every URL
 * in a message cannot unsubscribe the recipient, and somebody who clicked by
 * accident can back out. The body is pre-escaped by the caller so it may carry
 * the address being unsubscribed.
 */
function confirmPage(title: string, bodyHtml: string, action: string): string {
  const base = page(title, '');
  const form =
    `<p>${bodyHtml}</p>` +
    `<form method="post" action="${escapeHtml(action)}" style="margin-top:24px">` +
    `<button type="submit" style="font:inherit;font-weight:600;padding:12px 24px;` +
    `border:0;border-radius:8px;background:#1d1d1f;color:#fff;cursor:pointer">` +
    `Yes, unsubscribe me</button></form>`;
  return base.replace('<p></p>', form);
}


/**
 * The preference page itself.
 *
 * Plain server-rendered HTML with no script: it opens from an email, often on
 * a phone, sometimes in a webmail preview pane, and a page that needs
 * JavaScript to render a checkbox is a page that shows some of those people
 * nothing.
 *
 * "Leave entirely" is present and last. Burying it would be the dark pattern
 * this page exists to avoid — the argument for a preference centre is that
 * people choose to stay, not that they cannot find the exit.
 */
function preferencesPage(
  prefs: Preferences,
  storeName: string,
  token: string,
  saved = false,
): string {
  const action = `${config().publicUrl}/n/prefs/${encodeURIComponent(token)}`;
  const selectable = prefs.topics.filter((topic) => topic.selectable);

  const pausedNotice = prefs.paused_until
    ? `<p class="note">Your email is paused until ${escapeHtml(
        prefs.paused_until.toISOString().slice(0, 10),
      )}. Choosing "Send as usual" below starts it again.</p>`
    : '';

  const savedNotice = saved ? '<p class="saved">Saved.</p>' : '';

  const topicFields =
    selectable.length === 0
      ? ''
      : `<fieldset><legend>What to send</legend>${selectable
          .map(
            (topic) =>
              `<label class="row"><input type="checkbox" name="topic_${escapeHtml(topic.key)}"` +
              `${topic.subscribed ? ' checked' : ''}>` +
              `<span><strong>${escapeHtml(topic.name)}</strong>` +
              (topic.description ? `<em>${escapeHtml(topic.description)}</em>` : '') +
              `</span></label>`,
          )
          .join('')}</fieldset>`;

  const pauseOptions = [
    [0, 'Send as usual'],
    [30, 'Pause for a month'],
    [90, 'Pause for three months'],
  ] as const;

  const pauseFields = `<fieldset><legend>How often</legend>${pauseOptions
    .map(
      ([days, label], index) =>
        `<label class="row"><input type="radio" name="pause_days" value="${days}"` +
        `${(days === 0 && !prefs.paused_until) || (days !== 0 && prefs.paused_until && index === 1) ? ' checked' : ''}>` +
        `<span>${escapeHtml(label)}</span></label>`,
    )
    .join('')}</fieldset>`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>Email preferences</title>
<style>
  :root { color-scheme: light dark; }
  body { margin:0; min-height:100vh; display:grid; place-items:center;
         font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;
         background:#f5f5f7; color:#1d1d1f; padding:24px; }
  main { background:#fff; border-radius:14px; padding:32px; max-width:480px; width:100%;
         box-shadow:0 1px 3px rgba(0,0,0,.08); }
  h1 { margin:0 0 4px; font-size:22px; }
  .addr { margin:0 0 20px; font-size:14px; color:#6e6e73; word-break:break-all; }
  .note, .saved { font-size:14px; border-radius:8px; padding:10px 12px; margin:0 0 18px; }
  .note { background:#fff4e5; color:#7a4a00; }
  .saved { background:#e8f5e9; color:#1b5e20; }
  fieldset { border:0; padding:0; margin:0 0 22px; }
  legend { font-size:13px; text-transform:uppercase; letter-spacing:.04em;
           color:#6e6e73; padding:0 0 10px; }
  .row { display:flex; gap:12px; align-items:flex-start; padding:10px 0;
         border-top:1px solid #ececef; font-size:15px; cursor:pointer; }
  .row input { margin-top:3px; flex:none; width:18px; height:18px; }
  .row em { display:block; font-style:normal; font-size:13px; color:#6e6e73; margin-top:2px; }
  button { font:inherit; font-weight:600; padding:12px 24px; border:0; border-radius:8px;
           background:#1d1d1f; color:#fff; cursor:pointer; width:100%; }
  .leave { margin:22px 0 0; padding-top:18px; border-top:1px solid #ececef; text-align:center; }
  .leave button { background:none; color:#6e6e73; text-decoration:underline;
                  font-weight:400; padding:0; width:auto; }
  @media (prefers-color-scheme: dark) {
    body { background:#000; color:#f5f5f7; }
    main { background:#1c1c1e; box-shadow:none; }
    .row { border-color:#2c2c2e; }
    .leave { border-color:#2c2c2e; }
    .addr, .row em, legend, .leave button { color:#aeaeb2; }
    button { background:#f5f5f7; color:#1d1d1f; }
    .leave button { background:none; color:#aeaeb2; }
    .note { background:#3a2c14; color:#ffd8a8; }
    .saved { background:#17311a; color:#a8e6ad; }
  }
</style></head>
<body><main>
  <h1>Email preferences</h1>
  <p class="addr">${escapeHtml(storeName)}${storeName ? ' &middot; ' : ''}${escapeHtml(prefs.email)}</p>
  ${savedNotice}${pausedNotice}
  <form method="post" action="${escapeHtml(action)}">
    ${topicFields}
    ${pauseFields}
    <button type="submit">Save preferences</button>
  </form>
  <form method="post" action="${escapeHtml(action)}" class="leave">
    <input type="hidden" name="unsubscribe" value="1">
    <button type="submit">Or stop all marketing email</button>
  </form>
</main></body></html>`;
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

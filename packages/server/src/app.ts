import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { ApiError } from './lib/errors.js';
import { collectRoutes } from './routes/collect.js';
import { redirectRoutes } from './routes/redirect.js';
import { apiRoutes } from './routes/api.js';
import { reportRoutes } from './routes/reports.js';
import { gamificationRoutes } from './routes/gamification.js';
import { registerAdminRoutes } from './routes/admin.js';
import { withAuthorisation } from './lib/authorise.js';
import { healthRoutes } from './routes/health.js';

const here = dirname(fileURLToPath(import.meta.url));

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function buildApp(): Promise<FastifyInstance> {
  const cfg = config();

  const app = Fastify({
    logger: { level: cfg.logLevel },
    // Not `true`: that trusts every X-Forwarded-For entry, including the ones
    // the caller wrote themselves. See config.security.trustProxyHops.
    trustProxy: (_address: string, hop: number) => hop < cfg.security.trustProxyHops,
    bodyLimit: 1_048_576, // 1 MB: a tracker batch is a few KB at most.
    // Fastify's default is 100 characters, which is shorter than a signed
    // unsubscribe token — the URL in every marketing email — and a route
    // parameter over the limit answers 414 rather than matching at all.
    maxParamLength: 512,
  });

  /**
   * Form-encoded bodies: RFC 8058 one-click unsubscribe, and the preference
   * page.
   *
   * A mail client's unsubscribe button POSTs
   * `List-Unsubscribe=One-Click` as `application/x-www-form-urlencoded`.
   * Without a parser Fastify answers "Unsupported Media Type" and the button
   * silently does nothing — which is worse than never advertising the header,
   * because the customer believes they have unsubscribed.
   *
   * A malformed body must never fail either request: the unsubscribe token is
   * in the URL and is the whole request, so a client whose implementation
   * sends something unexpected still unsubscribes. An unparseable body reads
   * as no fields rather than as an error.
   *
   * `__proto__` and friends are dropped. The parsed object is passed straight
   * to handler code that looks keys up on it, and a form field named
   * `__proto__` would otherwise reach Object.prototype.
   */
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string', bodyLimit: 16_384 },
    (_request, body, done) => {
      const fields: Record<string, string> = Object.create(null);
      try {
        for (const [key, value] of new URLSearchParams(String(body))) {
          if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
          fields[key] = value;
        }
      } catch {
        // Nothing to report: see above.
      }
      done(null, fields);
    },
  );

  /** Methods with no request body of their own. */
  const BODYLESS = new Set(['GET', 'HEAD', 'DELETE', 'OPTIONS']);

  /**
   * An empty `application/json` body is nothing, not a syntax error.
   *
   * Fastify's default JSON parser answers an empty body with
   * "Body cannot be empty when content-type is set to 'application/json'" --
   * a 400 before any route runs. That is defensible for a POST and wrong for
   * a DELETE, which has no body to send, and it made every DELETE button in
   * the WordPress admin dead: the plugin sets `Content-Type: application/json`
   * on every request and attaches a body only to POST, PUT and PATCH. Nine
   * admin actions -- deleting a badge, a rank, a segment, a custom field, an
   * email template, an operator -- returned 400 and reported a failure the
   * retailer could do nothing about. Proved against a running server: the same
   * DELETE is 400 with the header and 200 without it.
   *
   * The plugin's habit is fixed too, but the server should not have been
   * brittle about it in the first place: declaring a content type you then
   * send none of is common enough that Fastify has an option for it, and a
   * handler that needs a body already rejects `{}` on its own terms through
   * the schema. So an empty body parses as an empty object, and nothing
   * downstream has to know the difference.
   */
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string', bodyLimit: 1_048_576 },
    (request, body, done) => {
      const text = String(body).trim();
      if (text === '') {
        // Only for a method that has no body to send. The first version of
        // this parser accepted an empty body on any method, and the test
        // written to catch that caught it: `PUT /v1/gamification/badges/:key`
        // with no body returned 200 and created a nameless badge, because the
        // upsert takes an object and `{}` is an object. The parser had been
        // the only thing rejecting it. So the tolerance is exactly as wide as
        // the bug it fixes and no wider -- everything else still gets
        // Fastify's own answer.
        if (BODYLESS.has(request.method.toUpperCase())) {
          done(null, Object.create(null) as Record<string, unknown>);
          return;
        }
        const empty = new Error(
          "Body cannot be empty when content-type is set to 'application/json'",
        ) as Error & { statusCode?: number };
        empty.statusCode = 400;
        done(empty, undefined);
        return;
      }
      try {
        done(null, JSON.parse(text));
      } catch (err) {
        // Shape it the way Fastify does, so a malformed body is still a 400
        // and not a 500 -- the one thing this parser must not change.
        const error = err as Error & { statusCode?: number };
        error.statusCode = 400;
        done(error, undefined);
      }
    },
  );

  /**
   * Ingest has to work from any customer storefront, so it is open CORS by
   * design — the site key is public and only authorises writes. The credentialed
   * APIs are server-to-server and never sent from a browser, so no allowlist here
   * grants anything a stolen site key could not already do.
   */
  await app.register(cors, {
    origin: true,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['content-type', 'x-tbay-key', 'authorization', 'x-tbay-secret'],
    maxAge: 86_400,
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiError) {
      return reply
        .code(error.statusCode)
        .send({ error: error.code, message: error.message, details: error.details });
    }
    if ((error as { statusCode?: number }).statusCode === 429) {
      return reply.code(429).send({ error: 'rate_limited', message: 'Too many requests' });
    }
    if ((error as { validation?: unknown }).validation) {
      return reply.code(400).send({ error: 'bad_request', message: messageOf(error) });
    }

    // Fastify's own 4xx — malformed JSON, an empty body, an unsupported media
    // type, a payload over the limit. Each is the caller's mistake and each
    // arrives here with the right status already on it; falling through to the
    // 500 branch told every one of them the server had broken.
    const status = (error as { statusCode?: number }).statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      request.log.warn({ err: error }, 'rejected request');
      return reply.code(status).send({ error: 'bad_request', message: messageOf(error) });
    }

    request.log.error({ err: error }, 'unhandled error');
    return reply.code(500).send({
      error: 'internal_error',
      message: cfg.isProduction ? 'Something went wrong' : messageOf(error),
    });
  });

  app.setNotFoundHandler((request, reply) =>
    reply.code(404).send({ error: 'not_found', message: `No route for ${request.method} ${request.url}` }),
  );

  // Before the routes, so every one of them is covered — including whichever
  // is added next. See lib/authorise.ts for why it is one hook rather than a
  // guard per handler.
  withAuthorisation(app);

  await app.register(healthRoutes);
  await app.register(collectRoutes);
  await app.register(redirectRoutes);
  await app.register(apiRoutes);
  await app.register(reportRoutes);
  await app.register(gamificationRoutes);
  await app.register(registerAdminRoutes);

  // The tracker is served from the API so retailers embed one stable URL and
  // pick up fixes without redeploying their site.
  app.get('/tbay.js', async (_request, reply) => {
    const script = await readFile(join(here, '..', '..', 'tracker', 'tbay.js'), 'utf8');
    return reply
      .type('application/javascript; charset=utf-8')
      .header('cache-control', 'public, max-age=3600')
      .send(script);
  });

  app.get('/', async (_request, reply) => {
    const html = await readFile(join(here, '..', 'public', 'dashboard.html'), 'utf8');
    return reply.type('text/html; charset=utf-8').send(html);
  });

  return app;
}

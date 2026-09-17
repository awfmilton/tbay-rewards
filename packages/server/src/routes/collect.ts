import type { FastifyInstance, FastifyRequest } from 'fastify';
import { clientIp, requirePublicKey } from '../lib/auth.js';
import { ApiError } from '../lib/errors.js';
import { collect } from '../services/ingest.js';
import { upsertContact } from '../services/contacts.js';
import { linkVisitorToContact, upsertVisitor } from '../services/visitors.js';
import { subscribe } from '../services/newsletter.js';
import { withTransaction } from '../db/pool.js';
import { fire } from '../services/automations.js';
import { collectSchema, identifySchema, subscribeSchema } from './schemas.js';
import { config } from '../config.js';
import { addChainParams, chainInfo } from '../lib/chains.js';
import { supplyStatus } from '../services/token.js';

/**
 * Public ingest endpoints.
 *
 * These are reachable from any browser with a site key, so they only ever
 * *write* first-party analytics. Nothing here can read a report, move points or
 * see another visitor's data.
 */
export async function collectRoutes(app: FastifyInstance): Promise<void> {
  // Tracker batch. Responds 204 so sendBeacon never buffers a body.
  app.post('/v1/collect', async (request, reply) => {
    const tenant = await requirePublicKey(request);
    const payload = parse(collectSchema, request.body);

    const result = await collect(tenant, payload, {
      userAgent: request.headers['user-agent'] ?? null,
      ip: clientIp(request),
      country: countryOf(request),
    });

    return reply.code(204).header('x-tbay-session', result.sessionId).send();
  });

  // Same payload over GET for environments that block POST beacons.
  app.get('/v1/collect', async (request, reply) => {
    const tenant = await requirePublicKey(request);
    const raw = (request.query as Record<string, string>).d;
    if (!raw) throw ApiError.badRequest('Missing d parameter');

    let decoded: unknown;
    try {
      decoded = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    } catch {
      throw ApiError.badRequest('d must be base64url-encoded JSON');
    }

    await collect(tenant, parse(collectSchema, decoded), {
      userAgent: request.headers['user-agent'] ?? null,
      ip: clientIp(request),
      country: countryOf(request),
    });

    // 1x1 transparent GIF, so this can also be used as a pixel.
    return reply
      .code(200)
      .header('content-type', 'image/gif')
      .header('cache-control', 'no-store')
      .send(
        Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'),
      );
  });

  /**
   * Attach an identity to the current visitor. Called when someone logs in or
   * completes a form, so earlier anonymous sessions keep their attribution.
   */
  app.post('/v1/identify', async (request) => {
    const tenant = await requirePublicKey(request);
    const input = parse(identifySchema, request.body);

    return withTransaction(async (client) => {
      const contact = await upsertContact(
        tenant.id,
        {
          email: input.email,
          name: input.name ?? null,
          phone: input.phone ?? null,
          locale: input.locale ?? null,
          country: input.country ?? null,
          attributes: input.attributes ?? {},
          tags: input.tags ?? [],
        },
        client,
        // The site key is in every page's source, so this call is effectively
        // anonymous. It may introduce a contact and fill in blanks on one;
        // it may not rewrite a customer the store already knows.
        { fillOnly: true },
      );

      if (input.visitor) {
        const visitor = await upsertVisitor(client, tenant.id, input.visitor);
        await linkVisitorToContact(client, tenant.id, visitor.id, contact.id);
      }

      await fire(
        tenant.id,
        'contact.created',
        { contact, data: { source: 'identify' }, dedupeKey: `identify:${contact.id}` },
        client,
      );

      return { contact_id: contact.id };
    });
  });

  /**
   * Public runtime configuration for the browser.
   *
   * Everything a wallet needs to connect to the right chain, plus the token
   * addresses and conversion rates. All of it is public by nature — it is in the
   * page source and on-chain anyway — but it is served from one place so the
   * storefront, the plugin and thirdweb never disagree about which network TBAY
   * is on.
   */
  app.get('/v1/config', async (request) => {
    const tenant = await requirePublicKey(request);
    const cfg = config();
    const l2 = chainInfo(cfg.chain.chainId);
    const bonusRaw = tenant.settings?.creditBonusBps;
    const bonusBps =
      typeof bonusRaw === 'number' && Number.isFinite(bonusRaw)
        ? Math.min(100_000, Math.max(0, Math.trunc(bonusRaw)))
        : 0;

    return {
      tenant: { slug: tenant.slug, name: tenant.name, currency: tenant.currency },
      token: {
        symbol: 'TBAY',
        l2: {
          address: cfg.chain.l2Contract,
          chainId: cfg.chain.chainId,
          decimals: 18,
          chain: l2,
          addChainParams: addChainParams(cfg.chain.chainId),
        },
        l1: {
          address: cfg.chain.l1Contract,
          chainId: 1,
          // L1 TBAY is a fixed 1,000,000 supply at 9 decimals with no mint
          // function, so bridging L2→L1 is always a release from reserve.
          decimals: 9,
          fixedSupply: '1000000',
          chain: chainInfo(1),
        },
        bridgeScale: '1000000000',
      },
      thirdweb: {
        clientId: process.env.THIRDWEB_CLIENT_ID ?? '',
        chainSlug: l2?.thirdwebSlug ?? null,
        contractUrl: l2 ? `https://thirdweb.com/${l2.thirdwebSlug}/${cfg.chain.l2Contract}` : null,
      },
      rewards: {
        pointsPerToken:
          typeof tenant.settings?.pointsPerToken === 'number' && tenant.settings.pointsPerToken > 0
            ? tenant.settings.pointsPerToken
            : cfg.rewards.pointsPerToken,
        minRedeemPoints: cfg.rewards.minRedeemPoints,
        networkCreditCentsPerToken: cfg.rewards.creditCentsPerToken,
        retailerBonusBps: bonusBps,
        effectiveCreditCentsPerToken: Math.floor(
          (cfg.rewards.creditCentsPerToken * (10_000 + bonusBps)) / 10_000,
        ),
      },
      supply: await supplyStatus(),
    };
  });

  /** Newsletter signup from a storefront form. */
  app.post('/v1/newsletter/subscribe', async (request) => {
    const tenant = await requirePublicKey(request);
    const input = parse(subscribeSchema, request.body);

    // Honeypot filled means a bot; answer as if it worked and drop it.
    if (input.website) return { status: 'pending' };

    const result = await subscribe(tenant, {
      email: input.email,
      name: input.name ?? null,
      listSlug: input.list,
      source: input.source ?? 'website',
      ip: clientIp(request),
      visitorAnonId: input.visitor ?? null,
      attributes: input.attributes ?? {},
    },
    undefined,
    // The site key, so: introduce a person, fill in blanks, change nothing.
    { fillOnly: true });

    return {
      status: result.status,
      contact_id: result.contact.id,
      ...(result.confirmToken ? { confirm_token: result.confirmToken } : {}),
    };
  });
}

function countryOf(request: FastifyRequest): string | null {
  // Set by Cloudflare / most CDNs. We never geolocate from the IP ourselves.
  const header =
    (request.headers['cf-ipcountry'] as string | undefined) ??
    (request.headers['x-vercel-ip-country'] as string | undefined) ??
    (request.headers['x-geo-country'] as string | undefined);
  if (!header || header === 'XX') return null;
  return header.slice(0, 2).toUpperCase();
}

function parse<T>(schema: { safeParse(input: unknown): { success: boolean; data?: T; error?: unknown } }, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success || !result.data) {
    throw ApiError.badRequest('Invalid request body', formatZodError(result.error));
  }
  return result.data;
}

function formatZodError(error: unknown): unknown {
  if (error && typeof error === 'object' && 'issues' in error) {
    const issues = (error as { issues: Array<{ path: unknown[]; message: string }> }).issues;
    return issues.slice(0, 10).map((issue) => ({
      field: issue.path.join('.'),
      message: issue.message,
    }));
  }
  return undefined;
}

export { parse, formatZodError };

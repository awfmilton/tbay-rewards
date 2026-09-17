import type { FastifyInstance } from 'fastify';
import { db, queryOne } from '../db/pool.js';
import { requireSecretKey, tenantOf } from '../lib/auth.js';
import { ApiError } from '../lib/errors.js';
import { config } from '../config.js';
import { parse } from './collect.js';
import {
  contactHandleSchema,
  createLinkSchema,
  orderSchema,
  pointTypeField,
  redeemSchema,
  shareSchema,
  spendSchema,
} from './schemas.js';
import { findContactByEmail, requireContact, upsertContact } from '../services/contacts.js';
import { createChallenge, verifiedWallet, verifyChallenge } from '../services/wallets.js';
import { getTenantById, updateTenantSettings } from '../services/tenants.js';
import { assertAddress, weiToTokenString } from '../lib/chain.js';
import { recordOrder, refundOrder, commissionSummary, listCommissions, markCommissionsPaid } from '../services/commissions.js';
import { createLink, linkReport, listLinks } from '../services/links.js';
import { uuidOf } from '../lib/paging.js';
import { award, getBalance, getBalances, listLedger, spend } from '../services/points.js';
import { leaderboard, listRules, trigger, upsertRule, assertRuleKey } from '../services/rewards.js';
import { createShare, listShares } from '../services/shares.js';
import {
  attachClaimTx,
  cancelSpendIntent,
  createSpendIntent,
  listClaims,
  redeemPointsForTokens,
  outstandingClaims,
  redeemStoreCredit,
  verifySpendIntent,
  walletSummary,
  creditQuote,
  redeemPointsForCredit,
} from '../services/token.js';

import { fire } from '../services/automations.js';
import { listStats, subscribe, unsubscribeByEmail } from '../services/newsletter.js';
import { z } from 'zod';

/**
 * Server-to-server API. Authenticated with a secret key, so everything here can
 * read customer data and move points — never expose these credentials to a browser.
 */
export async function apiRoutes(app: FastifyInstance): Promise<void> {
  // `onRequest`, not `preHandler`: authentication should reject before the
  // body is read, and the role guard in lib/authorise.ts runs at preHandler —
  // which is the phase after this one, so by then the key has been resolved.
  app.addHook('onRequest', async (request) => {
    await requireSecretKey(request);
  });

  // ── Tenant settings ───────────────────────────────────────────────────────

  /**
   * Read and write this retailer's configuration.
   *
   * Without a route for this, TBAY spending was unreachable: createSpendIntent
   * requires settings.payoutWallet and nothing outside the test suite could set
   * it. Same for the conversion rate and the page-key patterns that group
   * templated pages in heatmaps.
   */
  app.get('/v1/settings', async (request) => {
    const tenant = tenantOf(request);
    return {
      slug: tenant.slug,
      name: tenant.name,
      currency: tenant.currency,
      timezone: tenant.timezone,
      settings: tenant.settings ?? {},
    };
  });

  app.put('/v1/settings', async (request) => {
    const tenant = tenantOf(request);
    const schema = z
      .object({
        siteUrl: z.string().url().max(512).optional(),
        payoutWallet: z.string().length(42).optional(),
        pointsPerToken: z.number().int().positive().max(1_000_000).optional(),
        // Basis points ON TOP of the network rate. There is deliberately no way
        // to configure a retailer below it.
        creditBonusBps: z.number().int().min(0).max(100_000).optional(),
        commissionRateBps: z.number().int().min(0).max(10_000).optional(),
        pageKeyPatterns: z.array(z.string().max(255)).max(100).optional(),
        fromName: z.string().max(128).optional(),
        fromEmail: z.string().email().max(254).optional(),
        // Member-to-member transfer limits. Unset means unlimited, which is
        // what every tenant has today, so these change nothing until set.
        // Rewrite links and add an open pixel to marketing email. Never
        // applied to transactional mail whatever this says.
        emailTracking: z.boolean().optional(),
        // Frequency capping: how much marketing one contact may receive.
        // Unset means no cap, which is what every tenant has today.
        maxMarketingPerDay: z.number().int().min(1).max(50).optional(),
        maxMarketingPerWeek: z.number().int().min(1).max(200).optional(),
        transferMinimum: z.number().int().min(1).max(1_000_000).optional(),
        transferDailyLimit: z.number().int().min(1).max(100_000_000).optional(),
        transferWeeklyLimit: z.number().int().min(1).max(100_000_000).optional(),
        transferMonthlyLimit: z.number().int().min(1).max(100_000_000).optional(),
      })
      .strict();

    const patch = parse(schema, request.body);
    if (patch.payoutWallet) assertAddress(patch.payoutWallet, 'payoutWallet');

    await updateTenantSettings(db(), tenant.id, patch);
    const updated = await getTenantById(tenant.id);
    return { settings: updated?.settings ?? {} };
  });

  // ── Webhooks ──────────────────────────────────────────────────────────────

  /**
   * Register a storefront endpoint for platform events.
   *
   * The delivery worker and the WordPress receiver both existed, but nothing
   * could create a subscription, so no webhook had ever fired.
   */
  app.post('/v1/webhooks', async (request) => {
    const tenant = tenantOf(request);
    const schema = z.object({
      url: z.string().url().max(1024),
      secret: z.string().min(16).max(256),
      topics: z.array(z.string().max(64)).max(50).optional(),
    });
    const input = parse(schema, request.body);

    const parsed = new URL(input.url);
    if (parsed.protocol !== 'https:' && !parsed.hostname.match(/^(localhost|127\.0\.0\.1)$/)) {
      throw ApiError.badRequest('Webhook URLs must use https');
    }

    const row = await queryOne<{ id: string }>(
      db(),
      `INSERT INTO webhooks (tenant_id, url, secret, topics)
       VALUES ($1, $2, $3, $4::text[])
       RETURNING id`,
      [tenant.id, input.url, input.secret, input.topics ?? []],
    );
    return { webhook_id: row!.id, url: input.url, topics: input.topics ?? [] };
  });

  app.get('/v1/webhooks', async (request) => {
    const tenant = tenantOf(request);
    const { rows } = await db().query(
      // The signing secret is deliberately not returned.
      'SELECT id, url, topics, enabled, created_at FROM webhooks WHERE tenant_id = $1',
      [tenant.id],
    );
    return { webhooks: rows };
  });

  app.delete<{ Params: { id: string } }>('/v1/webhooks/:id', async (request) => {
    const tenant = tenantOf(request);
    const { rowCount } = await db().query(
      'DELETE FROM webhooks WHERE tenant_id = $1 AND id = $2',
      // Checked here rather than left to the uuid column, which raised
      // "invalid input syntax for type uuid" and came back as a 500.
      [tenant.id, uuidOf(request.params.id, 'id')!],
    );
    if (!rowCount) throw ApiError.notFound('Webhook not found');
    return { deleted: true };
  });

  // ── Orders ────────────────────────────────────────────────────────────────

  app.post('/v1/orders', async (request) => {
    const tenant = tenantOf(request);
    const input = parse(orderSchema, request.body);
    const result = await recordOrder(tenant, input);

    if (result.contactId) {
      const contact = await requireContact(tenant.id, { contactId: result.contactId });
      await fire(tenant.id, 'order.completed', {
        contact,
        data: {
          order_ref: input.orderRef,
          total_cents: input.totalCents,
          subtotal_cents: input.subtotalCents ?? input.totalCents,
          currency: input.currency ?? tenant.currency,
          points: result.pointsAwarded,
        },
        dedupeKey: `order:${input.orderRef}`,
      });
    }

    return {
      order_id: result.orderId,
      contact_id: result.contactId,
      points_awarded: result.pointsAwarded,
      commissions: result.commissions.map((row) => ({
        id: row.id,
        owner_contact_id: row.owner_contact_id,
        amount_cents: row.amount_cents,
        rate_bps: row.rate_bps,
        status: row.status,
      })),
    };
  });

  app.post<{ Params: { orderRef: string } }>('/v1/orders/:orderRef/refund', async (request) => {
    const tenant = tenantOf(request);
    return refundOrder(tenant, request.params.orderRef);
  });

  // ── Contacts ──────────────────────────────────────────────────────────────

  app.post('/v1/contacts', async (request) => {
    const tenant = tenantOf(request);
    const schema = z.object({
      email: z.string().email().max(254).optional(),
      name: z.string().max(255).nullish(),
      phone: z.string().max(64).nullish(),
      externalRef: z.string().max(128).nullish(),
      walletAddress: z.string().max(64).nullish(),
      isWriter: z.boolean().optional(),
      /**
       * Only ever set from a server-to-server call holding the tenant secret,
       * because it records a legal claim that the person agreed to marketing.
       * The public /v1/identify endpoint cannot reach it.
       */
      marketingConsent: z.boolean().optional(),
      consentSource: z.string().max(120).optional(),
      attributes: z.record(z.unknown()).optional(),
      tags: z.array(z.string().max(64)).max(50).optional(),
    });
    const input = parse(schema, request.body);

    const contact = await upsertContact(
      tenant.id,
      {
        email: input.email ?? null,
        name: input.name ?? null,
        phone: input.phone ?? null,
        externalRef: input.externalRef ?? null,
        attributes: input.attributes ?? {},
        tags: input.tags ?? [],
      },
      undefined,
      // Server-to-server, authenticated with the tenant's own secret: a customer
      // changing their email address has to be able to keep their account.
      { allowIdentityChange: true },
    );

    if (input.isWriter !== undefined) {
      await db().query('UPDATE contacts SET is_writer = $2 WHERE id = $1', [
        contact.id,
        input.isWriter,
      ]);
    }

    if (input.marketingConsent !== undefined) {
      await db().query(
        `UPDATE contacts
            SET marketing_consent = $2,
                consent_source = COALESCE($3, consent_source),
                -- Stamp when consent is granted, keep the original date on a
                -- re-grant, and leave the audit trail intact on withdrawal.
                consent_at = CASE WHEN $2 THEN COALESCE(consent_at, now()) ELSE consent_at END,
                updated_at = now()
          WHERE id = $1`,
        [contact.id, input.marketingConsent, input.consentSource ?? null],
      );
    }

    return { contact_id: contact.id, member_id: contact.member_id };
  });

  app.get<{ Querystring: { email?: string; externalRef?: string; contactId?: string } }>(
    '/v1/contacts/lookup',
    async (request) => {
      const tenant = tenantOf(request);
      const contact = await requireContact(tenant.id, request.query);
      const [balance, balances] = await Promise.all([
        getBalance(tenant.id, contact.id),
        getBalances(tenant.id, contact.id),
      ]);
      return {
        contact_id: contact.id,
        email: contact.email,
        name: contact.name,
        member_id: contact.member_id,
        wallet_address: contact.wallet_address,
        is_writer: contact.is_writer,
        tags: contact.tags,
        // `points` is the default currency, unchanged for existing callers.
        points: balance,
        balances,
      };
    },
  );

  /**
   * Step one of binding a wallet: issue a challenge for the holder to sign.
   *
   * Wallets are not bound on assertion. Anything downstream that trusts the
   * stored address — bridge withdrawals above all — would otherwise be
   * pointable at an address the caller does not control.
   */
  app.post('/v1/wallet/challenge', async (request) => {
    const tenant = tenantOf(request);
    const schema = contactHandleSchema.extend({ walletAddress: z.string().length(42) });
    const input = parse(schema, request.body);
    const contact = await requireContact(tenant.id, input);

    const challenge = await createChallenge(tenant, contact, input.walletAddress);
    return {
      contact_id: contact.id,
      nonce: challenge.nonce,
      message: challenge.message,
      wallet_address: challenge.walletAddress,
      expires_at: challenge.expiresAt,
    };
  });

  /** Step two: prove control of the wallet and bind it. */
  app.post('/v1/contacts/wallet', async (request) => {
    const tenant = tenantOf(request);
    const schema = contactHandleSchema.extend({
      nonce: z.string().min(16).max(128),
      signature: z.string().min(80).max(400),
      message: z.string().min(16).max(2000),
    });
    const input = parse(schema, request.body);
    const contact = await requireContact(tenant.id, input);

    const updated = await verifyChallenge(tenant, contact, {
      nonce: input.nonce,
      signature: input.signature,
      message: input.message,
    });

    return {
      contact_id: updated.id,
      wallet_address: updated.wallet_address,
      wallet_verified: true,
      member_id: updated.member_id,
    };
  });

  // ── Newsletter ────────────────────────────────────────────────────────────

  // Server-side subscribe. The browser-facing form posts to
  // /v1/newsletter/subscribe with a public key; this one is for storefront code
  // that already trusts the address (checkout opt-in, account settings).
  app.post('/v1/newsletter/subscriptions', async (request) => {
    const tenant = tenantOf(request);
    const schema = z.object({
      email: z.string().email().max(254),
      name: z.string().max(255).nullish(),
      list: z.string().max(64).optional(),
      source: z.string().max(128).nullish(),
    });
    const input = parse(schema, request.body);
    const result = await subscribe(tenant, {
      email: input.email,
      name: input.name ?? null,
      listSlug: input.list,
      source: input.source ?? 'api',
    });
    return { status: result.status, contact_id: result.contact.id };
  });

  app.post('/v1/newsletter/unsubscribe', async (request) => {
    const tenant = tenantOf(request);
    const input = parse(z.object({ email: z.string().email().max(254) }), request.body);
    return { unsubscribed: await unsubscribeByEmail(tenant.id, input.email) };
  });

  app.get('/v1/newsletter/lists', async (request) => {
    const tenant = tenantOf(request);
    return { lists: await listStats(tenant.id) };
  });

  // ── Links and commissions ─────────────────────────────────────────────────

  app.post('/v1/links', async (request) => {
    const tenant = tenantOf(request);
    const input = parse(createLinkSchema, request.body);

    let ownerContactId = input.ownerContactId ?? null;
    if (!ownerContactId && input.ownerEmail) {
      const owner = await findContactByEmail(tenant.id, input.ownerEmail);
      if (!owner) throw ApiError.notFound(`No contact for ${input.ownerEmail}`);
      ownerContactId = owner.id;
    }

    const link = await createLink(tenant.id, {
      targetUrl: input.targetUrl,
      kind: input.kind,
      ownerContactId,
      productRef: input.productRef ?? null,
      postRef: input.postRef ?? null,
      label: input.label ?? null,
      source: input.source ?? null,
      medium: input.medium ?? null,
      campaign: input.campaign ?? null,
      commissionRateBps: input.commissionRateBps ?? null,
      code: input.code ?? null,
    });

    return {
      code: link.code,
      url: `${config().publicUrl}/r/${link.code}`,
      kind: link.kind,
      commission_rate_bps: link.commission_rate_bps,
    };
  });

  app.get<{ Querystring: { ownerContactId?: string; kind?: string; postRef?: string } }>(
    '/v1/links',
    async (request) => {
      const tenant = tenantOf(request);
      const links = await listLinks(tenant.id, {
        ownerContactId: request.query.ownerContactId,
        kind: request.query.kind as never,
        postRef: request.query.postRef,
      });
      const base = config().publicUrl;
      return {
        links: links.map((link) => ({
          code: link.code,
          url: `${base}/r/${link.code}`,
          kind: link.kind,
          target_url: link.target_url,
          post_ref: link.post_ref,
          product_ref: link.product_ref,
          owner_contact_id: link.owner_contact_id,
          commission_rate_bps: link.commission_rate_bps,
          clicks: link.clicks,
        })),
      };
    },
  );

  app.get<{ Querystring: { ownerContactId?: string } }>('/v1/links/report', async (request) => {
    const tenant = tenantOf(request);
    return { links: await linkReport(tenant.id, { ownerContactId: request.query.ownerContactId }) };
  });

  app.get<{ Querystring: { contactId?: string; email?: string; status?: string } }>(
    '/v1/commissions',
    async (request) => {
      const tenant = tenantOf(request);
      const contact = await requireContact(tenant.id, {
        contactId: request.query.contactId,
        email: request.query.email,
      });
      return {
        contact_id: contact.id,
        summary: await commissionSummary(tenant.id, contact.id),
        commissions: await listCommissions(tenant.id, {
          ownerContactId: contact.id,
          status: request.query.status,
        }),
      };
    },
  );

  app.post('/v1/commissions/pay', async (request) => {
    const tenant = tenantOf(request);
    const input = parse(
      z.object({ ids: z.array(z.string().uuid()).min(1).max(500), payoutRef: z.string().max(128) }),
      request.body,
    );
    return { paid: await markCommissionsPaid(tenant.id, input.ids, input.payoutRef) };
  });

  // ── Rewards ───────────────────────────────────────────────────────────────

  app.get('/v1/rewards/rules', async (request) => {
    const tenant = tenantOf(request);
    return { rules: await listRules(tenant.id) };
  });

  app.put('/v1/rewards/rules', async (request) => {
    const tenant = tenantOf(request);
    const schema = z.object({
      key: z.string().max(64),
      name: z.string().max(255).optional(),
      eventKey: z.string().max(128).optional(),
      mode: z.enum(['fixed', 'per_currency_unit']).optional(),
      points: z.number().int().min(0).max(1_000_000).optional(),
      pointsPerUnit: z.number().min(0).max(10_000).optional(),
      cooldownSeconds: z.number().int().min(0).optional(),
      dailyCap: z.number().int().min(0).nullish(),
      weeklyCap: z.number().int().min(0).nullish(),
      monthlyCap: z.number().int().min(0).nullish(),
      lifetimeCap: z.number().int().min(0).nullish(),
      /** Clamps one award however the amount was calculated. */
      maxPerAward: z.number().int().min(1).max(10_000_000).nullish(),
      /** Ledger wording; %amount%, %rule%, %ref%, %value% are substituted. */
      logTemplate: z.string().max(300).nullish(),
      holdSeconds: z.number().int().min(0).optional(),
      enabled: z.boolean().optional(),
      /** Which currency this rule pays in; the default when unset. */
      pointType: pointTypeField,
    });
    const input = parse(schema, request.body);
    assertRuleKey(input.key);

    const rule = await upsertRule(tenant.id, {
      key: input.key,
      name: input.name,
      point_type: input.pointType,
      event_key: input.eventKey,
      mode: input.mode,
      points: input.points,
      points_per_unit: input.pointsPerUnit as never,
      cooldown_seconds: input.cooldownSeconds,
      daily_cap: input.dailyCap ?? null,
      weekly_cap: input.weeklyCap ?? null,
      monthly_cap: input.monthlyCap ?? null,
      lifetime_cap: input.lifetimeCap ?? null,
      max_per_award: input.maxPerAward ?? null,
      log_template: input.logTemplate ?? null,
      hold_seconds: input.holdSeconds,
      enabled: input.enabled,
    } as never);
    return { rule };
  });

  app.post('/v1/rewards/trigger', async (request) => {
    const tenant = tenantOf(request);
    const schema = contactHandleSchema.extend({
      ruleKey: z.string().max(64),
      refId: z.string().max(191),
      valueCents: z.number().int().min(0).optional(),
      meta: z.record(z.unknown()).optional(),
    });
    const input = parse(schema, request.body);
    const contact = await requireContact(tenant.id, input);

    const outcome = await trigger(tenant.id, {
      contactId: contact.id,
      ruleKey: input.ruleKey,
      refId: input.refId,
      valueCents: input.valueCents,
      meta: input.meta,
    });

    // No fire() here: `trigger()` raises points.awarded itself for every path
    // that awards through a rule. Doing it again would run each automation
    // twice for this route's awards — the two dedupe keys differ, so the
    // automation_runs unique index would not catch it.

    return outcome.awarded
      ? { awarded: true, points: outcome.points, balance: outcome.balance }
      : { awarded: false, reason: outcome.reason, balance: outcome.balance };
  });

  app.get<{
    Querystring: { contactId?: string; email?: string; externalRef?: string; pointType?: string };
  }>('/v1/rewards/balance', async (request) => {
    const tenant = tenantOf(request);
    const contact = await requireContact(tenant.id, request.query);
    return {
      contact_id: contact.id,
      ...(await walletSummary(tenant, contact)),
      ledger: await listLedger(
        tenant.id,
        contact.id,
        20,
        undefined,
        request.query.pointType ?? null,
      ),
    };
  });

  /**
   * Credit or debit an exact number of points.
   *
   * Reward rules cover the platform's own earning events; this covers everything
   * a retailer does for its own reasons — a goodwill gesture, a correction, or
   * mirroring an award made by another system such as myCred. The caller
   * supplies the idempotency key, so a retried webhook cannot double-credit.
   */
  app.post('/v1/rewards/adjust', async (request) => {
    const tenant = tenantOf(request);
    const schema = contactHandleSchema.extend({
      points: z.number().int().min(-1_000_000).max(1_000_000).refine((n) => n !== 0, {
        message: 'points must not be zero',
      }),
      reason: z.string().min(1).max(255),
      idempotencyKey: z.string().min(4).max(191),
      meta: z.record(z.unknown()).optional(),
      pointType: pointTypeField,
    });
    const input = parse(schema, request.body);
    const contact = await requireContact(tenant.id, input);

    const result =
      input.points > 0
        ? await award(tenant.id, {
            contactId: contact.id,
            points: input.points,
            reason: input.reason,
            refType: 'adjustment',
            idempotencyKey: input.idempotencyKey,
            pointType: input.pointType,
            meta: input.meta,
          })
        : await spend(tenant.id, {
            contactId: contact.id,
            points: -input.points,
            reason: input.reason,
            refType: 'adjustment',
            idempotencyKey: input.idempotencyKey,
            pointType: input.pointType,
            meta: input.meta,
          });

    return {
      applied: result.created,
      points: input.points,
      point_type: result.entry.point_type,
      balance: result.balance,
    };
  });

  app.get<{
    Querystring: { window?: string; limit?: string; contactId?: string; pointType?: string };
  }>('/v1/rewards/leaderboard', async (request) => {
    const tenant = tenantOf(request);
    const window = (['all', 'day', 'week', 'month', 'year'] as const).find(
      (candidate) => candidate === request.query.window,
    );
    const board = await leaderboard(tenant.id, {
      window: window ?? 'all',
      limit: request.query.limit ? Number(request.query.limit) : undefined,
      contactId: uuidOf(request.query.contactId, 'contactId'),
      pointType: request.query.pointType ?? null,
    });
    // `leaders` kept for the existing storefront; the rest are new.
    return {
      leaders: board.rows,
      you: board.you,
      window: board.window,
      point_type: board.point_type,
    };
  });

  // ── Social sharing ────────────────────────────────────────────────────────

  app.post('/v1/shares', async (request) => {
    const tenant = tenantOf(request);
    const input = parse(shareSchema, request.body);
    const contact = await requireContact(tenant.id, input);

    const result = await createShare(tenant, {
      contactId: contact.id,
      network: input.network,
      targetUrl: input.targetUrl,
      productRef: input.productRef ?? null,
      postRef: input.postRef ?? null,
    });

    return {
      share_id: result.share.id,
      share_url: result.shareUrl,
      intent_url: result.intentUrl,
      link_code: result.link.code,
      status: result.share.status,
      expires_at: result.share.expires_at,
    };
  });

  app.get<{ Querystring: { contactId?: string; email?: string } }>('/v1/shares', async (request) => {
    const tenant = tenantOf(request);
    const contact = await requireContact(tenant.id, request.query);
    return { shares: await listShares(tenant.id, contact.id) };
  });

  // ── TBAY token ────────────────────────────────────────────────────────────

  /**
   * Spend points for store credit, no wallet involved.
   *
   * The short path to "money off my next order". Same rate as the TBAY route,
   * so neither can be arbitraged against the other.
   */
  app.post('/v1/credit/redeem', async (request) => {
    const tenant = tenantOf(request);
    const input = parse(
      contactHandleSchema.extend({
        points: z.number().int().positive().max(10_000_000),
        pointType: pointTypeField,
      }),
      request.body,
    );
    const contact = await requireContact(tenant.id, input);
    return redeemPointsForCredit(tenant, contact.id, input.points, undefined, input.pointType);
  });

  app.get<{ Querystring: { points?: string } }>('/v1/credit/quote', async (request) => {
    const tenant = tenantOf(request);
    return creditQuote(tenant, Number(request.query.points) || 0);
  });

  app.post('/v1/token/redeem', async (request) => {
    const tenant = tenantOf(request);
    const input = parse(redeemSchema, request.body);
    const contact = await requireContact(tenant.id, input);

    // Mint to the wallet this member proved they control, never to an address
    // supplied in the request. A caller who can name the destination can drain
    // any balance they can reach into a wallet of their choosing.
    const wallet = await verifiedWallet(tenant.id, contact.id);
    if (!wallet) {
      throw ApiError.forbidden(
        'Verify your wallet before redeeming. Request a challenge from /v1/wallet/challenge and sign it.',
      );
    }
    if (input.walletAddress && input.walletAddress.toLowerCase() !== wallet.toLowerCase()) {
      throw ApiError.forbidden('That is not the wallet verified on this account');
    }

    const result = await redeemPointsForTokens(tenant, {
      contact,
      points: input.points,
      walletAddress: wallet,
      pointType: input.pointType,
    });

    return {
      claim_id: result.claim.id,
      status: result.claim.status,
      expires_at: result.claim.expires_at,
      points_spent: result.claim.points_spent,
      balance: result.balance,
      delivery: result.delivery,
      tx_hash: result.txHash,
      amount_tokens: result.amountTokens,
      // So the browser can refuse to submit from a different account rather
      // than letting the transaction revert and cost the customer gas.
      wallet_address: result.claim.wallet_address,
      transaction: result.transaction,
    };
  });

  app.post<{ Params: { claimId: string } }>('/v1/token/claims/:claimId/tx', async (request) => {
    const tenant = tenantOf(request);
    const input = parse(
      contactHandleSchema.extend({ txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/) }),
      request.body,
    );
    const contact = await requireContact(tenant.id, input);

    const claim = await attachClaimTx(
      tenant.id,
      uuidOf(request.params.claimId, 'claimId')!,
      input.txHash,
      contact.id,
    );
    if (!claim) throw ApiError.notFound('Claim not found');
    return { claim_id: claim.id, status: claim.status, tx_hash: claim.tx_hash };
  });

  /** Vouchers the member can still submit, including aged-out ones. */
  app.get<{ Querystring: { contactId?: string; email?: string } }>(
    '/v1/token/claims/outstanding',
    async (request) => {
      const tenant = tenantOf(request);
      const contact = await requireContact(tenant.id, request.query);
      const claims = await outstandingClaims(tenant.id, contact.id);
      return {
        claims: claims.map((claim) => ({
          claim_id: claim.id,
          status: claim.status,
          created_at: claim.created_at,
          points_spent: claim.points_spent,
          amount_tokens: weiToTokenString(BigInt(claim.token_amount_wei)),
          transaction: {
            chainId: claim.chain_id,
            contractAddress: claim.contract_address,
            method: 'claim' as const,
            args: {
              amount: claim.token_amount_wei,
              nonce: claim.nonce,
              signature: claim.signature,
            },
          },
        })),
      };
    },
  );

  app.get<{ Querystring: { contactId?: string; email?: string } }>(
    '/v1/token/claims',
    async (request) => {
      const tenant = tenantOf(request);
      const contact = await requireContact(tenant.id, request.query);
      return { claims: await listClaims(tenant.id, contact.id) };
    },
  );

  app.post('/v1/token/spend', async (request) => {
    const tenant = tenantOf(request);
    const input = parse(spendSchema, request.body);
    const contact = await requireContact(tenant.id, input);

    // Same reasoning as redemption: an unproved `fromAddress` lets an attacker
    // point a spend intent at a stranger's wallet and then claim the store
    // credit when that stranger's transfer lands.
    const spendWallet = await verifiedWallet(tenant.id, contact.id);
    if (!spendWallet) {
      throw ApiError.forbidden('Verify your wallet before spending TBAY');
    }

    const result = await createSpendIntent(tenant, {
      contact,
      amountTokens: input.amountTokens,
      fromAddress: spendWallet,
    });

    return {
      intent_id: result.intent.id,
      pay_to: result.payTo,
      amount_wei: result.amountWei,
      chain_id: result.intent.chain_id,
      contract_address: result.intent.contract_address,
      credit_cents: result.creditCents,
      expires_at: result.intent.expires_at,
    };
  });

  app.post<{ Params: { intentId: string } }>('/v1/token/spend/:intentId/verify', async (request) => {
    const tenant = tenantOf(request);
    const input = parse(z.object({ txHash: z.string().min(10).max(80) }), request.body);
    const result = await verifySpendIntent(tenant, request.params.intentId, input.txHash);
    return {
      intent_id: result.intent.id,
      status: result.intent.status,
      credit: result.credit,
    };
  });

  /**
   * Close an intent the retailer has dealt with by other means.
   *
   * 'cancelled' was in the schema from the first migration with nothing able
   * to reach it, so every message that suggested cancelling was naming a
   * remedy that did not exist. It is also what tells erasure that the wallet
   * on the intent is no longer evidence of anything owed, so without it an
   * abandoned checkout kept a customer's address on file indefinitely.
   */
  app.post<{ Params: { intentId: string } }>('/v1/token/spend/:intentId/cancel', async (request) => {
    const tenant = tenantOf(request);
    const cancelled = await cancelSpendIntent(tenant.id, uuidOf(request.params.intentId, 'intentId')!);
    if (!cancelled) {
      throw ApiError.conflict('That spend intent is not open, so there is nothing to cancel');
    }
    return { intent_id: cancelled.id, status: cancelled.status };
  });

  /**
   * Pick the credit a shopper should use next, without burning it yet.
   *
   * Checkout needs to know the code and amount before the order exists, but the
   * credit must only be consumed once it does — otherwise an abandoned checkout
   * would silently spend it.
   */
  app.post('/v1/token/credit/reserve', async (request) => {
    const tenant = tenantOf(request);
    const input = parse(contactHandleSchema, request.body);
    const contact = await requireContact(tenant.id, input);

    const credit = await queryOne<{
      code: string;
      amount_cents: string;
      remaining_cents: string;
      currency: string;
    }>(
      db(),
      // What is LEFT, not the face value: a credit is drawn down across orders,
      // and a storefront quoting the face value of a half-spent one offers a
      // discount the platform will refuse.
      `SELECT code, amount_cents, amount_cents - redeemed_cents AS remaining_cents, currency
         FROM store_credits
        WHERE tenant_id = $1 AND contact_id = $2 AND status = 'active'
          AND amount_cents > redeemed_cents
          AND (expires_at IS NULL OR expires_at > now())
        ORDER BY expires_at NULLS LAST, created_at
        LIMIT 1`,
      [tenant.id, contact.id],
    );
    if (!credit) throw ApiError.notFound('No active store credit');

    return {
      code: credit.code,
      // `amount_cents` keeps meaning "what this is worth now" for every caller
      // that already reads it; `remaining_cents` says the same thing plainly.
      amount_cents: Number(credit.remaining_cents),
      face_value_cents: Number(credit.amount_cents),
      remaining_cents: Number(credit.remaining_cents),
      currency: credit.currency,
    };
  });

  app.post('/v1/token/credit/redeem', async (request) => {
    const tenant = tenantOf(request);
    const input = parse(
      z.object({
        code: z.string().max(64),
        orderRef: z.string().max(128),
        // How much of the credit this order actually used. Omitted means the
        // whole remaining balance, which is what every caller before partial
        // redemption meant.
        amountCents: z.number().int().positive().max(100_000_000).optional(),
      }),
      request.body,
    );
    const credit = await redeemStoreCredit(
      tenant.id,
      input.code,
      input.orderRef,
      input.amountCents,
    );
    if (!credit) throw ApiError.notFound('No active store credit with that code');
    return credit;
  });
}

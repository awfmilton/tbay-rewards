import { uuidOf } from '../lib/paging.js';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db/pool.js';
import { requireSecretKey, tenantOf } from '../lib/auth.js';
import { ApiError } from '../lib/errors.js';
import { parse } from './collect.js';
import { contactHandleSchema, pointTypeField, timestampString } from './schemas.js';
import { requireContact } from '../services/contacts.js';
import {
  awardBadgeManually,
  badgesForContact,
  createCoupon,
  evaluateBadges,
  evaluateRank,
  listNotifications,
  listRanks,
  markNotificationsRead,
  profile,
  recordStreak,
  redeemCoupon,
  transferPoints,
  unlockContent,
  hasUnlocked,
} from '../services/gamification.js';
import {
  getWithdrawal,
  listWithdrawals,
  markReleased,
  recipientFor,
  recordWithdrawal,
  rejectWithdrawal,
  withdrawalInstructions,
} from '../services/bridge.js';
import { tokensToWei } from '../lib/chain.js';
import { verifiedWallet } from '../services/wallets.js';
import { constantTimeEqual, sha256 } from '../lib/crypto.js';

/** Gamification and bridge endpoints. Secret-key authenticated throughout. */
export async function gamificationRoutes(app: FastifyInstance): Promise<void> {
  // `onRequest`, not `preHandler`: authentication should reject before the
  // body is read, and the role guard in lib/authorise.ts runs at preHandler —
  // which is the phase after this one, so by then the key has been resolved.
  app.addHook('onRequest', async (request) => {
    await requireSecretKey(request);
  });

  // ── Profile, badges, ranks ────────────────────────────────────────────────

  app.get<{
    Querystring: { contactId?: string; email?: string; externalRef?: string; pointType?: string };
  }>(
    '/v1/gamification/profile',
    async (request) => {
      const tenant = tenantOf(request);
      const contact = await requireContact(tenant.id, request.query);
      // Per ladder: ranks, badges and balances all belong to one currency, and
      // a profile that silently answered for the default one was wrong for
      // every retailer running a second.
      return {
        contact_id: contact.id,
        ...(await profile(tenant.id, contact.id, db(), request.query.pointType ?? null)),
      };
    },
  );

  app.get<{ Querystring: { contactId?: string; email?: string } }>(
    '/v1/gamification/badges',
    async (request) => {
      const tenant = tenantOf(request);
      const contact = await requireContact(tenant.id, request.query);
      return { badges: await badgesForContact(tenant.id, contact.id) };
    },
  );

  app.get('/v1/gamification/ranks', async (request) => {
    const tenant = tenantOf(request);
    return { ranks: await listRanks(tenant.id) };
  });

  /** Re-run badge and rank evaluation, e.g. after a bulk import. */
  app.post('/v1/gamification/evaluate', async (request) => {
    const tenant = tenantOf(request);
    const input = parse(
      contactHandleSchema.extend({ pointType: pointTypeField }),
      request.body,
    );
    const contact = await requireContact(tenant.id, input);

    const badges = await evaluateBadges(tenant.id, contact.id);
    const rank = await evaluateRank(tenant.id, contact.id, undefined, input.pointType);

    return {
      badges_earned: badges.map((entry) => ({
        key: entry.badge.key,
        name: entry.badge.name,
        level: entry.level,
        points_awarded: entry.pointsAwarded,
      })),
      rank: rank.rank
        ? { key: rank.rank.key, name: rank.rank.name, point_type: rank.rank.point_type }
        : null,
      promoted: rank.promoted,
    };
  });

  app.post('/v1/gamification/badges/award', async (request) => {
    const tenant = tenantOf(request);
    const input = parse(
      contactHandleSchema.extend({
        badgeKey: z.string().max(64),
        level: z.number().int().min(1).max(20).optional(),
      }),
      request.body,
    );
    const contact = await requireContact(tenant.id, input);
    const awarded = await awardBadgeManually(tenant.id, contact.id, input.badgeKey, input.level ?? 1);
    return { award: awarded };
  });

  // ── Streaks ───────────────────────────────────────────────────────────────

  app.post('/v1/gamification/streak', async (request) => {
    const tenant = tenantOf(request);
    const input = parse(
      contactHandleSchema.extend({ key: z.string().max(64).optional() }),
      request.body,
    );
    const contact = await requireContact(tenant.id, input);
    return recordStreak(tenant.id, contact.id, input.key ?? 'daily_login');
  });

  // ── Transfers ─────────────────────────────────────────────────────────────

  app.post('/v1/gamification/transfer', async (request) => {
    const tenant = tenantOf(request);
    const input = parse(
      z.object({
        fromContactId: z.string().uuid().optional(),
        fromEmail: z.string().email().max(254).optional(),
        toContactId: z.string().uuid().optional(),
        toEmail: z.string().email().max(254).optional(),
        points: z.number().int().positive().max(1_000_000),
        message: z.string().max(500).optional(),
        pointType: pointTypeField,
      }),
      request.body,
    );

    const sender = await requireContact(tenant.id, {
      contactId: input.fromContactId,
      email: input.fromEmail,
    });
    const recipient = await requireContact(tenant.id, {
      contactId: input.toContactId,
      email: input.toEmail,
    });

    return transferPoints(tenant.id, {
      fromContactId: sender.id,
      toContactId: recipient.id,
      points: input.points,
      message: input.message,
      pointType: input.pointType,
    });
  });

  // ── Coupons ───────────────────────────────────────────────────────────────

  app.post('/v1/gamification/coupons', async (request) => {
    const tenant = tenantOf(request);
    const input = parse(
      z.object({
        code: z.string().min(3).max(64).regex(/^[A-Za-z0-9_-]+$/),
        points: z.number().int().positive().max(1_000_000),
        maxUses: z.number().int().positive().nullish(),
        perContactLimit: z.number().int().positive().max(100).optional(),
        expiresAt: timestampString.nullish(),
        // Balance band the redeemer must sit inside, and what the code hands
        // out besides points.
        minBalance: z.number().int().min(0).nullish(),
        maxBalance: z.number().int().min(0).nullish(),
        grantBadgeKey: z.string().max(64).nullish(),
        grantRankKey: z.string().max(64).nullish(),
        pointType: pointTypeField,
      }),
      request.body,
    );
    return createCoupon(tenant.id, input);
  });

  app.post('/v1/gamification/coupons/redeem', async (request) => {
    const tenant = tenantOf(request);
    const input = parse(
      contactHandleSchema.extend({ code: z.string().min(1).max(64) }),
      request.body,
    );
    const contact = await requireContact(tenant.id, input);
    return redeemCoupon(tenant.id, contact.id, input.code);
  });

  // ── Gated content ─────────────────────────────────────────────────────────

  app.post('/v1/gamification/content/unlock', async (request) => {
    const tenant = tenantOf(request);
    const input = parse(
      contactHandleSchema.extend({
        contentRef: z.string().min(1).max(191),
        points: z.number().int().positive().max(1_000_000),
        pointType: pointTypeField,
      }),
      request.body,
    );
    const contact = await requireContact(tenant.id, input);
    return unlockContent(
      tenant.id,
      contact.id,
      input.contentRef,
      input.points,
      undefined,
      input.pointType,
    );
  });

  app.get<{ Querystring: { contactId?: string; email?: string; contentRef?: string } }>(
    '/v1/gamification/content/access',
    async (request) => {
      const tenant = tenantOf(request);
      const contentRef = String(request.query.contentRef ?? '');
      if ('' === contentRef) throw ApiError.badRequest('contentRef is required');
      const contact = await requireContact(tenant.id, request.query);
      return { unlocked: await hasUnlocked(tenant.id, contact.id, contentRef) };
    },
  );

  // ── Notifications ─────────────────────────────────────────────────────────

  app.get<{ Querystring: { contactId?: string; email?: string; unread?: string } }>(
    '/v1/gamification/notifications',
    async (request) => {
      const tenant = tenantOf(request);
      const contact = await requireContact(tenant.id, request.query);
      return {
        notifications: await listNotifications(tenant.id, contact.id, {
          unreadOnly: request.query.unread === '1',
        }),
      };
    },
  );

  app.post('/v1/gamification/notifications/read', async (request) => {
    const tenant = tenantOf(request);
    const input = parse(
      contactHandleSchema.extend({ ids: z.array(z.string().uuid()).max(200).optional() }),
      request.body,
    );
    const contact = await requireContact(tenant.id, input);
    return { marked: await markNotificationsRead(tenant.id, contact.id, input.ids ?? null) };
  });

  // ── L2 → L1 bridge ────────────────────────────────────────────────────────

  /** What to call on the L2 contract, and what the dust rules mean for you. */
  app.post('/v1/bridge/quote', async (request) => {
    const input = parse(
      z.object({
        amountTokens: z.number().positive().optional(),
        amountWei: z.string().regex(/^\d+$/).optional(),
      }),
      request.body,
    );
    if (!input.amountTokens && !input.amountWei) {
      throw ApiError.badRequest('Provide amountTokens or amountWei');
    }
    const wei = input.amountWei ? BigInt(input.amountWei) : tokensToWei(input.amountTokens!);
    return withdrawalInstructions(wei);
  });

  /** Submit a completed burn so the L1 release can be queued. */
  app.post('/v1/bridge/withdrawals', async (request) => {
    const tenant = tenantOf(request);
    const input = parse(
      contactHandleSchema.extend({
        burnTxHash: z.string().length(66),
        // Optional: when the caller identifies a contact we use that contact's
        // PROVED wallet instead, because a request field is not evidence of
        // ownership. Only an anonymous bridge submission falls back to this.
        fromAddress: z.string().length(42).optional(),
      }),
      request.body,
    );

    let contactId: string | null = null;
    let memberId: string | null = null;
    let fromAddress: string | null = null;

    try {
      const contact = await requireContact(tenant.id, input);
      contactId = contact.id;
      memberId = contact.member_id;

      // Never take the burner's address from the request for an identified
      // member: use the wallet they actually proved they control. Otherwise a
      // member could claim any address and hijack that address's burns.
      fromAddress = await verifiedWallet(tenant.id, contact.id);
      if (!fromAddress) {
        throw ApiError.forbidden(
          'Verify your wallet before bridging. Sign the challenge from /v1/wallet/challenge first.',
        );
      }
    } catch (err) {
      if (err instanceof ApiError && err.statusCode === 403) throw err;

      // No contact matched. A withdrawal is a wallet action rather than an
      // account action, so an unregistered holder can still bridge — but the
      // burn itself is the only evidence, and the release goes to the burner.
      fromAddress = input.fromAddress ?? null;
      if (!fromAddress) {
        throw ApiError.badRequest('Provide a contact or a fromAddress');
      }
    }

    return recordWithdrawal({
      burnTxHash: input.burnTxHash,
      fromAddress,
      tenantId: tenant.id,
      contactId,
      memberId,
    });
  });

  app.get<{ Querystring: { fromAddress?: string; status?: string } }>(
    '/v1/bridge/withdrawals',
    async (request) => {
      const tenant = tenantOf(request);
      return {
        withdrawals: await listWithdrawals({
          tenantId: tenant.id,
          fromAddress: request.query.fromAddress,
          status: request.query.status,
        }),
      };
    },
  );

  app.get<{ Params: { id: string } }>('/v1/bridge/withdrawals/:id', async (request) => {
    const tenant = tenantOf(request);
    const id = uuidOf(request.params.id, 'id')!;
    const withdrawal = await getWithdrawal(id);
    // Equality, not "set and different". A withdrawal submitted anonymously
    // has a null tenant, and `w.tenant_id && …` short-circuited false for it —
    // so every anonymous row was readable by any retailer holding its id. An
    // anonymous withdrawal belongs to no retailer, so it is nobody's to read
    // here; the bridge operator has its own credential and its own listing.
    if (!withdrawal || withdrawal.tenant_id !== tenant.id) {
      throw ApiError.notFound('Withdrawal not found');
    }
    // The address to actually pay, recovered from the burn transaction when
    // the stored one was erased. See recipientFor: an erasure drops the wallet
    // because keeping it left a join back to the person, and the chain is the
    // authority for it either way.
    return { withdrawal, payable_to: await recipientFor(withdrawal) };
  });

  /**
   * Operator-only settlement.
   *
   * Releasing on L1 is an assertion the platform cannot verify from L2, so it
   * requires the separate bridge-operator credential rather than any retailer's
   * API secret.
   */
  app.post<{ Params: { id: string } }>('/v1/bridge/withdrawals/:id/release', async (request) => {
    requireBridgeOperator(request.headers['x-tbay-operator'] as string | undefined);
    const input = parse(z.object({ l1TxHash: z.string().length(66) }), request.body);
    const released = await markReleased(uuidOf(request.params.id, 'id')!, input.l1TxHash);
    if (!released) throw ApiError.conflict('That withdrawal is not awaiting release');
    return { withdrawal: released };
  });

  app.post<{ Params: { id: string } }>('/v1/bridge/withdrawals/:id/reject', async (request) => {
    requireBridgeOperator(request.headers['x-tbay-operator'] as string | undefined);
    const input = parse(z.object({ reason: z.string().max(500) }), request.body);
    const rejected = await rejectWithdrawal(uuidOf(request.params.id, 'id')!, input.reason);
    if (!rejected) throw ApiError.conflict('That withdrawal cannot be rejected');
    return { withdrawal: rejected };
  });
}

function requireBridgeOperator(presented: string | undefined): void {
  const expected = process.env.BRIDGE_OPERATOR_TOKEN ?? '';
  if ('' === expected) {
    // Named, because this is the wall a burned withdrawal hits. It ships empty
    // in .env.docker.example, and these two routes are the only way a
    // `burn_verified` row is ever closed out -- so an unset token is not a
    // missing feature, it is somebody's tokens burned on L2 with no path to
    // L1 and no error that says why.
    throw new ApiError(
      503,
      'operator_unavailable',
      'BRIDGE_OPERATOR_TOKEN is not set on this deployment, so no L1 release or rejection ' +
        'can be recorded. Set it (openssl rand -hex 32) and restart before enabling the bridge.',
    );
  }
  // Hash both sides before comparing, so the comparison time depends on the
  // digest length rather than on how much of the real token was guessed — an
  // early length check would leak the token's size.
  if (!presented || !constantTimeEqual(sha256(presented), sha256(expected))) {
    throw ApiError.forbidden('Bridge operator credential required');
  }
}


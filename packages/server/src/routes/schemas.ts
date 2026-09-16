import { z } from 'zod';

/** Shared request schemas. Everything crossing the wire is parsed, never cast. */

export const heatmapSampleSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  w: z.number().int().positive().max(1000).optional(),
});

export const heatmapBatchSchema = z.object({
  page: z.string().max(2048).nullish(),
  kind: z.enum(['click', 'move', 'scroll']),
  samples: z.array(heatmapSampleSchema).max(2000),
  docHeight: z.number().int().positive().max(1_000_000).nullish(),
  viewportWidth: z.number().int().positive().max(20_000).nullish(),
});

export const cartItemSchema = z.object({
  productRef: z.string().min(1).max(128),
  name: z.string().max(255).nullish(),
  quantity: z.number().int().positive().max(10_000),
  priceCents: z.number().int().min(0).max(100_000_000),
  imageUrl: z.string().max(1024).nullish(),
  url: z.string().max(1024).nullish(),
});

export const incomingEventSchema = z.object({
  type: z.string().min(1).max(64),
  url: z.string().max(2048).nullish(),
  path: z.string().max(1024).nullish(),
  productRef: z.string().max(128).nullish(),
  linkCode: z.string().max(64).nullish(),
  valueCents: z.number().int().nullish(),
  currency: z.string().length(3).nullish(),
  props: z.record(z.unknown()).optional(),
  occurredAt: z.string().max(40).nullish(),
  product: z
    .object({
      name: z.string().max(255).nullish(),
      url: z.string().max(1024).nullish(),
      imageUrl: z.string().max(1024).nullish(),
      priceCents: z.number().int().min(0).nullish(),
      currency: z.string().length(3).nullish(),
      categories: z.array(z.string().max(128)).max(20).optional(),
    })
    .optional(),
});

export const collectSchema = z.object({
  key: z.string().max(128).optional(),
  visitor: z.string().min(8).max(64),
  session: z.string().min(8).max(64),
  url: z.string().max(2048).nullish(),
  referrer: z.string().max(2048).nullish(),
  linkCode: z.string().max(64).nullish(),
  events: z.array(incomingEventSchema).max(200).optional(),
  heatmap: z.array(heatmapBatchSchema).max(20).optional(),
  cart: z
    .object({
      cartToken: z.string().min(1).max(128),
      items: z.array(cartItemSchema).max(200),
      currency: z.string().length(3).optional(),
      checkoutUrl: z.string().max(1024).nullish(),
    })
    .nullish(),
});

/**
 * Public identify.
 *
 * Deliberately has NO externalRef: this endpoint is reachable by anyone holding
 * the site key, which is printed in every page's source. Letting a browser
 * supply an external reference would let an attacker point an arbitrary
 * identity at an existing contact. Server-to-server callers use /v1/contacts
 * with the secret key when they need to set one.
 */
/**
 * Attribute keys a caller holding only the *public* site key may not write.
 *
 * `/v1/identify` and `/v1/newsletter/subscribe` need no secret — the site key
 * is in every page's source, and the contact is matched by email alone. So
 * anything the platform's own logic trusts has to be off limits there, or a
 * visitor can rewrite it for somebody else. `roles` drives reward exclusions:
 * clearing it puts an excluded staff account back on the payroll, and setting
 * it on a stranger's address stops them earning.
 *
 * Reserved keys are dropped rather than rejected. A legitimate client sending
 * a wide `attributes` blob should not have its whole identify call fail; it
 * should simply not be able to set these. The secret-key `/v1/contacts`
 * endpoint still writes them.
 */
export const RESERVED_ATTRIBUTE_KEYS = ['roles'] as const;

export const publicAttributes = z
  .record(z.unknown())
  .transform((attributes) => {
    const safe: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(attributes)) {
      // hasOwn, not `includes` on a key that could be `__proto__`.
      if (!RESERVED_ATTRIBUTE_KEYS.includes(key as never)) safe[key] = value;
    }
    return safe;
  })
  .optional();

export const identifySchema = z.object({
  key: z.string().max(128).optional(),
  visitor: z.string().min(8).max(64).optional(),
  email: z.string().email().max(254),
  name: z.string().max(255).nullish(),
  phone: z.string().max(64).nullish(),
  locale: z.string().max(16).nullish(),
  country: z.string().max(2).nullish(),
  attributes: publicAttributes,
  tags: z.array(z.string().max(64)).max(50).optional(),
})
  // Strict on purpose: an unexpected field here is either a client bug or
  // someone probing for a privileged parameter. Failing loudly beats silently
  // dropping it and returning 200 as though it had been honoured.
  .strict();

export const subscribeSchema = z.object({
  key: z.string().max(128).optional(),
  email: z.string().email().max(254),
  name: z.string().max(255).nullish(),
  list: z.string().max(64).optional(),
  source: z.string().max(128).nullish(),
  visitor: z.string().max(64).nullish(),
  attributes: publicAttributes,
  /** Honeypot: a real browser never fills this. */
  website: z.string().max(0).optional(),
});

/**
 * A hundred million currency units — a million dollars on one order.
 *
 * Unbounded, a fat-fingered or crafted total multiplied by a per-currency-unit
 * rule overflowed `points_ledger.delta_points`, which is an integer: the order
 * did not over-award, it failed with "integer out of range" and rolled the
 * whole transaction back. A store loses the order record rather than the
 * points. Refusing the absurd total up front says which number is wrong.
 */
const MAX_ORDER_CENTS = 100_000_000_00;

export const orderSchema = z.object({
  orderRef: z.string().min(1).max(128),
  status: z.string().max(32).optional(),
  totalCents: z.number().int().min(0).max(MAX_ORDER_CENTS),
  subtotalCents: z.number().int().min(0).max(MAX_ORDER_CENTS).optional(),
  currency: z.string().length(3).optional(),
  items: z
    .array(
      z.object({
        productRef: z.string().min(1).max(128),
        name: z.string().max(255).nullish(),
        quantity: z.number().int().positive().max(10_000),
        subtotalCents: z.number().int().min(0).max(MAX_ORDER_CENTS),
        commissionRateBps: z.number().int().min(0).max(10_000).nullish(),
        // Category slugs, so per-category reward overrides can match a line.
        // Zod strips unknown keys, so without this the field was silently
        // dropped and every category rule quietly matched nothing.
        categoryRefs: z.array(z.string().max(128)).max(30).optional(),
      }),
    )
    .max(500)
    .optional(),
  email: z.string().email().max(254).nullish(),
  name: z.string().max(255).nullish(),
  externalRef: z.string().max(128).nullish(),
  contactId: z.string().uuid().nullish(),
  cartToken: z.string().max(128).nullish(),
  visitorAnonId: z.string().max(64).nullish(),
  linkCode: z.string().max(64).nullish(),
  placedAt: z.string().max(40).nullish(),
});

export const contactHandleSchema = z.object({
  contactId: z.string().uuid().optional(),
  email: z.string().email().max(254).optional(),
  externalRef: z.string().max(128).optional(),
});

export const shareSchema = contactHandleSchema.extend({
  key: z.string().max(128).optional(),
  network: z.string().min(1).max(32),
  targetUrl: z.string().url().max(2048),
  productRef: z.string().max(128).nullish(),
  postRef: z.string().max(128).nullish(),
});

/**
 * The wallet address here is an optional *confirmation* that the client and the
 * server agree on the destination. The authoritative address is always the one
 * the member proved they control; a mismatch is rejected rather than honoured.
 */
/** A currency key, as declared in point_types. Absent means the default. */
export const pointTypeField = z.string().regex(/^[a-z0-9_]{2,32}$/).optional();

export const redeemSchema = contactHandleSchema.extend({
  points: z.number().int().positive(),
  walletAddress: z.string().length(42).optional(),
  pointType: pointTypeField,
});

export const spendSchema = contactHandleSchema.extend({
  amountTokens: z.number().positive(),
  fromAddress: z.string().length(42).optional(),
});

export const createLinkSchema = z.object({
  targetUrl: z.string().url().max(2048),
  kind: z.enum(['campaign', 'writer', 'referral', 'share']).optional(),
  ownerContactId: z.string().uuid().nullish(),
  ownerEmail: z.string().email().max(254).nullish(),
  productRef: z.string().max(128).nullish(),
  postRef: z.string().max(128).nullish(),
  label: z.string().max(255).nullish(),
  source: z.string().max(64).nullish(),
  medium: z.string().max(64).nullish(),
  campaign: z.string().max(128).nullish(),
  commissionRateBps: z.number().int().min(0).max(10_000).nullish(),
  code: z.string().min(4).max(32).regex(/^[A-Za-z0-9_-]+$/).nullish(),
});

export const dateRangeSchema = z.object({
  from: z.string().max(40).optional(),
  to: z.string().max(40).optional(),
  limit: z.coerce.number().int().positive().max(500).optional(),
});

export function parseDateRange(input: { from?: string; to?: string }): { from: Date; to: Date } {
  const to = input.to ? new Date(input.to) : new Date();
  const from = input.from
    ? new Date(input.from)
    : new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw new Error('Invalid date range');
  }
  return { from, to };
}

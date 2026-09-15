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

export const identifySchema = z.object({
  key: z.string().max(128).optional(),
  visitor: z.string().min(8).max(64).optional(),
  email: z.string().email().max(254).optional(),
  name: z.string().max(255).nullish(),
  phone: z.string().max(64).nullish(),
  externalRef: z.string().max(128).nullish(),
  locale: z.string().max(16).nullish(),
  country: z.string().max(2).nullish(),
  attributes: z.record(z.unknown()).optional(),
  tags: z.array(z.string().max(64)).max(50).optional(),
});

export const subscribeSchema = z.object({
  key: z.string().max(128).optional(),
  email: z.string().email().max(254),
  name: z.string().max(255).nullish(),
  list: z.string().max(64).optional(),
  source: z.string().max(128).nullish(),
  visitor: z.string().max(64).nullish(),
  attributes: z.record(z.unknown()).optional(),
  /** Honeypot: a real browser never fills this. */
  website: z.string().max(0).optional(),
});

export const orderSchema = z.object({
  orderRef: z.string().min(1).max(128),
  status: z.string().max(32).optional(),
  totalCents: z.number().int().min(0),
  subtotalCents: z.number().int().min(0).optional(),
  currency: z.string().length(3).optional(),
  items: z
    .array(
      z.object({
        productRef: z.string().min(1).max(128),
        name: z.string().max(255).nullish(),
        quantity: z.number().int().positive().max(10_000),
        subtotalCents: z.number().int().min(0),
        commissionRateBps: z.number().int().min(0).max(10_000).nullish(),
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

export const redeemSchema = contactHandleSchema.extend({
  points: z.number().int().positive(),
  walletAddress: z.string().min(42).max(42),
});

export const spendSchema = contactHandleSchema.extend({
  amountTokens: z.number().positive(),
  fromAddress: z.string().min(42).max(42),
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

import { db, queryOne, withTransaction, type Queryable } from '../db/pool.js';
import { randomToken } from '../lib/crypto.js';
import { config } from '../config.js';

export interface CartItem {
  productRef: string;
  name?: string | null;
  quantity: number;
  priceCents: number;
  imageUrl?: string | null;
  url?: string | null;
}

export interface Cart {
  id: string;
  tenant_id: string;
  cart_token: string;
  visitor_id: string | null;
  contact_id: string | null;
  items: CartItem[];
  item_count: number;
  subtotal_cents: number;
  currency: string;
  checkout_url: string | null;
  status: 'active' | 'abandoned' | 'recovered' | 'converted' | 'expired';
  recovery_token: string;
  recovery_stage: number;
  last_recovery_at: Date | null;
  abandoned_at: Date | null;
  updated_at: Date;
}

export interface CartInput {
  cartToken: string;
  visitorId?: string | null;
  contactId?: string | null;
  items: CartItem[];
  currency?: string;
  checkoutUrl?: string | null;
}

function normaliseItems(items: CartItem[]): { items: CartItem[]; count: number; subtotal: number } {
  const clean = items
    .filter((item) => item && typeof item.productRef === 'string' && item.productRef.length > 0)
    .map((item) => ({
      productRef: String(item.productRef).slice(0, 128),
      name: item.name ? String(item.name).slice(0, 255) : null,
      quantity: Math.max(1, Math.trunc(Number(item.quantity) || 1)),
      priceCents: Math.max(0, Math.trunc(Number(item.priceCents) || 0)),
      imageUrl: item.imageUrl ? String(item.imageUrl).slice(0, 1024) : null,
      url: item.url ? String(item.url).slice(0, 1024) : null,
    }));

  const count = clean.reduce((sum, item) => sum + item.quantity, 0);
  const subtotal = clean.reduce((sum, item) => sum + item.quantity * item.priceCents, 0);
  return { items: clean, count, subtotal };
}

/**
 * Record the current state of a cart.
 *
 * Emptying a cart expires it rather than leaving a zero-item row that the
 * sweeper would later "recover" with an email about nothing.
 */
export async function upsertCart(
  runner: Queryable,
  tenantId: string,
  input: CartInput,
): Promise<Cart> {
  const { items, count, subtotal } = normaliseItems(input.items ?? []);
  const status = count === 0 ? 'expired' : 'active';

  const cart = await queryOne<Cart>(
    runner,
    `INSERT INTO carts (
       tenant_id, cart_token, visitor_id, contact_id, items, item_count,
       subtotal_cents, currency, checkout_url, status, recovery_token
     ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (tenant_id, cart_token) DO UPDATE SET
       visitor_id     = COALESCE(EXCLUDED.visitor_id, carts.visitor_id),
       contact_id     = COALESCE(EXCLUDED.contact_id, carts.contact_id),
       items          = EXCLUDED.items,
       item_count     = EXCLUDED.item_count,
       subtotal_cents = EXCLUDED.subtotal_cents,
       currency       = EXCLUDED.currency,
       checkout_url   = COALESCE(EXCLUDED.checkout_url, carts.checkout_url),
       -- A converted cart is final; anything else returns to active on new activity.
       status         = CASE WHEN carts.status = 'converted' THEN 'converted'
                             ELSE EXCLUDED.status END,
       abandoned_at   = CASE WHEN EXCLUDED.status = 'active' THEN NULL
                             ELSE carts.abandoned_at END,
       updated_at     = now()
     RETURNING *`,
    [
      tenantId,
      input.cartToken,
      input.visitorId ?? null,
      input.contactId ?? null,
      JSON.stringify(items),
      count,
      subtotal,
      (input.currency ?? 'USD').toUpperCase().slice(0, 3),
      input.checkoutUrl ?? null,
      status,
      randomToken(18),
    ],
  );
  return cart!;
}

export async function getCartByToken(
  tenantId: string,
  cartToken: string,
  runner: Queryable = db(),
): Promise<Cart | null> {
  return queryOne<Cart>(runner, 'SELECT * FROM carts WHERE tenant_id = $1 AND cart_token = $2', [
    tenantId,
    cartToken,
  ]);
}

export async function getCartByRecoveryToken(token: string): Promise<Cart | null> {
  return queryOne<Cart>(db(), 'SELECT * FROM carts WHERE recovery_token = $1', [token]);
}

/**
 * Close out a cart when its order lands. A cart that had already been mailed a
 * recovery message is marked `recovered` so the recovery report can prove value.
 */
export async function markCartConverted(
  runner: Queryable,
  tenantId: string,
  opts: { cartToken?: string | null; cartId?: string | null; orderRef: string },
): Promise<Cart | null> {
  if (!opts.cartToken && !opts.cartId) return null;
  return queryOne<Cart>(
    runner,
    `UPDATE carts SET
       status = CASE WHEN recovery_stage > 0 THEN 'recovered' ELSE 'converted' END,
       converted_order_ref = $3,
       recovered_at = CASE WHEN recovery_stage > 0 THEN now() ELSE recovered_at END,
       updated_at = now()
     WHERE tenant_id = $1
       AND ($2::text IS NULL OR cart_token = $2)
       AND ($4::uuid IS NULL OR id = $4)
       AND status <> 'converted'
     RETURNING *`,
    [tenantId, opts.cartToken ?? null, opts.orderRef, opts.cartId ?? null],
  );
}

/**
 * Flip active carts that have gone quiet to `abandoned`.
 * Returns the carts that just changed state so the caller can queue recovery.
 */
export async function sweepAbandonedCarts(runner: Queryable = db()): Promise<Cart[]> {
  const minutes = config().carts.abandonAfterMinutes;
  const { rows } = await runner.query<Cart>(
    `UPDATE carts SET status = 'abandoned', abandoned_at = now(), updated_at = now()
      WHERE status = 'active'
        AND item_count > 0
        AND updated_at < now() - ($1 || ' minutes')::interval
      RETURNING *`,
    [String(minutes)],
  );
  return rows;
}

export interface RecoveryCandidate extends Cart {
  email: string | null;
  contact_name: string | null;
  marketing_consent: boolean;
}

/**
 * Abandoned carts whose next recovery email is due.
 *
 * Stage N goes out `recoveryStageHours[N]` hours after abandonment, and the
 * `recovery_stage` column advances only once a send is booked, so a crashed or
 * retried worker pass cannot double-mail anyone.
 */
export async function dueForRecovery(
  runner: Queryable = db(),
  limit = 200,
): Promise<RecoveryCandidate[]> {
  const stages = config().carts.recoveryStageHours;
  if (stages.length === 0) return [];

  const { rows } = await runner.query<RecoveryCandidate>(
    `SELECT c.*, ct.email, ct.name AS contact_name, ct.marketing_consent
       FROM carts c
       JOIN contacts ct ON ct.id = c.contact_id
      WHERE c.status = 'abandoned'
        AND c.item_count > 0
        AND ct.email IS NOT NULL
        -- Filtered here, not in the worker. The worker returned early for a
        -- contact without consent and never advanced the stage, so the cart
        -- stayed due forever — and because the batch is the 200 oldest carts
        -- platform-wide, and consent defaults to false, those carts filled the
        -- window permanently. Recovery mail stopped for everybody, quietly,
        -- once 200 of them had accumulated.
        AND ct.marketing_consent
        AND c.recovery_stage < $1
        AND c.abandoned_at < now() - ((($2::numeric[])[c.recovery_stage + 1]) || ' hours')::interval
      ORDER BY c.abandoned_at
      LIMIT $3`,
    [stages.length, stages, limit],
  );
  return rows;
}

export async function advanceRecoveryStage(
  runner: Queryable,
  cartId: string,
  stage: number,
): Promise<void> {
  await runner.query(
    `UPDATE carts SET recovery_stage = $2, last_recovery_at = now(), updated_at = updated_at
      WHERE id = $1 AND recovery_stage < $2`,
    [cartId, stage],
  );
}

export interface CartStats {
  active: number;
  abandoned: number;
  recovered: number;
  converted: number;
  abandoned_value_cents: number;
  recovered_value_cents: number;
  abandonment_rate: number;
  recovery_rate: number;
}

export async function cartStats(
  tenantId: string,
  from: Date,
  to: Date,
  runner: Queryable = db(),
): Promise<CartStats> {
  const row = await queryOne<Record<string, string>>(
    runner,
    `SELECT
       COUNT(*) FILTER (WHERE status = 'active')                          AS active,
       COUNT(*) FILTER (WHERE status = 'abandoned')                       AS abandoned,
       COUNT(*) FILTER (WHERE status = 'recovered')                       AS recovered,
       COUNT(*) FILTER (WHERE status = 'converted')                       AS converted,
       COALESCE(SUM(subtotal_cents) FILTER (WHERE status = 'abandoned'), 0) AS abandoned_value_cents,
       COALESCE(SUM(subtotal_cents) FILTER (WHERE status = 'recovered'), 0) AS recovered_value_cents
     FROM carts
     WHERE tenant_id = $1 AND created_at >= $2 AND created_at <= $3`,
    [tenantId, from, to],
  );

  const active = Number(row?.active ?? 0);
  const abandoned = Number(row?.abandoned ?? 0);
  const recovered = Number(row?.recovered ?? 0);
  const converted = Number(row?.converted ?? 0);
  const checkouts = abandoned + recovered + converted;

  return {
    active,
    abandoned,
    recovered,
    converted,
    abandoned_value_cents: Number(row?.abandoned_value_cents ?? 0),
    recovered_value_cents: Number(row?.recovered_value_cents ?? 0),
    abandonment_rate: checkouts > 0 ? round4(abandoned / checkouts) : 0,
    recovery_rate: recovered + abandoned > 0 ? round4(recovered / (recovered + abandoned)) : 0,
  };
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

export { withTransaction };

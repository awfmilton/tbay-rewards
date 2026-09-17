import { db, queryOne, withTransaction, type Queryable } from '../db/pool.js';
import { config } from '../config.js';
import { ApiError } from '../lib/errors.js';
import { getLinkByCode, type Link } from './links.js';
import { markCartConverted } from './carts.js';
import { bumpProductStat } from './products.js';
import { trigger } from './rewards.js';
import { applyProductOverrides, listProductRules } from './product-rules.js';
import { upsertContact } from './contacts.js';
import type { Tenant } from './tenants.js';

export interface OrderItem {
  productRef: string;
  name?: string | null;
  quantity: number;
  /** Line total in cents, after item-level discounts. */
  subtotalCents: number;
  /** Optional per-item override, e.g. a product excluded from commission. */
  commissionRateBps?: number | null;
  /** Category slugs/ids, so per-category reward overrides can match. */
  categoryRefs?: string[];
}

export interface OrderInput {
  orderRef: string;
  status?: string;
  totalCents: number;
  subtotalCents?: number;
  currency?: string;
  items?: OrderItem[];
  email?: string | null;
  name?: string | null;
  externalRef?: string | null;
  contactId?: string | null;
  cartToken?: string | null;
  visitorAnonId?: string | null;
  /** Attribution the storefront read from the tracking cookie. */
  linkCode?: string | null;
  placedAt?: string | null;
}

export interface Commission {
  id: string;
  tenant_id: string;
  link_id: string | null;
  owner_contact_id: string;
  order_ref: string;
  item_ref: string;
  product_ref: string | null;
  subtotal_cents: number;
  rate_bps: number;
  amount_cents: number;
  currency: string;
  status: 'pending' | 'approved' | 'paid' | 'void';
  hold_until: Date | null;
}

export interface RecordOrderResult {
  orderId: string;
  contactId: string | null;
  commissions: Commission[];
  pointsAwarded: number;
}

/**
 * Record a completed order: attribute it, accrue writer commission, award
 * purchase points and close out the abandoned-cart record.
 *
 * All of it happens in one transaction keyed on (tenant, order_ref), so the
 * storefront can safely retry the webhook.
 */
export async function recordOrder(
  tenant: Tenant,
  input: OrderInput,
  runner?: Queryable,
): Promise<RecordOrderResult> {
  if (!input.orderRef) throw ApiError.badRequest('order_ref is required');

  const run = async (client: Queryable): Promise<RecordOrderResult> => {
    const currency = (input.currency ?? tenant.currency).toUpperCase().slice(0, 3);
    const subtotal = input.subtotalCents ?? input.totalCents;

    let contactId = input.contactId ?? null;

    // Resolved against THIS tenant before anything is written.
    //
    // It arrives in the request body, so without this check a retailer could
    // name another retailer's contact and have the whole order pipeline —
    // ledger, balances, badges, ranks, notifications — write rows under its own
    // tenant_id against a stranger. The route's own `requireContact` runs
    // after `recordOrder` has already committed, so it returned 404 while the
    // rows persisted.
    if (contactId) {
      const owned = await queryOne<{ id: string }>(
        client,
        'SELECT id FROM contacts WHERE tenant_id = $1 AND id = $2',
        [tenant.id, contactId],
      );
      if (!owned) throw ApiError.notFound('No matching contact');
    }

    if (!contactId && (input.email || input.externalRef)) {
      const contact = await upsertContact(
        tenant.id,
        {
          email: input.email ?? null,
          name: input.name ?? null,
          externalRef: input.externalRef ?? null,
        },
        client,
      );
      contactId = contact.id;
    }

    let visitorId: string | null = null;
    if (input.visitorAnonId) {
      const visitor = await queryOne<{ id: string }>(
        client,
        'SELECT id FROM visitors WHERE tenant_id = $1 AND anon_id = $2',
        [tenant.id, input.visitorAnonId],
      );
      visitorId = visitor?.id ?? null;
    }

    const touches = visitorId ? await touchSnapshot(client, tenant.id, visitorId) : null;

    const order = await queryOne<{ id: string; already: boolean }>(
      client,
      `INSERT INTO orders (
         tenant_id, order_ref, contact_id, visitor_id, total_cents, subtotal_cents,
         currency, status, items, first_touch, last_touch, attributed_link_code, placed_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11::jsonb, $12, COALESCE($13::timestamptz, now()))
       ON CONFLICT (tenant_id, order_ref) DO UPDATE SET
         status      = EXCLUDED.status,
         total_cents = EXCLUDED.total_cents,
         contact_id  = COALESCE(orders.contact_id, EXCLUDED.contact_id),
         updated_at  = now()
       RETURNING id, (xmax <> 0) AS already`,
      [
        tenant.id,
        input.orderRef,
        contactId,
        visitorId,
        input.totalCents,
        subtotal,
        currency,
        input.status ?? 'completed',
        JSON.stringify(input.items ?? []),
        touches ? JSON.stringify(touches.first) : null,
        touches ? JSON.stringify(touches.last) : null,
        input.linkCode ?? touches?.last?.link_code ?? null,
        input.placedAt ?? null,
      ],
    );

    for (const item of input.items ?? []) {
      if (!item?.productRef) continue;
      await bumpProductStat(
        client,
        tenant.id,
        item.productRef,
        'purchases',
        Math.max(1, item.quantity ?? 1),
        item.subtotalCents ?? 0,
      );
    }

    if (input.cartToken) {
      await markCartConverted(client, tenant.id, {
        cartToken: input.cartToken,
        orderRef: input.orderRef,
      });
    }

    const commissions = await accrueCommissions(client, tenant, {
      orderRef: input.orderRef,
      linkCode: input.linkCode ?? touches?.last?.link_code ?? null,
      items: input.items ?? [],
      subtotalCents: subtotal,
      currency,
      buyerContactId: contactId,
    });

    let pointsAwarded = 0;
    if (contactId) {
      // Per-product and per-category overrides reshape the order before the
      // rate is applied: a line can be excluded, scaled, or replaced with a
      // flat per-unit award. With nothing configured this is the subtotal and
      // zero bonus, i.e. exactly the old behaviour.
      const overrides = await listProductRules(tenant.id, 'purchase', client);
      const shaped = applyProductOverrides(input.items ?? [], overrides, subtotal);

      const outcome = await trigger(
        tenant.id,
        {
          contactId,
          ruleKey: 'purchase',
          refId: input.orderRef,
          refType: 'order',
          valueCents: shaped.eligibleCents,
          bonusPoints: shaped.fixedPoints,
          meta: {
            order_ref: input.orderRef,
            currency,
            ...(overrides.length > 0
              ? { subtotal_cents: subtotal, overrides: shaped.breakdown }
              : {}),
          },
        },
        client,
      );
      if (outcome.awarded) pointsAwarded = outcome.points;

      await qualifyReferral(client, tenant.id, contactId);
    }

    return { orderId: order!.id, contactId, commissions, pointsAwarded };
  };

  return runner ? run(runner) : withTransaction(run);
}

interface TouchRow {
  source: string;
  medium: string | null;
  campaign: string | null;
  referrer_host: string | null;
  link_code: string | null;
  occurred_at: Date;
}

async function touchSnapshot(
  client: Queryable,
  tenantId: string,
  visitorId: string,
): Promise<{ first: TouchRow | null; last: TouchRow | null }> {
  const { rows } = await client.query<TouchRow>(
    `(SELECT source, medium, campaign, referrer_host, link_code, occurred_at
        FROM touchpoints WHERE tenant_id = $1 AND visitor_id = $2
       ORDER BY occurred_at ASC LIMIT 1)
     UNION ALL
     (SELECT source, medium, campaign, referrer_host, link_code, occurred_at
        FROM touchpoints WHERE tenant_id = $1 AND visitor_id = $2
       ORDER BY occurred_at DESC LIMIT 1)`,
    [tenantId, visitorId],
  );
  return { first: rows[0] ?? null, last: rows[rows.length - 1] ?? null };
}

interface AccrualInput {
  orderRef: string;
  linkCode: string | null;
  items: OrderItem[];
  subtotalCents: number;
  currency: string;
  buyerContactId: string | null;
}

/**
 * Accrue commission for the writer whose link brought the order in.
 *
 * Per-item when the order lists items (so a writer earns only on what they
 * actually promote, if the link targets a product), otherwise on the order
 * subtotal. Self-purchases through your own link never earn.
 */
export async function accrueCommissions(
  client: Queryable,
  tenant: Tenant,
  input: AccrualInput,
): Promise<Commission[]> {
  if (!input.linkCode) return [];

  const link = await getLinkByCode(input.linkCode, client);
  if (!link || link.tenant_id !== tenant.id) return [];
  if (!link.owner_contact_id || link.commission_rate_bps <= 0) return [];
  if (link.disabled_at) return [];
  if (input.buyerContactId && input.buyerContactId === link.owner_contact_id) return [];

  const holdUntil = new Date(Date.now() + config().commissions.holdDays * 24 * 60 * 60 * 1000);
  const rows: Commission[] = [];

  const lines = commissionableLines(link, input);
  for (const line of lines) {
    const amount = Math.floor((line.subtotalCents * line.rateBps) / 10_000);
    if (amount <= 0) continue;

    const row = await queryOne<Commission>(
      client,
      `INSERT INTO commissions (
         tenant_id, link_id, owner_contact_id, order_ref, item_ref, product_ref,
         subtotal_cents, rate_bps, amount_cents, currency, hold_until
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (tenant_id, order_ref, item_ref, owner_contact_id) DO NOTHING
       RETURNING *`,
      [
        tenant.id,
        link.id,
        link.owner_contact_id,
        input.orderRef,
        line.itemRef,
        line.productRef,
        line.subtotalCents,
        line.rateBps,
        amount,
        input.currency,
        holdUntil,
      ],
    );
    if (row) rows.push(row);
  }

  return rows;
}

function commissionableLines(
  link: Link,
  input: AccrualInput,
): Array<{ itemRef: string; productRef: string | null; subtotalCents: number; rateBps: number }> {
  if (input.items.length === 0) {
    return [
      {
        itemRef: '',
        productRef: null,
        subtotalCents: input.subtotalCents,
        rateBps: link.commission_rate_bps,
      },
    ];
  }

  // A product-specific link earns on that product only; a general writer link
  // earns across the whole basket.
  const eligible = link.product_ref
    ? input.items.filter((item) => item.productRef === link.product_ref)
    : input.items;

  return eligible.map((item) => ({
    itemRef: item.productRef,
    productRef: item.productRef,
    subtotalCents: item.subtotalCents ?? 0,
    rateBps: item.commissionRateBps ?? link.commission_rate_bps,
  }));
}

/** A referred customer's first order qualifies the referrer's reward. */
async function qualifyReferral(
  client: Queryable,
  tenantId: string,
  refereeContactId: string,
): Promise<void> {
  const referral = await queryOne<{ id: string; referrer_contact_id: string }>(
    client,
    `UPDATE referrals SET status = 'qualified', qualified_at = now()
      WHERE tenant_id = $1 AND referee_contact_id = $2 AND status = 'pending'
      RETURNING id, referrer_contact_id`,
    [tenantId, refereeContactId],
  );
  if (!referral) return;

  await trigger(
    tenantId,
    {
      contactId: referral.referrer_contact_id,
      ruleKey: 'referral',
      refId: referral.id,
      refType: 'referral',
    },
    client,
  );
}

/** Void an order's commissions and claw back its purchase points on refund. */
export async function refundOrder(
  tenant: Tenant,
  orderRef: string,
  runner?: Queryable,
): Promise<{ voided: number; pointsReversed: boolean }> {
  const run = async (client: Queryable) => {
    // The contact first, before the order row.
    //
    // A refund ends in `reverse`, which holds the contact -- but by then this
    // already had the order row, and a merge coming the other way (contact,
    // then REASSIGN orders) held the contact and wanted the order. Two rounds
    // in sixteen deadlocked. Read who owns it, hold them, then start writing.
    const owner = await queryOne<{ contact_id: string | null }>(
      client,
      'SELECT contact_id FROM orders WHERE tenant_id = $1 AND order_ref = $2',
      [tenant.id, orderRef],
    );
    if (owner?.contact_id) {
      const { holdContact } = await import('./points.js');
      await holdContact(client, tenant.id, owner.contact_id);
    }

    const { rowCount } = await client.query(
      `UPDATE commissions SET status = 'void', voided_at = now()
        WHERE tenant_id = $1 AND order_ref = $2 AND status IN ('pending', 'approved')`,
      [tenant.id, orderRef],
    );

    await client.query(
      `UPDATE orders SET status = 'refunded', updated_at = now()
        WHERE tenant_id = $1 AND order_ref = $2`,
      [tenant.id, orderRef],
    );

    // Everything this order paid out, not only the purchase line.
    //
    // Reversing `rule_key = 'purchase'` alone left every other award the order
    // triggered standing: a product rule that paid a bonus on one of its
    // items, a first-order award under another rule key. The refund took the
    // money back and left the points.
    const { rows: entries } = await client.query<{ id: string }>(
      `SELECT id FROM points_ledger
        WHERE tenant_id = $1 AND ref_type = 'order' AND ref_id = $2 AND status <> 'reversed'`,
      [tenant.id, orderRef],
    );

    const { reverse } = await import('./points.js');
    let pointsReversed = false;
    for (const entry of entries) {
      // Clamped: if the customer already redeemed those points for TBAY, the
      // tokens exist and cannot be un-minted. Take back what remains rather
      // than rolling back the commission void as well.
      const compensation = await reverse(tenant.id, entry.id, 'Order refunded', client, {
        clampToBalance: true,
      });
      if (compensation !== null) pointsReversed = true;
    }

    // And the referral this order qualified, if it was the only thing holding
    // it up. Refer yourself, place an order, collect the bonus, refund the
    // order was a complete loop that paid out every time -- the referral bonus
    // is keyed on the referral rather than the order, so nothing above reaches
    // it. Only unwound when no other order stands: a second, kept order is
    // reason enough for the referral on its own.
    const unqualified = await unqualifyReferralIfUnearned(client, tenant.id, orderRef);
    if (unqualified) pointsReversed = true;

    return { voided: rowCount ?? 0, pointsReversed };
  };

  return runner ? run(runner) : withTransaction(run);
}

/**
 * Take back a referral whose qualifying order has been refunded.
 *
 * Returns whether anything was reversed. A referral qualifies on the referee's
 * first kept order, so it stays qualified as long as one remains.
 */
async function unqualifyReferralIfUnearned(
  client: Queryable,
  tenantId: string,
  orderRef: string,
): Promise<boolean> {
  const order = await queryOne<{ contact_id: string | null }>(
    client,
    'SELECT contact_id FROM orders WHERE tenant_id = $1 AND order_ref = $2',
    [tenantId, orderRef],
  );
  if (!order?.contact_id) return false;

  const kept = await client.query(
    `SELECT 1 FROM orders
      WHERE tenant_id = $1 AND contact_id = $2 AND status <> 'refunded'
      LIMIT 1`,
    [tenantId, order.contact_id],
  );
  if ((kept.rowCount ?? 0) > 0) return false;

  const referral = await queryOne<{ id: string }>(
    client,
    `UPDATE referrals SET status = 'pending', qualified_at = NULL
      WHERE tenant_id = $1 AND referee_contact_id = $2 AND status = 'qualified'
      RETURNING id`,
    [tenantId, order.contact_id],
  );
  if (!referral) return false;

  const { rows: bonuses } = await client.query<{ id: string }>(
    `SELECT id FROM points_ledger
      WHERE tenant_id = $1 AND ref_type = 'referral' AND ref_id = $2 AND status <> 'reversed'`,
    [tenantId, referral.id],
  );

  const { reverse } = await import('./points.js');
  let reversed = false;
  for (const bonus of bonuses) {
    const compensation = await reverse(tenantId, bonus.id, 'Referred order refunded', client, {
      clampToBalance: true,
    });
    if (compensation !== null) reversed = true;
  }
  return reversed;
}

/** Release commissions whose refund-protection hold has elapsed. */
export async function approveMaturedCommissions(runner: Queryable = db()): Promise<number> {
  const { rowCount } = await runner.query(
    `UPDATE commissions SET status = 'approved', approved_at = now()
      WHERE status = 'pending' AND hold_until IS NOT NULL AND hold_until <= now()`,
  );
  return rowCount ?? 0;
}

export interface CommissionSummary {
  pending_cents: number;
  approved_cents: number;
  paid_cents: number;
  orders: number;
}

export async function commissionSummary(
  tenantId: string,
  ownerContactId: string,
  runner: Queryable = db(),
): Promise<CommissionSummary> {
  const row = await queryOne<Record<string, string>>(
    runner,
    `SELECT
       COALESCE(SUM(amount_cents) FILTER (WHERE status = 'pending'), 0)  AS pending_cents,
       COALESCE(SUM(amount_cents) FILTER (WHERE status = 'approved'), 0) AS approved_cents,
       COALESCE(SUM(amount_cents) FILTER (WHERE status = 'paid'), 0)     AS paid_cents,
       COUNT(DISTINCT order_ref) FILTER (WHERE status <> 'void')         AS orders
     FROM commissions WHERE tenant_id = $1 AND owner_contact_id = $2`,
    [tenantId, ownerContactId],
  );
  return {
    pending_cents: Number(row?.pending_cents ?? 0),
    approved_cents: Number(row?.approved_cents ?? 0),
    paid_cents: Number(row?.paid_cents ?? 0),
    orders: Number(row?.orders ?? 0),
  };
}

export async function listCommissions(
  tenantId: string,
  filter: { ownerContactId?: string; status?: string; limit?: number } = {},
  runner: Queryable = db(),
): Promise<Commission[]> {
  const { rows } = await runner.query<Commission>(
    `SELECT * FROM commissions
      WHERE tenant_id = $1
        AND ($2::uuid IS NULL OR owner_contact_id = $2)
        AND ($3::text IS NULL OR status = $3)
      ORDER BY created_at DESC
      LIMIT $4`,
    [tenantId, filter.ownerContactId ?? null, filter.status ?? null, Math.min(filter.limit ?? 100, 500)],
  );
  return rows;
}

/** Mark approved commissions as paid once a payout run settles. */
export async function markCommissionsPaid(
  tenantId: string,
  ids: string[],
  payoutRef: string,
  runner: Queryable = db(),
): Promise<number> {
  if (ids.length === 0) return 0;
  const { rowCount } = await runner.query(
    `UPDATE commissions SET status = 'paid', paid_at = now(), payout_ref = $3
      WHERE tenant_id = $1 AND id = ANY($2::uuid[]) AND status = 'approved'`,
    [tenantId, ids, payoutRef],
  );
  return rowCount ?? 0;
}

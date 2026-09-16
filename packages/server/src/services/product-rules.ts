import { db, queryOne, type Queryable } from '../db/pool.js';
import { ApiError } from '../lib/errors.js';
import type { OrderItem } from './commissions.js';

/**
 * Per-product and per-category point overrides.
 *
 * "Double points on the heritage range, none on gift cards" is the request
 * every store makes and the one myCred answers with a per-product meta box.
 * Without it a `per_currency_unit` rule is a single flat rate across the whole
 * catalogue, which is fine for a week and wrong forever after.
 *
 * Resolution order, most specific first: a product rule beats a category rule,
 * and `exclude` beats everything. Lines with no match earn the rule's base
 * rate, so a tenant that configures nothing behaves exactly as before.
 */

export type MatchKind = 'product' | 'category';
export type OverrideMode = 'multiplier' | 'fixed' | 'exclude';

export interface ProductRule {
  id: string;
  tenant_id: string;
  rule_key: string;
  match_kind: MatchKind;
  match_value: string;
  mode: OverrideMode;
  multiplier: string;
  points: number;
  note: string;
  created_at: Date;
}

export async function upsertProductRule(
  tenantId: string,
  input: {
    ruleKey: string;
    matchKind: MatchKind;
    matchValue: string;
    mode: OverrideMode;
    multiplier?: number;
    points?: number;
    note?: string;
  },
  runner: Queryable = db(),
): Promise<ProductRule> {
  if (input.matchKind !== 'product' && input.matchKind !== 'category') {
    throw ApiError.badRequest('matchKind must be "product" or "category"');
  }
  if (!['multiplier', 'fixed', 'exclude'].includes(input.mode)) {
    throw ApiError.badRequest('mode must be "multiplier", "fixed" or "exclude"');
  }
  const value = input.matchValue.trim();
  if (!value) throw ApiError.badRequest('matchValue is required');
  if (input.mode === 'multiplier' && (input.multiplier ?? 1) < 0) {
    throw ApiError.badRequest('multiplier cannot be negative');
  }
  if (input.mode === 'fixed' && (input.points ?? 0) < 0) {
    throw ApiError.badRequest('points cannot be negative');
  }

  const row = await queryOne<ProductRule>(
    runner,
    `INSERT INTO reward_product_rules
       (tenant_id, rule_key, match_kind, match_value, mode, multiplier, points, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (tenant_id, rule_key, match_kind, match_value)
     DO UPDATE SET mode = EXCLUDED.mode, multiplier = EXCLUDED.multiplier,
                   points = EXCLUDED.points, note = EXCLUDED.note
     RETURNING *`,
    [
      tenantId,
      input.ruleKey,
      input.matchKind,
      value,
      input.mode,
      input.multiplier ?? 1,
      input.points ?? 0,
      input.note ?? '',
    ],
  );
  return row!;
}

export async function deleteProductRule(
  tenantId: string,
  id: string,
  runner: Queryable = db(),
): Promise<boolean> {
  const { rowCount } = await runner.query(
    'DELETE FROM reward_product_rules WHERE tenant_id = $1 AND id = $2',
    [tenantId, id],
  );
  return (rowCount ?? 0) > 0;
}

export async function listProductRules(
  tenantId: string,
  ruleKey?: string,
  runner: Queryable = db(),
): Promise<ProductRule[]> {
  const { rows } = await runner.query<ProductRule>(
    `SELECT * FROM reward_product_rules
      WHERE tenant_id = $1 AND ($2::text IS NULL OR rule_key = $2)
      ORDER BY match_kind, match_value`,
    [tenantId, ruleKey ?? null],
  );
  return rows;
}

export interface ItemBreakdown {
  productRef: string;
  /** Cents that count toward the rule after overrides. */
  eligibleCents: number;
  /** Points added outright by a `fixed` override, bypassing the rate. */
  fixedPoints: number;
  applied: { mode: OverrideMode; matchKind: MatchKind; matchValue: string } | null;
}

export interface OverrideResult {
  /** Cents to run through the rule's normal per-currency-unit rate. */
  eligibleCents: number;
  /** Points contributed by `fixed` overrides, added after the rate. */
  fixedPoints: number;
  breakdown: ItemBreakdown[];
}

/**
 * Apply overrides to an order's lines.
 *
 * `multiplier` scales the line's *value* rather than its points, so the
 * result stays a single integer division at the end and cannot drift from the
 * rule's own rounding. `fixed` is points per unit sold, matching how a store
 * thinks about "50 points for this item".
 */
export function applyProductOverrides(
  items: OrderItem[],
  rules: ProductRule[],
  fallbackCents: number,
): OverrideResult {
  if (rules.length === 0 || items.length === 0) {
    return { eligibleCents: fallbackCents, fixedPoints: 0, breakdown: [] };
  }

  const byProduct = new Map<string, ProductRule>();
  const byCategory = new Map<string, ProductRule>();
  for (const rule of rules) {
    const target = rule.match_kind === 'product' ? byProduct : byCategory;
    target.set(rule.match_value.toLowerCase(), rule);
  }

  let eligibleCents = 0;
  let fixedPoints = 0;
  const breakdown: ItemBreakdown[] = [];

  for (const item of items) {
    // Most specific wins: an explicit product rule overrides whatever its
    // categories say, which is how a "…except this one" exception is written.
    let match = byProduct.get(String(item.productRef).toLowerCase()) ?? null;
    if (!match) {
      for (const ref of item.categoryRefs ?? []) {
        const found = byCategory.get(String(ref).toLowerCase());
        if (found) {
          match = found;
          break;
        }
      }
    }

    const lineCents = Math.max(0, item.subtotalCents ?? 0);

    if (!match) {
      eligibleCents += lineCents;
      breakdown.push({ productRef: item.productRef, eligibleCents: lineCents, fixedPoints: 0, applied: null });
      continue;
    }

    const applied = { mode: match.mode, matchKind: match.match_kind, matchValue: match.match_value };

    if (match.mode === 'exclude') {
      breakdown.push({ productRef: item.productRef, eligibleCents: 0, fixedPoints: 0, applied });
      continue;
    }

    if (match.mode === 'fixed') {
      const units = Math.max(0, Math.trunc(item.quantity ?? 1));
      const points = match.points * units;
      fixedPoints += points;
      breakdown.push({ productRef: item.productRef, eligibleCents: 0, fixedPoints: points, applied });
      continue;
    }

    const scaled = Math.floor(lineCents * Number(match.multiplier));
    eligibleCents += scaled;
    breakdown.push({ productRef: item.productRef, eligibleCents: scaled, fixedPoints: 0, applied });
  }

  return { eligibleCents, fixedPoints, breakdown };
}

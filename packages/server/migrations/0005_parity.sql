-- ─────────────────────────────────────────────────────────────────────────────
-- 0005 — myCred parity: the knobs an admin expects to turn
--
-- A parity review against myCred 2.6.3 found the engine sound but hardcoded
-- where myCred lets an admin configure. Everything here is a control surface
-- rather than a new mechanism: who is excluded from earning, which products
-- earn differently, how caps are windowed, and the coupon conditions the
-- schema already had a column for but never read.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Reward rule controls ─────────────────────────────────────────────────────
-- myCred's per-hook limit string is "N per day|week|month|total"; we had day
-- and total only. max_per_award mirrors myCred's enforce_max(), which clamps
-- any single award however the amount was calculated.
ALTER TABLE reward_rules
  ADD COLUMN weekly_cap    integer,
  ADD COLUMN monthly_cap   integer,
  ADD COLUMN max_per_award integer,
  -- Admin-editable ledger wording. NULL keeps the rule name, which is what
  -- every existing row gets.
  ADD COLUMN log_template  text;

-- ── Who does not earn ────────────────────────────────────────────────────────
-- Staff testing orders, the shop owner's own account, and role-based
-- exclusions. myCred keeps this in settings as user ids + roles; a table lets
-- a retailer manage it through the API and keeps an audit note.
CREATE TABLE reward_exclusions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind            text NOT NULL CHECK (kind IN ('contact', 'email', 'email_domain', 'role', 'tag')),
  -- Lower-cased on write so matching never depends on how it was typed.
  value           text NOT NULL,
  note            text NOT NULL DEFAULT '',
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, kind, value)
);
CREATE INDEX reward_exclusions_lookup_idx ON reward_exclusions (tenant_id, kind, value);

-- ── Per-product and per-category point overrides ─────────────────────────────
-- "Double points on this range, none on gift cards" is the most common store
-- request myCred answers with a per-product meta box.
CREATE TABLE reward_product_rules (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  rule_key        text NOT NULL,
  match_kind      text NOT NULL CHECK (match_kind IN ('product', 'category')),
  match_value     text NOT NULL,
  -- multiplier scales the line's points, fixed replaces them per unit sold,
  -- exclude drops the line from the calculation entirely.
  mode            text NOT NULL CHECK (mode IN ('multiplier', 'fixed', 'exclude')),
  multiplier      numeric(10, 4) NOT NULL DEFAULT 1,
  points          integer NOT NULL DEFAULT 0,
  note            text NOT NULL DEFAULT '',
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, rule_key, match_kind, match_value)
);
CREATE INDEX reward_product_rules_rule_idx ON reward_product_rules (tenant_id, rule_key);

-- ── Coupon conditions ────────────────────────────────────────────────────────
-- min_balance already existed and was never read; max_balance and the grants
-- complete myCred's coupon object.
ALTER TABLE point_coupons
  ADD COLUMN max_balance     integer,
  ADD COLUMN grant_badge_key text,
  ADD COLUMN grant_rank_key  text,
  ADD CONSTRAINT coupon_balance_range CHECK (
    min_balance IS NULL OR max_balance IS NULL OR max_balance >= min_balance
  );

-- ── Ranks: manual assignment ─────────────────────────────────────────────────
-- myCred's "Manual Mode" lets an admin pin someone to a tier regardless of
-- balance. rank_locked is the per-contact pin; manual marks how an award was
-- made so a re-evaluation knows not to undo it.
ALTER TABLE ranks      ADD COLUMN manual_only boolean NOT NULL DEFAULT false;
ALTER TABLE rank_awards ADD COLUMN manual     boolean NOT NULL DEFAULT false;
ALTER TABLE contacts   ADD COLUMN rank_locked boolean NOT NULL DEFAULT false;

-- ── Transactional vs marketing email ─────────────────────────────────────────
-- Every automation email was gated on marketing_consent, which suppressed
-- "you earned 250 points on your order" for anyone who had not opted into
-- marketing — a message about a transaction they just completed. Mautic draws
-- the same line with `sendToDnc`.
--
-- Default false, so nothing starts sending to people who have not consented;
-- marking a template transactional is a deliberate act by the retailer, whose
-- counsel decides what counts as a relationship message in their jurisdiction.
ALTER TABLE email_templates
  ADD COLUMN transactional boolean NOT NULL DEFAULT false;

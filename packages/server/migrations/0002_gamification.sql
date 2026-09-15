-- Gamification and bridging.
--
-- Brings the myCred feature set onto the platform's own ledger: badges with
-- tiers, balance ranks, streaks, member-to-member transfers, coupon codes,
-- points-gated content and notifications. Plus L2→L1 bridge withdrawals.

-- ─────────────────────────────────────────────────────────────────────────────
-- Badges
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE badges (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key             text NOT NULL,
  name            text NOT NULL,
  description     text NOT NULL DEFAULT '',
  image_url       text,
  -- What earns it: {"type":"rule_count","rule_key":"social_share"} or
  -- {"type":"lifetime_points"} / {"type":"order_count"} / {"type":"streak","streak_key":"daily_login"}
  criteria        jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Ascending tiers: [{"level":1,"threshold":1,"label":"Bronze","image_url":"…"}, …]
  tiers           jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Points granted the first time each tier is reached.
  points_per_tier integer NOT NULL DEFAULT 0,
  manual_only     boolean NOT NULL DEFAULT false,
  display_order   integer NOT NULL DEFAULT 0,
  enabled         boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, key)
);

CREATE TABLE badge_awards (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  badge_id        uuid NOT NULL REFERENCES badges(id) ON DELETE CASCADE,
  contact_id      uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  level           integer NOT NULL DEFAULT 1,
  progress        integer NOT NULL DEFAULT 0,
  awarded_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (badge_id, contact_id)
);
CREATE INDEX badge_awards_contact_idx ON badge_awards (contact_id, awarded_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- Ranks (balance tiers)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE ranks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key             text NOT NULL,
  name            text NOT NULL,
  description     text NOT NULL DEFAULT '',
  image_url       text,
  -- Ranked on lifetime points earned, so spending points never demotes anyone.
  min_points      integer NOT NULL DEFAULT 0,
  max_points      integer,
  perks           jsonb NOT NULL DEFAULT '{}'::jsonb,
  display_order   integer NOT NULL DEFAULT 0,
  enabled         boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, key),
  CONSTRAINT ranks_range_sane CHECK (max_points IS NULL OR max_points > min_points)
);
CREATE INDEX ranks_tenant_order_idx ON ranks (tenant_id, min_points) WHERE enabled;

CREATE TABLE rank_awards (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  contact_id      uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  rank_id         uuid NOT NULL REFERENCES ranks(id) ON DELETE CASCADE,
  awarded_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (contact_id, rank_id)
);

-- Current rank per contact, kept alongside the balance cache.
ALTER TABLE points_balances ADD COLUMN current_rank_id uuid REFERENCES ranks(id) ON DELETE SET NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- Streaks (daily login and friends)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE streaks (
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  contact_id      uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  key             text NOT NULL,
  current_length  integer NOT NULL DEFAULT 0,
  longest_length  integer NOT NULL DEFAULT 0,
  -- Stored as a date so "once per day" means the tenant's calendar day, not a
  -- rolling 24 hours that drifts earlier every visit.
  last_day        date NOT NULL,
  total_days      integer NOT NULL DEFAULT 0,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, contact_id, key)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Member-to-member transfers
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE point_transfers (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  from_contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  to_contact_id   uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  points          integer NOT NULL CHECK (points > 0),
  message         text NOT NULL DEFAULT '',
  debit_entry_id  uuid REFERENCES points_ledger(id) ON DELETE SET NULL,
  credit_entry_id uuid REFERENCES points_ledger(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT transfers_no_self CHECK (from_contact_id <> to_contact_id)
);
CREATE INDEX point_transfers_from_idx ON point_transfers (from_contact_id, created_at DESC);
CREATE INDEX point_transfers_to_idx ON point_transfers (to_contact_id, created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- Coupons
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE point_coupons (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code            text NOT NULL,
  points          integer NOT NULL CHECK (points > 0),
  max_uses        integer,
  uses            integer NOT NULL DEFAULT 0,
  per_contact_limit integer NOT NULL DEFAULT 1,
  min_balance     integer,
  expires_at      timestamptz,
  enabled         boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);

CREATE TABLE coupon_redemptions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  coupon_id       uuid NOT NULL REFERENCES point_coupons(id) ON DELETE CASCADE,
  contact_id      uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  points          integer NOT NULL,
  redeemed_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX coupon_redemptions_pair_idx ON coupon_redemptions (coupon_id, contact_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- Points-gated content
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE content_unlocks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  contact_id      uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  content_ref     text NOT NULL,
  points_spent    integer NOT NULL,
  ledger_entry_id uuid REFERENCES points_ledger(id) ON DELETE SET NULL,
  unlocked_at     timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz,
  UNIQUE (tenant_id, contact_id, content_ref)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Notifications
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE notifications (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  contact_id      uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  type            text NOT NULL,
  title           text NOT NULL,
  body            text NOT NULL DEFAULT '',
  icon            text,
  link_url        text,
  meta            jsonb NOT NULL DEFAULT '{}'::jsonb,
  read_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_contact_idx ON notifications (contact_id, created_at DESC);
CREATE INDEX notifications_unread_idx ON notifications (contact_id) WHERE read_at IS NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- L2 → L1 bridge withdrawals
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE bridge_withdrawals (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid REFERENCES tenants(id) ON DELETE SET NULL,
  contact_id      uuid REFERENCES contacts(id) ON DELETE SET NULL,
  member_id       uuid REFERENCES members(id) ON DELETE SET NULL,
  from_address    text NOT NULL,
  l1_recipient    text NOT NULL,
  -- Burned on L2 at 18 decimals…
  l2_amount_wei   numeric(78, 0) NOT NULL,
  -- …released on L1 at 9 decimals. The remainder is swept to treasury by the
  -- contract itself, so these two are not a simple 10^9 ratio when there is dust.
  l1_amount       numeric(78, 0) NOT NULL,
  dust_wei        numeric(78, 0) NOT NULL DEFAULT 0,
  l2_chain_id     bigint NOT NULL,
  l1_chain_id     bigint NOT NULL DEFAULT 1,
  burn_tx_hash    text NOT NULL,
  release_tx_hash text,
  status          text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'burn_verified', 'released', 'rejected')),
  rejected_reason text,
  verified_at     timestamptz,
  released_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  -- One withdrawal per burn transaction, ever.
  UNIQUE (l2_chain_id, burn_tx_hash)
);
CREATE INDEX bridge_withdrawals_status_idx ON bridge_withdrawals (status, created_at);
CREATE INDEX bridge_withdrawals_address_idx ON bridge_withdrawals (from_address, created_at DESC);

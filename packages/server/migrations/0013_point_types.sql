-- ─────────────────────────────────────────────────────────────────────────────
-- 0013 — several currencies, not one
--
-- myCred's largest remaining feature: a retailer can run more than one
-- currency side by side. "Points" you spend and "status credits" you only
-- accumulate is the classic pair — the second must not be spendable, or it
-- stops meaning anything.
--
-- Everything here is additive and defaulted, so a tenant that never creates a
-- second type behaves exactly as before. The default key is 'points', which is
-- what every existing row already implicitly is.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE point_types (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key             text NOT NULL,
  name            text NOT NULL,
  -- What to call one and many of them in the storefront: "1 point",
  -- "340 status credits". Without these every currency reads as "points",
  -- which defeats having more than one.
  singular        text NOT NULL DEFAULT 'point',
  plural          text NOT NULL DEFAULT 'points',

  -- Exactly one type per tenant is the default: what an award with no type
  -- named goes to, and what the storefront shows first.
  is_default      boolean NOT NULL DEFAULT false,

  -- Can this currency leave the platform — become store credit or TBAY?
  -- A status currency must not, or "status" becomes a second wallet.
  convertible     boolean NOT NULL DEFAULT false,
  -- Can members send it to each other? Same reasoning.
  transferable    boolean NOT NULL DEFAULT false,

  display_order   integer NOT NULL DEFAULT 0,
  enabled         boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, key)
);

-- One default, enforced by the database rather than by whoever writes the
-- next code path that sets one.
CREATE UNIQUE INDEX point_types_one_default_idx
  ON point_types (tenant_id) WHERE is_default;

-- Every tenant that already exists gets the type its rows are already in.
INSERT INTO point_types (tenant_id, key, name, is_default, convertible, transferable)
SELECT id, 'points', 'Points', true, true, true FROM tenants
ON CONFLICT (tenant_id, key) DO NOTHING;

-- ── The dimension itself ─────────────────────────────────────────────────────
--
-- 'points' as the default on every column, so existing rows and any code path
-- not yet aware of types keeps landing in the same place.

ALTER TABLE points_ledger   ADD COLUMN point_type text NOT NULL DEFAULT 'points';
ALTER TABLE points_balances ADD COLUMN point_type text NOT NULL DEFAULT 'points';
ALTER TABLE reward_rules    ADD COLUMN point_type text NOT NULL DEFAULT 'points';
ALTER TABLE ranks           ADD COLUMN point_type text NOT NULL DEFAULT 'points';
ALTER TABLE badges          ADD COLUMN point_type text NOT NULL DEFAULT 'points';
ALTER TABLE point_coupons   ADD COLUMN point_type text NOT NULL DEFAULT 'points';
ALTER TABLE point_transfers ADD COLUMN point_type text NOT NULL DEFAULT 'points';

-- A balance is per currency. The old key was (tenant, contact), which would
-- have collapsed every currency into one row.
ALTER TABLE points_balances DROP CONSTRAINT points_balances_pkey;
ALTER TABLE points_balances ADD PRIMARY KEY (tenant_id, contact_id, point_type);

-- Reward rules, ranks and badges each belong to one currency. A rank set for
-- "status" must not be reached by earning "points".
CREATE INDEX reward_rules_type_idx ON reward_rules (tenant_id, point_type);
CREATE INDEX ranks_type_idx        ON ranks (tenant_id, point_type, min_points);
CREATE INDEX badges_type_idx       ON badges (tenant_id, point_type);

-- The ledger is read per currency on every balance page and leaderboard.
CREATE INDEX points_ledger_type_idx
  ON points_ledger (tenant_id, contact_id, point_type, created_at DESC);

-- Deliberately NOT added to the idempotency key's unique index. A key is
-- unique per tenant across every currency: two different currencies awarded
-- under one key would mean the caller did not decide which they meant.

-- ── The manual rank pin moves with the balance ───────────────────────────────
--
-- A pin was a single flag on the contact, which was right when there was one
-- ladder. With a currency per ladder it would freeze all of them: a retailer
-- pinning a VIP on the spend ladder would also stop the status ladder from
-- ever moving again. The pin belongs to the balance row it pins.

ALTER TABLE points_balances ADD COLUMN rank_locked boolean NOT NULL DEFAULT false;

UPDATE points_balances b
   SET rank_locked = true
  FROM contacts c
 WHERE c.id = b.contact_id
   AND c.tenant_id = b.tenant_id
   AND c.rank_locked;

ALTER TABLE contacts DROP COLUMN rank_locked;

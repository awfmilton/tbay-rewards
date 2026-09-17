-- ─────────────────────────────────────────────────────────────────────────────
-- 0023 — a store credit is a balance, not a token
--
-- Redeeming marked the whole credit `redeemed` whatever it paid for. The
-- storefront discounts `min(credit, basket)`, so a $50 credit spent on a $10
-- basket took $10 off and destroyed the other $40 — the customer's money, and
-- the retailer looks like they took it.
--
-- So the credit is drawn down. `redeemed_cents` is what has been spent,
-- `amount_cents` stays the face value, and the difference is what is left. A
-- credit is only `redeemed` once nothing remains.
--
-- Redemptions are recorded per order rather than in the single `order_ref`
-- column, which could only ever name the last one.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE store_credits
  ADD COLUMN redeemed_cents bigint NOT NULL DEFAULT 0
    CHECK (redeemed_cents >= 0);

-- Everything already redeemed was redeemed in full; that is what the old code
-- did, and the row says so.
UPDATE store_credits SET redeemed_cents = amount_cents WHERE status = 'redeemed';

ALTER TABLE store_credits
  ADD CONSTRAINT store_credits_not_overdrawn CHECK (redeemed_cents <= amount_cents);

CREATE TABLE store_credit_redemptions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  credit_id       uuid NOT NULL REFERENCES store_credits(id) ON DELETE CASCADE,
  order_ref       text NOT NULL,
  amount_cents    bigint NOT NULL CHECK (amount_cents > 0),
  created_at      timestamptz NOT NULL DEFAULT now(),

  -- One redemption per credit per order. A checkout retried after a timeout,
  -- or two tabs finishing at once, asks twice and is answered once — the
  -- storefront cannot tell the difference between "that did not go through"
  -- and "that went through and the reply was lost", so the database decides.
  UNIQUE (credit_id, order_ref)
);

CREATE INDEX store_credit_redemptions_order_idx
  ON store_credit_redemptions (tenant_id, order_ref);

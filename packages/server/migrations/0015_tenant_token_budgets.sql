-- ─────────────────────────────────────────────────────────────────────────────
-- 0015 — a retailer's TBAY issuance is budgeted per retailer
--
-- The hourly mint window and the lifetime reward-supply budget are both keyed
-- (chain, contract): every tenant on the platform shares them. So one retailer
-- could set pointsPerToken to 1, adjust itself a few million points and redeem
-- them, and every OTHER retailer's customers would get "the TBAY hourly mint
-- allowance is exhausted" — or, with a supply cap configured, find the whole
-- reward allocation committed. In treasury mode the tokens actually leave.
--
-- Nothing about that requires malice: a retailer that misconfigures its
-- conversion rate does the same damage by accident.
--
-- These budgets sit in front of the shared ones. A tenant over its own share is
-- refused before it touches platform capacity, so the blast radius of one
-- retailer's mistake is that retailer.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE tenant_token_windows (
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  chain_id         integer NOT NULL,
  contract_address text NOT NULL,
  window_start     timestamptz NOT NULL,
  minted_wei       numeric(78, 0) NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, chain_id, contract_address, window_start)
);

-- The sweeper below deletes by age across every tenant.
CREATE INDEX tenant_token_windows_start_idx ON tenant_token_windows (window_start);

CREATE TABLE tenant_token_budgets (
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  chain_id         integer NOT NULL,
  contract_address text NOT NULL,
  issued_wei       numeric(78, 0) NOT NULL DEFAULT 0,
  reversed_wei     numeric(78, 0) NOT NULL DEFAULT 0,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, chain_id, contract_address)
);

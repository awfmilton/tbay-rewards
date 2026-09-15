-- Reward supply accounting.
--
-- One row per (chain, contract) tracking every wei this platform has committed
-- to reward redemptions. Separate from token_mint_windows, which mirrors the
-- contract's *hourly* rate limit; this is the lifetime budget that keeps the
-- L2→L1 bridge solvent against a fixed 1,000,000-token L1 supply.

CREATE TABLE token_supply_budget (
  chain_id         bigint NOT NULL,
  contract_address text NOT NULL,
  issued_wei       numeric(78, 0) NOT NULL DEFAULT 0,
  reversed_wei     numeric(78, 0) NOT NULL DEFAULT 0,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_id, contract_address)
);

-- How the voucher was funded, so reporting can tell minted supply apart from
-- treasury transfers after a mid-life switch.
ALTER TABLE token_claims
  ADD COLUMN supply_mode text NOT NULL DEFAULT 'mint'
  CHECK (supply_mode IN ('mint', 'treasury'));

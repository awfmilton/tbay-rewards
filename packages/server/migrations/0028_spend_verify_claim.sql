-- A spend intent that is being verified is not a spend intent nobody is using.
--
-- `verifySpendIntent` reads the row, makes an RPC round trip to the chain, and
-- only then writes 'verified' with a `WHERE status = 'pending'` guard. The
-- expiry worker added in the previous round writes 'expired' over exactly that
-- predicate on a five-minute tick, so the two race: a verify that begins a
-- second before `expires_at` and takes three seconds on the RPC comes back to
-- find its row already expired, and the compare-and-swap matches nothing.
--
-- Reproduced with a control: worker running -> status 'expired', zero store
-- credits and "Spend intent was already settled"; worker stopped -> 'verified',
-- one credit. The customer's TBAY is at the retailer's payout wallet either
-- way, so the losing side of that race is money taken and nothing given back.
--
-- So the verify claims the row for the duration of the RPC. 'verifying' is a
-- state the worker does not touch, and `verify_claimed_at` is what lets a
-- request that died mid-RPC be released rather than stranding the intent.
ALTER TABLE token_spend_intents
  DROP CONSTRAINT IF EXISTS token_spend_intents_status_check;

ALTER TABLE token_spend_intents
  ADD CONSTRAINT token_spend_intents_status_check
  CHECK (status IN ('pending', 'verifying', 'verified', 'expired', 'cancelled'));

ALTER TABLE token_spend_intents
  ADD COLUMN IF NOT EXISTS verify_claimed_at timestamptz;

-- The worker looks for both: stale 'pending' rows to expire, and 'verifying'
-- rows whose request never came back, to release.
DROP INDEX IF EXISTS token_spend_open_idx;
CREATE INDEX token_spend_open_idx ON token_spend_intents (status, expires_at)
  WHERE status IN ('pending', 'verifying');

CREATE INDEX token_spend_claimed_idx ON token_spend_intents (verify_claimed_at)
  WHERE status = 'verifying';

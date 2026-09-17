-- Scope a verification's release to the claim that took the row.
--
-- `release()` was `WHERE id = $1 AND status = 'verifying'` with nothing saying
-- *whose* claim it was, so any failing request released whatever claim existed
-- at that moment -- including one held by a different verification still
-- waiting on the chain. Reproduced: a real settlement came back from the RPC
-- to find its row released and re-claimed, and answered 409 "Spend intent was
-- already settled" while the customer's TBAY sat at the retailer's payout
-- wallet. Recoverable by retrying, but the message says the opposite of the
-- truth and a caller treating 409 as terminal stops there.
--
-- A token rather than the timestamp, for the same reason email_messages uses
-- one: Postgres keeps microseconds, node-postgres hands back a millisecond JS
-- Date, and the truncated value never matches on the way back in.
ALTER TABLE token_spend_intents
  ADD COLUMN IF NOT EXISTS verify_token uuid;

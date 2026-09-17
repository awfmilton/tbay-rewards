-- A claim needs a token, not a timestamp.
--
-- Every write that finishes a send has to prove it still owns the claim,
-- otherwise a worker whose send outlived the stale window writes its late
-- failure over the row another worker already marked sent, and the message
-- goes out a second time.
--
-- The obvious discriminator was claimed_at, and it does not work: Postgres
-- stores microseconds, node-postgres parses a timestamptz into a JS Date at
-- millisecond precision, and the truncated value sent back never equals the
-- stored one. Every guarded write matched nothing. A uuid round-trips exactly.

ALTER TABLE email_messages ADD COLUMN IF NOT EXISTS claim_token uuid;
ALTER TABLE webhook_deliveries ADD COLUMN IF NOT EXISTS claim_token uuid;

-- ─────────────────────────────────────────────────────────────────────────────
-- 0024 — claiming a message takes it out of the queue
--
-- The flush claimed rows with `FOR UPDATE SKIP LOCKED`, bumped `attempts`, and
-- left `status = 'queued'`. Those row locks last only as long as the claiming
-- statement, so the moment it committed the same rows matched the next
-- worker's claim — `status = 'queued' AND attempts < 5` — and were sent again.
--
-- Nothing caught it because the default deployment runs one worker. The compose
-- file ships an API and a separate worker container, and the API starts workers
-- unless told not to; two API replicas do it too. Every campaign would have
-- gone out twice, or more.
--
-- So a claim moves the row to `sending`, which no claim selects. A worker that
-- dies mid-send leaves a row there, which is why the claim also takes back
-- anything that has been `sending` for longer than any send could take.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE email_messages DROP CONSTRAINT IF EXISTS email_messages_status_check;
ALTER TABLE email_messages ADD CONSTRAINT email_messages_status_check
  CHECK (status IN ('queued', 'sending', 'sent', 'failed', 'skipped', 'suppressed'));

-- When the row was claimed, so a dead worker's messages can be taken back.
ALTER TABLE email_messages ADD COLUMN claimed_at timestamptz;

-- The claim reads both states, so the partial index has to cover both.
DROP INDEX IF EXISTS email_messages_queue_idx;
CREATE INDEX email_messages_queue_idx
  ON email_messages (status, created_at)
  WHERE status IN ('queued', 'sending');

-- The same hole, and the same fix, for outbound webhooks: the claim bumped
-- `attempts` and left the row `queued` with its `next_attempt_at` in the past,
-- so two workers posted every delivery — to a retailer's storefront, which
-- then awarded points or synced an order twice.
ALTER TABLE webhook_deliveries DROP CONSTRAINT IF EXISTS webhook_deliveries_status_check;
ALTER TABLE webhook_deliveries ADD CONSTRAINT webhook_deliveries_status_check
  CHECK (status IN ('queued', 'sending', 'delivered', 'failed'));
ALTER TABLE webhook_deliveries ADD COLUMN claimed_at timestamptz;

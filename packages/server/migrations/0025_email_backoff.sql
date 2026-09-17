-- ─────────────────────────────────────────────────────────────────────────────
-- 0025 — a retry that waits
--
-- The queue retried on every tick. Five attempts fifteen seconds apart meant a
-- message was written off in about a minute and its address suppressed for
-- thirty days — so an hour of throttling from the provider, or an IP listed on
-- a blocklist for an afternoon, took the whole batch off the list. The 30-day
-- suppression exists to stop a bounce storm; without a wait between attempts it
-- became a way to lose a mailing list to a transient problem.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE email_messages ADD COLUMN next_attempt_at timestamptz NOT NULL DEFAULT now();

-- The claim orders by `created_at` and now also filters on this, so it belongs
-- in the same partial index.
DROP INDEX IF EXISTS email_messages_queue_idx;
CREATE INDEX email_messages_queue_idx
  ON email_messages (status, next_attempt_at, created_at)
  WHERE status IN ('queued', 'sending');

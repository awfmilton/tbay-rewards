-- ─────────────────────────────────────────────────────────────────────────────
-- 0012 — tell a transport failure from a bounce
--
-- An adversarial review found that a ~75 second relay outage, retried five
-- times at fifteen-second intervals, permanently suppressed every recipient
-- queued at the time. The classifier treated "connection refused" the same as
-- "no such user", and the retry budget was spent on an outage that said
-- nothing about any mailbox.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE email_messages DROP CONSTRAINT IF EXISTS email_messages_bounce_type_check;

ALTER TABLE email_messages
  ADD CONSTRAINT email_messages_bounce_type_check
  CHECK (bounce_type IS NULL OR bounce_type IN ('hard', 'soft', 'complaint', 'transport'));

-- Give back the suppressions that outage handling would have made permanent.
-- A 'repeated_failure' is a guess about a mailbox, not a fact, and every one
-- written before this migration was written without an expiry.
UPDATE email_suppressions
   SET expires_at = now() + interval '1 day'
 WHERE reason = 'repeated_failure' AND expires_at IS NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- Automation runs: a persistent step budget and the shape of the sequence
--
-- Two findings from the same review:
--
--  - `MAX_STEPS` was a local counter reset on every resumption, so a
--    `wait 1 second` + `goto 0` cycle re-parked forever and monopolised the
--    shared worker across every tenant. The budget has to outlive a wait.
--  - A run stores an integer step index against a *live* action list. Editing
--    the list while runs are parked shifts what that index points at, and
--    because idempotency keys embed the index, an `award_points` step could
--    re-execute under a fresh key and hand out points nobody earned.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE automation_runs
  ADD COLUMN steps_executed integer NOT NULL DEFAULT 0,
  -- A digest of the action list the run started under. A mismatch on resume
  -- means the sequence was edited beneath it.
  ADD COLUMN actions_hash text;

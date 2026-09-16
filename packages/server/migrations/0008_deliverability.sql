-- ─────────────────────────────────────────────────────────────────────────────
-- 0008 — bounces, complaints and suppression
--
-- subscriptions.status has allowed 'bounced' and 'complained' since the
-- baseline and nothing ever set them, so a dead address was retried forever
-- and a spam complaint changed nothing. There was also no List-Unsubscribe
-- header, which Gmail and Yahoo require of bulk senders.
-- ─────────────────────────────────────────────────────────────────────────────

-- Addresses we will not mail again, whatever a list row says.
--
-- Suppression is keyed on the address rather than the contact: a hard bounce
-- is a fact about a mailbox, and it should survive the contact being deleted,
-- re-imported, or existing twice under different external refs.
CREATE TABLE email_suppressions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email           text NOT NULL,
  reason          text NOT NULL CHECK (reason IN ('hard_bounce', 'complaint', 'manual', 'repeated_failure')),
  detail          text NOT NULL DEFAULT '',
  -- A soft bounce clears itself; a hard one does not. NULL means permanent.
  expires_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, email)
);
CREATE INDEX email_suppressions_lookup_idx ON email_suppressions (tenant_id, email);

ALTER TABLE email_messages
  -- 'suppressed' is distinct from 'skipped': the message was never attempted
  -- because the address is on the suppression list, which is an answer rather
  -- than a failure.
  DROP CONSTRAINT IF EXISTS email_messages_status_check;

ALTER TABLE email_messages
  ADD CONSTRAINT email_messages_status_check
  CHECK (status IN ('queued', 'sent', 'failed', 'skipped', 'suppressed'));

ALTER TABLE email_messages
  -- Classified from the SMTP reply or a provider webhook, so the retry logic
  -- can tell "mailbox does not exist" from "try again in a minute".
  ADD COLUMN bounce_type text CHECK (bounce_type IN ('hard', 'soft', 'complaint'));

ALTER TABLE email_messages
  -- The unsubscribe URL as it went into this message.
  --
  -- It cannot be recomputed later: subscriptions store only a hash of the
  -- token, so the plaintext exists once, at queue time, in the caller that
  -- built the body. Storing it here is what lets the List-Unsubscribe header
  -- point at the same place as the link in the message.
  ADD COLUMN unsubscribe_url text;

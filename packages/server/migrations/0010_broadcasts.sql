-- ─────────────────────────────────────────────────────────────────────────────
-- 0010 — broadcasts and frequency capping
--
-- Every email the platform sent was triggered by one contact's own action.
-- There was no "send this to that segment on Tuesday", which is the single
-- thing a marketing team does most.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE broadcasts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key             text NOT NULL,
  name            text NOT NULL,
  segment_id      uuid REFERENCES segments(id) ON DELETE RESTRICT,
  template_key    text NOT NULL,
  -- Overrides the template's subject when set, so the same template can carry
  -- several sends without being edited each time.
  subject         text,

  -- draft    → being written, never sends
  -- scheduled→ will send at send_at
  -- sending  → a worker is walking the audience
  -- sent     → the audience was walked to the end
  -- cancelled→ stopped by a human; queued messages already written still go
  -- failed   → the run itself broke, not an individual message
  status          text NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft', 'scheduled', 'sending', 'sent', 'cancelled', 'failed')),
  send_at         timestamptz,
  started_at      timestamptz,
  finished_at     timestamptz,

  -- The audience is frozen when the send starts, not recomputed per batch: a
  -- contact who stops matching halfway through must not disappear mid-send,
  -- and one who starts matching must not be surprised by a campaign whose
  -- earlier half they never saw.
  audience_size   integer NOT NULL DEFAULT 0,
  queued_count    integer NOT NULL DEFAULT 0,
  skipped_count   integer NOT NULL DEFAULT 0,
  cursor_contact  uuid,
  error           text,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, key)
);
CREATE INDEX broadcasts_due_idx ON broadcasts (send_at)
  WHERE status IN ('scheduled', 'sending');

-- Who a broadcast reached, and why someone was skipped.
--
-- A separate row per recipient rather than counters alone: "why did Jane not
-- get the sale email" is the question a marketing team asks, and a counter
-- cannot answer it.
CREATE TABLE broadcast_recipients (
  broadcast_id    uuid NOT NULL REFERENCES broadcasts(id) ON DELETE CASCADE,
  contact_id      uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  message_id      uuid REFERENCES email_messages(id) ON DELETE SET NULL,
  status          text NOT NULL CHECK (status IN ('queued', 'skipped')),
  skip_reason     text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (broadcast_id, contact_id)
);
CREATE INDEX broadcast_recipients_contact_idx ON broadcast_recipients (contact_id);

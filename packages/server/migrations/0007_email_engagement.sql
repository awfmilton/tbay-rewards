-- ─────────────────────────────────────────────────────────────────────────────
-- 0007 — email opens and clicks
--
-- The platform sent email and learned nothing from it: no opens, no clicks, no
-- engagement signal for an automation, and an email click could not identify
-- the anonymous visitor who followed it. The click-redirect machinery for
-- writer links already existed; this points it at outgoing mail.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE email_messages
  -- Unguessable per-message token. It is the whole address space for both the
  -- pixel and the link redirects, so it must not be derivable from the message
  -- id, which appears in API responses.
  ADD COLUMN tracking_token   text,
  -- The rewritten links, in order. Storing them on the message means one row
  -- per send rather than one row per (send x link), and the redirect resolves
  -- by index rather than trusting a URL in the query string — which is what
  -- stops the endpoint becoming an open redirect.
  ADD COLUMN tracked_links    jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN opened_at        timestamptz,
  ADD COLUMN open_count       integer NOT NULL DEFAULT 0,
  ADD COLUMN first_clicked_at timestamptz,
  ADD COLUMN click_count      integer NOT NULL DEFAULT 0,
  -- A scanner prefetching every link is not engagement. Counted separately so
  -- the real numbers stay honest and automations never fire on a robot.
  ADD COLUMN bot_open_count   integer NOT NULL DEFAULT 0,
  ADD COLUMN bot_click_count  integer NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX email_messages_token_idx
  ON email_messages (tracking_token) WHERE tracking_token IS NOT NULL;

CREATE INDEX email_messages_contact_idx
  ON email_messages (tenant_id, contact_id, created_at DESC);

-- Individual open and click events, for reporting and for answering "did this
-- person ever click the thing we sent them".
CREATE TABLE email_events (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  message_id      uuid NOT NULL REFERENCES email_messages(id) ON DELETE CASCADE,
  contact_id      uuid REFERENCES contacts(id) ON DELETE SET NULL,
  kind            text NOT NULL CHECK (kind IN ('open', 'click')),
  /** Which entry of tracked_links; null for an open. */
  link_index      integer,
  url             text,
  ip_hash         text,
  ua_hash         text,
  is_bot          boolean NOT NULL DEFAULT false,
  occurred_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX email_events_message_idx ON email_events (message_id, occurred_at DESC);
CREATE INDEX email_events_tenant_idx  ON email_events (tenant_id, kind, occurred_at DESC);
CREATE INDEX email_events_contact_idx
  ON email_events (tenant_id, contact_id, kind) WHERE contact_id IS NOT NULL;

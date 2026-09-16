-- ─────────────────────────────────────────────────────────────────────────────
-- 0016 — erasure, and not keeping what nobody needs
--
-- A retailer running this is a data controller. Two obligations it could not
-- meet before: erase a person on request, and stop holding behavioural data
-- long after it is any use.
--
-- The hard part of erasure here is that the ledger is append-only and a balance
-- is a claim on the retailer. Deleting a contact would cascade through
-- points_ledger and take the retailer's own financial record with it, which is
-- not what anybody is asking for and in most places is itself unlawful. So the
-- contact row survives, stripped: the identifiers go, the history stays, and
-- the row is marked so nothing ever writes an identifier back onto it.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE contacts ADD COLUMN erased_at timestamptz;

-- Reconnecting an erased person is worse than the erasure being incomplete:
-- they asked to be gone, and an import that re-adds their address undoes it
-- silently. The hash is the only way to recognise an address we must refuse
-- without keeping the address.
--
-- Per tenant, salted with the tenant's own pii_salt, so the same person erased
-- at one retailer is not identifiable as erased at another.
ALTER TABLE contacts ADD COLUMN erased_email_hash text;

CREATE INDEX contacts_erased_hash_idx
  ON contacts (tenant_id, erased_email_hash)
  WHERE erased_email_hash IS NOT NULL;

-- ── Retention ────────────────────────────────────────────────────────────────
--
-- Nulls mean "keep indefinitely", which is what every existing tenant has and
-- therefore no change for them. A retailer sets the windows it wants and the
-- sweeper below honours them.
--
-- Deliberately per-category, because the right answer differs:
--   events and sessions   — behavioural, the largest tables, useful for months
--   email bodies          — the rendered HTML of what somebody was sent
--   erased contacts       — the stripped shell, once nothing references it

CREATE TABLE retention_policies (
  tenant_id            uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  -- Raw behavioural rows. Heatmap and product aggregates are NOT deleted with
  -- them: those are counts, carry no identifier, and are what the analytics
  -- screens actually read.
  event_days           integer,
  session_days         integer,
  -- The stored body of a sent email. Delivery metadata (opened, clicked,
  -- bounced) survives, because a suppression list with no reason is a list
  -- nobody can audit.
  email_body_days      integer,
  -- Rendered notification text in the member's inbox.
  notification_days    integer,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT retention_positive CHECK (
    coalesce(event_days, 1) > 0 AND coalesce(session_days, 1) > 0
    AND coalesce(email_body_days, 1) > 0 AND coalesce(notification_days, 1) > 0
  )
);

-- No new indexes for the sweeper: 0001 already has
-- events_tenant_time_idx (tenant_id, occurred_at DESC) and
-- sessions_tenant_started_idx (tenant_id, started_at DESC), and a DESC btree
-- serves an ascending range scan just as well. Adding the ASC twins would have
-- doubled the write cost on the two largest tables in the schema for nothing.

-- ── The record that an erasure happened ──────────────────────────────────────
--
-- Erasure that leaves no trace cannot be shown to have been carried out, which
-- is the one thing a regulator asks for. This holds no personal data: an
-- erasure is recorded by contact id and a hash, never by name or address.

CREATE TABLE erasure_log (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  contact_id      uuid NOT NULL,
  email_hash      text NOT NULL,
  -- 'request' (the person asked), 'retention' (a policy aged them out),
  -- 'admin' (the retailer decided).
  reason          text NOT NULL,
  requested_by    text,
  points_forfeited integer NOT NULL DEFAULT 0,
  rows_deleted    jsonb NOT NULL DEFAULT '{}'::jsonb,
  erased_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX erasure_log_tenant_idx ON erasure_log (tenant_id, erased_at DESC);

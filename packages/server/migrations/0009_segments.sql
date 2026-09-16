-- ─────────────────────────────────────────────────────────────────────────────
-- 0009 — dynamic segments
--
-- The README claimed segments and there were none: audiences could only be
-- chosen by list membership plus a consent flag, so "customers who ordered in
-- the last 90 days and are not tagged vip" was not expressible. This is the
-- storage; the filter compiler is in src/services/segments.ts.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE segments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key             text NOT NULL,
  name            text NOT NULL,
  description     text NOT NULL DEFAULT '',
  -- A filter group: {"match":"all"|"any","filters":[…],"groups":[…]}.
  -- Stored rather than compiled so a saved segment survives a change to the
  -- compiler, and so the UI can render what the user actually chose.
  definition      jsonb NOT NULL DEFAULT '{"match":"all","filters":[]}'::jsonb,
  -- Materialised membership is a cache. A segment is always *defined* by its
  -- filters; these columns only say when we last counted.
  member_count    integer NOT NULL DEFAULT 0,
  last_built_at   timestamptz,
  last_build_ms   integer,
  build_error     text,
  enabled         boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, key)
);

-- Materialised membership.
--
-- Evaluating a filter tree per contact per send does not scale, and a sending
-- run needs a stable audience anyway: a contact who stops matching halfway
-- through a broadcast should not vanish from it mid-flight.
CREATE TABLE segment_members (
  segment_id      uuid NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
  contact_id      uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  added_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (segment_id, contact_id)
);
CREATE INDEX segment_members_contact_idx ON segment_members (contact_id);

-- Supporting indexes for the filter families the compiler can emit.
CREATE INDEX contacts_tenant_lastseen_idx ON contacts (tenant_id, last_seen_at DESC);
CREATE INDEX contacts_tags_idx            ON contacts USING gin (tags);
CREATE INDEX contacts_attributes_idx      ON contacts USING gin (attributes jsonb_path_ops);
CREATE INDEX orders_contact_placed_idx    ON orders (contact_id, placed_at DESC)
  WHERE contact_id IS NOT NULL;

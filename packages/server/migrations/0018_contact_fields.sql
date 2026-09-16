-- ─────────────────────────────────────────────────────────────────────────────
-- 0018 — the retailer's own fields
--
-- Segments filter over a fixed catalogue of platform fields. A flag store
-- wants to segment on "province" and "preferred fabric"; a rewards programme
-- on "membership tier". Those are the retailer's data, and there was nowhere
-- to put them that anything could read back.
--
-- Typed columns rather than jsonb, and the reason is where the error lands.
-- With jsonb the value is text and a segment filtering "spend > 100" has to
-- cast at read time, so one contact whose "spend" is "lots" raises in the
-- middle of an audience build — a 500 from a screen that did nothing wrong,
-- hours after the bad value was written. Typed columns move that failure to
-- the write, where it is a 400 to whoever wrote it and names the field.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE contact_fields (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key           text NOT NULL,
  label         text NOT NULL,
  description   text NOT NULL DEFAULT '',
  -- What the value is, which decides the column it lands in, the operators a
  -- segment may use on it, and the control the admin screen renders.
  kind          text NOT NULL CHECK (kind IN ('text', 'number', 'date', 'boolean', 'select')),
  -- For 'select': the permitted values. A free-text field that should have
  -- been a list is how "ON", "on", "On" and "Ontario" end up as four segments.
  options       text[] NOT NULL DEFAULT '{}',
  display_order integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, key),
  -- A select with no options accepts nothing, which is a field nobody can
  -- fill in rather than a field with no constraint.
  CONSTRAINT select_has_options CHECK (kind <> 'select' OR array_length(options, 1) > 0)
);

CREATE TABLE contact_field_values (
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  contact_id   uuid NOT NULL,
  field_key    text NOT NULL,
  -- One of these, chosen by the field's kind. Separate columns rather than one
  -- text column so the database compares numbers as numbers and dates as
  -- dates: "tier > 3" over text puts 10 below 9.
  text_value   text,
  number_value numeric,
  date_value   timestamptz,
  bool_value   boolean,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, contact_id, field_key),
  FOREIGN KEY (contact_id, tenant_id) REFERENCES contacts (id, tenant_id) ON DELETE CASCADE
);

-- A segment filter is "the contacts whose field X is Y", read per contact
-- across the whole book. Without these it is a sequential scan of every value
-- a retailer has ever stored, once per filter, on every rebuild.
CREATE INDEX contact_field_text_idx
  ON contact_field_values (tenant_id, field_key, text_value)
  WHERE text_value IS NOT NULL;
CREATE INDEX contact_field_number_idx
  ON contact_field_values (tenant_id, field_key, number_value)
  WHERE number_value IS NOT NULL;
CREATE INDEX contact_field_date_idx
  ON contact_field_values (tenant_id, field_key, date_value)
  WHERE date_value IS NOT NULL;

-- The other direction: "everything held about this contact", which the
-- customer screen and the subject access export both ask for.
CREATE INDEX contact_field_contact_idx
  ON contact_field_values (tenant_id, contact_id);

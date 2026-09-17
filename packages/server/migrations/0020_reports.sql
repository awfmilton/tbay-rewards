-- ─────────────────────────────────────────────────────────────────────────────
-- 0020 — reports a retailer composes, and exports that arrive without asking
--
-- The analytics screens answer the questions we thought of. A retailer wants
-- "revenue by campaign, monthly, for the last year" or "points issued per rule
-- since we changed the rates" — questions nobody can enumerate in advance, and
-- which are currently answered by somebody writing SQL against the production
-- database, or not at all.
--
-- The report definition is the retailer's; the *shape* of it is not. A report
-- names a source, some dimensions and some measures, each from a fixed
-- catalogue — the same discipline the segment filter compiler is built on, for
-- the same reason. "Let admins pick any column" is how a reporting screen
-- becomes an arbitrary-read primitive over the whole schema.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE reports (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key         text NOT NULL,
  name        text NOT NULL,
  description text NOT NULL DEFAULT '',
  -- { source, dimensions[], measures[], filters?, range, sort?, limit? }
  -- Validated against the catalogue on save, so a broken definition is
  -- rejected while an admin is looking at the form rather than three weeks
  -- later when its schedule fires at 6am.
  definition  jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, key)
);

-- ── Scheduled exports ────────────────────────────────────────────────────────
--
-- A report nobody opens is a report nobody has. The weekly numbers landing in
-- an inbox on Monday morning is the difference between a reporting feature and
-- a reporting feature people use.

CREATE TABLE report_schedules (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  report_id    uuid NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  -- 'daily', 'weekly', 'monthly'. Deliberately not cron: an admin screen with
  -- a cron field is an admin screen where somebody schedules a report for
  -- 03:17 every 13th of the month by accident.
  cadence      text NOT NULL CHECK (cadence IN ('daily', 'weekly', 'monthly')),
  -- Hour of the day in the *retailer's* timezone. A Monday report arriving at
  -- 01:00 local because the server runs UTC is a report read on Tuesday.
  hour         integer NOT NULL DEFAULT 7 CHECK (hour BETWEEN 0 AND 23),
  -- 0 = Sunday, for the weekly cadence. Day of month for the monthly one,
  -- clamped to 28 so February never silently skips a send.
  day_of_week  integer NOT NULL DEFAULT 1 CHECK (day_of_week BETWEEN 0 AND 6),
  day_of_month integer NOT NULL DEFAULT 1 CHECK (day_of_month BETWEEN 1 AND 28),
  recipients   text[] NOT NULL DEFAULT '{}',
  enabled      boolean NOT NULL DEFAULT true,
  -- The window that has already been sent, so a worker that runs twice, or a
  -- second worker on another node, does not send the same Monday twice.
  last_period  text,
  last_run_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX report_schedules_due_idx ON report_schedules (tenant_id) WHERE enabled;

-- ── What was sent ────────────────────────────────────────────────────────────
--
-- Not the report's contents: those are reproducible by running it again, and
-- keeping a copy of every row of every export would be a second database of
-- the first one. Just enough to answer "did Monday's go out, and to whom".

CREATE TABLE report_runs (
  id           bigserial PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  report_id    uuid REFERENCES reports(id) ON DELETE SET NULL,
  schedule_id  uuid REFERENCES report_schedules(id) ON DELETE SET NULL,
  period       text,
  rows_out     integer NOT NULL DEFAULT 0,
  recipients   text[] NOT NULL DEFAULT '{}',
  status       text NOT NULL DEFAULT 'sent',
  error        text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX report_runs_tenant_idx ON report_runs (tenant_id, created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- 0019 — who did that
--
-- Everything the platform allows is allowed by holding a secret key, and every
-- key can do everything. That is fine for one person running one store. It
-- stops being fine the moment a second person has the key, which is the moment
-- "who adjusted this balance" becomes a question nobody can answer — and the
-- moment a support contractor needs to look things up without also being able
-- to erase a customer or issue themselves a key.
--
-- No login is added here. The platform is API-first with WordPress as its front
-- end, and inventing a session layer nobody asked for would be the wrong
-- feature. What is added is the two things that were actually missing: a key
-- can be attributed to a named person and limited to a role, and every
-- privileged action is recorded.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE operators (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email       text NOT NULL,
  name        text NOT NULL DEFAULT '',
  -- owner    — everything, including keys and operators
  -- manager  — everything operational: points, rules, badges, sends, erasure
  -- support  — read everything, adjust points, nothing destructive or outbound
  -- readonly — read
  role        text NOT NULL DEFAULT 'support'
              CHECK (role IN ('owner', 'manager', 'support', 'readonly')),
  disabled_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX operators_tenant_email_idx ON operators (tenant_id, lower(email));

-- A key belongs to a person, and may be narrower than that person.
--
-- Both nullable, and that is the compatibility story: every key issued before
-- this migration has neither, reads as `owner`, and keeps doing exactly what it
-- did. A retailer opts into narrower keys when they want them.
ALTER TABLE tenant_keys ADD COLUMN operator_id uuid REFERENCES operators(id) ON DELETE SET NULL;
ALTER TABLE tenant_keys ADD COLUMN role text
  CHECK (role IS NULL OR role IN ('owner', 'manager', 'support', 'readonly'));

-- ── The record ───────────────────────────────────────────────────────────────
--
-- Append-only, like the points ledger and for the same reason: a log somebody
-- can edit answers no question worth asking. There is deliberately no update or
-- delete path in the service above this.

CREATE TABLE audit_log (
  id           bigserial PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- Who. The operator when the key names one; the key id either way, so an
  -- action is always attributable to at least the credential that took it.
  operator_id  uuid REFERENCES operators(id) ON DELETE SET NULL,
  key_id       text,
  actor_label  text NOT NULL DEFAULT '',
  role         text,

  -- What. `action` is method + path, e.g. 'POST /v1/rewards/adjust'.
  action       text NOT NULL,
  status       integer NOT NULL,
  target       text,

  -- Enough of the request to answer "what did they change", and deliberately
  -- not the whole body: an audit log that copies every field becomes a second
  -- store of the personal data the first one is careful about.
  detail       jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip_hash      text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_log_tenant_idx ON audit_log (tenant_id, created_at DESC);
CREATE INDEX audit_log_operator_idx ON audit_log (tenant_id, operator_id, created_at DESC)
  WHERE operator_id IS NOT NULL;
-- "Everything that touched this customer", which is the question support asks.
CREATE INDEX audit_log_target_idx ON audit_log (tenant_id, target, created_at DESC)
  WHERE target IS NOT NULL;

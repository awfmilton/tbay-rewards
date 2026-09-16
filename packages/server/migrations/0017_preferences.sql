-- ─────────────────────────────────────────────────────────────────────────────
-- 0017 — something to click other than "never again"
--
-- Unsubscribe is binary. Most people who click it do not want silence; they
-- want less, or they want the one thing they signed up for and not the other
-- three. Offered only the binary choice they take it, and a list loses
-- somebody who would have stayed on a monthly digest.
--
-- Two things make the middle ground real:
--
--   a pause, because "not right now" is the honest answer more often than
--   "never", and a recipient who can say it comes back;
--
--   per-topic choice, because a store sends order news, sale news and a blog
--   digest down one list, and somebody who wants two of the three currently
--   has to take all or none.
-- ─────────────────────────────────────────────────────────────────────────────

-- A pause is not an unsubscribe: consent is untouched, and it lifts by itself.
ALTER TABLE contacts ADD COLUMN marketing_paused_until timestamptz;

-- ── Topics ───────────────────────────────────────────────────────────────────
--
-- A retailer's own categories, not ours. A store that never defines one keeps
-- exactly today's behaviour: no topics, so nothing is filtered by topic.

CREATE TABLE email_topics (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key           text NOT NULL,
  name          text NOT NULL,
  description   text NOT NULL DEFAULT '',
  -- Shown on the preference page. A retailer may want a topic that exists for
  -- targeting but is not something a recipient picks.
  selectable    boolean NOT NULL DEFAULT true,
  -- Whether a recipient who has never expressed a view gets it. On for the
  -- ordinary case: a topic nobody has opted into yet should still send.
  default_on    boolean NOT NULL DEFAULT true,
  display_order integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, key)
);

-- Only rows where somebody actually chose. Absence means "has not said", which
-- `default_on` answers — storing a row per contact per topic up front would be
-- a table the size of contacts × topics that says nothing.
CREATE TABLE contact_topic_prefs (
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL,
  topic_key  text NOT NULL,
  subscribed boolean NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, contact_id, topic_key),
  FOREIGN KEY (contact_id, tenant_id) REFERENCES contacts (id, tenant_id) ON DELETE CASCADE
);

-- Which topic a message belongs to, so the preference can be honoured at send
-- time and a recipient can see what they are being asked about.
ALTER TABLE email_templates ADD COLUMN topic_key text;
ALTER TABLE broadcasts      ADD COLUMN topic_key text;

-- ── What the recipient did ───────────────────────────────────────────────────
--
-- A preference centre nobody measures is a preference centre nobody tunes. The
-- useful number is how many people chose *something other than* leaving, which
-- is the whole reason the page exists.

CREATE TABLE preference_changes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  contact_id  uuid NOT NULL,
  -- 'paused', 'resumed', 'topics', 'unsubscribed'
  action      text NOT NULL,
  detail      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (contact_id, tenant_id) REFERENCES contacts (id, tenant_id) ON DELETE CASCADE
);

CREATE INDEX preference_changes_tenant_idx ON preference_changes (tenant_id, created_at DESC);

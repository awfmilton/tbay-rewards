-- Count a session against a heatmap page once, properly.
--
-- `sample_sessions` was incremented only when the request carrying the samples
-- happened to be the session's first. The tracker flushes pointer samples on a
-- timer, so a visitor who reads for a few seconds before moving the mouse
-- sends their first batch on a later beat and was never counted at all -- the
-- screen then reports a heatmap built from "0 sessions" beside a full set of
-- cells. A heatmap drawn from three sessions and one drawn from three thousand
-- are different things, and the number is how a retailer tells them apart.
--
-- The session FK cascades, so the retention sweep already cleans this up.

CREATE TABLE IF NOT EXISTS heatmap_page_sessions (
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  page_key     text NOT NULL,
  device_class text NOT NULL,
  session_id   uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  counted_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, page_key, device_class, session_id)
);

CREATE INDEX IF NOT EXISTS heatmap_page_sessions_session_idx
  ON heatmap_page_sessions (session_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- 0011 — automation waits and branches
--
-- An automation was one trigger, an AND list of conditions, and a linear list
-- of actions, all run at once. So "send the cart email, wait a day, and if they
-- still have not bought, send another" was not expressible — which is exactly
-- why cart recovery is a hand-written worker with its stages in environment
-- variables. A welcome series, a post-purchase review request and a win-back
-- all have that same shape and none of them could be built.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE automation_runs
  -- 'waiting' is a run parked mid-sequence until resume_at. Every other status
  -- is terminal.
  DROP CONSTRAINT IF EXISTS automation_runs_status_check;

ALTER TABLE automation_runs
  ADD CONSTRAINT automation_runs_status_check
  CHECK (status IN ('running', 'waiting', 'completed', 'failed', 'skipped', 'cancelled'));

ALTER TABLE automation_runs
  -- Where execution resumes. An action list is a flat array, so a single index
  -- is the whole program counter.
  ADD COLUMN step_index   integer NOT NULL DEFAULT 0,
  ADD COLUMN resume_at    timestamptz,
  ADD COLUMN attempts     smallint NOT NULL DEFAULT 0,
  ADD COLUMN updated_at   timestamptz NOT NULL DEFAULT now();

-- Claiming due runs: the worker asks for waiting runs whose time has come, and
-- for running ones a previous pass left behind.
CREATE INDEX automation_runs_due_idx
  ON automation_runs (resume_at)
  WHERE status IN ('waiting', 'running');

CREATE INDEX automation_runs_contact_idx
  ON automation_runs (tenant_id, contact_id, created_at DESC);

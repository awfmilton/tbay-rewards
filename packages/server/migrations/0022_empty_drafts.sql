-- ─────────────────────────────────────────────────────────────────────────────
-- 0022 — a draft may be empty
--
-- 0021 required every broadcast to name a template or carry a composed body.
-- That is right for a send, and wrong for a draft: "create it, then write it"
-- is the whole point of composing on the send, and the row has to exist
-- between those two steps.
--
-- The workaround was worse than the constraint. wp-admin created such a draft
-- by sending an empty block list, which meant every later save from the
-- "prepare a send" form — the only screen that can change a draft's segment —
-- sent an empty list again and wiped whatever had been written in between.
--
-- So the invariant moves to where it is true: a draft may be empty, anything
-- armed or beyond must have a body. `startBroadcast` refuses to arm an empty
-- one, and this is the same rule stated where it cannot be bypassed.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE broadcasts DROP CONSTRAINT IF EXISTS broadcasts_body_present;

ALTER TABLE broadcasts ADD CONSTRAINT broadcasts_body_present
  CHECK (status = 'draft' OR template_key IS NOT NULL OR blocks IS NOT NULL);

-- 0021 asked for this index by a name 0009 had already used for a single-column
-- index on the same table, so `IF NOT EXISTS` matched the name and created
-- nothing. `membershipFor` filters by contact and joins segments, so the
-- composite index is the one that serves it; the single-column index stays for
-- everything that only knows the contact.
CREATE INDEX IF NOT EXISTS segment_members_contact_segment_idx
  ON segment_members (contact_id, segment_id);

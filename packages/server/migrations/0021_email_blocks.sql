-- ─────────────────────────────────────────────────────────────────────────────
-- 0021 — an email somebody can compose without writing HTML
--
-- Templates are hand-written HTML. That is fine for the eight built-ins, which
-- a developer wrote once, and wrong for the thing a retailer actually wants to
-- do weekly: put this month's three products in a message, with a button, and
-- send it. Today that means editing a <table> in a textarea, and the first
-- unclosed tag breaks the layout in Outlook only.
--
-- Blocks instead: a list of typed pieces with typed fields. The renderer emits
-- the HTML, so the admin never writes any — which is also the security
-- property. An HTML textarea in wp-admin is a stored XSS vector against the
-- next admin who opens the preview; a list of blocks with escaped values is
-- not, whatever anybody types into it.
--
-- `blocks` null means the template is still hand-written HTML. Every existing
-- template is, and keeps working untouched.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE email_templates ADD COLUMN blocks jsonb;
ALTER TABLE email_templates ADD COLUMN preheader text;

-- Broadcasts compose their own body rather than always naming a template: the
-- monthly newsletter is a one-off, and making a retailer create a template for
-- each one is how a "send" screen grows a "template" screen nobody wanted.
ALTER TABLE broadcasts ADD COLUMN blocks jsonb;

-- The line a mail client shows after the subject. Without one it shows the
-- first words of the body, which for a message that opens with an image is the
-- alt text, and for one that opens with a heading is the heading again.
ALTER TABLE broadcasts ADD COLUMN preheader text;

-- A broadcast that composes its own body names no template, so the column can
-- no longer be required. Exactly one of the two must be present, and saying so
-- here rather than in the service means a bad row cannot be written at all.
ALTER TABLE broadcasts ALTER COLUMN template_key DROP NOT NULL;
ALTER TABLE broadcasts ADD CONSTRAINT broadcasts_body_present
  CHECK (template_key IS NOT NULL OR blocks IS NOT NULL);

-- ── Dynamic content ──────────────────────────────────────────────────────────
--
-- A block may name a segment it is for, or one it is not for. That is what
-- makes one message serve two audiences — "here is your VIP early access"
-- above the same three products everybody gets — rather than sending two.
--
-- Segment membership is already materialised in `segment_members`, so the
-- per-recipient check is an index lookup rather than a filter re-run.
CREATE INDEX IF NOT EXISTS segment_members_contact_idx
  ON segment_members (contact_id, segment_id);

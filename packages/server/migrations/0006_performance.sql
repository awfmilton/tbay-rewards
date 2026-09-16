-- ─────────────────────────────────────────────────────────────────────────────
-- 0006 — indexes and retention the load review measured
--
-- A performance review seeded a scratch database (1M events, 300k sessions,
-- 300k ledger rows, 200k carts) and ran EXPLAIN (ANALYZE, BUFFERS) over every
-- query on the hot paths. Every index below replaces a confirmed sequential
-- scan, and every DROP removes a btree nothing reads.
--
-- These are written without CONCURRENTLY so they run inside the migration
-- transaction. On a large live database, create them concurrently by hand
-- first; the CREATE INDEX statements here become no-ops via IF NOT EXISTS.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Public endpoints that were scanning whole tables ─────────────────────────
-- /v1/identify calls linkVisitorToContact, which scanned all of carts inside a
-- transaction. /c/:token scanned carts for a recovery token. Both are reachable
-- with nothing but a site key.
CREATE INDEX IF NOT EXISTS carts_visitor_idx
  ON carts (visitor_id) WHERE visitor_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS carts_recovery_token_idx
  ON carts (recovery_token) WHERE recovery_token IS NOT NULL;

-- ── Inside the advisory lock on every points award ───────────────────────────
-- evaluateBadges measures referral_count for any badge that uses it, and was
-- scanning referrals while holding the per-(contact, rule) lock.
CREATE INDEX IF NOT EXISTS referrals_referrer_idx
  ON referrals (tenant_id, referrer_contact_id) WHERE status = 'qualified';

-- ── Share verification ───────────────────────────────────────────────────────
-- creditShareClick walked every pending share platform-wide and filtered by
-- link_id in the heap.
CREATE INDEX IF NOT EXISTS share_events_link_idx
  ON share_events (link_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS share_events_tenant_idx
  ON share_events (tenant_id, status);

-- ── Reports ──────────────────────────────────────────────────────────────────
-- points_ledger is append-only and grows forever; the only tenant-leading
-- index was partial on rule_key IS NOT NULL, so the dashboard scanned it whole.
CREATE INDEX IF NOT EXISTS points_ledger_tenant_time_idx
  ON points_ledger (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS contacts_tenant_created_idx
  ON contacts (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS carts_tenant_created_idx
  ON carts (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS commissions_tenant_time_idx
  ON commissions (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS token_claims_tenant_idx
  ON token_claims (tenant_id, status);

-- ── Background workers ───────────────────────────────────────────────────────
-- carts_recovery_idx leads with tenant_id, which dueForRecovery never filters
-- on, so it fell back to a scan.
CREATE INDEX IF NOT EXISTS carts_due_idx
  ON carts (abandoned_at, recovery_stage) WHERE status = 'abandoned';

-- ── Claim reconciliation starvation ──────────────────────────────────────────
-- reconcileClaims read `ORDER BY created_at LIMIT 100`. Because an expired
-- voucher stays claimable forever and is never refunded, expired rows
-- accumulate at the head of that order — once more than `limit` of them exist,
-- the sweep re-checks the same oldest hundred on every pass and no newer
-- voucher is ever reconciled. Ordering by when we last looked makes the sweep
-- rotate instead.
ALTER TABLE token_claims ADD COLUMN IF NOT EXISTS last_checked_at timestamptz;
CREATE INDEX IF NOT EXISTS token_claims_reconcile_idx
  ON token_claims (last_checked_at NULLS FIRST, created_at)
  WHERE status IN ('signed', 'expired');

-- ── Indexes with no reader ───────────────────────────────────────────────────
-- Each btree costs an insert and WAL on every row. Dropping these two measured
-- 483 -> 400 bytes of WAL per event (-17%) on the busiest table in the system.
DROP INDEX IF EXISTS events_tenant_time_idx;
DROP INDEX IF EXISTS events_product_idx;
DROP INDEX IF EXISTS sessions_source_idx;

-- ── Keep updates HOT ─────────────────────────────────────────────────────────
-- These tables are update-heavy and measured a 0% HOT ratio: every increment
-- wrote a new row version and left a dead tuple, because a full page has no
-- room for the new version on the same page. Leaving 30% free lets Postgres
-- update in place and skip the index maintenance entirely.
ALTER TABLE heatmap_cells   SET (fillfactor = 70, autovacuum_vacuum_scale_factor = 0.01);
ALTER TABLE heatmap_pages   SET (fillfactor = 70, autovacuum_vacuum_scale_factor = 0.01);
ALTER TABLE product_stats   SET (fillfactor = 70, autovacuum_vacuum_scale_factor = 0.02);
ALTER TABLE sessions        SET (fillfactor = 85);
ALTER TABLE visitors        SET (fillfactor = 85);
ALTER TABLE carts           SET (fillfactor = 85);
ALTER TABLE points_balances SET (fillfactor = 85);
ALTER TABLE links           SET (fillfactor = 85);

-- TBAY Rewards — baseline schema.
--
-- Everything customer-facing is tenant-scoped: a "tenant" is one retailer running
-- the platform. The only deliberately cross-tenant object is `members`, the global
-- identity a TBAY balance hangs off, because the token spends at any retailer on
-- the network.

-- ─────────────────────────────────────────────────────────────────────────────
-- Tenancy and credentials
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE tenants (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug            text NOT NULL UNIQUE,
  name            text NOT NULL,
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'closed')),
  timezone        text NOT NULL DEFAULT 'UTC',
  currency        char(3) NOT NULL DEFAULT 'USD',
  -- Per-tenant salt for hashing IPs and user agents. Never leaves the server.
  pii_salt        text NOT NULL,
  settings        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Public keys are embedded in the browser tracker and only authorise writes to
-- the ingest endpoints. Secret keys are server-to-server and are stored hashed.
CREATE TABLE tenant_keys (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind            text NOT NULL CHECK (kind IN ('public', 'secret')),
  key_id          text NOT NULL UNIQUE,
  secret_hash     text,
  label           text NOT NULL DEFAULT '',
  last_used_at    timestamptz,
  revoked_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tenant_keys_secret_required
    CHECK (kind = 'public' OR secret_hash IS NOT NULL)
);
CREATE INDEX tenant_keys_tenant_idx ON tenant_keys (tenant_id, kind) WHERE revoked_at IS NULL;

-- Origins allowed to post tracker events with the tenant's public key.
CREATE TABLE tenant_domains (
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  domain          text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, domain)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Global identity (cross-retailer, token-bearing)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE members (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Lowercased 0x address. A member may exist before connecting a wallet.
  wallet_address  text UNIQUE,
  -- SHA-256 of the normalised email, salted platform-wide, so the same person is
  -- recognised across retailers without storing a plaintext cross-tenant email.
  email_hash      text UNIQUE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Visitors, contacts, sessions
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE contacts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  member_id       uuid REFERENCES members(id) ON DELETE SET NULL,
  email           text,
  email_normalised text,
  name            text,
  phone           text,
  external_ref    text,
  locale          text,
  country         text,
  wallet_address  text,
  -- Blog writers / affiliates earn commission; flagged per tenant.
  is_writer       boolean NOT NULL DEFAULT false,
  marketing_consent boolean NOT NULL DEFAULT false,
  consent_source  text,
  consent_at      timestamptz,
  attributes      jsonb NOT NULL DEFAULT '{}'::jsonb,
  tags            text[] NOT NULL DEFAULT '{}',
  first_seen_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX contacts_tenant_email_idx ON contacts (tenant_id, email_normalised)
  WHERE email_normalised IS NOT NULL;
CREATE UNIQUE INDEX contacts_tenant_external_idx ON contacts (tenant_id, external_ref)
  WHERE external_ref IS NOT NULL;
CREATE INDEX contacts_member_idx ON contacts (member_id) WHERE member_id IS NOT NULL;
CREATE INDEX contacts_tenant_writer_idx ON contacts (tenant_id) WHERE is_writer;

CREATE TABLE visitors (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- Opaque id minted by the tracker and kept in first-party storage.
  anon_id         text NOT NULL,
  contact_id      uuid REFERENCES contacts(id) ON DELETE SET NULL,
  first_seen_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  session_count   integer NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, anon_id)
);
CREATE INDEX visitors_contact_idx ON visitors (contact_id) WHERE contact_id IS NOT NULL;

CREATE TABLE sessions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  visitor_id      uuid NOT NULL REFERENCES visitors(id) ON DELETE CASCADE,
  contact_id      uuid REFERENCES contacts(id) ON DELETE SET NULL,
  client_session_id text NOT NULL,
  started_at      timestamptz NOT NULL DEFAULT now(),
  last_event_at   timestamptz NOT NULL DEFAULT now(),
  ended_at        timestamptz,
  entry_path      text,
  exit_path       text,
  pageviews       integer NOT NULL DEFAULT 0,
  events          integer NOT NULL DEFAULT 0,
  referrer_url    text,
  referrer_host   text,
  source          text,
  medium          text,
  campaign        text,
  term            text,
  content         text,
  link_code       text,
  device_class    text CHECK (device_class IN ('desktop', 'tablet', 'mobile', 'bot', 'unknown')),
  os              text,
  browser         text,
  country         text,
  ip_hash         text,
  ua_hash         text,
  is_bot          boolean NOT NULL DEFAULT false,
  UNIQUE (tenant_id, client_session_id)
);
CREATE INDEX sessions_tenant_started_idx ON sessions (tenant_id, started_at DESC);
CREATE INDEX sessions_visitor_idx ON sessions (visitor_id, started_at DESC);
CREATE INDEX sessions_source_idx ON sessions (tenant_id, source, started_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- Raw events
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE events (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  session_id      uuid REFERENCES sessions(id) ON DELETE CASCADE,
  visitor_id      uuid REFERENCES visitors(id) ON DELETE CASCADE,
  contact_id      uuid REFERENCES contacts(id) ON DELETE SET NULL,
  type            text NOT NULL,
  path            text,
  url             text,
  product_ref     text,
  link_code       text,
  value_cents     bigint,
  currency        char(3),
  props           jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  received_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX events_tenant_time_idx ON events (tenant_id, occurred_at DESC);
CREATE INDEX events_tenant_type_time_idx ON events (tenant_id, type, occurred_at DESC);
CREATE INDEX events_session_idx ON events (session_id, occurred_at);
CREATE INDEX events_product_idx ON events (tenant_id, product_ref, occurred_at DESC)
  WHERE product_ref IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- Heatmaps (pre-aggregated; raw pointer samples are never persisted)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE heatmap_pages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  page_key        text NOT NULL,
  device_class    text NOT NULL,
  sample_sessions integer NOT NULL DEFAULT 0,
  sample_points   bigint NOT NULL DEFAULT 0,
  avg_doc_height  integer,
  avg_viewport_w  integer,
  last_sample_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, page_key, device_class)
);

-- x_bin/y_bin are percentages of page width/height (0-99 and 0-199), so the grid
-- is resolution independent and one page costs at most 20k rows per device class.
CREATE TABLE heatmap_cells (
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  page_key        text NOT NULL,
  device_class    text NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('click', 'move', 'scroll')),
  x_bin           smallint NOT NULL,
  y_bin           smallint NOT NULL,
  weight          bigint NOT NULL DEFAULT 0,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, page_key, device_class, kind, x_bin, y_bin)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Products and daily rollups
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE products (
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  product_ref     text NOT NULL,
  name            text,
  url             text,
  image_url       text,
  price_cents     bigint,
  currency        char(3),
  categories      text[] NOT NULL DEFAULT '{}',
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, product_ref)
);

CREATE TABLE product_stats (
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  product_ref     text NOT NULL,
  stat_date       date NOT NULL,
  views           bigint NOT NULL DEFAULT 0,
  clicks          bigint NOT NULL DEFAULT 0,
  add_to_carts    bigint NOT NULL DEFAULT 0,
  purchases       bigint NOT NULL DEFAULT 0,
  revenue_cents   bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, product_ref, stat_date)
);
CREATE INDEX product_stats_date_idx ON product_stats (tenant_id, stat_date DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- Acquisition / attribution
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE touchpoints (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  visitor_id      uuid NOT NULL REFERENCES visitors(id) ON DELETE CASCADE,
  session_id      uuid REFERENCES sessions(id) ON DELETE SET NULL,
  contact_id      uuid REFERENCES contacts(id) ON DELETE SET NULL,
  source          text NOT NULL,
  medium          text,
  campaign        text,
  term            text,
  content         text,
  referrer_url    text,
  referrer_host   text,
  landing_path    text,
  link_code       text,
  occurred_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX touchpoints_visitor_idx ON touchpoints (visitor_id, occurred_at);
CREATE INDEX touchpoints_tenant_time_idx ON touchpoints (tenant_id, occurred_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- Carts and orders
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE carts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  cart_token      text NOT NULL,
  visitor_id      uuid REFERENCES visitors(id) ON DELETE SET NULL,
  contact_id      uuid REFERENCES contacts(id) ON DELETE SET NULL,
  items           jsonb NOT NULL DEFAULT '[]'::jsonb,
  item_count      integer NOT NULL DEFAULT 0,
  subtotal_cents  bigint NOT NULL DEFAULT 0,
  currency        char(3) NOT NULL DEFAULT 'USD',
  checkout_url    text,
  status          text NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active', 'abandoned', 'recovered', 'converted', 'expired')),
  recovery_token  text NOT NULL,
  recovery_stage  smallint NOT NULL DEFAULT 0,
  last_recovery_at timestamptz,
  abandoned_at    timestamptz,
  recovered_at    timestamptz,
  converted_order_ref text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, cart_token)
);
CREATE INDEX carts_sweeper_idx ON carts (status, updated_at) WHERE status = 'active';
CREATE INDEX carts_recovery_idx ON carts (tenant_id, status, recovery_stage, last_recovery_at)
  WHERE status = 'abandoned';
CREATE INDEX carts_contact_idx ON carts (contact_id) WHERE contact_id IS NOT NULL;

CREATE TABLE orders (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  order_ref       text NOT NULL,
  contact_id      uuid REFERENCES contacts(id) ON DELETE SET NULL,
  visitor_id      uuid REFERENCES visitors(id) ON DELETE SET NULL,
  cart_id         uuid REFERENCES carts(id) ON DELETE SET NULL,
  total_cents     bigint NOT NULL DEFAULT 0,
  subtotal_cents  bigint NOT NULL DEFAULT 0,
  currency        char(3) NOT NULL DEFAULT 'USD',
  status          text NOT NULL DEFAULT 'pending',
  items           jsonb NOT NULL DEFAULT '[]'::jsonb,
  first_touch     jsonb,
  last_touch      jsonb,
  attributed_link_code text,
  placed_at       timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, order_ref)
);
CREATE INDEX orders_tenant_placed_idx ON orders (tenant_id, placed_at DESC);
CREATE INDEX orders_contact_idx ON orders (contact_id) WHERE contact_id IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- Trackable links and writer commissions
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE links (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code            text NOT NULL UNIQUE,
  kind            text NOT NULL DEFAULT 'campaign'
                  CHECK (kind IN ('campaign', 'writer', 'referral', 'share')),
  target_url      text NOT NULL,
  owner_contact_id uuid REFERENCES contacts(id) ON DELETE SET NULL,
  product_ref     text,
  post_ref        text,
  label           text,
  source          text,
  medium          text,
  campaign        text,
  commission_rate_bps integer NOT NULL DEFAULT 0 CHECK (commission_rate_bps BETWEEN 0 AND 10000),
  clicks          bigint NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  disabled_at     timestamptz
);
CREATE INDEX links_tenant_owner_idx ON links (tenant_id, owner_contact_id);
CREATE INDEX links_tenant_post_idx ON links (tenant_id, post_ref) WHERE post_ref IS NOT NULL;

CREATE TABLE link_clicks (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  link_id         uuid NOT NULL REFERENCES links(id) ON DELETE CASCADE,
  visitor_id      uuid REFERENCES visitors(id) ON DELETE SET NULL,
  click_uuid      uuid NOT NULL DEFAULT gen_random_uuid(),
  ip_hash         text,
  ua_hash         text,
  referrer_host   text,
  landing_url     text,
  country         text,
  is_bot          boolean NOT NULL DEFAULT false,
  occurred_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX link_clicks_link_time_idx ON link_clicks (link_id, occurred_at DESC);
CREATE INDEX link_clicks_tenant_time_idx ON link_clicks (tenant_id, occurred_at DESC);

CREATE TABLE commissions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  link_id         uuid REFERENCES links(id) ON DELETE SET NULL,
  owner_contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  order_ref       text NOT NULL,
  item_ref        text NOT NULL DEFAULT '',
  product_ref     text,
  subtotal_cents  bigint NOT NULL DEFAULT 0,
  rate_bps        integer NOT NULL DEFAULT 0,
  amount_cents    bigint NOT NULL DEFAULT 0,
  currency        char(3) NOT NULL DEFAULT 'USD',
  status          text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'approved', 'paid', 'void')),
  hold_until      timestamptz,
  payout_ref      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  approved_at     timestamptz,
  paid_at         timestamptz,
  voided_at       timestamptz,
  UNIQUE (tenant_id, order_ref, item_ref, owner_contact_id)
);
CREATE INDEX commissions_owner_idx ON commissions (owner_contact_id, status, created_at DESC);
CREATE INDEX commissions_release_idx ON commissions (status, hold_until) WHERE status = 'pending';

-- ─────────────────────────────────────────────────────────────────────────────
-- Newsletter and email
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE lists (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  slug            text NOT NULL,
  name            text NOT NULL,
  double_optin    boolean NOT NULL DEFAULT true,
  from_name       text,
  from_email      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, slug)
);

CREATE TABLE subscriptions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  list_id         uuid NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  contact_id      uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  status          text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'subscribed', 'unsubscribed', 'bounced', 'complained')),
  -- Opt-in and unsubscribe tokens are stored hashed; the plaintext only ever
  -- exists inside the confirmation email.
  confirm_token_hash text,
  unsub_token_hash   text,
  source          text,
  ip_hash         text,
  requested_at    timestamptz NOT NULL DEFAULT now(),
  confirmed_at    timestamptz,
  unsubscribed_at timestamptz,
  UNIQUE (list_id, contact_id)
);
CREATE INDEX subscriptions_tenant_status_idx ON subscriptions (tenant_id, status);
CREATE INDEX subscriptions_confirm_idx ON subscriptions (confirm_token_hash)
  WHERE confirm_token_hash IS NOT NULL;
CREATE INDEX subscriptions_unsub_idx ON subscriptions (unsub_token_hash)
  WHERE unsub_token_hash IS NOT NULL;

CREATE TABLE email_templates (
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key             text NOT NULL,
  subject         text NOT NULL,
  html            text NOT NULL,
  text            text,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, key)
);

CREATE TABLE email_messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  contact_id      uuid REFERENCES contacts(id) ON DELETE SET NULL,
  template_key    text NOT NULL,
  to_email        text NOT NULL,
  subject         text NOT NULL,
  html            text NOT NULL,
  text            text,
  -- Every send carries a dedupe key so a retried worker pass or a double webhook
  -- can never mail the same person twice for the same reason.
  dedupe_key      text NOT NULL,
  status          text NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued', 'sent', 'failed', 'skipped')),
  attempts        smallint NOT NULL DEFAULT 0,
  provider_id     text,
  error           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  sent_at         timestamptz,
  UNIQUE (tenant_id, dedupe_key)
);
CREATE INDEX email_messages_queue_idx ON email_messages (status, created_at) WHERE status = 'queued';

-- ─────────────────────────────────────────────────────────────────────────────
-- Automations (the Mautic campaign replacement)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE automations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key             text NOT NULL,
  name            text NOT NULL,
  trigger_type    text NOT NULL,
  trigger_config  jsonb NOT NULL DEFAULT '{}'::jsonb,
  conditions      jsonb NOT NULL DEFAULT '[]'::jsonb,
  actions         jsonb NOT NULL DEFAULT '[]'::jsonb,
  enabled         boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, key)
);
CREATE INDEX automations_trigger_idx ON automations (tenant_id, trigger_type) WHERE enabled;

CREATE TABLE automation_runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  automation_id   uuid NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  contact_id      uuid REFERENCES contacts(id) ON DELETE SET NULL,
  dedupe_key      text NOT NULL,
  status          text NOT NULL DEFAULT 'completed'
                  CHECK (status IN ('completed', 'failed', 'skipped')),
  context         jsonb NOT NULL DEFAULT '{}'::jsonb,
  error           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (automation_id, dedupe_key)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Rewards: rules, ledger, balances
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE reward_rules (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key             text NOT NULL,
  name            text NOT NULL,
  event_key       text NOT NULL,
  mode            text NOT NULL DEFAULT 'fixed' CHECK (mode IN ('fixed', 'per_currency_unit')),
  points          integer NOT NULL DEFAULT 0,
  points_per_unit numeric(12, 4) NOT NULL DEFAULT 0,
  cooldown_seconds integer NOT NULL DEFAULT 0,
  daily_cap       integer,
  lifetime_cap    integer,
  hold_seconds    integer NOT NULL DEFAULT 0,
  requires_verification boolean NOT NULL DEFAULT false,
  config          jsonb NOT NULL DEFAULT '{}'::jsonb,
  enabled         boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, key)
);
CREATE INDEX reward_rules_event_idx ON reward_rules (tenant_id, event_key) WHERE enabled;

-- Append-only. `points_balances` is a transactional cache derived from this.
CREATE TABLE points_ledger (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  contact_id      uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  delta_points    integer NOT NULL,
  reason          text NOT NULL,
  rule_key        text,
  ref_type        text,
  ref_id          text,
  -- Unique per tenant: the same share, order or redemption can never be booked twice.
  idempotency_key text NOT NULL,
  status          text NOT NULL DEFAULT 'cleared'
                  CHECK (status IN ('pending', 'cleared', 'reversed')),
  available_at    timestamptz NOT NULL DEFAULT now(),
  reversed_by     uuid REFERENCES points_ledger(id) ON DELETE SET NULL,
  meta            jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_key)
);
CREATE INDEX points_ledger_contact_idx ON points_ledger (contact_id, created_at DESC);
CREATE INDEX points_ledger_release_idx ON points_ledger (status, available_at) WHERE status = 'pending';
CREATE INDEX points_ledger_rule_window_idx ON points_ledger (tenant_id, contact_id, rule_key, created_at DESC)
  WHERE rule_key IS NOT NULL;

CREATE TABLE points_balances (
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  contact_id      uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  balance         integer NOT NULL DEFAULT 0,
  pending         integer NOT NULL DEFAULT 0,
  lifetime_earned integer NOT NULL DEFAULT 0,
  lifetime_spent  integer NOT NULL DEFAULT 0,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, contact_id),
  CONSTRAINT points_balances_non_negative CHECK (balance >= 0)
);

CREATE TABLE share_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  contact_id      uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  network         text NOT NULL,
  target_url      text NOT NULL,
  share_url       text,
  link_id         uuid REFERENCES links(id) ON DELETE SET NULL,
  -- Proof-of-share token embedded in the shared link; verification looks for a
  -- click arriving from the claimed network carrying this token.
  share_token     text NOT NULL,
  status          text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'verified', 'rejected', 'expired')),
  verified_clicks integer NOT NULL DEFAULT 0,
  points_awarded  integer NOT NULL DEFAULT 0,
  rejected_reason text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  verified_at     timestamptz,
  expires_at      timestamptz NOT NULL,
  UNIQUE (tenant_id, share_token)
);
CREATE INDEX share_events_contact_idx ON share_events (contact_id, created_at DESC);
CREATE INDEX share_events_pending_idx ON share_events (status, expires_at) WHERE status = 'pending';

CREATE TABLE referrals (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  referrer_contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  referee_contact_id  uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  link_id         uuid REFERENCES links(id) ON DELETE SET NULL,
  status          text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'qualified', 'rejected')),
  qualified_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, referee_contact_id),
  CONSTRAINT referrals_no_self CHECK (referrer_contact_id <> referee_contact_id)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- TBAY token: claims out of points, spends back into retailers
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE token_claims (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  contact_id      uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  member_id       uuid REFERENCES members(id) ON DELETE SET NULL,
  points_spent    integer NOT NULL CHECK (points_spent > 0),
  -- uint256 wei. numeric(78,0) covers the full solidity range.
  token_amount_wei numeric(78, 0) NOT NULL,
  chain_id        bigint NOT NULL,
  contract_address text NOT NULL,
  wallet_address  text NOT NULL,
  -- Matches the contract's global replay-protection nonce.
  nonce           numeric(78, 0) NOT NULL,
  signature       text NOT NULL,
  status          text NOT NULL DEFAULT 'signed'
                  CHECK (status IN ('signed', 'claimed', 'expired', 'cancelled')),
  ledger_entry_id uuid REFERENCES points_ledger(id) ON DELETE SET NULL,
  reversal_entry_id uuid REFERENCES points_ledger(id) ON DELETE SET NULL,
  tx_hash         text,
  expires_at      timestamptz NOT NULL,
  claimed_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (chain_id, contract_address, nonce)
);
CREATE INDEX token_claims_contact_idx ON token_claims (contact_id, created_at DESC);
CREATE INDEX token_claims_open_idx ON token_claims (status, expires_at) WHERE status = 'signed';
CREATE INDEX token_claims_wallet_idx ON token_claims (wallet_address, created_at DESC);

-- Rate-limit bookkeeping mirroring the contract's MAX_MINT_PER_WINDOW so the
-- platform never hands out a voucher the chain would reject.
CREATE TABLE token_mint_windows (
  chain_id        bigint NOT NULL,
  contract_address text NOT NULL,
  window_start    timestamptz NOT NULL,
  minted_wei      numeric(78, 0) NOT NULL DEFAULT 0,
  PRIMARY KEY (chain_id, contract_address, window_start)
);

CREATE TABLE token_spend_intents (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  contact_id      uuid REFERENCES contacts(id) ON DELETE SET NULL,
  member_id       uuid REFERENCES members(id) ON DELETE SET NULL,
  token_amount_wei numeric(78, 0) NOT NULL,
  from_address    text NOT NULL,
  to_address      text NOT NULL,
  chain_id        bigint NOT NULL,
  contract_address text NOT NULL,
  credit_cents    bigint NOT NULL,
  currency        char(3) NOT NULL DEFAULT 'USD',
  status          text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'verified', 'expired', 'cancelled')),
  tx_hash         text,
  verified_at     timestamptz,
  expires_at      timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (chain_id, tx_hash)
);
CREATE INDEX token_spend_open_idx ON token_spend_intents (status, expires_at) WHERE status = 'pending';

CREATE TABLE store_credits (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  contact_id      uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  code            text NOT NULL,
  amount_cents    bigint NOT NULL CHECK (amount_cents > 0),
  currency        char(3) NOT NULL DEFAULT 'USD',
  source          text NOT NULL DEFAULT 'token_spend',
  spend_intent_id uuid REFERENCES token_spend_intents(id) ON DELETE SET NULL,
  status          text NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active', 'redeemed', 'expired', 'void')),
  order_ref       text,
  expires_at      timestamptz,
  redeemed_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);
CREATE INDEX store_credits_contact_idx ON store_credits (contact_id, status);

-- ─────────────────────────────────────────────────────────────────────────────
-- Outbound webhooks back to the retailer's storefront
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE webhooks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  url             text NOT NULL,
  secret          text NOT NULL,
  topics          text[] NOT NULL DEFAULT '{}',
  enabled         boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE webhook_deliveries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  webhook_id      uuid NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  topic           text NOT NULL,
  payload         jsonb NOT NULL,
  status          text NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued', 'delivered', 'failed')),
  attempts        smallint NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  response_code   integer,
  error           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  delivered_at    timestamptz
);
CREATE INDEX webhook_deliveries_queue_idx ON webhook_deliveries (status, next_attempt_at)
  WHERE status = 'queued';

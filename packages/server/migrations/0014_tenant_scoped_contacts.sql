-- ─────────────────────────────────────────────────────────────────────────────
-- 0014 — a tenant's rows can only ever name that tenant's contacts
--
-- An adversarial review found that POST /v1/orders took `contactId` straight
-- from the request body and never checked it belonged to the calling tenant.
-- Retailer A could name retailer B's contact and have the whole order pipeline
-- — ledger, balances, badges, ranks, notifications — write rows under A's
-- tenant_id against a stranger, then read B's email and name back out of the
-- ledger endpoint.
--
-- The application now resolves that id against the tenant. This migration is
-- the reason it cannot come back: every foreign key below carries the tenant
-- alongside the contact, so the database itself rejects a cross-tenant row. A
-- future endpoint that forgets the check gets a constraint violation, not a
-- quiet corruption of the ledger.
--
-- Scoped to the tables where a cross-tenant row would mean money, a claim on
-- the retailer, or someone's personal data. The analytics tables (events,
-- sessions, visitors, touchpoints) are left alone: their contact_id is a
-- nullable convenience, and they are written a great deal.
-- ─────────────────────────────────────────────────────────────────────────────

-- The target of the composite keys below.
ALTER TABLE contacts ADD CONSTRAINT contacts_id_tenant_key UNIQUE (id, tenant_id);

-- Refuse to proceed over existing damage rather than deleting someone's ledger
-- history on their behalf. On a clean database this is a no-op; if it fires,
-- the rows it names are the ones a caller wrote across the boundary and an
-- operator decides what to do with them.
DO $$
DECLARE
  offending bigint;
BEGIN
  SELECT count(*) INTO offending
    FROM points_ledger l
    JOIN contacts c ON c.id = l.contact_id
   WHERE c.tenant_id <> l.tenant_id;

  IF offending > 0 THEN
    RAISE EXCEPTION
      'Found % points_ledger row(s) whose contact belongs to another tenant. '
      'These predate the cross-tenant fix and must be reviewed before this '
      'migration can add the constraint that prevents them.', offending;
  END IF;
END $$;

-- MATCH SIMPLE, which is the default: where contact_id is nullable and NULL,
-- the constraint is simply not checked, which is the behaviour we want.
ALTER TABLE points_ledger
  ADD CONSTRAINT points_ledger_contact_tenant_fkey
  FOREIGN KEY (contact_id, tenant_id) REFERENCES contacts (id, tenant_id) ON DELETE CASCADE;

ALTER TABLE points_balances
  ADD CONSTRAINT points_balances_contact_tenant_fkey
  FOREIGN KEY (contact_id, tenant_id) REFERENCES contacts (id, tenant_id) ON DELETE CASCADE;

ALTER TABLE badge_awards
  ADD CONSTRAINT badge_awards_contact_tenant_fkey
  FOREIGN KEY (contact_id, tenant_id) REFERENCES contacts (id, tenant_id) ON DELETE CASCADE;

ALTER TABLE rank_awards
  ADD CONSTRAINT rank_awards_contact_tenant_fkey
  FOREIGN KEY (contact_id, tenant_id) REFERENCES contacts (id, tenant_id) ON DELETE CASCADE;

ALTER TABLE notifications
  ADD CONSTRAINT notifications_contact_tenant_fkey
  FOREIGN KEY (contact_id, tenant_id) REFERENCES contacts (id, tenant_id) ON DELETE CASCADE;

ALTER TABLE coupon_redemptions
  ADD CONSTRAINT coupon_redemptions_contact_tenant_fkey
  FOREIGN KEY (contact_id, tenant_id) REFERENCES contacts (id, tenant_id) ON DELETE CASCADE;

ALTER TABLE content_unlocks
  ADD CONSTRAINT content_unlocks_contact_tenant_fkey
  FOREIGN KEY (contact_id, tenant_id) REFERENCES contacts (id, tenant_id) ON DELETE CASCADE;

ALTER TABLE store_credits
  ADD CONSTRAINT store_credits_contact_tenant_fkey
  FOREIGN KEY (contact_id, tenant_id) REFERENCES contacts (id, tenant_id) ON DELETE CASCADE;

ALTER TABLE streaks
  ADD CONSTRAINT streaks_contact_tenant_fkey
  FOREIGN KEY (contact_id, tenant_id) REFERENCES contacts (id, tenant_id) ON DELETE CASCADE;

ALTER TABLE share_events
  ADD CONSTRAINT share_events_contact_tenant_fkey
  FOREIGN KEY (contact_id, tenant_id) REFERENCES contacts (id, tenant_id) ON DELETE CASCADE;

ALTER TABLE token_claims
  ADD CONSTRAINT token_claims_contact_tenant_fkey
  FOREIGN KEY (contact_id, tenant_id) REFERENCES contacts (id, tenant_id) ON DELETE CASCADE;

ALTER TABLE subscriptions
  ADD CONSTRAINT subscriptions_contact_tenant_fkey
  FOREIGN KEY (contact_id, tenant_id) REFERENCES contacts (id, tenant_id) ON DELETE CASCADE;

ALTER TABLE orders
  ADD CONSTRAINT orders_contact_tenant_fkey
  FOREIGN KEY (contact_id, tenant_id) REFERENCES contacts (id, tenant_id) ON DELETE SET NULL;

ALTER TABLE carts
  ADD CONSTRAINT carts_contact_tenant_fkey
  FOREIGN KEY (contact_id, tenant_id) REFERENCES contacts (id, tenant_id) ON DELETE SET NULL;

-- Both ends of a transfer, so points cannot be sent across a tenant boundary.
ALTER TABLE point_transfers
  ADD CONSTRAINT point_transfers_from_tenant_fkey
  FOREIGN KEY (from_contact_id, tenant_id) REFERENCES contacts (id, tenant_id) ON DELETE CASCADE;

ALTER TABLE point_transfers
  ADD CONSTRAINT point_transfers_to_tenant_fkey
  FOREIGN KEY (to_contact_id, tenant_id) REFERENCES contacts (id, tenant_id) ON DELETE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- Roles are an array or they are nothing
--
-- The same review found that the public /v1/identify and
-- /v1/newsletter/subscribe endpoints — which need only the site key that is in
-- every page's source — could write any JSON at all into attributes.roles.
--
--   roles: []     → an excluded staff account starts earning again
--   roles: "x"    → jsonb_array_elements_text raises, so every reward trigger
--                   for that contact throws, taking the enclosing order
--                   transaction down with it, and the tenant's whole
--                   leaderboard 500s
--
-- The endpoints no longer accept reserved keys. This is the other half: any
-- roles value that is not an array reads as no roles at all, so a bad value
-- can never again turn into an exception in the middle of someone's checkout.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION contact_roles(attributes jsonb)
RETURNS jsonb
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE
           WHEN jsonb_typeof(attributes -> 'roles') = 'array' THEN attributes -> 'roles'
           ELSE '[]'::jsonb
         END
$$;

-- Wallet ownership challenges.
--
-- Binding a wallet to an account used to be an unauthenticated assertion: any
-- member could claim any address. That was enough to hijack someone else's
-- bridge withdrawal, because the withdrawal path trusted the stored address.
-- A wallet is now only bound after the holder signs a server-issued challenge.

CREATE TABLE wallet_challenges (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  contact_id      uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  wallet_address  text NOT NULL,
  nonce           text NOT NULL UNIQUE,
  -- Single use: consumed the moment a valid signature is accepted.
  consumed_at     timestamptz,
  expires_at      timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX wallet_challenges_open_idx ON wallet_challenges (contact_id, expires_at)
  WHERE consumed_at IS NULL;

-- Records that the address was proved, not merely claimed. Reporting and the
-- bridge both check this rather than trusting contacts.wallet_address alone.
ALTER TABLE contacts ADD COLUMN wallet_verified_at timestamptz;

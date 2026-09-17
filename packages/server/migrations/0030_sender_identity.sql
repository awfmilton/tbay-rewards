-- ─────────────────────────────────────────────────────────────────────────────
-- 0030 — store the sender identity the queue was already computing
--
-- Five senders (newsletter, automations, broadcasts, cart recovery, and the
-- confirmation path) each spread `...senderFor(tenant)` into their queueEmail
-- input, and `queueEmail`'s INSERT named eleven columns, none of which was a
-- sender. So the value was computed at every call site and dropped on the
-- floor, and the transport -- which reads `message.fromName ?? config` from
-- the row it claimed -- fell through to the platform default for every tenant.
--
-- The effect is invisible on a queue screen and fatal for deliverability: a
-- retailer configures `fromEmail: hello@theirshop.ca`, their SPF and DKIM are
-- aligned for it, and every message still leaves as the platform address,
-- failing DMARC alignment at the recipient.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE email_messages
  -- NULL means "whatever the platform default is at send time", which is the
  -- behaviour every row written before this migration actually got.
  ADD COLUMN from_name text,
  ADD COLUMN from_address text;

import { db, queryOne, withTransaction, type Queryable } from '../db/pool.js';
import { identityHash, normaliseEmail } from '../lib/crypto.js';
import { ApiError } from '../lib/errors.js';

export interface Contact {
  id: string;
  tenant_id: string;
  member_id: string | null;
  email: string | null;
  email_normalised: string | null;
  name: string | null;
  phone: string | null;
  external_ref: string | null;
  locale: string | null;
  country: string | null;
  wallet_address: string | null;
  is_writer: boolean;
  marketing_consent: boolean;
  attributes: Record<string, unknown>;
  tags: string[];
  first_seen_at: Date;
  last_seen_at: Date;
  /** Set once a person has been erased; every identifier above is then null. */
  erased_at: Date | null;
}

export interface ContactInput {
  email?: string | null;
  name?: string | null;
  phone?: string | null;
  externalRef?: string | null;
  locale?: string | null;
  country?: string | null;
  walletAddress?: string | null;
  attributes?: Record<string, unknown>;
  tags?: string[];
  marketingConsent?: boolean;
  consentSource?: string | null;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function isValidEmail(email: string): boolean {
  return EMAIL_PATTERN.test(email) && email.length <= 254;
}

/**
 * Find or create the global member for an email and/or wallet.
 *
 * A member is the cross-retailer identity that a TBAY balance belongs to. We key
 * on a salted hash of the email so the platform can recognise the same person at
 * retailer B without retailer A's plaintext address ever being shared.
 */
export async function upsertMember(
  runner: Queryable,
  opts: { email?: string | null; walletAddress?: string | null },
): Promise<string | null> {
  const emailHash = opts.email ? identityHash(opts.email) : null;
  const wallet = opts.walletAddress ? opts.walletAddress.toLowerCase() : null;
  if (!emailHash && !wallet) return null;

  // Prefer an existing wallet match: a connected wallet is the stronger claim.
  if (wallet) {
    const byWallet = await queryOne<{ id: string; email_hash: string | null }>(
      runner,
      'SELECT id, email_hash FROM members WHERE wallet_address = $1',
      [wallet],
    );
    if (byWallet) {
      if (emailHash && !byWallet.email_hash) {
        await runner.query(
          `UPDATE members SET email_hash = $2, updated_at = now()
            WHERE id = $1 AND email_hash IS NULL`,
          [byWallet.id, emailHash],
        );
      }
      return byWallet.id;
    }
  }

  if (emailHash) {
    const byEmail = await queryOne<{ id: string; wallet_address: string | null }>(
      runner,
      'SELECT id, wallet_address FROM members WHERE email_hash = $1',
      [emailHash],
    );
    if (byEmail) {
      if (wallet && !byEmail.wallet_address) {
        await runner.query(
          `UPDATE members SET wallet_address = $2, updated_at = now()
            WHERE id = $1 AND wallet_address IS NULL`,
          [byEmail.id, wallet],
        );
      }
      return byEmail.id;
    }
  }

  const created = await queryOne<{ id: string }>(
    runner,
    `INSERT INTO members (wallet_address, email_hash) VALUES ($1, $2)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [wallet, emailHash],
  );
  if (created) return created.id;

  // Lost a race; re-read whichever key we have.
  const existing = await queryOne<{ id: string }>(
    runner,
    `SELECT id FROM members
      WHERE ($1::text IS NOT NULL AND wallet_address = $1)
         OR ($2::text IS NOT NULL AND email_hash = $2)
      LIMIT 1`,
    [wallet, emailHash],
  );
  return existing?.id ?? null;
}

/**
 * Create or merge a tenant-scoped contact. Matching is by email first, then by
 * the retailer's own external reference (e.g. a WordPress user id).
 */
export interface UpsertOptions {
  /**
   * Allow this call to REPLACE an identity key (email or external ref) that is
   * already set to a different value.
   *
   * Off by default, and the public ingest path must never turn it on. With it
   * off, an attacker who knows one identity key cannot rewrite the other and
   * take over the account: supplying {email: attacker, externalRef: victim}
   * is rejected instead of silently moving the victim's contact — and their
   * points balance — onto the attacker's email.
   *
   * Server-to-server callers holding the tenant's own secret key may opt in, so
   * a customer legitimately changing their email address still works.
   */
  allowIdentityChange?: boolean;

  /**
   * Fill in what is missing; never overwrite what is there.
   *
   * For the public site key, which is embedded in every page and therefore
   * held by anyone who can view source. Without this, knowing a customer's
   * email address was enough to rewrite their name, phone, locale and country
   * on the retailer's own records, and — worse — to add tags and attributes to
   * them. Tags drive segments, segments drive broadcasts and the visibility of
   * conditional email blocks, so tag injection is a way to put yourself, or
   * somebody else, into a campaign.
   *
   * A first login filling in a name the store does not have yet is the case
   * this path exists for, and it still works. Overwriting a name the store
   * already has is not something a page script should be able to do.
   *
   * Tags and attributes are ignored entirely on an existing contact rather than
   * merged: "add-only" still lets anything be added.
   */
  fillOnly?: boolean;
}

export async function upsertContact(
  tenantId: string,
  input: ContactInput,
  runner?: Queryable,
  options: UpsertOptions = {},
): Promise<Contact> {
  const run = async (client: Queryable): Promise<Contact> => {
    const email = input.email ? normaliseEmail(input.email) : null;
    if (email && !isValidEmail(email)) throw ApiError.badRequest('Invalid email address');

    const wallet = input.walletAddress ? input.walletAddress.toLowerCase() : null;
    const memberId = await upsertMember(client, { email, walletAddress: wallet });

    let existing: Contact | null = null;
    if (email) {
      existing = await queryOne<Contact>(
        client,
        'SELECT * FROM contacts WHERE tenant_id = $1 AND email_normalised = $2',
        [tenantId, email],
      );
    }
    if (!existing && input.externalRef) {
      existing = await queryOne<Contact>(
        client,
        'SELECT * FROM contacts WHERE tenant_id = $1 AND external_ref = $2',
        [tenantId, input.externalRef],
      );
    }

    if (existing && !options.allowIdentityChange) {
      assertIdentityUnchanged(existing, { email, externalRef: input.externalRef ?? null });
    }

    // An erased person stays erased.
    //
    // Erasure strips the address off the contact row, so nothing above finds
    // them and the next identify or import would create a *new* contact with
    // the same address — silently undoing an erasure the retailer is on record
    // as having carried out. The hash is the only way to recognise an address
    // we must refuse without keeping the address.
    //
    // Refused, not ignored: a caller that keeps sending this person's data
    // should be told, and quietly discarding writes is how an integration
    // develops a mystery.
    if (!existing && email) {
      // The same digest `hashPii` computes, evaluated in the database so the
      // tenant's salt never has to be fetched into the process for a check
      // that runs on every new contact. Postgres's built-in sha256 — no
      // extension, and verified byte for byte against the TypeScript.
      const { rows } = await client.query(
        `SELECT 1 FROM contacts c
           JOIN tenants t ON t.id = c.tenant_id
          WHERE c.tenant_id = $1
            AND c.erased_email_hash = left(
                  encode(sha256(convert_to(t.pii_salt || ':' || $2, 'UTF8')), 'hex'), 32)
          LIMIT 1`,
        [tenantId, email],
      );
      if (rows.length > 0) {
        throw ApiError.unprocessable(
          'That person asked to be erased from this store and cannot be re-added',
          { code: 'erased' },
        );
      }
    }

    if (existing) {
      const updated = await queryOne<Contact>(
        client,
        // $15 is `fillOnly`: the caller may fill a blank but not change a
        // value. See UpsertOptions for why the public site key gets that and
        // nothing more.
        `UPDATE contacts SET
            email             = COALESCE($2, email),
            email_normalised  = COALESCE($3, email_normalised),
            name              = CASE WHEN $15 THEN COALESCE(name, $4)
                                     ELSE COALESCE($4, name) END,
            phone             = CASE WHEN $15 THEN COALESCE(phone, $5)
                                     ELSE COALESCE($5, phone) END,
            external_ref      = COALESCE($6, external_ref),
            locale            = CASE WHEN $15 THEN COALESCE(locale, $7)
                                     ELSE COALESCE($7, locale) END,
            country           = CASE WHEN $15 THEN COALESCE(country, $8)
                                     ELSE COALESCE($8, country) END,
            wallet_address    = CASE WHEN $15 THEN COALESCE(wallet_address, $9)
                                     ELSE COALESCE($9, wallet_address) END,
            member_id         = COALESCE(member_id, $10),
            attributes        = CASE WHEN $15 THEN attributes
                                     ELSE attributes || $11::jsonb END,
            tags              = CASE WHEN $15 THEN tags ELSE (
              SELECT COALESCE(array_agg(DISTINCT tag), '{}')
                FROM unnest(tags || $12::text[]) AS tag
            ) END,
            marketing_consent = COALESCE($13, marketing_consent),
            consent_source    = COALESCE($14, consent_source),
            consent_at        = CASE WHEN $13 IS TRUE AND NOT marketing_consent
                                     THEN now() ELSE consent_at END,
            last_seen_at      = now(),
            updated_at        = now()
          WHERE id = $1
          RETURNING *`,
        [
          existing.id,
          input.email ?? null,
          email,
          input.name ?? null,
          input.phone ?? null,
          input.externalRef ?? null,
          input.locale ?? null,
          input.country ?? null,
          wallet,
          memberId,
          JSON.stringify(input.attributes ?? {}),
          input.tags ?? [],
          input.marketingConsent ?? null,
          input.consentSource ?? null,
          options.fillOnly ?? false,
        ],
      );
      return updated!;
    }

    const created = await queryOne<Contact>(
      client,
      `INSERT INTO contacts (
         tenant_id, member_id, email, email_normalised, name, phone, external_ref,
         locale, country, wallet_address, attributes, tags, marketing_consent,
         consent_source, consent_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::text[], $13, $14,
         CASE WHEN $13 IS TRUE THEN now() ELSE NULL END
       )
       RETURNING *`,
      [
        tenantId,
        memberId,
        input.email ?? null,
        email,
        input.name ?? null,
        input.phone ?? null,
        input.externalRef ?? null,
        input.locale ?? null,
        input.country ?? null,
        wallet,
        JSON.stringify(input.attributes ?? {}),
        input.tags ?? [],
        input.marketingConsent ?? false,
        input.consentSource ?? null,
      ],
    );
    return created!;
  };

  return runner ? run(runner) : withTransaction(run);
}

/**
 * Refuse to move a contact onto a different email or external reference.
 *
 * Filling in a key that is currently empty is fine and expected — that is how
 * an anonymous newsletter subscriber later gains a WordPress user id. Replacing
 * a key that is already set to something else is an identity takeover.
 */
function assertIdentityUnchanged(
  existing: Contact,
  incoming: { email: string | null; externalRef: string | null },
): void {
  if (
    incoming.email &&
    existing.email_normalised &&
    existing.email_normalised !== incoming.email
  ) {
    throw ApiError.conflict(
      'That reference already belongs to a different email address',
      { field: 'email' },
    );
  }

  if (
    incoming.externalRef &&
    existing.external_ref &&
    existing.external_ref !== incoming.externalRef
  ) {
    throw ApiError.conflict(
      'That email address already belongs to a different account',
      { field: 'externalRef' },
    );
  }
}

/**
 * Takes an optional runner so callers inside a transaction see their own
 * uncommitted writes — a contact created and awarded in one transaction would
 * otherwise read back as null from a separate pool connection.
 */
export async function getContact(
  tenantId: string,
  contactId: string,
  runner: Queryable = db(),
): Promise<Contact | null> {
  return queryOne<Contact>(runner, 'SELECT * FROM contacts WHERE tenant_id = $1 AND id = $2', [
    tenantId,
    contactId,
  ]);
}

export async function findContactByEmail(
  tenantId: string,
  email: string,
  runner: Queryable = db(),
): Promise<Contact | null> {
  return queryOne<Contact>(
    runner,
    'SELECT * FROM contacts WHERE tenant_id = $1 AND email_normalised = $2',
    [tenantId, normaliseEmail(email)],
  );
}

/**
 * Resolve the contact a caller means from any of the accepted handles.
 * Throws rather than silently creating when nothing identifies a person.
 */
export async function requireContact(
  tenantId: string,
  handles: { contactId?: string | null; email?: string | null; externalRef?: string | null },
): Promise<Contact> {
  if (handles.contactId) {
    const byId = await getContact(tenantId, handles.contactId);
    if (byId) return byId;
  }
  if (handles.email) {
    const byEmail = await findContactByEmail(tenantId, handles.email);
    if (byEmail) return byEmail;
  }
  if (handles.externalRef) {
    const byRef = await queryOne<Contact>(
      db(),
      'SELECT * FROM contacts WHERE tenant_id = $1 AND external_ref = $2',
      [tenantId, handles.externalRef],
    );
    if (byRef) return byRef;
  }
  throw ApiError.notFound('No matching contact');
}

/**
 * Record that one member brought another in.
 *
 * Called when a new contact is created during a session that arrived on a
 * referral link. Without this the referrals table stays empty, which in turn
 * means the referral reward and the Connector badge can never be earned.
 */
export async function recordReferral(
  runner: Queryable,
  tenantId: string,
  referrerContactId: string,
  refereeContactId: string,
  linkId: string | null,
): Promise<boolean> {
  if (referrerContactId === refereeContactId) return false;

  const row = await queryOne<{ id: string }>(
    runner,
    `INSERT INTO referrals (tenant_id, referrer_contact_id, referee_contact_id, link_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (tenant_id, referee_contact_id) DO NOTHING
     RETURNING id`,
    [tenantId, referrerContactId, refereeContactId, linkId],
  );
  return row !== null;
}

export async function setWallet(
  tenantId: string,
  contactId: string,
  walletAddress: string,
): Promise<Contact> {
  const wallet = walletAddress.toLowerCase();
  return withTransaction(async (client) => {
    const contact = await queryOne<Contact>(
      client,
      'SELECT * FROM contacts WHERE tenant_id = $1 AND id = $2 FOR UPDATE',
      [tenantId, contactId],
    );
    if (!contact) throw ApiError.notFound('Contact not found');

    const memberId =
      (await upsertMember(client, { email: contact.email_normalised, walletAddress: wallet })) ??
      contact.member_id;

    const updated = await queryOne<Contact>(
      client,
      `UPDATE contacts SET wallet_address = $3, member_id = COALESCE($4, member_id), updated_at = now()
        WHERE tenant_id = $1 AND id = $2 RETURNING *`,
      [tenantId, contactId, wallet, memberId],
    );
    return updated!;
  });
}

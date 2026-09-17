import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1

/** URL-safe random token, e.g. for opt-in and recovery links. */
export function randomToken(bytes = 24): string {
  return randomBytes(bytes).toString('base64url');
}

/** Short human-typable code for trackable links and store credits. */
export function randomCode(length = 8): string {
  const buf = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += CODE_ALPHABET[buf[i]! % CODE_ALPHABET.length];
  }
  return out;
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Hash a bearer token before storing it, so a database leak yields nothing usable. */
export function hashToken(token: string): string {
  return createHmac('sha256', config().security.tokenSecret).update(token).digest('hex');
}

/**
 * A wallet address in a form the database cannot turn back into a wallet.
 *
 * Keyed with TOKEN_SECRET rather than the tenant's `pii_salt`, and that is the
 * whole point. `pii_salt` is a column in the same database as
 * `members.wallet_address`, which is a *small* table holding every wallet the
 * platform knows -- so an adversary at the database, which is the adversary
 * this exists for, reads the salt, hashes five thousand candidate wallets and
 * matches the digest in a tenth of a millisecond. Measured. There is no
 * 160-bit space to search when the answers are sitting in the next table.
 *
 * The tenant id is still mixed in, so the same wallet at two retailers gives
 * two digests and the erasure does not create a cross-retailer join of its
 * own. Within one retailer it is deliberately stable: settling a transfer by
 * hand means comparing a candidate address against it.
 */
export function walletDigest(address: string, tenantId: string): string {
  return createHmac('sha256', config().security.tokenSecret)
    .update(`wallet:${tenantId}:${address.trim().toLowerCase()}`)
    .digest('hex')
    .slice(0, 32);
}

/**
 * Hash PII (IP, user agent) with a per-tenant salt. Lets us count uniques and
 * detect abuse without ever storing the raw value.
 */
export function hashPii(value: string, tenantSalt: string): string {
  return createHash('sha256').update(`${tenantSalt}:${value}`).digest('hex').slice(0, 32);
}

/**
 * Platform-wide identity hash. Deliberately *not* tenant-salted: recognising the
 * same person across retailers is what makes one TBAY balance possible.
 */
export function identityHash(email: string): string {
  return createHash('sha256')
    .update(`${config().security.identitySalt}:${normaliseEmail(email)}`)
    .digest('hex');
}

export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** `payload.signature` envelope used for attribution cookies. */
export function signPayload(payload: object): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', config().security.tokenSecret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifyPayload<T = Record<string, unknown>>(signed: string): T | null {
  const dot = signed.lastIndexOf('.');
  if (dot <= 0) return null;
  const body = signed.slice(0, dot);
  const sig = signed.slice(dot + 1);
  const expected = createHmac('sha256', config().security.tokenSecret)
    .update(body)
    .digest('base64url');
  if (!constantTimeEqual(sig, expected)) return null;
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T;
  } catch {
    return null;
  }
}

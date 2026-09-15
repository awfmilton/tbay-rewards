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

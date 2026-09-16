/**
 * Clamping numbers that end up inside a SQL string.
 *
 * `LIMIT` and `OFFSET` cannot be bound parameters in every position we use
 * them, so they are interpolated. That is safe only while the value is
 * guaranteed to be a plain integer, and `Number(x)` alone does not guarantee
 * it: `Number('1.5')` is 1.5 and `Number('abc')` is NaN, both of which produce
 * invalid SQL and a 500 from what should be a 400 — or nothing at all, which
 * is worse, because a silently-wrong limit reads as missing data.
 *
 * There is no injection here — `Number()` cannot yield letters or quotes — but
 * "not injectable" is a lower bar than "correct", and one helper is easier to
 * audit than six hand-written clamps.
 */

export function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  // `Number('')`, `Number(null)` and `Number([])` are all 0, so an absent or
  // empty query parameter would otherwise clamp to the minimum rather than
  // falling back — `?limit=` would silently mean "one row".
  const supplied =
    typeof value === 'number'
      ? Number.isFinite(value)
      : typeof value === 'string' && value.trim() !== '';

  const parsed = supplied ? Math.trunc(Number(value)) : Number.NaN;

  if (!Number.isFinite(parsed)) {
    const safe = Math.trunc(Number(fallback));
    return Number.isFinite(safe) ? Math.min(Math.max(safe, min), max) : min;
  }
  if (parsed < min) return min;
  if (parsed > max) return max;
  return parsed;
}

/** A row limit: at least 1, never more than `max`. */
export function limitOf(value: unknown, fallback: number, max: number): number {
  return clampInt(value, fallback, 1, max);
}

/** An offset: never negative, and bounded so a huge page cannot be requested. */
export function offsetOf(value: unknown, max = 1_000_000): number {
  return clampInt(value, 0, 0, max);
}

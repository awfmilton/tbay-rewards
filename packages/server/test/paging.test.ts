import { describe, it, expect } from 'vitest';
import { clampInt, limitOf, offsetOf } from '../src/lib/paging.js';

describe('clamping numbers that go into SQL', () => {
  it('turns anything unusable into the fallback', () => {
    for (const junk of ['abc', '', null, undefined, NaN, {}, [], 'Infinity']) {
      expect(limitOf(junk, 50, 1000)).toBe(50);
      expect(offsetOf(junk)).toBe(0);
    }
  });

  it('always yields an integer', () => {
    // LIMIT 1.5 is invalid SQL and turns a bad query param into a 500.
    expect(limitOf('1.5', 50, 1000)).toBe(1);
    expect(offsetOf('7.9')).toBe(7);
    expect(Number.isInteger(limitOf('1e99', 50, 1000))).toBe(true);
  });

  it('clamps rather than trusting the caller', () => {
    expect(limitOf('999999', 50, 1000)).toBe(1000);
    expect(limitOf('-10', 50, 1000)).toBe(1);
    expect(offsetOf('-1')).toBe(0);
    expect(offsetOf('1e99')).toBe(1_000_000);
  });

  it('cannot be made to produce anything but digits', () => {
    // The whole reason interpolating these is acceptable.
    for (const attack of ["1; DROP TABLE contacts", "1 UNION SELECT", "0x41", "1'"]) {
      expect(String(limitOf(attack, 50, 1000))).toMatch(/^\d+$/);
      expect(String(offsetOf(attack))).toMatch(/^\d+$/);
    }
  });

  it('falls back safely even when the fallback itself is junk', () => {
    expect(clampInt('abc', NaN, 1, 100)).toBe(1);
  });
});

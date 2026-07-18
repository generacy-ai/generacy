import { describe, it, expect } from 'vitest';
import { calculateBackoffDelay } from '../../src/calculate-backoff-delay.js';

describe('calculateBackoffDelay', () => {
  it('T1: attempt=0 with random()=>0 returns exactly base/2 (2500)', () => {
    expect(
      calculateBackoffDelay(0, { base: 5000, cap: 30000, random: () => 0 }),
    ).toBe(2500);
  });

  it('T2: attempt=0 with random()=>0.9999 approaches base (< 5000, > 4999)', () => {
    const result = calculateBackoffDelay(0, {
      base: 5000,
      cap: 30000,
      random: () => 0.9999,
    });
    expect(result).toBeLessThan(5000);
    expect(result).toBeGreaterThan(4999);
  });

  it('T3: attempt=3 with random()=>0 returns cap/2 (15000) — raw=40000 capped', () => {
    expect(
      calculateBackoffDelay(3, { base: 5000, cap: 30000, random: () => 0 }),
    ).toBe(15000);
  });

  it('T4: attempt=3 with random()=>0.9999 approaches cap (< 30000, > 29999)', () => {
    const result = calculateBackoffDelay(3, {
      base: 5000,
      cap: 30000,
      random: () => 0.9999,
    });
    expect(result).toBeLessThan(30000);
    expect(result).toBeGreaterThan(29998);
  });

  it('T5: attempt=10 with random()=>0.5 returns exactly 22500 at saturated ladder', () => {
    expect(
      calculateBackoffDelay(10, {
        base: 5000,
        cap: 30000,
        random: () => 0.5,
      }),
    ).toBe(22500);
  });

  it('T6 (SC-004): same attempt with different random values yields distinct results', () => {
    const a = calculateBackoffDelay(3, {
      base: 5000,
      cap: 30000,
      random: () => 0.1,
    });
    const b = calculateBackoffDelay(3, {
      base: 5000,
      cap: 30000,
      random: () => 0.9,
    });
    expect(a).not.toBe(b);
  });

  it('T7: attempt=-1 throws RangeError', () => {
    expect(() =>
      calculateBackoffDelay(-1, { base: 5000, cap: 30000 }),
    ).toThrow(RangeError);
  });

  it('T7: attempt=NaN throws RangeError', () => {
    expect(() =>
      calculateBackoffDelay(Number.NaN, { base: 5000, cap: 30000 }),
    ).toThrow(RangeError);
  });

  it('T8: base=0 throws RangeError', () => {
    expect(() =>
      calculateBackoffDelay(0, { base: 0, cap: 30000 }),
    ).toThrow(RangeError);
  });

  it('T9: cap < base throws RangeError', () => {
    expect(() =>
      calculateBackoffDelay(0, { base: 5000, cap: 1000 }),
    ).toThrow(RangeError);
  });

  it('T10: attempt=2 with random()=>0.5 returns exactly 15000 (mid-ladder, not yet capped)', () => {
    expect(
      calculateBackoffDelay(2, {
        base: 5000,
        cap: 30000,
        random: () => 0.5,
      }),
    ).toBe(15000);
  });
});

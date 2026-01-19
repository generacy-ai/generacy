import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  calculateExpiration,
  calculateRemainingTtl,
  isExpired,
  ttlToSeconds,
  remainingTtlToSeconds,
  parseTtl,
  formatTtl,
} from '../../src/utils/ttl.js';
import { DEFAULT_TTL } from '../../src/types/messages.js';

describe('calculateExpiration', () => {
  it('calculates expiration timestamp', () => {
    const createdAt = 1000;
    const ttl = 5000;
    expect(calculateExpiration(createdAt, ttl)).toBe(6000);
  });

  it('uses default TTL when not provided', () => {
    const createdAt = 1000;
    expect(calculateExpiration(createdAt)).toBe(createdAt + DEFAULT_TTL);
  });
});

describe('calculateRemainingTtl', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('calculates remaining time', () => {
    vi.setSystemTime(5000);
    const createdAt = 1000;
    const ttl = 10000;
    expect(calculateRemainingTtl(createdAt, ttl)).toBe(6000);
  });

  it('returns 0 when expired', () => {
    vi.setSystemTime(15000);
    const createdAt = 1000;
    const ttl = 10000;
    expect(calculateRemainingTtl(createdAt, ttl)).toBe(0);
  });

  it('uses default TTL when not provided', () => {
    vi.setSystemTime(1000);
    const createdAt = 500;
    expect(calculateRemainingTtl(createdAt)).toBe(DEFAULT_TTL - 500);
  });
});

describe('isExpired', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns false when not expired', () => {
    vi.setSystemTime(5000);
    expect(isExpired(1000, 10000)).toBe(false);
  });

  it('returns true when expired', () => {
    vi.setSystemTime(15000);
    expect(isExpired(1000, 10000)).toBe(true);
  });

  it('returns true when exactly at expiration', () => {
    vi.setSystemTime(11001);
    expect(isExpired(1000, 10000)).toBe(true);
  });
});

describe('ttlToSeconds', () => {
  it('converts milliseconds to seconds (ceiling)', () => {
    expect(ttlToSeconds(1000)).toBe(1);
    expect(ttlToSeconds(1500)).toBe(2);
    expect(ttlToSeconds(2000)).toBe(2);
    expect(ttlToSeconds(500)).toBe(1);
  });
});

describe('remainingTtlToSeconds', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('calculates remaining TTL in seconds', () => {
    vi.setSystemTime(5000);
    expect(remainingTtlToSeconds(1000, 10000)).toBe(6);
  });

  it('returns 0 when expired', () => {
    vi.setSystemTime(15000);
    expect(remainingTtlToSeconds(1000, 10000)).toBe(0);
  });
});

describe('parseTtl', () => {
  it('parses milliseconds', () => {
    expect(parseTtl('100ms')).toBe(100);
    expect(parseTtl('5000ms')).toBe(5000);
  });

  it('parses seconds', () => {
    expect(parseTtl('10s')).toBe(10000);
    expect(parseTtl('1s')).toBe(1000);
  });

  it('parses minutes', () => {
    expect(parseTtl('5m')).toBe(300000);
    expect(parseTtl('1m')).toBe(60000);
  });

  it('parses hours', () => {
    expect(parseTtl('1h')).toBe(3600000);
    expect(parseTtl('2h')).toBe(7200000);
  });

  it('parses days', () => {
    expect(parseTtl('1d')).toBe(86400000);
    expect(parseTtl('7d')).toBe(604800000);
  });

  it('throws on invalid format', () => {
    expect(() => parseTtl('invalid')).toThrow('Invalid TTL format');
    expect(() => parseTtl('10')).toThrow('Invalid TTL format');
    expect(() => parseTtl('10x')).toThrow('Invalid TTL format');
    expect(() => parseTtl('')).toThrow('Invalid TTL format');
  });
});

describe('formatTtl', () => {
  it('formats milliseconds', () => {
    expect(formatTtl(500)).toBe('500ms');
    expect(formatTtl(999)).toBe('999ms');
  });

  it('formats seconds', () => {
    expect(formatTtl(1000)).toBe('1s');
    expect(formatTtl(30000)).toBe('30s');
    expect(formatTtl(59000)).toBe('59s');
  });

  it('formats minutes', () => {
    expect(formatTtl(60000)).toBe('1m');
    expect(formatTtl(300000)).toBe('5m');
    expect(formatTtl(3540000)).toBe('59m');
  });

  it('formats hours', () => {
    expect(formatTtl(3600000)).toBe('1h');
    expect(formatTtl(7200000)).toBe('2h');
    expect(formatTtl(82800000)).toBe('23h');
  });

  it('formats days', () => {
    expect(formatTtl(86400000)).toBe('1d');
    expect(formatTtl(604800000)).toBe('7d');
  });
});

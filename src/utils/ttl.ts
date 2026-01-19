/**
 * TTL (Time-To-Live) calculation helpers.
 */

import { DEFAULT_TTL } from '../types/messages.js';

/** Calculates the expiration timestamp from creation time and TTL */
export function calculateExpiration(createdAt: number, ttl: number = DEFAULT_TTL): number {
  return createdAt + ttl;
}

/** Calculates remaining TTL from creation time */
export function calculateRemainingTtl(createdAt: number, ttl: number = DEFAULT_TTL): number {
  const remaining = (createdAt + ttl) - Date.now();
  return Math.max(0, remaining);
}

/** Checks if a timestamp has expired */
export function isExpired(createdAt: number, ttl: number = DEFAULT_TTL): boolean {
  return Date.now() > createdAt + ttl;
}

/** Calculates TTL in seconds (for Redis EXPIRE command) */
export function ttlToSeconds(ttlMs: number): number {
  return Math.ceil(ttlMs / 1000);
}

/** Calculates TTL in seconds from remaining time */
export function remainingTtlToSeconds(createdAt: number, ttl: number = DEFAULT_TTL): number {
  const remaining = calculateRemainingTtl(createdAt, ttl);
  return Math.ceil(remaining / 1000);
}

/** Parses a human-readable TTL string (e.g., "1h", "30m", "5s") to milliseconds */
export function parseTtl(input: string): number {
  const match = input.match(/^(\d+)(ms|s|m|h|d)$/);
  if (!match) {
    throw new Error(`Invalid TTL format: "${input}". Expected format: <number><unit> (ms, s, m, h, d)`);
  }

  const value = parseInt(match[1]!, 10);
  const unit = match[2]!;

  switch (unit) {
    case 'ms':
      return value;
    case 's':
      return value * 1000;
    case 'm':
      return value * 60 * 1000;
    case 'h':
      return value * 60 * 60 * 1000;
    case 'd':
      return value * 24 * 60 * 60 * 1000;
    default:
      throw new Error(`Unknown TTL unit: ${unit}`);
  }
}

/** Formats milliseconds to a human-readable TTL string */
export function formatTtl(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60 * 1000) return `${Math.round(ms / 1000)}s`;
  if (ms < 60 * 60 * 1000) return `${Math.round(ms / (60 * 1000))}m`;
  if (ms < 24 * 60 * 60 * 1000) return `${Math.round(ms / (60 * 60 * 1000))}h`;
  return `${Math.round(ms / (24 * 60 * 60 * 1000))}d`;
}

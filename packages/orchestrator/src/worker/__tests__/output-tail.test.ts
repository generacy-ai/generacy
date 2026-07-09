import { describe, it, expect } from 'vitest';
import { Buffer } from 'node:buffer';
import { boundOutputTail } from '../output-tail.js';

const MAX_BYTES = 4096;
const MARKER_PREFIX = '… truncated (kept last ';

describe('boundOutputTail', () => {
  it('returns the literal for an empty string', () => {
    expect(boundOutputTail('')).toBe('(no output on either stream)');
  });

  it('returns short input unchanged with no marker', () => {
    const raw = 'line 1\nline 2\nline 3';
    const result = boundOutputTail(raw);
    expect(result).toBe(raw);
    expect(result.startsWith(MARKER_PREFIX)).toBe(false);
  });

  it('returns exactly 30 short lines unchanged with no marker', () => {
    const raw = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n');
    expect(Buffer.byteLength(raw, 'utf8')).toBeLessThanOrEqual(MAX_BYTES);
    const result = boundOutputTail(raw);
    expect(result).toBe(raw);
    expect(result.startsWith(MARKER_PREFIX)).toBe(false);
  });

  it('slices to last 30 lines when > 30 lines but tail is still ≤ 4 KiB', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`);
    const raw = lines.join('\n');
    const expected = lines.slice(-30).join('\n');
    expect(Buffer.byteLength(expected, 'utf8')).toBeLessThanOrEqual(MAX_BYTES);
    const result = boundOutputTail(raw);
    expect(result).toBe(expected);
    expect(result.startsWith(MARKER_PREFIX)).toBe(false);
  });

  it('prepends marker and caps body ≤ 4096 bytes when tail exceeds 4 KiB', () => {
    // Each line ~500 bytes; 30 of them ≈ 15000 bytes → forces byte-cap.
    const bigLine = 'x'.repeat(500);
    const lines = Array.from({ length: 100 }, () => bigLine);
    const raw = lines.join('\n');
    const result = boundOutputTail(raw);
    expect(result.startsWith(MARKER_PREFIX)).toBe(true);
    const newlineIdx = result.indexOf('\n');
    const body = result.slice(newlineIdx + 1);
    expect(Buffer.byteLength(body, 'utf8')).toBeLessThanOrEqual(MAX_BYTES);
  });

  it('holds ≤ ~4200 bytes for a 100 MB synthetic output (SC-004)', () => {
    // 100 MB of ~1000-byte lines → 100_000 lines. Each line is well above the
    // per-line budget of 4096/30 ≈ 136 bytes so the last-30 slice forces the
    // byte-cap path.
    const line = 'a'.repeat(999);
    const raw = new Array(100_000).fill(line).join('\n');
    expect(raw.length).toBeGreaterThanOrEqual(90 * 1024 * 1024);
    const result = boundOutputTail(raw);
    expect(Buffer.byteLength(result, 'utf8')).toBeLessThanOrEqual(4200);
    expect(result.startsWith(MARKER_PREFIX)).toBe(true);
  });

  it('produces decodable UTF-8 when multi-byte content sits near the cut point', () => {
    // 2000 lines of a mixed-byte word so the cut lands mid-line and possibly mid-codepoint.
    const line = 'héllo wörld 🚀 ';
    const raw = new Array(2000).fill(line.repeat(20)).join('\n');
    const result = boundOutputTail(raw);
    // Round-trip through Buffer to detect any invalid UTF-8 (Node's utf8 decoder
    // replaces bad bytes with U+FFFD; we assert the string round-trips cleanly).
    const roundTrip = Buffer.from(result, 'utf8').toString('utf8');
    expect(roundTrip).toBe(result);
    expect(result.startsWith(MARKER_PREFIX)).toBe(true);
  });
});

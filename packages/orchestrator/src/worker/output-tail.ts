import { Buffer } from 'node:buffer';

const MAX_BYTES = 4096;
const LAST_N_LINES = 30;
const EMPTY_LITERAL = '(no output on either stream)';

/**
 * Bound a raw merged stdout+stderr string into a compact tail suitable for a GitHub comment.
 *
 * Contract (see specs/890-found-during-cockpit-v1/data-model.md):
 * - Empty input → literal `(no output on either stream)`.
 * - Non-empty ≤ 4096 bytes after taking the last 30 lines → returned unchanged.
 * - Non-empty > 4096 bytes → truncate-from-start of the last-30-lines slice to
 *   4096 bytes; prepend `… truncated (kept last <N> lines / 4096 bytes) …\n`
 *   where `<N>` is the line count of the returned (post-cap) slice.
 * - Holds ≤ ~4200 bytes for any input up to 100 MB.
 */
export function boundOutputTail(raw: string): string {
  if (raw.length === 0) return EMPTY_LITERAL;

  const lines = raw.split('\n');
  const last30 = lines.slice(-LAST_N_LINES).join('\n');

  if (Buffer.byteLength(last30, 'utf8') <= MAX_BYTES) {
    return last30;
  }

  const buf = Buffer.from(last30, 'utf8');
  const trimmedBuf = buf.subarray(buf.length - MAX_BYTES);
  const trimmed = trimmedBuf.toString('utf8');
  const keptLines = trimmed.split('\n').length;
  const marker = `… truncated (kept last ${keptLines} lines / ${MAX_BYTES} bytes) …`;
  return `${marker}\n${trimmed}`;
}

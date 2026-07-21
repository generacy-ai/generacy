/**
 * Parse and format the `<!-- cockpit:claim v1 -->` marker used for the
 * active-driver claim (#1015). See contracts/claim-marker.md.
 *
 * The comment body is fixed-shape:
 *
 *     <!-- cockpit:claim v1 -->
 *     ```json
 *     { ...ClaimPayload... }
 *     ```
 *
 * A comment matches the marker iff its body (rtrim'd) STARTS WITH the exact
 * prefix, contains a ```json fenced block whose contents parse and validate
 * against `ClaimPayloadSchema`. Any failure → treated as not-a-marker (parse
 * returns `null`); malformed-prefix-matched bodies are candidates for
 * best-effort cleanup by the caller.
 */
import { ClaimPayloadSchema, type ClaimPayload } from './payload.js';

export const MARKER_PREFIX = '<!-- cockpit:claim v1 -->';

const FENCE_REGEX = /```json\n([\s\S]*?)\n```/;

export function formatMarker(payload: ClaimPayload): string {
  const json = JSON.stringify(payload, null, 2);
  return `${MARKER_PREFIX}\n\`\`\`json\n${json}\n\`\`\``;
}

export function parseMarker(body: string): ClaimPayload | null {
  const trimmed = body.replace(/[\s﻿\xA0]+$/, '');
  if (!trimmed.startsWith(MARKER_PREFIX)) return null;
  const fenceMatch = FENCE_REGEX.exec(trimmed);
  if (fenceMatch === null || fenceMatch[1] === undefined) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fenceMatch[1]);
  } catch {
    return null;
  }
  const shape = ClaimPayloadSchema.safeParse(parsed);
  if (!shape.success) return null;
  return shape.data;
}

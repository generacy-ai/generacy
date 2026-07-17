/**
 * #942: Failure fingerprint primitive.
 *
 * `computeFailureFingerprint({ phase, evidence })` returns a stable
 * 16-char lowercase hex sha256 prefix that is byte-identical across worker
 * invocations for the same underlying defect (same phase + classifier +
 * reason text). It is the load-bearing invariant for repeat-failure detection.
 *
 * `parseFailureAlertMarker(commentBody)` reads line 1 of a previously-posted
 * failure-alert comment and returns the fingerprint + occurrence when the v2
 * sibling marker (`<!-- fp:HEX:N -->`) is present, or `null` when it's absent
 * (v1 / pre-#942 comments). Never throws.
 */

import { createHash } from 'node:crypto';
import type { CommandExitEvidence, FailureFingerprint, WorkflowPhase } from './types.js';
import { FAILURE_ALERT_MARKER_V2_REGEX } from './types.js';

/** Q3→A: escalate on the 2nd same-fingerprint failure. */
export const REPEAT_FAILURE_THRESHOLD = 2;

/** Q1→B: hex prefix length. 16 chars = 64 bits — sufficient for per-issue scan. */
export const FINGERPRINT_HEX_LENGTH = 16;

/** Extraction patterns for the classifier substring inside `evidence.exitDescriptor`. */
const POST_EXIT_REGEX = /^failed post-exit: ([^ ]+) \(process exit \d+\)$/;
const KILLED_REGEX = /^killed \(SIGTERM\) after \d+ms$/;
const ABORTED_REGEX = /^aborted$/;
const EXIT_N_REGEX = /^exit (\d+)$/;

/**
 * Extract the classifier substring per contract §Semantics step 1.
 *
 * Defensive fallback (F-1): if none of the four patterns match, return the
 * literal `exitDescriptor` string so the fingerprint is still deterministic.
 */
function extractClassifier(exitDescriptor: string): string {
  const postExitMatch = POST_EXIT_REGEX.exec(exitDescriptor);
  if (postExitMatch) return postExitMatch[1]!;
  if (KILLED_REGEX.test(exitDescriptor)) return 'timeout';
  if (ABORTED_REGEX.test(exitDescriptor)) return 'aborted';
  const exitNMatch = EXIT_N_REGEX.exec(exitDescriptor);
  if (exitNMatch) return `exit-${exitNMatch[1]}`;
  return exitDescriptor;
}

export interface FailureFingerprintInput {
  phase: WorkflowPhase | string;
  evidence: CommandExitEvidence;
}

/**
 * Compute the fingerprint per contract §Semantics.
 *
 * `sha256(phase + '\x00' + classifier + '\x00' + reasonText).slice(0, 16)`
 * — hex, lowercase. Null-byte joiner prevents field-boundary collisions.
 */
export function computeFailureFingerprint(
  input: FailureFingerprintInput,
): FailureFingerprint {
  const classifier = extractClassifier(input.evidence.exitDescriptor);
  const reasonText = input.evidence.reason ?? input.evidence.outputTail;
  const material = `${input.phase}\x00${classifier}\x00${reasonText}`;
  return createHash('sha256')
    .update(material)
    .digest('hex')
    .slice(0, FINGERPRINT_HEX_LENGTH);
}

export interface ParsedFailureAlertMarker {
  fingerprint: FailureFingerprint;
  occurrence: number;
}

/**
 * Parse the v2 marker on line 1 of a failure-alert comment body.
 *
 * Returns `null` for v1 (pre-#942) comments, malformed markers, or bodies
 * where line 1 does not contain the v2 sibling marker. Never throws.
 */
export function parseFailureAlertMarker(
  commentBody: string,
): ParsedFailureAlertMarker | null {
  const firstLine = commentBody.split('\n', 1)[0] ?? '';
  const match = FAILURE_ALERT_MARKER_V2_REGEX.exec(firstLine);
  if (!match) return null;
  const occurrence = Number.parseInt(match[2]!, 10);
  if (!Number.isFinite(occurrence)) return null;
  return { fingerprint: match[1]!, occurrence };
}

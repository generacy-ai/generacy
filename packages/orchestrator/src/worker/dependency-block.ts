/**
 * Dependency-block helpers for the implement-phase blocked branch (#1211).
 *
 * Pure functions (no I/O): ref grammar parser, marker comment format/parse,
 * cycle counting from comment lists, and comment body builders.
 *
 * Markers follow the codebase HTML-comment convention — newest instance wins.
 * Contract: {@link specs/1211-problem-clarify-phase-answer/contracts/dependency-block-comments.md}
 */
import type { Comment } from '@generacy-ai/workflow-engine';
import type { Logger } from './types.js';

// =============================================================================
// Ref grammar (§3 / research.md D-9)
// =============================================================================

/** Normalized dependency reference. */
export interface DependencyRef {
  owner: string;
  repo: string;
  number: number;
}

const CANONICAL_REF_RE = /^([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)#(\d+)$/;
const SHORT_REF_RE = /^#(\d+)$/;
const BARE_NUMBER_RE = /^(\d+)$/;

/**
 * Parse raw agent-emitted refs into validated canonical refs.
 * Shorthand forms (`#N`, bare `N`) resolve against the blocked issue's repo.
 * Invalid entries are dropped with a `logger.warn`; the caller checks whether
 * at least one valid ref remains to decide whether to proceed.
 */
export function parseDependencyRefs(
  raw: string[],
  defaultOwner: string,
  defaultRepo: string,
  logger?: Logger,
): { valid: DependencyRef[]; invalid: string[] } {
  const valid: DependencyRef[] = [];
  const invalid: string[] = [];

  for (const entry of raw) {
    const trimmed = entry.trim();

    let match: RegExpMatchArray | null;
    let candidate: DependencyRef | null = null;

    match = CANONICAL_REF_RE.exec(trimmed);
    if (match) {
      candidate = { owner: match[1]!, repo: match[2]!, number: Number(match[3]) };
    } else {
      match = SHORT_REF_RE.exec(trimmed) ?? BARE_NUMBER_RE.exec(trimmed);
      if (match) {
        candidate = { owner: defaultOwner, repo: defaultRepo, number: Number(match[1]) };
      }
    }

    // Contract §1 ref grammar: `number` must be a positive integer. `#0` / `0`
    // match the shape but can never name a real issue.
    if (candidate && candidate.number > 0) {
      valid.push(candidate);
      continue;
    }

    invalid.push(entry);
    logger?.warn({ entry, defaultOwner, defaultRepo }, 'Dependency ref failed grammar validation — dropped');
  }

  return { valid, invalid };
}

/** Format a normalized ref back to canonical string form. */
export function formatCanonicalRef(ref: DependencyRef): string {
  return `${ref.owner}/${ref.repo}#${ref.number}`;
}

// =============================================================================
// Marker constants (§4 / contracts/dependency-block-comments.md)
// =============================================================================

const MARKER_BLOCK = '<!-- generacy-dependency-block -->';
const MARKER_LIMIT = '<!-- generacy-dependency-limit -->';
const MARKER_ERROR = '<!-- generacy-dependency-block-error -->';

/** JSON marker key — the `on` field in the fenced block. Internal to this file. */
// no-op — markers are the public API

// =============================================================================
// Marker comment format/parse
// =============================================================================

/**
 * Extract the canonical refs from a block marker comment's fenced JSON.
 * Returns `null` if the comment body does not contain a valid block marker
 * with a parseable `on` array.
 */
export function parseBlockCommentRefs(body: string): string[] | null {
  if (!body.startsWith(MARKER_BLOCK)) return null;

  // Find the fenced JSON block
  const fenceStart = body.indexOf('```json\n');
  if (fenceStart === -1) return null;

  const jsonStart = fenceStart + '```json\n'.length;
  const fenceEnd = body.indexOf('\n```', jsonStart);
  if (fenceEnd === -1) return null;

  const jsonStr = body.slice(jsonStart, fenceEnd);
  try {
    const parsed = JSON.parse(jsonStr) as { on?: unknown };
    if (Array.isArray(parsed.on) && parsed.on.length > 0 && parsed.on.every(e => typeof e === 'string')) {
      return parsed.on as string[];
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Find the newest comment whose body starts with the given marker.
 * Returns `undefined` if no comment matches.
 */
export function findNewestCommentWithMarker(
  comments: Comment[],
  marker: string,
): Comment | undefined {
  const sorted = [...comments].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );
  return sorted.find(c => c.body?.startsWith(marker));
}

/** Find the newest block marker comment. */
export function findNewestBlockComment(comments: Comment[]): Comment | undefined {
  return findNewestCommentWithMarker(comments, MARKER_BLOCK);
}

/** Find the newest limit marker comment. */
export function findNewestLimitComment(comments: Comment[]): Comment | undefined {
  return findNewestCommentWithMarker(comments, MARKER_LIMIT);
}

/** Find the newest error marker comment. */
export function findNewestErrorComment(comments: Comment[]): Comment | undefined {
  return findNewestCommentWithMarker(comments, MARKER_ERROR);
}

// =============================================================================
// Cycle counting (research.md D-4)
// =============================================================================

/**
 * Count dependency-block cycles: the number of block comments newer than the
 * newest limit comment (or all block comments if no limit comment exists).
 *
 * At count ≥ N (N=3), the blocked branch escalates to `waiting-for:dependency-limit`
 * instead of re-pausing with `waiting-for:dependencies`.
 */
export function countDependencyBlockCycles(
  comments: Comment[],
  maxCycles: number = 3,
): { count: number; atCap: boolean } {
  const blockComments = comments.filter(c => c.body?.startsWith(MARKER_BLOCK));
  const newestLimit = findNewestLimitComment(comments);

  let relevantBlocks = blockComments;
  if (newestLimit) {
    const limitTime = new Date(newestLimit.created_at).getTime();
    relevantBlocks = blockComments.filter(c => new Date(c.created_at).getTime() > limitTime);
  }

  const count = relevantBlocks.length;
  return { count, atCap: count >= maxCycles };
}

// =============================================================================
// Comment body builders (§4 contracts)
// =============================================================================

/**
 * Build the body of a dependency-block marker comment.
 * Canonical refs are formatted via {@link formatCanonicalRef}.
 */
export function buildBlockComment(refs: DependencyRef[]): string {
  const refList = refs.map(r => formatCanonicalRef(r));
  return [
    MARKER_BLOCK,
    '**Implementation paused — waiting on dependencies**',
    '',
    'This issue\'s implement phase is blocked until the following are closed:',
    '',
    '```json',
    JSON.stringify({ on: refList }),
    '```',
    '',
    'The engine will resume automatically when all references above are closed.',
  ].join('\n');
}

/**
 * Build the body of a dependency-limit comment.
 * Posted when the cycle cap is reached.
 */
export function buildLimitComment(openRefs: DependencyRef[]): string {
  const refLines = openRefs.map(r => `- ${formatCanonicalRef(r)}`);
  return [
    MARKER_LIMIT,
    '**Dependency-block limit reached (3 cycles)**',
    '',
    'Still open:',
    ...refLines,
    '',
    'Add `completed:dependency-limit` to this issue (or `cockpit advance --gate dependency-limit`) to grant another round of block cycles.',
  ].join('\n');
}

/**
 * Build the body of a re-arm comment. Flags not-planned and unmerged-PR closes
 * per Q3=C.
 */
export function buildReArmComment(
  results: Array<{ ref: DependencyRef; state: 'closed'; stateReason: string | null; merged: boolean | null }>,
): string {
  const lines = results.map(r => {
    const refStr = formatCanonicalRef(r.ref);
    if (r.stateReason === 'not_planned') {
      return `- ${refStr} — ⚠ closed as **not planned** — verify this dependency was actually delivered`;
    }
    if (r.merged === false) {
      return `- ${refStr} — ⚠ closed without merging`;
    }
    return `- ${refStr} — closed (completed)`;
  });

  return [
    '**Dependencies resolved — resuming implementation**',
    '',
    ...lines,
  ].join('\n');
}

/**
 * Build the body of a ref-read escalation comment.
 */
export function buildErrorComment(
  ref: DependencyRef,
  consecutiveFailures: number,
  lastError: string,
): string {
  const refStr = formatCanonicalRef(ref);
  return [
    MARKER_ERROR,
    '**Cannot verify dependency state**',
    '',
    `\`${refStr}\` has failed ${consecutiveFailures} consecutive reads (last error: ${lastError}).`,
    'The gate is still held and retries continue. If this ref is wrong or inaccessible,',
    'advance the gate manually: `cockpit advance --gate dependencies`.',
  ].join('\n');
}

/** Re-exported for use by DependencyMonitorService. */
export { MARKER_BLOCK, MARKER_LIMIT, MARKER_ERROR };
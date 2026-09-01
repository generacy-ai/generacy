import { describe, it, expect, vi } from 'vitest';
import {
  parseDependencyRefs,
  formatCanonicalRef,
  parseBlockCommentRefs,
  findNewestBlockComment,
  findNewestLimitComment,
  findNewestErrorComment,
  findNewestCommentWithMarker,
  countDependencyBlockCycles,
  buildBlockComment,
  buildLimitComment,
  buildReArmComment,
  buildErrorComment,
  MARKER_BLOCK,
  MARKER_LIMIT,
  MARKER_ERROR,
  type DependencyRef,
} from '../dependency-block.js';
import type { Comment } from '@generacy-ai/workflow-engine';

const DEFAULT_OWNER = 'test-org';
const DEFAULT_REPO = 'test-repo';

function makeComment(overrides: Partial<Comment> = {}): Comment {
  return {
    id: 1,
    body: '',
    author: 'test-user',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

// =============================================================================
// Ref grammar
// =============================================================================

describe('parseDependencyRefs', () => {
  it('parses canonical refs (owner/repo#N)', () => {
    const { valid, invalid } = parseDependencyRefs(
      ['generacy-ai/generacy#1198', 'my-org/my.repo_1#42'],
      DEFAULT_OWNER, DEFAULT_REPO,
    );
    expect(invalid).toHaveLength(0);
    expect(valid).toEqual([
      { owner: 'generacy-ai', repo: 'generacy', number: 1198 },
      { owner: 'my-org', repo: 'my.repo_1', number: 42 },
    ]);
  });

  it('resolves shorthand #N against the default owner/repo', () => {
    const { valid, invalid } = parseDependencyRefs(
      ['#1199', '#1'],
      DEFAULT_OWNER, DEFAULT_REPO,
    );
    expect(invalid).toHaveLength(0);
    expect(valid).toEqual([
      { owner: DEFAULT_OWNER, repo: DEFAULT_REPO, number: 1199 },
      { owner: DEFAULT_OWNER, repo: DEFAULT_REPO, number: 1 },
    ]);
  });

  it('resolves bare N against the default owner/repo', () => {
    const { valid, invalid } = parseDependencyRefs(
      ['42', '7'],
      DEFAULT_OWNER, DEFAULT_REPO,
    );
    expect(invalid).toHaveLength(0);
    expect(valid).toEqual([
      { owner: DEFAULT_OWNER, repo: DEFAULT_REPO, number: 42 },
      { owner: DEFAULT_OWNER, repo: DEFAULT_REPO, number: 7 },
    ]);
  });

  it('drops invalid entries and returns them in the invalid list', () => {
    const logger = { warn: vi.fn() } as any;
    const { valid, invalid } = parseDependencyRefs(
      ['not-a-ref', '', '   ', 'generacy-ai/generacy#42'],
      DEFAULT_OWNER, DEFAULT_REPO,
      logger,
    );
    expect(valid).toEqual([{ owner: 'generacy-ai', repo: 'generacy', number: 42 }]);
    expect(invalid).toEqual(['not-a-ref', '', '   ']);
    expect(logger.warn).toHaveBeenCalledTimes(3);
  });

  it('rejects zero-numbered refs in every grammar form', () => {
    const { valid, invalid } = parseDependencyRefs(
      ['owner/repo#0', '#0', '0'],
      'def-owner',
      'def-repo',
    );
    expect(valid).toHaveLength(0);
    expect(invalid).toEqual(['owner/repo#0', '#0', '0']);
  });

  it('returns empty valid when all refs are invalid', () => {
    const { valid, invalid } = parseDependencyRefs(
      ['garbage', 'not/a/ref'],
      DEFAULT_OWNER, DEFAULT_REPO,
    );
    expect(valid).toHaveLength(0);
    expect(invalid).toHaveLength(2);
  });

  it('trims whitespace from entries', () => {
    const { valid } = parseDependencyRefs(
      ['  #42  ', ' generacy-ai/generacy#1 '],
      DEFAULT_OWNER, DEFAULT_REPO,
    );
    expect(valid).toEqual([
      { owner: DEFAULT_OWNER, repo: DEFAULT_REPO, number: 42 },
      { owner: 'generacy-ai', repo: 'generacy', number: 1 },
    ]);
  });

  it('handles mixed valid and invalid entries', () => {
    const { valid, invalid } = parseDependencyRefs(
      ['generacy-ai/generacy#1', 'bad', '#2', '3'],
      DEFAULT_OWNER, DEFAULT_REPO,
    );
    expect(valid).toHaveLength(3);
    expect(invalid).toEqual(['bad']);
  });
});

describe('formatCanonicalRef', () => {
  it('formats a DependencyRef to canonical string', () => {
    expect(formatCanonicalRef({ owner: 'a', repo: 'b', number: 42 })).toBe('a/b#42');
  });
});

// =============================================================================
// Marker comment format/parse
// =============================================================================

describe('parseBlockCommentRefs', () => {
  it('parses a valid block marker comment body', () => {
    const body = buildBlockComment([
      { owner: 'a', repo: 'b', number: 1 },
      { owner: 'c', repo: 'd', number: 2 },
    ]);
    const refs = parseBlockCommentRefs(body);
    expect(refs).toEqual(['a/b#1', 'c/d#2']);
  });

  it('returns null for a non-marker body', () => {
    expect(parseBlockCommentRefs('just a regular comment')).toBeNull();
  });

  it('returns null when marker is present but JSON is missing', () => {
    expect(parseBlockCommentRefs(MARKER_BLOCK + '\n no json here')).toBeNull();
  });

  it('returns null when JSON is malformed', () => {
    expect(parseBlockCommentRefs(MARKER_BLOCK + '\n```json\n{not json}\n```')).toBeNull();
  });

  it('returns null when on field is not an array', () => {
    expect(parseBlockCommentRefs(MARKER_BLOCK + '\n```json\n{"on":"string"}\n```')).toBeNull();
  });

  it('returns null when on array is empty', () => {
    expect(parseBlockCommentRefs(MARKER_BLOCK + '\n```json\n{"on":[]}\n```')).toBeNull();
  });

  it('returns null when on array contains non-string entries', () => {
    expect(parseBlockCommentRefs(MARKER_BLOCK + '\n```json\n{"on":[1,2,3]}\n```')).toBeNull();
  });
});

describe('findNewestCommentWithMarker', () => {
  it('finds the newest comment with the given marker', () => {
    const comments = [
      makeComment({ id: 1, body: MARKER_BLOCK + '\n```json\n{"on":["a/b#1"]}\n```', created_at: '2026-01-01T00:00:00Z' }),
      makeComment({ id: 2, body: 'regular comment', created_at: '2026-02-01T00:00:00Z' }),
      makeComment({ id: 3, body: MARKER_BLOCK + '\n```json\n{"on":["c/d#2"]}\n```', created_at: '2026-03-01T00:00:00Z' }),
    ];
    const found = findNewestBlockComment(comments);
    expect(found?.id).toBe(3);
  });

  it('returns undefined when no comment has the marker', () => {
    const comments = [
      makeComment({ id: 1, body: 'regular comment' }),
    ];
    expect(findNewestBlockComment(comments)).toBeUndefined();
    expect(findNewestLimitComment(comments)).toBeUndefined();
    expect(findNewestErrorComment(comments)).toBeUndefined();
  });
});

// =============================================================================
// Cycle counting
// =============================================================================

describe('countDependencyBlockCycles', () => {
  it('counts all block comments when there is no limit comment', () => {
    const comments = [
      makeComment({ id: 1, body: MARKER_BLOCK + '\n```json\n{"on":["a/b#1"]}\n```', created_at: '2026-01-01T00:00:00Z' }),
      makeComment({ id: 2, body: MARKER_BLOCK + '\n```json\n{"on":["a/b#1"]}\n```', created_at: '2026-02-01T00:00:00Z' }),
    ];
    const { count, atCap } = countDependencyBlockCycles(comments, 3);
    expect(count).toBe(2);
    expect(atCap).toBe(false);
  });

  it('counts only block comments newer than the newest limit comment', () => {
    const comments = [
      makeComment({ id: 1, body: MARKER_BLOCK + '\n```json\n{"on":["a/b#1"]}\n```', created_at: '2026-01-01T00:00:00Z' }),
      makeComment({ id: 2, body: MARKER_LIMIT + '\nlimit', created_at: '2026-02-01T00:00:00Z' }),
      makeComment({ id: 3, body: MARKER_BLOCK + '\n```json\n{"on":["a/b#1"]}\n```', created_at: '2026-03-01T00:00:00Z' }),
    ];
    const { count, atCap } = countDependencyBlockCycles(comments, 3);
    expect(count).toBe(1); // only id=3 is newer than the limit
    expect(atCap).toBe(false);
  });

  it('returns atCap=true when count reaches maxCycles', () => {
    const comments = [
      makeComment({ id: 1, body: MARKER_BLOCK + '\n```json\n{"on":["a/b#1"]}\n```', created_at: '2026-01-01T00:00:00Z' }),
      makeComment({ id: 2, body: MARKER_BLOCK + '\n```json\n{"on":["a/b#1"]}\n```', created_at: '2026-02-01T00:00:00Z' }),
      makeComment({ id: 3, body: MARKER_BLOCK + '\n```json\n{"on":["a/b#1"]}\n```', created_at: '2026-03-01T00:00:00Z' }),
    ];
    const { count, atCap } = countDependencyBlockCycles(comments, 3);
    expect(count).toBe(3);
    expect(atCap).toBe(true);
  });

  it('a current limit comment forces atCap=false — the limit-comment dedup rule is structural', () => {
    // contracts/dependency-block-comments.md §2 asks the writer to skip posting a
    // second limit comment while one newer than the newest block exists. The
    // derived counter makes that state unreachable rather than merely guarded:
    // a newer limit comment zeroes the count, so the cap branch never re-enters.
    const comments = [
      makeComment({ id: 1, body: MARKER_BLOCK + '\n```json\n{"on":["a/b#1"]}\n```', created_at: '2026-01-01T00:00:00Z' }),
      makeComment({ id: 2, body: MARKER_BLOCK + '\n```json\n{"on":["a/b#1"]}\n```', created_at: '2026-02-01T00:00:00Z' }),
      makeComment({ id: 3, body: MARKER_BLOCK + '\n```json\n{"on":["a/b#1"]}\n```', created_at: '2026-03-01T00:00:00Z' }),
      makeComment({ id: 4, body: MARKER_LIMIT + '\nlimit', created_at: '2026-04-01T00:00:00Z' }),
    ];
    const { count, atCap } = countDependencyBlockCycles(comments, 3);
    expect(count).toBe(0);
    expect(atCap).toBe(false);
  });

  it('operator grant resets the baseline — new limit comment resets count', () => {
    const comments = [
      makeComment({ id: 1, body: MARKER_BLOCK + '\n```json\n{"on":["a/b#1"]}\n```', created_at: '2026-01-01T00:00:00Z' }),
      makeComment({ id: 2, body: MARKER_BLOCK + '\n```json\n{"on":["a/b#1"]}\n```', created_at: '2026-02-01T00:00:00Z' }),
      makeComment({ id: 3, body: MARKER_BLOCK + '\n```json\n{"on":["a/b#1"]}\n```', created_at: '2026-03-01T00:00:00Z' }),
      // Operator grants another round
      makeComment({ id: 4, body: MARKER_LIMIT + '\nlimit', created_at: '2026-04-01T00:00:00Z' }),
      // One new block comment after the grant
      makeComment({ id: 5, body: MARKER_BLOCK + '\n```json\n{"on":["a/b#1"]}\n```', created_at: '2026-05-01T00:00:00Z' }),
    ];
    const { count, atCap } = countDependencyBlockCycles(comments, 3);
    expect(count).toBe(1); // only id=5 is newer than the new limit
    expect(atCap).toBe(false);
  });
});

// =============================================================================
// Comment body builders
// =============================================================================

describe('buildBlockComment', () => {
  it('includes the marker, canonical refs, and human-readable prose', () => {
    const refs: DependencyRef[] = [
      { owner: 'a', repo: 'b', number: 1 },
      { owner: 'c', repo: 'd', number: 2 },
    ];
    const body = buildBlockComment(refs);
    expect(body).toContain(MARKER_BLOCK);
    expect(body).toContain('"on":["a/b#1","c/d#2"]');
    expect(body).toContain('Implementation paused');
  });
});

describe('buildLimitComment', () => {
  it('includes the marker, open refs, and human-readable prose', () => {
    const refs: DependencyRef[] = [
      { owner: 'a', repo: 'b', number: 1 },
    ];
    const body = buildLimitComment(refs);
    expect(body).toContain(MARKER_LIMIT);
    expect(body).toContain('a/b#1');
    expect(body).toContain('completed:dependency-limit');
  });
});

describe('buildReArmComment', () => {
  it('flags not_planned closures with warning', () => {
    const results = [
      { ref: { owner: 'a', repo: 'b', number: 1 }, state: 'closed' as const, stateReason: 'not_planned', merged: null },
    ];
    const body = buildReArmComment(results);
    expect(body).toContain('not planned');
    expect(body).toContain('a/b#1');
  });

  it('flags unmerged PR closures with warning', () => {
    const results = [
      { ref: { owner: 'a', repo: 'b', number: 1 }, state: 'closed' as const, stateReason: null, merged: false },
    ];
    const body = buildReArmComment(results);
    expect(body).toContain('closed without merging');
    expect(body).toContain('a/b#1');
  });

  it('marks normal closures without warning', () => {
    const results = [
      { ref: { owner: 'a', repo: 'b', number: 1 }, state: 'closed' as const, stateReason: 'completed', merged: true },
    ];
    const body = buildReArmComment(results);
    expect(body).toContain('closed (completed)');
    expect(body).not.toContain('not planned');
    expect(body).not.toContain('without merging');
  });
});

describe('buildErrorComment', () => {
  it('includes the marker, ref, failure count, and last error', () => {
    const ref: DependencyRef = { owner: 'a', repo: 'b', number: 1 };
    const body = buildErrorComment(ref, 3, 'Network error');
    expect(body).toContain(MARKER_ERROR);
    expect(body).toContain('a/b#1');
    expect(body).toContain('3 consecutive');
    expect(body).toContain('Network error');
  });
});
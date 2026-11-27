import { describe, expect, it } from 'vitest';

import { findSpecDirName, matchSpecDir } from '../spec-dir-resolver.js';

describe('matchSpecDir (#1241)', () => {
  it('matches a zero-padded dir for a low-numbered issue (SC-001)', () => {
    expect(matchSpecDir(['006-foo'], 6)).toEqual({ kind: 'match', dir: '006-foo' });
  });

  it('matches a non-padded dir for the same issue (SC-003)', () => {
    expect(matchSpecDir(['6-foo'], 6)).toEqual({ kind: 'match', dir: '6-foo' });
  });

  it('matches a three-digit issue by exact digits (SC-003)', () => {
    expect(matchSpecDir(['123-foo'], 123)).toEqual({ kind: 'match', dir: '123-foo' });
  });

  it('prefers the exact non-padded dir when both exist (SC-004)', () => {
    expect(matchSpecDir(['6-foo', '006-bar'], 6)).toEqual({ kind: 'match', dir: '6-foo' });
  });

  it('does not match across a number boundary (SC-002)', () => {
    expect(matchSpecDir(['60-foo'], 6)).toEqual({ kind: 'none' });
    expect(matchSpecDir(['600-foo'], 6)).toEqual({ kind: 'none' });
  });

  it('ignores `006abc-foo` — digits must be immediately followed by `-` (US2)', () => {
    expect(matchSpecDir(['006abc-foo'], 6)).toEqual({ kind: 'none' });
  });

  it('ignores a non-numeric entry (FR-002a)', () => {
    expect(matchSpecDir(['contracts'], 6)).toEqual({ kind: 'none' });
  });

  it('reports ambiguity when multiple padded dirs resolve to the same issue (FR-003)', () => {
    expect(matchSpecDir(['006-foo', '0006-bar'], 6)).toEqual({
      kind: 'ambiguous',
      dirs: ['006-foo', '0006-bar'],
    });
  });

  it('returns none for an empty listing (FR-004)', () => {
    expect(matchSpecDir([], 6)).toEqual({ kind: 'none' });
  });

  it('matches the exact non-padded dir even amid cross-boundary noise', () => {
    expect(matchSpecDir(['60-x', '600-y', '6-real', '006-pad'], 6)).toEqual({
      kind: 'match',
      dir: '6-real',
    });
  });
});

describe('findSpecDirName (#1241)', () => {
  it('returns the dir name on a unique match', () => {
    expect(findSpecDirName(['006-foo'], 6)).toBe('006-foo');
  });

  it('returns undefined on none', () => {
    expect(findSpecDirName(['99-other'], 6)).toBeUndefined();
  });

  it('returns undefined on ambiguous', () => {
    expect(findSpecDirName(['006-foo', '0006-bar'], 6)).toBeUndefined();
  });

  it('applies exact-match precedence', () => {
    expect(findSpecDirName(['006-bar', '6-foo'], 6)).toBe('6-foo');
  });
});

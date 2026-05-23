import { describe, it, expect } from 'vitest';
import { parsePRUrl } from '../linked-pr-url-parser.js';

describe('parsePRUrl', () => {
  it('parses a valid GitHub PR URL', () => {
    const result = parsePRUrl('https://github.com/generacy-ai/generacy-cloud/pull/42');
    expect(result).toEqual({ owner: 'generacy-ai', repo: 'generacy-cloud', number: 42 });
  });

  it('parses HTTPS URL with trailing slash', () => {
    const result = parsePRUrl('https://github.com/generacy-ai/generacy-cloud/pull/42/');
    expect(result).toEqual({ owner: 'generacy-ai', repo: 'generacy-cloud', number: 42 });
  });

  it('returns null for non-GitHub URL', () => {
    expect(parsePRUrl('https://gitlab.com/org/repo/merge_requests/1')).toBeNull();
  });

  it('returns null for malformed path', () => {
    expect(parsePRUrl('https://github.com/org/repo/issues/5')).toBeNull();
  });

  it('parses cross-org URL', () => {
    const result = parsePRUrl('https://github.com/other-org/other-repo/pull/99');
    expect(result).toEqual({ owner: 'other-org', repo: 'other-repo', number: 99 });
  });
});

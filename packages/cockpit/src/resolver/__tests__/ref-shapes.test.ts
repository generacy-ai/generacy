import { describe, expect, it } from 'vitest';
import { parseRef } from '../ref-shapes.js';

describe('parseRef', () => {
  const canonical = { repo: 'owner/repo', number: 42 };

  it('accepts bare owner/repo#N', () => {
    expect(parseRef('owner/repo#42')).toEqual(canonical);
  });

  it('accepts markdown-linked bare label', () => {
    expect(parseRef('[owner/repo#42](https://example.test)')).toEqual(canonical);
  });

  it('accepts markdown-linked #N label with matching URL', () => {
    expect(
      parseRef('[#42](https://github.com/owner/repo/issues/42)'),
    ).toEqual(canonical);
  });

  it('accepts /pull/ in the URL', () => {
    expect(
      parseRef('[#42](https://github.com/owner/repo/pull/42)'),
    ).toEqual(canonical);
  });

  it('accepts plain issue URL', () => {
    expect(parseRef('https://github.com/owner/repo/issues/42')).toEqual(canonical);
  });

  it('accepts plain PR URL', () => {
    expect(parseRef('https://github.com/owner/repo/pull/42')).toEqual(canonical);
  });

  it('rejects bare #N shorthand', () => {
    expect(parseRef('#42')).toBeNull();
  });

  it('rejects N=0', () => {
    expect(parseRef('owner/repo#0')).toBeNull();
  });

  it('rejects N=-3 (regex level, since sign is not matched)', () => {
    expect(parseRef('owner/repo#-3')).toBeNull();
  });

  it('rejects N=abc', () => {
    expect(parseRef('owner/repo#abc')).toBeNull();
  });

  it('accepts URL with query string', () => {
    expect(
      parseRef('https://github.com/owner/repo/issues/42?foo=bar'),
    ).toEqual(canonical);
  });

  it('accepts URL with fragment', () => {
    expect(
      parseRef('https://github.com/owner/repo/issues/42#comment-1'),
    ).toEqual(canonical);
  });

  it('rejects URL with /tree/ path', () => {
    expect(
      parseRef('https://github.com/owner/repo/tree/main'),
    ).toBeNull();
  });

  it('rejects URL with /commits/ path', () => {
    expect(
      parseRef('https://github.com/owner/repo/commits/main'),
    ).toBeNull();
  });

  it('rejects markdown link with mismatched #N and URL number', () => {
    expect(
      parseRef('[#42](https://github.com/owner/repo/issues/43)'),
    ).toBeNull();
  });

  it('normalises whitespace around the token', () => {
    expect(parseRef('  owner/repo#42  ')).toEqual(canonical);
  });
});

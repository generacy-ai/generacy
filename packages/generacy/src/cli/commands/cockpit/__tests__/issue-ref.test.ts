import { describe, it, expect } from 'vitest';
import { parseIssueRef } from '../issue-ref.js';

describe('parseIssueRef', () => {
  it('refuses a bare number (repos are not configured)', () => {
    expect(() => parseIssueRef('123')).toThrow(
      /^parse issue: bare issue number "123" is not accepted/,
    );
  });

  it('parses owner/repo#number form', () => {
    expect(parseIssueRef('owner/repo#7')).toEqual({
      owner: 'owner',
      repo: 'repo',
      number: 7,
      nwo: 'owner/repo',
    });
  });

  it('parses an issues URL', () => {
    expect(parseIssueRef('https://github.com/owner/repo/issues/99')).toEqual({
      owner: 'owner',
      repo: 'repo',
      number: 99,
      nwo: 'owner/repo',
    });
  });

  it('parses a pull URL (PRs are issues on GitHub)', () => {
    expect(parseIssueRef('https://github.com/owner/repo/pull/788')).toEqual({
      owner: 'owner',
      repo: 'repo',
      number: 788,
      nwo: 'owner/repo',
    });
  });

  it('accepts URLs with trailing query strings or fragments', () => {
    const ref = parseIssueRef('https://github.com/o/r/issues/12?foo=1#bar');
    expect(ref.number).toBe(12);
  });

  it('rejects empty input', () => {
    expect(() => parseIssueRef('')).toThrow(/^parse issue: issue argument is required/);
  });

  it('rejects garbage', () => {
    expect(() => parseIssueRef('not-an-issue')).toThrow(/^parse issue: unrecognized issue ref/);
  });

  it('rejects issue number 0 and negative in owner/repo#n form', () => {
    expect(() => parseIssueRef('owner/repo#0')).toThrow(/positive integer/);
  });
});

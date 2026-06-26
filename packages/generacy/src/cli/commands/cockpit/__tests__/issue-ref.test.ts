import { describe, it, expect } from 'vitest';
import { parseIssueRef } from '../issue-ref.js';

const oneRepo = { config: { repos: ['generacy-ai/generacy'] } };
const zeroRepo = { config: { repos: [] } };
const manyRepos = { config: { repos: ['generacy-ai/generacy', 'generacy-ai/cluster-base'] } };

describe('parseIssueRef', () => {
  it('parses bare number with exactly one configured repo', () => {
    expect(parseIssueRef('123', oneRepo)).toEqual({
      owner: 'generacy-ai',
      repo: 'generacy',
      number: 123,
      nwo: 'generacy-ai/generacy',
    });
  });

  it('refuses bare number when zero repos configured', () => {
    expect(() => parseIssueRef('1', zeroRepo)).toThrow(
      /^parse issue: Cannot resolve issue #1: 0 monitored repos configured/,
    );
  });

  it('refuses bare number when multiple repos configured', () => {
    expect(() => parseIssueRef('42', manyRepos)).toThrow(
      /^parse issue: Cannot resolve issue #42: 2 monitored repos configured/,
    );
  });

  it('parses owner/repo#number form regardless of configured repos', () => {
    expect(parseIssueRef('owner/repo#7', zeroRepo)).toEqual({
      owner: 'owner',
      repo: 'repo',
      number: 7,
      nwo: 'owner/repo',
    });
    expect(parseIssueRef('owner/repo#7', manyRepos)).toEqual({
      owner: 'owner',
      repo: 'repo',
      number: 7,
      nwo: 'owner/repo',
    });
  });

  it('parses an issues URL', () => {
    expect(parseIssueRef('https://github.com/owner/repo/issues/99', zeroRepo)).toEqual({
      owner: 'owner',
      repo: 'repo',
      number: 99,
      nwo: 'owner/repo',
    });
  });

  it('parses a pull URL (PRs are issues on GitHub)', () => {
    expect(parseIssueRef('https://github.com/owner/repo/pull/788', zeroRepo)).toEqual({
      owner: 'owner',
      repo: 'repo',
      number: 788,
      nwo: 'owner/repo',
    });
  });

  it('accepts URLs with trailing query strings or fragments', () => {
    const ref = parseIssueRef('https://github.com/o/r/issues/12?foo=1#bar', zeroRepo);
    expect(ref.number).toBe(12);
  });

  it('rejects empty input', () => {
    expect(() => parseIssueRef('', oneRepo)).toThrow(/^parse issue: issue argument is required/);
  });

  it('rejects garbage', () => {
    expect(() => parseIssueRef('not-an-issue', oneRepo)).toThrow(/^parse issue: unrecognized issue ref/);
  });

  it('rejects issue number 0 and negative', () => {
    expect(() => parseIssueRef('0', oneRepo)).toThrow(/positive integer/);
  });
});

import { describe, it, expect, vi } from 'vitest';
import type { CommandRunner } from '@generacy-ai/cockpit';
import { parseIssueRef, resolveIssueContext } from '../resolver.js';

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

  it("garbage error message enumerates <n>, <owner>/<repo>#<n>, and URL forms (FR-007)", () => {
    expect(() => parseIssueRef('garbage')).toThrow(
      /Use <n>, <owner>\/<repo>#<n>, or https:\/\/github\.com\/<owner>\/<repo>\/issues\/<n>\./,
    );
  });

  it('rejects issue number 0 in owner/repo#n form', () => {
    expect(() => parseIssueRef('owner/repo#0')).toThrow(/positive integer/);
  });
});

describe('resolveIssueContext', () => {
  it('returns { ref, repo, gh } for owner/repo#n form (no runner call needed)', async () => {
    const runner = vi.fn<CommandRunner>();
    const ctx = await resolveIssueContext({ issue: 'owner/repo#42', runner });
    expect(ctx.ref).toEqual({
      owner: 'owner',
      repo: 'repo',
      number: 42,
      nwo: 'owner/repo',
    });
    expect(ctx.repo).toBe('owner/repo');
    expect(runner).not.toHaveBeenCalled();
  });

  it('infers repo from git origin URL when input is a bare number', async () => {
    const runner: CommandRunner = vi.fn(async (cmd, args) => {
      expect(cmd).toBe('git');
      expect(args).toEqual(['remote', 'get-url', 'origin']);
      return {
        stdout: 'https://github.com/owner/repo.git\n',
        stderr: '',
        exitCode: 0,
      };
    });
    const ctx = await resolveIssueContext({ issue: '123', runner });
    expect(ctx.ref.owner).toBe('owner');
    expect(ctx.ref.repo).toBe('repo');
    expect(ctx.ref.number).toBe(123);
    expect(ctx.repo).toBe('owner/repo');
  });

  it('honors input.repo override for a bare number (no git-origin call)', async () => {
    const runner = vi.fn<CommandRunner>();
    const ctx = await resolveIssueContext({
      issue: '55',
      repo: 'foo/bar',
      runner,
    });
    expect(ctx.ref).toEqual({
      owner: 'foo',
      repo: 'bar',
      number: 55,
      nwo: 'foo/bar',
    });
    expect(runner).not.toHaveBeenCalled();
  });

  it('fails loudly when bare number is passed and git origin lookup fails', async () => {
    const runner: CommandRunner = vi.fn(async () => ({
      stdout: '',
      stderr: 'fatal: no such remote',
      exitCode: 128,
    }));
    await expect(
      resolveIssueContext({ issue: '123', runner }),
    ).rejects.toThrow(/could not infer owner\/repo/);
  });

  it('bare "1" with ssh origin URL expands to owner/repo#1 (T007 integration)', async () => {
    const runner: CommandRunner = vi.fn(async (cmd, args) => {
      expect(cmd).toBe('git');
      expect(args).toEqual(['remote', 'get-url', 'origin']);
      return {
        stdout: 'git@github.com:owner/repo.git\n',
        stderr: '',
        exitCode: 0,
      };
    });
    const ctx = await resolveIssueContext({ issue: '1', runner });
    expect(ctx.ref.nwo).toBe('owner/repo');
    expect(ctx.ref.number).toBe(1);
  });

  it('propagates non-bare-number parse failures without falling through to git-origin', async () => {
    const runner = vi.fn<CommandRunner>();
    await expect(
      resolveIssueContext({ issue: 'garbage', runner }),
    ).rejects.toThrow(/unrecognized issue ref/);
    expect(runner).not.toHaveBeenCalled();
  });
});

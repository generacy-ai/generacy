import { describe, it, expect, vi } from 'vitest';
import type { CommandRunner, GhWrapper, Issue } from '@generacy-ai/cockpit';
import { normalizeIssueRef } from '../ref-input.js';

function stubGh(issue: Partial<Issue> = {}): GhWrapper {
  return {
    getIssue: vi.fn(async () => ({
      number: 917,
      title: 'x',
      state: 'OPEN',
      labels: [],
      url: 'https://github.com/generacy-ai/generacy/issues/917',
      ...issue,
    })) as unknown as GhWrapper['getIssue'],
  } as unknown as GhWrapper;
}

describe('normalizeIssueRef', () => {
  it('accepts object form', async () => {
    const gh = stubGh();
    const result = await normalizeIssueRef(
      { owner: 'generacy-ai', repo: 'generacy', number: 917 },
      { expects: 'issue', gh },
    );
    if (!result.ok) throw new Error('unexpected error: ' + JSON.stringify(result.error));
    expect(result.value.ref).toEqual({
      owner: 'generacy-ai',
      repo: 'generacy',
      number: 917,
      nwo: 'generacy-ai/generacy',
    });
  });

  it('accepts qualified string form owner/repo#N', async () => {
    const gh = stubGh();
    const runner: CommandRunner = vi.fn(async () => ({
      exitCode: 0,
      stdout: '',
      stderr: '',
    })) as unknown as CommandRunner;
    const result = await normalizeIssueRef('generacy-ai/generacy#917', {
      expects: 'issue',
      gh,
      runner,
    });
    if (!result.ok) throw new Error('unexpected error');
    expect(result.value.ref.number).toBe(917);
    expect(result.value.ref.nwo).toBe('generacy-ai/generacy');
  });

  it('accepts URL string form', async () => {
    const gh = stubGh();
    const runner: CommandRunner = vi.fn(async () => ({
      exitCode: 0,
      stdout: '',
      stderr: '',
    })) as unknown as CommandRunner;
    const result = await normalizeIssueRef(
      'https://github.com/generacy-ai/generacy/issues/917',
      { expects: 'issue', gh, runner },
    );
    if (!result.ok) throw new Error('unexpected error');
    expect(result.value.ref.number).toBe(917);
  });

  it('rejects PR-number-as-issue with wrong-kind (subsumes #906)', async () => {
    const gh = stubGh({ url: 'https://github.com/generacy-ai/generacy/pull/917' });
    const result = await normalizeIssueRef(
      { owner: 'generacy-ai', repo: 'generacy', number: 917 },
      { expects: 'issue', gh },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.class).toBe('wrong-kind');
    expect(result.error.detail).toContain('is a pull request');
  });

  it('rejects issue-number-as-pr with wrong-kind (cockpit_merge)', async () => {
    const gh = stubGh({ url: 'https://github.com/generacy-ai/generacy/issues/917' });
    const result = await normalizeIssueRef(
      { owner: 'generacy-ai', repo: 'generacy', number: 917 },
      { expects: 'pr', gh },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.class).toBe('wrong-kind');
    expect(result.error.detail).toContain('is an issue');
  });

  it('accepts type:pr label as PR discriminator', async () => {
    const gh = stubGh({
      url: 'https://github.com/example/example/issues/1',
      labels: ['type:pr'],
    });
    const result = await normalizeIssueRef(
      { owner: 'example', repo: 'example', number: 1 },
      { expects: 'issue', gh },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.class).toBe('wrong-kind');
  });

  it('rejects malformed object shape → invalid-args', async () => {
    const gh = stubGh();
    const result = await normalizeIssueRef(
      { owner: 'has spaces', repo: 'generacy', number: 917 } as never,
      { expects: 'issue', gh },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.class).toBe('invalid-args');
  });
});

import { describe, it, expect, vi } from 'vitest';
import { gatherCodeReferences } from '../code-references.js';
import type { CommandRunner, GhWrapper } from '@generacy-ai/cockpit';

function stubGh(overrides: Partial<GhWrapper>): GhWrapper {
  return {
    fetchIssueLabels: vi.fn(),
    fetchIssueState: vi.fn(),
    postIssueComment: vi.fn(),
    addLabel: vi.fn(),
    removeLabel: vi.fn(),
    fetchIssueTimeline: vi.fn(),
    fetchIssueComments: vi.fn(),
    getCurrentUser: vi.fn(),
    findOpenPrForBranch: vi.fn(async () => null),
    prDiffNames: vi.fn(async () => []),
    prDiffPatch: vi.fn(async () => ''),
    ...overrides,
  } as GhWrapper;
}

const okRunner: CommandRunner = async () => ({ stdout: '', stderr: '', exitCode: 0 });

describe('gatherCodeReferences', () => {
  it('returns null when branch equals base', async () => {
    expect(
      await gatherCodeReferences({ repo: 'o/r', branch: 'develop', baseBranch: 'develop' }, stubGh({}), okRunner),
    ).toBeNull();
  });

  it('returns null when branch is empty', async () => {
    expect(
      await gatherCodeReferences({ repo: 'o/r', branch: '', baseBranch: 'develop' }, stubGh({}), okRunner),
    ).toBeNull();
  });

  it('uses gh pr diff when an open PR exists', async () => {
    const gh = stubGh({
      findOpenPrForBranch: vi.fn(async () => ({ url: 'https://github.com/o/r/pull/9', number: 9 })),
      prDiffNames: vi.fn(async () => ['src/a.ts', 'src/b.ts']),
      prDiffPatch: vi.fn(async () => 'diff --git a/src/a.ts b/src/a.ts\n+hi'),
    });
    const result = await gatherCodeReferences(
      { repo: 'o/r', branch: 'feat-x', baseBranch: 'develop' },
      gh,
      okRunner,
    );
    expect(result).toEqual({
      touchedFiles: ['src/a.ts', 'src/b.ts'],
      prUrl: 'https://github.com/o/r/pull/9',
      prDiffSummary: 'diff --git a/src/a.ts b/src/a.ts\n+hi',
    });
  });

  it('falls back to git diff --name-only when no PR', async () => {
    const runner: CommandRunner = vi.fn(async (cmd, args) => {
      expect(cmd).toBe('git');
      expect(args).toEqual(['diff', '--name-only', 'develop...feat-x']);
      return { stdout: 'src/x.ts\nsrc/y.ts\n', stderr: '', exitCode: 0 };
    });
    const gh = stubGh({ findOpenPrForBranch: vi.fn(async () => null) });
    const result = await gatherCodeReferences(
      { repo: 'o/r', branch: 'feat-x', baseBranch: 'develop' },
      gh,
      runner,
    );
    expect(result).toEqual({
      touchedFiles: ['src/x.ts', 'src/y.ts'],
      prUrl: null,
      prDiffSummary: null,
    });
  });

  it('truncates prDiffSummary to 4 KiB with marker', async () => {
    const big = 'x'.repeat(5000);
    const gh = stubGh({
      findOpenPrForBranch: vi.fn(async () => ({ url: 'u', number: 1 })),
      prDiffNames: vi.fn(async () => []),
      prDiffPatch: vi.fn(async () => big),
    });
    const result = await gatherCodeReferences(
      { repo: 'o/r', branch: 'b', baseBranch: 'develop' },
      gh,
      okRunner,
    );
    expect(result?.prDiffSummary).toMatch(/^x{4096}…\[truncated\]$/);
    expect(result?.prDiffSummary?.length).toBeLessThanOrEqual(4108);
  });
});

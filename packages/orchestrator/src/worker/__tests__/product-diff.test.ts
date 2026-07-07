import { describe, it, expect, vi } from 'vitest';
import type { GitHubClient } from '@generacy-ai/workflow-engine';
import type { PrManager } from '../pr-manager.js';
import {
  EXCLUDED_PATH_PREFIXES,
  isProductFile,
  resolveBaseRef,
  computeProductDiff,
} from '../product-diff.js';

describe('EXCLUDED_PATH_PREFIXES', () => {
  it('contains specs/', () => {
    expect(EXCLUDED_PATH_PREFIXES).toEqual(['specs/']);
  });
});

describe('isProductFile', () => {
  it('excludes specs/foo.md', () => {
    expect(isProductFile('specs/820/plan.md')).toBe(false);
  });

  it('excludes specs/README.md (matches on prefix, not on filename)', () => {
    expect(isProductFile('specs/README.md')).toBe(false);
  });

  it('includes top-level README.md', () => {
    expect(isProductFile('README.md')).toBe(true);
  });

  it('includes packages/orchestrator/src/worker/phase-loop.ts', () => {
    expect(isProductFile('packages/orchestrator/src/worker/phase-loop.ts')).toBe(true);
  });

  it('includes empty string (does not match any non-empty prefix)', () => {
    expect(isProductFile('')).toBe(true);
  });

  it('respects injected prefixes over default', () => {
    expect(isProductFile('docs/foo.md', ['docs/'])).toBe(false);
    expect(isProductFile('specs/foo.md', ['docs/'])).toBe(true);
  });
});

describe('resolveBaseRef', () => {
  it('returns origin/<PR base ref> when PR number is defined', async () => {
    const github: Partial<GitHubClient> = {
      getPullRequest: vi.fn().mockResolvedValue({
        number: 42,
        base: { ref: 'develop', sha: 'abc' },
      }),
      getDefaultBranch: vi.fn().mockResolvedValue('main'),
    };
    const prManager: Partial<PrManager> = {
      getPrNumber: () => 42,
    };

    const baseRef = await resolveBaseRef(
      github as GitHubClient,
      prManager as PrManager,
      'generacy-ai',
      'generacy',
    );

    expect(baseRef).toBe('origin/develop');
    expect(github.getPullRequest).toHaveBeenCalledWith('generacy-ai', 'generacy', 42);
    expect(github.getDefaultBranch).not.toHaveBeenCalled();
  });

  it('falls back to origin/<default branch> when PR number is undefined', async () => {
    const github: Partial<GitHubClient> = {
      getPullRequest: vi.fn(),
      getDefaultBranch: vi.fn().mockResolvedValue('main'),
    };
    const prManager: Partial<PrManager> = {
      getPrNumber: () => undefined,
    };

    const baseRef = await resolveBaseRef(
      github as GitHubClient,
      prManager as PrManager,
      'generacy-ai',
      'generacy',
    );

    expect(baseRef).toBe('origin/main');
    expect(github.getPullRequest).not.toHaveBeenCalled();
    expect(github.getDefaultBranch).toHaveBeenCalled();
  });
});

describe('computeProductDiff', () => {
  const makeGithub = (files: string[]): GitHubClient => ({
    getFilesChangedBetween: vi.fn().mockResolvedValue(files),
  } as unknown as GitHubClient);

  it('SC-001: specs-only diff produces no productFiles', async () => {
    const github = makeGithub(['specs/820/tasks.md', 'specs/820/plan.md']);
    const result = await computeProductDiff(github, 'origin/develop');
    expect(result.changedFiles).toEqual(['specs/820/tasks.md', 'specs/820/plan.md']);
    expect(result.productFiles).toEqual([]);
    expect(result.baseRef).toBe('origin/develop');
  });

  it('mixed diff partitions correctly', async () => {
    const github = makeGithub(['specs/foo.md', 'packages/x/y.ts']);
    const result = await computeProductDiff(github, 'origin/develop');
    expect(result.changedFiles).toEqual(['specs/foo.md', 'packages/x/y.ts']);
    expect(result.productFiles).toEqual(['packages/x/y.ts']);
  });

  it('empty diff yields empty productFiles', async () => {
    const github = makeGithub([]);
    const result = await computeProductDiff(github, 'origin/develop');
    expect(result.changedFiles).toEqual([]);
    expect(result.productFiles).toEqual([]);
    expect(result.baseRef).toBe('origin/develop');
  });

  it('echoes the passed baseRef', async () => {
    const github = makeGithub(['README.md']);
    const result = await computeProductDiff(github, 'origin/feature/foo');
    expect(result.baseRef).toBe('origin/feature/foo');
  });

  it('does not mutate the returned productFiles when caller pushes to changedFiles', async () => {
    const github = makeGithub(['README.md']);
    const result = await computeProductDiff(github, 'origin/develop');
    result.changedFiles.push('extra.ts');
    expect(result.productFiles).toEqual(['README.md']);
  });
});

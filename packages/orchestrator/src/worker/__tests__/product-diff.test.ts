import { describe, it, expect, vi } from 'vitest';
import type { GitHubClient } from '@generacy-ai/workflow-engine';
import type { PrManager } from '../pr-manager.js';
import {
  EXCLUDED_PATH_PREFIXES,
  EXCLUDED_EXACT_PATHS,
  ENGINE_SIDECAR_PREFIXES,
  ENGINE_STATE_DIR,
  isEngineSidecar,
  engineSidecarCleanExcludes,
  isCollapsedEngineStateDir,
  isProductFile,
  resolveBaseRef,
  computeProductDiff,
  computePhaseScopedProductDiff,
} from '../product-diff.js';

describe('EXCLUDED_PATH_PREFIXES', () => {
  it('contains specs/ plus every engine-sidecar prefix (#1162)', () => {
    expect(EXCLUDED_PATH_PREFIXES).toEqual([
      'specs/',
      '.generacy/review-findings-',
      '.generacy/review-candidate-',
      '.generacy/pause-context-',
      '.generacy/external-feedback-',
      '.generacy/workflow-state-',
    ]);
  });
});

// #1162 SC-002: the sidecar prefixes are a single source of truth shared by the
// staging filter (FR-001) and the product-diff exclusion (FR-004).
describe('ENGINE_SIDECAR_PREFIXES / isEngineSidecar', () => {
  it('lists exactly the engine bookkeeping prefixes', () => {
    expect(ENGINE_SIDECAR_PREFIXES).toEqual([
      '.generacy/review-findings-',
      '.generacy/review-candidate-',
      '.generacy/pause-context-',
      '.generacy/external-feedback-',
      '.generacy/workflow-state-',
    ]);
  });

  it('matches each sidecar prefix with its sanitized-id suffix', () => {
    expect(isEngineSidecar('.generacy/review-findings-generacy-ai_generacy_1162.json')).toBe(true);
    expect(isEngineSidecar('.generacy/review-candidate-generacy-ai_generacy_1162.json')).toBe(true);
    expect(isEngineSidecar('.generacy/pause-context-generacy-ai_generacy_1162.json')).toBe(true);
    expect(isEngineSidecar('.generacy/external-feedback-generacy-ai_generacy_1162.json')).toBe(true);
    expect(isEngineSidecar('.generacy/workflow-state-generacy-ai_generacy_1162.json')).toBe(true);
  });

  it('does NOT match legitimately tracked .generacy product files (Q3)', () => {
    expect(isEngineSidecar('.generacy/config.yaml')).toBe(false);
    expect(isEngineSidecar('.generacy/epics/foo.md')).toBe(false);
  });

  it('does NOT match ordinary product paths', () => {
    expect(isEngineSidecar('packages/orchestrator/src/worker/phase-loop.ts')).toBe(false);
    expect(isEngineSidecar('README.md')).toBe(false);
  });
});

// #1162 follow-up: the cross-run checkout reset must spare the same sidecars
// the staging filter refuses to commit — derived from the same prefix list.
describe('engineSidecarCleanExcludes', () => {
  it('yields one `<prefix>*` git-clean exclude per sidecar prefix, in order', () => {
    expect(engineSidecarCleanExcludes()).toEqual([
      '.generacy/review-findings-*',
      '.generacy/review-candidate-*',
      '.generacy/pause-context-*',
      '.generacy/external-feedback-*',
      '.generacy/workflow-state-*',
    ]);
    expect(engineSidecarCleanExcludes()).toEqual(
      ENGINE_SIDECAR_PREFIXES.map((p) => `${p}*`),
    );
  });

  it('every prefix lives under ENGINE_STATE_DIR', () => {
    for (const prefix of ENGINE_SIDECAR_PREFIXES) {
      expect(prefix.startsWith(`${ENGINE_STATE_DIR}/`)).toBe(true);
    }
  });
});

describe('isCollapsedEngineStateDir', () => {
  it('matches a bare .generacy directory entry with or without trailing slash', () => {
    expect(isCollapsedEngineStateDir('.generacy/')).toBe(true);
    expect(isCollapsedEngineStateDir('.generacy')).toBe(true);
  });

  it('does NOT match files under .generacy or look-alike paths', () => {
    expect(isCollapsedEngineStateDir('.generacy/config.yaml')).toBe(false);
    expect(isCollapsedEngineStateDir('.generacy/review-findings-x.json')).toBe(false);
    expect(isCollapsedEngineStateDir('.generacyx')).toBe(false);
    expect(isCollapsedEngineStateDir('foo/.generacy/')).toBe(false);
    expect(isCollapsedEngineStateDir('README.md')).toBe(false);
  });

  it('is disjoint from isEngineSidecar (a collapsed dir is not itself a sidecar)', () => {
    expect(isEngineSidecar('.generacy/')).toBe(false);
    expect(isEngineSidecar('.generacy')).toBe(false);
  });
});

describe('EXCLUDED_EXACT_PATHS', () => {
  it('contains the four agent-context targets', () => {
    expect(EXCLUDED_EXACT_PATHS).toEqual([
      'CLAUDE.md',
      'AGENTS.md',
      'GEMINI.md',
      '.github/copilot-instructions.md',
    ]);
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

  // T013 / SC-002: root-relative exact-filename exclusion (#1107 FR-001).
  it('excludes root CLAUDE.md', () => {
    expect(isProductFile('CLAUDE.md')).toBe(false);
  });

  it('excludes root AGENTS.md / GEMINI.md', () => {
    expect(isProductFile('AGENTS.md')).toBe(false);
    expect(isProductFile('GEMINI.md')).toBe(false);
  });

  it('excludes .github/copilot-instructions.md', () => {
    expect(isProductFile('.github/copilot-instructions.md')).toBe(false);
  });

  it('includes CLAUDE.md.bak (exact match, not startsWith)', () => {
    expect(isProductFile('CLAUDE.md.bak')).toBe(true);
  });

  it('includes nested packages/foo/CLAUDE.md (root-relative only)', () => {
    expect(isProductFile('packages/foo/CLAUDE.md')).toBe(true);
  });

  it('respects injected exactPaths over default', () => {
    expect(isProductFile('OWNERS', EXCLUDED_PATH_PREFIXES, ['OWNERS'])).toBe(false);
    expect(isProductFile('CLAUDE.md', EXCLUDED_PATH_PREFIXES, ['OWNERS'])).toBe(true);
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

describe('computePhaseScopedProductDiff', () => {
  const makeGithub = (files: string[]): GitHubClient => ({
    getFilesChangedByOwnCommits: vi.fn().mockResolvedValue(files),
  } as unknown as GitHubClient);

  it('queries own-commit files from the passed startRef', async () => {
    const getFilesChangedByOwnCommits = vi.fn().mockResolvedValue(['packages/x/y.ts']);
    const github = { getFilesChangedByOwnCommits } as unknown as GitHubClient;
    const result = await computePhaseScopedProductDiff(github, 'abc123');
    expect(getFilesChangedByOwnCommits).toHaveBeenCalledWith('abc123');
    expect(result.baseRef).toBe('abc123');
  });

  it('SC-002: own-diff of CLAUDE.md only yields no productFiles', async () => {
    const github = makeGithub(['CLAUDE.md']);
    const result = await computePhaseScopedProductDiff(github, 'abc123');
    expect(result.changedFiles).toEqual(['CLAUDE.md']);
    expect(result.productFiles).toEqual([]);
  });

  it('SC-001: own-diff of an earlier-phase CLAUDE.md + a spec log yields no productFiles', async () => {
    const github = makeGithub(['CLAUDE.md', 'specs/1107/conversation-log.jsonl']);
    const result = await computePhaseScopedProductDiff(github, 'abc123');
    expect(result.productFiles).toEqual([]);
  });

  it('partitions a mixed own-diff, keeping real product files', async () => {
    const github = makeGithub(['CLAUDE.md', 'specs/1107/plan.md', 'packages/x/y.ts']);
    const result = await computePhaseScopedProductDiff(github, 'abc123');
    expect(result.productFiles).toEqual(['packages/x/y.ts']);
  });

  it('empty own-diff yields empty productFiles', async () => {
    const github = makeGithub([]);
    const result = await computePhaseScopedProductDiff(github, 'abc123');
    expect(result.changedFiles).toEqual([]);
    expect(result.productFiles).toEqual([]);
  });
});

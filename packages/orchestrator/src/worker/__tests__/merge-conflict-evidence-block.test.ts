/**
 * Renderer tests for the #864 merge-conflict evidence block.
 *
 * Contract: specs/864-found-during-cockpit-v1/contracts/merge-conflict-evidence-block.md
 * The block is placed below a horizontal rule, mirroring #847's placement pattern.
 */
import { vi, describe, it, expect } from 'vitest';
import { StageCommentManager } from '../stage-comment-manager.js';
import type { GitHubClient } from '@generacy-ai/workflow-engine';
import type { StageCommentData, Logger } from '../types.js';
import { STAGE_MARKERS } from '../types.js';

function makeLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as unknown as Logger;
}

async function render(data: StageCommentData): Promise<string> {
  let captured = '';
  const github: GitHubClient = {
    getIssueComments: vi
      .fn()
      .mockResolvedValue([{ id: 1, body: STAGE_MARKERS[data.stage] }]),
    updateComment: vi
      .fn()
      .mockImplementation(
        async (_o: string, _r: string, _id: number, body: string) => {
          captured = body;
          return undefined;
        },
      ),
    addIssueComment: vi.fn(),
  } as unknown as GitHubClient;
  const manager = new StageCommentManager(
    github,
    'owner',
    'repo',
    1,
    makeLogger(),
  );
  await manager.updateStageComment(data);
  return captured;
}

const IN_PROGRESS: StageCommentData = {
  stage: 'implementation',
  status: 'in_progress',
  phases: [
    { phase: 'implement', status: 'in_progress', startedAt: '2026-07-08T00:00:00Z' },
  ],
  startedAt: '2026-07-08T00:00:00Z',
};

describe('merge-conflict evidence block', () => {
  it('renders the canonical marker string (SC-004)', async () => {
    const body = await render({
      ...IN_PROGRESS,
      errorEvidence: {
        mergeConflict: {
          baseRef: 'origin/main',
          conflictedPaths: ['CLAUDE.md'],
        },
      },
    });
    expect(body).toContain('**Merge conflict during base-sync**');
  });

  it('renders the base ref line with backtick-wrapped ref', async () => {
    const body = await render({
      ...IN_PROGRESS,
      errorEvidence: {
        mergeConflict: {
          baseRef: 'origin/main',
          conflictedPaths: ['package.json'],
        },
      },
    });
    expect(body).toContain('**Base**: `origin/main`');
  });

  it('emits all supplied paths bulleted, in the supplied order', async () => {
    const body = await render({
      ...IN_PROGRESS,
      errorEvidence: {
        mergeConflict: {
          baseRef: 'origin/main',
          conflictedPaths: ['CLAUDE.md', 'package.json', 'package-lock.json'],
        },
      },
    });
    const lines = body.split('\n');
    const claudeIdx = lines.findIndex((l) => l === '- `CLAUDE.md`');
    const pjIdx = lines.findIndex((l) => l === '- `package.json`');
    const plIdx = lines.findIndex((l) => l === '- `package-lock.json`');
    expect(claudeIdx).toBeGreaterThan(-1);
    expect(pjIdx).toBeGreaterThan(claudeIdx);
    expect(plIdx).toBeGreaterThan(pjIdx);
  });

  it('header count matches path count', async () => {
    const body = await render({
      ...IN_PROGRESS,
      errorEvidence: {
        mergeConflict: {
          baseRef: 'origin/main',
          conflictedPaths: ['a', 'b', 'c', 'd'],
        },
      },
    });
    expect(body).toContain('<details><summary>Conflicted paths (4)</summary>');
  });

  it('renders horizontal rule above the block', async () => {
    const body = await render({
      ...IN_PROGRESS,
      errorEvidence: {
        mergeConflict: {
          baseRef: 'origin/main',
          conflictedPaths: ['x.ts'],
        },
      },
    });
    const lines = body.split('\n');
    const hrIdx = lines.findIndex((l) => l === '---');
    const markerIdx = lines.findIndex(
      (l) => l === '**Merge conflict during base-sync**',
    );
    expect(hrIdx).toBeGreaterThan(-1);
    expect(markerIdx).toBe(hrIdx + 1);
  });

  it('bytes above the `---` are unchanged from the no-evidence render (#847 regression guard)', async () => {
    const withoutEvidence = await render(IN_PROGRESS);
    const withEvidence = await render({
      ...IN_PROGRESS,
      errorEvidence: {
        mergeConflict: { baseRef: 'origin/main', conflictedPaths: ['x.ts'] },
      },
    });
    // Take everything up to and NOT including the first `---` that begins the block
    // in the with-evidence render, and compare to the no-evidence render.
    const withHrIdx = withEvidence.indexOf('\n---\n');
    const withoutHrIdx = withoutEvidence.indexOf('\n---\n');
    // No pre-existing --- in either output (the block adds the first one)
    const prelude = withHrIdx === -1 ? withEvidence : withEvidence.slice(0, withHrIdx);
    const baseline = withoutHrIdx === -1 ? withoutEvidence : withoutEvidence.slice(0, withoutHrIdx);
    expect(prelude.trimEnd()).toBe(baseline.trimEnd());
  });

  it('empty conflictedPaths renders the no-paths fallback with header count 0', async () => {
    const body = await render({
      ...IN_PROGRESS,
      errorEvidence: {
        mergeConflict: { baseRef: 'origin/main', conflictedPaths: [] },
      },
    });
    expect(body).toContain('<details><summary>Conflicted paths (0)</summary>');
    expect(body).toContain(
      '- (no paths reported — merge failed for a non-conflict reason)',
    );
  });
});

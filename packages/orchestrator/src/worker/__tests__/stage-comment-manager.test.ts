import { vi, describe, it, expect } from 'vitest';
import { StageCommentManager } from '../stage-comment-manager.js';
import type { GitHubClient } from '@generacy-ai/workflow-engine';
import type { StageCommentData, Logger } from '../types.js';
import { STAGE_MARKERS } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeLogger(): Logger & { warn: ReturnType<typeof vi.fn> } {
  const warn = vi.fn();
  return {
    info: vi.fn(),
    warn,
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => makeLogger()),
  } as unknown as Logger & { warn: ReturnType<typeof vi.fn> };
}

/**
 * Render a StageCommentData through the real renderer by capturing the body
 * passed to the GitHubClient. Avoids reaching into private renderStageComment.
 */
async function render(
  data: StageCommentData,
  logger: Logger = makeLogger(),
): Promise<string> {
  let captured = '';
  const github: GitHubClient = {
    getIssueComments: vi.fn().mockResolvedValue([{ id: 1, body: STAGE_MARKERS[data.stage] }]),
    updateComment: vi.fn().mockImplementation(async (_o: string, _r: string, _id: number, body: string) => {
      captured = body;
      return undefined;
    }),
    addIssueComment: vi.fn(),
  } as unknown as GitHubClient;

  const manager = new StageCommentManager(github, 'owner', 'repo', 1, logger);
  await manager.updateStageComment(data);
  return captured;
}

const BASE_COMPLETE: StageCommentData = {
  stage: 'implementation',
  status: 'complete',
  phases: [
    {
      phase: 'implement',
      status: 'complete',
      startedAt: '2026-07-08T00:00:00Z',
      completedAt: '2026-07-08T00:05:00Z',
    },
  ],
  startedAt: '2026-07-08T00:00:00Z',
  completedAt: '2026-07-08T00:05:00Z',
  prUrl: 'https://github.com/owner/repo/pull/5',
};

const BASE_ERROR: StageCommentData = {
  stage: 'implementation',
  status: 'error',
  phases: [
    {
      phase: 'validate',
      status: 'error',
      startedAt: '2026-07-08T00:00:00Z',
    },
  ],
  startedAt: '2026-07-08T00:00:00Z',
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('StageCommentManager.renderStageComment', () => {
  it('renders happy path (status: complete) unchanged — no evidence block', async () => {
    const body = await render(BASE_COMPLETE);
    expect(body).toContain('**Status**: ✅ Complete');
    expect(body).toContain('**PR**: https://github.com/owner/repo/pull/5');
    // Horizontal-rule separator '\n---\n' (not the table-header row) is absent.
    expect(body).not.toContain('\n---\n');
    expect(body).not.toContain('**Failed command**');
    expect(body).not.toContain('<details>');
  });

  it('renders a numeric-exit failure with full evidence block', async () => {
    const body = await render({
      ...BASE_ERROR,
      errorEvidence: {
        command: 'pnpm install',
        exitDescriptor: 'exit 1',
        stderrTail: 'ELIFECYCLE Command failed with exit code 1',
      },
    });
    expect(body).toContain('---');
    expect(body).toContain('**Failed command**: `pnpm install`');
    expect(body).toContain('**Exit**: exit 1');
    expect(body).toContain('<details><summary>stderr (last 1 lines)</summary>');
    expect(body).toContain('```text\nELIFECYCLE Command failed with exit code 1\n```');
    expect(body).toContain('</details>');
  });

  it('renders a timeout failure verbatim descriptor', async () => {
    const body = await render({
      ...BASE_ERROR,
      errorEvidence: {
        command: 'pnpm test',
        exitDescriptor: 'killed (SIGTERM) after 300000ms',
        stderrTail: 'still running…',
      },
    });
    expect(body).toContain('**Exit**: killed (SIGTERM) after 300000ms');
  });

  it('renders an abort failure with empty-stderr literal inside the fenced block', async () => {
    const body = await render({
      ...BASE_ERROR,
      errorEvidence: {
        command: 'validate',
        exitDescriptor: 'aborted',
        stderrTail: '(stderr empty)',
      },
    });
    expect(body).toContain('**Exit**: aborted');
    expect(body).toContain('```text\n(stderr empty)\n```');
  });

  it('surfaces a truncation marker as the first line of the fenced block', async () => {
    const marker = '… truncated (kept last 30 lines / 4096 bytes) …';
    const body = await render({
      ...BASE_ERROR,
      errorEvidence: {
        command: 'pnpm test',
        exitDescriptor: 'exit 1',
        stderrTail: `${marker}\nline body`,
      },
    });
    // The marker line appears immediately after the ```text opener.
    expect(body).toContain(`\`\`\`text\n${marker}\nline body\n\`\`\``);
  });

  it('neutralizes backtick-poisoned stderr so the fenced block stays closed', async () => {
    const body = await render({
      ...BASE_ERROR,
      errorEvidence: {
        command: 'echo',
        exitDescriptor: 'exit 1',
        stderrTail: 'before\n```\nafter',
      },
    });
    // The literal ``` sequence must not appear inside the fenced block body
    // (the substitution inserts a ZWSP between the first two backticks).
    // Find the opener ```text and the closer ```, then confirm no ``` between them.
    const openerIdx = body.indexOf('```text');
    // Skip past the opener (```text plus newline) before searching for a rogue ```.
    const afterOpener = openerIdx + '```text\n'.length;
    const closerIdx = body.indexOf('\n```', afterOpener);
    const inner = body.slice(afterOpener, closerIdx);
    expect(inner.includes('```')).toBe(false);
    // The ZWSP-injected form is present.
    expect(inner).toContain('`​``');
  });

  it('omits the block and logs a warning when errorEvidence is missing on error status', async () => {
    const logger = makeLogger();
    const body = await render(BASE_ERROR, logger);
    expect(body).not.toContain('\n---\n');
    expect(body).not.toContain('**Failed command**');
    expect((logger.warn as any).mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it('keeps the HTML STAGE_MARKERS entry as the first line of the comment body', async () => {
    const bodyComplete = await render(BASE_COMPLETE);
    expect(bodyComplete.split('\n')[0]).toBe(STAGE_MARKERS.implementation);

    const bodyError = await render({
      ...BASE_ERROR,
      errorEvidence: { command: 'x', exitDescriptor: 'exit 1', stderrTail: 'y' },
    });
    expect(bodyError.split('\n')[0]).toBe(STAGE_MARKERS.implementation);
  });
});

import { vi, describe, it, expect } from 'vitest';
import { StageCommentManager } from '../stage-comment-manager.js';
import type { GitHubClient } from '@generacy-ai/workflow-engine';
import type { StageCommentData, Logger, FailureAlertData } from '../types.js';
import { STAGE_MARKERS, FAILURE_ALERT_MARKER_PREFIX } from '../types.js';

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
        outputTail: 'ELIFECYCLE Command failed with exit code 1',
      },
    });
    expect(body).toContain('---');
    expect(body).toContain('**Failed command**: `pnpm install`');
    expect(body).toContain('**Exit**: exit 1');
    expect(body).toContain('<details><summary>output (last 1 lines)</summary>');
    expect(body).toContain('```text\nELIFECYCLE Command failed with exit code 1\n```');
    expect(body).toContain('</details>');
  });

  it('renders a timeout failure verbatim descriptor', async () => {
    const body = await render({
      ...BASE_ERROR,
      errorEvidence: {
        command: 'pnpm test',
        exitDescriptor: 'killed (SIGTERM) after 300000ms',
        outputTail: 'still running…',
      },
    });
    expect(body).toContain('**Exit**: killed (SIGTERM) after 300000ms');
  });

  it('renders an abort failure with both-empty literal inside the fenced block', async () => {
    const body = await render({
      ...BASE_ERROR,
      errorEvidence: {
        command: 'validate',
        exitDescriptor: 'aborted',
        outputTail: '(no output on either stream)',
      },
    });
    expect(body).toContain('**Exit**: aborted');
    expect(body).toContain('```text\n(no output on either stream)\n```');
    // SC-003: no `(empty)` substring anywhere in the rendered body.
    expect(body).not.toContain('(empty)');
  });

  it('surfaces a truncation marker as the first line of the fenced block', async () => {
    const marker = '… truncated (kept last 30 lines / 4096 bytes) …';
    const body = await render({
      ...BASE_ERROR,
      errorEvidence: {
        command: 'pnpm test',
        exitDescriptor: 'exit 1',
        outputTail: `${marker}\nline body`,
      },
    });
    // The marker line appears immediately after the ```text opener.
    expect(body).toContain(`\`\`\`text\n${marker}\nline body\n\`\`\``);
  });

  it('neutralizes backtick-poisoned output so the fenced block stays closed', async () => {
    const body = await render({
      ...BASE_ERROR,
      errorEvidence: {
        command: 'echo',
        exitDescriptor: 'exit 1',
        outputTail: 'before\n```\nafter',
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
      errorEvidence: { command: 'x', exitDescriptor: 'exit 1', outputTail: 'y' },
    });
    expect(bodyError.split('\n')[0]).toBe(STAGE_MARKERS.implementation);
  });
});

// ---------------------------------------------------------------------------
// postFailureAlert helper + fixtures
// ---------------------------------------------------------------------------

const TEST_RUN_ID = '9e5c8a0d-755e-40b3-b0c3-43e849f0bb90';

function makeAlertGithub(existingComments: { id: number; body: string }[] = []): {
  github: GitHubClient;
  getIssueComments: ReturnType<typeof vi.fn>;
  addIssueComment: ReturnType<typeof vi.fn>;
  updateComment: ReturnType<typeof vi.fn>;
  lastAddedBody: () => string;
} {
  let lastBody = '';
  const getIssueComments = vi.fn().mockResolvedValue(existingComments);
  const addIssueComment = vi.fn().mockImplementation(
    async (_o: string, _r: string, _i: number, body: string) => {
      lastBody = body;
      return { id: 999 };
    },
  );
  const updateComment = vi.fn().mockResolvedValue(undefined);
  const github = {
    getIssueComments,
    addIssueComment,
    updateComment,
  } as unknown as GitHubClient;
  return { github, getIssueComments, addIssueComment, updateComment, lastAddedBody: () => lastBody };
}

// #942: 16-char hex fingerprint fixture for BASE_ALERT. Test-only sentinel,
// deliberately readable so failing golden strings surface the marker cleanly.
const TEST_FINGERPRINT = 'abcdef1234567890';

const BASE_ALERT: FailureAlertData = {
  stage: 'implementation',
  runId: TEST_RUN_ID,
  phase: 'validate',
  evidence: {
    command: 'pnpm test',
    exitDescriptor: 'exit 1',
    outputTail: 'npm error Missing script: "test"',
  },
  fingerprint: TEST_FINGERPRINT,
  occurrence: 1,
};

describe('StageCommentManager.postFailureAlert', () => {
  it('posts new comment with correct body bytes on first-time occurrence', async () => {
    const { github, addIssueComment, lastAddedBody } = makeAlertGithub();
    const logger = makeLogger();
    const manager = new StageCommentManager(github, 'owner', 'repo', 42, logger);

    await manager.postFailureAlert(BASE_ALERT);

    expect(addIssueComment).toHaveBeenCalledTimes(1);
    const expected = [
      `<!-- generacy:failure-alert:implementation:${TEST_RUN_ID} --> <!-- fp:${TEST_FINGERPRINT}:1 -->`,
      '❌ **validate failed** — `pnpm test` exit 1.',
      '',
      '<details><summary>output (last 1 lines)</summary>',
      '',
      '```text',
      'npm error Missing script: "test"',
      '```',
      '',
      '</details>',
    ].join('\n');
    expect(lastAddedBody()).toBe(expected);
  });

  it('dedup — matching marker in existing comments → NO addIssueComment call, info log', async () => {
    const marker = `<!-- generacy:failure-alert:implementation:${TEST_RUN_ID} -->`;
    const { github, addIssueComment } = makeAlertGithub([{ id: 42, body: `${marker}\nprior alert body` }]);
    const logger = makeLogger();
    const manager = new StageCommentManager(github, 'owner', 'repo', 42, logger);

    await manager.postFailureAlert(BASE_ALERT);

    expect(addIssueComment).not.toHaveBeenCalled();
    const infoCalls = (logger.info as any).mock.calls;
    const dedupCall = infoCalls.find((call: any[]) =>
      typeof call[1] === 'string' && call[1] === 'Failure alert already exists — suppressing duplicate post',
    );
    expect(dedupCall).toBeDefined();
    expect(dedupCall[0]).toMatchObject({ existingCommentId: 42 });
  });

  it('renders timeout exitDescriptor verbatim in the summary line', async () => {
    const { github, lastAddedBody } = makeAlertGithub();
    const manager = new StageCommentManager(github, 'owner', 'repo', 42, makeLogger());

    await manager.postFailureAlert({
      ...BASE_ALERT,
      evidence: {
        command: 'pnpm test',
        exitDescriptor: 'killed (SIGTERM) after 300000ms',
        outputTail: 'still running…',
      },
    });

    expect(lastAddedBody()).toContain(
      '❌ **validate failed** — `pnpm test` killed (SIGTERM) after 300000ms.',
    );
  });

  it('renders abort exitDescriptor + both-empty literal inside the fenced block', async () => {
    const { github, lastAddedBody } = makeAlertGithub();
    const manager = new StageCommentManager(github, 'owner', 'repo', 42, makeLogger());

    await manager.postFailureAlert({
      ...BASE_ALERT,
      evidence: {
        command: 'validate',
        exitDescriptor: 'aborted',
        outputTail: '(no output on either stream)',
      },
    });

    const body = lastAddedBody();
    expect(body).toContain('❌ **validate failed** — `validate` aborted.');
    expect(body).toContain('```text\n(no output on either stream)\n```');
    // SC-003: no `(empty)` substring anywhere in the rendered alert body.
    expect(body).not.toContain('(empty)');
  });

  it('neutralizes backtick-poisoned output so the outer fenced block stays closed', async () => {
    const { github, lastAddedBody } = makeAlertGithub();
    const manager = new StageCommentManager(github, 'owner', 'repo', 42, makeLogger());

    await manager.postFailureAlert({
      ...BASE_ALERT,
      evidence: {
        command: 'echo',
        exitDescriptor: 'exit 1',
        outputTail: 'before\n```\nafter',
      },
    });

    const body = lastAddedBody();
    const openerIdx = body.indexOf('```text');
    const afterOpener = openerIdx + '```text\n'.length;
    const closerIdx = body.indexOf('\n```', afterOpener);
    const inner = body.slice(afterOpener, closerIdx);
    expect(inner.includes('```')).toBe(false);
    expect(inner).toContain('`​``');
  });

  it('renders truncated output unchanged inside the fenced block', async () => {
    const marker = '… truncated (kept last 30 lines / 4096 bytes) …';
    const { github, lastAddedBody } = makeAlertGithub();
    const manager = new StageCommentManager(github, 'owner', 'repo', 42, makeLogger());

    await manager.postFailureAlert({
      ...BASE_ALERT,
      evidence: {
        command: 'pnpm test',
        exitDescriptor: 'exit 1',
        outputTail: `${marker}\nline body`,
      },
    });

    expect(lastAddedBody()).toContain(`\`\`\`text\n${marker}\nline body\n\`\`\``);
  });

  it('marker shape matches the contract regex on the first line (#942 v2)', async () => {
    const { github, lastAddedBody } = makeAlertGithub();
    const manager = new StageCommentManager(github, 'owner', 'repo', 42, makeLogger());

    await manager.postFailureAlert(BASE_ALERT);

    const firstLine = lastAddedBody().split('\n')[0];
    // #942 INV-C1: v1 marker + single space + v2 marker.
    expect(firstLine).toMatch(
      /^<!-- generacy:failure-alert:(specification|planning|implementation):[0-9a-f-]{36} --> <!-- fp:[0-9a-f]{16}:\d+ -->$/,
    );
    // #942 INV-C2: exactly one space between the two markers.
    expect(firstLine).toContain(' --> <!-- fp:');
    expect(firstLine).not.toContain('  --> <!-- fp:');
    expect(firstLine!.startsWith(FAILURE_ALERT_MARKER_PREFIX)).toBe(true);
  });

  it('#942 — v2 fingerprint marker carries the runtime fingerprint + occurrence', async () => {
    const { github, lastAddedBody } = makeAlertGithub();
    const manager = new StageCommentManager(github, 'owner', 'repo', 42, makeLogger());

    await manager.postFailureAlert({
      ...BASE_ALERT,
      fingerprint: '9c4d3e2a1b0f8a7b',
      occurrence: 2,
    });

    const firstLine = lastAddedBody().split('\n')[0];
    expect(firstLine).toBe(
      `<!-- generacy:failure-alert:implementation:${TEST_RUN_ID} --> <!-- fp:9c4d3e2a1b0f8a7b:2 -->`,
    );
  });

  it('#942 — INV-C3 body lines 2+ unchanged when only fingerprint / occurrence differ', async () => {
    const { github, lastAddedBody: bodyA } = makeAlertGithub();
    const mgrA = new StageCommentManager(github, 'owner', 'repo', 42, makeLogger());
    await mgrA.postFailureAlert({ ...BASE_ALERT, fingerprint: '1111111111111111', occurrence: 1 });
    const a = bodyA();

    const { github: g2, lastAddedBody: bodyB } = makeAlertGithub();
    const mgrB = new StageCommentManager(g2, 'owner', 'repo', 42, makeLogger());
    await mgrB.postFailureAlert({ ...BASE_ALERT, fingerprint: '2222222222222222', occurrence: 5 });
    const b = bodyB();

    // Only line 1 differs; body lines 2+ are byte-identical.
    const linesA = a.split('\n');
    const linesB = b.split('\n');
    expect(linesA.length).toBe(linesB.length);
    for (let i = 1; i < linesA.length; i++) {
      expect(linesB[i]).toBe(linesA[i]);
    }
  });

  it('does not alter the canonical stage comment (FR-008)', async () => {
    // Render a stage comment first (captures body), then post a failure alert,
    // then re-render and assert byte-identity.
    const before = await render({
      ...BASE_ERROR,
      errorEvidence: {
        command: 'pnpm test',
        exitDescriptor: 'exit 1',
        outputTail: 'oops',
      },
    });

    const { github } = makeAlertGithub();
    const manager = new StageCommentManager(github, 'owner', 'repo', 42, makeLogger());
    await manager.postFailureAlert(BASE_ALERT);

    const after = await render({
      ...BASE_ERROR,
      errorEvidence: {
        command: 'pnpm test',
        exitDescriptor: 'exit 1',
        outputTail: 'oops',
      },
    });

    expect(after).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// #915: classifier-reason block rendering (both surfaces, lockstep invariant)
// ---------------------------------------------------------------------------

/**
 * Extract the reason-block substring from a rendered body — bytes from the
 * `**Reason**` line through (but excluding) the blank line preceding
 * `<details>`. Used by the lockstep invariant test to prove both renderers
 * emit identical bytes for the same evidence.
 */
function extractReasonBlock(body: string): string {
  const start = body.indexOf('**Reason**');
  if (start === -1) return '';
  const detailsIdx = body.indexOf('<details>', start);
  // The two lines immediately preceding `<details>` are (a) the trailing line
  // of the reason block and (b) the blank separator. Slice up to the blank.
  const blankBeforeDetails = body.lastIndexOf('\n\n', detailsIdx);
  return body.slice(start, blankBeforeDetails);
}

describe('#915 — stage comment reason block (appendEvidenceBlock)', () => {
  it('renders a single-line reason inline between **Exit** and <details>', async () => {
    const body = await render({
      ...BASE_ERROR,
      errorEvidence: {
        command: 'implement',
        exitDescriptor: 'failed post-exit: no-progress (process exit 0)',
        outputTail: 'no progress: tasks_remaining stayed at 5 across two increments',
        reason: 'Implement increment made no progress — aborting to prevent infinite loop',
      },
    });
    expect(body).toContain(
      '**Exit**: failed post-exit: no-progress (process exit 0)\n' +
        '**Reason**: Implement increment made no progress — aborting to prevent infinite loop\n' +
        '\n' +
        '<details>',
    );
    // Regression: exit descriptor is honest (not `exit 0`).
    expect(body).not.toContain('**Exit**: exit 0');
  });

  it('renders a multi-line reason as a fenced ```text``` block above <details>', async () => {
    const multiLine = 'first line\nsecond line\nthird line';
    const body = await render({
      ...BASE_ERROR,
      errorEvidence: {
        command: 'implement',
        exitDescriptor: 'failed post-exit: product-diff-error (process exit 0)',
        outputTail: '(no output on either stream)',
        reason: multiLine,
      },
    });
    // The `**Reason**:` line stands alone, followed by blank + fenced block.
    expect(body).toContain(
      '**Exit**: failed post-exit: product-diff-error (process exit 0)\n' +
        '**Reason**:\n' +
        '\n' +
        '```text\n' +
        multiLine +
        '\n```\n' +
        '\n' +
        '<details>',
    );
  });

  it('caps a >1 KiB multi-line reason at 1024 bytes with a … marker before the closing fence', async () => {
    // Force multi-line: 32 lines × ~40 chars = 1280+ bytes.
    const line = 'padding padding padding padding padding\n';
    const raw = line.repeat(40); // > 1 KiB and multi-line
    expect(Buffer.byteLength(raw, 'utf8')).toBeGreaterThan(1024);

    const body = await render({
      ...BASE_ERROR,
      errorEvidence: {
        command: 'implement',
        exitDescriptor: 'failed post-exit: product-diff-error (process exit 0)',
        outputTail: '(no output on either stream)',
        reason: raw,
      },
    });

    // Reason block must end with `…\n\`\`\`\n` per contract §Rendering normalization.
    // Extract the fenced text block that follows `**Reason**:`.
    const reasonStart = body.indexOf('**Reason**:');
    const fenceOpen = body.indexOf('```text', reasonStart);
    const fenceClose = body.indexOf('\n```', fenceOpen + '```text'.length);
    const fencedBody = body.slice(fenceOpen + '```text\n'.length, fenceClose);
    // Byte length of the sliced text (before the trailing … marker) must be ≤ 1024.
    // The truncation marker `…` sits on its own line at the tail.
    expect(fencedBody.endsWith('\n…')).toBe(true);
    const beforeMarker = fencedBody.slice(0, -2); // strip '\n…'
    expect(Buffer.byteLength(beforeMarker, 'utf8')).toBeLessThanOrEqual(1024);
  });

  it('ZWSP-escapes backticks in reason so the reason line stays inside markdown-safe bytes', async () => {
    const reason = 'a `token` in the middle';
    const body = await render({
      ...BASE_ERROR,
      errorEvidence: {
        command: 'implement',
        exitDescriptor: 'failed post-exit: no-progress (process exit 0)',
        outputTail: 'x',
        reason,
      },
    });
    // Backtick → backtick + ZWSP. Raw literal backtick is not preserved as-is.
    expect(body).toContain('**Reason**: a `​token`​ in the middle');
  });

  it('omits the reason block entirely for absent reason — output byte-identical to #890 shape', async () => {
    const withoutReason = await render({
      ...BASE_ERROR,
      errorEvidence: {
        command: 'pnpm test',
        exitDescriptor: 'exit 1',
        outputTail: 'oops',
      },
    });
    const withUndefined = await render({
      ...BASE_ERROR,
      errorEvidence: {
        command: 'pnpm test',
        exitDescriptor: 'exit 1',
        outputTail: 'oops',
        reason: undefined,
      },
    });
    const withEmpty = await render({
      ...BASE_ERROR,
      errorEvidence: {
        command: 'pnpm test',
        exitDescriptor: 'exit 1',
        outputTail: 'oops',
        reason: '',
      },
    });
    // All three renderings must be byte-identical (invariant 4 of the contract).
    expect(withUndefined).toBe(withoutReason);
    expect(withEmpty).toBe(withoutReason);
    // And the reason marker must not appear at all.
    expect(withoutReason).not.toContain('**Reason**');
  });
});

describe('#915 — failure alert reason block (renderFailureAlert)', () => {
  it('renders a single-line reason inline between the summary and <details>', async () => {
    const { github, lastAddedBody } = makeAlertGithub();
    const manager = new StageCommentManager(github, 'owner', 'repo', 42, makeLogger());

    await manager.postFailureAlert({
      ...BASE_ALERT,
      phase: 'implement',
      evidence: {
        command: 'implement (no-progress guard)',
        exitDescriptor: 'failed post-exit: no-progress (process exit 0)',
        outputTail: 'no progress: tasks_remaining stayed at 5 across two increments',
        reason: 'Implement increment made no progress — aborting to prevent infinite loop',
      },
    });

    const body = lastAddedBody();
    expect(body).toContain(
      '❌ **implement failed** — `implement (no-progress guard)` failed post-exit: no-progress (process exit 0).\n' +
        '**Reason**: Implement increment made no progress — aborting to prevent infinite loop\n' +
        '\n' +
        '<details>',
    );
    expect(body).not.toContain('exit 0.\n');
  });

  it('renders a multi-line reason fenced above the outputTail block', async () => {
    const { github, lastAddedBody } = makeAlertGithub();
    const manager = new StageCommentManager(github, 'owner', 'repo', 42, makeLogger());
    const multiLine = 'line-a\nline-b';

    await manager.postFailureAlert({
      ...BASE_ALERT,
      evidence: {
        command: 'implement',
        exitDescriptor: 'failed post-exit: product-diff-error (process exit 0)',
        outputTail: '(no output on either stream)',
        reason: multiLine,
      },
    });

    const body = lastAddedBody();
    expect(body).toContain('**Reason**:\n\n```text\n' + multiLine + '\n```\n\n<details>');
  });

  it('omits the reason block entirely for absent reason — output byte-identical to #865 shape', async () => {
    const { github, lastAddedBody: getA } = makeAlertGithub();
    const managerA = new StageCommentManager(github, 'owner', 'repo', 42, makeLogger());
    await managerA.postFailureAlert(BASE_ALERT);
    const withoutReason = getA();

    const { github: gh2, lastAddedBody: getB } = makeAlertGithub();
    const managerB = new StageCommentManager(gh2, 'owner', 'repo', 42, makeLogger());
    await managerB.postFailureAlert({
      ...BASE_ALERT,
      evidence: { ...BASE_ALERT.evidence, reason: undefined },
    });
    const withUndefined = getB();

    expect(withUndefined).toBe(withoutReason);
    expect(withoutReason).not.toContain('**Reason**');
  });
});

describe('#915 — lockstep invariant across both renderers', () => {
  it('appendEvidenceBlock and renderFailureAlert emit byte-identical reason-block substrings', async () => {
    // Same evidence fed through both surfaces — the reason-block bytes (from
    // `**Reason**` through the pre-<details> blank line) must match exactly.
    const evidence = {
      command: 'implement',
      exitDescriptor: 'failed post-exit: no-product-code-changes (process exit 0)',
      outputTail: '(no output on either stream)',
      reason:
        'Phase "implement" produced no product-code changes — all changed files are under excluded prefixes [specs/].',
    };

    const stageBody = await render({
      ...BASE_ERROR,
      errorEvidence: evidence,
    });

    const { github, lastAddedBody } = makeAlertGithub();
    const manager = new StageCommentManager(github, 'owner', 'repo', 42, makeLogger());
    await manager.postFailureAlert({
      ...BASE_ALERT,
      evidence,
    });
    const alertBody = lastAddedBody();

    const stageBlock = extractReasonBlock(stageBody);
    const alertBlock = extractReasonBlock(alertBody);
    expect(stageBlock).not.toBe('');
    expect(alertBlock).toBe(stageBlock);
  });

  it('appendEvidenceBlock and renderFailureAlert produce identical multi-line + capped reason blocks', async () => {
    const line = 'padding padding padding padding\n';
    const reason = line.repeat(40);
    const evidence = {
      command: 'implement',
      exitDescriptor: 'failed post-exit: product-diff-error (process exit 0)',
      outputTail: '(no output on either stream)',
      reason,
    };

    const stageBody = await render({
      ...BASE_ERROR,
      errorEvidence: evidence,
    });

    const { github, lastAddedBody } = makeAlertGithub();
    const manager = new StageCommentManager(github, 'owner', 'repo', 42, makeLogger());
    await manager.postFailureAlert({
      ...BASE_ALERT,
      evidence,
    });
    const alertBody = lastAddedBody();

    expect(extractReasonBlock(alertBody)).toBe(extractReasonBlock(stageBody));
  });
});

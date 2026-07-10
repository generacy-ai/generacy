/**
 * FR-006 / FR-003 regression coverage — LabelManager retry exhaustion
 * throws `TerminalLabelOpError` with the correct `site`, `labelOp`, `ghStderr`,
 * and preserved `cause` at each of the six retry sites.
 */
import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { GitHubClient } from '@generacy-ai/workflow-engine';
import { LabelManager } from '../label-manager.js';
import { isTerminalLabelOpError, TerminalLabelOpError } from '../terminal-label-op-error.js';
import type { Logger } from '../types.js';

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: () => mockLogger,
};

function makeGithub() {
  return {
    getIssue: vi.fn().mockResolvedValue({ labels: [] }),
    addLabels: vi.fn().mockResolvedValue(undefined),
    removeLabels: vi.fn().mockResolvedValue(undefined),
    listLabels: vi.fn().mockResolvedValue([]),
    createLabel: vi.fn().mockResolvedValue(undefined),
  };
}

function createLabelManager(github: ReturnType<typeof makeGithub>): LabelManager {
  return new LabelManager(
    github as unknown as GitHubClient,
    'owner',
    'repo',
    99,
    mockLogger as unknown as Logger,
  );
}

/** Skip real backoff sleeps so 3 retries finish immediately. */
function neutralizeSleep(lm: LabelManager): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (lm as any).sleep = vi.fn().mockResolvedValue(undefined);
}

describe('LabelManager terminal error propagation (FR-003)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockLogger.info.mockReset();
    mockLogger.warn.mockReset();
    mockLogger.error.mockReset();
    mockLogger.debug.mockReset();
    LabelManager.resetEnsureCacheForTests();
  });

  it('throws TerminalLabelOpError with site=phase-start on onPhaseStart exhaustion', async () => {
    const github = makeGithub();
    const cause = new Error("gh: label 'phase:plan' not found");
    github.addLabels.mockRejectedValue(cause);

    const lm = createLabelManager(github);
    neutralizeSleep(lm);

    const err = await lm.onPhaseStart('plan').catch((e) => e);
    expect(isTerminalLabelOpError(err)).toBe(true);
    const t = err as TerminalLabelOpError;
    expect(t.site).toBe('phase-start');
    expect(t.labelOp).toContain('phase:plan');
    expect(t.ghStderr).toContain('phase:plan');
    expect(t.cause).toBe(cause);
  });

  it('throws TerminalLabelOpError with site=phase-complete on onPhaseComplete exhaustion', async () => {
    const github = makeGithub();
    github.addLabels.mockRejectedValue(new Error('gh: label not found'));

    const lm = createLabelManager(github);
    neutralizeSleep(lm);

    const err = await lm.onPhaseComplete('plan').catch((e) => e);
    expect(isTerminalLabelOpError(err)).toBe(true);
    expect((err as TerminalLabelOpError).site).toBe('phase-complete');
    expect((err as TerminalLabelOpError).labelOp).toContain('completed:plan');
  });

  it('throws TerminalLabelOpError with site=gate-hit on onGateHit exhaustion', async () => {
    const github = makeGithub();
    github.addLabels.mockRejectedValue(
      new Error("could not add label: 'waiting-for:merge-conflicts' not found"),
    );

    const lm = createLabelManager(github);
    neutralizeSleep(lm);

    const err = await lm.onGateHit('implement', 'waiting-for:merge-conflicts').catch((e) => e);
    expect(isTerminalLabelOpError(err)).toBe(true);
    const t = err as TerminalLabelOpError;
    expect(t.site).toBe('gate-hit');
    expect(t.labelOp).toContain('waiting-for:merge-conflicts');
    expect(t.labelOp).toContain('agent:paused');
    expect(t.ghStderr).toContain("'waiting-for:merge-conflicts' not found");
  });

  it('throws TerminalLabelOpError with site=error on onError exhaustion', async () => {
    const github = makeGithub();
    github.addLabels.mockRejectedValue(new Error('gh: label not found'));

    const lm = createLabelManager(github);
    neutralizeSleep(lm);

    const err = await lm.onError('implement').catch((e) => e);
    expect(isTerminalLabelOpError(err)).toBe(true);
    expect((err as TerminalLabelOpError).site).toBe('error');
    expect((err as TerminalLabelOpError).labelOp).toContain('failed:implement');
    expect((err as TerminalLabelOpError).labelOp).toContain('agent:error');
  });

  it('throws TerminalLabelOpError with site=resume-start on onResumeStart exhaustion', async () => {
    const github = makeGithub();
    github.addLabels.mockRejectedValue(new Error('gh: label not found'));

    const lm = createLabelManager(github);
    neutralizeSleep(lm);

    const err = await lm.onResumeStart().catch((e) => e);
    expect(isTerminalLabelOpError(err)).toBe(true);
    expect((err as TerminalLabelOpError).site).toBe('resume-start');
    expect((err as TerminalLabelOpError).labelOp).toContain('agent:in-progress');
  });

  it('throws TerminalLabelOpError with site=workflow-complete on onWorkflowComplete exhaustion', async () => {
    const github = makeGithub();
    github.removeLabels.mockRejectedValue(new Error('gh: 500 internal error'));

    const lm = createLabelManager(github);
    neutralizeSleep(lm);

    const err = await lm.onWorkflowComplete().catch((e) => e);
    expect(isTerminalLabelOpError(err)).toBe(true);
    expect((err as TerminalLabelOpError).site).toBe('workflow-complete');
    expect((err as TerminalLabelOpError).labelOp).toContain('agent:in-progress');
    expect((err as TerminalLabelOpError).ghStderr).toContain('500');
  });
});

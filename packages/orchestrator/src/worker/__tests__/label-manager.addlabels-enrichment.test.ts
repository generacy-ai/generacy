/**
 * #916 FR-008 / SC-007: `addLabels` enrichment via the lineage map.
 *
 * When the ensure-pass classified a provisioning failure and the subsequent
 * `addLabels` call 404s for that same label, the thrown error's message gets
 * `label "<name>": <cause> (HTTP <statusCode>)` spliced in so the operator sees
 * the provisioning cause inline. Cross-process gaps (map miss) rethrow the raw
 * 404 unchanged.
 */
import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { GitHubClient } from '@generacy-ai/workflow-engine';
import { LabelManager } from '../label-manager.js';
import { TerminalLabelOpError } from '../terminal-label-op-error.js';
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
    'test-owner',
    'test-repo',
    42,
    mockLogger as unknown as Logger,
  );
}

describe('LabelManager addLabels enrichment (#916 FR-008)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockLogger.info.mockReset();
    mockLogger.warn.mockReset();
    mockLogger.error.mockReset();
    mockLogger.debug.mockReset();
    LabelManager.resetEnsureCacheForTests();
  });

  it('same-process 404: enriches thrown error with provisioning cause', async () => {
    const github = makeGithub();
    github.listLabels.mockResolvedValue([]);
    // Prime lineage: the ensure-pass classifies a 422 on blocked:stuck-feedback-loop.
    github.createLabel.mockImplementation(async (_owner, _repo, name: string) => {
      if (name === 'blocked:stuck-feedback-loop') {
        throw new Error(
          'Failed to create label blocked:stuck-feedback-loop: HTTP 422: Validation Failed\ndescription is too long (maximum is 100 characters)',
        );
      }
    });
    // The subsequent apply request for [blocked:stuck-feedback-loop, agent:paused]
    // 404s because the label was never actually created.
    github.addLabels.mockRejectedValue(new Error('HTTP 404: Not Found'));

    const lm = createLabelManager(github);

    // onGateHit's applyLabels call ends up requesting [gateLabel, 'agent:paused'].
    // Using 'blocked:stuck-feedback-loop' as the gateLabel targets the primed
    // lineage entry so the enrichment loop matches on it.
    let caught: unknown;
    try {
      await lm.onGateHit('plan', 'blocked:stuck-feedback-loop');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(TerminalLabelOpError);
    const term = caught as TerminalLabelOpError;
    // The enriched message is spliced into the thrown Error's message, which
    // becomes retryWithBackoff's `ghStderr` field on the terminal error.
    expect(term.ghStderr).toContain('label "blocked:stuck-feedback-loop"');
    expect(term.ghStderr).toContain('description is too long');
    expect(term.ghStderr).toContain('HTTP 422');
    // The raw 404 line remains present after the enrichment prefix.
    expect(term.ghStderr).toContain('HTTP 404');
  });

  it('cross-process 404: rethrows raw 404 when lineage map is empty', async () => {
    const github = makeGithub();
    github.listLabels.mockResolvedValue([]);
    // No provisioning failure — every createLabel succeeds — so lineage is empty.
    github.createLabel.mockResolvedValue(undefined);
    // But the subsequent apply 404s anyway (simulating cross-process gap).
    github.addLabels.mockRejectedValue(new Error('HTTP 404: Not Found'));

    const lm = createLabelManager(github);

    let caught: unknown;
    try {
      await lm.onGateHit('plan', 'blocked:stuck-feedback-loop');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(TerminalLabelOpError);
    const term = caught as TerminalLabelOpError;
    // Raw 404 shows, no enrichment prefix.
    expect(term.ghStderr).toContain('HTTP 404');
    expect(term.ghStderr).not.toContain('label "blocked:stuck-feedback-loop":');
    expect(term.ghStderr).not.toContain('description is too long');
  });
});

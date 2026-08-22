/**
 * `LabelManager.onResumeStart()` resume-strip retain rule.
 *
 * The strip removes stale `waiting-for:*` + `agent:paused` and the paired
 * `completed:<X>` for every `waiting-for:<X>` present, EXCEPT the explicit
 * retain set the worker passes (`resolveResumeRetainSuffixes(config)`):
 *   - `remediation-limit` — always (consumed + removed by the phase-loop reset
 *     branch).
 *   - `implementation-review` — ONLY when `ciMergeGateEnabled` (the relocated
 *     gate's terminal no-op resume reads it).
 * Everything else — `ci`, `clarification`, `sibling-review`, the artifact
 * review gates — is stripped so the resumed phase can pause again (clarify
 * follow-ups; a validate re-pause must not leave a stale `completed:ci`).
 *
 * These assertions drive the real `onResumeStart()` (not a hand-injected label
 * set).
 */
import { vi, describe, it, expect, beforeEach } from 'vitest';
import {
  LabelManager,
  DEFAULT_RESUME_RETAIN_SUFFIXES,
  resolveResumeRetainSuffixes,
} from '../label-manager.js';
import type { GitHubClient } from '@generacy-ai/workflow-engine';
import type { Logger } from '../types.js';

// Every human-gate suffix the strip may encounter paired with a waiting-for.
const ALL_GATE_SUFFIXES = [
  'clarification',
  'spec-review',
  'clarification-review',
  'plan-review',
  'tasks-review',
  'implementation-review',
  'manual-validation',
  'remediation-limit',
  'ci',
  'sibling-review',
  'merge-conflicts',
] as const;

const mockGithub = {
  getIssue: vi.fn(),
  addLabels: vi.fn(),
  removeLabels: vi.fn(),
  listLabels: vi.fn(),
  createLabel: vi.fn(),
};

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: () => mockLogger,
};

function createLabelManager(): LabelManager {
  return new LabelManager(
    mockGithub as unknown as GitHubClient,
    'owner',
    'repo',
    42,
    mockLogger as unknown as Logger,
  );
}

function pairedLabels(): { name: string }[] {
  return [
    { name: 'agent:paused' },
    { name: 'workflow:speckit-feature' },
    { name: 'completed:specify' }, // non-gate phase completion, no waiting-for
    ...ALL_GATE_SUFFIXES.flatMap((s) => [
      { name: `waiting-for:${s}` },
      { name: `completed:${s}` },
    ]),
  ];
}

function removedLabels(): string[] {
  return (mockGithub.removeLabels.mock.calls[0]?.[3] as string[]) ?? [];
}

describe('resolveResumeRetainSuffixes', () => {
  it('retains only remediation-limit by default', () => {
    expect(DEFAULT_RESUME_RETAIN_SUFFIXES).toEqual(['remediation-limit']);
    expect(resolveResumeRetainSuffixes({})).toEqual(['remediation-limit']);
    expect(resolveResumeRetainSuffixes({ ciMergeGateEnabled: false })).toEqual([
      'remediation-limit',
    ]);
  });

  it('adds implementation-review only when ciMergeGateEnabled', () => {
    expect(resolveResumeRetainSuffixes({ ciMergeGateEnabled: true })).toEqual([
      'remediation-limit',
      'implementation-review',
    ]);
  });
});

describe('LabelManager.onResumeStart — explicit retain set', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockGithub.getIssue.mockReset();
    mockGithub.addLabels.mockReset();
    mockGithub.removeLabels.mockReset();
    mockGithub.listLabels.mockReset();
    mockGithub.createLabel.mockReset();
    mockLogger.info.mockReset();
    mockLogger.warn.mockReset();
    LabelManager.resetEnsureCacheForTests();

    mockGithub.addLabels.mockResolvedValue(undefined);
    mockGithub.removeLabels.mockResolvedValue(undefined);
    mockGithub.listLabels.mockResolvedValue([]);
    mockGithub.createLabel.mockResolvedValue(undefined);
  });

  it('default (no options): strips every paired completed:<X> except remediation-limit', async () => {
    mockGithub.getIssue.mockResolvedValue({ labels: pairedLabels() });

    await createLabelManager().onResumeStart();

    const removed = removedLabels();
    expect(removed).toContain('agent:paused');
    for (const s of ALL_GATE_SUFFIXES) {
      expect(removed).toContain(`waiting-for:${s}`);
      if (s === 'remediation-limit') {
        expect(removed).not.toContain(`completed:${s}`);
      } else {
        expect(removed).toContain(`completed:${s}`);
      }
    }
    // Non-gate phase completion with no waiting-for is untouched.
    expect(removed).not.toContain('completed:specify');
    expect(mockGithub.addLabels).toHaveBeenCalledWith('owner', 'repo', 42, ['agent:in-progress']);
  });

  it('ciMergeGateEnabled retain set: implementation-review also survives; ci/clarification/sibling-review still stripped', async () => {
    mockGithub.getIssue.mockResolvedValue({ labels: pairedLabels() });

    await createLabelManager().onResumeStart({
      retainCompletedSuffixes: resolveResumeRetainSuffixes({ ciMergeGateEnabled: true }),
    });

    const removed = removedLabels();
    expect(removed).not.toContain('completed:remediation-limit');
    expect(removed).not.toContain('completed:implementation-review');
    expect(removed).toContain('completed:ci');
    expect(removed).toContain('completed:clarification');
    expect(removed).toContain('completed:sibling-review');
    expect(removed).toContain('waiting-for:implementation-review');
    expect(removed).toContain('agent:paused');
  });

  it('flag OFF retain set: implementation-review is stripped', async () => {
    mockGithub.getIssue.mockResolvedValue({
      labels: [
        { name: 'waiting-for:implementation-review' },
        { name: 'completed:implementation-review' },
        { name: 'agent:paused' },
      ],
    });

    await createLabelManager().onResumeStart({
      retainCompletedSuffixes: resolveResumeRetainSuffixes({ ciMergeGateEnabled: false }),
    });

    expect(removedLabels()).toEqual([
      'waiting-for:implementation-review',
      'agent:paused',
      'completed:implementation-review',
    ]);
  });

  it('a waiting-for:ci answered with completed:ci is fully cleared so a validate re-pause cannot pair a stale completed:ci', async () => {
    mockGithub.getIssue.mockResolvedValue({
      labels: [
        { name: 'waiting-for:ci' },
        { name: 'completed:ci' },
        { name: 'agent:paused' },
      ],
    });

    await createLabelManager().onResumeStart({
      retainCompletedSuffixes: resolveResumeRetainSuffixes({ ciMergeGateEnabled: true }),
    });

    expect(removedLabels()).toEqual(['waiting-for:ci', 'agent:paused', 'completed:ci']);
  });

  it('retained completed:<X> without a paired waiting-for is left alone (no-op)', async () => {
    mockGithub.getIssue.mockResolvedValue({
      labels: [{ name: 'completed:remediation-limit' }, { name: 'agent:paused' }],
    });

    await createLabelManager().onResumeStart();

    expect(removedLabels()).toEqual(['agent:paused']);
  });
});

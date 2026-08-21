/**
 * #1154 SC-003 (contracts/onresumestart-strip.md): `LabelManager.onResumeStart()`
 * must retain every `completed:<X>` where X is a human-gate suffix while still
 * removing stale `waiting-for:*` and `agent:paused` labels. Non-gate
 * `completed:<phase>` labels are unaffected.
 *
 * These assertions drive the real `onResumeStart()` (not a hand-injected label
 * set), so they exercise the FR-001 guard directly.
 */
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { LabelManager, isHumanGateCompletion } from '../label-manager.js';
import type { GitHubClient } from '@generacy-ai/workflow-engine';
import type { Logger } from '../types.js';

// Representative human-gate suffixes covering GATE_MAPPING, the on-ci-green gate
// (#1133 / #1154 FR-004), and the supplemental static set.
const HUMAN_GATE_SUFFIXES = [
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

describe('LabelManager.onResumeStart — #1154 human-gate retention (SC-003)', () => {
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

  it('every listed suffix is genuinely a human-gate completion', () => {
    for (const suffix of HUMAN_GATE_SUFFIXES) {
      expect(isHumanGateCompletion(`completed:${suffix}`)).toBe(true);
    }
  });

  it('retains every human-gate completed:<X> while removing waiting-for:* and agent:paused', async () => {
    const labels = [
      { name: 'agent:paused' },
      { name: 'workflow:speckit-feature' },
      { name: 'completed:specify' }, // non-gate phase completion, no waiting-for
      ...HUMAN_GATE_SUFFIXES.flatMap((s) => [
        { name: `waiting-for:${s}` },
        { name: `completed:${s}` },
      ]),
    ];
    mockGithub.getIssue.mockResolvedValue({ labels });

    await lmResume();

    const removed = mockGithub.removeLabels.mock.calls[0]?.[3] as string[];
    // agent:paused + every waiting-for:<X> is removed …
    expect(removed).toContain('agent:paused');
    for (const s of HUMAN_GATE_SUFFIXES) {
      expect(removed).toContain(`waiting-for:${s}`);
    }
    // … but NO completed:<X> for any human gate is removed.
    for (const s of HUMAN_GATE_SUFFIXES) {
      expect(removed).not.toContain(`completed:${s}`);
    }
    // … and the non-gate phase completion is untouched.
    expect(removed).not.toContain('completed:specify');

    expect(mockGithub.addLabels).toHaveBeenCalledWith('owner', 'repo', 42, ['agent:in-progress']);
  });

  it('non-gate completed:<phase> with a co-present waiting-for:<phase> is still stripped', async () => {
    // A hypothetical non-gate suffix (a phase name) is NOT a human gate, so the
    // strip still removes it — proving the guard is scoped to gate suffixes only.
    mockGithub.getIssue.mockResolvedValue({
      labels: [
        { name: 'waiting-for:implement' },
        { name: 'completed:implement' },
        { name: 'agent:paused' },
      ],
    });

    await lmResume();

    expect(isHumanGateCompletion('completed:implement')).toBe(false);
    const removed = mockGithub.removeLabels.mock.calls[0]?.[3] as string[];
    expect(removed).toContain('completed:implement');
    expect(removed).toContain('waiting-for:implement');
    expect(removed).toContain('agent:paused');
  });
});

async function lmResume(): Promise<void> {
  const lm = createLabelManager();
  await lm.onResumeStart();
}

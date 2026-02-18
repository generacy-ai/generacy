import { vi, describe, it, expect, beforeEach } from 'vitest';
import { LabelManager } from '../label-manager.js';
import type { GitHubClient } from '@generacy-ai/workflow-engine';
import type { Logger } from '../types.js';

const mockGithub = {
  getIssue: vi.fn(),
  addLabels: vi.fn(),
  removeLabels: vi.fn(),
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

describe('LabelManager', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockGithub.getIssue.mockReset();
    mockGithub.addLabels.mockReset();
    mockGithub.removeLabels.mockReset();
    mockLogger.info.mockReset();
    mockLogger.warn.mockReset();
    mockLogger.error.mockReset();
    mockLogger.debug.mockReset();

    // Default: all GitHub calls succeed
    mockGithub.getIssue.mockResolvedValue({ labels: [] });
    mockGithub.addLabels.mockResolvedValue(undefined);
    mockGithub.removeLabels.mockResolvedValue(undefined);
  });

  describe('onPhaseStart', () => {
    it('adds phase:plan label', async () => {
      const lm = createLabelManager();
      mockGithub.getIssue.mockResolvedValue({ labels: [] });

      await lm.onPhaseStart('plan');

      expect(mockGithub.addLabels).toHaveBeenCalledWith('owner', 'repo', 42, ['phase:plan']);
    });

    it('removes previous phase:specify label when starting plan', async () => {
      const lm = createLabelManager();
      mockGithub.getIssue.mockResolvedValue({
        labels: [{ name: 'phase:specify' }, { name: 'bug' }],
      });

      await lm.onPhaseStart('plan');

      expect(mockGithub.removeLabels).toHaveBeenCalledWith('owner', 'repo', 42, ['phase:specify']);
      expect(mockGithub.addLabels).toHaveBeenCalledWith('owner', 'repo', 42, ['phase:plan']);
    });

    it('does not call removeLabels if no prior phase labels exist', async () => {
      const lm = createLabelManager();
      mockGithub.getIssue.mockResolvedValue({
        labels: [{ name: 'bug' }, { name: 'enhancement' }],
      });

      await lm.onPhaseStart('plan');

      expect(mockGithub.removeLabels).not.toHaveBeenCalled();
      expect(mockGithub.addLabels).toHaveBeenCalledWith('owner', 'repo', 42, ['phase:plan']);
    });

    it('handles labels as plain strings', async () => {
      const lm = createLabelManager();
      mockGithub.getIssue.mockResolvedValue({
        labels: ['phase:specify', 'bug'],
      });

      await lm.onPhaseStart('clarify');

      expect(mockGithub.removeLabels).toHaveBeenCalledWith('owner', 'repo', 42, ['phase:specify']);
      expect(mockGithub.addLabels).toHaveBeenCalledWith('owner', 'repo', 42, ['phase:clarify']);
    });
  });

  describe('onPhaseComplete', () => {
    it('removes phase:plan and adds completed:plan', async () => {
      const lm = createLabelManager();

      await lm.onPhaseComplete('plan');

      expect(mockGithub.removeLabels).toHaveBeenCalledWith('owner', 'repo', 42, ['phase:plan']);
      expect(mockGithub.addLabels).toHaveBeenCalledWith('owner', 'repo', 42, ['completed:plan']);
    });
  });

  describe('onGateHit', () => {
    it('removes phase:clarify and adds waiting-for:clarification and agent:paused', async () => {
      const lm = createLabelManager();

      await lm.onGateHit('clarify', 'waiting-for:clarification');

      expect(mockGithub.removeLabels).toHaveBeenCalledWith('owner', 'repo', 42, [
        'phase:clarify',
      ]);
      expect(mockGithub.addLabels).toHaveBeenCalledWith('owner', 'repo', 42, [
        'waiting-for:clarification',
        'agent:paused',
      ]);
    });
  });

  describe('onError', () => {
    it('removes phase:implement and adds agent:error', async () => {
      const lm = createLabelManager();

      await lm.onError('implement');

      expect(mockGithub.removeLabels).toHaveBeenCalledWith('owner', 'repo', 42, [
        'phase:implement',
      ]);
      expect(mockGithub.addLabels).toHaveBeenCalledWith('owner', 'repo', 42, ['agent:error']);
    });
  });

  describe('onWorkflowComplete', () => {
    it('removes agent:in-progress label', async () => {
      const lm = createLabelManager();

      await lm.onWorkflowComplete();

      expect(mockGithub.removeLabels).toHaveBeenCalledWith('owner', 'repo', 42, [
        'agent:in-progress',
      ]);
    });
  });

  describe('retry on API failure', () => {
    it('succeeds on second attempt after first addLabels call throws', async () => {
      const lm = createLabelManager();
      // Bypass real sleep delays by mocking the private sleep method
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (lm as any).sleep = vi.fn().mockResolvedValue(undefined);

      mockGithub.addLabels
        .mockRejectedValueOnce(new Error('GitHub API 503'))
        .mockResolvedValueOnce(undefined);

      await lm.onPhaseComplete('plan');

      expect(mockGithub.addLabels).toHaveBeenCalledTimes(2);
      expect(mockGithub.removeLabels).toHaveBeenCalledTimes(2);
      expect(mockLogger.warn).toHaveBeenCalled();
    });

    it('throws after all 3 attempts fail', async () => {
      const lm = createLabelManager();
      // Bypass real sleep delays by mocking the private sleep method
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (lm as any).sleep = vi.fn().mockResolvedValue(undefined);

      mockGithub.addLabels.mockRejectedValue(new Error('GitHub API 503'));

      await expect(lm.onPhaseComplete('plan')).rejects.toThrow('GitHub API 503');

      expect(mockGithub.addLabels).toHaveBeenCalledTimes(3);
      expect(mockLogger.error).toHaveBeenCalled();
    });
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GitHubActionsPlugin } from '../src/plugin.js';
import type { GitHubActionsConfig } from '../src/types/config.js';
import type { WorkflowRun } from '../src/types/workflows.js';
import type { Job } from '../src/types/jobs.js';
import type { IssueTracker } from '../src/plugin.js';

// Mock dependencies
vi.mock('../src/client.js', () => ({
  createClient: vi.fn().mockReturnValue({
    getOwner: () => 'test-owner',
    getRepo: () => 'test-repo',
    request: vi.fn(),
    requestRaw: vi.fn(),
  }),
  GitHubClient: vi.fn(),
}));

describe('IssueTracker Integration', () => {
  let plugin: GitHubActionsPlugin;
  let mockIssueTracker: IssueTracker;
  let config: GitHubActionsConfig;

  const createMockRun = (
    conclusion: WorkflowRun['conclusion'] = 'success'
  ): WorkflowRun => ({
    id: 123,
    name: 'CI',
    path: '.github/workflows/ci.yml',
    head_branch: 'main',
    head_sha: 'abc123def456789012345678901234567890abcd',
    status: 'completed',
    conclusion,
    html_url: 'https://github.com/owner/repo/actions/runs/123',
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:01:00Z',
    run_started_at: '2024-01-01T00:00:00Z',
    actor: { id: 1, login: 'user', avatar_url: '', type: 'User' },
    event: 'push',
    run_attempt: 1,
  });

  const createMockJob = (
    name: string,
    conclusion: Job['conclusion'] = 'failure'
  ): Job => ({
    id: 456,
    run_id: 123,
    name,
    status: 'completed',
    conclusion,
    steps: [],
    started_at: '2024-01-01T00:00:00Z',
    completed_at: '2024-01-01T00:01:00Z',
    runner_id: 1,
    runner_name: 'ubuntu-latest',
  });

  beforeEach(() => {
    vi.clearAllMocks();

    config = {
      owner: 'test-owner',
      repo: 'test-repo',
      token: 'ghp_test_token',
    };

    mockIssueTracker = {
      addComment: vi.fn().mockResolvedValue(undefined),
    };

    plugin = new GitHubActionsPlugin(config);
  });

  describe('postWorkflowStatusToIssue', () => {
    it('should not post if issue tracker is not set', async () => {
      const run = createMockRun('success');
      await plugin.postWorkflowStatusToIssue(42, run);
      // Should not throw
    });

    it('should post success status to issue', async () => {
      plugin.setIssueTracker(mockIssueTracker);
      const run = createMockRun('success');

      await plugin.postWorkflowStatusToIssue(42, run);

      expect(mockIssueTracker.addComment).toHaveBeenCalledWith(
        '42',
        expect.stringContaining(':white_check_mark:')
      );
      expect(mockIssueTracker.addComment).toHaveBeenCalledWith(
        '42',
        expect.stringContaining('.github/workflows/ci.yml')
      );
    });

    it('should post failure status with correct emoji', async () => {
      plugin.setIssueTracker(mockIssueTracker);
      const run = createMockRun('failure');

      await plugin.postWorkflowStatusToIssue(42, run);

      expect(mockIssueTracker.addComment).toHaveBeenCalledWith(
        '42',
        expect.stringContaining(':x:')
      );
    });

    it('should include workflow run URL', async () => {
      plugin.setIssueTracker(mockIssueTracker);
      const run = createMockRun('success');

      await plugin.postWorkflowStatusToIssue(42, run);

      expect(mockIssueTracker.addComment).toHaveBeenCalledWith(
        '42',
        expect.stringContaining('https://github.com/owner/repo/actions/runs/123')
      );
    });

    it('should include branch and commit info', async () => {
      plugin.setIssueTracker(mockIssueTracker);
      const run = createMockRun('success');

      await plugin.postWorkflowStatusToIssue(42, run);

      expect(mockIssueTracker.addComment).toHaveBeenCalledWith(
        '42',
        expect.stringContaining('main')
      );
      expect(mockIssueTracker.addComment).toHaveBeenCalledWith(
        '42',
        expect.stringContaining('abc123d')
      );
    });
  });

  describe('postWorkflowFailureToIssue', () => {
    it('should not post if issue tracker is not set', async () => {
      const run = createMockRun('failure');
      await plugin.postWorkflowFailureToIssue(42, run, []);
      // Should not throw
    });

    it('should post failure details with failed jobs', async () => {
      plugin.setIssueTracker(mockIssueTracker);
      const run = createMockRun('failure');
      const failedJobs = [
        createMockJob('build', 'failure'),
        createMockJob('test', 'failure'),
      ];

      await plugin.postWorkflowFailureToIssue(42, run, failedJobs);

      expect(mockIssueTracker.addComment).toHaveBeenCalledWith(
        '42',
        expect.stringContaining('Workflow failed')
      );
      expect(mockIssueTracker.addComment).toHaveBeenCalledWith(
        '42',
        expect.stringContaining('build')
      );
      expect(mockIssueTracker.addComment).toHaveBeenCalledWith(
        '42',
        expect.stringContaining('test')
      );
    });

    it('should handle empty failed jobs list', async () => {
      plugin.setIssueTracker(mockIssueTracker);
      const run = createMockRun('failure');

      await plugin.postWorkflowFailureToIssue(42, run, []);

      expect(mockIssueTracker.addComment).toHaveBeenCalledWith(
        '42',
        expect.stringContaining('No job details available')
      );
    });
  });

  describe('status emoji mapping', () => {
    const testCases: [WorkflowRun['conclusion'], string][] = [
      ['success', ':white_check_mark:'],
      ['failure', ':x:'],
      ['cancelled', ':no_entry_sign:'],
      ['timed_out', ':alarm_clock:'],
      ['skipped', ':fast_forward:'],
      [null, ':grey_question:'],
    ];

    it.each(testCases)('should use correct emoji for %s', async (conclusion, emoji) => {
      plugin.setIssueTracker(mockIssueTracker);
      const run = createMockRun(conclusion);

      await plugin.postWorkflowStatusToIssue(42, run);

      expect(mockIssueTracker.addComment).toHaveBeenCalledWith(
        '42',
        expect.stringContaining(emoji)
      );
    });
  });

  describe('duration formatting', () => {
    it('should format seconds', async () => {
      plugin.setIssueTracker(mockIssueTracker);
      const run = createMockRun('success');
      // Duration is 60 seconds (from mock)

      await plugin.postWorkflowStatusToIssue(42, run);

      expect(mockIssueTracker.addComment).toHaveBeenCalledWith(
        '42',
        expect.stringContaining('1m 0s')
      );
    });
  });
});

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { LabelMonitorService } from '../../../src/services/label-monitor-service.js';
import type { QueueAdapter, PhaseTracker, QueueItem } from '../../../src/types/index.js';
import type { MonitorConfig, RepositoryConfig } from '../../../src/config/schema.js';

function createMockLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function createMockPhaseTracker(overrides: Partial<PhaseTracker> = {}): PhaseTracker {
  return {
    isDuplicate: vi.fn().mockResolvedValue(false),
    markProcessed: vi.fn().mockResolvedValue(undefined),
    clear: vi.fn().mockResolvedValue(undefined),
    tryMarkProcessed: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

function createMockQueueAdapter(overrides: Partial<QueueAdapter> = {}): QueueAdapter {
  return {
    enqueue: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function createMockGitHubClient(overrides: Record<string, unknown> = {}) {
  return {
    addLabels: vi.fn().mockResolvedValue(undefined),
    removeLabels: vi.fn().mockResolvedValue(undefined),
    listLabels: vi.fn().mockResolvedValue([]),
    listIssuesWithLabel: vi.fn().mockResolvedValue([]),
    getIssue: vi.fn().mockResolvedValue({ labels: [], body: 'Test issue body', title: 'Test issue title' }),
    ...overrides,
  } as unknown as ReturnType<import('@generacy-ai/workflow-engine').GitHubClientFactory>;
}

const defaultConfig: MonitorConfig = {
  pollIntervalMs: 30000,
  adaptivePolling: true,
  maxConcurrentPolls: 5,
};

const defaultRepos: RepositoryConfig[] = [
  { owner: 'test-org', repo: 'test-repo' },
];

describe('LabelMonitorService', () => {
  let logger: ReturnType<typeof createMockLogger>;
  let phaseTracker: PhaseTracker;
  let queueAdapter: QueueAdapter;
  let mockClient: ReturnType<typeof createMockGitHubClient>;
  let clientFactory: ReturnType<typeof vi.fn>;
  let service: LabelMonitorService;

  beforeEach(() => {
    logger = createMockLogger();
    phaseTracker = createMockPhaseTracker();
    queueAdapter = createMockQueueAdapter();
    mockClient = createMockGitHubClient();
    clientFactory = vi.fn().mockReturnValue(mockClient);
    service = new LabelMonitorService(
      logger,
      clientFactory,
      phaseTracker,
      queueAdapter,
      defaultConfig,
      defaultRepos,
    );
  });

  afterEach(() => {
    service.stopPolling();
  });

  // ==========================================================================
  // T019: parseLabelEvent tests
  // ==========================================================================

  describe('parseLabelEvent', () => {
    it('should parse process:* label into a process event', () => {
      const event = service.parseLabelEvent(
        'process:speckit-feature',
        'owner', 'repo', 42,
        ['process:speckit-feature'],
        'webhook',
      );

      expect(event).toEqual({
        type: 'process',
        owner: 'owner',
        repo: 'repo',
        issueNumber: 42,
        labelName: 'process:speckit-feature',
        parsedName: 'speckit-feature',
        source: 'webhook',
        issueLabels: ['process:speckit-feature'],
      });
    });

    it('should return null for non-trigger labels', () => {
      const event = service.parseLabelEvent(
        'enhancement',
        'owner', 'repo', 42,
        ['enhancement'],
        'webhook',
      );

      expect(event).toBeNull();
    });

    it('should return null for empty workflow name after prefix', () => {
      const event = service.parseLabelEvent(
        'process:',
        'owner', 'repo', 42,
        ['process:'],
        'webhook',
      );

      expect(event).toBeNull();
    });

    it('should parse poll source correctly', () => {
      const event = service.parseLabelEvent(
        'process:speckit-bugfix',
        'owner', 'repo', 10,
        ['process:speckit-bugfix'],
        'poll',
      );

      expect(event?.source).toBe('poll');
      expect(event?.issueLabels).toEqual(['process:speckit-bugfix']);
    });
  });

  // ==========================================================================
  // T019: processLabelEvent tests
  // ==========================================================================

  describe('processLabelEvent', () => {
    it('should enqueue a process event with description and update labels', async () => {
      const event = {
        type: 'process' as const,
        owner: 'owner',
        repo: 'repo',
        issueNumber: 42,
        labelName: 'process:speckit-feature',
        parsedName: 'speckit-feature',
        source: 'webhook' as const,
        issueLabels: ['process:speckit-feature'],
      };

      const result = await service.processLabelEvent(event);

      expect(result).toBe(true);
      expect(queueAdapter.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: 'owner',
          repo: 'repo',
          issueNumber: 42,
          workflowName: 'speckit-feature',
          command: 'process',
          metadata: { description: 'Test issue body' },
        }),
      );
      expect(mockClient.removeLabels).toHaveBeenCalledWith(
        'owner', 'repo', 42, ['process:speckit-feature', 'agent:error'],
      );
      expect(mockClient.addLabels).toHaveBeenCalledWith(
        'owner', 'repo', 42, ['agent:in-progress', 'workflow:speckit-feature'],
      );
    });

    it('should skip duplicate events', async () => {
      (phaseTracker.isDuplicate as ReturnType<typeof vi.fn>).mockResolvedValue(true);

      const event = {
        type: 'process' as const,
        owner: 'owner',
        repo: 'repo',
        issueNumber: 42,
        labelName: 'process:speckit-feature',
        parsedName: 'speckit-feature',
        source: 'webhook' as const,
        issueLabels: ['process:speckit-feature'],
      };

      const result = await service.processLabelEvent(event);

      expect(result).toBe(false);
      expect(queueAdapter.enqueue).not.toHaveBeenCalled();
    });

    it('should mark event as processed after enqueue', async () => {
      const event = {
        type: 'process' as const,
        owner: 'owner',
        repo: 'repo',
        issueNumber: 42,
        labelName: 'process:speckit-feature',
        parsedName: 'speckit-feature',
        source: 'webhook' as const,
        issueLabels: ['process:speckit-feature'],
      };

      await service.processLabelEvent(event);

      expect(phaseTracker.markProcessed).toHaveBeenCalledWith(
        'owner', 'repo', 42, 'speckit-feature',
      );
    });

    it('should use fallback description when getIssue fails', async () => {
      (mockClient.getIssue as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('API error'),
      );

      const event = {
        type: 'process' as const,
        owner: 'owner',
        repo: 'repo',
        issueNumber: 42,
        labelName: 'process:speckit-feature',
        parsedName: 'speckit-feature',
        source: 'webhook' as const,
        issueLabels: ['process:speckit-feature'],
      };

      const result = await service.processLabelEvent(event);

      expect(result).toBe(true);
      expect(queueAdapter.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: { description: 'Issue #42' },
        }),
      );
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ issueNumber: 42 }),
        'Failed to fetch issue details, using fallback description',
      );
    });

    it('should fall back to title when issue body is empty', async () => {
      (mockClient.getIssue as ReturnType<typeof vi.fn>).mockResolvedValue({
        labels: [],
        body: '',
        title: 'My issue title',
      });

      const event = {
        type: 'process' as const,
        owner: 'owner',
        repo: 'repo',
        issueNumber: 42,
        labelName: 'process:speckit-feature',
        parsedName: 'speckit-feature',
        source: 'webhook' as const,
        issueLabels: ['process:speckit-feature'],
      };

      await service.processLabelEvent(event);

      expect(queueAdapter.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: { description: 'My issue title' },
        }),
      );
    });
  });

  // ==========================================================================
  // T020: Resume detection tests
  // ==========================================================================

  describe('resume detection', () => {
    it('should detect completed:* + waiting-for:* pair', () => {
      const event = service.parseLabelEvent(
        'completed:spec-review',
        'owner', 'repo', 42,
        ['completed:spec-review', 'waiting-for:spec-review', 'phase:clarify'],
        'webhook',
      );

      expect(event).toEqual({
        type: 'resume',
        owner: 'owner',
        repo: 'repo',
        issueNumber: 42,
        labelName: 'completed:spec-review',
        parsedName: 'spec-review',
        source: 'webhook',
        issueLabels: ['completed:spec-review', 'waiting-for:spec-review', 'phase:clarify'],
      });
    });

    it('should ignore completed:* without matching waiting-for:*', () => {
      const event = service.parseLabelEvent(
        'completed:spec-review',
        'owner', 'repo', 42,
        ['completed:spec-review', 'phase:clarify'],
        'webhook',
      );

      expect(event).toBeNull();
    });

    it('should log when completed:* has no matching waiting-for:*', () => {
      service.parseLabelEvent(
        'completed:spec-review',
        'owner', 'repo', 42,
        ['completed:spec-review', 'phase:clarify'],
        'webhook',
      );

      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          labelName: 'completed:spec-review',
          expectedWaitingLabel: 'waiting-for:spec-review',
        }),
        'completed:* label seen without matching waiting-for:* label',
      );
    });

    it('should enqueue continue command for resume event with resolved workflow name', async () => {
      const event = {
        type: 'resume' as const,
        owner: 'owner',
        repo: 'repo',
        issueNumber: 42,
        labelName: 'completed:spec-review',
        parsedName: 'spec-review',
        source: 'webhook' as const,
        issueLabels: ['completed:spec-review', 'waiting-for:spec-review', 'workflow:speckit-feature'],
      };

      await service.processLabelEvent(event);

      expect(queueAdapter.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          command: 'continue',
          workflowName: 'speckit-feature',
        }),
      );
    });

    it('should not remove waiting-for:* label on resume (deferred to worker)', async () => {
      const event = {
        type: 'resume' as const,
        owner: 'owner',
        repo: 'repo',
        issueNumber: 42,
        labelName: 'completed:spec-review',
        parsedName: 'spec-review',
        source: 'webhook' as const,
        issueLabels: ['completed:spec-review', 'waiting-for:spec-review', 'workflow:speckit-feature'],
      };

      await service.processLabelEvent(event);

      // waiting-for:* removal is now handled by the worker (labelManager.onResumeStart)
      // to avoid a race condition where the label is removed before the worker reads it
      expect(mockClient.removeLabels).not.toHaveBeenCalled();
    });

    it('should default to speckit-feature when no workflow: label exists on resume', async () => {
      const event = {
        type: 'resume' as const,
        owner: 'owner',
        repo: 'repo',
        issueNumber: 42,
        labelName: 'completed:spec-review',
        parsedName: 'spec-review',
        source: 'webhook' as const,
        issueLabels: ['completed:spec-review', 'waiting-for:spec-review'],
      };

      await service.processLabelEvent(event);

      expect(queueAdapter.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          command: 'continue',
          workflowName: 'speckit-feature',
        }),
      );
      expect(logger.warn).toHaveBeenCalled();
    });

    it('should use resume dedup key prefix', async () => {
      const event = {
        type: 'resume' as const,
        owner: 'owner',
        repo: 'repo',
        issueNumber: 42,
        labelName: 'completed:spec-review',
        parsedName: 'spec-review',
        source: 'webhook' as const,
        issueLabels: ['completed:spec-review', 'waiting-for:spec-review', 'workflow:speckit-feature'],
      };

      await service.processLabelEvent(event);

      expect(phaseTracker.isDuplicate).toHaveBeenCalledWith(
        'owner', 'repo', 42, 'resume:spec-review',
      );
    });
  });

  // ==========================================================================
  // verifyAndProcessCompletedLabel tests
  // ==========================================================================

  describe('verifyAndProcessCompletedLabel', () => {
    it('should re-fetch labels and process resume when waiting-for:* exists on issue', async () => {
      (mockClient.getIssue as ReturnType<typeof vi.fn>).mockResolvedValue({
        labels: [
          { name: 'completed:spec-review', color: '' },
          { name: 'waiting-for:spec-review', color: '' },
          { name: 'workflow:speckit-feature', color: '' },
        ],
      });

      const result = await service.verifyAndProcessCompletedLabel(
        'owner', 'repo', 42, 'completed:spec-review',
      );

      expect(result).toBe(true);
      expect(mockClient.getIssue).toHaveBeenCalledWith('owner', 'repo', 42);
      expect(queueAdapter.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          command: 'continue',
          issueNumber: 42,
        }),
      );
    });

    it('should return false when re-fetch confirms no waiting-for:* label', async () => {
      (mockClient.getIssue as ReturnType<typeof vi.fn>).mockResolvedValue({
        labels: [
          { name: 'completed:spec-review', color: '' },
          { name: 'phase:clarify', color: '' },
        ],
      });

      const result = await service.verifyAndProcessCompletedLabel(
        'owner', 'repo', 42, 'completed:spec-review',
      );

      expect(result).toBe(false);
      expect(queueAdapter.enqueue).not.toHaveBeenCalled();
    });

    it('should return false when getIssue API call fails', async () => {
      (mockClient.getIssue as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('API rate limit exceeded'),
      );

      const result = await service.verifyAndProcessCompletedLabel(
        'owner', 'repo', 42, 'completed:spec-review',
      );

      expect(result).toBe(false);
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ labelName: 'completed:spec-review' }),
        expect.stringContaining('Failed to re-fetch'),
      );
    });

    it('should respect dedup when re-fetch finds a valid pair', async () => {
      (phaseTracker.isDuplicate as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      (mockClient.getIssue as ReturnType<typeof vi.fn>).mockResolvedValue({
        labels: [
          { name: 'completed:spec-review', color: '' },
          { name: 'waiting-for:spec-review', color: '' },
          { name: 'workflow:speckit-feature', color: '' },
        ],
      });

      const result = await service.verifyAndProcessCompletedLabel(
        'owner', 'repo', 42, 'completed:spec-review',
      );

      expect(result).toBe(false);
      expect(queueAdapter.enqueue).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // T021: Polling loop tests
  // ==========================================================================

  describe('polling', () => {
    it('should poll repos and find process labels', async () => {
      (mockClient.listLabels as ReturnType<typeof vi.fn>).mockResolvedValue([
        { name: 'process:speckit-feature', color: 'D876E3' },
      ]);
      (mockClient.listIssuesWithLabel as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          number: 42,
          title: 'Test issue',
          body: '',
          state: 'open',
          labels: [{ name: 'process:speckit-feature', color: 'D876E3' }],
          assignees: [],
          created_at: '',
          updated_at: '',
        },
      ]);

      await service.poll();

      expect(queueAdapter.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          issueNumber: 42,
          workflowName: 'speckit-feature',
          command: 'process',
        }),
      );
    });

    it('should stop polling cleanly via AbortController', async () => {
      // Start polling then immediately stop
      const pollPromise = service.startPolling();
      // Give it a tiny bit of time to enter the loop
      await new Promise(resolve => setTimeout(resolve, 10));
      service.stopPolling();
      await pollPromise;

      const state = service.getState();
      expect(state.isPolling).toBe(false);
    });

    it('should not start polling twice', async () => {
      const pollPromise = service.startPolling();
      await new Promise(resolve => setTimeout(resolve, 10));

      // Second call should warn and return immediately
      await service.startPolling();
      expect(logger.warn).toHaveBeenCalledWith('Polling already running');

      service.stopPolling();
      await pollPromise;
    });
  });

  // ==========================================================================
  // T021: Adaptive polling tests
  // ==========================================================================

  describe('adaptive polling', () => {
    it('should start with base poll interval', () => {
      const state = service.getState();
      expect(state.currentPollIntervalMs).toBe(30000);
      expect(state.basePollIntervalMs).toBe(30000);
    });

    it('should record webhook events and stay healthy', () => {
      service.recordWebhookEvent();
      const state = service.getState();
      expect(state.webhookHealthy).toBe(true);
      expect(state.lastWebhookEvent).not.toBeNull();
    });

    it('should restore normal interval when webhook reconnects', () => {
      // Simulate: webhook was active, went unhealthy
      service.recordWebhookEvent();

      // Force lastWebhookEvent to be old (simulate time passing)
      const internalState = (service as unknown as { state: { lastWebhookEvent: number; webhookHealthy: boolean; currentPollIntervalMs: number } }).state;
      internalState.lastWebhookEvent = Date.now() - 120000; // 2 minutes ago
      internalState.webhookHealthy = false;
      internalState.currentPollIntervalMs = 10000;

      // Webhook comes back
      service.recordWebhookEvent();

      const state = service.getState();
      expect(state.webhookHealthy).toBe(true);
      expect(state.currentPollIntervalMs).toBe(30000);
    });
  });

  // ==========================================================================
  // T022: Dedup integration tests
  // ==========================================================================

  describe('deduplication integration', () => {
    it('should skip duplicate events via phase tracker (resume events only)', async () => {
      // Process events always clear dedup first, so they won't be blocked.
      // Resume events don't clear, so they can be deduplicated.
      (phaseTracker.isDuplicate as ReturnType<typeof vi.fn>).mockResolvedValue(true);

      const event = {
        type: 'resume' as const,
        owner: 'owner',
        repo: 'repo',
        issueNumber: 42,
        labelName: 'completed:clarification',
        parsedName: 'clarification',
        source: 'poll' as const,
        issueLabels: ['completed:clarification', 'waiting-for:clarification', 'workflow:speckit-feature'],
      };

      const result = await service.processLabelEvent(event);

      expect(result).toBe(false);
      expect(queueAdapter.enqueue).not.toHaveBeenCalled();
      expect(phaseTracker.markProcessed).not.toHaveBeenCalled();
      // clear should NOT be called for resume events
      expect(phaseTracker.clear).not.toHaveBeenCalled();
    });

    it('should clear dedup and proceed for process events', async () => {
      (phaseTracker.isDuplicate as ReturnType<typeof vi.fn>).mockResolvedValue(false);

      const event = {
        type: 'process' as const,
        owner: 'owner',
        repo: 'repo',
        issueNumber: 42,
        labelName: 'process:speckit-feature',
        parsedName: 'speckit-feature',
        source: 'poll' as const,
        issueLabels: ['process:speckit-feature'],
      };

      const result = await service.processLabelEvent(event);

      expect(result).toBe(true);
      // Process events clear dedup first to allow requeue
      expect(phaseTracker.clear).toHaveBeenCalledWith('owner', 'repo', 42, 'speckit-feature');
      expect(queueAdapter.enqueue).toHaveBeenCalled();
      expect(phaseTracker.markProcessed).toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // T023: Webhook route behavior (tested via service methods)
  // ==========================================================================

  describe('webhook integration', () => {
    it('should accept labeled events for watched repos', () => {
      const event = service.parseLabelEvent(
        'process:speckit-feature',
        'test-org', 'test-repo', 42,
        ['process:speckit-feature'],
        'webhook',
      );

      expect(event).not.toBeNull();
      expect(event?.type).toBe('process');
      expect(event?.issueLabels).toEqual(['process:speckit-feature']);
    });

    it('should filter out non-process labels', () => {
      const event = service.parseLabelEvent(
        'enhancement',
        'test-org', 'test-repo', 42,
        ['enhancement'],
        'webhook',
      );

      expect(event).toBeNull();
    });

    it('should record webhook event on successful processing', () => {
      // This tests the webhook handler behavior via the recordWebhookEvent method
      service.recordWebhookEvent();
      const state = service.getState();
      expect(state.lastWebhookEvent).not.toBeNull();
      expect(state.webhookHealthy).toBe(true);
    });
  });

  // ==========================================================================
  // T005: failed:* label cleanup on process events
  // ==========================================================================

  describe('failed:* label cleanup', () => {
    it('should remove failed:* labels alongside completed:* labels on process events', async () => {
      (mockClient.getIssue as ReturnType<typeof vi.fn>).mockResolvedValue({
        labels: [
          { name: 'completed:specify', color: '' },
          { name: 'failed:validate', color: '' },
          { name: 'workflow:speckit-feature', color: '' },
        ],
        body: 'Test issue body',
        title: 'Test issue title',
      });

      const event = {
        type: 'process' as const,
        owner: 'owner',
        repo: 'repo',
        issueNumber: 42,
        labelName: 'process:speckit-feature',
        parsedName: 'speckit-feature',
        source: 'webhook' as const,
        issueLabels: ['process:speckit-feature'],
      };

      await service.processLabelEvent(event);

      expect(mockClient.removeLabels).toHaveBeenCalledWith(
        'owner', 'repo', 42,
        expect.arrayContaining(['process:speckit-feature', 'agent:error', 'completed:specify', 'failed:validate']),
      );
    });

    it('should not include failed:* labels in removal when none exist', async () => {
      (mockClient.getIssue as ReturnType<typeof vi.fn>).mockResolvedValue({
        labels: [
          { name: 'completed:specify', color: '' },
        ],
        body: 'Test issue body',
        title: 'Test issue title',
      });

      const event = {
        type: 'process' as const,
        owner: 'owner',
        repo: 'repo',
        issueNumber: 42,
        labelName: 'process:speckit-feature',
        parsedName: 'speckit-feature',
        source: 'webhook' as const,
        issueLabels: ['process:speckit-feature'],
      };

      await service.processLabelEvent(event);

      expect(mockClient.removeLabels).toHaveBeenCalledWith(
        'owner', 'repo', 42,
        ['process:speckit-feature', 'agent:error', 'completed:specify'],
      );
    });
  });

  // ==========================================================================
  // T013: Assignee filtering in polling
  // ==========================================================================

  describe('assignee filtering in polling', () => {
    it('should process all issues when clusterGithubUsername is undefined (backward compat)', async () => {
      // Default service from beforeEach has no clusterGithubUsername
      (mockClient.listIssuesWithLabel as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          number: 10,
          title: 'Assigned issue',
          body: '',
          state: 'open',
          labels: [{ name: 'process:speckit-feature', color: '' }],
          assignees: ['user-a'],
          created_at: '',
          updated_at: '',
        },
        {
          number: 20,
          title: 'Unassigned issue',
          body: '',
          state: 'open',
          labels: [{ name: 'process:speckit-feature', color: '' }],
          assignees: [],
          created_at: '',
          updated_at: '',
        },
      ]);

      await service.poll();

      // Both issues should be enqueued — no filtering when username is undefined
      expect(queueAdapter.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({ issueNumber: 10 }),
      );
      expect(queueAdapter.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({ issueNumber: 20 }),
      );
    });

    it('should only process issues assigned to cluster username when set', async () => {
      service = new LabelMonitorService(
        logger,
        clientFactory,
        phaseTracker,
        queueAdapter,
        defaultConfig,
        defaultRepos,
        'my-user',
      );

      (mockClient.listIssuesWithLabel as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          number: 10,
          title: 'Assigned to my-user',
          body: '',
          state: 'open',
          labels: [{ name: 'process:speckit-feature', color: '' }],
          assignees: ['my-user'],
          created_at: '',
          updated_at: '',
        },
        {
          number: 20,
          title: 'Assigned to other-user',
          body: '',
          state: 'open',
          labels: [{ name: 'process:speckit-feature', color: '' }],
          assignees: ['other-user'],
          created_at: '',
          updated_at: '',
        },
      ]);

      await service.poll();

      expect(queueAdapter.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({ issueNumber: 10 }),
      );
      expect(queueAdapter.enqueue).not.toHaveBeenCalledWith(
        expect.objectContaining({ issueNumber: 20 }),
      );
    });

    it('should skip unassigned issues with warning when username is set', async () => {
      service = new LabelMonitorService(
        logger,
        clientFactory,
        phaseTracker,
        queueAdapter,
        defaultConfig,
        defaultRepos,
        'my-user',
      );

      (mockClient.listIssuesWithLabel as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          number: 30,
          title: 'Unassigned issue',
          body: '',
          state: 'open',
          labels: [{ name: 'process:speckit-feature', color: '' }],
          assignees: [],
          created_at: '',
          updated_at: '',
        },
      ]);

      await service.poll();

      expect(queueAdapter.enqueue).not.toHaveBeenCalledWith(
        expect.objectContaining({ issueNumber: 30 }),
      );
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ issueNumber: 30 }),
        expect.stringContaining('no assignees'),
      );
    });

    it('should filter completed label issues by assignee on every 3rd cycle', async () => {
      service = new LabelMonitorService(
        logger,
        clientFactory,
        phaseTracker,
        queueAdapter,
        defaultConfig,
        defaultRepos,
        'my-user',
      );

      // Set pollCycleCount to 2 so next poll() is cycle 3 (triggers completed check)
      (service as unknown as { pollCycleCount: number }).pollCycleCount = 2;

      (mockClient.listIssuesWithLabel as ReturnType<typeof vi.fn>).mockImplementation(
        (_owner: string, _repo: string, label: string) => {
          if (label.startsWith('completed:')) {
            const phase = label.slice('completed:'.length);
            return Promise.resolve([
              {
                number: 50,
                title: 'Completed - assigned to my-user',
                body: '',
                state: 'open',
                labels: [
                  { name: label, color: '' },
                  { name: `waiting-for:${phase}`, color: '' },
                ],
                assignees: ['my-user'],
                created_at: '',
                updated_at: '',
              },
              {
                number: 60,
                title: 'Completed - assigned to other-user',
                body: '',
                state: 'open',
                labels: [
                  { name: label, color: '' },
                  { name: `waiting-for:${phase}`, color: '' },
                ],
                assignees: ['other-user'],
                created_at: '',
                updated_at: '',
              },
            ]);
          }
          // Process labels return no issues
          return Promise.resolve([]);
        },
      );

      await service.poll();

      // Issue 50 (assigned to my-user) should be enqueued as a resume
      expect(queueAdapter.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({ issueNumber: 50, command: 'continue' }),
      );
      // Issue 60 (assigned to other-user) should be filtered out
      expect(queueAdapter.enqueue).not.toHaveBeenCalledWith(
        expect.objectContaining({ issueNumber: 60 }),
      );
    });
  });
});

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
    });
  });

  // ==========================================================================
  // T019: processLabelEvent tests
  // ==========================================================================

  describe('processLabelEvent', () => {
    it('should enqueue a process event and update labels', async () => {
      const event = {
        type: 'process' as const,
        owner: 'owner',
        repo: 'repo',
        issueNumber: 42,
        labelName: 'process:speckit-feature',
        parsedName: 'speckit-feature',
        source: 'webhook' as const,
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
        }),
      );
      expect(mockClient.removeLabels).toHaveBeenCalledWith(
        'owner', 'repo', 42, ['process:speckit-feature', 'agent:error'],
      );
      expect(mockClient.addLabels).toHaveBeenCalledWith(
        'owner', 'repo', 42, ['agent:in-progress'],
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
      };

      await service.processLabelEvent(event);

      expect(phaseTracker.markProcessed).toHaveBeenCalledWith(
        'owner', 'repo', 42, 'speckit-feature',
      );
    });

    it('should still enqueue even if label update fails', async () => {
      (mockClient.removeLabels as ReturnType<typeof vi.fn>).mockRejectedValue(
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
      };

      const result = await service.processLabelEvent(event);

      expect(result).toBe(true);
      expect(queueAdapter.enqueue).toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalled();
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

    it('should enqueue continue command for resume event', async () => {
      const event = {
        type: 'resume' as const,
        owner: 'owner',
        repo: 'repo',
        issueNumber: 42,
        labelName: 'completed:spec-review',
        parsedName: 'spec-review',
        source: 'webhook' as const,
      };

      await service.processLabelEvent(event);

      expect(queueAdapter.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          command: 'continue',
          workflowName: 'spec-review',
        }),
      );
    });

    it('should remove waiting-for:* label on resume', async () => {
      const event = {
        type: 'resume' as const,
        owner: 'owner',
        repo: 'repo',
        issueNumber: 42,
        labelName: 'completed:spec-review',
        parsedName: 'spec-review',
        source: 'webhook' as const,
      };

      await service.processLabelEvent(event);

      expect(mockClient.removeLabels).toHaveBeenCalledWith(
        'owner', 'repo', 42, ['waiting-for:spec-review'],
      );
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
      };

      await service.processLabelEvent(event);

      expect(phaseTracker.isDuplicate).toHaveBeenCalledWith(
        'owner', 'repo', 42, 'resume:spec-review',
      );
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
});

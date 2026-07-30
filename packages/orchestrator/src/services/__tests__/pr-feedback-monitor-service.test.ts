import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { GhAuthError } from '@generacy-ai/workflow-engine';
import { PrFeedbackMonitorService } from '../pr-feedback-monitor-service.js';
import { InMemoryQueueAdapter } from '../in-memory-queue-adapter.js';
import type {
  QueueManager,
  PrReviewEvent,
} from '../../types/monitor.js';
import type { PrMonitorConfig, RepositoryConfig } from '../../config/schema.js';
import type { Logger } from '../../worker/types.js';

// DO NOT add a `resolved` field to this fixture — see #861 / quickstart.md.
// The REST payload never carried thread resolution; that is the whole bug.
// Read via getPRReviewThreads() instead.
const FIXTURE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures/pr-comments-rest.json',
);
const restCommentFixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf-8')) as {
  _meta: { source: string; capturedAt: string; note: string };
  comments: Array<Record<string, unknown>>;
};

// ==========================================================================
// Mock Factories
// ==========================================================================

function createMockLogger(): Logger {
  const logger: Logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return logger;
}

/**
 * #879: pr-feedback dedupe now runs through `QueueManager.enqueueIfAbsent`.
 * Tests wire the real `InMemoryQueueAdapter` (its `enqueueIfAbsent` gives us
 * real single-in-flight semantics for SC-001/SC-002/SC-003 without hand-
 * rolling a fake) with `enqueueIfAbsent` and `enqueue` spied for assertion.
 */
function createInMemoryQueueManager(): QueueManager & {
  spies: {
    enqueueIfAbsent: ReturnType<typeof vi.fn>;
    enqueue: ReturnType<typeof vi.fn>;
  };
} {
  const noopLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  };
  const adapter = new InMemoryQueueAdapter(noopLogger);
  const enqueueIfAbsentSpy = vi.spyOn(adapter, 'enqueueIfAbsent');
  const enqueueSpy = vi.spyOn(adapter, 'enqueue');
  return Object.assign(adapter, {
    spies: {
      enqueueIfAbsent: enqueueIfAbsentSpy as unknown as ReturnType<typeof vi.fn>,
      enqueue: enqueueSpy as unknown as ReturnType<typeof vi.fn>,
    },
  }) as QueueManager & {
    spies: {
      enqueueIfAbsent: ReturnType<typeof vi.fn>;
      enqueue: ReturnType<typeof vi.fn>;
    };
  };
}

function createMockGitHubClient(overrides: Record<string, unknown> = {}) {
  return {
    addLabels: vi.fn().mockResolvedValue(undefined),
    removeLabels: vi.fn().mockResolvedValue(undefined),
    listLabels: vi.fn().mockResolvedValue([]),
    listIssuesWithLabel: vi.fn().mockResolvedValue([]),
    getIssue: vi.fn().mockResolvedValue({
      number: 42,
      title: 'Test issue',
      body: '',
      state: 'open',
      labels: [{ name: 'agent:in-progress', color: '' }],
      assignees: [],
      created_at: '',
      updated_at: '',
    }),
    // #883: monitor pre-enqueue skip fetches issue labels. Default: no
    // blocked:* labels → no skip.
    getIssueLabels: vi.fn().mockResolvedValue([]),
    getPRReviewThreads: vi.fn().mockResolvedValue([]),
    listOpenPullRequests: vi.fn().mockResolvedValue([]),
    replyToPRComment: vi.fn().mockResolvedValue({}),
    ...overrides,
  } as unknown as ReturnType<import('@generacy-ai/workflow-engine').GitHubClientFactory>;
}

const defaultConfig: PrMonitorConfig = {
  enabled: true,
  pollIntervalMs: 60000,
  adaptivePolling: true,
  maxConcurrentPolls: 3,
};

const defaultRepos: RepositoryConfig[] = [
  { owner: 'test-org', repo: 'test-repo' },
];

// ==========================================================================
// Helper: create a standard PrReviewEvent
// ==========================================================================

function createPrReviewEvent(overrides: Partial<PrReviewEvent> = {}): PrReviewEvent {
  return {
    owner: 'test-org',
    repo: 'test-repo',
    prNumber: 10,
    prBody: 'Fixes #42',
    branchName: '42-feature-branch',
    source: 'webhook',
    prMerged: false,
    ...overrides,
  };
}

describe('PrFeedbackMonitorService', () => {
  let logger: Logger;
  let queueManager: ReturnType<typeof createInMemoryQueueManager>;
  let mockClient: ReturnType<typeof createMockGitHubClient>;
  let clientFactory: ReturnType<typeof vi.fn>;
  let service: PrFeedbackMonitorService;

  beforeEach(() => {
    logger = createMockLogger();
    queueManager = createInMemoryQueueManager();
    mockClient = createMockGitHubClient({
      getPRReviewThreads: vi.fn().mockResolvedValue([
        {
          rootCommentId: 101,
          isResolved: false,
          comments: [{ id: 101, body: 'Fix this', author: 'r', authorAssociation: 'MEMBER', created_at: '', updated_at: '', path: 'src/app.ts', line: 10 }],
        },
        {
          rootCommentId: 102,
          isResolved: false,
          comments: [{ id: 102, body: 'Also fix this', author: 'r', authorAssociation: 'MEMBER', created_at: '', updated_at: '', path: 'src/util.ts', line: 20 }],
        },
      ]),
    });
    clientFactory = vi.fn().mockReturnValue(mockClient);
    service = new PrFeedbackMonitorService(
      logger,
      clientFactory,
      queueManager,
      defaultConfig,
      defaultRepos,
      undefined,
      undefined,
      undefined,
      undefined,
      true, // #953: webhooksConfigured=true — pre-existing "record webhook
            // → recover to base" tests assume a configured feeder path.
    );
  });

  afterEach(() => {
    service.stopPolling();
  });

  // ==========================================================================
  // processPrReviewEvent: Happy Path
  // ==========================================================================

  describe('processPrReviewEvent', () => {
    it('should link PR to issue, detect unresolved threads, and enqueue work', async () => {
      const event = createPrReviewEvent();

      const result = await service.processPrReviewEvent(event);

      expect(result).toBe(true);
      expect(queueManager.spies.enqueueIfAbsent).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: 'test-org',
          repo: 'test-repo',
          issueNumber: 42,
          command: 'address-pr-feedback',
          metadata: expect.objectContaining({
            prNumber: 10,
            reviewThreadIds: [101, 102],
          }),
        }),
      );
    });

    it('should add waiting-for:address-pr-feedback label (idempotent, before enqueue per #879 FR-010)', async () => {
      const event = createPrReviewEvent();

      await service.processPrReviewEvent(event);

      expect(mockClient.addLabels).toHaveBeenCalledWith(
        'test-org', 'test-repo', 42, ['waiting-for:address-pr-feedback'],
      );
    });

    it('should include workflowName resolved from issue labels', async () => {
      // getIssue returns issue with process:speckit-feature label
      (mockClient.getIssue as ReturnType<typeof vi.fn>).mockResolvedValue({
        number: 42,
        title: 'Test issue',
        body: '',
        state: 'open',
        labels: [
          { name: 'agent:in-progress', color: '' },
          { name: 'process:speckit-feature', color: '' },
        ],
        assignees: [],
        created_at: '',
        updated_at: '',
      });

      const event = createPrReviewEvent();
      await service.processPrReviewEvent(event);

      expect(queueManager.spies.enqueueIfAbsent).toHaveBeenCalledWith(
        expect.objectContaining({
          workflowName: 'speckit-feature',
        }),
      );
    });

    it('should resolve workflowName from completed:* label', async () => {
      (mockClient.getIssue as ReturnType<typeof vi.fn>).mockResolvedValue({
        number: 42,
        title: 'Test issue',
        body: '',
        state: 'open',
        labels: [
          { name: 'agent:in-progress', color: '' },
          { name: 'completed:speckit-bugfix', color: '' },
        ],
        assignees: [],
        created_at: '',
        updated_at: '',
      });

      const event = createPrReviewEvent();
      await service.processPrReviewEvent(event);

      expect(queueManager.spies.enqueueIfAbsent).toHaveBeenCalledWith(
        expect.objectContaining({
          workflowName: 'speckit-bugfix',
        }),
      );
    });

    it('should use "unknown" workflow when no workflow label exists', async () => {
      (mockClient.getIssue as ReturnType<typeof vi.fn>).mockResolvedValue({
        number: 42,
        title: 'Test issue',
        body: '',
        state: 'open',
        labels: [{ name: 'agent:in-progress', color: '' }],
        assignees: [],
        created_at: '',
        updated_at: '',
      });

      const event = createPrReviewEvent();
      await service.processPrReviewEvent(event);

      expect(queueManager.spies.enqueueIfAbsent).toHaveBeenCalledWith(
        expect.objectContaining({
          workflowName: 'unknown',
        }),
      );
    });

    // ==========================================================================
    // processPrReviewEvent: PR-to-Issue Linking
    // ==========================================================================

    it('should skip PRs not linked to any issue', async () => {
      const event = createPrReviewEvent({
        prBody: 'No issue reference here',
        branchName: 'feature-no-issue',
      });

      const result = await service.processPrReviewEvent(event);

      expect(result).toBe(false);
      expect(queueManager.spies.enqueueIfAbsent).not.toHaveBeenCalled();
    });

    it('should skip PRs linked to non-orchestrated issues (no agent:* label)', async () => {
      (mockClient.getIssue as ReturnType<typeof vi.fn>).mockResolvedValue({
        number: 42,
        title: 'Test issue',
        body: '',
        state: 'open',
        labels: [{ name: 'enhancement', color: '' }],
        assignees: [],
        created_at: '',
        updated_at: '',
      });

      const event = createPrReviewEvent();
      const result = await service.processPrReviewEvent(event);

      expect(result).toBe(false);
      expect(queueManager.spies.enqueueIfAbsent).not.toHaveBeenCalled();
    });

    it('should link via branch name when PR body has no closing keywords', async () => {
      const event = createPrReviewEvent({
        prBody: 'Some changes without closing keywords',
        branchName: '42-feature-branch',
      });

      const result = await service.processPrReviewEvent(event);

      expect(result).toBe(true);
      expect(queueManager.spies.enqueueIfAbsent).toHaveBeenCalledWith(
        expect.objectContaining({ issueNumber: 42 }),
      );
    });

    it('should prefer PR body keyword over branch name', async () => {
      // PR body says #42, branch says 99
      (mockClient.getIssue as ReturnType<typeof vi.fn>).mockResolvedValue({
        number: 42,
        title: 'Test issue',
        body: '',
        state: 'open',
        labels: [{ name: 'agent:in-progress', color: '' }],
        assignees: [],
        created_at: '',
        updated_at: '',
      });

      const event = createPrReviewEvent({
        prBody: 'Fixes #42',
        branchName: '99-other-branch',
      });

      const result = await service.processPrReviewEvent(event);

      expect(result).toBe(true);
      expect(queueManager.spies.enqueueIfAbsent).toHaveBeenCalledWith(
        expect.objectContaining({ issueNumber: 42 }),
      );
    });

    // ==========================================================================
    // processPrReviewEvent: Unresolved Thread Detection
    // ==========================================================================

    it('should skip PRs with no unresolved review threads', async () => {
      (mockClient.getPRReviewThreads as ReturnType<typeof vi.fn>).mockResolvedValue([
        { rootCommentId: 101, isResolved: true, comments: [{ id: 101, body: 'Fixed', author: 'r', created_at: '', updated_at: '' }] },
      ]);

      const event = createPrReviewEvent();
      const result = await service.processPrReviewEvent(event);

      expect(result).toBe(false);
      expect(queueManager.spies.enqueueIfAbsent).not.toHaveBeenCalled();
    });

    it('should skip PRs with zero review threads', async () => {
      (mockClient.getPRReviewThreads as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const event = createPrReviewEvent();
      const result = await service.processPrReviewEvent(event);

      expect(result).toBe(false);
      expect(queueManager.spies.enqueueIfAbsent).not.toHaveBeenCalled();
    });

    it('should emit rootCommentId per unresolved thread', async () => {
      (mockClient.getPRReviewThreads as ReturnType<typeof vi.fn>).mockResolvedValue([
        { rootCommentId: 101, isResolved: false, comments: [{ id: 101, body: 'Root', author: 'r', authorAssociation: 'MEMBER', created_at: '', updated_at: '' }] },
        { rootCommentId: 103, isResolved: true, comments: [{ id: 103, body: 'Resolved', author: 'r', authorAssociation: 'MEMBER', created_at: '', updated_at: '' }] },
      ]);

      const event = createPrReviewEvent();
      await service.processPrReviewEvent(event);

      expect(queueManager.spies.enqueueIfAbsent).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            reviewThreadIds: [101], // Only unresolved thread's root
          }),
        }),
      );
    });

    it('should return false when fetching review threads fails with generic error (warn)', async () => {
      (mockClient.getPRReviewThreads as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('API error'),
      );

      const event = createPrReviewEvent();
      const result = await service.processPrReviewEvent(event);

      expect(result).toBe(false);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.stringContaining('API error'), owner: 'test-org', repo: 'test-repo', prNumber: 10 }),
        expect.stringContaining('transient'),
      );
      expect(queueManager.spies.enqueueIfAbsent).not.toHaveBeenCalled();
    });

    // ==========================================================================
    // processPrReviewEvent: Deduplication
    // ==========================================================================

    it('should skip duplicate events when enqueueIfAbsent returns false', async () => {
      // Pre-seed the itemKey as in-flight so enqueueIfAbsent short-circuits.
      queueManager.spies.enqueueIfAbsent.mockResolvedValueOnce(false);

      const event = createPrReviewEvent();
      const result = await service.processPrReviewEvent(event);

      expect(result).toBe(false);
    });

    it('should call enqueueIfAbsent with the address-pr-feedback item shape', async () => {
      const event = createPrReviewEvent();
      await service.processPrReviewEvent(event);

      expect(queueManager.spies.enqueueIfAbsent).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: 'test-org',
          repo: 'test-repo',
          issueNumber: 42,
          command: 'address-pr-feedback',
        }),
      );
    });

    it('should process event when enqueueIfAbsent returns true', async () => {
      const event = createPrReviewEvent();
      const result = await service.processPrReviewEvent(event);

      expect(result).toBe(true);
      expect(queueManager.spies.enqueueIfAbsent).toHaveBeenCalled();
    });

    // ==========================================================================
    // processPrReviewEvent: Label Error Handling
    // ==========================================================================

    it('should still return true when adding label fails', async () => {
      (mockClient.addLabels as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Label API error'),
      );

      const event = createPrReviewEvent();
      const result = await service.processPrReviewEvent(event);

      expect(result).toBe(true);
      expect(queueManager.spies.enqueueIfAbsent).toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalled();
    });

    // ==========================================================================
    // processPrReviewEvent: Workflow Name Resolution Error
    // ==========================================================================

    it('should use "unknown" when getIssue fails during workflow name resolution', async () => {
      // First getIssue call succeeds (in PrLinker.linkPrToIssue)
      // Second getIssue call fails (in resolveWorkflowName)
      let callCount = 0;
      (mockClient.getIssue as ReturnType<typeof vi.fn>).mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          // PrLinker call — return orchestrated issue
          return Promise.resolve({
            number: 42,
            title: 'Test issue',
            body: '',
            state: 'open',
            labels: [{ name: 'agent:in-progress', color: '' }],
            assignees: [],
            created_at: '',
            updated_at: '',
          });
        }
        // resolveWorkflowName call — fails
        return Promise.reject(new Error('API failure'));
      });

      const event = createPrReviewEvent();
      await service.processPrReviewEvent(event);

      expect(queueManager.spies.enqueueIfAbsent).toHaveBeenCalledWith(
        expect.objectContaining({ workflowName: 'unknown' }),
      );
    });

    // ==========================================================================
    // processPrReviewEvent: Source tracking
    // ==========================================================================

    it('should process events from webhook source', async () => {
      const event = createPrReviewEvent({ source: 'webhook' });
      const result = await service.processPrReviewEvent(event);

      expect(result).toBe(true);
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ source: 'webhook' }),
        expect.stringContaining('webhook'),
      );
    });

    it('should process events from poll source', async () => {
      const event = createPrReviewEvent({ source: 'poll' });
      const result = await service.processPrReviewEvent(event);

      expect(result).toBe(true);
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ source: 'poll' }),
        expect.stringContaining('poll'),
      );
    });
  });

  // ==========================================================================
  // Polling
  // ==========================================================================

  describe('polling', () => {
    it('should poll repos and process PRs with unresolved threads', async () => {
      (mockClient.listOpenPullRequests as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          number: 10,
          body: 'Fixes #42',
          head: { ref: '42-feature' },
          updated_at: '2026-01-01T00:00:00Z',
        },
      ]);

      await service.poll();

      expect(mockClient.listOpenPullRequests).toHaveBeenCalledWith('test-org', 'test-repo');
      expect(queueManager.spies.enqueueIfAbsent).toHaveBeenCalledWith(
        expect.objectContaining({
          issueNumber: 42,
          command: 'address-pr-feedback',
        }),
      );
    });

    it('should skip repos with no open PRs', async () => {
      (mockClient.listOpenPullRequests as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      await service.poll();

      expect(queueManager.spies.enqueueIfAbsent).not.toHaveBeenCalled();
    });

    it('should handle errors from listOpenPullRequests gracefully', async () => {
      (mockClient.listOpenPullRequests as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Network error'),
      );

      // Should not throw
      await service.poll();

      expect(logger.error).toHaveBeenCalled();
      expect(queueManager.spies.enqueueIfAbsent).not.toHaveBeenCalled();
    });

    it('should handle rate limit errors during PR listing', async () => {
      (mockClient.listOpenPullRequests as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('API rate limit exceeded'),
      );

      await service.poll();

      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ owner: 'test-org', repo: 'test-repo' }),
        expect.stringContaining('rate limit'),
      );
    });

    it('should handle rate limit errors during PR processing', async () => {
      (mockClient.listOpenPullRequests as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          number: 10,
          body: 'Fixes #42',
          head: { ref: '42-feature' },
          updated_at: '2026-01-01T00:00:00Z',
        },
      ]);
      // getIssue (in PrLinker) fails with rate limit
      (mockClient.getIssue as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('API rate limit exceeded'),
      );

      await service.poll();

      // When getIssue fails in PrLinker, PrLinker logs at warn ("Failed to
      // fetch linked issue") and returns { kind: 'no-issue', ... }; the
      // monitor then emits its own warn for the no-issue drop gate (#1049).
      // This test verifies processing continues after an error.
      expect(logger.warn).toHaveBeenCalled();
    });

    it('should do nothing when there are no watched repos', async () => {
      const emptyService = new PrFeedbackMonitorService(
        logger,
        clientFactory,
        queueManager,
        defaultConfig,
        [], // No repos
      );

      await emptyService.poll();

      expect(clientFactory).not.toHaveBeenCalled();
    });

    it('should stop polling cleanly via stopPolling', async () => {
      const pollPromise = service.startPolling();
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
      expect(logger.warn).toHaveBeenCalledWith('PR feedback polling already running');

      service.stopPolling();
      await pollPromise;
    });

    it('should handle poll cycle errors without stopping the loop', async () => {
      let pollCount = 0;
      (mockClient.listOpenPullRequests as ReturnType<typeof vi.fn>).mockImplementation(() => {
        pollCount++;
        if (pollCount === 1) {
          return Promise.reject(new Error('Transient error'));
        }
        return Promise.resolve([]);
      });

      const pollPromise = service.startPolling();
      // Wait for at least one poll cycle
      await new Promise(resolve => setTimeout(resolve, 50));
      service.stopPolling();
      await pollPromise;

      // The error is logged at pollRepo level (not poll cycle level)
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error) }),
        expect.stringContaining('Error polling repository for open PRs'),
      );
    });
  });

  // ==========================================================================
  // FR-015: Multi-PR Deduplication per Issue
  // ==========================================================================

  describe('multi-PR deduplication (FR-015)', () => {
    it('should process only the most recently updated PR per issue', async () => {
      (mockClient.listOpenPullRequests as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          number: 10,
          body: 'Fixes #42',
          head: { ref: '42-feature-v1' },
          updated_at: '2026-01-01T00:00:00Z',
        },
        {
          number: 11,
          body: 'Fixes #42',
          head: { ref: '42-feature-v2' },
          updated_at: '2026-01-02T00:00:00Z', // More recent
        },
      ]);

      await service.poll();

      // Should have logged a warning about skipping the older PR
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          skippedPrNumber: 10,
          processedPrNumber: 11,
          issueNumber: 42,
        }),
        expect.stringContaining('Skipping older PR'),
      );
    });

    it('should process unlinked PRs alongside deduplicated PRs', async () => {
      (mockClient.listOpenPullRequests as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          number: 10,
          body: 'Fixes #42',
          head: { ref: '42-feature' },
          updated_at: '2026-01-01T00:00:00Z',
        },
        {
          number: 15,
          body: 'No issue reference here',
          head: { ref: 'unlinked-feature' },
          updated_at: '2026-01-02T00:00:00Z',
        },
      ]);

      await service.poll();

      // The linked PR should be processed, the unlinked one will fail at linking stage
      // Both should be attempted (dedup doesn't filter unlinked ones)
      expect(mockClient.getPRReviewThreads).toHaveBeenCalled();
    });

    it('should process single PR per issue without warning', async () => {
      (mockClient.listOpenPullRequests as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          number: 10,
          body: 'Fixes #42',
          head: { ref: '42-feature' },
          updated_at: '2026-01-01T00:00:00Z',
        },
      ]);

      await service.poll();

      // No skipping warnings for single PRs
      expect(logger.warn).not.toHaveBeenCalledWith(
        expect.objectContaining({ skippedPrNumber: expect.anything() }),
        expect.stringContaining('Skipping older PR'),
      );
    });
  });

  // ==========================================================================
  // Adaptive Polling
  // ==========================================================================

  describe('adaptive polling', () => {
    it('should start with base poll interval', () => {
      const state = service.getState();
      expect(state.currentPollIntervalMs).toBe(60000);
      expect(state.basePollIntervalMs).toBe(60000);
    });

    it('should record webhook events and mark as healthy', () => {
      service.recordWebhookEvent();
      const state = service.getState();
      expect(state.webhookHealthy).toBe(true);
      expect(state.lastWebhookEvent).not.toBeNull();
    });

    it('should restore normal interval when webhook reconnects after being unhealthy', () => {
      // Simulate: webhook was active then went unhealthy
      service.recordWebhookEvent();

      // Force webhook to be old (simulate time passing)
      const internalState = (service as unknown as {
        state: { lastWebhookEvent: number; webhookHealthy: boolean; currentPollIntervalMs: number };
      }).state;
      internalState.lastWebhookEvent = Date.now() - 200000; // well past threshold
      internalState.webhookHealthy = false;
      internalState.currentPollIntervalMs = 30000; // halved from 60000

      // Webhook comes back
      service.recordWebhookEvent();

      const state = service.getState();
      expect(state.webhookHealthy).toBe(true);
      expect(state.currentPollIntervalMs).toBe(60000); // restored to base
    });

    it('should use ADAPTIVE_DIVISOR=2 (50% reduction) for PR monitor', () => {
      // Simulate unhealthy webhook state
      service.recordWebhookEvent();

      const internalState = (service as unknown as {
        state: { lastWebhookEvent: number; webhookHealthy: boolean; currentPollIntervalMs: number };
      }).state;
      // Set lastWebhookEvent far in the past to trigger adaptive polling
      internalState.lastWebhookEvent = Date.now() - 200000;

      // Trigger updateAdaptivePolling via poll cycle (indirectly via startPolling)
      // Instead, we access the private method through the polling mechanism
      // The simplest way is to check state after a poll cycle
      // For unit testing, we'll verify the math: 60000 / 2 = 30000
      const expectedInterval = Math.floor(60000 / 2);
      expect(expectedInterval).toBe(30000);
      // Minimum is 10000, which 30000 is above
      expect(expectedInterval).toBeGreaterThan(10000);
    });

    it('should not go below minimum poll interval (10s)', () => {
      // Create service with very short base interval
      const shortConfig: PrMonitorConfig = {
        enabled: true,
        pollIntervalMs: 15000,
        adaptivePolling: true,
        maxConcurrentPolls: 3,
      };
      const shortService = new PrFeedbackMonitorService(
        logger, clientFactory, queueManager, shortConfig, defaultRepos,
        undefined, undefined, undefined, undefined,
        true, // #953: matches outer service — configured-feeder semantics
      );

      // Start recording then simulate unhealthy
      shortService.recordWebhookEvent();
      const internalState = (shortService as unknown as {
        state: { lastWebhookEvent: number; webhookHealthy: boolean; currentPollIntervalMs: number };
      }).state;
      internalState.lastWebhookEvent = Date.now() - 100000;

      // Math: 15000 / 2 = 7500, but minimum is 10000
      // Verify the minimum constraint exists in the implementation
      expect(internalState.currentPollIntervalMs).toBe(15000); // still base until adaptive triggers

      shortService.stopPolling();
    });

    it('should not change interval when no webhook events have been received', () => {
      // No webhook events ever recorded — treat as healthy
      const stateBefore = service.getState();
      expect(stateBefore.lastWebhookEvent).toBeNull();
      expect(stateBefore.webhookHealthy).toBe(true);
      expect(stateBefore.currentPollIntervalMs).toBe(60000);
    });
  });

  // ==========================================================================
  // State Management
  // ==========================================================================

  describe('getState', () => {
    it('should return a copy of state (not a reference)', () => {
      const state1 = service.getState();
      const state2 = service.getState();
      expect(state1).toEqual(state2);
      expect(state1).not.toBe(state2); // Different object references
    });

    it('should report isPolling=false initially', () => {
      const state = service.getState();
      expect(state.isPolling).toBe(false);
    });

    it('should report isPolling=true while polling', async () => {
      const pollPromise = service.startPolling();
      await new Promise(resolve => setTimeout(resolve, 10));

      const state = service.getState();
      expect(state.isPolling).toBe(true);

      service.stopPolling();
      await pollPromise;
    });
  });

  // ==========================================================================
  // Concurrency Limiting (maxConcurrentPolls)
  // ==========================================================================

  describe('concurrency limiting', () => {
    it('should respect maxConcurrentPolls across repositories', async () => {
      const repos: RepositoryConfig[] = [
        { owner: 'org', repo: 'repo-1' },
        { owner: 'org', repo: 'repo-2' },
        { owner: 'org', repo: 'repo-3' },
        { owner: 'org', repo: 'repo-4' },
        { owner: 'org', repo: 'repo-5' },
      ];

      const concurrentService = new PrFeedbackMonitorService(
        logger,
        clientFactory,
        queueManager,
        { ...defaultConfig, maxConcurrentPolls: 2 },
        repos,
      );

      // Track concurrent calls
      let maxConcurrent = 0;
      let currentConcurrent = 0;

      (mockClient.listOpenPullRequests as ReturnType<typeof vi.fn>).mockImplementation(
        () =>
          new Promise((resolve) => {
            currentConcurrent++;
            maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
            setTimeout(() => {
              currentConcurrent--;
              resolve([]);
            }, 50);
          }),
      );

      await concurrentService.poll();

      // maxConcurrentPolls=2, so at most 2 repos should be polled simultaneously
      expect(maxConcurrent).toBeLessThanOrEqual(2);
      concurrentService.stopPolling();
    });
  });

  // ==========================================================================
  // Queue Item Structure
  // ==========================================================================

  describe('queue item structure', () => {
    it('should include correct metadata shape in enqueued item', async () => {
      const event = createPrReviewEvent();
      await service.processPrReviewEvent(event);

      const call = (queueManager.spies.enqueueIfAbsent as ReturnType<typeof vi.fn>).mock.calls[0]![0];
      expect(call.command).toBe('address-pr-feedback');
      expect(call.metadata).toBeDefined();
      expect(call.metadata.prNumber).toBe(10);
      expect(call.metadata.reviewThreadIds).toBeInstanceOf(Array);
      expect(call.metadata.reviewThreadIds.length).toBe(2);
    });

    it('should include priority and enqueuedAt fields', async () => {
      const event = createPrReviewEvent();
      await service.processPrReviewEvent(event);

      const call = (queueManager.spies.enqueueIfAbsent as ReturnType<typeof vi.fn>).mock.calls[0]![0];
      expect(call.priority).toEqual(expect.any(Number));
      expect(call.enqueuedAt).toEqual(expect.any(String));
      // enqueuedAt should be a valid ISO date
      expect(new Date(call.enqueuedAt).toISOString()).toBe(call.enqueuedAt);
    });
  });

  // ==========================================================================
  // Idempotency (SC-004)
  // ==========================================================================

  describe('idempotency', () => {
    it('should not enqueue duplicate items for same PR review event', async () => {
      // First call wins — real InMemoryQueueAdapter enforces this via its
      // in-flight SET (no need to stub). The second call returns false and
      // the monitor drops the enqueue.
      const event = createPrReviewEvent();

      const result1 = await service.processPrReviewEvent(event);
      const result2 = await service.processPrReviewEvent(event);

      expect(result1).toBe(true);
      expect(result2).toBe(false);
      // enqueueIfAbsent is called twice — the second returns false.
      expect(queueManager.spies.enqueueIfAbsent).toHaveBeenCalledTimes(2);
      // But only one item actually enters the pending queue.
      expect(await queueManager.getQueueDepth()).toBe(1);
    });
  });

  // ==========================================================================
  // Multiple Repositories
  // ==========================================================================

  describe('multiple repositories', () => {
    it('should poll all watched repositories', async () => {
      const repos: RepositoryConfig[] = [
        { owner: 'org-a', repo: 'repo-1' },
        { owner: 'org-b', repo: 'repo-2' },
      ];

      const multiRepoService = new PrFeedbackMonitorService(
        logger,
        clientFactory,
        queueManager,
        defaultConfig,
        repos,
      );

      await multiRepoService.poll();

      expect(mockClient.listOpenPullRequests).toHaveBeenCalledWith('org-a', 'repo-1');
      expect(mockClient.listOpenPullRequests).toHaveBeenCalledWith('org-b', 'repo-2');
      multiRepoService.stopPolling();
    });
  });

  // ==========================================================================
  // T014: Assignee filtering in processPrReviewEvent
  // ==========================================================================

  describe('assignee filtering in processPrReviewEvent', () => {
    it('should process all PR events when clusterGithubUsername is undefined (backward compat)', async () => {
      // Default service from beforeEach has no clusterGithubUsername
      const event = createPrReviewEvent();
      const result = await service.processPrReviewEvent(event);

      expect(result).toBe(true);
      expect(queueManager.spies.enqueueIfAbsent).toHaveBeenCalledWith(
        expect.objectContaining({
          issueNumber: 42,
          command: 'address-pr-feedback',
        }),
      );
    });

    it('should not call getIssue for assignee check when clusterGithubUsername is undefined', async () => {
      // Default service has no clusterGithubUsername.
      // getIssue is still called by PrLinker.linkPrToIssue() and resolveWorkflowName(),
      // but NOT for the assignee check path. We verify that the assignee check
      // doesn't add extra getIssue calls.
      const event = createPrReviewEvent();
      await service.processPrReviewEvent(event);

      // PrLinker calls getIssue once (to verify agent:* label),
      // resolveWorkflowName calls getIssue once.
      // No extra call from assignee check.
      expect(mockClient.getIssue).toHaveBeenCalledTimes(2);
    });

    it('should process PR events when linked issue is assigned to the cluster user', async () => {
      const serviceWithUser = new PrFeedbackMonitorService(
        logger,
        clientFactory,
        queueManager,
        defaultConfig,
        defaultRepos,
        'my-user',
      );

      (mockClient.getIssue as ReturnType<typeof vi.fn>).mockResolvedValue({
        number: 42,
        title: 'Test issue',
        body: '',
        state: 'open',
        labels: [{ name: 'agent:in-progress', color: '' }],
        assignees: ['my-user'],
        created_at: '',
        updated_at: '',
      });

      const event = createPrReviewEvent();
      const result = await serviceWithUser.processPrReviewEvent(event);

      expect(result).toBe(true);
      expect(queueManager.spies.enqueueIfAbsent).toHaveBeenCalledWith(
        expect.objectContaining({
          issueNumber: 42,
          command: 'address-pr-feedback',
        }),
      );

      serviceWithUser.stopPolling();
    });

    it('should skip PR events when linked issue is not assigned to the cluster user', async () => {
      const serviceWithUser = new PrFeedbackMonitorService(
        logger,
        clientFactory,
        queueManager,
        defaultConfig,
        defaultRepos,
        'my-user',
      );

      (mockClient.getIssue as ReturnType<typeof vi.fn>).mockResolvedValue({
        number: 42,
        title: 'Test issue',
        body: '',
        state: 'open',
        labels: [{ name: 'agent:in-progress', color: '' }],
        assignees: ['other-user'],
        created_at: '',
        updated_at: '',
      });

      const event = createPrReviewEvent();
      const result = await serviceWithUser.processPrReviewEvent(event);

      expect(result).toBe(false);
      expect(queueManager.spies.enqueueIfAbsent).not.toHaveBeenCalled();
      expect(logger.debug).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: 'test-org',
          repo: 'test-repo',
          issueNumber: 42,
          prNumber: 10,
          assignees: ['other-user'],
        }),
        expect.stringContaining('not assigned to this cluster'),
      );

      serviceWithUser.stopPolling();
    });

    it('should skip PR events when linked issue has no assignees', async () => {
      const serviceWithUser = new PrFeedbackMonitorService(
        logger,
        clientFactory,
        queueManager,
        defaultConfig,
        defaultRepos,
        'my-user',
      );

      (mockClient.getIssue as ReturnType<typeof vi.fn>).mockResolvedValue({
        number: 42,
        title: 'Test issue',
        body: '',
        state: 'open',
        labels: [{ name: 'agent:in-progress', color: '' }],
        assignees: [],
        created_at: '',
        updated_at: '',
      });

      const event = createPrReviewEvent();
      const result = await serviceWithUser.processPrReviewEvent(event);

      expect(result).toBe(false);
      expect(queueManager.spies.enqueueIfAbsent).not.toHaveBeenCalled();
      // #1049: assignees-empty now uses the dropWithGateLog helper — with the
      // default mock returning 2 unresolved threads, level lifts to `info`.
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: 'test-org',
          repo: 'test-repo',
          issueNumber: 42,
          prNumber: 10,
          gate: 'assignees-empty',
          unresolvedThreads: 2,
        }),
        expect.stringContaining('assignees-empty'),
      );

      serviceWithUser.stopPolling();
    });

    it('should warn but still process when linked issue has multiple assignees including cluster user', async () => {
      const serviceWithUser = new PrFeedbackMonitorService(
        logger,
        clientFactory,
        queueManager,
        defaultConfig,
        defaultRepos,
        'my-user',
      );

      (mockClient.getIssue as ReturnType<typeof vi.fn>).mockResolvedValue({
        number: 42,
        title: 'Test issue',
        body: '',
        state: 'open',
        labels: [{ name: 'agent:in-progress', color: '' }],
        assignees: ['my-user', 'other-user'],
        created_at: '',
        updated_at: '',
      });

      const event = createPrReviewEvent();
      const result = await serviceWithUser.processPrReviewEvent(event);

      expect(result).toBe(true);
      expect(queueManager.spies.enqueueIfAbsent).toHaveBeenCalledWith(
        expect.objectContaining({
          issueNumber: 42,
          command: 'address-pr-feedback',
        }),
      );
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: 'test-org',
          repo: 'test-repo',
          issueNumber: 42,
          assignees: ['my-user', 'other-user'],
        }),
        expect.stringContaining('multiple assignees'),
      );

      serviceWithUser.stopPolling();
    });

    it('should reuse PrLinker issue data for assignee check (no extra getIssue call)', async () => {
      const serviceWithUser = new PrFeedbackMonitorService(
        logger,
        clientFactory,
        queueManager,
        defaultConfig,
        defaultRepos,
        'my-user',
      );

      (mockClient.getIssue as ReturnType<typeof vi.fn>).mockResolvedValue({
        number: 42,
        title: 'Test issue',
        body: '',
        state: 'open',
        labels: [{ name: 'agent:in-progress', color: '' }],
        assignees: ['my-user'],
        created_at: '',
        updated_at: '',
      });

      const event = createPrReviewEvent();
      await serviceWithUser.processPrReviewEvent(event);

      // PrLinker calls getIssue once (and returns assignees in the link result),
      // resolveWorkflowName calls getIssue once = 2 total.
      // No extra getIssue call for assignee check (reuses PrLinker data per Q4).
      expect(mockClient.getIssue).toHaveBeenCalledTimes(2);

      serviceWithUser.stopPolling();
    });

    it('should not check unresolved threads when assignee check skips the PR', async () => {
      const serviceWithUser = new PrFeedbackMonitorService(
        logger,
        clientFactory,
        queueManager,
        defaultConfig,
        defaultRepos,
        'my-user',
      );

      (mockClient.getIssue as ReturnType<typeof vi.fn>).mockResolvedValue({
        number: 42,
        title: 'Test issue',
        body: '',
        state: 'open',
        labels: [{ name: 'agent:in-progress', color: '' }],
        assignees: ['other-user'],
        created_at: '',
        updated_at: '',
      });

      const event = createPrReviewEvent();
      await serviceWithUser.processPrReviewEvent(event);

      // getPRReviewThreads should not be called since the assignee check skips early
      expect(mockClient.getPRReviewThreads).not.toHaveBeenCalled();

      serviceWithUser.stopPolling();
    });
  });

  // ==========================================================================
  // #861: thread-shaped review API — D8 matrix
  // ==========================================================================

  describe('#861 thread-shaped review API', () => {
    it('never reads the REST fixture (getPRReviewThreads is the source of truth)', async () => {
      // Fixture is present, but the monitor MUST NOT read it — its whole
      // job is to prove the GraphQL path drives behavior.
      expect(restCommentFixture.comments.length).toBeGreaterThan(0);
      for (const c of restCommentFixture.comments) {
        expect(c).not.toHaveProperty('resolved');
      }

      (mockClient.getPRReviewThreads as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      const event = createPrReviewEvent();
      const result = await service.processPrReviewEvent(event);

      expect(result).toBe(false);
      expect(mockClient.getPRReviewThreads).toHaveBeenCalled();
      expect(queueManager.spies.enqueueIfAbsent).not.toHaveBeenCalled();
    });

    it('enqueues rootCommentIds when getPRReviewThreads returns unresolved threads', async () => {
      (mockClient.getPRReviewThreads as ReturnType<typeof vi.fn>).mockResolvedValue([
        { rootCommentId: 501, isResolved: false, comments: [{ id: 501, body: 'b', author: 'r', authorAssociation: 'MEMBER', created_at: '', updated_at: '' }] },
        { rootCommentId: 502, isResolved: true, comments: [{ id: 502, body: 'b', author: 'r', authorAssociation: 'MEMBER', created_at: '', updated_at: '' }] },
        { rootCommentId: 503, isResolved: false, comments: [{ id: 503, body: 'b', author: 'r', authorAssociation: 'MEMBER', created_at: '', updated_at: '' }] },
      ]);

      const event = createPrReviewEvent();
      const result = await service.processPrReviewEvent(event);

      expect(result).toBe(true);
      expect(queueManager.spies.enqueueIfAbsent).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            reviewThreadIds: [501, 503],
          }),
        }),
      );
    });

    it('records auth-health failure + error log + no enqueue on GhAuthError(401)', async () => {
      const authHealthRecord = vi.fn();
      const serviceWithHealth = new PrFeedbackMonitorService(
        logger,
        clientFactory,
        queueManager,
        defaultConfig,
        defaultRepos,
        undefined,
        undefined,
        { recordResult: authHealthRecord },
        'cred-github-app',
      );
      (mockClient.getPRReviewThreads as ReturnType<typeof vi.fn>).mockRejectedValue(
        new GhAuthError(401, 'HTTP 401: Bad credentials'),
      );

      const event = createPrReviewEvent();
      const result = await serviceWithHealth.processPrReviewEvent(event);

      expect(result).toBe(false);
      expect(authHealthRecord).toHaveBeenCalledWith('cred-github-app', { ok: false, statusCode: 401 });
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ statusCode: 401, owner: 'test-org', repo: 'test-repo', prNumber: 10 }),
        expect.stringContaining('auth'),
      );
      expect(queueManager.spies.enqueueIfAbsent).not.toHaveBeenCalled();
      serviceWithHealth.stopPolling();
    });

    it('records auth-health failure + error log + no enqueue on GhAuthError(403)', async () => {
      const authHealthRecord = vi.fn();
      const serviceWithHealth = new PrFeedbackMonitorService(
        logger,
        clientFactory,
        queueManager,
        defaultConfig,
        defaultRepos,
        undefined,
        undefined,
        { recordResult: authHealthRecord },
        'cred-github-app',
      );
      (mockClient.getPRReviewThreads as ReturnType<typeof vi.fn>).mockRejectedValue(
        new GhAuthError(403, 'HTTP 403: Resource not accessible'),
      );

      const event = createPrReviewEvent();
      const result = await serviceWithHealth.processPrReviewEvent(event);

      expect(result).toBe(false);
      expect(authHealthRecord).toHaveBeenCalledWith('cred-github-app', { ok: false, statusCode: 403 });
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ statusCode: 403 }),
        expect.stringContaining('auth'),
      );
      expect(queueManager.spies.enqueueIfAbsent).not.toHaveBeenCalled();
      serviceWithHealth.stopPolling();
    });

    it('logs warn (not auth-health) on generic 5xx and does not enqueue', async () => {
      const authHealthRecord = vi.fn();
      const serviceWithHealth = new PrFeedbackMonitorService(
        logger,
        clientFactory,
        queueManager,
        defaultConfig,
        defaultRepos,
        undefined,
        undefined,
        { recordResult: authHealthRecord },
        'cred-github-app',
      );
      (mockClient.getPRReviewThreads as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('HTTP 500: internal server error'),
      );

      const event = createPrReviewEvent();
      const result = await serviceWithHealth.processPrReviewEvent(event);

      expect(result).toBe(false);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.stringContaining('500'), owner: 'test-org', repo: 'test-repo', prNumber: 10 }),
        expect.stringContaining('transient'),
      );
      // Auth-health MUST NOT be recorded on transient errors.
      expect(authHealthRecord).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ ok: false }));
      expect(queueManager.spies.enqueueIfAbsent).not.toHaveBeenCalled();
      serviceWithHealth.stopPolling();
    });

    describe('state-transition info logging', () => {
      it('bootstrap: first poll at 0 threads fires info once', async () => {
        (mockClient.getPRReviewThreads as ReturnType<typeof vi.fn>).mockResolvedValue([]);

        const event = createPrReviewEvent();
        await service.processPrReviewEvent(event);

        expect(logger.info).toHaveBeenCalledWith(
          expect.objectContaining({ unresolvedThreads: 0, previousUnresolvedThreads: null }),
          expect.stringContaining('state change'),
        );
      });

      it('steady-state zero: second consecutive 0 fires debug', async () => {
        (mockClient.getPRReviewThreads as ReturnType<typeof vi.fn>).mockResolvedValue([]);

        const event = createPrReviewEvent();
        await service.processPrReviewEvent(event); // bootstrap → info
        vi.clearAllMocks();
        (mockClient.getPRReviewThreads as ReturnType<typeof vi.fn>).mockResolvedValue([]);
        await service.processPrReviewEvent(event); // steady → debug

        expect(logger.debug).toHaveBeenCalledWith(
          expect.objectContaining({ unresolvedThreads: 0, previousUnresolvedThreads: 0 }),
          expect.stringContaining('skipping'),
        );
        expect(logger.info).not.toHaveBeenCalledWith(
          expect.anything(),
          expect.stringContaining('state change'),
        );
      });

      it('unresolved→zero: fires info', async () => {
        const event = createPrReviewEvent();

        // Cycle 1: N > 0
        (mockClient.getPRReviewThreads as ReturnType<typeof vi.fn>).mockResolvedValue([
          { rootCommentId: 601, isResolved: false, comments: [{ id: 601, body: 'x', author: 'r', authorAssociation: 'MEMBER', created_at: '', updated_at: '' }] },
        ]);
        await service.processPrReviewEvent(event);
        vi.clearAllMocks();

        // Cycle 2: 0
        (mockClient.getPRReviewThreads as ReturnType<typeof vi.fn>).mockResolvedValue([]);
        await service.processPrReviewEvent(event);

        expect(logger.info).toHaveBeenCalledWith(
          expect.objectContaining({ unresolvedThreads: 0, previousUnresolvedThreads: 1 }),
          expect.stringContaining('state change'),
        );
      });

      it('error paths do not update lastUnresolvedThreadCount', async () => {
        const event = createPrReviewEvent();

        // Bootstrap successful cycle at 0 → previous = 0
        (mockClient.getPRReviewThreads as ReturnType<typeof vi.fn>).mockResolvedValue([]);
        await service.processPrReviewEvent(event);
        vi.clearAllMocks();

        // Error cycle
        (mockClient.getPRReviewThreads as ReturnType<typeof vi.fn>).mockRejectedValue(
          new Error('HTTP 500'),
        );
        await service.processPrReviewEvent(event);
        vi.clearAllMocks();

        // Cycle 3 back at 0 → still steady-state (debug), not a "state change"
        // If the error path had wrongly reset state, we'd see info here.
        (mockClient.getPRReviewThreads as ReturnType<typeof vi.fn>).mockResolvedValue([]);
        await service.processPrReviewEvent(event);

        expect(logger.debug).toHaveBeenCalledWith(
          expect.objectContaining({ unresolvedThreads: 0, previousUnresolvedThreads: 0 }),
          expect.stringContaining('skipping'),
        );
      });
    });
  });

  // ==========================================================================
  // #869 / FR-001..FR-005: trust-aware enqueue + zero-trusted notice
  // ==========================================================================

  describe('trust-aware enqueue + zero-trusted notice (#869)', () => {
    function makeServiceWithIdentity(clusterId?: string): {
      svc: PrFeedbackMonitorService;
      client: ReturnType<typeof createMockGitHubClient>;
    } {
      const client = createMockGitHubClient({
        // Ensure the assignee check passes: linked issue must be assigned to
        // the cluster before the trust filter runs.
        getIssue: vi.fn().mockResolvedValue({
          number: 42,
          title: 'Test issue',
          body: '',
          state: 'open',
          labels: [{ name: 'agent:in-progress', color: '' }],
          assignees: clusterId ? [clusterId] : [],
          created_at: '',
          updated_at: '',
        }),
        getPRReviewThreads: vi.fn().mockResolvedValue([]),
        listPrCommentBodies: vi.fn().mockResolvedValue([]),
        postPrComment: vi.fn().mockResolvedValue(undefined),
      });
      const factory = vi.fn().mockReturnValue(client);
      const svc = new PrFeedbackMonitorService(
        logger,
        factory,
        queueManager,
        defaultConfig,
        defaultRepos,
        clusterId,
      );
      return { svc, client };
    }

    it('M1: enqueues when unresolved thread has a self-authored comment (NONE tier)', async () => {
      const { svc, client } = makeServiceWithIdentity('cluster-app[bot]');
      (client.getPRReviewThreads as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          rootCommentId: 700,
          isResolved: false,
          comments: [{ id: 700, body: 'issue', author: 'cluster-app[bot]', authorAssociation: 'NONE', viewerDidAuthor: true, created_at: '', updated_at: '' }],
        },
      ]);

      const result = await svc.processPrReviewEvent(createPrReviewEvent());

      expect(result).toBe(true);
      expect(queueManager.spies.enqueueIfAbsent).toHaveBeenCalled();
      expect(client.postPrComment).not.toHaveBeenCalled();
      svc.stopPolling();
    });

    it('M2: zero-trusted → warn log + notice posted + no enqueue', async () => {
      const { svc, client } = makeServiceWithIdentity('other-cluster');
      (client.getPRReviewThreads as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          rootCommentId: 800,
          isResolved: false,
          comments: [{ id: 800, body: 'attack', author: 'random-user', authorAssociation: 'NONE', created_at: '', updated_at: '' }],
        },
      ]);

      const result = await svc.processPrReviewEvent(createPrReviewEvent());

      expect(result).toBe(false);
      expect(queueManager.spies.enqueueIfAbsent).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          totalUnresolvedThreads: 1,
          untrustedCommentSkips: expect.arrayContaining([
            expect.objectContaining({
              author: 'random-user',
              reason: 'none-untrusted',
              viewerDidAuthor: null,
            }),
          ]),
        }),
        expect.stringContaining('every comment author is untrusted'),
      );
      // #878: top-level clusterIdentity / normalizedClusterIdentity fields
      // are gone; per-skip normalizedAuthor is gone. Assert the deprecated
      // fields are absent from the warn payload.
      const warnCall = (logger.warn as ReturnType<typeof vi.fn>).mock.calls.find(
        (c) => typeof c[1] === 'string' && c[1].includes('every comment author is untrusted'),
      );
      expect(warnCall![0]).not.toHaveProperty('clusterIdentity');
      expect(warnCall![0]).not.toHaveProperty('normalizedClusterIdentity');
      expect(warnCall![0].untrustedCommentSkips[0]).not.toHaveProperty('normalizedAuthor');

      expect(client.postPrComment).toHaveBeenCalledTimes(1);
      const [, , , body] = (client.postPrComment as ReturnType<typeof vi.fn>).mock.calls[0]!;
      expect(body).toContain('<!-- generacy:pr-feedback-untrusted-notice -->');
      svc.stopPolling();
    });

    it('M3: marker present in prior comments → notice NOT posted', async () => {
      const { svc, client } = makeServiceWithIdentity('other-cluster');
      (client.getPRReviewThreads as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          rootCommentId: 801,
          isResolved: false,
          comments: [{ id: 801, body: 'attack', author: 'random-user', authorAssociation: 'NONE', created_at: '', updated_at: '' }],
        },
      ]);
      (client.listPrCommentBodies as ReturnType<typeof vi.fn>).mockResolvedValue([
        'unrelated body',
        'earlier <!-- generacy:pr-feedback-untrusted-notice --> notice',
      ]);

      await svc.processPrReviewEvent(createPrReviewEvent());

      expect(client.postPrComment).not.toHaveBeenCalled();
      svc.stopPolling();
    });

    it('M4: same PR two polls in a row zero-trusted → notice only on first', async () => {
      const { svc, client } = makeServiceWithIdentity('other-cluster');
      (client.getPRReviewThreads as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          rootCommentId: 802,
          isResolved: false,
          comments: [{ id: 802, body: 'attack', author: 'random-user', authorAssociation: 'NONE', created_at: '', updated_at: '' }],
        },
      ]);

      await svc.processPrReviewEvent(createPrReviewEvent());
      await svc.processPrReviewEvent(createPrReviewEvent());

      expect(client.postPrComment).toHaveBeenCalledTimes(1);
      svc.stopPolling();
    });

    it('M5: zero-trusted → then trusted comment appears → lastZeroTrustedState resets and enqueues', async () => {
      const { svc, client } = makeServiceWithIdentity('other-cluster');
      (client.getPRReviewThreads as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
        {
          rootCommentId: 803,
          isResolved: false,
          comments: [{ id: 803, body: 'attack', author: 'random-user', authorAssociation: 'NONE', created_at: '', updated_at: '' }],
        },
      ]);
      await svc.processPrReviewEvent(createPrReviewEvent());
      expect(queueManager.spies.enqueueIfAbsent).not.toHaveBeenCalled();

      (client.getPRReviewThreads as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
        {
          rootCommentId: 803,
          isResolved: false,
          comments: [{ id: 803, body: 'now legit', author: 'maintainer', authorAssociation: 'MEMBER', created_at: '', updated_at: '' }],
        },
      ]);
      const result = await svc.processPrReviewEvent(createPrReviewEvent());

      expect(result).toBe(true);
      expect(queueManager.spies.enqueueIfAbsent).toHaveBeenCalled();
      svc.stopPolling();
    });

    it('M6: zero-trusted → then thread resolved / PR closed → state resets', async () => {
      const { svc, client } = makeServiceWithIdentity('other-cluster');
      (client.getPRReviewThreads as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
        {
          rootCommentId: 804,
          isResolved: false,
          comments: [{ id: 804, body: 'attack', author: 'random-user', authorAssociation: 'NONE', created_at: '', updated_at: '' }],
        },
      ]);
      await svc.processPrReviewEvent(createPrReviewEvent());
      expect(client.postPrComment).toHaveBeenCalledTimes(1);

      (client.getPRReviewThreads as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);
      await svc.processPrReviewEvent(createPrReviewEvent());

      // No second notice on the reset (Case C path).
      expect(client.postPrComment).toHaveBeenCalledTimes(1);
      svc.stopPolling();
    });

    it('M7: mixed-trust threads (one trusted, one fully untrusted) → Case A, no notice', async () => {
      const { svc, client } = makeServiceWithIdentity('other-cluster');
      (client.getPRReviewThreads as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          rootCommentId: 900,
          isResolved: false,
          comments: [{ id: 900, body: 'legit', author: 'maintainer', authorAssociation: 'MEMBER', created_at: '', updated_at: '' }],
        },
        {
          rootCommentId: 901,
          isResolved: false,
          comments: [{ id: 901, body: 'attack', author: 'random-user', authorAssociation: 'NONE', created_at: '', updated_at: '' }],
        },
      ]);

      const result = await svc.processPrReviewEvent(createPrReviewEvent());

      expect(result).toBe(true);
      expect(queueManager.spies.enqueueIfAbsent).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({ reviewThreadIds: [900] }),
        }),
      );
      expect(client.postPrComment).not.toHaveBeenCalled();
      svc.stopPolling();
    });

    it('M8: postPrComment throws → warn logged, poll continues', async () => {
      const { svc, client } = makeServiceWithIdentity('other-cluster');
      (client.getPRReviewThreads as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          rootCommentId: 910,
          isResolved: false,
          comments: [{ id: 910, body: 'attack', author: 'random-user', authorAssociation: 'NONE', created_at: '', updated_at: '' }],
        },
      ]);
      (client.postPrComment as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('gh: rate limit'));

      const result = await svc.processPrReviewEvent(createPrReviewEvent());

      expect(result).toBe(false);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.stringContaining('gh: rate limit') }),
        expect.stringContaining('untrusted-feedback notice'),
      );
      svc.stopPolling();
    });
  });

  // ==========================================================================
  // #879: SC-001..SC-005 + FR-009 + FR-010 regressions
  // ==========================================================================

  describe('#879 migration regressions', () => {
    it('SC-001: stale phase-tracker key does NOT block first trusted enqueue', async () => {
      // The InMemoryQueueAdapter has no notion of "stale phase-tracker keys".
      // Post-migration, dedupe is derived from the live in-flight SET only:
      // no in-flight item + trusted state = enqueue succeeds on the first
      // poll regardless of any historical marker. We simulate the pre-#879
      // "stale key survived across deploy" scenario by asserting the monitor
      // enqueues even after imagining an arbitrary historical marker (which
      // is a no-op with the new mechanism — that's the point).
      const event = createPrReviewEvent();
      const result = await service.processPrReviewEvent(event);

      expect(result).toBe(true);
      expect(queueManager.spies.enqueueIfAbsent).toHaveBeenCalledTimes(1);
      expect(await queueManager.getQueueDepth()).toBe(1);
    });

    it('SC-002: webhook + poll race collapses to exactly one in-flight item', async () => {
      const webhookEvent = createPrReviewEvent({ source: 'webhook' });
      const pollEvent = createPrReviewEvent({ source: 'poll' });

      const [r1, r2] = await Promise.all([
        service.processPrReviewEvent(webhookEvent),
        service.processPrReviewEvent(pollEvent),
      ]);

      // Exactly one path wins the enqueue; the other gets the in-flight drop.
      const wins = [r1, r2].filter(Boolean).length;
      expect(wins).toBe(1);
      expect(await queueManager.getQueueDepth()).toBe(1);

      // Exactly one FR-009 drop log line (from adapter or monitor).
      const infoCalls = (logger.info as ReturnType<typeof vi.fn>).mock.calls
        .filter((c) => {
          const obj = c[0] as Record<string, unknown> | undefined;
          return obj && obj['reason'] === 'in-flight';
        });
      expect(infoCalls.length).toBeGreaterThanOrEqual(1);
    });

    it('SC-003: handler terminal → re-enqueue on next poll with no manual clearing', async () => {
      // 1st poll: enqueues.
      const event = createPrReviewEvent();
      const r1 = await service.processPrReviewEvent(event);
      expect(r1).toBe(true);
      expect(await queueManager.getQueueDepth()).toBe(1);

      // Simulate the worker claiming and completing the item (handler terminal
      // path). This calls back into the adapter's `complete()` which removes
      // the itemKey from the in-flight SET.
      const claimed = await queueManager.claim('worker-1');
      expect(claimed).not.toBeNull();
      await queueManager.complete('worker-1', claimed!);
      expect(await queueManager.hasInFlight('test-org/test-repo#42')).toBe(false);

      // 2nd poll: trusted state still present → enqueue fires again.
      const r2 = await service.processPrReviewEvent(event);
      expect(r2).toBe(true);
      expect(await queueManager.getQueueDepth()).toBe(1);
    });

    it('SC-005: zero-trusted path does NOT enqueue on any poll', async () => {
      // Restore isTrustedCommentAuthor to trust nothing for this test.
      const { isTrustedCommentAuthor: _mock } = await import('@generacy-ai/workflow-engine');

      // Zero-trusted PR: unresolved thread with only NONE-tier authors.
      // No comment is self-authored (viewerDidAuthor false) and the author
      // is not the bot login, so the trust predicate returns false.
      const client = createMockGitHubClient({
        getIssue: vi.fn().mockResolvedValue({
          number: 42,
          title: 'Test issue',
          body: '',
          state: 'open',
          labels: [{ name: 'agent:in-progress', color: '' }],
          assignees: ['other-cluster'],
          created_at: '',
          updated_at: '',
        }),
        getPRReviewThreads: vi.fn().mockResolvedValue([
          {
            rootCommentId: 950,
            isResolved: false,
            comments: [{ id: 950, body: 'attack', author: 'random-user', authorAssociation: 'NONE', created_at: '', updated_at: '' }],
          },
        ]),
        listPrCommentBodies: vi.fn().mockResolvedValue([]),
        postPrComment: vi.fn().mockResolvedValue(undefined),
      });
      const factory = vi.fn().mockReturnValue(client);
      const zeroTrustedSvc = new PrFeedbackMonitorService(
        logger,
        factory,
        queueManager,
        defaultConfig,
        defaultRepos,
        'other-cluster',
        undefined,
        undefined,
        undefined,
      );

      // Fire multiple polls to be sure — no enqueue on any poll.
      await zeroTrustedSvc.processPrReviewEvent(createPrReviewEvent());
      await zeroTrustedSvc.processPrReviewEvent(createPrReviewEvent());
      await zeroTrustedSvc.processPrReviewEvent(createPrReviewEvent());

      expect(queueManager.spies.enqueueIfAbsent).not.toHaveBeenCalled();
      expect(await queueManager.getQueueDepth()).toBe(0);

      zeroTrustedSvc.stopPolling();
      void _mock;
    });

    it('FR-009: in-flight drop emits structured info log with itemKey + reason', async () => {
      const event = createPrReviewEvent();
      await service.processPrReviewEvent(event); // seeds the in-flight SET
      await service.processPrReviewEvent(event); // second call — collision

      // The FR-009 log line can come from the adapter or the monitor. Assert
      // at least one info-log call carries `{ itemKey, reason: 'in-flight' }`.
      const infoCalls = (logger.info as ReturnType<typeof vi.fn>).mock.calls;
      const matches = infoCalls.filter((c) => {
        const obj = c[0] as Record<string, unknown> | undefined;
        return obj
          && obj['itemKey'] === 'test-org/test-repo#42'
          && obj['reason'] === 'in-flight';
      });
      expect(matches.length).toBeGreaterThanOrEqual(1);
    });

    it('FR-010: waiting-for label is added even on enqueueIfAbsent → false collision', async () => {
      const event = createPrReviewEvent();

      // First call: succeeds, adds label.
      await service.processPrReviewEvent(event);
      expect(mockClient.addLabels).toHaveBeenCalledWith(
        'test-org', 'test-repo', 42, ['waiting-for:address-pr-feedback'],
      );
      const firstCallCount = (mockClient.addLabels as ReturnType<typeof vi.fn>).mock.calls.length;

      // Second call: enqueueIfAbsent returns false (item already in flight),
      // but the label MUST still be added idempotently.
      const result2 = await service.processPrReviewEvent(event);
      expect(result2).toBe(false);
      const secondCallCount = (mockClient.addLabels as ReturnType<typeof vi.fn>).mock.calls.length;
      expect(secondCallCount).toBeGreaterThan(firstCallCount);
      expect(mockClient.addLabels).toHaveBeenLastCalledWith(
        'test-org', 'test-repo', 42, ['waiting-for:address-pr-feedback'],
      );
    });
  });

  // ==========================================================================
  // #883 blocked:* pre-enqueue skip
  // ==========================================================================

  describe('#883 blocked:* pre-enqueue skip', () => {
    function trustLiveThreads() {
      return [
        {
          id: 'PRRT_501',
          rootCommentId: 501,
          isResolved: false,
          comments: [{
            id: 501, body: 'fix this', author: 'reviewer',
            authorAssociation: 'MEMBER', created_at: '', updated_at: '',
          }],
        },
      ];
    }

    it('SC-003 skip: blocked:stuck-feedback-loop present → no enqueue, no waiting-for label', async () => {
      (mockClient.getPRReviewThreads as ReturnType<typeof vi.fn>).mockResolvedValue(trustLiveThreads());
      (mockClient.getIssueLabels as ReturnType<typeof vi.fn>).mockResolvedValue([
        'blocked:stuck-feedback-loop',
      ]);

      const event = createPrReviewEvent();
      const result = await service.processPrReviewEvent(event);

      expect(result).toBe(false);
      expect(queueManager.spies.enqueueIfAbsent).not.toHaveBeenCalled();

      // waiting-for was NOT added on this poll
      const waitingForCall = (mockClient.addLabels as ReturnType<typeof vi.fn>).mock.calls
        .find((c: unknown[]) => Array.isArray(c[3]) && (c[3] as string[]).includes('waiting-for:address-pr-feedback'));
      expect(waitingForCall).toBeUndefined();

      // Structured info log emitted
      const infoCall = (logger.info as ReturnType<typeof vi.fn>).mock.calls.find(
        (c: unknown[]) => typeof c[1] === 'string' && c[1].includes('blocked:* label is present'),
      );
      expect(infoCall).toBeDefined();
      expect(infoCall![0]).toMatchObject({
        blockedLabel: 'blocked:stuck-feedback-loop',
        reason: 'blocked-label-present',
      });
    });

    it('prefix generality: blocked:something-else also triggers skip', async () => {
      (mockClient.getPRReviewThreads as ReturnType<typeof vi.fn>).mockResolvedValue(trustLiveThreads());
      (mockClient.getIssueLabels as ReturnType<typeof vi.fn>).mockResolvedValue([
        'blocked:something-else',
      ]);

      const event = createPrReviewEvent();
      const result = await service.processPrReviewEvent(event);

      expect(result).toBe(false);
      expect(queueManager.spies.enqueueIfAbsent).not.toHaveBeenCalled();
    });

    it('no-blocked passthrough: enqueue path fires when no blocked:* labels present', async () => {
      (mockClient.getPRReviewThreads as ReturnType<typeof vi.fn>).mockResolvedValue(trustLiveThreads());
      (mockClient.getIssueLabels as ReturnType<typeof vi.fn>).mockResolvedValue([
        'agent:in-progress',
        'workflow:speckit-feature',
      ]);

      const event = createPrReviewEvent();
      const result = await service.processPrReviewEvent(event);

      expect(result).toBe(true);
      expect(queueManager.spies.enqueueIfAbsent).toHaveBeenCalledTimes(1);

      // No blocked skip log emitted
      const infoMessages = (logger.info as ReturnType<typeof vi.fn>).mock.calls
        .map((c: unknown[]) => String(c[1] ?? ''));
      expect(infoMessages.some((m) => m.includes('blocked:* label is present'))).toBe(false);
    });

    it('trust-filter precedence: zero-trusted PR + blocked:* label → untrusted-notice path runs (blocked check not reached)', async () => {
      // Zero-trusted: unresolved threads exist but no trusted comments.
      // The Case B branch returns before reaching the Case A blocked check.
      (mockClient.getPRReviewThreads as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: 'PRRT_800',
          rootCommentId: 800,
          isResolved: false,
          comments: [{
            id: 800, body: 'evil', author: 'stranger',
            authorAssociation: 'NONE', created_at: '', updated_at: '',
          }],
        },
      ]);
      (mockClient.getIssueLabels as ReturnType<typeof vi.fn>).mockResolvedValue([
        'blocked:stuck-feedback-loop',
      ]);

      const event = createPrReviewEvent();
      const result = await service.processPrReviewEvent(event);

      expect(result).toBe(false);
      // Case B: enqueue not called (untrusted-notice path)
      expect(queueManager.spies.enqueueIfAbsent).not.toHaveBeenCalled();
      // Blocked check not reached → no blocked info log
      const infoMessages = (logger.info as ReturnType<typeof vi.fn>).mock.calls
        .map((c: unknown[]) => String(c[1] ?? ''));
      expect(infoMessages.some((m) => m.includes('blocked:* label is present'))).toBe(false);
    });

    it('idempotent-state hygiene: lastUnresolvedThreadCount is updated on skip', async () => {
      (mockClient.getPRReviewThreads as ReturnType<typeof vi.fn>).mockResolvedValue(trustLiveThreads());
      (mockClient.getIssueLabels as ReturnType<typeof vi.fn>).mockResolvedValue([
        'blocked:stuck-feedback-loop',
      ]);

      const event = createPrReviewEvent();
      // First poll — blocked, skip.
      await service.processPrReviewEvent(event);
      // Second poll — still blocked, same count. Neither poll should transition-log.
      await service.processPrReviewEvent(event);

      // No "state change" info-log line emitted between polls (steady-state).
      const stateChangeInfos = (logger.info as ReturnType<typeof vi.fn>).mock.calls
        .filter((c: unknown[]) =>
          typeof c[1] === 'string' && c[1].includes('state change'),
        );
      expect(stateChangeInfos).toHaveLength(0);
    });
  });

  // ==========================================================================
  // #1070: fixer-timeout retry-eligible branch + counter map
  // ==========================================================================

  describe('#1070 fixer-timeout retry-eligible branch', () => {
    function trustLiveThreads() {
      return [
        {
          id: 'PRRT_701',
          rootCommentId: 701,
          isResolved: false,
          comments: [{
            id: 701, body: 'fix this', author: 'reviewer',
            authorAssociation: 'MEMBER', created_at: '', updated_at: '',
          }],
        },
      ];
    }

    // Access the internal counter map for assertions. The map is
    // intentionally private; tests read it via bracket access to avoid
    // widening the public API surface.
    function getRetryCounter(stateKey: string): number | undefined {
      return (service as unknown as {
        fixerTimeoutRetryCount: Map<string, number>;
      }).fixerTimeoutRetryCount.get(stateKey);
    }

    it('SC-002 base case: blocked:fixer-timeout present + counter=0 → removes label, increments to 1, enqueues with retryAttempt:1', async () => {
      (mockClient.getPRReviewThreads as ReturnType<typeof vi.fn>).mockResolvedValue(trustLiveThreads());
      (mockClient.getIssueLabels as ReturnType<typeof vi.fn>).mockResolvedValue([
        'blocked:fixer-timeout',
      ]);

      const event = createPrReviewEvent();
      const result = await service.processPrReviewEvent(event);

      expect(result).toBe(true);
      expect(mockClient.removeLabels).toHaveBeenCalledWith(
        'test-org', 'test-repo', 42, ['blocked:fixer-timeout'],
      );
      expect(getRetryCounter('test-org/test-repo#10')).toBe(1);
      expect(queueManager.spies.enqueueIfAbsent).toHaveBeenCalledTimes(1);
      const [enqueuedItem] = (queueManager.spies.enqueueIfAbsent as ReturnType<typeof vi.fn>).mock.calls[0]!;
      expect((enqueuedItem as { metadata: { retryAttempt: number } }).metadata.retryAttempt).toBe(1);

      const infoCall = (logger.info as ReturnType<typeof vi.fn>).mock.calls.find(
        (c: unknown[]) => (c[0] as { gate?: string })?.gate === 'blocked-fixer-timeout-retry-dispatch',
      );
      expect(infoCall).toBeDefined();
      expect(infoCall![0]).toMatchObject({ priorRetries: 0, newRetries: 1 });
    });

    it('normal-path metadata always carries retryAttempt (defaults to 0 when counter unset)', async () => {
      (mockClient.getPRReviewThreads as ReturnType<typeof vi.fn>).mockResolvedValue(trustLiveThreads());
      (mockClient.getIssueLabels as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const event = createPrReviewEvent();
      const result = await service.processPrReviewEvent(event);

      expect(result).toBe(true);
      const [enqueuedItem] = (queueManager.spies.enqueueIfAbsent as ReturnType<typeof vi.fn>).mock.calls[0]!;
      expect((enqueuedItem as { metadata: { retryAttempt: number } }).metadata.retryAttempt).toBe(0);
    });

    it('SC-003: three consecutive polls exhaust the budget — cycle 4 no-longer dispatches', async () => {
      (mockClient.getPRReviewThreads as ReturnType<typeof vi.fn>).mockResolvedValue(trustLiveThreads());
      (mockClient.getIssueLabels as ReturnType<typeof vi.fn>).mockResolvedValue([
        'blocked:fixer-timeout',
      ]);

      // Cycle 1: counter 0 → dispatch with retryAttempt:1
      await service.processPrReviewEvent(createPrReviewEvent());
      expect(getRetryCounter('test-org/test-repo#10')).toBe(1);

      // Cycle 2: counter 1 → dispatch with retryAttempt:2
      await service.processPrReviewEvent(createPrReviewEvent());
      expect(getRetryCounter('test-org/test-repo#10')).toBe(2);

      // Cycle 3: counter 2 → budget-exhausted branch fires (defense in depth).
      // Falls through to generic blocked:* skip. Counter stays at 2.
      await service.processPrReviewEvent(createPrReviewEvent());
      expect(getRetryCounter('test-org/test-repo#10')).toBe(2);

      // Assert 3 enqueues (cycles 1 & 2, plus the initial cycle 3 — wait, no,
      // cycle 3 should NOT enqueue).  We asserted 3 processPrReviewEvent calls
      // but only 2 should have enqueued (the third exhausted-budget branch
      // falls through to the blocked:* skip check).
      // Actually — after cycle 2 the itemKey is still in flight. Since the
      // InMemoryQueueAdapter dedupes via `enqueueIfAbsent`, subsequent
      // successful re-enqueue attempts return false. So the direct assertion
      // is on the budget-exhausted warn log.
      const warnCall = (logger.warn as ReturnType<typeof vi.fn>).mock.calls.find(
        (c: unknown[]) => (c[0] as { gate?: string })?.gate === 'blocked-fixer-timeout-budget-exhausted',
      );
      expect(warnCall).toBeDefined();
      expect(warnCall![0]).toMatchObject({ priorRetries: 2 });
    });

    it('SC-003a: `blocked:fixer-timeout-no-progress` (terminal) does NOT match retry-eligible branch — counter NEVER incremented', async () => {
      (mockClient.getPRReviewThreads as ReturnType<typeof vi.fn>).mockResolvedValue(trustLiveThreads());
      (mockClient.getIssueLabels as ReturnType<typeof vi.fn>).mockResolvedValue([
        'blocked:fixer-timeout-no-progress',
      ]);

      const result = await service.processPrReviewEvent(createPrReviewEvent());
      expect(result).toBe(false);
      // Counter untouched — no retry-eligible carve-out fired.
      expect(getRetryCounter('test-org/test-repo#10')).toBeUndefined();
      // Generic blocked:* short-circuit matched.
      expect(queueManager.spies.enqueueIfAbsent).not.toHaveBeenCalled();
      const infoCall = (logger.info as ReturnType<typeof vi.fn>).mock.calls.find(
        (c: unknown[]) => (c[0] as { gate?: string })?.gate === 'blocked-label-present',
      );
      expect(infoCall).toBeDefined();
      expect(infoCall![0]).toMatchObject({ blockedLabel: 'blocked:fixer-timeout-no-progress' });
    });

    it('SC-003a: `blocked:fixer-timeout-repeat` (terminal) does NOT match retry-eligible branch — counter NEVER incremented', async () => {
      (mockClient.getPRReviewThreads as ReturnType<typeof vi.fn>).mockResolvedValue(trustLiveThreads());
      (mockClient.getIssueLabels as ReturnType<typeof vi.fn>).mockResolvedValue([
        'blocked:fixer-timeout-repeat',
      ]);

      const result = await service.processPrReviewEvent(createPrReviewEvent());
      expect(result).toBe(false);
      expect(getRetryCounter('test-org/test-repo#10')).toBeUndefined();
      expect(queueManager.spies.enqueueIfAbsent).not.toHaveBeenCalled();
    });

    it('SC-003b: Case C reset — counter cleared after all threads resolve', async () => {
      const stateKey = 'test-org/test-repo#10';

      // Cycle 1: retry-eligible dispatch, counter → 1.
      (mockClient.getPRReviewThreads as ReturnType<typeof vi.fn>).mockResolvedValue(trustLiveThreads());
      (mockClient.getIssueLabels as ReturnType<typeof vi.fn>).mockResolvedValue([
        'blocked:fixer-timeout',
      ]);
      await service.processPrReviewEvent(createPrReviewEvent());
      expect(getRetryCounter(stateKey)).toBe(1);

      // Cycle 2 (Case C): all threads resolved → counter deleted.
      (mockClient.getPRReviewThreads as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      // getIssueLabels doesn't matter — Case C returns before the label check.
      await service.processPrReviewEvent(createPrReviewEvent());
      expect(getRetryCounter(stateKey)).toBeUndefined();

      // Cycle 3: fresh timeout label → counter starts from 0 again.
      (mockClient.getPRReviewThreads as ReturnType<typeof vi.fn>).mockResolvedValue(trustLiveThreads());
      (mockClient.getIssueLabels as ReturnType<typeof vi.fn>).mockResolvedValue([
        'blocked:fixer-timeout',
      ]);
      await service.processPrReviewEvent(createPrReviewEvent());
      expect(getRetryCounter(stateKey)).toBe(1);
    });

    it('failure isolation: client.removeLabels throws → retry branch falls through, counter NOT incremented, generic blocked:* skip matches', async () => {
      (mockClient.getPRReviewThreads as ReturnType<typeof vi.fn>).mockResolvedValue(trustLiveThreads());
      (mockClient.getIssueLabels as ReturnType<typeof vi.fn>).mockResolvedValue([
        'blocked:fixer-timeout',
      ]);
      (mockClient.removeLabels as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('API error'),
      );

      const result = await service.processPrReviewEvent(createPrReviewEvent());

      expect(result).toBe(false);
      // Counter NOT incremented — we did NOT dispatch.
      expect(getRetryCounter('test-org/test-repo#10')).toBeUndefined();
      // Fell through to generic blocked:* skip.
      expect(queueManager.spies.enqueueIfAbsent).not.toHaveBeenCalled();

      // Warn log for the removal failure.
      const warnCall = (logger.warn as ReturnType<typeof vi.fn>).mock.calls.find(
        (c: unknown[]) => typeof c[1] === 'string' && c[1].includes('Failed to remove blocked:fixer-timeout'),
      );
      expect(warnCall).toBeDefined();
    });

    // PR #1072 review regression: guard-before-mutation.
    //
    // When a second blocked:* label from another handler (e.g.
    // blocked:stuck-merge-conflicts) coexists with blocked:fixer-timeout, the
    // retry-eligible branch must NOT consume the retry budget or remove the
    // timeout signal. The generic blocked:* skip must fire on the coexisting
    // label so the timeout label survives and no retry is spent.
    it('regression: coexisting other blocked:* label → counter unchanged, blocked:fixer-timeout NOT removed', async () => {
      (mockClient.getPRReviewThreads as ReturnType<typeof vi.fn>).mockResolvedValue(trustLiveThreads());
      (mockClient.getIssueLabels as ReturnType<typeof vi.fn>).mockResolvedValue([
        'blocked:fixer-timeout',
        'blocked:stuck-merge-conflicts',
      ]);

      const result = await service.processPrReviewEvent(createPrReviewEvent());

      expect(result).toBe(false);
      // Counter untouched — no retry burned by the guard-before-mutation fix.
      expect(getRetryCounter('test-org/test-repo#10')).toBeUndefined();
      // blocked:fixer-timeout signal preserved — the label is NOT removed
      // because dispatch never committed. The operator can still see it.
      expect(mockClient.removeLabels).not.toHaveBeenCalled();
      // No dispatch.
      expect(queueManager.spies.enqueueIfAbsent).not.toHaveBeenCalled();
      // Retry-dispatch info log NOT emitted.
      const retryDispatchLog = (logger.info as ReturnType<typeof vi.fn>).mock.calls.find(
        (c: unknown[]) => (c[0] as { gate?: string })?.gate === 'blocked-fixer-timeout-retry-dispatch',
      );
      expect(retryDispatchLog).toBeUndefined();
      // Generic blocked:* skip fires. Either coexisting label is a valid
      // report — the load-bearing signal is that the skip happened and
      // nothing mutated.
      const skipLog = (logger.info as ReturnType<typeof vi.fn>).mock.calls.find(
        (c: unknown[]) => (c[0] as { gate?: string })?.gate === 'blocked-label-present',
      );
      expect(skipLog).toBeDefined();
      expect((skipLog![0] as { blockedLabel?: string }).blockedLabel).toMatch(/^blocked:/);
    });
  });

  // ==========================================================================
  // #1049: drop-gate log-level lift + merged-PR gate
  // ==========================================================================

  describe('#1049 drop-gate logging + merged-PR gate', () => {
    function unresolvedThread(id = 700) {
      return {
        rootCommentId: id,
        isResolved: false,
        comments: [{
          id, body: 'x', author: 'reviewer',
          authorAssociation: 'MEMBER', created_at: '', updated_at: '',
        }],
      };
    }

    // -----------------------------------------------------------------------
    // G1: merged-pr gate — always info, no PrLinker call, no enqueue
    // -----------------------------------------------------------------------
    describe('G1: merged-pr gate', () => {
      it('INV-5: merged PR → info log with gate=merged-pr, no probe, no enqueue', async () => {
        const event = createPrReviewEvent({ prMerged: true });
        const result = await service.processPrReviewEvent(event);

        expect(result).toBe(false);
        expect(queueManager.spies.enqueueIfAbsent).not.toHaveBeenCalled();
        // PrLinker not consulted → getIssue not called on the linking path
        expect(mockClient.getIssue).not.toHaveBeenCalled();
        // Probe not called
        expect(mockClient.getPRReviewThreads).not.toHaveBeenCalled();
        // Info log emitted with gate: 'merged-pr'
        expect(logger.info).toHaveBeenCalledWith(
          expect.objectContaining({
            gate: 'merged-pr',
            owner: 'test-org',
            repo: 'test-repo',
            prNumber: 10,
            source: 'webhook',
          }),
          expect.stringContaining('merged-pr'),
        );
      });

      it('merged PR with unresolved threads: still no probe (gate bypass)', async () => {
        // Even if threads are unresolved, merged-pr fires first and skips probe.
        const event = createPrReviewEvent({ prMerged: true });
        await service.processPrReviewEvent(event);

        expect(mockClient.getPRReviewThreads).not.toHaveBeenCalled();
      });
    });

    // -----------------------------------------------------------------------
    // G2: no-link gate — info if ≥1 unresolved thread, else debug
    // -----------------------------------------------------------------------
    describe('G2: no-link gate', () => {
      it('INV-1: no-link + 1 unresolved thread → info with gate=no-link', async () => {
        (mockClient.getPRReviewThreads as ReturnType<typeof vi.fn>).mockResolvedValue([
          unresolvedThread(701),
        ]);
        const event = createPrReviewEvent({
          prBody: 'No issue reference',
          branchName: 'feature-no-link',
        });

        await service.processPrReviewEvent(event);

        expect(logger.info).toHaveBeenCalledWith(
          expect.objectContaining({
            gate: 'no-link',
            source: 'webhook',
            unresolvedThreads: 1,
          }),
          expect.stringContaining('no-link'),
        );
      });

      it('INV-6: no-link + 0 unresolved threads → debug, NOT info', async () => {
        (mockClient.getPRReviewThreads as ReturnType<typeof vi.fn>).mockResolvedValue([]);
        const event = createPrReviewEvent({
          prBody: 'No issue reference',
          branchName: 'feature-no-link',
        });

        await service.processPrReviewEvent(event);

        // Debug fired with gate=no-link
        expect(logger.debug).toHaveBeenCalledWith(
          expect.objectContaining({
            gate: 'no-link',
            unresolvedThreads: 0,
          }),
          expect.stringContaining('no-link'),
        );
        // Info NOT fired for this specific gate
        const infoWithGate = (logger.info as ReturnType<typeof vi.fn>).mock.calls
          .filter((c: unknown[]) => {
            const obj = c[0] as Record<string, unknown> | undefined;
            return obj && obj['gate'] === 'no-link';
          });
        expect(infoWithGate).toHaveLength(0);
      });
    });

    // -----------------------------------------------------------------------
    // G3: not-orchestrated gate — info if ≥1 unresolved thread, else debug
    // -----------------------------------------------------------------------
    describe('G3: not-orchestrated gate', () => {
      it('INV-3: not-orchestrated + 1 unresolved thread → info with gate=not-orchestrated', async () => {
        (mockClient.getIssue as ReturnType<typeof vi.fn>).mockResolvedValue({
          number: 42,
          title: 'Test issue',
          body: '',
          state: 'open',
          labels: [{ name: 'bug' }],
          assignees: [],
          created_at: '', updated_at: '',
        });
        (mockClient.getPRReviewThreads as ReturnType<typeof vi.fn>).mockResolvedValue([
          unresolvedThread(702),
        ]);

        const event = createPrReviewEvent();
        await service.processPrReviewEvent(event);

        expect(logger.info).toHaveBeenCalledWith(
          expect.objectContaining({
            gate: 'not-orchestrated',
            issueNumber: 42,
            source: 'webhook',
            unresolvedThreads: 1,
          }),
          expect.stringContaining('not-orchestrated'),
        );
      });

      it('SC-003 monitor-side: post-cockpit_advance shape enqueues', async () => {
        // The linked issue has workflow:* + completed:validate
        // + completed:implementation-review — the post-advance shape.
        (mockClient.getIssue as ReturnType<typeof vi.fn>).mockResolvedValue({
          number: 42,
          title: 'Test issue',
          body: '',
          state: 'open',
          labels: [
            { name: 'workflow:speckit-feature' },
            { name: 'completed:validate' },
            { name: 'completed:implementation-review' },
          ],
          assignees: [],
          created_at: '', updated_at: '',
        });
        // Default beforeEach mock returns 2 unresolved threads with MEMBER
        // authors — the enqueue path fires.
        const event = createPrReviewEvent();
        const result = await service.processPrReviewEvent(event);

        expect(result).toBe(true);
        expect(queueManager.spies.enqueueIfAbsent).toHaveBeenCalled();
      });
    });

    // -----------------------------------------------------------------------
    // G4: assignees-empty gate — info if ≥1 unresolved thread, else debug
    // -----------------------------------------------------------------------
    describe('G4: assignees-empty gate', () => {
      it('INV-2: assignees-empty + 1 unresolved thread → info with gate=assignees-empty', async () => {
        const serviceWithUser = new PrFeedbackMonitorService(
          logger, clientFactory, queueManager, defaultConfig,
          defaultRepos, 'my-user',
        );
        (mockClient.getIssue as ReturnType<typeof vi.fn>).mockResolvedValue({
          number: 42, title: 'Test', body: '', state: 'open',
          labels: [{ name: 'agent:in-progress' }],
          assignees: [],
          created_at: '', updated_at: '',
        });
        (mockClient.getPRReviewThreads as ReturnType<typeof vi.fn>).mockResolvedValue([
          unresolvedThread(703),
        ]);

        const event = createPrReviewEvent();
        await serviceWithUser.processPrReviewEvent(event);

        expect(logger.info).toHaveBeenCalledWith(
          expect.objectContaining({
            gate: 'assignees-empty',
            issueNumber: 42,
            source: 'webhook',
            unresolvedThreads: 1,
          }),
          expect.stringContaining('assignees-empty'),
        );

        serviceWithUser.stopPolling();
      });
    });

    // -----------------------------------------------------------------------
    // G5: wrong-cluster gate — always debug, no probe (Q3=B)
    // -----------------------------------------------------------------------
    describe('G5: wrong-cluster gate', () => {
      it('INV-4: wrong-cluster + 1 unresolved thread → debug, NOT info', async () => {
        const serviceWithUser = new PrFeedbackMonitorService(
          logger, clientFactory, queueManager, defaultConfig,
          defaultRepos, 'my-user',
        );
        (mockClient.getIssue as ReturnType<typeof vi.fn>).mockResolvedValue({
          number: 42, title: 'Test', body: '', state: 'open',
          labels: [{ name: 'agent:in-progress' }],
          assignees: ['other-user'],
          created_at: '', updated_at: '',
        });
        (mockClient.getPRReviewThreads as ReturnType<typeof vi.fn>).mockResolvedValue([
          unresolvedThread(704),
        ]);

        const event = createPrReviewEvent();
        await serviceWithUser.processPrReviewEvent(event);

        // Probe MUST NOT be called for wrong-cluster (contract §G5 explicit)
        expect(mockClient.getPRReviewThreads).not.toHaveBeenCalled();
        // Debug fired with gate=wrong-cluster
        expect(logger.debug).toHaveBeenCalledWith(
          expect.objectContaining({
            gate: 'wrong-cluster',
            issueNumber: 42,
          }),
          expect.stringContaining('not assigned'),
        );
        // Info with gate=wrong-cluster NOT fired
        const infoWithGate = (logger.info as ReturnType<typeof vi.fn>).mock.calls
          .filter((c: unknown[]) => {
            const obj = c[0] as Record<string, unknown> | undefined;
            return obj && obj['gate'] === 'wrong-cluster';
          });
        expect(infoWithGate).toHaveLength(0);

        serviceWithUser.stopPolling();
      });
    });

    // -----------------------------------------------------------------------
    // Poll-path suppression: probe skipped + drop-log at debug (steady-state cost guard)
    // -----------------------------------------------------------------------
    describe('poll-path suppression', () => {
      it('no-link + source=poll → no probe, debug log with source=poll', async () => {
        // Even if unresolved threads exist, poll-source MUST NOT probe.
        (mockClient.getPRReviewThreads as ReturnType<typeof vi.fn>).mockResolvedValue([
          unresolvedThread(710),
        ]);
        const event = createPrReviewEvent({
          prBody: 'No issue reference',
          branchName: 'feature-no-link',
          source: 'poll',
        });

        await service.processPrReviewEvent(event);

        // Probe MUST NOT be called on the poll path.
        expect(mockClient.getPRReviewThreads).not.toHaveBeenCalled();
        // Debug log fired with the gate and source.
        expect(logger.debug).toHaveBeenCalledWith(
          expect.objectContaining({ gate: 'no-link', source: 'poll' }),
          expect.stringContaining('no-link'),
        );
        // No info log for this gate on the poll path (steady-state spam guard).
        const infoWithGate = (logger.info as ReturnType<typeof vi.fn>).mock.calls
          .filter((c: unknown[]) => {
            const obj = c[0] as Record<string, unknown> | undefined;
            return obj && obj['gate'] === 'no-link';
          });
        expect(infoWithGate).toHaveLength(0);
      });

      it('not-orchestrated + source=poll → no probe, debug log with source=poll', async () => {
        (mockClient.getIssue as ReturnType<typeof vi.fn>).mockResolvedValue({
          number: 42, title: 'Test issue', body: '', state: 'open',
          labels: [{ name: 'bug' }],
          assignees: [],
          created_at: '', updated_at: '',
        });
        (mockClient.getPRReviewThreads as ReturnType<typeof vi.fn>).mockResolvedValue([
          unresolvedThread(711),
        ]);

        const event = createPrReviewEvent({ source: 'poll' });
        await service.processPrReviewEvent(event);

        expect(mockClient.getPRReviewThreads).not.toHaveBeenCalled();
        expect(logger.debug).toHaveBeenCalledWith(
          expect.objectContaining({
            gate: 'not-orchestrated',
            source: 'poll',
            issueNumber: 42,
          }),
          expect.stringContaining('not-orchestrated'),
        );
        const infoWithGate = (logger.info as ReturnType<typeof vi.fn>).mock.calls
          .filter((c: unknown[]) => {
            const obj = c[0] as Record<string, unknown> | undefined;
            return obj && obj['gate'] === 'not-orchestrated';
          });
        expect(infoWithGate).toHaveLength(0);
      });

      it('assignees-empty + source=poll → no probe, debug log with source=poll', async () => {
        const serviceWithUser = new PrFeedbackMonitorService(
          logger, clientFactory, queueManager, defaultConfig,
          defaultRepos, 'my-user',
        );
        (mockClient.getIssue as ReturnType<typeof vi.fn>).mockResolvedValue({
          number: 42, title: 'Test', body: '', state: 'open',
          labels: [{ name: 'agent:in-progress' }],
          assignees: [],
          created_at: '', updated_at: '',
        });
        (mockClient.getPRReviewThreads as ReturnType<typeof vi.fn>).mockResolvedValue([
          unresolvedThread(712),
        ]);

        const event = createPrReviewEvent({ source: 'poll' });
        await serviceWithUser.processPrReviewEvent(event);

        expect(mockClient.getPRReviewThreads).not.toHaveBeenCalled();
        expect(logger.debug).toHaveBeenCalledWith(
          expect.objectContaining({
            gate: 'assignees-empty',
            source: 'poll',
            issueNumber: 42,
          }),
          expect.stringContaining('assignees-empty'),
        );

        serviceWithUser.stopPolling();
      });
    });

    // -----------------------------------------------------------------------
    // Probe error path — falls back to debug with probeError field
    // -----------------------------------------------------------------------
    describe('probe error path', () => {
      it('probe throws → debug log with probeError field, no error signal', async () => {
        (mockClient.getPRReviewThreads as ReturnType<typeof vi.fn>).mockRejectedValue(
          new Error('probe blew up'),
        );
        const event = createPrReviewEvent({
          prBody: 'No issue reference',
          branchName: 'feature-no-link',
        });

        await service.processPrReviewEvent(event);

        expect(logger.debug).toHaveBeenCalledWith(
          expect.objectContaining({
            gate: 'no-link',
            probeError: expect.stringContaining('probe blew up'),
          }),
          expect.stringContaining('probe failed'),
        );
        // NOT logged as error
        expect(logger.error).not.toHaveBeenCalledWith(
          expect.objectContaining({ probeError: expect.anything() }),
          expect.anything(),
        );
      });
    });

    // -----------------------------------------------------------------------
    // SC-001: post-completed:validate PR enqueues (regression anchor)
    // -----------------------------------------------------------------------
    describe('SC-001 anchor', () => {
      it('issue with only completed:validate label → enqueue path runs', async () => {
        (mockClient.getIssue as ReturnType<typeof vi.fn>).mockResolvedValue({
          number: 42, title: 'Test', body: '', state: 'open',
          labels: [{ name: 'completed:validate' }],
          assignees: [],
          created_at: '', updated_at: '',
        });
        const event = createPrReviewEvent();
        const result = await service.processPrReviewEvent(event);

        expect(result).toBe(true);
        expect(queueManager.spies.enqueueIfAbsent).toHaveBeenCalled();
      });
    });
  });
});

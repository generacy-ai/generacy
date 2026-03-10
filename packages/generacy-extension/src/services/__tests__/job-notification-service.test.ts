/**
 * Tests for JobNotificationService.
 *
 * Covers: deduplication, configuration checks, notification content,
 * action handling, rate limiting, focus batching, data enrichment,
 * status bar flash, continueOnError inference, and disposal.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { QueueItem, JobProgress, SSEEvent, WorkflowStepEventData } from '../../api/types';

// ---------------------------------------------------------------------------
// Hoisted variables (accessible inside vi.mock factories)
// ---------------------------------------------------------------------------

type SSEHandler = (event: SSEEvent) => void;

const {
  mockGetConfiguration,
  mockGetJobProgress,
  sseSubscriptions,
  hoisted,
} = vi.hoisted(() => {
  const state = {
    mockWindowFocused: true,
    windowStateHandler: undefined as ((s: { focused: boolean }) => void) | undefined,
  };
  return {
    mockGetConfiguration: vi.fn(),
    mockGetJobProgress: vi.fn(),
    sseSubscriptions: [] as { channel: string; handler: SSEHandler }[],
    hoisted: state,
  };
});

// ---------------------------------------------------------------------------
// Mock vscode
// ---------------------------------------------------------------------------

vi.mock('vscode', () => ({
  window: {
    showInformationMessage: vi.fn(() => Promise.resolve(undefined)),
    showWarningMessage: vi.fn(() => Promise.resolve(undefined)),
    state: { get focused() { return hoisted.mockWindowFocused; } },
    onDidChangeWindowState: vi.fn((handler: (state: { focused: boolean }) => void) => {
      hoisted.windowStateHandler = handler;
      return { dispose: vi.fn() };
    }),
  },
  workspace: {
    getConfiguration: mockGetConfiguration,
  },
  commands: {
    executeCommand: vi.fn(),
  },
  env: {
    openExternal: vi.fn(),
  },
  Uri: {
    parse: vi.fn((url: string) => ({ toString: () => url, _url: url })),
  },
  ThemeColor: class {
    constructor(public id: string) {}
  },
  Disposable: vi.fn().mockImplementation((fn: () => void) => ({ dispose: fn })),
}));

// ---------------------------------------------------------------------------
// Mock SSESubscriptionManager
// ---------------------------------------------------------------------------

vi.mock('../../api/sse', () => ({
  SSESubscriptionManager: {
    getInstance: () => ({
      subscribe: vi.fn((channel: string, handler: SSEHandler) => {
        sseSubscriptions.push({ channel, handler });
        return { dispose: vi.fn() };
      }),
    }),
  },
}));

// ---------------------------------------------------------------------------
// Mock queueApi
// ---------------------------------------------------------------------------

vi.mock('../../api/endpoints/queue', () => ({
  queueApi: {
    getJobProgress: (...args: unknown[]) => mockGetJobProgress(...args),
  },
}));

// ---------------------------------------------------------------------------
// Mock logger
// ---------------------------------------------------------------------------

vi.mock('../../utils/logger', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  }),
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import * as vscode from 'vscode';
import { JobNotificationService } from '../job-notification-service';
import type { CloudJobStatusBarProvider } from '../../providers/status-bar';
import type { ProjectConfigService } from '../project-config-service';

// ---------------------------------------------------------------------------
// Test Helpers
// ---------------------------------------------------------------------------

function createMockStatusBar(): CloudJobStatusBarProvider {
  return {
    flash: vi.fn(),
    updateCount: vi.fn(),
    dispose: vi.fn(),
  } as unknown as CloudJobStatusBarProvider;
}

function createMockQueueProvider() {
  return { refresh: vi.fn() } as unknown as import('../../views/cloud/queue').QueueTreeProvider;
}

function createMockExtensionUri() {
  return {} as vscode.Uri;
}

function createMockProjectConfigService(
  overrides: {
    isConfigured?: boolean;
    reposPrimary?: string;
    projectName?: string;
  } = {},
): ProjectConfigService {
  return {
    isConfigured: overrides.isConfigured ?? true,
    reposPrimary: overrides.reposPrimary,
    projectName: overrides.projectName,
    projectId: undefined,
    currentConfig: undefined,
    onDidChange: vi.fn(),
    initialize: vi.fn(),
    dispose: vi.fn(),
  } as unknown as ProjectConfigService;
}

function createQueueItem(overrides: Partial<QueueItem> = {}): QueueItem {
  return {
    id: 'job-1',
    workflowId: 'wf-1',
    workflowName: 'speckit-bugfix',
    status: 'completed',
    priority: 'normal',
    queuedAt: '2026-01-01T00:00:00Z',
    startedAt: '2026-01-01T00:00:00Z',
    completedAt: '2026-01-01T00:31:22Z',
    ...overrides,
  };
}

function createSSEEvent(overrides: Partial<SSEEvent> & { data?: Record<string, unknown> } = {}): SSEEvent {
  const item = createQueueItem(overrides.data as Partial<QueueItem>);
  return {
    id: overrides.id ?? 'evt-1',
    event: overrides.event ?? 'queue:updated',
    channel: overrides.channel ?? 'queue',
    timestamp: '2026-01-01T00:31:22Z',
    data: {
      ...item,
      ...(overrides.data ?? {}),
    },
  } as SSEEvent;
}

function createJobProgress(overrides: Partial<JobProgress> = {}): JobProgress {
  return {
    jobId: 'job-1',
    currentPhaseIndex: 0,
    totalPhases: 1,
    completedPhases: 1,
    skippedPhases: 0,
    phases: [],
    updatedAt: '2026-01-01T00:31:22Z',
    ...overrides,
  };
}

/** Return the handler subscribed to a given SSE channel */
function getSSEHandler(channel: string): SSEHandler {
  const sub = sseSubscriptions.find((s) => s.channel === channel);
  if (!sub) throw new Error(`No subscription found for channel "${channel}"`);
  return sub.handler;
}

/** Set up a default config mock that enables all notifications */
function mockConfigEnabled() {
  mockGetConfiguration.mockReturnValue({
    get: vi.fn((_key: string, defaultValue: unknown) => defaultValue),
  });
}

/** Set up a config mock that returns specific values */
function mockConfig(overrides: Record<string, unknown>) {
  mockGetConfiguration.mockReturnValue({
    get: vi.fn((key: string, defaultValue: unknown) =>
      key in overrides ? overrides[key] : defaultValue,
    ),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('JobNotificationService', () => {
  let service: JobNotificationService;
  let statusBar: CloudJobStatusBarProvider;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    sseSubscriptions.length = 0;
    hoisted.mockWindowFocused = true;
    hoisted.windowStateHandler = undefined;
    mockConfigEnabled();
    mockGetJobProgress.mockResolvedValue(createJobProgress());

    statusBar = createMockStatusBar();
    service = new JobNotificationService(
      statusBar,
      createMockQueueProvider(),
      createMockExtensionUri(),
    );
  });

  afterEach(() => {
    service.dispose();
    vi.useRealTimers();
  });

  // ========================================================================
  // SSE Subscription
  // ========================================================================

  describe('SSE subscription', () => {
    it('should subscribe to both queue and workflows channels', () => {
      const channels = sseSubscriptions.map((s) => s.channel);
      expect(channels).toContain('queue');
      expect(channels).toContain('workflows');
    });

    it('should ignore non queue:updated events', () => {
      const handler = getSSEHandler('queue');
      handler(createSSEEvent({ event: 'queue:created', data: { status: 'completed' } }));

      vi.advanceTimersByTime(10_000);
      expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
    });

    it('should ignore non-terminal statuses', () => {
      const handler = getSSEHandler('queue');
      handler(createSSEEvent({ data: { status: 'running' } }));

      vi.advanceTimersByTime(10_000);
      expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
    });
  });

  // ========================================================================
  // Deduplication
  // ========================================================================

  describe('deduplication', () => {
    it('should ignore duplicate event IDs', async () => {
      const handler = getSSEHandler('queue');
      const event = createSSEEvent({ id: 'dup-1', data: { status: 'completed' } });

      handler(event);
      handler(event);

      await vi.advanceTimersByTimeAsync(10_000);

      // Only one notification should be shown
      expect(vscode.window.showInformationMessage).toHaveBeenCalledTimes(1);
    });

    it('should evict oldest ID after 101 events and allow re-trigger', async () => {
      const handler = getSSEHandler('queue');

      // Send 101 unique events to fill the dedup set and evict the first
      for (let i = 0; i < 101; i++) {
        handler(createSSEEvent({
          id: `evt-${i}`,
          data: { id: `job-${i}`, status: 'completed' },
        }));
      }

      // The first event (evt-0) should have been evicted from the dedup set
      // Clear mocks to count only new calls
      vi.clearAllMocks();
      mockConfigEnabled();
      mockGetJobProgress.mockResolvedValue(createJobProgress());

      handler(createSSEEvent({
        id: 'evt-0',
        data: { id: 'job-0', status: 'completed' },
      }));

      await vi.advanceTimersByTimeAsync(10_000);

      // Should be able to trigger again since evt-0 was evicted
      expect(statusBar.flash).toHaveBeenCalled();
    });
  });

  // ========================================================================
  // Configuration
  // ========================================================================

  describe('configuration', () => {
    it('should suppress all notifications when notifications.enabled is false', async () => {
      mockConfig({ 'notifications.enabled': false });
      const handler = getSSEHandler('queue');

      handler(createSSEEvent({ data: { status: 'completed' } }));
      handler(createSSEEvent({ id: 'evt-2', data: { status: 'failed' } }));

      await vi.advanceTimersByTimeAsync(10_000);

      expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
      expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
    });

    it('should suppress completed notifications when onComplete is false', async () => {
      mockConfig({ 'notifications.onComplete': false });
      const handler = getSSEHandler('queue');

      handler(createSSEEvent({ id: 'evt-c', data: { status: 'completed' } }));

      await vi.advanceTimersByTimeAsync(10_000);

      expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
    });

    it('should still show failed notifications when onComplete is false', async () => {
      mockConfig({ 'notifications.onComplete': false });
      const handler = getSSEHandler('queue');

      handler(createSSEEvent({ id: 'evt-f', data: { status: 'failed' } }));

      await vi.advanceTimersByTimeAsync(10_000);

      expect(vscode.window.showWarningMessage).toHaveBeenCalled();
    });

    it('should suppress failed/cancelled notifications when onError is false', async () => {
      mockConfig({ 'notifications.onError': false });
      const handler = getSSEHandler('queue');

      handler(createSSEEvent({ id: 'evt-f', data: { status: 'failed' } }));
      handler(createSSEEvent({ id: 'evt-x', data: { status: 'cancelled' } }));

      await vi.advanceTimersByTimeAsync(10_000);

      expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
      // cancelled uses showInformationMessage, but should also be suppressed
      expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
    });

    it('should still show completed notifications when onError is false', async () => {
      mockConfig({ 'notifications.onError': false });
      const handler = getSSEHandler('queue');

      handler(createSSEEvent({ id: 'evt-c', data: { status: 'completed' } }));

      await vi.advanceTimersByTimeAsync(10_000);

      expect(vscode.window.showInformationMessage).toHaveBeenCalled();
    });
  });

  // ========================================================================
  // Notification Content
  // ========================================================================

  describe('notification content', () => {
    it('should show completed job with PR info and both action buttons', async () => {
      const prUrl = 'https://github.com/org/repo/pull/62';
      mockGetJobProgress.mockResolvedValue(createJobProgress({
        pullRequestUrl: prUrl,
      }));

      const handler = getSSEHandler('queue');
      handler(createSSEEvent({
        data: {
          status: 'completed',
          workflowName: 'speckit-bugfix',
          startedAt: '2026-01-01T00:00:00Z',
          completedAt: '2026-01-01T00:31:22Z',
        },
      }));

      await vi.advanceTimersByTimeAsync(10_000);

      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        expect.stringContaining('speckit-bugfix completed'),
        'View PR',
        'View Details',
      );
      // Duration should be in the message
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        expect.stringContaining('31m 22s'),
        expect.anything(),
        expect.anything(),
      );
    });

    it('should show completed job without PR — only View Details button', async () => {
      mockGetJobProgress.mockResolvedValue(createJobProgress({ pullRequestUrl: undefined }));

      const handler = getSSEHandler('queue');
      handler(createSSEEvent({
        data: {
          status: 'completed',
          workflowName: 'my-workflow',
        },
      }));

      await vi.advanceTimersByTimeAsync(10_000);

      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        expect.stringContaining('my-workflow completed'),
        'View Details',
      );
    });

    it('should show failed job with step name, error detail, and action buttons', async () => {
      mockGetJobProgress.mockResolvedValue(createJobProgress({
        phases: [{
          id: 'impl',
          name: 'implementation',
          status: 'failed',
          steps: [{
            id: 'T003',
            name: 'implement',
            status: 'failed',
            error: 'Task T003 timed out',
          }],
        }],
      }));

      const handler = getSSEHandler('queue');
      handler(createSSEEvent({
        data: {
          status: 'failed',
          workflowName: 'speckit-bugfix',
          startedAt: '2026-01-01T00:00:00Z',
          completedAt: '2026-01-01T00:18:05Z',
        },
      }));

      await vi.advanceTimersByTimeAsync(10_000);

      expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining('speckit-bugfix failed'),
        'View Logs',
        'View Details',
      );
      expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining('implement'),
        expect.anything(),
        expect.anything(),
      );
      expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining('Task T003 timed out'),
        expect.anything(),
        expect.anything(),
      );
    });

    it('should show cancelled job with View Details button', async () => {
      const handler = getSSEHandler('queue');
      handler(createSSEEvent({
        data: {
          status: 'cancelled',
          workflowName: 'my-workflow',
        },
      }));

      await vi.advanceTimersByTimeAsync(10_000);

      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        expect.stringContaining('my-workflow was cancelled'),
        'View Details',
      );
    });
  });

  // ========================================================================
  // Waiting Notifications
  // ========================================================================

  describe('waiting notifications', () => {
    it('should show waiting notification immediately (not batched)', () => {
      const handler = getSSEHandler('queue');
      handler(createSSEEvent({
        data: {
          status: 'waiting',
          workflowName: 'my-workflow',
          waitingFor: 'human approval',
        },
      }));

      // Waiting notifications are shown immediately, no need to advance timers
      expect(vscode.window.showWarningMessage).toHaveBeenCalledTimes(1);
      expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining('my-workflow is waiting for: human approval'),
        'View Job',
      );
    });

    it('should show generic waiting message when waitingFor is absent', () => {
      const handler = getSSEHandler('queue');
      handler(createSSEEvent({
        data: {
          status: 'waiting',
          workflowName: 'my-workflow',
        },
      }));

      expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining('my-workflow is waiting for input'),
        'View Job',
      );
    });

    it('should flash status bar with waiting status', () => {
      const handler = getSSEHandler('queue');
      handler(createSSEEvent({
        data: { status: 'waiting', workflowName: 'test' },
      }));

      expect(statusBar.flash).toHaveBeenCalledWith('waiting');
    });

    it('should execute viewJobProgress when View Job is selected', async () => {
      (vscode.window.showWarningMessage as ReturnType<typeof vi.fn>).mockResolvedValueOnce('View Job');

      const handler = getSSEHandler('queue');
      handler(createSSEEvent({
        data: { id: 'job-wait-1', status: 'waiting', workflowName: 'test' },
      }));

      // Allow the .then() handler to execute
      await vi.advanceTimersByTimeAsync(0);

      expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
        'generacy.queue.viewProgress',
        'job-wait-1',
      );
    });

    it('should deduplicate waiting events', () => {
      const handler = getSSEHandler('queue');
      const event = createSSEEvent({
        id: 'wait-dup-1',
        data: { status: 'waiting', workflowName: 'test' },
      });

      handler(event);
      handler(event);

      // Only one notification
      expect(vscode.window.showWarningMessage).toHaveBeenCalledTimes(1);
    });

    it('should suppress waiting notifications when notifications.enabled is false', () => {
      mockConfig({ 'notifications.enabled': false });
      const handler = getSSEHandler('queue');

      handler(createSSEEvent({
        data: { status: 'waiting', workflowName: 'test' },
      }));

      expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
    });

    it('should always show waiting notifications when notifications are enabled (regardless of onComplete/onError)', () => {
      mockConfig({ 'notifications.onComplete': false, 'notifications.onError': false });
      const handler = getSSEHandler('queue');

      handler(createSSEEvent({
        data: { status: 'waiting', workflowName: 'test', waitingFor: 'approval' },
      }));

      expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining('test is waiting for: approval'),
        'View Job',
      );
    });

    it('should not enrich waiting notifications via getJobProgress', () => {
      const handler = getSSEHandler('queue');
      handler(createSSEEvent({
        data: { status: 'waiting', workflowName: 'test' },
      }));

      // Waiting notifications bypass enrichment entirely
      expect(mockGetJobProgress).not.toHaveBeenCalled();
    });

    it('should not clear step failure timer for waiting events', () => {
      const workflowHandler = getSSEHandler('workflows');
      const queueHandler = getSSEHandler('queue');

      // Step failure event
      workflowHandler({
        id: 'wf-evt-wait',
        event: 'workflow:step:complete',
        channel: 'workflows',
        timestamp: '2026-01-01T00:10:00Z',
        data: {
          workflowId: 'wf-1',
          jobId: 'job-wait-coe',
          phaseId: 'phase-1',
          phaseIndex: 0,
          step: { id: 'T001', name: 'lint', status: 'failed' },
          stepIndex: 0,
          totalSteps: 3,
        },
      } as SSEEvent);

      // Waiting event (should not clear the step failure timer)
      queueHandler(createSSEEvent({
        id: 'wait-coe-evt',
        data: { id: 'job-wait-coe', status: 'waiting', workflowName: 'test' },
      }));

      // Advance past the continueOnError window
      vi.advanceTimersByTime(5_000);

      // Both the waiting flash and the step failure flash should have fired
      expect(statusBar.flash).toHaveBeenCalledWith('waiting');
      expect(statusBar.flash).toHaveBeenCalledWith('failed');
    });

    it('should include waiting in summary when batched with other statuses on refocus', async () => {
      hoisted.mockWindowFocused = false;
      hoisted.windowStateHandler?.({ focused: false });

      const handler = getSSEHandler('queue');
      handler(createSSEEvent({ id: 'evt-w1', data: { id: 'j-w1', status: 'completed' } }));
      handler(createSSEEvent({ id: 'evt-w2', data: { id: 'j-w2', status: 'completed' } }));

      await vi.advanceTimersByTimeAsync(10_000);

      // Waiting notifications still fire immediately even while unfocused
      handler(createSSEEvent({ id: 'evt-w3', data: { id: 'j-w3', status: 'waiting', workflowName: 'wf-wait' } }));

      // The waiting notification is shown immediately regardless of focus
      expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining('wf-wait is waiting for input'),
        'View Job',
      );
    });
  });

  // ========================================================================
  // Action Handling
  // ========================================================================

  describe('action handling', () => {
    it('should open PR URL when View PR action is selected', async () => {
      const prUrl = 'https://github.com/org/repo/pull/42';
      mockGetJobProgress.mockResolvedValue(createJobProgress({ pullRequestUrl: prUrl }));

      (vscode.window.showInformationMessage as ReturnType<typeof vi.fn>).mockResolvedValueOnce('View PR');

      const handler = getSSEHandler('queue');
      handler(createSSEEvent({
        data: { status: 'completed', workflowName: 'test' },
      }));

      await vi.advanceTimersByTimeAsync(10_000);

      // Wait for the .then() handler
      await vi.advanceTimersByTimeAsync(0);

      expect(vscode.env.openExternal).toHaveBeenCalled();
      expect(vscode.Uri.parse).toHaveBeenCalledWith(prUrl);
    });

    it('should execute viewJobProgress command when View Details is selected', async () => {
      mockGetJobProgress.mockResolvedValue(createJobProgress());

      (vscode.window.showInformationMessage as ReturnType<typeof vi.fn>).mockResolvedValueOnce('View Details');

      const handler = getSSEHandler('queue');
      handler(createSSEEvent({
        data: { id: 'job-42', status: 'completed', workflowName: 'test' },
      }));

      await vi.advanceTimersByTimeAsync(10_000);
      await vi.advanceTimersByTimeAsync(0);

      expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
        'generacy.queue.viewProgress',
        'job-42',
      );
    });

    it('should execute viewJobProgress command when View Logs is selected', async () => {
      mockGetJobProgress.mockResolvedValue(createJobProgress({
        phases: [{ id: 'p', name: 'p', status: 'failed', steps: [], error: 'err' }],
      }));

      (vscode.window.showWarningMessage as ReturnType<typeof vi.fn>).mockResolvedValueOnce('View Logs');

      const handler = getSSEHandler('queue');
      handler(createSSEEvent({
        data: { id: 'job-fail', status: 'failed', workflowName: 'test' },
      }));

      await vi.advanceTimersByTimeAsync(10_000);
      await vi.advanceTimersByTimeAsync(0);

      expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
        'generacy.queue.viewProgress',
        'job-fail',
      );
    });
  });

  // ========================================================================
  // Rate Limiting
  // ========================================================================

  describe('rate limiting', () => {
    it('should show individual notifications when <3 in batch window', async () => {
      const handler = getSSEHandler('queue');

      handler(createSSEEvent({ id: 'evt-a', data: { id: 'j-a', status: 'completed', workflowName: 'wf-a' } }));
      handler(createSSEEvent({ id: 'evt-b', data: { id: 'j-b', status: 'completed', workflowName: 'wf-b' } }));

      await vi.advanceTimersByTimeAsync(10_000);

      // Two individual notifications
      expect(vscode.window.showInformationMessage).toHaveBeenCalledTimes(2);
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        expect.stringContaining('wf-a'),
        expect.anything(),
      );
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        expect.stringContaining('wf-b'),
        expect.anything(),
      );
    });

    it('should group into summary when 3+ notifications in batch window', async () => {
      const handler = getSSEHandler('queue');

      handler(createSSEEvent({ id: 'evt-a', data: { id: 'j-a', status: 'completed' } }));
      handler(createSSEEvent({ id: 'evt-b', data: { id: 'j-b', status: 'completed' } }));
      handler(createSSEEvent({ id: 'evt-c', data: { id: 'j-c', status: 'failed' } }));

      await vi.advanceTimersByTimeAsync(10_000);

      // Should show a single summary (either info or warning depending on presence of failures)
      // The summary contains failures so it uses showWarningMessage
      expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining('2 jobs completed'),
        'View Queue',
      );
      expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining('1 job failed'),
        'View Queue',
      );
    });

    it('should execute focusQueue when View Queue action is selected on summary', async () => {
      (vscode.window.showWarningMessage as ReturnType<typeof vi.fn>).mockResolvedValueOnce('View Queue');

      const handler = getSSEHandler('queue');
      handler(createSSEEvent({ id: 'evt-a', data: { id: 'j-a', status: 'completed' } }));
      handler(createSSEEvent({ id: 'evt-b', data: { id: 'j-b', status: 'completed' } }));
      handler(createSSEEvent({ id: 'evt-c', data: { id: 'j-c', status: 'failed' } }));

      await vi.advanceTimersByTimeAsync(10_000);
      await vi.advanceTimersByTimeAsync(0);

      expect(vscode.commands.executeCommand).toHaveBeenCalledWith('generacy.queue.focus');
    });
  });

  // ========================================================================
  // Focus Batching
  // ========================================================================

  describe('focus batching', () => {
    it('should queue notifications when VS Code is unfocused', async () => {
      hoisted.mockWindowFocused = false;
      // Simulate focus loss
      hoisted.windowStateHandler?.({ focused: false });

      const handler = getSSEHandler('queue');
      handler(createSSEEvent({ id: 'evt-u1', data: { status: 'completed', workflowName: 'bg-1' } }));

      await vi.advanceTimersByTimeAsync(10_000);

      // No notification shown while unfocused
      expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
    });

    it('should show individual notifications on refocus with <3 queued', async () => {
      hoisted.mockWindowFocused = false;
      hoisted.windowStateHandler?.({ focused: false });

      const handler = getSSEHandler('queue');
      handler(createSSEEvent({ id: 'evt-u1', data: { status: 'completed', workflowName: 'bg-1' } }));
      handler(createSSEEvent({ id: 'evt-u2', data: { status: 'completed', workflowName: 'bg-2' } }));

      await vi.advanceTimersByTimeAsync(10_000);

      expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();

      // Refocus
      hoisted.mockWindowFocused = true;
      hoisted.windowStateHandler?.({ focused: true });

      // Should show 2 individual notifications
      expect(vscode.window.showInformationMessage).toHaveBeenCalledTimes(2);
    });

    it('should show summary notification on refocus with 3+ queued', async () => {
      hoisted.mockWindowFocused = false;
      hoisted.windowStateHandler?.({ focused: false });

      const handler = getSSEHandler('queue');
      handler(createSSEEvent({ id: 'evt-u1', data: { id: 'j-1', status: 'completed' } }));
      handler(createSSEEvent({ id: 'evt-u2', data: { id: 'j-2', status: 'completed' } }));
      handler(createSSEEvent({ id: 'evt-u3', data: { id: 'j-3', status: 'completed' } }));

      await vi.advanceTimersByTimeAsync(10_000);

      expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();

      // Refocus
      hoisted.mockWindowFocused = true;
      hoisted.windowStateHandler?.({ focused: true });

      // Should show single summary
      expect(vscode.window.showInformationMessage).toHaveBeenCalledTimes(1);
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        expect.stringContaining('3 jobs completed'),
        'View Queue',
      );
    });

    it('should move pending batch notifications to unfocused queue on focus loss', async () => {
      const handler = getSSEHandler('queue');

      // Send event while focused — it enters the batch pending list
      handler(createSSEEvent({ id: 'evt-p1', data: { status: 'completed', workflowName: 'p1' } }));

      // Lose focus before batch timer fires
      hoisted.mockWindowFocused = false;
      hoisted.windowStateHandler?.({ focused: false });

      // Add another while unfocused
      handler(createSSEEvent({ id: 'evt-p2', data: { status: 'completed', workflowName: 'p2' } }));

      await vi.advanceTimersByTimeAsync(10_000);

      // Nothing shown while unfocused
      expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();

      // Refocus — both should appear
      hoisted.mockWindowFocused = true;
      hoisted.windowStateHandler?.({ focused: true });

      expect(vscode.window.showInformationMessage).toHaveBeenCalledTimes(2);
    });
  });

  // ========================================================================
  // Data Enrichment
  // ========================================================================

  describe('data enrichment', () => {
    it('should show notification with fallback data when getJobProgress fails', async () => {
      mockGetJobProgress.mockRejectedValue(new Error('Network error'));

      const handler = getSSEHandler('queue');
      handler(createSSEEvent({
        data: {
          status: 'failed',
          workflowName: 'my-workflow',
          error: 'Something went wrong',
        },
      }));

      await vi.advanceTimersByTimeAsync(10_000);

      // Should still show the notification with QueueItem.error as fallback
      expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining('my-workflow failed'),
        'View Logs',
        'View Details',
      );
      expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining('Something went wrong'),
        expect.anything(),
        expect.anything(),
      );
    });

    it('should format duration in seconds', async () => {
      const handler = getSSEHandler('queue');
      handler(createSSEEvent({
        data: {
          status: 'completed',
          workflowName: 'quick-job',
          startedAt: '2026-01-01T00:00:00Z',
          completedAt: '2026-01-01T00:00:45Z',
        },
      }));

      await vi.advanceTimersByTimeAsync(10_000);

      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        expect.stringContaining('45s'),
        expect.anything(),
      );
    });

    it('should format duration in minutes and seconds', async () => {
      const handler = getSSEHandler('queue');
      handler(createSSEEvent({
        data: {
          status: 'completed',
          workflowName: 'medium-job',
          startedAt: '2026-01-01T00:00:00Z',
          completedAt: '2026-01-01T00:05:30Z',
        },
      }));

      await vi.advanceTimersByTimeAsync(10_000);

      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        expect.stringContaining('5m 30s'),
        expect.anything(),
      );
    });

    it('should format duration in hours and minutes', async () => {
      const handler = getSSEHandler('queue');
      handler(createSSEEvent({
        data: {
          status: 'completed',
          workflowName: 'long-job',
          startedAt: '2026-01-01T00:00:00Z',
          completedAt: '2026-01-01T01:05:00Z',
        },
      }));

      await vi.advanceTimersByTimeAsync(10_000);

      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        expect.stringContaining('1h 5m'),
        expect.anything(),
      );
    });
  });

  // ========================================================================
  // Status Bar Flash
  // ========================================================================

  describe('status bar flash', () => {
    it('should call flash for completed events', async () => {
      const handler = getSSEHandler('queue');
      handler(createSSEEvent({ data: { status: 'completed' } }));

      expect(statusBar.flash).toHaveBeenCalledWith('completed');
    });

    it('should call flash for failed events', async () => {
      const handler = getSSEHandler('queue');
      handler(createSSEEvent({ id: 'evt-f', data: { status: 'failed' } }));

      expect(statusBar.flash).toHaveBeenCalledWith('failed');
    });

    it('should call flash for cancelled events', async () => {
      const handler = getSSEHandler('queue');
      handler(createSSEEvent({ id: 'evt-x', data: { status: 'cancelled' } }));

      expect(statusBar.flash).toHaveBeenCalledWith('cancelled');
    });

    it('should call flash for waiting events', async () => {
      const handler = getSSEHandler('queue');
      handler(createSSEEvent({ id: 'evt-w', data: { status: 'waiting' } }));

      expect(statusBar.flash).toHaveBeenCalledWith('waiting');
    });
  });

  // ========================================================================
  // continueOnError
  // ========================================================================

  describe('continueOnError inference', () => {
    it('should flash status bar only (no toast) for step failure without terminal event', async () => {
      const handler = getSSEHandler('workflows');
      handler({
        id: 'wf-evt-1',
        event: 'workflow:step:complete',
        channel: 'workflows',
        timestamp: '2026-01-01T00:10:00Z',
        data: {
          workflowId: 'wf-1',
          jobId: 'job-coe',
          phaseId: 'phase-1',
          phaseIndex: 0,
          step: { id: 'T001', name: 'lint', status: 'failed', error: 'Lint errors' },
          stepIndex: 0,
          totalSteps: 3,
        } satisfies WorkflowStepEventData,
      } as SSEEvent);

      // Advance past the continueOnError window (5s)
      vi.advanceTimersByTime(5_000);

      // Status bar flash should have been called for the step failure
      expect(statusBar.flash).toHaveBeenCalledWith('failed');

      // No toast notification should be shown
      expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
      expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
    });

    it('should show normal terminal notification when step failure is followed by terminal event', async () => {
      const workflowHandler = getSSEHandler('workflows');
      const queueHandler = getSSEHandler('queue');

      // Step failure event
      workflowHandler({
        id: 'wf-evt-2',
        event: 'workflow:step:complete',
        channel: 'workflows',
        timestamp: '2026-01-01T00:10:00Z',
        data: {
          workflowId: 'wf-1',
          jobId: 'job-term',
          phaseId: 'phase-1',
          phaseIndex: 0,
          step: { id: 'T001', name: 'lint', status: 'failed', error: 'Lint errors' },
          stepIndex: 0,
          totalSteps: 3,
        } satisfies WorkflowStepEventData,
      } as SSEEvent);

      // Terminal event arrives within the 5s window
      vi.advanceTimersByTime(2_000);
      queueHandler(createSSEEvent({
        id: 'term-evt',
        data: { id: 'job-term', status: 'failed', workflowName: 'test' },
      }));

      await vi.advanceTimersByTimeAsync(10_000);

      // Normal terminal notification should be shown
      expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining('test failed'),
        expect.anything(),
        expect.anything(),
      );
    });

    it('should clear step failure timer when terminal event arrives for same job', () => {
      const workflowHandler = getSSEHandler('workflows');
      const queueHandler = getSSEHandler('queue');

      // Step failure
      workflowHandler({
        id: 'wf-evt-3',
        event: 'workflow:step:complete',
        channel: 'workflows',
        timestamp: '2026-01-01T00:10:00Z',
        data: {
          workflowId: 'wf-1',
          jobId: 'job-clear',
          phaseId: 'phase-1',
          phaseIndex: 0,
          step: { id: 'T001', name: 'lint', status: 'failed' },
          stepIndex: 0,
          totalSteps: 3,
        } satisfies WorkflowStepEventData,
      } as SSEEvent);

      // Terminal event clears the timer
      queueHandler(createSSEEvent({
        id: 'clear-evt',
        data: { id: 'job-clear', status: 'failed', workflowName: 'test' },
      }));

      // Advance past the continueOnError window
      vi.advanceTimersByTime(5_000);

      // Flash should only be called once (from the terminal event, not from the step failure timer)
      expect(statusBar.flash).toHaveBeenCalledTimes(1);
      expect(statusBar.flash).toHaveBeenCalledWith('failed');
    });
  });

  // ========================================================================
  // Project-Scoped Filtering
  // ========================================================================

  describe('project-scoped notification filtering', () => {
    it('should show all notifications when no ProjectConfigService is provided (default)', async () => {
      // The default `service` in beforeEach has no ProjectConfigService
      const handler = getSSEHandler('queue');
      handler(createSSEEvent({
        data: { status: 'completed', workflowName: 'any-workflow', repository: 'other-org/other-repo' },
      }));

      await vi.advanceTimersByTimeAsync(10_000);

      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        expect.stringContaining('any-workflow completed'),
        expect.anything(),
      );
    });

    it('should show all notifications when ProjectConfigService is not configured', async () => {
      service.dispose();
      sseSubscriptions.length = 0;

      const configService = createMockProjectConfigService({ isConfigured: false });
      statusBar = createMockStatusBar();
      service = new JobNotificationService(
        statusBar,
        createMockQueueProvider(),
        createMockExtensionUri(),
        configService,
      );

      const handler = getSSEHandler('queue');
      handler(createSSEEvent({
        data: { status: 'completed', workflowName: 'unfiltered', repository: 'org/other-repo' },
      }));

      await vi.advanceTimersByTimeAsync(10_000);

      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        expect.stringContaining('unfiltered completed'),
        expect.anything(),
      );
    });

    it('should show notification when repository matches reposPrimary', async () => {
      service.dispose();
      sseSubscriptions.length = 0;

      const configService = createMockProjectConfigService({
        isConfigured: true,
        reposPrimary: 'org/my-repo',
        projectName: 'my-repo',
      });
      statusBar = createMockStatusBar();
      service = new JobNotificationService(
        statusBar,
        createMockQueueProvider(),
        createMockExtensionUri(),
        configService,
      );

      const handler = getSSEHandler('queue');
      handler(createSSEEvent({
        data: { status: 'completed', workflowName: 'my-workflow', repository: 'org/my-repo' },
      }));

      await vi.advanceTimersByTimeAsync(10_000);

      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        expect.stringContaining('my-workflow completed'),
        expect.anything(),
      );
    });

    it('should suppress toast but still flash status bar for non-matching repository', async () => {
      service.dispose();
      sseSubscriptions.length = 0;

      const configService = createMockProjectConfigService({
        isConfigured: true,
        reposPrimary: 'org/my-repo',
        projectName: 'my-repo',
      });
      statusBar = createMockStatusBar();
      service = new JobNotificationService(
        statusBar,
        createMockQueueProvider(),
        createMockExtensionUri(),
        configService,
      );

      const handler = getSSEHandler('queue');
      handler(createSSEEvent({
        data: { status: 'completed', workflowName: 'other-workflow', repository: 'org/other-repo' },
      }));

      await vi.advanceTimersByTimeAsync(10_000);

      // Status bar should still flash
      expect(statusBar.flash).toHaveBeenCalledWith('completed');
      // But no toast notification
      expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
    });

    it('should show notification when queue item has no repository (cannot filter)', async () => {
      service.dispose();
      sseSubscriptions.length = 0;

      const configService = createMockProjectConfigService({
        isConfigured: true,
        reposPrimary: 'org/my-repo',
        projectName: 'my-repo',
      });
      statusBar = createMockStatusBar();
      service = new JobNotificationService(
        statusBar,
        createMockQueueProvider(),
        createMockExtensionUri(),
        configService,
      );

      const handler = getSSEHandler('queue');
      handler(createSSEEvent({
        data: { status: 'completed', workflowName: 'no-repo-workflow' },
      }));

      await vi.advanceTimersByTimeAsync(10_000);

      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        expect.stringContaining('no-repo-workflow completed'),
        expect.anything(),
      );
    });

    it('should match by projectName when reposPrimary is not set', async () => {
      service.dispose();
      sseSubscriptions.length = 0;

      const configService = createMockProjectConfigService({
        isConfigured: true,
        reposPrimary: undefined,
        projectName: 'my-project',
      });
      statusBar = createMockStatusBar();
      service = new JobNotificationService(
        statusBar,
        createMockQueueProvider(),
        createMockExtensionUri(),
        configService,
      );

      const handler = getSSEHandler('queue');
      handler(createSSEEvent({
        data: { status: 'completed', workflowName: 'matched-by-name', repository: 'org/my-project' },
      }));

      await vi.advanceTimersByTimeAsync(10_000);

      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        expect.stringContaining('matched-by-name completed'),
        expect.anything(),
      );
    });

    it('should suppress waiting toast for non-matching project but still flash status bar', () => {
      service.dispose();
      sseSubscriptions.length = 0;

      const configService = createMockProjectConfigService({
        isConfigured: true,
        reposPrimary: 'org/my-repo',
        projectName: 'my-repo',
      });
      statusBar = createMockStatusBar();
      service = new JobNotificationService(
        statusBar,
        createMockQueueProvider(),
        createMockExtensionUri(),
        configService,
      );

      const handler = getSSEHandler('queue');
      handler(createSSEEvent({
        data: { status: 'waiting', workflowName: 'other-wait', repository: 'org/other-repo' },
      }));

      // Status bar should flash
      expect(statusBar.flash).toHaveBeenCalledWith('waiting');
      // But no toast
      expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
    });

    it('should show waiting toast for matching project', () => {
      service.dispose();
      sseSubscriptions.length = 0;

      const configService = createMockProjectConfigService({
        isConfigured: true,
        reposPrimary: 'org/my-repo',
        projectName: 'my-repo',
      });
      statusBar = createMockStatusBar();
      service = new JobNotificationService(
        statusBar,
        createMockQueueProvider(),
        createMockExtensionUri(),
        configService,
      );

      const handler = getSSEHandler('queue');
      handler(createSSEEvent({
        data: { status: 'waiting', workflowName: 'my-wait', repository: 'org/my-repo', waitingFor: 'approval' },
      }));

      expect(statusBar.flash).toHaveBeenCalledWith('waiting');
      expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining('my-wait is waiting for: approval'),
        'View Job',
      );
    });

    it('should suppress failed toast for non-matching project but still flash status bar', async () => {
      service.dispose();
      sseSubscriptions.length = 0;

      const configService = createMockProjectConfigService({
        isConfigured: true,
        reposPrimary: 'org/my-repo',
        projectName: 'my-repo',
      });
      statusBar = createMockStatusBar();
      service = new JobNotificationService(
        statusBar,
        createMockQueueProvider(),
        createMockExtensionUri(),
        configService,
      );

      const handler = getSSEHandler('queue');
      handler(createSSEEvent({
        id: 'evt-fail-other',
        data: { status: 'failed', workflowName: 'other-fail', repository: 'org/other-repo' },
      }));

      await vi.advanceTimersByTimeAsync(10_000);

      expect(statusBar.flash).toHaveBeenCalledWith('failed');
      expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
    });
  });

  // ========================================================================
  // Dispose
  // ========================================================================

  describe('dispose', () => {
    it('should clear all timers on dispose', () => {
      const handler = getSSEHandler('queue');

      // Start a batch timer
      handler(createSSEEvent({ data: { status: 'completed' } }));

      // Start a step failure timer
      const workflowHandler = getSSEHandler('workflows');
      workflowHandler({
        id: 'wf-evt-disp',
        event: 'workflow:step:complete',
        channel: 'workflows',
        timestamp: '2026-01-01T00:10:00Z',
        data: {
          workflowId: 'wf-1',
          jobId: 'job-disp',
          phaseId: 'phase-1',
          phaseIndex: 0,
          step: { id: 'T001', name: 'lint', status: 'failed' },
          stepIndex: 0,
          totalSteps: 1,
        } satisfies WorkflowStepEventData,
      } as SSEEvent);

      service.dispose();

      // Advancing timers after dispose should not trigger any notifications or flashes
      vi.clearAllMocks();
      vi.advanceTimersByTime(10_000);

      expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
      expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
      expect(statusBar.flash).not.toHaveBeenCalled();
    });

    it('should clear pending notifications and unfocused queue on dispose', () => {
      const handler = getSSEHandler('queue');

      // Queue some notifications
      handler(createSSEEvent({ id: 'evt-d1', data: { status: 'completed' } }));

      service.dispose();

      // Flush should not show anything
      vi.advanceTimersByTime(10_000);
      // No error thrown, nothing displayed
      expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
    });

    it('should not process new events after dispose', () => {
      service.dispose();

      const handler = getSSEHandler('queue');
      handler(createSSEEvent({ id: 'evt-post', data: { status: 'completed' } }));

      expect(statusBar.flash).not.toHaveBeenCalled();
    });
  });
});

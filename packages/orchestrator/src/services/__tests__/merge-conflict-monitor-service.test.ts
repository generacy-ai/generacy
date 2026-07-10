/**
 * #898 T015 — Unit tests for MergeConflictMonitorService.
 *
 * Covers T1-T6 from monitor-contract.md §"Test coverage":
 *   T1: poll finds one paused issue → enqueue succeeds
 *   T2: paused issue with `blocked:stuck-merge-conflicts` → skip
 *   T3: assignee != cluster user → skip via filterByAssignee
 *   T4: two consecutive polls with same paused issue → first true, second false (in-flight)
 *   T5: paused issue missing `agent:paused` → precondition drop with debug
 *   T6: GhAuthError on listIssuesWithLabel → authHealth.recordResult called, no throw
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GhAuthError } from '@generacy-ai/workflow-engine';
import { MergeConflictMonitorService, type MergeConflictEvent } from '../merge-conflict-monitor-service.js';
import { InMemoryQueueAdapter } from '../in-memory-queue-adapter.js';
import type { PrMonitorConfig, RepositoryConfig } from '../../config/schema.js';
import type { Logger } from '../../worker/types.js';
import type { QueueManager } from '../../types/monitor.js';

function createMockLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as unknown as Logger;
}

function createInMemoryQueueManager(): QueueManager & {
  spies: { enqueueIfAbsent: ReturnType<typeof vi.fn> };
} {
  const noop = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
  const adapter = new InMemoryQueueAdapter(noop);
  const enqueueIfAbsentSpy = vi.spyOn(adapter, 'enqueueIfAbsent');
  return Object.assign(adapter, {
    spies: { enqueueIfAbsent: enqueueIfAbsentSpy as unknown as ReturnType<typeof vi.fn> },
  }) as QueueManager & { spies: { enqueueIfAbsent: ReturnType<typeof vi.fn> } };
}

function createMockGitHubClient(overrides: Record<string, unknown> = {}) {
  return {
    listIssuesWithLabel: vi.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as ReturnType<import('@generacy-ai/workflow-engine').GitHubClientFactory>;
}

const defaultConfig: PrMonitorConfig = {
  enabled: true,
  pollIntervalMs: 60_000,
  adaptivePolling: true,
  maxConcurrentPolls: 3,
};

const defaultRepos: RepositoryConfig[] = [
  { owner: 'test-org', repo: 'test-repo' },
];

/** Standard paused-issue label set. */
const PAUSED_LABELS = ['waiting-for:merge-conflicts', 'agent:paused', 'workflow:speckit-feature'];

function makeEvent(overrides: Partial<MergeConflictEvent> = {}): MergeConflictEvent {
  return {
    owner: 'test-org',
    repo: 'test-repo',
    issueNumber: 42,
    issueLabels: PAUSED_LABELS,
    source: 'poll',
    ...overrides,
  };
}

describe('MergeConflictMonitorService (#898 T015)', () => {
  let logger: Logger;
  let queue: ReturnType<typeof createInMemoryQueueManager>;

  beforeEach(() => {
    logger = createMockLogger();
    queue = createInMemoryQueueManager();
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // T1: enqueue succeeds on paused issue
  // -------------------------------------------------------------------------
  it('T1: paused issue → enqueueIfAbsent returns true, info log emitted', async () => {
    const svc = new MergeConflictMonitorService(
      logger,
      () => createMockGitHubClient(),
      queue,
      defaultConfig,
      defaultRepos,
    );

    const enqueued = await svc.processMergeConflictEvent(makeEvent());

    expect(enqueued).toBe(true);
    expect(queue.spies.enqueueIfAbsent).toHaveBeenCalledTimes(1);
    const args = queue.spies.enqueueIfAbsent.mock.calls[0]![0];
    expect(args.command).toBe('resolve-merge-conflicts');
    expect(args.workflowName).toBe('speckit-feature');
    expect(args.queueReason).toBe('resume');
    expect(args.metadata).toEqual({});
  });

  // -------------------------------------------------------------------------
  // T2: blocked-label skip
  // -------------------------------------------------------------------------
  it('T2: blocked:stuck-merge-conflicts on issue → skip, no enqueue', async () => {
    const svc = new MergeConflictMonitorService(
      logger,
      () => createMockGitHubClient(),
      queue,
      defaultConfig,
      defaultRepos,
    );

    const enqueued = await svc.processMergeConflictEvent(
      makeEvent({
        issueLabels: [...PAUSED_LABELS, 'blocked:stuck-merge-conflicts'],
      }),
    );

    expect(enqueued).toBe(false);
    expect(queue.spies.enqueueIfAbsent).not.toHaveBeenCalled();
    // Verify info log with blocked-label-present reason
    const infoCalls = (logger.info as ReturnType<typeof vi.fn>).mock.calls;
    const skipLog = infoCalls.find(
      (c) => (c[0] as Record<string, unknown>)?.reason === 'blocked-label-present',
    );
    expect(skipLog).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // T3: assignee != cluster user → skip via filterByAssignee (at poll level)
  // -------------------------------------------------------------------------
  it('T3: assignee filter drops issues not assigned to this cluster', async () => {
    const client = createMockGitHubClient({
      listIssuesWithLabel: vi.fn().mockResolvedValue([
        {
          number: 42,
          title: 't',
          body: '',
          state: 'open',
          labels: PAUSED_LABELS.map((n) => ({ name: n, color: '' })),
          assignees: ['other-user'], // NOT the cluster user
          created_at: '',
          updated_at: '',
        },
      ]),
    });

    const svc = new MergeConflictMonitorService(
      logger,
      () => client,
      queue,
      defaultConfig,
      defaultRepos,
      'cluster-user', // clusterGithubUsername
    );

    await svc.poll();

    expect(queue.spies.enqueueIfAbsent).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // T4: two consecutive processMergeConflictEvent calls on same issue
  //     → first enqueues, second drops with reason 'in-flight'
  // -------------------------------------------------------------------------
  it('T4: two consecutive events → first enqueues, second drops in-flight', async () => {
    const svc = new MergeConflictMonitorService(
      logger,
      () => createMockGitHubClient(),
      queue,
      defaultConfig,
      defaultRepos,
    );

    const first = await svc.processMergeConflictEvent(makeEvent());
    const second = await svc.processMergeConflictEvent(makeEvent());

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(queue.spies.enqueueIfAbsent).toHaveBeenCalledTimes(2);
    // Second call: log line names in-flight reason.
    const infoCalls = (logger.info as ReturnType<typeof vi.fn>).mock.calls;
    const inFlightLog = infoCalls.find(
      (c) => (c[0] as Record<string, unknown>)?.reason === 'in-flight',
    );
    expect(inFlightLog).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // T5: precondition drop when agent:paused is missing
  // -------------------------------------------------------------------------
  it('T5: missing agent:paused → precondition drop with debug log', async () => {
    const svc = new MergeConflictMonitorService(
      logger,
      () => createMockGitHubClient(),
      queue,
      defaultConfig,
      defaultRepos,
    );

    const enqueued = await svc.processMergeConflictEvent(
      makeEvent({
        issueLabels: ['waiting-for:merge-conflicts', 'workflow:speckit-feature'],
      }),
    );

    expect(enqueued).toBe(false);
    expect(queue.spies.enqueueIfAbsent).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // T6: GhAuthError on listIssuesWithLabel → authHealth recorded, no throw
  // -------------------------------------------------------------------------
  it('T6: GhAuthError on listIssuesWithLabel → authHealth recordResult, cycle skipped', async () => {
    const authHealth = { recordResult: vi.fn() };
    const client = createMockGitHubClient({
      listIssuesWithLabel: vi.fn().mockRejectedValue(new GhAuthError(401, 'auth failed')),
    });

    const svc = new MergeConflictMonitorService(
      logger,
      () => client,
      queue,
      defaultConfig,
      defaultRepos,
      undefined,
      undefined,
      authHealth,
      'gh-app-cred-id',
    );

    // Should NOT throw — cycle just returns.
    await expect(svc.poll()).resolves.toBeUndefined();

    expect(authHealth.recordResult).toHaveBeenCalledWith(
      'gh-app-cred-id',
      { ok: false, statusCode: 401 },
    );
    expect(queue.spies.enqueueIfAbsent).not.toHaveBeenCalled();
  });
});

/**
 * Unit tests for #1051 FR-005: dispatch-time closed-issue gate.
 *
 * Covers `contracts/closed-issue-dispatch-gate.md § Test surface`:
 *   - `type: 'process'` + `issue.state === 'closed'` → drop + log fires with
 *     `eventType: 'process'` + zero mutations.
 *   - `type: 'resume'` + `issue.state === 'closed'` → drop + log fires with
 *     `eventType: 'resume'` + zero mutations.
 *   - `type: 'process'` + `issue.state === 'open'` → proceed to enqueue.
 *   - `type: 'resume'` + `issue.state === 'open'` → proceed to enqueue.
 *   - `github.getIssue` throws → `fetchedIssue === null`, event proceeds
 *     to enqueue (no drop, no crash) — the fallback branch.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { LabelMonitorService } from '../label-monitor-service.js';
import type { LabelEvent, PhaseTracker, QueueManager } from '../../types/monitor.js';
import type { MonitorConfig, RepositoryConfig } from '../../config/schema.js';
import type { GitHubClientFactory } from '@generacy-ai/workflow-engine';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
}

function createPhaseTracker(): PhaseTracker {
  return {
    isDuplicate: vi.fn().mockResolvedValue(false),
    markProcessed: vi.fn().mockResolvedValue(undefined),
    clear: vi.fn().mockResolvedValue(undefined),
    tryMarkProcessed: vi.fn().mockResolvedValue(true),
    isDuplicateRaw: vi.fn().mockResolvedValue(false),
    markProcessedRaw: vi.fn().mockResolvedValue(undefined),
  };
}

function createQueueManager(): QueueManager {
  return {
    enqueue: vi.fn().mockResolvedValue(true),
    enqueueIfAbsent: vi.fn().mockResolvedValue(true),
    requeueForResume: vi.fn().mockResolvedValue(undefined),
    dequeue: vi.fn().mockResolvedValue(null),
    size: vi.fn().mockResolvedValue(0),
    clear: vi.fn().mockResolvedValue(undefined),
  } as unknown as QueueManager;
}

function makeClientFactory(issue: { state: 'open' | 'closed'; labels?: unknown[] } | Error) {
  const getIssue = vi.fn(async () => {
    if (issue instanceof Error) throw issue;
    return {
      number: 100,
      title: 'issue title',
      body: 'issue body',
      state: issue.state,
      labels: issue.labels ?? [],
      assignees: [],
      created_at: '2026-07-01T00:00:00Z',
      updated_at: '2026-07-01T00:00:00Z',
    };
  });
  const addLabels = vi.fn().mockResolvedValue(undefined);
  const removeLabels = vi.fn().mockResolvedValue(undefined);
  const factory: GitHubClientFactory = vi.fn(() => ({
    getIssue,
    addLabels,
    removeLabels,
  })) as unknown as GitHubClientFactory;
  return { factory, getIssue, addLabels, removeLabels };
}

function makeConfig(): MonitorConfig {
  return {
    pollIntervalMs: 60_000,
    webhookSecret: undefined,
    maxConcurrentPolls: 5,
    adaptivePolling: false,
    clusterGithubUsername: undefined,
  };
}

const repos: RepositoryConfig[] = [{ owner: 'o', repo: 'r' }];

function makeSvc(clientFactory: GitHubClientFactory) {
  const logger = createLogger();
  const phaseTracker = createPhaseTracker();
  const queueManager = createQueueManager();
  const svc = new LabelMonitorService(
    logger,
    clientFactory,
    phaseTracker,
    queueManager,
    makeConfig(),
    repos,
  );
  return { svc, logger, phaseTracker, queueManager };
}

function makeEvent(type: 'process' | 'resume'): LabelEvent {
  return {
    type,
    owner: 'o',
    repo: 'r',
    issueNumber: 100,
    labelName: type === 'process' ? 'process:speckit-feature' : 'waiting-for:spec-review',
    parsedName: type === 'process' ? 'speckit-feature' : 'spec-review',
    source: 'poll',
    issueLabels: type === 'resume'
      ? ['workflow:speckit-feature', 'completed:spec-review']
      : ['process:speckit-feature'],
  };
}

function findInfoCall(logger: ReturnType<typeof createLogger>, field: string, value: unknown) {
  return (logger.info as unknown as { mock: { calls: unknown[][] } }).mock.calls.find(
    (call) => {
      const obj = call[0] as Record<string, unknown> | undefined;
      return obj && obj[field] === value;
    },
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LabelMonitorService.processLabelEvent — #1051 FR-005 closed-issue gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('type: process + issue.state=closed → drop + info log + zero mutations', async () => {
    const { factory, addLabels, removeLabels } = makeClientFactory({ state: 'closed' });
    const { svc, logger, phaseTracker, queueManager } = makeSvc(factory);

    const result = await svc.processLabelEvent(makeEvent('process'));

    expect(result).toBe(false);

    // Log line with dropped: 'issue-closed' and eventType: 'process'
    const dropCall = findInfoCall(logger, 'dropped', 'issue-closed');
    expect(dropCall).toBeDefined();
    const payload = dropCall![0] as Record<string, unknown>;
    expect(payload).toMatchObject({
      dropped: 'issue-closed',
      issueNumber: 100,
      eventType: 'process',
      phase: 'speckit-feature',
      owner: 'o',
      repo: 'r',
    });

    // Zero mutations.
    expect(queueManager.enqueue).not.toHaveBeenCalled();
    expect(queueManager.enqueueIfAbsent).not.toHaveBeenCalled();
    expect(phaseTracker.markProcessed).not.toHaveBeenCalled();
    expect(addLabels).not.toHaveBeenCalled();
    expect(removeLabels).not.toHaveBeenCalled();
  });

  it('type: resume + issue.state=closed → drop + info log + zero mutations', async () => {
    const { factory, addLabels, removeLabels } = makeClientFactory({ state: 'closed' });
    const { svc, logger, phaseTracker, queueManager } = makeSvc(factory);

    const result = await svc.processLabelEvent(makeEvent('resume'));

    expect(result).toBe(false);

    const dropCall = findInfoCall(logger, 'dropped', 'issue-closed');
    expect(dropCall).toBeDefined();
    const payload = dropCall![0] as Record<string, unknown>;
    // PR #1052 review Finding 10: assert `phase` alongside eventType so a
    // regression that drops the field for resume events only (e.g. a refactor
    // that emits `phase: undefined` when the event carries a gate name) cannot
    // stay green. Resume events synthesize `parsedName` from the waiting-for
    // label suffix; here that is `'spec-review'`.
    expect(payload).toMatchObject({
      dropped: 'issue-closed',
      issueNumber: 100,
      eventType: 'resume',
      phase: 'spec-review',
      owner: 'o',
      repo: 'r',
    });

    expect(queueManager.enqueue).not.toHaveBeenCalled();
    expect(queueManager.enqueueIfAbsent).not.toHaveBeenCalled();
    expect(phaseTracker.markProcessed).not.toHaveBeenCalled();
    expect(addLabels).not.toHaveBeenCalled();
    expect(removeLabels).not.toHaveBeenCalled();
  });

  it('type: process + issue.state=open → proceed to enqueue (no drop log)', async () => {
    const { factory } = makeClientFactory({ state: 'open' });
    const { svc, logger, queueManager } = makeSvc(factory);

    const result = await svc.processLabelEvent(makeEvent('process'));

    expect(result).toBe(true);
    expect(findInfoCall(logger, 'dropped', 'issue-closed')).toBeUndefined();
    expect(queueManager.enqueue).toHaveBeenCalledTimes(1);
  });

  it('type: resume + issue.state=open → proceed to enqueue (no drop log)', async () => {
    const { factory } = makeClientFactory({ state: 'open' });
    const { svc, logger, queueManager } = makeSvc(factory);

    const result = await svc.processLabelEvent(makeEvent('resume'));

    expect(result).toBe(true);
    expect(findInfoCall(logger, 'dropped', 'issue-closed')).toBeUndefined();
    expect(queueManager.enqueueIfAbsent).toHaveBeenCalledTimes(1);
  });

  it('github.getIssue throws → fetchedIssue null → event proceeds (fallback branch)', async () => {
    const { factory } = makeClientFactory(new Error('gh transient failure'));
    const { svc, logger, queueManager } = makeSvc(factory);

    const result = await svc.processLabelEvent(makeEvent('process'));

    // Fallback: proceed to enqueue rather than drop on transient failure.
    expect(result).toBe(true);
    expect(findInfoCall(logger, 'dropped', 'issue-closed')).toBeUndefined();
    expect(queueManager.enqueue).toHaveBeenCalledTimes(1);
  });
});

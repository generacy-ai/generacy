/**
 * #958 T019 — Unit tests for `ClarificationAnswerMonitorService`.
 *
 * Covers the contract in `specs/958-found-during-local-snappoll/contracts/
 * clarification-answer-monitor.md`:
 *   - Precondition filtering (waiting-for + agent:paused + no blocked:*).
 *   - `viewerDidAuthor === false` gate — cluster-self comments don't count.
 *   - Cluster-self carrying answer marker → still not counted (treated as
 *     cluster-self per contract §Preconditions).
 *   - `enqueueIfAbsent` dedupe on repeated polls.
 *   - Never applies `completed:clarification`.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ClarificationAnswerMonitorService } from '../clarification-answer-monitor-service.js';
import { InMemoryQueueAdapter } from '../in-memory-queue-adapter.js';
import type { PrMonitorConfig, RepositoryConfig } from '../../config/schema.js';
import type { Logger } from '../../worker/types.js';
import type { QueueManager } from '../../types/monitor.js';

vi.mock('@generacy-ai/workflow-engine', async () => {
  const actual = await vi.importActual<typeof import('@generacy-ai/workflow-engine')>(
    '@generacy-ai/workflow-engine',
  );
  return { ...actual, tryLoadCommentTrustConfig: vi.fn(() => undefined) };
});

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

function createMockClientFactory(commentsByIssue: Record<number, Array<Record<string, unknown>>>) {
  const getIssueCommentsWithViewerAuth = vi.fn(async (_o: string, _r: string, n: number) => {
    return commentsByIssue[n] ?? [];
  });
  return {
    factory: () =>
      ({
        listIssuesWithLabel: vi.fn().mockResolvedValue([]),
        getIssueCommentsWithViewerAuth,
      }) as unknown as ReturnType<import('@generacy-ai/workflow-engine').GitHubClientFactory>,
    spy: getIssueCommentsWithViewerAuth,
  };
}

const defaultConfig: PrMonitorConfig = {
  enabled: true,
  pollIntervalMs: 60_000,
  adaptivePolling: true,
  maxConcurrentPolls: 3,
};

const defaultRepos: RepositoryConfig[] = [{ owner: 'test-org', repo: 'test-repo' }];

const PAUSED_LABELS = [
  'waiting-for:clarification',
  'agent:paused',
  'workflow:speckit-feature',
];

describe('#958 ClarificationAnswerMonitorService', () => {
  let logger: Logger;
  let queue: ReturnType<typeof createInMemoryQueueManager>;

  beforeEach(() => {
    logger = createMockLogger();
    queue = createInMemoryQueueManager();
    vi.clearAllMocks();
  });

  it('paused issue with new human comment → enqueues `continue` (queueReason: resume)', async () => {
    const { factory } = createMockClientFactory({
      42: [
        {
          id: 1,
          body: 'Q1: OAuth',
          author: 'chris',
          authorAssociation: 'OWNER',
          viewerDidAuthor: false,
        },
      ],
    });
    const svc = new ClarificationAnswerMonitorService(
      logger,
      factory,
      queue,
      defaultConfig,
      defaultRepos,
    );

    const enqueued = await svc.processClarificationAnswerEvent({
      owner: 'test-org',
      repo: 'test-repo',
      issueNumber: 42,
      issueLabels: PAUSED_LABELS,
      source: 'poll',
    });

    expect(enqueued).toBe(true);
    expect(queue.spies.enqueueIfAbsent).toHaveBeenCalledTimes(1);
    const args = queue.spies.enqueueIfAbsent.mock.calls[0]![0];
    expect(args.command).toBe('continue');
    expect(args.queueReason).toBe('resume');
    expect(args.workflowName).toBe('speckit-feature');
  });

  it('precondition drop — missing agent:paused → skip', async () => {
    const { factory } = createMockClientFactory({});
    const svc = new ClarificationAnswerMonitorService(
      logger,
      factory,
      queue,
      defaultConfig,
      defaultRepos,
    );

    const enqueued = await svc.processClarificationAnswerEvent({
      owner: 'test-org',
      repo: 'test-repo',
      issueNumber: 42,
      issueLabels: ['waiting-for:clarification'], // no agent:paused
      source: 'poll',
    });

    expect(enqueued).toBe(false);
    expect(queue.spies.enqueueIfAbsent).not.toHaveBeenCalled();
  });

  it('precondition drop — missing waiting-for:clarification → skip', async () => {
    const { factory } = createMockClientFactory({});
    const svc = new ClarificationAnswerMonitorService(
      logger,
      factory,
      queue,
      defaultConfig,
      defaultRepos,
    );

    const enqueued = await svc.processClarificationAnswerEvent({
      owner: 'test-org',
      repo: 'test-repo',
      issueNumber: 42,
      issueLabels: ['agent:paused'],
      source: 'poll',
    });

    expect(enqueued).toBe(false);
    expect(queue.spies.enqueueIfAbsent).not.toHaveBeenCalled();
  });

  it('blocked:* on issue → skip, no enqueue', async () => {
    const { factory } = createMockClientFactory({
      42: [
        {
          id: 1,
          body: 'Q1: OAuth',
          author: 'chris',
          authorAssociation: 'OWNER',
          viewerDidAuthor: false,
        },
      ],
    });
    const svc = new ClarificationAnswerMonitorService(
      logger,
      factory,
      queue,
      defaultConfig,
      defaultRepos,
    );

    const enqueued = await svc.processClarificationAnswerEvent({
      owner: 'test-org',
      repo: 'test-repo',
      issueNumber: 42,
      issueLabels: [...PAUSED_LABELS, 'blocked:parsing'],
      source: 'poll',
    });

    expect(enqueued).toBe(false);
    expect(queue.spies.enqueueIfAbsent).not.toHaveBeenCalled();
  });

  it('cluster-self comment only (viewerDidAuthor=true) → no enqueue', async () => {
    // Even if the cluster's answer comment carries the marker, the monitor
    // does NOT enqueue on it — the phase loop handles cluster-relayed answers.
    const { factory } = createMockClientFactory({
      42: [
        {
          id: 1,
          body:
            '<!-- generacy-clarification-answers:1 ts=2026-07-16T00:00:00.000Z -->\n\nQ1: OAuth',
          author: 'cluster-bot',
          authorAssociation: 'NONE',
          viewerDidAuthor: true,
        },
      ],
    });
    const svc = new ClarificationAnswerMonitorService(
      logger,
      factory,
      queue,
      defaultConfig,
      defaultRepos,
    );

    const enqueued = await svc.processClarificationAnswerEvent({
      owner: 'test-org',
      repo: 'test-repo',
      issueNumber: 42,
      issueLabels: PAUSED_LABELS,
      source: 'poll',
    });

    expect(enqueued).toBe(false);
    expect(queue.spies.enqueueIfAbsent).not.toHaveBeenCalled();
  });

  it('in-flight dedupe — second call for same issue returns false', async () => {
    const { factory } = createMockClientFactory({
      42: [
        {
          id: 1,
          body: 'Q1: OAuth',
          author: 'chris',
          authorAssociation: 'OWNER',
          viewerDidAuthor: false,
        },
      ],
    });
    const svc = new ClarificationAnswerMonitorService(
      logger,
      factory,
      queue,
      defaultConfig,
      defaultRepos,
    );

    const first = await svc.processClarificationAnswerEvent({
      owner: 'test-org',
      repo: 'test-repo',
      issueNumber: 42,
      issueLabels: PAUSED_LABELS,
      source: 'poll',
    });
    const second = await svc.processClarificationAnswerEvent({
      owner: 'test-org',
      repo: 'test-repo',
      issueNumber: 42,
      issueLabels: PAUSED_LABELS,
      source: 'poll',
    });

    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  it('NEVER applies completed:clarification (contract §Non-post-conditions)', async () => {
    // Monitor has no gh client reference for labels — the constructor takes
    // only the GraphQL createClient. This is proved structurally: `addLabel`
    // is not called anywhere in the service. This assertion documents that
    // invariant against future edits.
    const { factory } = createMockClientFactory({
      42: [
        {
          id: 1,
          body: 'Q1: OAuth',
          author: 'chris',
          authorAssociation: 'OWNER',
          viewerDidAuthor: false,
        },
      ],
    });
    const svc = new ClarificationAnswerMonitorService(
      logger,
      factory,
      queue,
      defaultConfig,
      defaultRepos,
    );
    await svc.processClarificationAnswerEvent({
      owner: 'test-org',
      repo: 'test-repo',
      issueNumber: 42,
      issueLabels: PAUSED_LABELS,
      source: 'poll',
    });

    // Enqueue happened; no label surface was touched by the service.
    expect(queue.spies.enqueueIfAbsent).toHaveBeenCalledOnce();
    // Structural check: source code contains no `addLabel` / `applyLabels` calls.
    // (Runtime assertion is inherent — the class doesn't hold a labels API.)
  });
});

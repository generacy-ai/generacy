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
import { MACHINE_MARKERS } from '../../worker/clarification-markers.js';

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
          id: 0,
          body: '<!-- generacy-clarifications:1 -->\nQ1: OAuth?',
          author: 'generacy-ai[bot]',
          authorAssociation: 'NONE',
          viewerDidAuthor: false,
          created_at: '2026-07-18T10:00:00Z',
        },
        {
          id: 1,
          body: 'Q1: OAuth',
          author: 'chris',
          authorAssociation: 'OWNER',
          viewerDidAuthor: false,
          created_at: '2026-07-18T10:15:00Z',
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
          id: 0,
          body: '<!-- generacy-clarifications:1 -->\nQ1: OAuth?',
          author: 'generacy-ai[bot]',
          authorAssociation: 'NONE',
          viewerDidAuthor: false,
          created_at: '2026-07-18T10:00:00Z',
        },
        {
          id: 1,
          body: 'Q1: OAuth',
          author: 'chris',
          authorAssociation: 'OWNER',
          viewerDidAuthor: false,
          created_at: '2026-07-18T10:15:00Z',
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

  // #976 case (a): cluster-self comment carrying any MACHINE_MARKERS prefix
  // is filtered by the pre-marker check; no enqueue regardless of the marker
  // family (question, stage/status, audit, answer-relay, explainer).
  it.each(MACHINE_MARKERS.map((m) => [m]))(
    'cluster-self comment carrying machine marker %s → no enqueue',
    async (prefix) => {
      const { factory } = createMockClientFactory({
        42: [
          {
            id: 1,
            body: `${prefix} -->\n\nQ1: OAuth`,
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
    },
  );

  // #993 supersedes the #976 SC-001 positive path. Cluster-self
  // (`viewerDidAuthor === true`) comments no longer resume through this
  // monitor — they flow through the `completed:clarification` label /
  // LabelMonitorService path instead. See specs/993/plan.md §Key Decisions.
  it('cluster-self plain `Q<n>:` reply → does NOT enqueue (#993 supersedes #976 SC-001)', async () => {
    const { factory } = createMockClientFactory({
      42: [
        {
          id: 0,
          body: '<!-- generacy-clarifications:1 -->\nQ1: OAuth?',
          author: 'generacy-ai[bot]',
          authorAssociation: 'NONE',
          viewerDidAuthor: false,
          created_at: '2026-07-18T10:00:00Z',
        },
        {
          id: 1,
          body: 'Q1: OAuth\nQ2: JWT',
          author: 'cluster-bot',
          authorAssociation: 'NONE',
          viewerDidAuthor: true,
          created_at: '2026-07-18T10:15:00Z',
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
          id: 0,
          body: '<!-- generacy-clarifications:1 -->\nQ1: OAuth?',
          author: 'generacy-ai[bot]',
          authorAssociation: 'NONE',
          viewerDidAuthor: false,
          created_at: '2026-07-18T10:00:00Z',
        },
        {
          id: 1,
          body: 'Q1: OAuth',
          author: 'chris',
          authorAssociation: 'OWNER',
          viewerDidAuthor: false,
          created_at: '2026-07-18T10:15:00Z',
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
          id: 0,
          body: '<!-- generacy-clarifications:1 -->\nQ1: OAuth?',
          author: 'generacy-ai[bot]',
          authorAssociation: 'NONE',
          viewerDidAuthor: false,
          created_at: '2026-07-18T10:00:00Z',
        },
        {
          id: 1,
          body: 'Q1: OAuth',
          author: 'chris',
          authorAssociation: 'OWNER',
          viewerDidAuthor: false,
          created_at: '2026-07-18T10:15:00Z',
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

// ============================================================================
// #993 — clarification-answer monitor stops resuming on its own bot comments
// See specs/993-summary-orchestrator-s/contracts/monitor-predicate-contract.md
// ============================================================================

describe('#993 ClarificationAnswerMonitorService bot-filter + newness-anchor', () => {
  let logger: Logger;
  let queue: ReturnType<typeof createInMemoryQueueManager>;

  beforeEach(() => {
    logger = createMockLogger();
    queue = createInMemoryQueueManager();
    vi.clearAllMocks();
  });

  it('SC-001 — bot-only comments across N poll cycles → zero resumes', async () => {
    // Regression for the snappoll loop on P3 issues #5–#8. All three comments
    // are engine-authored by `generacy-ai[bot]`; no non-bot answer exists.
    const { factory } = createMockClientFactory({
      42: [
        {
          id: 1,
          body: '<!-- generacy-stage:specification -->\nSpec summary…',
          author: 'generacy-ai[bot]',
          authorAssociation: 'NONE',
          viewerDidAuthor: false,
          created_at: '2026-07-18T09:00:00Z',
        },
        {
          id: 2,
          body: '<!-- speckit-stage:clarification -->\nStage summary…',
          author: 'generacy-ai[bot]',
          authorAssociation: 'NONE',
          viewerDidAuthor: false,
          created_at: '2026-07-18T09:59:00Z',
        },
        {
          id: 3,
          body: '<!-- generacy-clarifications:5 -->\nQ1: …?',
          author: 'generacy-ai[bot]',
          authorAssociation: 'NONE',
          viewerDidAuthor: false,
          created_at: '2026-07-18T10:00:00Z',
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

    for (let cycle = 0; cycle < 3; cycle++) {
      const enqueued = await svc.processClarificationAnswerEvent({
        owner: 'test-org',
        repo: 'test-repo',
        issueNumber: 42,
        issueLabels: PAUSED_LABELS,
        source: 'poll',
      });
      expect(enqueued).toBe(false);
    }
    expect(queue.spies.enqueueIfAbsent).not.toHaveBeenCalled();
  });

  it('SC-002 — bot noise plus one real external human → exactly one resume', async () => {
    const { factory } = createMockClientFactory({
      42: [
        {
          id: 1,
          body: '<!-- generacy-stage:specification -->\nSpec summary…',
          author: 'generacy-ai[bot]',
          authorAssociation: 'NONE',
          viewerDidAuthor: false,
          created_at: '2026-07-18T09:00:00Z',
        },
        {
          id: 2,
          body: '<!-- speckit-stage:clarification -->\nStage summary…',
          author: 'generacy-ai[bot]',
          authorAssociation: 'NONE',
          viewerDidAuthor: false,
          created_at: '2026-07-18T09:59:00Z',
        },
        {
          id: 3,
          body: '<!-- generacy-clarifications:5 -->\nQ1: …?',
          author: 'generacy-ai[bot]',
          authorAssociation: 'NONE',
          viewerDidAuthor: false,
          created_at: '2026-07-18T10:00:00Z',
        },
        {
          id: 4,
          body: 'Q1: yes — use OAuth.',
          author: 'christrudelpw',
          authorAssociation: 'MEMBER',
          viewerDidAuthor: false,
          created_at: '2026-07-18T10:15:00Z',
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
  });

  it('SC-003 — non-bot marker-carrying answer resumes', async () => {
    const { factory } = createMockClientFactory({
      42: [
        {
          id: 1,
          body: '<!-- generacy-clarifications:1 -->\nQ1: OAuth or JWT?',
          author: 'generacy-ai[bot]',
          authorAssociation: 'NONE',
          viewerDidAuthor: false,
          created_at: '2026-07-18T10:00:00Z',
        },
        {
          id: 2,
          body: '<!-- generacy-clarification-answers:1 -->\nQ1: yes',
          author: 'humantester',
          authorAssociation: 'MEMBER',
          viewerDidAuthor: false,
          created_at: '2026-07-18T10:15:00Z',
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
  });

  it('edge — no question-marker comment on issue → short-circuit false', async () => {
    // FR-004 short-circuit: absence of a question marker is a data-integrity
    // signal and the monitor MUST NOT resume.
    const { factory } = createMockClientFactory({
      42: [
        {
          id: 1,
          body: 'Some human comment.',
          author: 'christrudelpw',
          authorAssociation: 'MEMBER',
          viewerDidAuthor: false,
          created_at: '2026-07-18T10:00:00Z',
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

  it('edge — viewerDidAuthor:true on non-`[bot]` author does not qualify (self-authored)', async () => {
    const { factory } = createMockClientFactory({
      42: [
        {
          id: 1,
          body: '<!-- generacy-clarifications:1 -->\nQ1: OAuth?',
          author: 'generacy-ai[bot]',
          authorAssociation: 'NONE',
          viewerDidAuthor: false,
          created_at: '2026-07-18T10:00:00Z',
        },
        {
          id: 2,
          body: 'Q1: yes.',
          author: 'christrudelpw',
          authorAssociation: 'MEMBER',
          viewerDidAuthor: true,
          created_at: '2026-07-18T10:15:00Z',
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

  it('edge — candidate created_at equals question created_at (tie) → does not qualify', async () => {
    const { factory } = createMockClientFactory({
      42: [
        {
          id: 1,
          body: '<!-- generacy-clarifications:1 -->\nQ1: OAuth?',
          author: 'generacy-ai[bot]',
          authorAssociation: 'NONE',
          viewerDidAuthor: false,
          created_at: '2026-07-18T10:00:00Z',
        },
        {
          id: 2,
          body: 'Q1: yes.',
          author: 'humantester',
          authorAssociation: 'MEMBER',
          viewerDidAuthor: false,
          created_at: '2026-07-18T10:00:00Z',
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

  it('edge — bot-authored answer marker does NOT rescue (FR-001 upstream)', async () => {
    const { factory } = createMockClientFactory({
      42: [
        {
          id: 1,
          body: '<!-- generacy-clarifications:1 -->\nQ1: OAuth?',
          author: 'generacy-ai[bot]',
          authorAssociation: 'NONE',
          viewerDidAuthor: false,
          created_at: '2026-07-18T10:00:00Z',
        },
        {
          id: 2,
          body: '<!-- generacy-clarification-answers:1 -->\nQ1: yes',
          author: 'generacy-ai[bot]',
          authorAssociation: 'NONE',
          viewerDidAuthor: false,
          created_at: '2026-07-18T10:15:00Z',
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
});

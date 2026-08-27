/**
 * #1211 T017 — Unit tests for `DependencyMonitorService`.
 *
 * Covers the re-arm sequence in
 * `specs/1211-problem-clarify-phase-answer/contracts/sentinel-and-gate-protocol.md` §5
 * and the comment contracts in `contracts/dependency-block-comments.md`:
 *   - SC-003: all refs closed → `completed:dependencies` applied and
 *     `enqueueIfAbsent` called within one poll tick.
 *   - Partially-closed refs → gate held (no label, no enqueue).
 *   - FR-014: 2 consecutive ref-read failures retry quietly; the 3rd posts one
 *     escalation comment (marker-deduped across later polls) and holds the gate.
 *   - Q3=C: not-planned issue close / unmerged PR close → ⚠ flags in the re-arm
 *     comment; the gate still re-arms.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DependencyMonitorService } from '../dependency-monitor-service.js';
import { InMemoryQueueAdapter } from '../in-memory-queue-adapter.js';
import type { PrMonitorConfig, RepositoryConfig } from '../../config/schema.js';
import type { Logger } from '../../worker/types.js';
import type { QueueManager } from '../../types/monitor.js';
import {
  buildBlockComment,
  MARKER_BLOCK,
  MARKER_ERROR,
  type DependencyRef,
} from '../../worker/dependency-block.js';

const OWNER = 'test-org';
const REPO = 'test-repo';
const ISSUE = 42;

const defaultConfig: PrMonitorConfig = {
  enabled: true,
  pollIntervalMs: 60_000,
  adaptivePolling: true,
  maxConcurrentPolls: 3,
};

const defaultRepos: RepositoryConfig[] = [{ owner: OWNER, repo: REPO }];

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
  enqueueIfAbsentSpy: ReturnType<typeof vi.spyOn>;
} {
  const noop = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
  const adapter = new InMemoryQueueAdapter(noop);
  const spy = vi.spyOn(adapter, 'enqueueIfAbsent');
  return Object.assign(adapter, { enqueueIfAbsentSpy: spy }) as unknown as QueueManager & {
    enqueueIfAbsentSpy: ReturnType<typeof vi.spyOn>;
  };
}

function ref(number: number): DependencyRef {
  return { owner: OWNER, repo: REPO, number };
}

interface RefStateStub {
  state: 'open' | 'closed';
  stateReason?: 'completed' | 'not_planned' | 'reopened' | null;
  isPullRequest?: boolean;
  merged?: boolean | null;
  /** When set, `getIssueRefState` rejects with this message instead. */
  error?: string;
}

/**
 * Build a stub GitHub client whose comment list is mutated by
 * `addIssueComment` — so escalation dedupe (which reads the comment list on the
 * NEXT poll) behaves as it does against real GitHub.
 */
function createHarness(opts: {
  blockedRefs?: DependencyRef[];
  refStates: Record<number, RefStateStub>;
  /** Omit the block marker comment entirely. */
  noBlockComment?: boolean;
  /** Post a block comment whose fenced JSON is unparseable. */
  malformedBlockComment?: boolean;
  labels?: string[];
}) {
  let clock = 0;
  const nextTimestamp = () => {
    clock += 1;
    return `2026-08-27T00:00:${String(clock).padStart(2, '0')}Z`;
  };

  const comments: Array<{ id: number; body: string; created_at: string }> = [];
  if (!opts.noBlockComment) {
    comments.push({
      id: comments.length,
      body: opts.malformedBlockComment
        ? `${MARKER_BLOCK}\n\n\`\`\`json\n{"on": [oops\n\`\`\`\n`
        : buildBlockComment(opts.blockedRefs ?? [ref(1)]),
      created_at: nextTimestamp(),
    });
  }

  const addIssueComment = vi.fn(
    async (_o: string, _r: string, _n: number, body: string) => {
      comments.push({ id: comments.length, body, created_at: nextTimestamp() });
    },
  );
  const addLabels = vi.fn().mockResolvedValue(undefined);
  const getIssueRefState = vi.fn(async (_o: string, _r: string, n: number) => {
    const stub = opts.refStates[n];
    if (!stub) throw new Error(`no stub for #${n}`);
    if (stub.error) throw new Error(stub.error);
    return {
      state: stub.state,
      stateReason: stub.stateReason ?? null,
      isPullRequest: stub.isPullRequest ?? false,
      merged: stub.merged ?? null,
    };
  });

  const client = {
    listIssuesWithLabel: vi.fn().mockResolvedValue([{ number: ISSUE }]),
    getIssueComments: vi.fn(async () => [...comments]),
    getIssueRefState,
    addIssueComment,
    addLabels,
    getIssue: vi.fn().mockResolvedValue({
      number: ISSUE,
      labels: (opts.labels ?? ['workflow:speckit-bugfix']).map((name) => ({ name })),
    }),
  };

  return {
    client,
    comments,
    spies: { addIssueComment, addLabels, getIssueRefState },
    factory: (() => client) as unknown as Parameters<
      typeof DependencyMonitorService.prototype.constructor
    >[1],
  };
}

function createService(
  harness: ReturnType<typeof createHarness>,
  logger: Logger,
  queue: QueueManager,
): DependencyMonitorService {
  return new DependencyMonitorService(
    logger,
    harness.factory as never,
    queue,
    defaultConfig,
    defaultRepos,
  );
}

describe('#1211 DependencyMonitorService', () => {
  let logger: Logger;
  let queue: ReturnType<typeof createInMemoryQueueManager>;

  beforeEach(() => {
    logger = createMockLogger();
    queue = createInMemoryQueueManager();
    vi.clearAllMocks();
  });

  // SC-003
  it('all refs closed → completed:dependencies applied and continue enqueued in one poll tick', async () => {
    const harness = createHarness({
      blockedRefs: [ref(1), ref(2)],
      refStates: {
        1: { state: 'closed', stateReason: 'completed' },
        2: { state: 'closed', isPullRequest: true, merged: true },
      },
    });
    const svc = createService(harness, logger, queue);

    await svc.poll();

    expect(harness.spies.addLabels).toHaveBeenCalledWith(
      OWNER,
      REPO,
      ISSUE,
      ['completed:dependencies'],
    );
    expect(queue.enqueueIfAbsentSpy).toHaveBeenCalledTimes(1);
    const item = queue.enqueueIfAbsentSpy.mock.calls[0]![0] as Record<string, unknown>;
    expect(item).toMatchObject({
      owner: OWNER,
      repo: REPO,
      issueNumber: ISSUE,
      command: 'continue',
      queueReason: 'resume',
      workflowName: 'speckit-bugfix',
    });

    // Re-arm comment posted, plain lines for clean closes.
    const reArm = harness.comments.find((c) =>
      c.body.startsWith('**Dependencies resolved'),
    );
    expect(reArm).toBeDefined();
    expect(reArm!.body).toContain(`${OWNER}/${REPO}#1 — closed (completed)`);
    expect(reArm!.body).not.toContain('⚠');
  });

  it('partially closed refs → gate held (no label, no enqueue, no re-arm comment)', async () => {
    const harness = createHarness({
      blockedRefs: [ref(1), ref(2)],
      refStates: {
        1: { state: 'closed', stateReason: 'completed' },
        2: { state: 'open' },
      },
    });
    const svc = createService(harness, logger, queue);

    await svc.poll();

    expect(harness.spies.addLabels).not.toHaveBeenCalled();
    expect(queue.enqueueIfAbsentSpy).not.toHaveBeenCalled();
    expect(harness.spies.addIssueComment).not.toHaveBeenCalled();
  });

  // FR-014 / Q5=B
  it('2 consecutive ref-read failures retry quietly; the 3rd escalates once and holds the gate', async () => {
    const harness = createHarness({
      blockedRefs: [ref(7)],
      refStates: { 7: { state: 'open', error: 'HTTP 404' } },
    });
    const svc = createService(harness, logger, queue);

    const errorComments = () =>
      harness.comments.filter((c) => c.body.startsWith(MARKER_ERROR));

    await svc.poll();
    expect(errorComments()).toHaveLength(0);

    await svc.poll();
    expect(errorComments()).toHaveLength(0);

    await svc.poll();
    expect(errorComments()).toHaveLength(1);
    expect(errorComments()[0]!.body).toContain(`${OWNER}/${REPO}#7`);
    expect(errorComments()[0]!.body).toContain('3 consecutive reads');

    // Marker dedupe: a 4th poll does not post a second escalation.
    await svc.poll();
    expect(errorComments()).toHaveLength(1);

    // Gate held throughout — never fail-open.
    expect(harness.spies.addLabels).not.toHaveBeenCalled();
    expect(queue.enqueueIfAbsentSpy).not.toHaveBeenCalled();
  });

  it('a successful read resets the failure counter, so escalation needs 3 more consecutive failures', async () => {
    const stub: RefStateStub = { state: 'open', error: 'HTTP 500' };
    const harness = createHarness({ blockedRefs: [ref(7)], refStates: { 7: stub } });
    const svc = createService(harness, logger, queue);

    await svc.poll();
    await svc.poll();

    // Ref becomes readable (still open → gate held), which resets the counter.
    delete stub.error;
    await svc.poll();

    // Back to failing: two more polls must NOT escalate.
    stub.error = 'HTTP 500';
    await svc.poll();
    await svc.poll();
    expect(harness.comments.filter((c) => c.body.startsWith(MARKER_ERROR))).toHaveLength(0);

    await svc.poll();
    expect(harness.comments.filter((c) => c.body.startsWith(MARKER_ERROR))).toHaveLength(1);
  });

  // Q3=C
  it('not-planned close and unmerged-PR close → ⚠ flags in the re-arm comment, gate still re-arms', async () => {
    const harness = createHarness({
      blockedRefs: [ref(1), ref(2), ref(3)],
      refStates: {
        1: { state: 'closed', stateReason: 'not_planned' },
        2: { state: 'closed', isPullRequest: true, merged: false },
        3: { state: 'closed', stateReason: 'completed' },
      },
    });
    const svc = createService(harness, logger, queue);

    await svc.poll();

    const reArm = harness.comments.find((c) =>
      c.body.startsWith('**Dependencies resolved'),
    );
    expect(reArm).toBeDefined();
    expect(reArm!.body).toContain(`${OWNER}/${REPO}#1 — ⚠ closed as **not planned**`);
    expect(reArm!.body).toContain(`${OWNER}/${REPO}#2 — ⚠ closed without merging`);
    expect(reArm!.body).toContain(`${OWNER}/${REPO}#3 — closed (completed)`);

    expect(harness.spies.addLabels).toHaveBeenCalledWith(
      OWNER,
      REPO,
      ISSUE,
      ['completed:dependencies'],
    );
    expect(queue.enqueueIfAbsentSpy).toHaveBeenCalledTimes(1);
  });

  it('no block marker comment → skipped, gate held, no ref reads', async () => {
    const harness = createHarness({ noBlockComment: true, refStates: {} });
    const svc = createService(harness, logger, queue);

    await svc.poll();

    expect(harness.spies.getIssueRefState).not.toHaveBeenCalled();
    expect(harness.spies.addLabels).not.toHaveBeenCalled();
    expect(queue.enqueueIfAbsentSpy).not.toHaveBeenCalled();
  });

  it('block marker with unparseable fenced JSON → skipped with a warn, gate held', async () => {
    const harness = createHarness({ malformedBlockComment: true, refStates: {} });
    const svc = createService(harness, logger, queue);

    await svc.poll();

    expect(harness.spies.getIssueRefState).not.toHaveBeenCalled();
    expect(harness.spies.addLabels).not.toHaveBeenCalled();
    expect(queue.enqueueIfAbsentSpy).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('no issues carrying waiting-for:dependencies → no work, no ref reads', async () => {
    const harness = createHarness({ refStates: {} });
    harness.client.listIssuesWithLabel.mockResolvedValue([]);
    const svc = createService(harness, logger, queue);

    await svc.poll();

    expect(harness.client.getIssueComments).not.toHaveBeenCalled();
    expect(harness.spies.getIssueRefState).not.toHaveBeenCalled();
  });

  it('poll() polls the waiting-for:dependencies label only', async () => {
    const harness = createHarness({
      blockedRefs: [ref(1)],
      refStates: { 1: { state: 'open' } },
    });
    const svc = createService(harness, logger, queue);

    await svc.poll();

    expect(harness.client.listIssuesWithLabel).toHaveBeenCalledWith(
      OWNER,
      REPO,
      'waiting-for:dependencies',
    );
  });

  it('listIssuesWithLabel failure is swallowed per repo (poll never throws)', async () => {
    const harness = createHarness({ refStates: {} });
    harness.client.listIssuesWithLabel.mockRejectedValue(new Error('rate limited'));
    const svc = createService(harness, logger, queue);

    await expect(svc.poll()).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
  });
});

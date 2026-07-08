/**
 * Integration test for #849: Paired resume-dedupe clear on pause.
 *
 * Reproduces the FR-007 / SC-001 scenario end-to-end using real
 * `PhaseTrackerService` (with `ioredis-mock` for Redis), real
 * `LabelMonitorService.processLabelEvent` for the resume-enqueue path, and
 * real `LabelManager.onGateHit` for the pause path. The wiring closure at
 * `claude-cli-worker.ts:406` is reproduced inline to keep the test focused
 * on the paired-lifecycle invariant, not the worker's checkout/spawn plumbing.
 *
 * Cycles:
 *   1. Pause  at waiting-for:implementation-review
 *   2. Resume via completed:implementation-review — enqueues, markProcessed
 *   3. Pause  at waiting-for:address-pr-feedback
 *   4. Resume via completed:address-pr-feedback   — enqueues, markProcessed
 *   5. Pause  at waiting-for:implementation-review AGAIN (paired-clear runs)
 *   6. Resume via completed:implementation-review — MUST enqueue again
 *      (this is the bug regression: pre-fix the 24h TTL key survives and
 *      short-circuits step 6, stranding the issue silently)
 *
 * T051 adds the FR-008 single-cycle non-regression: two back-to-back resume
 * events *within* one cycle (between pause 2 and pause 3) — first enqueues,
 * second is deduped as expected.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import RedisMock from 'ioredis-mock';
import type { Redis } from 'ioredis';
import { PhaseTrackerService } from '../services/phase-tracker-service.js';
import { LabelMonitorService } from '../services/label-monitor-service.js';
import { LabelManager } from '../worker/label-manager.js';
import type {
  QueueAdapter,
  QueueItem,
  LabelEvent,
} from '../types/index.js';
import type { Logger } from '../worker/types.js';
import type { GitHubClient } from '@generacy-ai/workflow-engine';

function createLogger(): Logger {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(function (this: Logger) {
      return this;
    }),
  } as unknown as Logger;
  return logger;
}

class InMemoryQueueAdapter implements QueueAdapter {
  public enqueuedItems: QueueItem[] = [];
  async enqueue(item: QueueItem): Promise<void> {
    this.enqueuedItems.push(item);
  }
  clear(): void {
    this.enqueuedItems = [];
  }
}

const OWNER = 'test-org';
const REPO = 'test-repo';
const ISSUE = 42;

// Minimal GitHub client stub — only the methods LabelMonitorService and
// LabelManager touch during the test paths we exercise.
function createGithubStub() {
  const stub = {
    getIssue: vi.fn().mockResolvedValue({
      number: ISSUE,
      title: 'Feature',
      body: 'body',
      state: 'open',
      labels: [{ name: 'workflow:speckit-feature' }],
      assignees: [],
      created_at: '',
      updated_at: '',
    }),
    addLabels: vi.fn().mockResolvedValue(undefined),
    removeLabels: vi.fn().mockResolvedValue(undefined),
  };
  return stub;
}

function buildResumeEvent(gateSuffix: string): LabelEvent {
  return {
    type: 'resume',
    owner: OWNER,
    repo: REPO,
    issueNumber: ISSUE,
    labelName: `completed:${gateSuffix}`,
    parsedName: gateSuffix,
    source: 'webhook',
    issueLabels: [
      `waiting-for:${gateSuffix}`,
      `completed:${gateSuffix}`,
      'workflow:speckit-feature',
    ],
  };
}

describe('#849 paired resume-dedupe clear — integration', () => {
  let redis: Redis;
  let phaseTracker: PhaseTrackerService;
  let queueAdapter: InMemoryQueueAdapter;
  let logger: Logger;
  let github: ReturnType<typeof createGithubStub>;
  let labelMonitor: LabelMonitorService;

  beforeEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    redis = new RedisMock() as unknown as Redis;
    logger = createLogger();
    phaseTracker = new PhaseTrackerService(logger, redis);
    queueAdapter = new InMemoryQueueAdapter();
    github = createGithubStub();

    labelMonitor = new LabelMonitorService(
      logger,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (() => github) as any,
      phaseTracker,
      queueAdapter,
      {
        enabled: true,
        pollIntervalMs: 60000,
        adaptivePolling: false,
        maxConcurrentPolls: 1,
      },
      [{ owner: OWNER, repo: REPO }],
    );
  });

  afterEach(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (redis as any).flushall?.();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (redis as any).disconnect?.();
  });

  // Mirror the wiring closure in claude-cli-worker.ts:406.
  function createLabelManagerForPause(): LabelManager {
    return new LabelManager(
      github as unknown as GitHubClient,
      OWNER,
      REPO,
      ISSUE,
      logger,
      (gateSuffix: string) =>
        phaseTracker.clear(OWNER, REPO, ISSUE, `resume:${gateSuffix}`),
    );
  }

  it('two-cycle pause→resume→pause→resume through implementation-review — second resume enqueues (SC-001)', async () => {
    const labelManager = createLabelManagerForPause();

    // ── Cycle 1 ────────────────────────────────────────────────────────────
    // Pause 1: workflow reaches implementation-review gate.
    await labelManager.onGateHit('implement', 'waiting-for:implementation-review');

    // Resume 1: reviewer applies completed:implementation-review.
    let processed = await labelMonitor.processLabelEvent(
      buildResumeEvent('implementation-review'),
    );
    expect(processed).toBe(true);
    expect(queueAdapter.enqueuedItems).toHaveLength(1);
    // Sanity: markProcessed wrote the dedupe key.
    await expect(
      phaseTracker.isDuplicate(OWNER, REPO, ISSUE, 'resume:implementation-review'),
    ).resolves.toBe(true);

    // Pause 2: workflow reaches address-pr-feedback gate.
    await labelManager.onGateHit('implement', 'waiting-for:address-pr-feedback');

    // Resume 2: reviewer applies completed:address-pr-feedback.
    processed = await labelMonitor.processLabelEvent(
      buildResumeEvent('address-pr-feedback'),
    );
    expect(processed).toBe(true);
    expect(queueAdapter.enqueuedItems).toHaveLength(2);

    // ── Cycle 2 ────────────────────────────────────────────────────────────
    // Pause 3: workflow reaches implementation-review gate AGAIN.
    // Paired-clear invalidates the resume:implementation-review dedupe key.
    await labelManager.onGateHit('implement', 'waiting-for:implementation-review');

    // The key is gone after the paired-clear (FR-007 asserion point).
    await expect(
      phaseTracker.isDuplicate(OWNER, REPO, ISSUE, 'resume:implementation-review'),
    ).resolves.toBe(false);

    // Resume 3: reviewer applies completed:implementation-review AGAIN.
    // Pre-fix: this call short-circuits on isDuplicate:true and the issue
    // silently strands. Post-fix: the paired-clear at pause 3 invalidated
    // the key, so this event enqueues cleanly.
    processed = await labelMonitor.processLabelEvent(
      buildResumeEvent('implementation-review'),
    );
    expect(processed).toBe(true);
    expect(queueAdapter.enqueuedItems).toHaveLength(3);
  });

  it('single-cycle non-regression: two back-to-back resume events → first enqueues, second is deduped (FR-008)', async () => {
    const labelManager = createLabelManagerForPause();

    // Pause and then resume — the second resume in the SAME cycle must be
    // deduped because no new pause has fired between them.
    await labelManager.onGateHit('implement', 'waiting-for:implementation-review');

    const first = await labelMonitor.processLabelEvent(
      buildResumeEvent('implementation-review'),
    );
    expect(first).toBe(true);
    expect(queueAdapter.enqueuedItems).toHaveLength(1);

    const second = await labelMonitor.processLabelEvent(
      buildResumeEvent('implementation-review'),
    );
    expect(second).toBe(false);
    expect(queueAdapter.enqueuedItems).toHaveLength(1);
  });
});

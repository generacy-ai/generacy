import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GhAuthError } from '@generacy-ai/workflow-engine';
import { BaseAdvanceMonitorService } from '../base-advance-monitor-service.js';
import type { ResumeItem, BaseAdvanceMonitorConfig } from '../base-advance-monitor-service.js';
import type { PhaseTracker } from '../../types/monitor.js';
import type { Logger } from '../../worker/types.js';

function makeLogger(): Logger {
  const log = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(),
  };
  log.child.mockReturnValue(log);
  return log as unknown as Logger;
}

function makePhaseTracker(): PhaseTracker & {
  seen: Set<string>;
  isDuplicateRaw: ReturnType<typeof vi.fn>;
  markProcessedRaw: ReturnType<typeof vi.fn>;
} {
  const seen = new Set<string>();
  const stub = {
    seen,
    isDuplicate: vi.fn(),
    markProcessed: vi.fn(),
    clear: vi.fn(),
    tryMarkProcessed: vi.fn(),
    isDuplicateRaw: vi.fn(async (key: string) => seen.has(key)),
    markProcessedRaw: vi.fn(async (key: string) => {
      seen.add(key);
    }),
  };
  return stub as unknown as PhaseTracker & typeof stub;
}

function makePR(overrides: Partial<{
  number: number;
  base: string;
  labels: string[];
}> = {}) {
  return {
    number: overrides.number ?? 42,
    title: 't',
    body: '',
    state: 'open' as const,
    draft: false,
    head: { ref: 'feat/x', sha: '0'.repeat(40), repo: 'acme/widgets' },
    base: { ref: overrides.base ?? 'develop', sha: '0'.repeat(40), repo: 'acme/widgets' },
    labels: (overrides.labels ?? ['failed:validate']).map((n) => ({ name: n, color: '', description: '' })),
    created_at: '',
    updated_at: '',
  };
}

interface StubGithub {
  listOpenPullRequests: ReturnType<typeof vi.fn>;
  getRefHeadSha: ReturnType<typeof vi.fn>;
}

function makeGithub(overrides: Partial<StubGithub> = {}): StubGithub {
  return {
    listOpenPullRequests: overrides.listOpenPullRequests ?? vi.fn().mockResolvedValue([]),
    getRefHeadSha: overrides.getRefHeadSha ?? vi.fn().mockResolvedValue('a'.repeat(40)),
  };
}

const baseConfig = (): BaseAdvanceMonitorConfig => ({
  pollIntervalMs: 60000,
  repositories: [{ owner: 'acme', repo: 'widgets' }],
  concurrency: 4,
});

describe('BaseAdvanceMonitorService (#892)', () => {
  let logger: Logger;
  let tracker: ReturnType<typeof makePhaseTracker>;

  beforeEach(() => {
    logger = makeLogger();
    tracker = makePhaseTracker();
  });

  it('happy path — SHA change enqueues once, unchanged SHA does not re-enqueue', async () => {
    const sha1 = 'a'.repeat(40);
    const sha2 = 'b'.repeat(40);
    const github = makeGithub({
      listOpenPullRequests: vi.fn().mockResolvedValue([makePR({ number: 42, base: 'develop' })]),
      getRefHeadSha: vi.fn().mockResolvedValueOnce(sha1).mockResolvedValueOnce(sha1).mockResolvedValueOnce(sha2),
    });
    const enqueue = vi.fn().mockResolvedValue(undefined);
    const svc = new BaseAdvanceMonitorService(
      logger,
      () => github as any,
      baseConfig(),
      tracker,
      enqueue,
    );

    await svc.pollCycle();
    await svc.pollCycle();
    await svc.pollCycle();

    // cycle 1 sha1 → enqueue; cycle 2 sha1 → dedup skip; cycle 3 sha2 → enqueue.
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(enqueue.mock.calls[0]![0]!).toMatchObject({
      owner: 'acme', repo: 'widgets', issueNumber: 42, reason: 'base-advance', newSha: sha1,
    });
    expect(enqueue.mock.calls[1]![0]!).toMatchObject({
      newSha: sha2,
    });
  });

  it('multi-PR grouping — one getRefHeadSha per group, N enqueues per cycle', async () => {
    const sha1 = 'a'.repeat(40);
    const github = makeGithub({
      listOpenPullRequests: vi.fn().mockResolvedValue([
        makePR({ number: 1, base: 'develop' }),
        makePR({ number: 2, base: 'develop' }),
        makePR({ number: 3, base: 'develop' }),
      ]),
      getRefHeadSha: vi.fn().mockResolvedValue(sha1),
    });
    const enqueue = vi.fn().mockResolvedValue(undefined);
    const svc = new BaseAdvanceMonitorService(
      logger, () => github as any, baseConfig(), tracker, enqueue,
    );

    await svc.pollCycle();
    expect(github.getRefHeadSha).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledTimes(3);

    // Same SHA next cycle → no enqueues.
    await svc.pollCycle();
    expect(enqueue).toHaveBeenCalledTimes(3);
  });

  it('multi-base grouping — one getRefHeadSha per unique base', async () => {
    const github = makeGithub({
      listOpenPullRequests: vi.fn().mockResolvedValue([
        makePR({ number: 1, base: 'develop' }),
        makePR({ number: 2, base: 'main' }),
      ]),
      getRefHeadSha: vi.fn()
        .mockResolvedValueOnce('a'.repeat(40))
        .mockResolvedValueOnce('b'.repeat(40)),
    });
    const enqueue = vi.fn().mockResolvedValue(undefined);
    const svc = new BaseAdvanceMonitorService(
      logger, () => github as any, baseConfig(), tracker, enqueue,
    );

    await svc.pollCycle();
    expect(github.getRefHeadSha).toHaveBeenCalledTimes(2);
    expect(enqueue).toHaveBeenCalledTimes(2);
  });

  it('boot re-arm — every stranded PR gets one enqueue on first cycle', async () => {
    const github = makeGithub({
      listOpenPullRequests: vi.fn().mockResolvedValue([
        makePR({ number: 1, base: 'develop' }),
        makePR({ number: 2, base: 'develop' }),
        makePR({ number: 3, base: 'develop' }),
        makePR({ number: 4, base: 'develop' }),
        makePR({ number: 5, base: 'develop' }),
      ]),
      getRefHeadSha: vi.fn().mockResolvedValue('c'.repeat(40)),
    });
    const enqueue = vi.fn().mockResolvedValue(undefined);
    const svc = new BaseAdvanceMonitorService(
      logger, () => github as any, baseConfig(), tracker, enqueue,
    );

    await svc.pollCycle();
    expect(enqueue).toHaveBeenCalledTimes(5);
  });

  it('GhAuthError on getRefHeadSha — records authHealth failure and skips group', async () => {
    const github = makeGithub({
      listOpenPullRequests: vi.fn().mockResolvedValue([
        makePR({ number: 1, base: 'develop' }),
        makePR({ number: 2, base: 'main' }),
      ]),
      getRefHeadSha: vi.fn()
        .mockRejectedValueOnce(new GhAuthError(401, 'boom'))
        .mockResolvedValueOnce('d'.repeat(40)),
    });
    const enqueue = vi.fn().mockResolvedValue(undefined);
    const authHealth = { recordResult: vi.fn() };
    const svc = new BaseAdvanceMonitorService(
      logger, () => github as any, baseConfig(), tracker, enqueue,
      undefined, authHealth, 'cred-A',
    );

    await svc.pollCycle();

    expect(authHealth.recordResult).toHaveBeenCalledWith('cred-A', { ok: false, statusCode: 401 });
    // Only the non-failing base group produced an enqueue.
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it('enqueueResume failure — markProcessedRaw NOT called; next cycle retries and succeeds', async () => {
    const sha1 = 'e'.repeat(40);
    const github = makeGithub({
      listOpenPullRequests: vi.fn().mockResolvedValue([makePR({ number: 42, base: 'develop' })]),
      getRefHeadSha: vi.fn().mockResolvedValue(sha1),
    });
    const enqueue = vi.fn()
      .mockRejectedValueOnce(new Error('queue down'))
      .mockResolvedValueOnce(undefined);
    const svc = new BaseAdvanceMonitorService(
      logger, () => github as any, baseConfig(), tracker, enqueue,
    );

    await svc.pollCycle();
    // First cycle: enqueue threw → no markProcessedRaw call.
    expect(tracker.markProcessedRaw).not.toHaveBeenCalled();

    await svc.pollCycle();
    // Second cycle: enqueue succeeds → markProcessedRaw called with the same key.
    expect(tracker.markProcessedRaw).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledTimes(2);
  });

  it('stopPolling — awaits in-flight cycle and stops loop', async () => {
    const github = makeGithub({
      listOpenPullRequests: vi.fn().mockResolvedValue([]),
    });
    const enqueue = vi.fn();
    const svc = new BaseAdvanceMonitorService(
      logger, () => github as any, { ...baseConfig(), pollIntervalMs: 10 }, tracker, enqueue,
    );

    const running = svc.startPolling();
    await new Promise((r) => setTimeout(r, 30));
    await svc.stopPolling();
    await running;
    // Should not throw; multiple cycles ran.
    expect(github.listOpenPullRequests.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it('empty repo — no getRefHeadSha calls, no enqueues', async () => {
    const github = makeGithub({
      listOpenPullRequests: vi.fn().mockResolvedValue([]),
    });
    const enqueue = vi.fn();
    const svc = new BaseAdvanceMonitorService(
      logger, () => github as any, baseConfig(), tracker, enqueue,
    );
    await svc.pollCycle();
    expect(github.getRefHeadSha).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('filters out PRs without failed:validate label', async () => {
    const github = makeGithub({
      listOpenPullRequests: vi.fn().mockResolvedValue([
        makePR({ number: 1, base: 'develop', labels: ['phase:validate'] }),
        makePR({ number: 2, base: 'develop', labels: ['failed:validate'] }),
      ]),
      getRefHeadSha: vi.fn().mockResolvedValue('f'.repeat(40)),
    });
    const enqueue = vi.fn().mockResolvedValue(undefined);
    const svc = new BaseAdvanceMonitorService(
      logger, () => github as any, baseConfig(), tracker, enqueue,
    );

    await svc.pollCycle();
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0]![0]!.issueNumber).toBe(2);
  });
});

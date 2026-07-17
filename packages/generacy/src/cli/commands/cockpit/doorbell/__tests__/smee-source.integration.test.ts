import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import { SmeeDoorbellSource } from '../smee-source.js';
import type { CockpitStreamEvent } from '../../watch/stream-event.js';
import type { GhWrapper } from '@generacy-ai/cockpit';
import type { ChecksRollup, PrSnapshot, SnapshotMap } from '../../watch/snapshot.js';
import { snapshotKey } from '../../watch/snapshot.js';

interface FakeServer {
  url: string;
  server: http.Server;
  activeSockets: Set<import('node:net').Socket>;
  activeResponses: Set<http.ServerResponse>;
  writeFrame: (frame: string) => void;
  close: () => Promise<void>;
  dropAllConnections: () => void;
}

async function startFakeSmee(): Promise<FakeServer> {
  const activeSockets = new Set<import('node:net').Socket>();
  const activeResponses = new Set<http.ServerResponse>();

  const server = http.createServer((req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(`event: ready\ndata: {}\n\n`);
    activeResponses.add(res);
    req.on('close', () => activeResponses.delete(res));
  });

  server.on('connection', (socket) => {
    activeSockets.add(socket);
    socket.on('close', () => activeSockets.delete(socket));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${addr.port}/channel`;

  const writeFrame = (frame: string): void => {
    for (const res of activeResponses) {
      res.write(frame);
    }
  };

  const dropAllConnections = (): void => {
    for (const res of activeResponses) {
      try {
        res.destroy();
      } catch {
        /* noop */
      }
    }
    for (const sock of activeSockets) {
      try {
        sock.destroy();
      } catch {
        /* noop */
      }
    }
  };

  const close = async (): Promise<void> => {
    dropAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };

  return { url, server, activeSockets, activeResponses, writeFrame, close, dropAllConnections };
}

function checkRunFrame(opts: {
  repoOwner?: string;
  repoName?: string;
  prNumber?: number;
}): string {
  const owner = opts.repoOwner ?? 'o';
  const repo = opts.repoName ?? 'r';
  const prNumber = opts.prNumber ?? 42;
  const payload = {
    'x-github-event': 'check_run',
    body: {
      action: 'completed',
      repository: { name: repo, owner: { login: owner } },
      check_run: { pull_requests: [{ number: prNumber }] },
    },
  };
  return `event: message\ndata: ${JSON.stringify(payload)}\n\n`;
}

function fakePrSnapshot(repo: string, number: number, rollup: ChecksRollup): PrSnapshot {
  return {
    kind: 'pr',
    repo,
    number,
    url: `https://github.com/${repo}/pull/${number}`,
    lifecycle: 'open',
    state: 'OPEN',
    stateReason: null,
    labels: [],
    classified: { state: 'unknown', sourceLabel: '', labels: [] },
    checksRollup: rollup,
    cyclesSinceLastCheckFetch: 0,
  };
}

function setPrev(source: SmeeDoorbellSource, prev: SnapshotMap): void {
  (source as unknown as { prev: SnapshotMap }).prev = prev;
}

function issueFrame(action: string, opts: {
  repoOwner?: string;
  repoName?: string;
  number?: number;
  label?: string;
  labels?: string[];
}): string {
  const owner = opts.repoOwner ?? 'o';
  const repo = opts.repoName ?? 'r';
  const number = opts.number ?? 42;
  const label = opts.label ?? 'foo';
  const labels = opts.labels ?? [{ name: label } as unknown];
  const payload = {
    'x-github-event': 'issues',
    body: {
      action,
      repository: { name: repo, owner: { login: owner } },
      issue: { number, labels: labels.map((n) => (typeof n === 'string' ? { name: n } : n)) },
      label: { name: label },
    },
  };
  return `event: message\ndata: ${JSON.stringify(payload)}\n\n`;
}

async function waitFor(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`waitFor: predicate did not become true in ${timeoutMs}ms`);
}

const FAKE_RESOLVED = {
  epic: { repo: 'o/r', number: 100 },
  parsed: { phases: [], adhocRefs: [], allRefs: [{ repo: 'o/r', number: 42 }], warnings: [] },
  repos: ['o/r'],
  bodyHash: 'x',
};

// Stub resolveEpic to return a fixed resolved epic — the smee source uses it
// at startup and on refresh.
vi.mock('@generacy-ai/cockpit', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    resolveEpic: vi.fn(async () => FAKE_RESOLVED),
  };
});

describe('SmeeDoorbellSource integration', () => {
  let fake: FakeServer;

  beforeEach(async () => {
    fake = await startFakeSmee();
  });

  afterEach(async () => {
    await fake.close();
  });

  it('emits one event per matching payload', async () => {
    const events: CockpitStreamEvent[] = [];
    const source = new SmeeDoorbellSource({
      channelUrl: fake.url,
      epicRef: 'o/r#100',
      gh: {} as unknown as GhWrapper,
      logger: { warn: () => undefined, info: () => undefined },
      onEvent: async (ev) => {
        events.push(ev);
      },
      onReconnectAttempt: () => undefined,
      onReconnectSuccess: () => undefined,
      baseReconnectDelayMs: 10,
    });

    await source.start();
    await waitFor(() => fake.activeResponses.size > 0);
    fake.writeFrame(issueFrame('labeled', { number: 42, label: 'foo' }));

    await waitFor(() => events.length >= 1);
    expect(events[0]?.type).toBe('issue-transition');
    if (events[0]?.type === 'issue-transition') {
      expect(events[0].event).toBe('label-change');
    }

    await source.stop();
  }, 10_000);

  it('drops payload for repo not in watched set', async () => {
    const events: CockpitStreamEvent[] = [];
    const source = new SmeeDoorbellSource({
      channelUrl: fake.url,
      epicRef: 'o/r#100',
      gh: {} as unknown as GhWrapper,
      logger: { warn: () => undefined, info: () => undefined },
      onEvent: async (ev) => {
        events.push(ev);
      },
      onReconnectAttempt: () => undefined,
      onReconnectSuccess: () => undefined,
      baseReconnectDelayMs: 10,
    });

    await source.start();
    await waitFor(() => fake.activeResponses.size > 0);
    fake.writeFrame(
      issueFrame('labeled', { number: 42, repoOwner: 'other', repoName: 'unrelated' }),
    );
    await new Promise((r) => setTimeout(r, 100));
    expect(events).toHaveLength(0);

    await source.stop();
  }, 10_000);

  it('drops payload for issue not in ref set', async () => {
    const events: CockpitStreamEvent[] = [];
    const source = new SmeeDoorbellSource({
      channelUrl: fake.url,
      epicRef: 'o/r#100',
      gh: {} as unknown as GhWrapper,
      logger: { warn: () => undefined, info: () => undefined },
      onEvent: async (ev) => {
        events.push(ev);
      },
      onReconnectAttempt: () => undefined,
      onReconnectSuccess: () => undefined,
      baseReconnectDelayMs: 10,
    });

    await source.start();
    await waitFor(() => fake.activeResponses.size > 0);
    fake.writeFrame(issueFrame('labeled', { number: 999 }));
    await new Promise((r) => setTimeout(r, 100));
    expect(events).toHaveLength(0);

    await source.stop();
  }, 10_000);

  it('reconnects with backoff after connection drop and calls onReconnectAttempt', async () => {
    const attempts: number[] = [];
    let successes = 0;
    const source = new SmeeDoorbellSource({
      channelUrl: fake.url,
      epicRef: 'o/r#100',
      gh: {} as unknown as GhWrapper,
      logger: { warn: () => undefined, info: () => undefined },
      onEvent: async () => undefined,
      onReconnectAttempt: (n) => attempts.push(n),
      onReconnectSuccess: () => (successes += 1),
      baseReconnectDelayMs: 10,
    });

    await source.start();
    await waitFor(() => successes >= 1);
    fake.dropAllConnections();
    await waitFor(() => attempts.length >= 1, 3000);
    expect(attempts[0]).toBeGreaterThanOrEqual(1);

    await source.stop();
  }, 15_000);

  // T006 (FR-008c, INV-1): no gh calls between webhook receipt and onEvent dispatch.
  it('smee event path performs zero gh calls between webhook receipt and onEvent dispatch', async () => {
    const events: CockpitStreamEvent[] = [];
    const invocations: string[] = [];
    const trapGh = new Proxy(
      {},
      {
        get(_target, prop): unknown {
          const name = String(prop);
          return (...args: unknown[]): never => {
            invocations.push(`${name}(${args.length})`);
            throw new Error(`unexpected gh call: ${name}`);
          };
        },
      },
    ) as unknown as GhWrapper;

    const source = new SmeeDoorbellSource({
      channelUrl: fake.url,
      epicRef: 'o/r#100',
      gh: trapGh,
      logger: { warn: () => undefined, info: () => undefined },
      onEvent: async (ev) => {
        events.push(ev);
      },
      onReconnectAttempt: () => undefined,
      onReconnectSuccess: () => undefined,
      baseReconnectDelayMs: 10,
    });

    await source.start();
    await waitFor(() => fake.activeResponses.size > 0);

    // Fire a pr-checks payload — the code path that would historically call gh.
    fake.writeFrame(checkRunFrame({ prNumber: 42 }));
    await waitFor(() => events.length >= 1);

    expect(invocations).toEqual([]);
    expect(events[0]?.type).toBe('issue-transition');

    await source.stop();
  }, 10_000);

  // T006 (FR-008d, INV-4): checks stamping mirror the checks-mapping contract table.
  describe('checks stamping (contracts/checks-mapping.md)', () => {
    it.each<[ChecksRollup, 'green' | 'red' | undefined]>([
      ['success', 'green'],
      ['failure', 'red'],
      ['error', 'red'],
      ['pending', undefined],
      ['none', undefined],
    ])('pr-checks with cached rollup=%s → wire checks=%s', async (rollup, wire) => {
      const events: CockpitStreamEvent[] = [];
      const source = new SmeeDoorbellSource({
        channelUrl: fake.url,
        epicRef: 'o/r#100',
        gh: {} as unknown as GhWrapper,
        logger: { warn: () => undefined, info: () => undefined },
        onEvent: async (ev) => {
          events.push(ev);
        },
        onReconnectAttempt: () => undefined,
        onReconnectSuccess: () => undefined,
        baseReconnectDelayMs: 10,
      });

      await source.start();
      const prev: SnapshotMap = new Map();
      prev.set(snapshotKey('o/r', 'pr', 42), fakePrSnapshot('o/r', 42, rollup));
      setPrev(source, prev);

      await waitFor(() => fake.activeResponses.size > 0);
      fake.writeFrame(checkRunFrame({ prNumber: 42 }));
      await waitFor(() => events.length >= 1);

      const ev = events[0]!;
      expect(ev.type).toBe('issue-transition');
      if (ev.type === 'issue-transition') {
        expect(ev.event).toBe('pr-checks');
        expect(ev.checks).toBe(wire);
      }

      await source.stop();
    }, 10_000);

    it('pr-checks with cache miss → checks absent', async () => {
      const events: CockpitStreamEvent[] = [];
      const source = new SmeeDoorbellSource({
        channelUrl: fake.url,
        epicRef: 'o/r#100',
        gh: {} as unknown as GhWrapper,
        logger: { warn: () => undefined, info: () => undefined },
        onEvent: async (ev) => {
          events.push(ev);
        },
        onReconnectAttempt: () => undefined,
        onReconnectSuccess: () => undefined,
        baseReconnectDelayMs: 10,
      });

      await source.start();
      // prev intentionally left empty — cache miss.
      await waitFor(() => fake.activeResponses.size > 0);
      fake.writeFrame(checkRunFrame({ prNumber: 42 }));
      await waitFor(() => events.length >= 1);

      const ev = events[0]!;
      if (ev.type === 'issue-transition') {
        expect(ev.checks).toBeUndefined();
      }

      await source.stop();
    }, 10_000);

    it('completed:validate label-change with cached success rollup → checks=green', async () => {
      const events: CockpitStreamEvent[] = [];
      const source = new SmeeDoorbellSource({
        channelUrl: fake.url,
        epicRef: 'o/r#100',
        gh: {} as unknown as GhWrapper,
        logger: { warn: () => undefined, info: () => undefined },
        onEvent: async (ev) => {
          events.push(ev);
        },
        onReconnectAttempt: () => undefined,
        onReconnectSuccess: () => undefined,
        baseReconnectDelayMs: 10,
      });

      await source.start();
      const prev: SnapshotMap = new Map();
      prev.set(snapshotKey('o/r', 'pr', 42), fakePrSnapshot('o/r', 42, 'success'));
      setPrev(source, prev);

      await waitFor(() => fake.activeResponses.size > 0);
      fake.writeFrame(
        issueFrame('labeled', {
          number: 42,
          label: 'completed:validate',
          labels: ['completed:validate'],
        }),
      );
      await waitFor(() => events.length >= 1);

      const ev = events[0]!;
      if (ev.type === 'issue-transition') {
        expect(ev.event).toBe('label-change');
        expect(ev.sourceLabel).toBe('completed:validate');
        expect(ev.checks).toBe('green');
      }

      await source.stop();
    }, 10_000);

    it('unrelated event (label-change, non-validate) does NOT get checks stamped', async () => {
      const events: CockpitStreamEvent[] = [];
      const source = new SmeeDoorbellSource({
        channelUrl: fake.url,
        epicRef: 'o/r#100',
        gh: {} as unknown as GhWrapper,
        logger: { warn: () => undefined, info: () => undefined },
        onEvent: async (ev) => {
          events.push(ev);
        },
        onReconnectAttempt: () => undefined,
        onReconnectSuccess: () => undefined,
        baseReconnectDelayMs: 10,
      });

      await source.start();
      // Even with a success-rollup snapshot cached, non-validate label events skip checks.
      const prev: SnapshotMap = new Map();
      prev.set(snapshotKey('o/r', 'pr', 42), fakePrSnapshot('o/r', 42, 'success'));
      setPrev(source, prev);

      await waitFor(() => fake.activeResponses.size > 0);
      fake.writeFrame(
        issueFrame('labeled', {
          number: 42,
          label: 'agent:paused',
          labels: ['agent:paused'],
        }),
      );
      await waitFor(() => events.length >= 1);

      const ev = events[0]!;
      if (ev.type === 'issue-transition') {
        expect(ev.checks).toBeUndefined();
      }

      await source.stop();
    }, 10_000);
  });

  it('p95 latency ≤ 3s for 20 simulated events with fast backoff', async () => {
    const timings: number[] = [];
    const source = new SmeeDoorbellSource({
      channelUrl: fake.url,
      epicRef: 'o/r#100',
      gh: {} as unknown as GhWrapper,
      logger: { warn: () => undefined, info: () => undefined },
      onEvent: async () => {
        timings.push(Date.now());
      },
      onReconnectAttempt: () => undefined,
      onReconnectSuccess: () => undefined,
      baseReconnectDelayMs: 10,
    });

    await source.start();
    await waitFor(() => fake.activeResponses.size > 0);

    const sends: number[] = [];
    const N = 20;
    for (let i = 0; i < N; i++) {
      sends.push(Date.now());
      fake.writeFrame(issueFrame('labeled', { number: 42, label: `foo-${i}` }));
      await new Promise((r) => setTimeout(r, 5));
    }
    await waitFor(() => timings.length >= N, 5000);

    const latencies = sends.slice(0, N).map((s, i) => timings[i]! - s);
    latencies.sort((a, b) => a - b);
    const p95 = latencies[Math.floor(0.95 * N)] ?? latencies[N - 1] ?? 0;
    expect(p95).toBeLessThanOrEqual(3000);

    await source.stop();
  }, 15_000);
});

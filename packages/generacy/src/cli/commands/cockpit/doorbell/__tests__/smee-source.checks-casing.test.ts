import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import { SmeeDoorbellSource } from '../smee-source.js';
import type { CockpitStreamEvent } from '../../watch/stream-event.js';
import type { GhWrapper } from '@generacy-ai/cockpit';
import type { ChecksRollup, PrSnapshot, SnapshotMap } from '../../watch/snapshot.js';
import { snapshotKey } from '../../watch/snapshot.js';

// #1113 — Pin the read-through PrSnapshot cache path to `snapshotKey`. PR #1109
// (fix for #1106) lowercases `repo` inside `snapshotKey` at both write and read
// sites, so a write/read casing mismatch still hits the cache. These rows drive
// `processEventBlock` end-to-end with the write key and read payload in opposite
// casings; the read-mixed rows go red if `smee-source.ts:375`'s
// `snapshotKey(ev.repo, 'pr', ev.number)` is ever inlined as
// `` `${ev.repo}#pr#${ev.number}` `` (payload-canonical casing → cache miss →
// `checks: undefined`).
//
// Lives in a non-`*.integration.test.ts` file so it runs under `pnpm test` and
// therefore gates the speckit `validate` phase (#1115 review).

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

describe('#1113 read-through cache path — casing drift across snapshotKey', () => {
  let fake: FakeServer;

  beforeEach(async () => {
    fake = await startFakeSmee();
  });

  afterEach(async () => {
    await fake.close();
  });

  it('write-mixed × pr-checks: cached under O/R, payload o/r → checks=green', async () => {
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
    prev.set(snapshotKey('O/R', 'pr', 42), fakePrSnapshot('O/R', 42, 'success'));
    setPrev(source, prev);

    await waitFor(() => fake.activeResponses.size > 0);
    fake.writeFrame(checkRunFrame({ prNumber: 42, repoOwner: 'o', repoName: 'r' }));
    await waitFor(() => events.length >= 1);

    const ev = events[0]!;
    expect(ev.type).toBe('issue-transition');
    if (ev.type === 'issue-transition') {
      expect(ev.event).toBe('pr-checks');
      expect(ev.checks).toBe('green');
    }

    await source.stop();
  }, 10_000);

  // SC-002 mutation-killer: write lowercase, read mixed. Inlining the line-375
  // key produces `'O/R#pr#42'`, which misses the lowercase-written cache entry.
  it('read-mixed × pr-checks: cached under o/r, payload O/R → checks=green', async () => {
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
    fake.writeFrame(checkRunFrame({ prNumber: 42, repoOwner: 'O', repoName: 'R' }));
    await waitFor(() => events.length >= 1);

    const ev = events[0]!;
    expect(ev.type).toBe('issue-transition');
    if (ev.type === 'issue-transition') {
      expect(ev.event).toBe('pr-checks');
      expect(ev.checks).toBe('green');
    }

    await source.stop();
  }, 10_000);

  it('write-mixed × completed:validate: cached under O/R, payload o/r → checks=green', async () => {
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
    prev.set(snapshotKey('O/R', 'pr', 42), fakePrSnapshot('O/R', 42, 'success'));
    setPrev(source, prev);

    await waitFor(() => fake.activeResponses.size > 0);
    fake.writeFrame(
      issueFrame('labeled', {
        number: 42,
        label: 'completed:validate',
        labels: ['completed:validate'],
        repoOwner: 'o',
        repoName: 'r',
      }),
    );
    await waitFor(() => events.length >= 1);

    const ev = events[0]!;
    expect(ev.type).toBe('issue-transition');
    if (ev.type === 'issue-transition') {
      expect(ev.event).toBe('label-change');
      expect(ev.sourceLabel).toBe('completed:validate');
      expect(ev.checks).toBe('green');
    }

    await source.stop();
  }, 10_000);

  // SC-002 mutation-killer (label-change branch): write lowercase, read mixed.
  it('read-mixed × completed:validate: cached under o/r, payload O/R → checks=green', async () => {
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
        repoOwner: 'O',
        repoName: 'R',
      }),
    );
    await waitFor(() => events.length >= 1);

    const ev = events[0]!;
    expect(ev.type).toBe('issue-transition');
    if (ev.type === 'issue-transition') {
      expect(ev.event).toBe('label-change');
      expect(ev.sourceLabel).toBe('completed:validate');
      expect(ev.checks).toBe('green');
    }

    await source.stop();
  }, 10_000);
});

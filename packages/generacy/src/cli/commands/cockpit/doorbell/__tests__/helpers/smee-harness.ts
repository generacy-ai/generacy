import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import { SmeeDoorbellSource } from '../../smee-source.js';
import type { ChecksRollup, PrSnapshot, SnapshotMap } from '../../../watch/snapshot.js';

// Shared scaffolding for the smee-doorbell integration and casing-drift tests.
// Not a `*.test.ts` file — vitest's include glob (`src/**/__tests__/**/*.test.ts`)
// will not collect this as a suite. Any change to the SSE fake or the webhook
// frame shape belongs here so both consumers stay in lockstep.
//
// The `vi.mock('@generacy-ai/cockpit', ...)` call is intentionally NOT extracted:
// module mocks are hoisted per-file by vitest and do not survive extraction.

export interface FakeServer {
  url: string;
  server: http.Server;
  activeSockets: Set<import('node:net').Socket>;
  activeResponses: Set<http.ServerResponse>;
  writeFrame: (frame: string) => void;
  close: () => Promise<void>;
  dropAllConnections: () => void;
}

export async function startFakeSmee(): Promise<FakeServer> {
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

export function checkRunFrame(opts: {
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

export function fakePrSnapshot(repo: string, number: number, rollup: ChecksRollup): PrSnapshot {
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

export function setPrev(source: SmeeDoorbellSource, prev: SnapshotMap): void {
  (source as unknown as { prev: SnapshotMap }).prev = prev;
}

export function issueFrame(action: string, opts: {
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

export async function waitFor(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`waitFor: predicate did not become true in ${timeoutMs}ms`);
}

export const FAKE_RESOLVED = {
  epic: { repo: 'o/r', number: 100 },
  parsed: { phases: [], adhocRefs: [], allRefs: [{ repo: 'o/r', number: 42 }], warnings: [] },
  repos: ['o/r'],
  bodyHash: 'x',
};

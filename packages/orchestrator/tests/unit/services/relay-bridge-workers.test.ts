/**
 * Tests for RelayBridge worker enumeration (#714).
 *
 * Covers the four scenarios from plan.md §"Project Structure":
 *   1. Running count       — workers === #running replicas
 *   2. Engine error        — workers omitted when DockerDaemonUnavailableError
 *   3. NOT_COMPOSE_MANAGED — workers omitted, /events subscription not opened
 *   4. Event-driven        — die event triggers sendMetadata within 100ms
 *
 * Plus filter-shape and cancellation assertions from
 * contracts/docker-events-subscription.md §"Conformance test cases" cases 2–3.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({
  execSync: vi.fn(() => 'origin\tgit@github.com:org/repo.git (fetch)\n'),
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    readFileSync: vi.fn(() => '{"version":"0.1.0"}'),
  };
});

vi.mock('../../../src/services/code-server-probe.js', () => ({
  probeCodeServerSocket: vi.fn(async () => false),
}));

vi.mock('../../../src/services/control-plane-probe.js', () => ({
  probeControlPlaneSocket: vi.fn(async () => false),
}));

import { RelayBridge } from '../../../src/services/relay-bridge.js';
import type { ClusterRelayClient } from '../../../src/types/relay.js';
import type { SSESubscriptionManager } from '../../../src/sse/subscriptions.js';
import type { FastifyInstance } from 'fastify';
import type {
  DockerEngineClient,
  EngineEvent,
  StreamContainerEventsOptions,
} from '@generacy-ai/control-plane';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

type StreamControl = {
  yield: (event: EngineEvent) => void;
  end: () => void;
  error: (err: Error) => void;
  capturedOptions: StreamContainerEventsOptions | null;
  capturedSignals: AbortSignal[];
};

function makeControllableStream(): {
  control: StreamControl;
  stream: (opts: StreamContainerEventsOptions) => AsyncIterable<EngineEvent>;
} {
  const control: StreamControl = {
    yield: () => {},
    end: () => {},
    error: () => {},
    capturedOptions: null,
    capturedSignals: [],
  };

  const stream = (opts: StreamContainerEventsOptions): AsyncIterable<EngineEvent> => {
    control.capturedOptions = opts;
    if (opts.signal) control.capturedSignals.push(opts.signal);

    const queue: EngineEvent[] = [];
    let done = false;
    let err: Error | null = null;
    let pending: ((res: IteratorResult<EngineEvent>) => void) | null = null;
    let pendingReject: ((err: Error) => void) | null = null;

    const settle = (): void => {
      if (err && pendingReject) {
        const reject = pendingReject;
        pending = null;
        pendingReject = null;
        reject(err);
        return;
      }
      if (queue.length > 0 && pending) {
        const next = queue.shift()!;
        const resolve = pending;
        pending = null;
        pendingReject = null;
        resolve({ value: next, done: false });
        return;
      }
      if (done && pending) {
        const resolve = pending;
        pending = null;
        pendingReject = null;
        resolve({ value: undefined, done: true });
      }
    };

    control.yield = (e) => {
      queue.push(e);
      settle();
    };
    control.end = () => {
      done = true;
      settle();
    };
    control.error = (e) => {
      err = e;
      settle();
    };

    const abortHandler = (): void => {
      done = true;
      settle();
    };
    if (opts.signal) {
      if (opts.signal.aborted) abortHandler();
      else opts.signal.addEventListener('abort', abortHandler, { once: true });
    }

    return {
      [Symbol.asyncIterator]: () => ({
        next: () =>
          new Promise<IteratorResult<EngineEvent>>((resolve, reject) => {
            pending = resolve;
            pendingReject = reject;
            settle();
          }),
        return: () => {
          done = true;
          return Promise.resolve({ value: undefined, done: true } as IteratorResult<EngineEvent>);
        },
      }),
    };
  };

  return { control, stream };
}

function makeEngineClient(overrides: Partial<DockerEngineClient> = {}): DockerEngineClient {
  return {
    inspectContainer: vi.fn().mockResolvedValue({
      Config: { Labels: { 'com.docker.compose.project': 'testproj' } },
    }),
    listContainers: vi.fn().mockResolvedValue([]),
    streamContainerEvents: vi.fn().mockReturnValue({
      [Symbol.asyncIterator]: () => ({
        next: () => new Promise(() => {}), // never resolves
        return: () => Promise.resolve({ value: undefined, done: true }),
      }),
    }),
    ...overrides,
  } as unknown as DockerEngineClient;
}

interface BridgeFixture {
  bridge: RelayBridge;
  client: ClusterRelayClient & {
    connect: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
    send: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
    off: ReturnType<typeof vi.fn>;
  };
}

function createBridge(engineClient: DockerEngineClient): BridgeFixture {
  const handlers: Record<string, ((...args: unknown[]) => void)[]> = {};
  let connected = false;

  const fakeClient = {
    connect: vi.fn(async () => {
      connected = true;
      handlers['connected']?.forEach((h) => h());
    }),
    disconnect: vi.fn(async () => {
      connected = false;
    }),
    send: vi.fn(),
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      (handlers[event] ??= []).push(handler);
    }),
    off: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      handlers[event] = (handlers[event] ?? []).filter((h) => h !== handler);
    }),
    get isConnected() {
      return connected;
    },
  } as unknown as BridgeFixture['client'];

  const fakeServer = {} as FastifyInstance;
  const fakeSseManager = {
    broadcast: vi.fn(),
  } as unknown as SSESubscriptionManager;

  const bridge = new RelayBridge({
    client: fakeClient,
    server: fakeServer,
    sseManager: fakeSseManager,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as never,
    config: {
      metadataIntervalMs: 60_000,
      clusterYamlPath: '/nonexistent/cluster.yaml',
    } as never,
    engineClient,
  });

  return { bridge, client: fakeClient };
}

// Helper: wait one macrotask so microtasks scheduled by start() can run.
const tick = (ms = 10): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Scenario 1: Running count
// ---------------------------------------------------------------------------

describe('RelayBridge workers — running count', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reports workers as the count of running replicas (2 running + 1 exited → 2)', async () => {
    const engineClient = makeEngineClient({
      listContainers: vi.fn().mockResolvedValue([
        {
          Id: 'c1',
          Names: ['/testproj-worker-1'],
          State: 'running',
          Labels: {
            'com.docker.compose.project': 'testproj',
            'com.docker.compose.service': 'worker',
            'com.docker.compose.container-number': '1',
          },
          NetworkSettings: { Networks: {} },
        },
        {
          Id: 'c2',
          Names: ['/testproj-worker-2'],
          State: 'running',
          Labels: {
            'com.docker.compose.project': 'testproj',
            'com.docker.compose.service': 'worker',
            'com.docker.compose.container-number': '2',
          },
          NetworkSettings: { Networks: {} },
        },
        {
          Id: 'c3',
          Names: ['/testproj-worker-3'],
          State: 'exited',
          Labels: {
            'com.docker.compose.project': 'testproj',
            'com.docker.compose.service': 'worker',
            'com.docker.compose.container-number': '3',
          },
          NetworkSettings: { Networks: {} },
        },
      ]) as never,
    });

    const { bridge } = createBridge(engineClient);
    const metadata = await bridge.collectMetadata();

    expect(metadata.workers).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: Engine error omission
// ---------------------------------------------------------------------------

describe('RelayBridge workers — engine error omission', () => {
  beforeEach(() => vi.clearAllMocks());

  it('omits workers when listContainers throws DockerDaemonUnavailableError; rest of payload still sent', async () => {
    const { DockerDaemonUnavailableError } = await import(
      '@generacy-ai/control-plane'
    );
    const engineClient = makeEngineClient({
      listContainers: vi
        .fn()
        .mockRejectedValue(new DockerDaemonUnavailableError('/var/run/docker.sock')) as never,
    });

    const { bridge } = createBridge(engineClient);
    const metadata = await bridge.collectMetadata();

    expect(metadata.workers).toBeUndefined();
    // Rest of the payload is still well-formed.
    expect(metadata.version).toBeDefined();
    expect(metadata.reportedAt).toBeDefined();
    expect(Array.isArray(metadata.gitRemotes)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Scenario 3: NOT_COMPOSE_MANAGED omission + no subscription
// ---------------------------------------------------------------------------

describe('RelayBridge workers — NOT_COMPOSE_MANAGED', () => {
  const originalProject = process.env['COMPOSE_PROJECT_NAME'];
  beforeEach(() => {
    delete process.env['COMPOSE_PROJECT_NAME'];
    vi.clearAllMocks();
  });
  afterEach(() => {
    if (originalProject !== undefined) {
      process.env['COMPOSE_PROJECT_NAME'] = originalProject;
    }
  });

  it('does not open /events subscription and omits workers from collectMetadata', async () => {
    const engineClient = makeEngineClient({
      inspectContainer: vi.fn().mockRejectedValue(new Error('no inspect')) as never,
    });

    const { bridge } = createBridge(engineClient);
    await bridge.start();
    await tick();

    expect(engineClient.streamContainerEvents).not.toHaveBeenCalled();

    const metadata = await bridge.collectMetadata();
    expect(metadata.workers).toBeUndefined();

    await bridge.stop();
  });
});

// ---------------------------------------------------------------------------
// Scenario 4: Event-driven refresh + filter shape + cancellation
// ---------------------------------------------------------------------------

describe('RelayBridge workers — event-driven refresh', () => {
  const originalProject = process.env['COMPOSE_PROJECT_NAME'];
  beforeEach(() => {
    process.env['COMPOSE_PROJECT_NAME'] = 'testproj';
    vi.clearAllMocks();
  });
  afterEach(() => {
    if (originalProject !== undefined) {
      process.env['COMPOSE_PROJECT_NAME'] = originalProject;
    } else {
      delete process.env['COMPOSE_PROJECT_NAME'];
    }
  });

  it('passes the documented filter shape (labels + type=container) to streamContainerEvents', async () => {
    const { control, stream } = makeControllableStream();
    const engineClient = makeEngineClient({
      streamContainerEvents: vi.fn(stream) as never,
    });

    const { bridge } = createBridge(engineClient);
    await bridge.start();
    await tick();

    expect(engineClient.streamContainerEvents).toHaveBeenCalledTimes(1);
    expect(control.capturedOptions).toBeTruthy();
    expect(control.capturedOptions?.filters.type).toEqual(['container']);
    expect(control.capturedOptions?.filters.label).toEqual([
      'com.docker.compose.project=testproj',
      'com.docker.compose.service=worker',
    ]);
    expect(control.capturedOptions?.signal).toBeInstanceOf(AbortSignal);

    await bridge.stop();
  });

  it('fires sendMetadata within 100ms of receiving a die event', async () => {
    const { control, stream } = makeControllableStream();
    const engineClient = makeEngineClient({
      streamContainerEvents: vi.fn(stream) as never,
    });

    const { bridge, client } = createBridge(engineClient);
    const sendSpy = vi.spyOn(bridge, 'sendMetadata');

    await bridge.start();
    await tick();

    // start() -> handleConnected() fires sendMetadata once; reset to isolate.
    sendSpy.mockClear();
    client.send.mockClear();

    const t0 = Date.now();
    control.yield({
      Type: 'container',
      Action: 'die',
      id: 'c1',
      Actor: { ID: 'c1', Attributes: {} },
    });

    // Wait for the loop to consume the event and dispatch sendMetadata.
    await tick(50);

    expect(sendSpy).toHaveBeenCalled();
    expect(Date.now() - t0).toBeLessThan(150);

    await bridge.stop();
  });

  it('stop() aborts the controller and prevents further sendMetadata calls', async () => {
    const { control, stream } = makeControllableStream();
    const engineClient = makeEngineClient({
      streamContainerEvents: vi.fn(stream) as never,
    });

    const { bridge } = createBridge(engineClient);
    await bridge.start();
    await tick();

    expect(control.capturedSignals.length).toBeGreaterThan(0);
    expect(control.capturedSignals[0]?.aborted).toBe(false);

    await bridge.stop();

    expect(control.capturedSignals[0]?.aborted).toBe(true);

    // Spy after stop to confirm no further sends.
    const sendSpy = vi.spyOn(bridge, 'sendMetadata');
    control.yield({
      Type: 'container',
      Action: 'die',
      id: 'c-late',
      Actor: { ID: 'c-late', Attributes: {} },
    });
    await tick(20);
    expect(sendSpy).not.toHaveBeenCalled();
  });
});

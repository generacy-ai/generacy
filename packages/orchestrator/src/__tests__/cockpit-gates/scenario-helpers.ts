/**
 * Per-scenario wire-up for the cockpit gates integration harness (#1024).
 *
 * Composes the REAL cluster-side gate surface end-to-end, no cloud, no live
 * GitHub, no smee (FR-002, FR-010):
 *
 *   1. A per-scenario temp dir with `COCKPIT_ANSWERS_FILE` pointing into it,
 *      so the real answers-file writer and the doorbell tail an isolated file
 *      (spec Assumption §100, seam S-1/S-5).
 *   2. A fake relay peer (`ws` WebSocketServer) on a random port that plays the
 *      role of the generacy-cloud relay ingress.
 *   3. A light in-process orchestrator that wires the REAL gate modules —
 *      `setupCockpitGatesRoute`, `setupCockpitAnswersRoute`, the real
 *      `CockpitAnswersWriter`, and the real `createRetainedCockpitEvents`
 *      retainer — onto a bare Fastify instance (plan D-1 "lighter fixture that
 *      only wires the gate routes"; the full `createServer` boot pulls in
 *      redis/workflow/smee that this harness does not exercise).
 *   4. A REAL `ClusterRelayClient` (`@generacy-ai/cluster-relay`) pointed at the
 *      fake peer's `ws://` url — the same client the orchestrator uses in
 *      production, so the outbound `cluster.cockpit` framing and the inbound
 *      `api_request` proxy path are exercised for real (plan D-3). The
 *      `retainer.drainInto(client)` replay on (re)connect mirrors
 *      `RelayBridge.handleConnected()`.
 *   5. (optionally) A REAL doorbell child process spawned in hermetic mode
 *      (`COCKPIT_DOORBELL_HARNESS=1`) that tails the answers file — clarification
 *      Q3 → C requires a real `spawn()`/kill so FR-007's restart-replay is
 *      genuine.
 *
 * **On the `cockpit_await_events` / in-process MCP bus (assertion primitive #5):**
 * the bus registry lives in `@generacy-ai/generacy`, which depends on
 * `@generacy-ai/orchestrator` (`workspace:*`). Importing it here would close a
 * build cycle, so the harness cannot drain the bus in-process. The doorbell
 * emits every `gate-answer` to BOTH its stdout NDJSON AND its in-process
 * `EpicEventBus` from the same object (`doorbell.ts` `answersOnEvent`), so the
 * doorbell's parsed stdout stream (`ctx.doorbell.events`) is the byte-identical,
 * cross-process-observable surface the bus would hold. Scenarios assert on it.
 *
 * See `specs/1024-part-cockpit-remote-gates/data-model.md` §"ScenarioContext".
 */
import type { AddressInfo } from 'node:net';
import type http from 'node:http';
import type https from 'node:https';
import { Readable } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { URL } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import { ClusterRelayClient } from '@generacy-ai/cluster-relay';
import { DEFAULT_WIRE_EPIC_REF, type GateType } from '@generacy-ai/cockpit';
import type { ClusterRelayClient as ClusterRelayClientType } from '../../types/relay.js';
import { setupCockpitGatesRoute } from '../../routes/cockpit-gates.js';
import { setupCockpitAnswersRoute } from '../../routes/cockpit-answers.js';
import { createRetainedCockpitEvents } from '../../routes/retained-cockpit-events.js';
import { CockpitAnswersWriter } from '../../services/cockpit-answers-writer.js';
import {
  createCloudGateQueryClient,
  type HttpsRequestImpl,
} from '../../services/cloud-gate-query-client.js';
import { startFakePeer, type FakePeer } from './fake-peer.js';
import {
  createDoorbellDriver,
  type DoorbellDriver,
  type DoorbellDriverOptions,
} from './doorbell-driver.js';
import {
  createFakeCloudStore,
  type FakeCloudStore,
  type FakeCloudStoreOptions,
} from './fake-cloud-store.js';
import { createMcpToolDriver, type McpToolDriver } from './mcp-tool-driver.js';

/** Epic ref the harness binds the doorbell + answer scope to. Matches
 *  `DEFAULT_WIRE_SCOPE` in `@generacy-ai/cockpit` so `answerLineFixture()`
 *  scope passes the doorbell's epic-scope filter. */
export const HARNESS_EPIC_REF = DEFAULT_WIRE_EPIC_REF;

const SILENT_LOGGER = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

/**
 * #1068 — replacement for `SILENT_LOGGER` that captures structured log calls
 * for later assertion. Used by `startFakeCloud` scenarios to prove:
 *   - FR-004: exactly one `'cockpit gate emitted'` info per gateId.
 *   - FR-007: zero warns containing `'Invalid relay message, skipping'`.
 */
export interface CountingLogger {
  info(msg: string): void;
  info(obj: Record<string, unknown>, msg: string): void;
  warn(msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
  debug(msg: string): void;
  debug(obj: Record<string, unknown>, msg: string): void;
  readonly records: ReadonlyArray<{
    level: 'info' | 'warn' | 'error' | 'debug';
    obj?: Record<string, unknown>;
    msg: string;
  }>;
}

function createCountingLogger(): CountingLogger {
  const records: Array<{
    level: 'info' | 'warn' | 'error' | 'debug';
    obj?: Record<string, unknown>;
    msg: string;
  }> = [];
  const capture = (level: 'info' | 'warn' | 'error' | 'debug') =>
    ((...args: [Record<string, unknown> | string, string?]) => {
      const [first, second] = args;
      if (typeof first === 'string') {
        records.push({ level, msg: first });
      } else {
        records.push({ level, obj: first, msg: second ?? '' });
      }
    }) as CountingLogger[typeof level];
  return {
    info: capture('info'),
    warn: capture('warn'),
    error: capture('error'),
    debug: capture('debug'),
    records,
  } as CountingLogger;
}

/**
 * #1068 — Extract `'cockpit gate emitted'` info lines from a CountingLogger's
 * records. Each line's `obj` carries `{ gateId, type }` per
 * `routes/cockpit-gates.ts:190-193`.
 */
function selectGateEmittedLines(
  logger: CountingLogger,
): Array<{ gateId: string; type: string }> {
  const result: Array<{ gateId: string; type: string }> = [];
  for (const r of logger.records) {
    if (r.level !== 'info') continue;
    if (r.msg !== 'cockpit gate emitted') continue;
    const obj = r.obj as { gateId?: unknown; type?: unknown } | undefined;
    if (obj == null || typeof obj.gateId !== 'string' || typeof obj.type !== 'string') continue;
    result.push({ gateId: obj.gateId, type: obj.type });
  }
  return result;
}

/**
 * #1068 — Build an `httpRequestImpl`-shaped shim that services
 * `GET /api/clusters/<clusterId>/cockpit/gates?...` from a `FakeCloudStore`,
 * exactly matching the URL shape that `cloud-gate-query-client.ts:200-219`
 * emits.
 *
 * Two response modes:
 *   - status mode (`generation` present) → `{ gateId, status }` or `{ gateId: null, status: null }`.
 *   - list mode   (`generation` absent)  → `{ gates: [{ gateId, gateType, generation, status }] }`.
 *
 * Pre-Phase-A docs (`generation === undefined`) surface in list mode as
 * `generation: '<pre-phase-a>'` sentinel per contracts/fake-cloud-store.md.
 */
function buildFakeCloudHttpImpl(
  fakeCloud: FakeCloudStore,
): HttpsRequestImpl {
  const impl: HttpsRequestImpl = (options, callback) => {
    const method = ((options as { method?: string }).method ?? 'GET').toUpperCase();
    const path = (options as { path?: string }).path ?? '/';
    const parsed = new URL(path, 'http://fake');

    // Fake IncomingMessage — Readable subclass with `statusCode` glued on.
    // Client at cloud-gate-query-client.ts:243 does `chunks.push(c as Buffer)`
    // then `Buffer.concat(chunks)`, so the stream MUST emit Buffer chunks.
    const respond = (statusCode: number, body: unknown): void => {
      const stream = Readable.from([Buffer.from(JSON.stringify(body), 'utf8')]);
      (stream as unknown as { statusCode: number }).statusCode = statusCode;
      if (typeof callback === 'function') {
        // Defer so caller-side listener wiring (which happens after
        // `httpRequestImpl(...)` returns) is in place.
        setImmediate(() => callback(stream as unknown as http.IncomingMessage));
      }
    };

    // Minimal ClientRequest stub — `.on('error', ...)` and `.end()` are what
    // `performGet` uses; wire them as no-ops so error listeners never fire on
    // the happy path.
    const req = {
      on: (_evt: string, _listener: (...args: unknown[]) => void) => req,
      end: () => undefined,
      write: (_chunk: unknown) => undefined,
    } as unknown as http.ClientRequest;

    if (method !== 'GET') {
      respond(405, { error: 'method-not-allowed' });
      return req;
    }
    if (!parsed.pathname.startsWith('/api/clusters/') || !parsed.pathname.endsWith('/cockpit/gates')) {
      respond(404, { error: 'not-found' });
      return req;
    }
    const issueRef = parsed.searchParams.get('issueRef');
    if (issueRef == null || issueRef.length === 0) {
      respond(400, { error: 'missing issueRef' });
      return req;
    }
    const gateType = parsed.searchParams.get('gateType') as GateType | null;
    const generation = parsed.searchParams.get('generation');
    const runId = parsed.searchParams.get('runId') ?? undefined;

    if (generation != null) {
      // status mode
      if (gateType == null) {
        respond(400, { error: 'gateType is required when generation is present' });
        return req;
      }
      const doc = fakeCloud.getByKey(issueRef, gateType, generation, runId);
      if (doc == null) {
        respond(200, { gateId: null, status: null });
        return req;
      }
      respond(200, { gateId: doc.gateId, status: doc.status });
      return req;
    }

    // list mode
    const docs = fakeCloud.listByIssueRef(issueRef, gateType ?? undefined);
    const gates = docs.map((doc) => ({
      gateId: doc.gateId,
      gateType: doc.gateType,
      generation: doc.generation ?? '<pre-phase-a>',
      status: doc.status,
    }));
    respond(200, { gates });
    return req;
  };
  return impl;
}

export interface ScenarioContext {
  peer: FakePeer;
  /** Real doorbell child driver. `null` unless the scenario opted in via
   *  `startDoorbell` / a `doorbellDriverOptions` override. */
  doorbell: DoorbellDriver | null;
  /** Bare Fastify instance wired with the real gate + answers routes. */
  orchestrator: FastifyInstance;
  /** Real relay client connected to the fake peer. */
  relayClient: ClusterRelayClientType;
  answersFilePath: string;
  tempDir: string;
  /** `http://127.0.0.1:<port>` — the light orchestrator's HTTP base. */
  orchestratorUrl: string;
  /** Epic ref the doorbell is bound to (`HARNESS_EPIC_REF`). */
  epicRef: string;
  /** #1068 — in-memory fake cloud, set when `setupScenario({ startFakeCloud: true })`. */
  fakeCloud: FakeCloudStore | null;
  /** #1068 — direct-import MCP tool driver, set when `startFakeCloud: true`. */
  mcp: McpToolDriver | null;
  /** #1068 — captured `'cockpit gate emitted'` log lines from the light orchestrator (FR-004). */
  gateEmittedLogLines: ReadonlyArray<{ gateId: string; type: string }>;
  /** #1068 — the full log record buffer from the light orchestrator (FR-007). */
  loggerRecords: CountingLogger['records'];
  cleanup: () => Promise<void>;
}

export interface ScenarioSetupOptions {
  /** Spawn the real hermetic doorbell child bound to `HARNESS_EPIC_REF`.
   *  Default false (many scenarios only assert the relay path). */
  startDoorbell?: boolean;
  /** Override the doorbell driver options (e.g. `spawnArgv` for a synthetic
   *  child during harness plumbing self-tests). Implies `startDoorbell`. */
  doorbellDriverOptions?: Partial<DoorbellDriverOptions>;
  /** Base reconnect delay for the relay client (ms). Small so S1b's
   *  disconnect→reconnect completes quickly. Default 200. */
  relayReconnectMs?: number;
  /**
   * #1068 — wire an in-memory `FakeCloudStore` into the fake-peer's payload
   * validator and build a fake HTTP shim that `CloudGateQueryClient` reaches
   * for `GET /cockpit/gates`. Also swaps `SILENT_LOGGER` for a `CountingLogger`
   * and constructs a direct-import `McpToolDriver`.
   * Default: false (existing sibling scenarios keep today's shape).
   */
  startFakeCloud?: boolean;
  /**
   * #1068 — options passed to `createFakeCloudStore`. `persistGeneration: false`
   * simulates a Phase-A revert (cloud does not persist `generation`).
   */
  fakeCloudOptions?: FakeCloudStoreOptions;
}

const CONNECT_TIMEOUT_MS = 5000;
const CONNECT_POLL_MS = 20;

async function waitUntil(
  predicate: () => boolean,
  timeoutMs: number,
  onTimeout: () => string,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(onTimeout());
    await new Promise((r) => setTimeout(r, CONNECT_POLL_MS));
  }
}

/**
 * Spin up a fresh scenario context. Call `cleanup()` in `afterEach`; safe to
 * call multiple times.
 */
export async function setupScenario(
  opts: ScenarioSetupOptions = {},
): Promise<ScenarioContext> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'cockpit-gates-1024-'));
  const answersFilePath = path.join(tempDir, 'answers.ndjson');
  const epicRef = HARNESS_EPIC_REF;

  // Redirect the writer's answers file into the temp dir. Set before the
  // writer is constructed. Restored in cleanup.
  const previousAnswersFileEnv = process.env['COCKPIT_ANSWERS_FILE'];
  process.env['COCKPIT_ANSWERS_FILE'] = answersFilePath;

  // --- #1068: fake cloud store + logger. Constructed before the peer so the
  //     peer's `onValidatedFrame` callback can route into the store on receipt.
  let fakeCloud: FakeCloudStore | null = null;
  let countingLogger: CountingLogger | null = null;
  const previousApiUrlEnv = process.env['GENERACY_API_URL'];
  // Test-only side channel for runId recovery. Wire schemas strip `runId`, so
  // the fake-cloud store can't recover it from the frame alone; the driver
  // records it here on every gateOpen and the fake-peer callback consults it.
  const runIdByGateId = new Map<string, string>();
  if (opts.startFakeCloud === true) {
    fakeCloud = createFakeCloudStore(opts.fakeCloudOptions);
    countingLogger = createCountingLogger();
    // `CloudGateQueryClient.buildUrl` requires GENERACY_API_URL to be set. The
    // shim short-circuits before dialing, so any value is fine.
    process.env['GENERACY_API_URL'] = 'http://127.0.0.1:1';
  }
  const activeLogger = countingLogger ?? SILENT_LOGGER;
  const capturedFakeCloud = fakeCloud;

  const peer = await startFakePeer(
    capturedFakeCloud != null
      ? {
          onValidatedFrame: (frame) => {
            if (frame.type === 'gate-open') {
              const mapped = runIdByGateId.get(frame.data.gateId);
              // Frame.data.runId may already be present if some other test
              // path passes it explicitly; prefer that. Otherwise use the map.
              const runId = frame.data.runId ?? mapped;
              capturedFakeCloud.putGateFromWireFrame(
                runId !== undefined
                  ? { ...frame.data, runId }
                  : frame.data,
              );
            } else {
              capturedFakeCloud.applyOutcome(
                frame.data.gateId,
                frame.data.outcome,
                frame.data.detail,
              );
            }
          },
        }
      : {},
  );

  // --- Light orchestrator: real gate modules on a bare Fastify instance. ----
  const orchestrator = Fastify({ logger: false });
  const writer = new CockpitAnswersWriter({
    path: answersFilePath,
    rotationBytes: 32 * 1024 * 1024,
    rotationKeep: 3,
    logger: SILENT_LOGGER,
  });
  await writer.init();
  const retainer = createRetainedCockpitEvents({
    maxCount: 1000,
    maxBytes: 4 * 1024 * 1024,
  });

  // Deferred-binding relay-client ref, mirroring server.ts: the gate route
  // reads it lazily so a POST that arrives before the client connects retains
  // instead of dropping.
  let relayClientRef: ClusterRelayClientType | null = null;

  // #1068 — real CloudGateQueryClient backed by the fake HTTP shim over the
  // fake cloud store. Only wired when `startFakeCloud: true`.
  const cloudQueryClient = capturedFakeCloud != null
    ? createCloudGateQueryClient({
        clusterId: 'test-cluster',
        httpRequestImpl: buildFakeCloudHttpImpl(capturedFakeCloud),
        httpsRequestImpl: buildFakeCloudHttpImpl(capturedFakeCloud),
        // `apiKeyPath` — the client reads a key from disk before every call.
        // Point it at a file that exists (any file with content); its value is
        // ignored by the shim.
        apiKeyPath: '/etc/hostname',
        logger: {
          info: () => undefined,
          warn: () => undefined,
        },
      })
    : null;

  setupCockpitGatesRoute(orchestrator, {
    retainer,
    getRelayClient: () => relayClientRef,
    logger: activeLogger,
    ...(cloudQueryClient != null
      ? { getCloudGateQueryClient: () => cloudQueryClient }
      : {}),
  });
  setupCockpitAnswersRoute(orchestrator, { writer, logger: SILENT_LOGGER });

  await orchestrator.listen({ port: 0, host: '127.0.0.1' });
  const address = orchestrator.server.address() as AddressInfo | string | null;
  if (address == null || typeof address === 'string') {
    throw new Error(
      `[scenario-helpers] unexpected server.address(): ${JSON.stringify(address)}`,
    );
  }
  const orchestratorUrl = `http://127.0.0.1:${address.port}`;

  // --- Real relay client → fake peer. --------------------------------------
  const relayClient = new ClusterRelayClient(
    {
      apiKey: 'test-cluster-key',
      cloudUrl: peer.url,
      orchestratorUrl,
      orchestratorApiKey: 'test-orchestrator-key',
      baseReconnectDelayMs: opts.relayReconnectMs ?? 200,
      routes: [],
    },
    SILENT_LOGGER,
  ) as unknown as ClusterRelayClientType;
  relayClientRef = relayClient;

  // Replay retained cluster.cockpit events on every (re)connect — mirrors
  // RelayBridge.handleConnected() → drainRetainedCockpitEvents() (FR-004).
  (relayClient as unknown as {
    on: (event: string, handler: () => void) => void;
  }).on('connected', () => {
    retainer.drainInto(relayClient);
  });

  // connect() runs an internal reconnect loop that only resolves on
  // disconnect(), so kick it off fire-and-forget and poll isConnected.
  void (relayClient as unknown as { connect: () => Promise<void> }).connect();
  await waitUntil(
    () => relayClient.isConnected,
    CONNECT_TIMEOUT_MS,
    () => `[scenario-helpers] relay client did not connect to fake peer within ${CONNECT_TIMEOUT_MS}ms`,
  );

  // --- Optional real doorbell child. ---------------------------------------
  let doorbell: DoorbellDriver | null = null;
  const wantsDoorbell =
    opts.startDoorbell === true || opts.doorbellDriverOptions != null;
  if (wantsDoorbell) {
    const driverOptions: DoorbellDriverOptions = {
      answersFilePath,
      env: {
        COCKPIT_ANSWERS_FILE: answersFilePath,
        COCKPIT_DOORBELL_HARNESS: '1',
      },
      extraArgs: [epicRef],
      ...(opts.doorbellDriverOptions ?? {}),
    };
    doorbell = createDoorbellDriver(driverOptions);
    await doorbell.start();
  }

  // #1068 — build the direct-import MCP driver against the light orchestrator.
  const mcp = capturedFakeCloud != null
    ? createMcpToolDriver({
        baseUrl: orchestratorUrl,
        fetchImpl: fetch,
        runIdByGateId,
      })
    : null;

  let cleanedUp = false;
  const cleanup = async (): Promise<void> => {
    if (cleanedUp) return;
    cleanedUp = true;
    if (doorbell != null) {
      try {
        await doorbell.stop(1500);
      } catch {
        /* best-effort */
      }
    }
    try {
      await (relayClient as unknown as { disconnect: () => Promise<void> }).disconnect();
    } catch {
      /* best-effort */
    }
    try {
      await orchestrator.close();
    } catch {
      /* best-effort */
    }
    try {
      await writer.close();
    } catch {
      /* best-effort */
    }
    try {
      await peer.close();
    } catch {
      /* best-effort */
    }
    try {
      await rm(tempDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
    if (previousAnswersFileEnv == null) {
      delete process.env['COCKPIT_ANSWERS_FILE'];
    } else {
      process.env['COCKPIT_ANSWERS_FILE'] = previousAnswersFileEnv;
    }
    if (opts.startFakeCloud === true) {
      if (previousApiUrlEnv == null) {
        delete process.env['GENERACY_API_URL'];
      } else {
        process.env['GENERACY_API_URL'] = previousApiUrlEnv;
      }
    }
  };

  return {
    peer,
    doorbell,
    orchestrator,
    relayClient,
    answersFilePath,
    tempDir,
    orchestratorUrl,
    epicRef,
    fakeCloud,
    mcp,
    // Getter: `gateEmittedLogLines` reflects the CURRENT state of the logger
    // buffer at each read. Scenarios can `expect(ctx.gateEmittedLogLines)` at
    // any point and see all lines captured up to that moment.
    get gateEmittedLogLines() {
      return countingLogger != null ? selectGateEmittedLines(countingLogger) : [];
    },
    get loggerRecords() {
      return countingLogger != null ? countingLogger.records : [];
    },
    cleanup,
  } as ScenarioContext;
}

/**
 * Poll a predicate until true or timeout. Small helper for scenario bodies
 * that wait on a file/stdout side effect the fixtures do not expose a
 * dedicated waiter for (e.g. "exactly N lines in the answers file").
 */
export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
  message = 'waitFor timed out',
): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await predicate()) return;
    if (Date.now() - start > timeoutMs) throw new Error(message);
    await new Promise((r) => setTimeout(r, 25));
  }
}

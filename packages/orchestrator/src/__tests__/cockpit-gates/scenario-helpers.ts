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
import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { ClusterRelayClient } from '@generacy-ai/cluster-relay';
import { DEFAULT_WIRE_EPIC_REF } from '@generacy-ai/cockpit';
import type { ClusterRelayClient as ClusterRelayClientType } from '../../types/relay.js';
import { setupCockpitGatesRoute } from '../../routes/cockpit-gates.js';
import { GateStatusQueryService } from '../../services/gate-status-query.js';
import { setupCockpitAnswersRoute } from '../../routes/cockpit-answers.js';
import { createRetainedCockpitEvents } from '../../routes/retained-cockpit-events.js';
import { CockpitAnswersWriter } from '../../services/cockpit-answers-writer.js';
import { startFakePeer, type FakePeer } from './fake-peer.js';
import {
  createDoorbellDriver,
  type DoorbellDriver,
  type DoorbellDriverOptions,
} from './doorbell-driver.js';

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

  const peer = await startFakePeer();

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

  // #1038 — read-only gate-status query service. Wired into the relay client's
  // inbound message stream below so gate_query_response frames route back to
  // the pending promise.
  const gateStatusQuery = new GateStatusQueryService({
    getRelayClient: () => relayClientRef,
    logger: SILENT_LOGGER,
    perAttemptTimeoutMs: 3000,
  });

  setupCockpitGatesRoute(orchestrator, {
    retainer,
    getRelayClient: () => relayClientRef,
    logger: SILENT_LOGGER,
    getQueryService: () => gateStatusQuery,
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

  // #1038 — route gate_query_response frames to the status-query service so
  // the GET /cockpit/gates handler's awaits resolve. Same seam
  // initializeRelayBridge uses in production.
  (relayClient as unknown as {
    on: (event: string, handler: (msg: { type: string }) => void) => void;
  }).on('message', (msg) => {
    if (msg.type === 'gate_query_response') {
      gateStatusQuery.onRelayMessage(msg as unknown as Parameters<typeof gateStatusQuery.onRelayMessage>[0]);
    }
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
    cleanup,
  };
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

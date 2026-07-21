# Data Model — Cockpit gates integration harness (#1024)

The harness does not introduce persistent entities. It composes existing types from four sources (`packages/cockpit/src/gates/`, `packages/cluster-relay`, `packages/orchestrator/src/routes/`, and its own helper modules). This document catalogs the runtime-only types the harness itself defines and pins the imported shapes it depends on.

## Imported types (pinned dependencies)

### From `@generacy-ai/cockpit/gates` (sibling #1020 — pinned)

Contract shapes exported by #1020. This harness treats them as authoritative and does not re-declare them.

- `GateOpen` — up-path payload for `POST /cockpit/gates`. Fields per epic plan §"Gate record": `gateId`, `gateKey`, `gateType`, `epicRef`, `issueRef`, `issueTitle`, `issueUrl`, `branch?`, `prNumber?`, `title`, `body`, `options[]`, `allowFreeText`, `sessionId`, `askedAt`.
- `GateAnswer` — down-path NDJSON line body for `POST /cockpit/answers`. Fields: `type: 'gate-answer'`, `gateId`, `gateKey`, `optionId?`, `freeText?`, `actor: { userId, email, displayName }`, `answeredAt`, `deliveryId`.
- `GateOutcome` — up-path ack body for `POST /cockpit/gates/:id/ack`. Fields: `gateId`, `outcome: 'applied' | 'superseded' | 'failed'`, `detail?`, `at`.
- `GateType` — union of the 8 gate types (`clarification | artifact-review | implementation-review | manual-validation | escalation | phase-queue | filing | scope-drained`).
- Zod schemas: `GateOpenSchema`, `GateAnswerSchema`, `GateOutcomeSchema` — used in harness assertions to validate wire messages.
- Fixture builders: `gateOpenFixture()`, `answerLineFixture()`, `outcomeAckFixture()` — return fully-populated contract objects with sensible defaults + `overrides` argument.
- `computeGateId({ owner, repo, issue, gateType, generation })` — sha256, hex, first 24 chars. Used to assert `gateId` derivation in scenarios that vary generation.

### From `@generacy-ai/cluster-relay` (existing)

- `RelayMessage` — discriminated union covering all inbound/outbound relay frames. Harness's fake peer parses inbound messages with `RelayMessageSchema.safeParse`.
- `EventMessage` — `{ type: 'event', event: string, data: unknown, timestamp: string }`. Fake peer records these with `event === 'cluster.cockpit'` into `received.events`.
- `ApiRequestMessage` — `{ type: 'api_request', correlationId, method, path, body?, headers?, actor? }`. Fake peer emits these to inject cloud→cluster requests.
- `ApiResponseMessage` — `{ type: 'api_response', correlationId, status, body?, headers? }`. Fake peer collects these to correlate against emitted `api_request`s.
- `HandshakeMessage`, `HeartbeatMessage` — used by fake peer to advance the client's state machine to `connected`.

### From `packages/orchestrator/src/` (existing)

- `createServer(config)` — factory for the orchestrator Fastify app + relay bridge. Harness invokes with a test-mode config: `relay.relayUrl = ws://127.0.0.1:<peer-port>`, `relay.apiKey = 'test-key'`, `activation.cloudUrl` unset (activation skipped for tests), and any answers-file path env override.
- `ClusterRelayClient` interface (`packages/orchestrator/src/types/relay.ts`) — used only for typing; harness does not implement it (real `ClusterRelay` runs against the fake peer).

## Harness-defined types

Runtime-only types the harness declares in its helper modules. Not exported outside `packages/orchestrator/src/__tests__/cockpit-gates/`.

### `FakePeer`

Exported by `cockpit-gates/fake-peer.ts`.

```ts
export interface FakePeerOptions {
  /** WebSocket port; default 0 (random). */
  port?: number;
  /** Fake responder for api_request frames the peer sends TO the cluster.
   *  Default: no responder (peer only sends api_requests and awaits ApiResponseMessage
   *  frames back from the real orchestrator). */
  apiRequestHandler?: (req: ApiRequestMessage) => Promise<Partial<ApiResponseMessage>>;
  /** Optional pre-connect delay for testing reconnect windows. */
  connectDelayMs?: number;
}

export interface FakePeer {
  /** ws://127.0.0.1:<port> — pass to orchestrator config.relay.relayUrl. */
  readonly url: string;

  /** Cumulative record of everything received across all connections. */
  readonly received: {
    events: EventMessage[];       // filtered to type === 'event'
    apiResponses: ApiResponseMessage[]; // filtered to type === 'api_response'
    handshakes: HandshakeMessage[]; // for FR-004 reconnect assertions
  };

  /** Wait until an event on the named channel arrives (or timeout).
   *  Optional matcher narrows further (e.g. by gateId). */
  waitForEvent(
    channel: string,
    matcher?: (data: unknown) => boolean,
    timeoutMs?: number,
  ): Promise<EventMessage>;

  /** Send an api_request to the currently connected cluster client.
   *  Resolves with the matching api_response frame (correlated on correlationId). */
  sendApiRequest(
    method: string,
    path: string,
    body: unknown,
    timeoutMs?: number,
  ): Promise<ApiResponseMessage>;

  /** Force-drop all currently connected clients (FR-004 disconnect scenario). */
  disconnectAllClients(): Promise<void>;

  /** Await the next new client connection (FR-004 reconnect assertion). */
  waitForReconnect(timeoutMs?: number): Promise<void>;

  /** Clean shutdown of the ws server. */
  close(): Promise<void>;
}
```

**Validation rules**:
- All inbound frames must pass `RelayMessageSchema.safeParse`. Frames that fail are logged and dropped (no crash).
- `waitForEvent` polls at 20 ms intervals with a default 5 s timeout; matches the sibling `waitFor()` in `packages/cluster-relay/tests/relay.test.ts`.
- `sendApiRequest` correlates the outbound frame's `correlationId` (uuidv4) against inbound `api_response` frames; unmatched responses after `timeoutMs` reject.

### `DoorbellDriver`

Exported by `cockpit-gates/doorbell-driver.ts`.

```ts
export interface DoorbellDriverOptions {
  /** Absolute path to the answers-file the doorbell should tail. */
  answersFilePath: string;
  /** Additional env vars for the child process. */
  env?: NodeJS.ProcessEnv;
  /** Extra CLI flags for `generacy cockpit doorbell`. */
  extraArgs?: string[];
  /** Node binary; default process.execPath. */
  nodeBin?: string;
  /** Path to the built generacy bin; default 'packages/generacy/dist/bin/generacy.js'. */
  generacyBin?: string;
}

export interface DoorbellDriver {
  /** Every NDJSON line the child has written to stdout so far, in order. */
  readonly stdoutLines: string[];

  /** Parsed events (JSON.parse) surfaced by the doorbell. */
  readonly events: Array<{ type: string; [k: string]: unknown }>;

  /** Wait until the doorbell has emitted an event matching the predicate. */
  waitForEvent(
    match: (event: { type: string; [k: string]: unknown }) => boolean,
    timeoutMs?: number,
  ): Promise<{ type: string; [k: string]: unknown }>;

  /** Send SIGTERM, await exit. */
  stop(timeoutMs?: number): Promise<void>;

  /** Start (or restart) the child process. Idempotent when already stopped. */
  start(): Promise<void>;

  /** Combined stop + start with the SAME env, for the FR-007 restart scenario. */
  restart(timeoutMs?: number): Promise<void>;
}

export function createDoorbellDriver(opts: DoorbellDriverOptions): DoorbellDriver;
```

**Validation rules**:
- `start()` throws if the child exits with a non-zero code before yielding its first stdout line (a smoke-test guard against bin misconfiguration).
- Stdout is line-buffered (split on `\n`); partial lines held until `\n` arrives (avoids fragment parse errors).
- Non-JSON stdout lines are pushed to `stdoutLines` unchanged but not added to `events` — the harness can inspect `stdoutLines` for logs/warnings when a test asserts non-event output (FR-013 malformed-line scenario).

### `ScenarioContext`

Exported by `cockpit-gates/scenario-helpers.ts` — the shared per-test wire-up.

```ts
export interface ScenarioContext {
  peer: FakePeer;
  doorbell: DoorbellDriver;
  orchestrator: FastifyInstance;
  answersFilePath: string;
  tempDir: string;
  orchestratorUrl: string; // http://127.0.0.1:<port> for direct POST /cockpit/gates
  cleanup: () => Promise<void>;
}

export interface ScenarioSetupOptions {
  /** Delay orchestrator connect until after the peer is ready. Default true. */
  waitForPeerConnect?: boolean;
  /** Extra orchestrator config overrides. */
  orchestratorConfig?: Partial<OrchestratorConfig>;
}

export function setupScenario(opts?: ScenarioSetupOptions): Promise<ScenarioContext>;
```

**Lifecycle**:
1. `mkdtemp` → set `COCKPIT_ANSWERS_FILE`.
2. `startFakePeer()` → get `peer.url`.
3. `createServer({ relay: { relayUrl: peer.url, apiKey: 'test-key', ... }, ... })` → boot orchestrator.
4. Wait for the peer to see the handshake (`waitForReconnect` semantics for initial connect).
5. `createDoorbellDriver({ answersFilePath }).start()` → doorbell child.
6. Return `ScenarioContext` with a `cleanup()` that stops the doorbell, closes orchestrator, closes peer, rm temp dir — safe to call more than once.

## Scenario→FR mapping

Documented for reviewer traceability (SC-002).

| Scenario | Spec section | FRs | Uses |
|----------|--------------|-----|------|
| S1a: Gate open → cluster.cockpit event | Scope §1 | FR-003 | `gateOpenFixture`, `peer.waitForEvent('cluster.cockpit')` |
| S1b: Retain-and-replay across disconnect | Scope §1 (parenthetical) | FR-004 | `peer.disconnectAllClients` + `waitForReconnect` |
| S2: Answer → answers-file + doorbell + bus | Scope §2 | FR-005 | `peer.sendApiRequest('POST', '/cockpit/answers', answerLineFixture)` |
| S3: Ack → outcome relay event | Scope §3 | FR-006 | `outcomeAckFixture`, `peer.waitForEvent('cluster.cockpit')` |
| S4: Restart replay of unacked answers | Scope §4 | FR-007 | `doorbell.restart()` — assert **one** re-emit per unacked deliveryId |
| S5: `deliveryId` dedup end-to-end | Scope §5 | FR-008 | Two `sendApiRequest`s with same `deliveryId` — assert **one** file line + **one** bus/stdout entry |
| F1: Malformed answer NDJSON line | FR-013 | FR-013 | Append raw garbage to `answersFilePath` mid-run — assert doorbell alive + subsequent lines still surface |
| F2: Invalid gate-open body → 4xx + no event | FR-014 | FR-014 | Direct `fetch(orchestratorUrl + '/cockpit/gates', invalidBody)` — assert 4xx + no `cluster.cockpit` event |
| F3: Answers-file rotation | FR-015 | FR-015 | `rename(answersFilePath, answersFilePath + '.1')` + `writeFile(answersFilePath, '')` — assert pending unacked lines still surface |

8 scenarios total (5 in Scope §1–5, split as 6 assertion-blocks because Scope §1 has two sub-scenarios; plus F1, F2, F3 from FR-013–FR-015). Matches SC-002 target ("8 / 8 scenarios asserted").

## Relationships

```
FakePeer ──speaks──> RelayMessage frames ──over──> WebSocket ──to──> orchestrator's ClusterRelay
  │
  └── records ──> received.events (cluster.cockpit gate-open + outcome-ack)
             └──> received.apiResponses (for its own api_requests)

DoorbellDriver ──spawns──> `generacy cockpit doorbell` child ──tails──> COCKPIT_ANSWERS_FILE
  │
  └── captures ──> stdoutLines (gate-answer NDJSON emissions)

ScenarioContext ──owns──> { peer, doorbell, orchestrator, tempDir }
  │
  └── cleanup ──> stop doorbell + close orchestrator + close peer + rm tempDir
```

## Non-persistent state (deliberate)

- The harness holds **no** persistent state across test runs. Every scenario gets a fresh temp dir, fresh WS port, fresh orchestrator, fresh doorbell child. No global registries, no shared module-level state.
- The orchestrator's own module-level state (`retainedTunnelEvent`, MCP event-bus registry singletons) is reset via `beforeEach` — either by clearing (`clearRetainedTunnelEvent()`) or by respecting the fact that `createServer()` is called fresh per scenario.

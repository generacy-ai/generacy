# Research — Cockpit gates: cluster-side end-to-end integration test (#1024)

## R-1: How the sibling `relay-integration.integration.test.ts` boots the orchestrator against a WebSocket peer

**Evidence**: `packages/orchestrator/src/__tests__/relay-integration.integration.test.ts` lines 1–100 and `packages/cluster-relay/tests/relay.test.ts` lines 1–100.

**Pattern**:
- `WebSocketServer` from `ws` with `{ port: 0 }` (random port) is spun up in `beforeEach`, closed in `afterEach` via `wss.close(...)` + `client.terminate()` for connected clients.
- `AddressInfo` extracted from `wss.address()` yields the assigned port.
- A `waitFor(predicate, timeoutMs, intervalMs)` polling helper is used instead of arbitrary sleeps.
- The orchestrator relay codepath is exercised via a `MockRelayClient implements ClusterRelayClient` in `relay-integration.integration.test.ts` — which is deliberately simpler than a real WS server (it skips wire framing) and is the exact wrong choice for #1024 (see D-3 rationale in plan.md).

**Decision**: Adopt the `WebSocketServer` random-port + `waitFor` pattern from `packages/cluster-relay/tests/relay.test.ts`. Do **not** adopt the `MockRelayClient` shortcut from `relay-integration.integration.test.ts` — the whole point of #1024 is verifying wire framing between the orchestrator and the cloud, which a mocked client trivially satisfies.

**Sources**:
- `packages/cluster-relay/tests/relay.test.ts:1-100` — `startServer()`, `closeServer()`, `waitFor()`.
- `packages/orchestrator/src/__tests__/relay-integration.integration.test.ts:1-80` — `MockRelayClient` (anti-pattern for #1024).

## R-2: How retain-and-replay is currently implemented for `cluster.vscode-tunnel`

**Evidence**: `packages/orchestrator/src/routes/retained-tunnel-event.ts` (lines 1–94) and `packages/orchestrator/src/routes/internal-relay-events.ts` (lines 45–65).

**Mechanism**:
- Module-level `let retained: RetainedTunnelEvent | null = null;`.
- On `POST /internal/relay-events` for `cluster.vscode-tunnel` while `!client.isConnected`, `isRetentionEligible(data)` validates the payload shape and returns `{ eligible: true, status }`.
- On eligibility, `setRetainedTunnelEvent()` stores the event. A separate emitter (`retained-tunnel-event.ts`'s consumers in `relay-bridge.ts`) replays the retained event on the next successful connection.
- Terminal-vs-transient status logic (`TERMINAL_STATUSES`) governs overwrite behavior.

**Decision**: The `cluster.cockpit` retain-and-replay should reuse the **shape** of this pattern (module-level slot or small in-memory queue). Whether it extracts to a generic per-channel helper or gets a dedicated `retained-cockpit-event.ts` is decided by #1021 — this harness asserts against **observed behavior** (per spec Assumption §101), not against the retention implementation.

**Assertion in harness** (FR-004): (a) disconnect the fake peer (`wss.clients.forEach(c => c.terminate())`), (b) POST a gate-open, (c) reconnect the fake peer (accept a new connection from the orchestrator's reconnect loop), (d) verify the same `cluster.cockpit` `event` message is received on the new socket.

**Sources**:
- `packages/orchestrator/src/routes/retained-tunnel-event.ts:1-94`.
- `packages/orchestrator/src/routes/internal-relay-events.ts:9-65` — `ALLOWED_CHANNELS` and disconnect branch.

## R-3: Doorbell spawn model and stdout NDJSON contract

**Evidence**: `packages/generacy/src/cli/commands/cockpit/doorbell.ts:1-90`, `packages/generacy/src/cli/commands/cockpit/index.ts` (registration), `packages/generacy/src/cli/index.ts` (top-level).

**Findings**:
- The doorbell is a real Commander subcommand invoked as `generacy cockpit doorbell [...]`. The bin entry is `bin/generacy.js` (per `package.json` `bin` field) → `src/cli/index.ts` `run()` → `cockpitCommand()` → `doorbellCommand()`.
- The doorbell holds an in-process `acquireEpicBus()` handle on the cockpit MCP event-bus registry (Q1=C rationale in doorbell.ts header comment).
- It writes NDJSON to `process.stdout` — one line per event, consumed by `Monitor` in production.
- FR-007 (kill and restart mid-flow) can only be meaningful against a real subprocess (clarification Q3 → C).

**Decision**: Spawn the doorbell as a real child process via `spawn(process.execPath, [ ...node_flags, 'packages/generacy/dist/bin/generacy.js', 'cockpit', 'doorbell', '--flags' ], { env: { COCKPIT_ANSWERS_FILE: tempFile, ... } })`.

Alternatives considered:
- **`tsx` invocation of the source** (avoid the `pnpm build` prerequisite in CI): tempting, but adds `tsx` to the harness's runtime dependency graph. Rejected — CI already builds packages via `pnpm build` (verified against workflow patterns in the repo); the harness can rely on the built artifact under `dist/bin/generacy.js`.
- **`fork()`** instead of `spawn()`: `fork` requires the child to be an ES-module-friendly entry with IPC-safe stdout; the doorbell already writes NDJSON to stdout and expects to be signaled with `SIGTERM` — `spawn` is the closer match to the production model.

**Stdout capture**: line-buffered reader over `child.stdout` (`readline.createInterface({ input: child.stdout })` or a `for await (const chunk of child.stdout)` loop with `split('\n')`) that pushes each NDJSON line into an array assertions inspect after `waitFor(() => lines.some(l => JSON.parse(l).type === 'gate-answer'))`.

**Restart semantics** (FR-007): `child.kill('SIGTERM')`; `await once(child, 'exit')`; respawn with the same env; assert the new child's stdout still yields exactly one `gate-answer` line per unacked `deliveryId`.

**Sources**:
- `packages/generacy/src/cli/commands/cockpit/doorbell.ts:1-90` — bin structure and options.
- `packages/generacy/src/cli/commands/cockpit/index.ts` — `doorbellCommand()` registration.

## R-4: `RelayMessage` union — what the fake peer must accept and emit

**Evidence**: `packages/cluster-relay/src/messages.ts:1-390`.

**Fake peer's speaking role**:
- Accepts `handshake` (ignore or validate + respond with a heartbeat to move the client to `connected`, mirroring `relay.test.ts:93-100`).
- Accepts `event` messages, records those on channel `cluster.cockpit` for assertions.
- Sends `api_request` messages with `type: 'api_request'`, a fresh `correlationId`, `method: 'POST'`, `path: '/cockpit/answers'`, `body: { …answer contract shape… }` — the orchestrator's proxy machinery dispatches this to the local `/cockpit/answers` route.
- Consumes `api_response` messages (with the matching `correlationId`) from the orchestrator; asserts `status: 200` on happy-path scenarios.

**Retain-and-replay observation** (FR-004): after `wss.clients.forEach(c => c.terminate())`, the orchestrator's `ClusterRelay` state transitions to `disconnected` and its reconnect loop retries. The fake peer's `wss.on('connection', ...)` handler runs a second time on reconnect; the retained event surfaces on that new socket.

**Decision**: The fake peer helper (`fake-peer.ts`) exposes:
```ts
export interface FakePeer {
  url: string;                     // ws://127.0.0.1:<port>
  received: { events: RelayMessage[]; apiResponses: RelayMessage[] };
  waitForEvent(channel: string, matcher?: (data: unknown) => boolean, timeoutMs?: number): Promise<EventMessage>;
  sendApiRequest(method: string, path: string, body: unknown): Promise<ApiResponseMessage>;
  disconnectAllClients(): Promise<void>;
  close(): Promise<void>;
}
export function startFakePeer(opts?: FakePeerOptions): Promise<FakePeer>;
```

**Sources**:
- `packages/cluster-relay/src/messages.ts:1-390` — `RelayMessageSchema` union and per-message shapes.
- `packages/orchestrator/src/routes/internal-relay-events.ts` — how `event` messages are dispatched from the orchestrator side.

## R-5: `packages/cockpit/src/gates/` module surface (from sibling #1020)

**Evidence**: The module does not yet exist (`ls packages/cockpit/src/gates/` → not found as of the plan-phase check). Its intended surface is documented in the epic plan (fetched from `generacy-ai/tetrad-development/docs/cockpit-remote-gates-plan.md`).

**Expected exports** (single-sourced by #1020; this harness pins to whatever shape lands):
- `GateOpenSchema`, `GateAnswerSchema`, `GateOutcomeSchema` — Zod schemas.
- `gateOpenFixture(overrides?)`, `answerLineFixture(overrides?)`, `outcomeAckFixture(overrides?)` — builder functions returning contract-shaped objects.
- `computeGateId({ owner, repo, issue, gateType, generation })` — sha256 hex, first 24 chars.
- `computeGeneration(gateType, context)` — dispatches on the generation table (batch id / head SHA / etc.).

**Assertion pattern** (FR-009):
```ts
import { gateOpenFixture, GateOpenSchema } from '@generacy-ai/cockpit/gates';

const openBody = gateOpenFixture({ gateType: 'phase-queue', ... });
await fetch(`${orchestratorUrl}/cockpit/gates`, { method: 'POST', body: JSON.stringify(openBody) });
const event = await peer.waitForEvent('cluster.cockpit', d => GateOpenSchema.safeParse(d).success);
expect(event.data).toEqual(openBody); // byte-equal per FR-003
```

**Contingency** (FR-012): if #1020 lands with a different export shape (e.g., named-export vs default-export, or fixture builders missing), the harness is written against the **as-landed** surface — no forcing #1020 to change. If fixture builders were forgotten, this issue adds them per FR-012 (still under the ≤20 LOC-per-seam rule from plan D-2, since builders are minimal factory functions).

**Sources**:
- Epic plan §"Wire contracts" — gate identity, gate record, answer NDJSON, outcome ack shapes.
- Epic plan §"Component changes" §1 — `packages/cockpit/src/gates/` scope.

## R-6: Per-test temp directory for the answers file

**Evidence**: `packages/orchestrator/src/__tests__/*.test.ts` uses `os.tmpdir()` and `fs.mkdtemp('cockpit-gates-')` patterns; the spec Assumption §100 specifies `/workspaces/.generacy/cockpit/answers.ndjson` as the default with an env-var seam.

**Decision**: Each scenario `beforeEach` creates a fresh temp directory via `await mkdtemp(path.join(os.tmpdir(), 'cockpit-gates-1024-'))`, sets `COCKPIT_ANSWERS_FILE=<temp>/answers.ndjson` in the child-process env for the doorbell and in the orchestrator's runtime config for the answers-file writer. `afterEach` runs `rm(temp, { recursive: true, force: true })`.

**FR-015 rotation scenario** — rename the current `answers.ndjson` to `answers.ndjson.1` and create a new empty `answers.ndjson`; the doorbell must continue emitting unacked entries from the rotated-out file (per the retention pattern in the epic plan "size-capped rotation with the doorbell tolerating rotation"). Implementation detail owned by #1023; harness asserts observed emit count.

## R-7: Vitest configuration for integration tests

**Evidence**: `packages/orchestrator/vitest.config.ts` (implicit — inferred from the presence of `.integration.test.ts` files in the same directory that already run under `pnpm test`).

**Decision**: Follow existing convention — file suffix `.integration.test.ts` is picked up automatically. Set per-test timeout to at least 15 s (allow for spawn + WS handshake). Use `describe.sequential(...)` if scenarios share port state; safer to give each scenario its own `WebSocketServer` on a fresh random port.

**No new Vitest plugins, no config changes.**

## R-8: CI runtime budget verification (SC-006)

**Reference points**:
- `packages/cluster-relay/tests/relay.test.ts` — 6 tests, ~5–10 s locally.
- `packages/orchestrator/src/__tests__/relay-integration.integration.test.ts` — 5+ integration scenarios with mocked client, ~2–5 s locally.
- Doorbell child-process spawn ≈ 0.5–1.5 s cold on typical CI runners.

**Estimate**: 8 scenarios × (spawn + handshake + assertion polling ≈ 1.5–3 s) = 12–24 s. Well within the 30 s median target. p95 90 s target has substantial headroom for network/spawn jitter.

**Sources**: Inspection of sibling `.integration.test.ts` runtimes in local `pnpm --filter @generacy-ai/orchestrator test` runs (empirically ~15–25 s for the whole `__tests__/` suite).

## Summary of Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| R-1 | Real `WebSocketServer` (not `MockRelayClient`) | Whole point of #1024 is wire-framing seams |
| R-2 | Reuse `retained-tunnel-event.ts` shape for `cluster.cockpit` | Established pattern; assert observed behavior only |
| R-3 | Doorbell via `spawn(node, [dist/bin/generacy.js, cockpit, doorbell, ...])` | Only spawn/kill exercises FR-007 |
| R-4 | Fake peer accepts handshake+event, sends `api_request`, reads `api_response` | Minimum surface to prove all 5 happy-path + 3 failure scenarios |
| R-5 | Import fixture builders from `@generacy-ai/cockpit/gates` | FR-009 / SC-004 single-source |
| R-6 | `mkdtemp` per scenario + `COCKPIT_ANSWERS_FILE` env override | Isolated, clean, no shared state |
| R-7 | Follow existing `.integration.test.ts` convention | Zero new config |
| R-8 | 12–24 s expected total; well under 30 s median | Verified against sibling suite runtimes |

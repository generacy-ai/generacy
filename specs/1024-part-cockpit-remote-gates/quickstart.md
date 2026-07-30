# Quickstart — Cockpit gates integration harness (#1024)

**Audience**: two readers.
1. **Cluster-side sibling implementers** (P1: #1020–#1023) — run the harness locally to catch integration gaps before pushing.
2. **Cloud-side implementers** (P2 in generacy-cloud) — mirror the exact WebSocket message shapes from a fake-cluster harness on the other side of the wire.

## Running the harness locally

```bash
# From the repo root
pnpm install
pnpm --filter @generacy-ai/generacy build           # builds bin/generacy.js (doorbell spawn target)
pnpm --filter @generacy-ai/orchestrator test:integration -- cockpit-gates-integration
```

The harness lives at `packages/orchestrator/src/__tests__/cockpit-gates-integration.integration.test.ts`. It requires the built `packages/generacy/dist/bin/generacy.js` because it spawns the doorbell as a real child process (per clarification Q3 → C).

**Why `test:integration` and not `test`**: the orchestrator package's `vitest.config.ts` `exclude`s `**/*.integration.test.ts` from the default `pnpm test` run; the integration-specific config in `vitest.integration.config.ts` `include`s them with a wider 30 s timeout. CI runs both via `pnpm -r --if-present run test:integration` (`.github/workflows/ci.yml:85`).

**Current status (2026-07-21)**: all 8 scenarios are authored as `it.skip(...)` with follow-up TODOs — none of the four sibling P1 issues (#1020 contracts, #1021 orchestrator routes, #1022 MCP tools, #1023 doorbell tail) have landed yet. Running the harness above will report 8 skipped tests. As each sibling lands, its unskip PR replaces the corresponding `it.skip` with a real assertion. See `tasks.md` §"T001 audit result" for the full seam matrix.

**Node**: ≥22 (per repo constitution and `packages/generacy/package.json`).

**No external services required** — no Firebase emulators, no Docker, no live GitHub, no live smee. Everything runs against localhost.

## What the harness proves

Eight scenarios (5 happy-path + 3 targeted failure modes), each mapped 1:1 to a spec FR:

- **S1a (FR-003)** Gate open POST → `cluster.cockpit` event byte-equal to the contract.
- **S1b (FR-004)** Retain-and-replay: disconnect the peer, POST a gate, reconnect the peer → same event arrives on the new socket.
- **S2 (FR-005)** Answer down-path: peer sends `api_request POST /cockpit/answers` → file line + doorbell stdout `gate-answer` + `cockpit_await_events` batch entry.
- **S3 (FR-006)** Ack POST → outcome `cluster.cockpit` event byte-equal.
- **S4 (FR-007)** Restart replay: kill+respawn the doorbell mid-flow → unacked answers re-emit exactly once.
- **S5 (FR-008)** `deliveryId` dedup end-to-end: same delivery twice → one file line, one stdout event, one bus entry.
- **F1 (FR-013)** Malformed answer NDJSON line skipped-and-logged; doorbell keeps emitting subsequent well-formed lines.
- **F2 (FR-014)** Invalid gate-open body → 4xx, no `cluster.cockpit` event on the peer.
- **F3 (FR-015)** Answers-file rotation: pending unacked lines still surface after `rename()` + fresh file.

See `contracts/scenario-catalog.md` for the exact mapping of each scenario to the sibling issue whose 1-line breakage should surface as a failing scenario (SC-003 verification protocol).

## Mirroring the wire shapes on the cloud side (P2)

The message shapes exchanged with the fake peer are pinned by imports from `@generacy-ai/cockpit/gates` (the module #1020 owns). Do **not** copy schema literals into the P2 harness — depend on the shared module.

**Cluster → Cloud** (frames the P2 harness's fake-cluster emits and P2's real cloud ingests):

```jsonc
// Gate open
{
  "type": "event",
  "event": "cluster.cockpit",
  "timestamp": "…ISO 8601…",
  "data": { "kind": "gate-open", "gate": { /* GateOpen shape */ } }
}

// Outcome ack
{
  "type": "event",
  "event": "cluster.cockpit",
  "timestamp": "…",
  "data": { "kind": "outcome", "outcome": { /* GateOutcome shape */ } }
}
```

**Cloud → Cluster** (frame P2's fake-cluster receives and dispatches):

```jsonc
{
  "type": "api_request",
  "correlationId": "<uuid v4>",
  "method": "POST",
  "path": "/cockpit/answers",
  "headers": { "content-type": "application/json" },
  "body": { /* GateAnswer shape */ }
}
```

Response frame the P2 fake-cluster emits back:

```jsonc
{
  "type": "api_response",
  "correlationId": "<same as request>",
  "status": 200,
  "body": {}
}
```

Full protocol reference: `contracts/fake-peer-protocol.md`.

## Adding a new scenario

1. Import the contract shape from `@generacy-ai/cockpit/gates` (never inline a literal schema — SC-004 gate).
2. Add a `it(...)` block in `cockpit-gates-integration.integration.test.ts`.
3. Use the primitives listed in `contracts/scenario-catalog.md`:
   - `peer.waitForEvent(channel, matcher)` — read from the fake peer.
   - `peer.sendApiRequest(method, path, body)` — inject a cloud→cluster request.
   - `doorbell.waitForEvent(pred)` — read from the doorbell child's stdout.
   - `fetch(orchestratorUrl + path, init)` — direct HTTP against the orchestrator.
   - `awaitCockpitEvents(sinceCursor)` — drain the in-process MCP event bus.
4. Update `data-model.md`'s scenario→FR mapping table.

## Common failure signatures

**"waitForEvent on channel `cluster.cockpit` timed out"** — check `packages/orchestrator/src/routes/internal-relay-events.ts`. Is `'cluster.cockpit'` in `ALLOWED_CHANNELS`? Is the orchestrator's relay client connected to the peer (check `peer.received.handshakes.length`)?

**"Expected 1 file line, got 0"** — check `COCKPIT_ANSWERS_FILE` is being read by the answers-file writer. The env var must be set **before** the orchestrator is booted.

**"doorbell.waitForEvent timed out"** — check the doorbell's stdout in `doorbell.stdoutLines` for parse errors or unhandled exceptions. Also verify the doorbell subprocess was passed `COCKPIT_ANSWERS_FILE` in its env.

**"Expected 1 gate-answer, got 2"** (S4/S5) — the dedup layer misfired. Layer (a) failure = duplicated file line; layer (b) failure = duplicated stdout emit despite single file line. Distinguish by reading `answersFilePath` after the scenario.

**Child process exited with non-zero code before first stdout line** — the `spawn()` misconfiguration guard triggered. Check that `packages/generacy/dist/bin/generacy.js` exists (`pnpm --filter @generacy-ai/generacy build`).

## Troubleshooting: harness passes locally but fails in CI

- Check Node version on the CI runner (must be ≥22).
- CI's per-test timeout may be tighter than local; bump `vitest.testTimeout` if needed but investigate the root cause first.
- Random-port collisions are extremely unlikely with `port: 0` — but if you see `EADDRINUSE`, another test in the same run is leaking sockets. Verify every scenario `afterEach` closes the peer and the orchestrator.

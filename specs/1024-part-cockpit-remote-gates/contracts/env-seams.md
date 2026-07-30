# Contract — Env-var and config seams the harness depends on

**Purpose**: Enumerate the exact env-var / config-override surface the harness needs from siblings #1021 and #1023. If any of these are missing when this issue's PR opens, they land here under FR-012 (≤20 LOC each per plan D-2) with a linking comment to the sibling.

## Seams required from #1021 (orchestrator routes + answers-file writer)

### S-1: `COCKPIT_ANSWERS_FILE` env override

**What**: Read `process.env.COCKPIT_ANSWERS_FILE` at answers-file-writer construction time; fall back to `/workspaces/.generacy/cockpit/answers.ndjson` if unset.

**Where**: `packages/orchestrator/src/routes/answers.ts` (or wherever #1021 puts the answers-file writer).

**Consumer**: Harness sets it per-scenario via `os.tmpdir()` + `mkdtemp`.

**Rationale**: Spec Assumption §100. Without this seam, all scenarios collide on the production path and interfere with each other + the dev machine.

**Landing budget**: 2–5 LOC. Under D-2's ≤20 LOC threshold — lands here if #1021 missed it.

### S-2: `cluster.cockpit` in `ALLOWED_CHANNELS`

**What**: Add `'cluster.cockpit'` to the tuple at `packages/orchestrator/src/routes/internal-relay-events.ts:9-15`.

**Where**: That exact file, that exact tuple.

**Consumer**: Any test that POSTs an event to `/internal/relay-events` on channel `cluster.cockpit` (which the gate-open/ack handlers do internally when they emit).

**Landing budget**: 1 LOC. Definitely lands here if #1021 missed it — trivial.

### S-3: Retain-and-replay branch for `cluster.cockpit`

**What**: In `internal-relay-events.ts`'s `if (client.isConnected) { ... } else if (event === 'cluster.vscode-tunnel') { ... }` block, add a symmetric `else if (event === 'cluster.cockpit') { ... }` branch that retains the event and replays it on the next successful connection.

**Where**: `packages/orchestrator/src/routes/internal-relay-events.ts` + likely a new module `packages/orchestrator/src/routes/retained-cockpit-event.ts` mirroring `retained-tunnel-event.ts`.

**Consumer**: Scenario S1b (FR-004).

**Landing budget**: If a small copy-and-adapt (~50 LOC in a new file), this exceeds the D-2 ≤20 LOC threshold and should land in #1021, not here. If #1021 already implemented retention but forgot to hook it into the else-if chain, the ≤20 LOC hookup lands here.

**Contingency**: If #1021 landed without any retain-and-replay for `cluster.cockpit`, S1b is skipped in this PR with a `.skip()` and a linking comment to a filed follow-up issue. The harness's other 7 scenarios still ship, and SC-002 is satisfied at 7/8 with a documented skip.

### S-4: Ack route `POST /cockpit/gates/:id/ack`

**What**: The route exists, validates its body against `GateOutcomeSchema` from `@generacy-ai/cockpit/gates`, and re-emits the outcome as a `cluster.cockpit` event.

**Where**: Owned by #1021.

**Consumer**: Scenario S3.

**Landing budget**: If missing, this is #1021's core scope — the harness assumes it's present. If not, S3 is skipped with a linking comment.

## Seams required from #1023 (doorbell)

### S-5: `COCKPIT_ANSWERS_FILE` env override in the doorbell

**What**: The doorbell (`packages/generacy/src/cli/commands/cockpit/doorbell.ts`) reads `process.env.COCKPIT_ANSWERS_FILE` when locating its tail target; falls back to the production path if unset.

**Where**: `packages/generacy/src/cli/commands/cockpit/doorbell.ts` — likely inside `doorbellCommand()` or a helper it calls.

**Consumer**: Every scenario that spawns the doorbell (all of them except F2 arguably, but F2 also spawns for consistency).

**Landing budget**: 2–5 LOC. Lands here if #1023 missed it.

### S-6: `--answers-file <path>` CLI flag (alternative to env)

**What**: Optional — if the doorbell already accepts a `--answers-file` flag, the harness passes it in `spawn` args instead of via env. Either mechanism satisfies the harness.

**Where**: `packages/generacy/src/cli/commands/cockpit/doorbell.ts` command definition.

**Consumer**: Harness `spawn()` call.

**Landing budget**: 3–5 LOC. Nice-to-have; env-var is fine.

### S-7: Doorbell startup re-reads from head (position model B)

**What**: On start, the doorbell always re-reads the answers file from head and consults the ack registry / MCP event-bus for already-acked `deliveryId`s (per clarification Q1 → B). No on-disk position sidecar.

**Where**: Doorbell startup path.

**Consumer**: Scenario S4 (restart replay exactly once).

**Landing budget**: If #1023 implemented some other position model (A or C from the clarification), this is a real behavioral divergence and the harness will surface it. **Fix does not land here** — it's a contract change owned by #1023's PR conversation.

## Seams required from #1022 (cockpit MCP tools)

### S-8: `cockpit_gate_open` and `cockpit_gate_ack` are HTTP clients of the orchestrator routes

**What**: `cockpit_gate_open` POSTs to `POST /cockpit/gates` and returns `{gateId, status}`; `cockpit_gate_ack` POSTs to `POST /cockpit/gates/:id/ack` and returns success/failure.

**Where**: `packages/generacy/src/cli/commands/cockpit/mcp/tools/` (approximate location per #1022).

**Consumer**: The harness does **not** invoke `cockpit_gate_open` / `cockpit_gate_ack` directly through the MCP protocol — it POSTs to the orchestrator routes with `fetch()`. This means #1022's specific tool surface is not directly asserted by this harness. **This is intentional**: #1022 has its own MCP-boundary tests (following the parity-test pattern from #1015). This harness's scope is the orchestrator ↔ doorbell ↔ relay wire, not the MCP tool.

**Landing budget**: N/A — no seam required from #1022 for this harness.

## Seams required from #1020 (contracts module)

### S-9: `@generacy-ai/cockpit/gates` subpath export

**What**: The `packages/cockpit/package.json` `exports` field surfaces `./gates` (or `./src/gates`) so `import { gateOpenFixture } from '@generacy-ai/cockpit/gates'` resolves.

**Where**: `packages/cockpit/package.json` `exports` field.

**Consumer**: The harness's imports.

**Landing budget**: If #1020 exports the module only via the main entry (`import { gateOpenFixture } from '@generacy-ai/cockpit'`), the harness adapts to whatever the main-entry surface is. If the module is not exported at all, the harness cannot compile — 3–5 LOC package.json fix under D-2 lands here.

### S-10: Fixture builders exist and match the contract shapes

**What**: `gateOpenFixture()`, `answerLineFixture()`, `outcomeAckFixture()` return contract-conformant objects with sensible defaults, accept a partial-object `overrides` arg.

**Where**: `packages/cockpit/src/gates/fixtures.ts` (approximate).

**Consumer**: Every scenario in the harness.

**Landing budget**: If #1020 landed schemas but no fixture builders, the builders (~30–50 LOC total) exceed the D-2 threshold. They land in a small `packages/cockpit/src/gates/fixtures.ts` follow-up co-authored with #1020's PR owner. If that follow-up is not available, the harness inlines minimal builders in `scenario-helpers.ts` **with a large `// TODO(#1020): move these to packages/cockpit/src/gates/fixtures.ts`** and files the follow-up before merge.

## Summary matrix

| Seam | Sibling | Required for | Threshold LOC | Lands here if missing? |
|------|---------|--------------|---------------|------------------------|
| S-1 `COCKPIT_ANSWERS_FILE` (writer) | #1021 | All except F2 | 2–5 | ✅ Yes |
| S-2 `cluster.cockpit` allow-list | #1021 | S1a, S1b, S3 | 1 | ✅ Yes |
| S-3 Retain-and-replay branch | #1021 | S1b | ~20 hookup / >20 full | Hookup: ✅ / Full: file follow-up, skip S1b |
| S-4 Ack route exists | #1021 | S3 | Core sibling scope | ❌ Skip S3 with follow-up |
| S-5 `COCKPIT_ANSWERS_FILE` (doorbell) | #1023 | All except F2 | 2–5 | ✅ Yes |
| S-6 `--answers-file` CLI flag | #1023 | (alt to env) | 3–5 | ✅ Yes (optional) |
| S-7 Startup re-read model | #1023 | S4 | Contract change | ❌ Escalate to #1023 conversation |
| S-8 MCP tool HTTP-client shape | #1022 | (none) | N/A | ❌ Not asserted here |
| S-9 `./gates` subpath export | #1020 | Compile | 3–5 | ✅ Yes |
| S-10 Fixture builders | #1020 | All | 30–50 | Follow-up preferred; inline as last resort |

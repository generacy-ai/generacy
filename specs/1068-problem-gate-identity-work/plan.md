# Implementation Plan: End-to-end verification of run-scoped gate identity

**Feature**: End-to-end verification of run-scoped gate identity across generacy / generacy-cloud / agency
**Branch**: `1068-problem-gate-identity-work`
**Status**: Complete
**Date**: 2026-07-29
**Spec**: [spec.md](./spec.md)
**Source issue**: [generacy#1068](https://github.com/generacy-ai/generacy/issues/1068)

## Summary

Ship a **cluster-side integration harness** that composes the real orchestrator gate routes, the real `ClusterRelayClient`, the real MCP query tools (`cockpit_gate_status`, `cockpit_gate_list`) and the real MCP write tools (`cockpit_gate_open`, `cockpit_gate_ack`) against a **schema-validated fake cloud** (fake WS peer + in-memory gate-doc store + fake HTTP endpoint backing `CloudGateQueryClient`). Seven assertions pin the composed run-scoped-gate contract that spans generacy Phase B, generacy-cloud Phase A and agency Phase C — each of which is a no-op inside its own repo. Under clarifications Q1=A the "real cloud" is realized as a schema-validated fake; under Q5=B fault-injection knobs live in harness/fixture code only (FR-012 forbids `SIMULATE_PHASE_*` switches in shipped binaries).

The load-bearing shift versus the ancestor `cockpit-gates-integration.integration.test.ts` (#1024) is on the fake peer: today it only validates the relay **envelope** (`RelayMessageSchema`); this feature tightens it to also validate the **payload** with `GateOpenWireSchema` / `GateOutcomeWireSchema` from `packages/generacy/src/cli/commands/cockpit/mcp/gates/schemas.ts`, so that a cluster-side payload-shape drift (the exact class of bug that shipped `frameId` inert) fails locally instead of silently diverging (FR-006). A second load-bearing shift is on the query path: the harness must stand up a fake **HTTP** cloud that `CloudGateQueryClient` can reach, so `GET /cockpit/gates` (backing `cockpit_gate_status` and `cockpit_gate_list`) returns real bytes rather than 503 (the harness's current behaviour when `getCloudGateQueryClient` is unwired).

## Technical Context

**Language/Version**: TypeScript 5.x, Node.js ≥22 (workspace-wide constraint).
**Primary Dependencies**:
- `vitest` — test runner (existing sibling `.integration.test.ts` pattern).
- `ws` — real WebSocketServer for the fake peer.
- `fastify` — bare Fastify instance in `scenario-helpers.ts` (light orchestrator).
- `@generacy-ai/cluster-relay` — real `ClusterRelayClient` connecting to the fake peer.
- `@generacy-ai/cockpit` — fixture builders (`gateOpenFixture`, `gateOutcomeFixture`, `deriveGateKey`, `deriveGateId`) — SC-004 single-sourcing.
- `packages/orchestrator/src/routes/cockpit-gates.ts` — real gate routes wired into the light orchestrator.
- `packages/orchestrator/src/services/cloud-gate-query-client.ts` — real cluster→cloud query client, pointed at the fake HTTP cloud via `httpsRequestImpl` / `httpRequestImpl` test seams.
- `packages/generacy/src/cli/commands/cockpit/mcp/tools/{cockpit_gate_status,cockpit_gate_list,cockpit_gate_open,cockpit_gate_ack}.ts` — real MCP tool handlers exercised via direct import.
- `packages/generacy/src/cli/commands/cockpit/mcp/gates/schemas.ts` — `GateOpenWireSchema` / `GateOutcomeWireSchema` for the fake-peer payload validator (FR-006).

**Storage**: In-memory `Map<gateId, GateDoc>` in the fake cloud (§data-model). No Firestore, no filesystem persistence beyond the per-scenario temp dir already established by `setupScenario()`.
**Testing**: Vitest, `.integration.test.ts` suffix (matches `cockpit-gates-integration.integration.test.ts` and `cockpit-gates-frameid.integration.test.ts`).
**Target Platform**: Linux CI runners (same as sibling harnesses).
**Project Type**: Test harness — extension of `packages/orchestrator/src/__tests__/cockpit-gates/`.
**Performance Goals**: Test file median ≤ 90 s, p95 ≤ 180 s (SC-006). Sibling `relay-integration.integration.test.ts` runs in ~15–25 s locally; expected ~30–60 s.
**Constraints**:
- **FR-012 (load-bearing)**: no `SIMULATE_PHASE_*` env var, config flag or code branch may ship in `packages/orchestrator/src/`, `packages/control-plane/src/`, `packages/cluster-relay/src/`, or `packages/generacy/src/cli/commands/cockpit/mcp/` (see contracts/production-code-boundary.md for the exact scan pattern). Fault injection lives in `packages/orchestrator/src/__tests__/cockpit-gates/` only.
- **Q1=A residual**: cluster↔cloud semantic divergence is NOT detectable here — this is called out in the spec header and repeated in `research.md § Q1`.
- **SC-004 single-sourcing**: every wire body constructed through the `@generacy-ai/cockpit` fixture builders. No inline schema literals.
- **Workspace build cycle** (from `scenario-helpers.ts` header): `@generacy-ai/generacy` depends on `@generacy-ai/orchestrator` (`workspace:*`), so the harness cannot import the MCP server directly. The harness reaches the MCP tools via **direct function import** (`cockpitGateStatus`, `cockpitGateList`, etc.), NOT via the MCP protocol.

**Scale/Scope**: 7 FR verification items × 1 healthy cell + up to 3 revert cells (per SC-002) = up to 4 test cases per FR. Estimated ~15 new test cases in a single new `.integration.test.ts` file plus 3 new harness helpers.

## Constitution Check

No `/workspaces/generacy/.specify/memory/constitution.md` exists. Gate defers to project conventions embedded in `CLAUDE.md`:

- **Changeset gate**: this feature is **test-only** (`packages/*/src/**` non-test paths NOT touched). CLAUDE.md exempts test-only diffs from the changeset gate — `.changeset/*.md` will NOT be added. Reviewer should verify by running `git diff --name-only develop.. -- 'packages/*/src/**' | grep -v -E '(\.test\.ts|\.spec\.ts|__tests__/)'` before merge; empty output = exempt.
- **Speckit workflow**: `/plan` → `/tasks` → `/implement`. Implement phase MUST add the changeset if — and only if — a non-test file under `packages/*/src/` changes during implementation (unlikely given scope; possible if FR-006 requires exporting `GateOpenWireSchema` from a package boundary or a fake-cloud helper needs to live under `src/`).
- **Test file naming**: `.integration.test.ts` suffix (sibling convention).

**Gate outcome**: PASS. No violations; no complexity-tracking entries required.

## Project Structure

### Documentation (this feature)

```text
specs/1068-problem-gate-identity-work/
├── spec.md                              # Existing — DO NOT MODIFY
├── clarifications.md                    # Existing — DO NOT MODIFY
├── plan.md                              # This file (/plan output)
├── research.md                          # /plan output — decision rationale
├── data-model.md                        # /plan output — harness entities
├── quickstart.md                        # /plan output — runbook
├── contracts/
│   ├── fake-cloud-store.md              # In-memory GateDoc store contract
│   ├── fake-peer-payload-schema.md      # FR-006 payload-validator contract
│   ├── mcp-tool-driver.md               # Q2=C direct-import contract
│   ├── production-code-boundary.md      # FR-012 scan pattern & enforcement
│   └── revert-scenarios.md              # SC-002 per-phase-revert matrix
└── checklists/                          # Existing (empty) — /checklist output
```

### Source Code (repository root — extensions only, no new packages)

```text
packages/orchestrator/src/__tests__/cockpit-gates/
├── fake-peer.ts                         # EXISTING — extended: payload validator (FR-006)
├── scenario-helpers.ts                  # EXISTING — extended: fake-cloud wiring + MCP tool driver
├── doorbell-driver.ts                   # EXISTING — unchanged
├── fake-cloud-store.ts                  # NEW — in-memory GateDoc store + HTTP fake
└── mcp-tool-driver.ts                   # NEW — direct-import wrapper around cockpit_gate_* tools

packages/orchestrator/src/__tests__/
└── cockpit-gates-runid.integration.test.ts   # NEW — 7 FR verification items + revert matrix
```

### Files touched (write-list, non-test)

**None expected.** If FR-006 tightening surfaces a `GateOpenWireSchema` / `GateOutcomeWireSchema` re-export gap (currently they live in `packages/generacy/.../mcp/gates/schemas.ts`; the harness sits in `packages/orchestrator/`), the honest fix is a **workspace-graph-safe re-import**: the harness reads them from a new shared location OR duplicates them inline in `fake-peer.ts` (mirror pattern already used inside `mcp/gates/schemas.ts` per its own header rationale — "keep the boundary insulated from cross-package export churn"). Decision recorded in `research.md § D-3`; final choice made at implement time when the exact import-graph shape is known.

If a re-export IS required, it lives in `packages/cockpit/src/gates/` (the neutral home for wire contracts per #1020) and the change becomes non-test — triggering the changeset gate. Implementer MUST add `.changeset/1068-*.md` in that case.

### Structure Decision

Single new `.integration.test.ts` file + two new harness helpers, all under `packages/orchestrator/src/__tests__/cockpit-gates/`. Extends the #1024 `setupScenario` primitive with a `startFakeCloud: true` option that wires an in-memory `GateDoc` store into `CloudGateQueryClient` via the existing `httpsRequestImpl` / `httpRequestImpl` test seams (§data-model). No changes to production `packages/*/src/**` code expected.

## Approach

### 1. FR-006 fake-peer payload validation (load-bearing)

`packages/orchestrator/src/__tests__/cockpit-gates/fake-peer.ts:148-158` currently runs `RelayMessageSchema.safeParse` and drops frames that fail the envelope schema. On success it pushes to `received.events` without inspecting `data`.

**Change**: on a frame with `event === 'cluster.cockpit'`, additionally attempt `GateOpenWireSchema.safeParse(msg.data)` (when `data.type === 'gate-open'`) or `GateOutcomeWireSchema.safeParse(msg.data)` (when `data.type === 'gate-outcome'`). Failure = drop + logged-and-tracked violation (a new counter on `FakePeer.received.payloadViolations`), NOT crash. Scenarios assert `payloadViolations.length === 0` on the happy path (FR-006 primary) and `> 0` on an intentionally-drifted body (FR-006 negative).

**Rejected alternative**: crash the peer on payload-schema failure. Rejected because the peer already tolerates unknown frame types silently (`fake-peer.ts:179 'heartbeat, tunnel_*, lease_*, error, conversation — silently accept'`); a hard crash would make one unrelated test failure kill the whole file. Tracking-and-asserting keeps the failure surface attributable per-scenario.

### 2. Fake HTTP cloud backing `CloudGateQueryClient`

`packages/orchestrator/src/services/cloud-gate-query-client.ts:145-147` already exposes `httpsRequestImpl` / `httpRequestImpl` test seams. The current harness never constructs `CloudGateQueryClient` — `setupCockpitGatesRoute` receives no `getCloudGateQueryClient`, so `GET /cockpit/gates` returns 503.

**Change**: extend `setupScenario({ startFakeCloud: true })` to:
1. Instantiate an in-memory `FakeCloudStore` (`packages/orchestrator/src/__tests__/cockpit-gates/fake-cloud-store.ts`) — `Map<gateId, GateDoc>` with `putGateFromWireFrame(gateOpenWire)`, `applyOutcome(gateId, outcome)`, `getByKey(issueRef, gateType, generation, runId?)`, `listByIssueRef(issueRef, gateType?)`.
2. Wire the store as a **peer-side listener**: when `fake-peer.ts` accepts a validated `gate-open` frame, `FakeCloudStore.putGateFromWireFrame(frame.data)` is invoked; when it accepts a validated `gate-outcome` frame, `FakeCloudStore.applyOutcome(frame.data.gateId, frame.data.outcome)`. This mirrors what the real cloud's `services/api/src/services/relay/message-handler.ts` does with `gate-open` / `gate-outcome` sub-events.
3. Build a `httpRequestImpl` shim that intercepts `GET /api/clusters/<clusterId>/cockpit/gates` and returns JSON derived from `FakeCloudStore`. Two shapes per the wire contract at `cloud-gate-query-client.ts:78-114`:
   - **status mode** (`generation` present) → `{ gateId, status }` where `status ∈ { open, answered, delivered, applied, superseded, failed, expired } | null`. Under Q4/§collapseCloudStatus, the orchestrator route collapses this to the three-state `open | answered | absent` before returning to the MCP tool.
   - **list mode** (`generation` absent) → `{ gates: [{ gateId, gateType, generation, status }], truncated? }`.
4. Pass a `createCloudGateQueryClient({ clusterId: 'test-cluster', httpRequestImpl: shim, apiUrlEnv: 'GENERACY_API_URL' })` into `setupCockpitGatesRoute` via a new `startFakeCloud` code-path in `scenario-helpers.ts`. `GENERACY_API_URL` gets `http://127.0.0.1:1` (ignored by the shim; the shim short-circuits before the URL is dialed) — set at scenario setup, restored at cleanup.

### 3. MCP tool driver (Q2=C)

Per clarifications Q2, the harness does NOT spawn a real `claude` process and does NOT drive the MCP protocol. It calls the tool handlers **directly** by named import:

```ts
import { cockpitGateOpen } from 'packages/generacy/src/cli/commands/cockpit/mcp/tools/cockpit_gate_open.js';
import { cockpitGateAck } from 'packages/generacy/src/cli/commands/cockpit/mcp/tools/cockpit_gate_ack.js';
import { cockpitGateStatus } from 'packages/generacy/src/cli/commands/cockpit/mcp/tools/cockpit_gate_status.js';
import { cockpitGateList } from 'packages/generacy/src/cli/commands/cockpit/mcp/tools/cockpit_gate_list.js';
```

**Workspace-cycle risk**: `packages/generacy` depends on `packages/orchestrator` (see `scenario-helpers.ts` header note on the doorbell driver). The reverse import direction — orchestrator tests importing from generacy — is the SAME direction the `cockpit-gates-integration.integration.test.ts` doorbell driver uses (via `spawn(nodeBin, ['-e', ...])` invoking the built `dist/bin/generacy.js`). Static import from a test file is allowed by TypeScript because the tests are excluded from the package's public build graph. Verify at implement time that `pnpm --filter @generacy-ai/orchestrator test` resolves the imports; if not, fall back to spawning a Node subprocess and driving the tools by CLI, mirroring the doorbell pattern.

**`resolveGateOptions(deps)` seam**: the MCP tools accept a `BuildMcpServerDeps` object that carries a `baseUrl` and `fetchImpl`. The harness passes `{ baseUrl: ctx.orchestratorUrl, fetchImpl: fetch }` — the tool then hits the light orchestrator's `GET /cockpit/gates` route, which hits the fake cloud (via the seams in step 2), which returns bytes derived from `FakeCloudStore`. Full loop, real code, zero mocks past the wire boundary.

### 4. Seven FR verification items → test bodies

| FR | Verification | Test body sketch |
|----|--------------|-----------------|
| FR-001 | Real WebSocket | Every test uses `setupScenario({ startFakeCloud: true })` — inherited from #1024, which already runs a real `WebSocketServer` and real `ClusterRelayClient`. |
| FR-002 | Re-run makes a new gate | Two `cockpitGateOpen` calls with same `(issueRef, gateType, generation)` but different `runId` → assert `deriveGateId` outputs differ, both frames observed at peer with distinct `gateId`, `FakeCloudStore` has two distinct docs. |
| FR-003 | `cockpit_gate_status(runId)` returns `open` in-run | `cockpitGateOpen(...)` → poll `cockpitGateStatus({ ..., runId: sameRunId })` → assert `data.status === 'open'` and `data.gateId === derivedGateIdA`. Also assert the same `gateId` appears in `cockpitGateList({ issueRef })`. |
| FR-004 | N≥3 wakes, no re-emit | Loop `cockpitGateStatus({ ..., runId })` 3 times ("wakes"); assert on each wake `status ∈ {open, answered}` (never `absent`); assert exactly one `cluster.cockpit` frame at peer for `gateId`; assert exactly one `'cockpit gate emitted'` log line via a stub logger injection through `setupCockpitGatesRoute` options. Draft-loop simulation is a `for` loop in the test body — no subagent spawn. |
| FR-005 | Rendering strips `runId` from generation | `cockpitGateOpen({ generation: 'P2', runId: 'rid-1' })` and `cockpitGateOpen({ generation: 'artifact-review:spec-review:abc123', runId: 'rid-2' })` → `cockpitGateList({ issueRef })` → assert entries[i].generation matches the input string unchanged, no `:<runId>` suffix. |
| FR-006 | `frameId` correlated over real socket | `cockpitGateOpen(...)` → capture route response `frameId` → capture peer-received `data.frameId` → assert byte-equal. Combined with fake-peer payload validation (§1) — any shape drift on the wire body fails locally. |
| FR-007 | Zero `Invalid relay message, skipping` in cluster stdout | Inject a stub logger into `setupCockpitGatesRoute` options that captures every `warn`; run a full open→ack cycle; assert `warnRecords.filter(r => r.msg.includes('Invalid relay message, skipping')).length === 0`. Fake-peer must not emit the string either (it doesn't today — it uses `dropping frame that failed ...` — so this is a genuine post-#1063 regression guard, not a false pass from an unrelated log line). |
| FR-008 | Cluster without Phase B (omit `runId`) | Call `cockpitGateOpen` WITHOUT `runId` field → `cockpitGateAck` WITHOUT `runId` field. Assert cycle completes to `applied` in `FakeCloudStore`. `runId` optionality is real (see `GateOpenInputSchema.runId: z.string().min(1).optional()` at `mcp/gates/schemas.ts:131`). |
| FR-009 | Pre-Phase-A doc (no `generation`) | Direct-write into `FakeCloudStore` a doc with `generation: undefined` → call `cockpitGateList` → assert the doc surfaces via the pre-Phase-A fallback (implemented by not-including `generation` in the list-response `gates[]` entries — the harness asserts the doc appears when queried by `issueRef` alone). Pre-Phase-A doc shape is hand-crafted here; not generated from a wire fixture. |
| FR-010 | Fail-closed attribution | Vitest's default `describe/it` isolation delivers this — each FR is its own `it()` block, so an FR-003 assertion failure doesn't mask an FR-005 assertion. |
| FR-011 | Cluster on new build with workers restarted | Precondition, not a test assertion. Documented in `quickstart.md § Preconditions`. |
| FR-012 | No `SIMULATE_PHASE_*` in shipped code | Static grep test in `packages/orchestrator/src/__tests__/cockpit-gates/no-simulate-phase-in-src.test.ts` (NEW) — asserts `grep -r 'SIMULATE_PHASE_' packages/*/src/ --exclude-dir=__tests__` returns zero matches. Runs as part of the same suite so a rogue implement-phase env var trips it. See `contracts/production-code-boundary.md`. |

### 5. SC-002 per-phase-revert matrix

Per clarifications Q5, revert scenarios are **fake-side configuration**, not production knobs. `contracts/revert-scenarios.md` catalogs three revert cells:

- **Phase A reverted** — `FakeCloudStore` constructor takes `{ persistGeneration: false }` → docs stored without `generation` field → `cockpit_gate_list` falls back → FR-005/FR-009 asserts still pass but FR-002/FR-003 fail attributably (no `generation` means no per-run discrimination).
- **Phase B reverted** — harness omits `runId` on all tool calls (per Q3=C — this is not-passing an optional field, not a flag) → FR-003 fails: `cockpit_gate_status` returns `absent` for the second run because the fake cloud's `getByKey` lookup can't discriminate.
- **Phase C reverted** — same as Phase B (agency's contribution is passing `runId` from `/cockpit:auto`; from the harness's perspective this is indistinguishable from Phase B) → same failure attribution. Documented as such in `contracts/revert-scenarios.md`; SC-002 requires per-phase attribution but B and C fail on the same assertion because they are two ways of stopping the same value from flowing.

### 6. Anti-patterns to avoid

- **No `MockRelayClient`.** Every test uses the real `ClusterRelayClient` from `@generacy-ai/cluster-relay` (FR-001, US5). #1024 already established this pattern; don't regress it.
- **No inline schema literals.** All wire bodies via `gateOpenFixture` / `gateOutcomeFixture` from `@generacy-ai/cockpit` (SC-004). Invalid bodies derive from a fixture, then mutate one field.
- **No `vi.fn()` for the peer.** Fake peer is a real `WebSocketServer` (US5 rationale — echo-mocks are worthless here).
- **No `SIMULATE_PHASE_*` env vars.** FR-012. Enforced by the static grep test.
- **No cross-run state leak.** Every scenario runs `setupScenario()` in `beforeEach` and `ctx.cleanup()` in `afterEach` — same pattern as the sibling harnesses. `FakeCloudStore` is instantiated per-scenario, never module-scoped.

## Complexity Tracking

None. All work sits inside the existing `packages/orchestrator/src/__tests__/cockpit-gates/` directory and reuses the #1024/#1077 harness scaffolding.

## Risks and mitigations

| Risk | Mitigation |
|------|------------|
| Workspace-cycle blocks direct MCP-tool import (`packages/orchestrator` test → `packages/generacy` handler). | Documented fallback in §3: spawn a Node subprocess mirroring the doorbell driver. Verified at implement time (T001). |
| FR-006 requires exporting `GateOpenWireSchema` from a shared package. | Documented in §"Files touched"; if needed, re-export lands in `packages/cockpit/src/gates/` (#1020's neutral home) and implementer adds a changeset. |
| Fake cloud drifts from real cloud shape → false green. | Mitigated by (a) SC-004 fixture builders, (b) FR-006 fake-peer payload validation using the same frozen wire schemas the real cloud uses (documented Q1=A residual: semantic divergence NOT detectable here). |
| `cockpit_gate_status` returns `absent` for the same-run second-call case IFF the fake's key derivation drifts from cluster-side `deriveGateKey`. | Mitigated by the fake importing and calling `deriveGateKey` / `deriveGateId` from `@generacy-ai/cockpit` — the same helpers `cockpit_gate_open` uses. Documented in `contracts/fake-cloud-store.md § Key derivation`. |
| CI runtime > SC-006 budget. | Sibling `.integration.test.ts` files run 15–25 s. Estimated 30–60 s for this file. Budget headroom is real. `Vitest.setTimeout(20_000)` per test caps a runaway. |

## Next step

`/tasks` — generate the dependency-ordered task list from this plan.

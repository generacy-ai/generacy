# Research: End-to-end verification of run-scoped gate identity

**Feature**: End-to-end verification of run-scoped gate identity across generacy / generacy-cloud / agency
**Spec**: [spec.md](./spec.md)
**Plan**: [plan.md](./plan.md)
**Date**: 2026-07-29

This document records the load-bearing implementation decisions, the alternatives considered, and the sources that inform each. Decisions map to the clarifications in `clarifications.md` where the answer is already fixed; new decisions (D-*) are introduced here to close gaps that surfaced during planning.

---

## Q1=A — Fake WS peer + fake HTTP cloud (recap)

**Decision**: Use the schema-validated fake harness pattern from #1024 (`cockpit-gates-integration.integration.test.ts` + `fake-peer.ts`), extended with a fake HTTP cloud that backs `CloudGateQueryClient`.

**Rationale**: covered in `clarifications.md § Q1`. Two mitigations required:
1. **Parse, do not pick.** Fake peer validates payload with the frozen wire schemas — see D-1.
2. **State the residual honestly.** Cluster↔cloud semantic divergence is NOT detectable here and remains covered by generacy-cloud's own suite. Repeated in the spec header, plan Summary, and quickstart.

**Rejected alternatives** (from `clarifications.md § Q1`):
- **B (ephemeral real cloud)** — CI runtime blows the SC-006 budget; requires Firestore emulator container per run.
- **C (shared staging cloud)** — shares production `generacy-ai` `(default)` Firestore across Cloud Run services. CI writes would land in production. Record here so C is never revisited as "the fast option": **staging shares the production Firestore.**

**Sources**:
- `packages/orchestrator/src/__tests__/cockpit-gates/fake-peer.ts` (existing, #1024).
- `packages/cluster-relay/tests/relay.test.ts` (WebSocketServer + waitFor pattern).
- `generacy-cloud/services/api/src/services/relay/message-handler.ts:812` — real cloud reads `frameId` off raw frame data.

---

## Q2=C — MCP tool-call driver (recap)

**Decision**: Harness drives `cockpit_gate_open` / `cockpit_gate_ack` / `cockpit_gate_status` / `cockpit_gate_list` MCP tool handlers by **direct function import**. No real `claude` process. No MCP protocol layer. No drafting subagent (it doesn't exist as code — see `clarifications.md § Q2`).

**Rationale**: covered in `clarifications.md § Q2`. Key point: agency's `packages/claude-plugin-cockpit/tests/playbook-verification.test.ts` (186 assertions) is the sibling test that pins `auto.md` consumes the tools correctly. Neither repo can make both claims; the division of labour is fixed in the spec's `§ Division of labour with agency` block.

**Rejected alternatives** (from `clarifications.md § Q2`):
- **A (direct call to drafting entry-point)** — module does not exist. Struck.
- **B (real `claude` CLI subprocess)** — requires stubbed LLM backend or real Anthropic key in CI; blows SC-006 budget.

**New decision (D-2)** — **workspace-cycle mitigation**. `packages/generacy` depends on `packages/orchestrator` (`workspace:*`). The reverse direction (orchestrator test importing from generacy source) is what the harness needs. Two options:

- **D-2-a (default)**: TypeScript static import. Tests are excluded from the `packages/generacy` public build graph, so the import resolves through `tsc`'s test-mode resolver. Same shape the sibling `#1024` harness uses when it spawns the doorbell binary. **Verify at implement time** with `pnpm --filter @generacy-ai/orchestrator test`.
- **D-2-b (fallback)**: spawn a Node subprocess (`spawn(nodeBin, ['-e', '<script that imports the tool and prints JSON>'])`), mirror the doorbell driver pattern. Higher CI cost (~200 ms per invocation) but zero build-graph impact.

**Recommendation**: attempt D-2-a first; fall back to D-2-b only if the static import fails.

---

## Q3=C — Hybrid backward-compat realization (recap)

**Decision**:
- **FR-008** (cluster without Phase B) realized by omitting the optional `runId` field on tool calls. Not a flag; the field is already `z.string().min(1).optional()`.
- **FR-009** (pre-Phase-A doc) realized by hand-crafting a doc without `generation` and writing it directly into `FakeCloudStore`.

**Rationale**: covered in `clarifications.md § Q3`. Rejected alternative:
- **B (pin old published packages)** — cluster is source-linked (`/workspaces/generacy/packages/generacy/bin/generacy.js`). Pinning old tarballs tests a distribution path this deployment doesn't use.

**Source**: `packages/generacy/src/cli/commands/cockpit/mcp/gates/schemas.ts:131` — `runId: z.string().min(1).optional()`. Same shape in `query-schemas.ts:34` and `:75`.

---

## Q4=C — Existing log line + wire frame count (recap)

**Decision**: FR-004's dedup signal is:
1. Exactly one `'cockpit gate emitted'` log line per `gateId` (from `packages/orchestrator/src/routes/cockpit-gates.ts:190-193` inside `tryEmitOrRetain`).
2. Exactly one `cluster.cockpit` frame per `gateId` at the peer (each frame carries a distinct `frameId` per #1077, so a duplicate emit produces two frames with two ids).
3. `cockpit_gate_status(runId=<current>)` returns `open`/`answered` on wakes 2..N, never `absent`.

**Rationale**: covered in `clarifications.md § Q4`. Substitution to a stronger signal — one layer closer to the operator — satisfies Assumption 3's "no weaker signal" constraint.

**Instrumentation**: the log line is captured by injecting a stub logger into `setupCockpitGatesRoute({ logger })`. The scenario helpers already accept a logger override (`SILENT_LOGGER` is a placeholder); the new harness swaps in a `CountingLogger` per scenario.

---

## Q5=B — Fault injection in harness only (recap)

**Decision**: Every phase-revert knob is fake-side configuration. No `SIMULATE_PHASE_*` env var, config flag or code branch may ship in production packages. Static grep test enforces (see `contracts/production-code-boundary.md`).

**Rationale**: covered in `clarifications.md § Q5`. A production binary carrying "behave like the broken version" branches is one misconfiguration from being the broken version.

---

## D-1: Fake-peer payload validation (FR-006 tightening)

**Decision**: Extend `fake-peer.ts:148-158` to run a second `safeParse` on `msg.data` when `msg.event === 'cluster.cockpit'`, using `GateOpenWireSchema` (when `data.type === 'gate-open'`) or `GateOutcomeWireSchema` (when `data.type === 'gate-outcome'`). Frames that fail: **track and drop, don't crash.**

**Rationale**: real cloud (`services/api/src/services/relay/message-handler.ts:812`) reads `frameId` off raw frame data via Zod parse. A fake that only validates the envelope (`RelayMessageSchema`) would pass any payload shape the cluster emits — exactly the class of bug that shipped `frameId` inert. Tightening puts the fake at parity with the real cloud on the one dimension the harness can guarantee (Q1=A residual).

**Alternatives considered**:
- **D-1-a (chosen)**: track violations on `FakePeer.received.payloadViolations: Array<{ gateType, issues }>`. Scenarios assert `.length === 0` on happy path, `> 0` on negative.
- **D-1-b (rejected)**: throw / disconnect on payload failure. Rejected because peer already tolerates unknown top-level frame types silently (`fake-peer.ts:179`); a hard crash would make one unrelated failure kill the whole file and destroy FR-010's per-item attribution.
- **D-1-c (rejected)**: log-only, no counter. Rejected because tests would then need to grep stderr — noisier than a first-class field.

**Wire schema source**: `packages/generacy/src/cli/commands/cockpit/mcp/gates/schemas.ts`. These are the **cluster-side mirror** of the frozen cloud contract; the header of that file documents field-for-field parity with the cloud. Importing them from the cluster side is honest — a drift between cluster-side and cloud-side mirrors is out of scope (Q1=A residual, generacy-cloud's own suite covers it).

---

## D-3: `GateOpenWireSchema` import location

**Question**: The schemas today live in `packages/generacy/src/cli/commands/cockpit/mcp/gates/schemas.ts`. The harness lives in `packages/orchestrator/src/__tests__/`. Can the harness import from the generacy package's non-published file path?

**Options**:
- **D-3-a**: Direct test-time import (same file path). Requires the tests to resolve through the workspace symlink. Works in `pnpm --filter @generacy-ai/orchestrator test` because vitest resolves via tsconfig paths / workspace layout.
- **D-3-b**: Duplicate the two schemas inline in `fake-peer.ts` (mirror the pattern that `mcp/gates/schemas.ts` itself uses: it duplicates helpers rather than importing from `@generacy-ai/cockpit` for insulation from cross-package export churn — see the file's header).
- **D-3-c**: Extract the schemas into `@generacy-ai/cockpit` (the neutral home per #1020) and import from there. Non-test change → triggers changeset gate; larger blast radius.

**Recommendation**: Try D-3-a first (zero-cost if it works). If the resolver complains, use D-3-b (adds ~30 LOC of duplication in `fake-peer.ts`, matches the pattern the cluster-side mirror already uses one layer up). D-3-c is the honest structural fix but is deferred as a follow-up because it forces a non-test change that widens this PR's scope.

**Decision recorded at implement time** (T003 in tasks.md).

---

## D-4: `cockpit_gate_open` semantics vs harness invocation

The `cockpitGateOpen` tool handler currently derives `gateKey` + `gateId` internally from `(issueRef, gateType, generation, runId?)` and POSTs the flat frozen record to the orchestrator's `POST /cockpit/gates`. The harness's `cockpitGateOpen({ ..., runId })` therefore does the same derivation — no need for the harness to compute `deriveGateId` itself for the write path. But the assertions ARE against the derived id, so the harness computes it independently via `deriveGateKey` / `deriveGateId` from `@generacy-ai/cockpit` (fixture-builder module) to prove the tool did the right derivation.

**Sources**:
- `packages/generacy/src/cli/commands/cockpit/mcp/gates/schemas.ts:71-83` (`deriveGateKey`, `deriveGateId`).
- `packages/generacy/src/cli/commands/cockpit/mcp/tools/cockpit_gate_open.ts` (writes via `POST /cockpit/gates`).

---

## D-5: `FakeCloudStore` key-derivation invariance

`FakeCloudStore.getByKey(issueRef, gateType, generation, runId?)` must derive the lookup key **byte-identically** to what the cluster-side `cockpit_gate_open` derived when it wrote the doc. If they drift, `cockpit_gate_status` returns `absent` for a gate that IS in the store, and every FR-003 assertion falsely fails.

**Decision**: The fake imports `deriveGateKey` from `@generacy-ai/cockpit` and uses it for both the write path (`putGateFromWireFrame` — deriving from the payload's `issueRef` / `gateType` / `generation` / `runId?` triple in the received wire body) and the read path. Same helper both sides.

**Alternative rejected**: hand-code the key format `${issueRef}:${gateType}:${generation}[:${runId}]` inline in the fake. Rejected because a format drift between cluster and fake is exactly the failure mode the fixture-builder single-sourcing rule (SC-004) exists to prevent.

**Source**: `packages/cockpit/src/gates/` re-exports `deriveGateKey` / `deriveGateId`; `@generacy-ai/cockpit`'s root export bundle from #1020 is the neutral home.

---

## D-6: Injecting `CloudGateQueryClient` into the light orchestrator

`packages/orchestrator/src/services/cloud-gate-query-client.ts:135-153` accepts a `CreateCloudGateQueryClientOptions` bag with test seams `httpsRequestImpl` / `httpRequestImpl`. The seams sit at the `node:http.request` / `node:https.request` layer.

**Decision**: Fake HTTP handler is a `HttpsRequestImpl`-shaped closure that:
1. Inspects the incoming `RequestOptions` (path, method).
2. Matches `GET /api/clusters/<clusterId>/cockpit/gates?...` — the exact URL shape `cloud-gate-query-client.ts:200-219` produces.
3. Parses the query string (`issueRef`, `gateType?`, `generation?`, `runId?`).
4. Queries `FakeCloudStore.getByKey` (status mode) or `FakeCloudStore.listByIssueRef` (list mode).
5. Returns a fake `IncomingMessage`-shaped object via the `callback` argument.

The fake `IncomingMessage` needs `on('data', ...)` and `on('end', ...)` — a `Readable.from([JSON.stringify(body)])` covers both. `statusCode` is set on the fake response object before the callback fires.

**Alternative rejected**: use `nock` or `msw/node`. Both work but add a dependency for one testing surface; the existing `httpsRequestImpl` seam is the intended override point and needs no new dep. Sibling `packages/control-plane/src/services/cloud-pull-client.ts` (per `cloud-gate-query-client.ts:5-7`) uses the same seam pattern.

---

## D-7: How to prove "no `SIMULATE_PHASE_*` in shipped code" (FR-012)

**Decision**: Add `packages/orchestrator/src/__tests__/cockpit-gates/no-simulate-phase-in-src.test.ts` — a single-line grep test:

```ts
import { execSync } from 'node:child_process';

it('FR-012: no SIMULATE_PHASE_* switches in shipped code paths', () => {
  const cmd = "grep -rE 'SIMULATE_PHASE_[A-Z]' packages/*/src/ --exclude-dir=__tests__ --exclude='*.test.ts' --exclude='*.spec.ts' || true";
  const output = execSync(cmd, { cwd: '/workspaces/generacy', encoding: 'utf-8' });
  expect(output).toBe('');
});
```

**Rationale**: FR-012 is a durable constraint — a future implementer must not slip a fault-injection knob into production. The test lives in the same suite so a rogue introduction breaks CI on the very PR that adds it.

**Alternative rejected**: ESLint rule (`no-restricted-syntax` on identifiers matching `/SIMULATE_PHASE_/`). Rejected because ESLint is easily disabled per-line and the check runs later in the pipeline than vitest. A grep test at test time is loud and unbypassable.

---

## D-8: Fake HTTP cloud vs orchestrator route split

There is a subtle question: the `GET /cockpit/gates` route on the orchestrator (`packages/orchestrator/src/routes/cockpit-gates.ts:222-330`) does the seven-to-three status collapse (`collapseCloudStatus`). The MCP tool sees `open | answered | absent`. The fake cloud returns cloud-level status (`open | answered | delivered | applied | superseded | failed | expired | null`) — the orchestrator route handles the collapse.

**Decision**: `FakeCloudStore` stores and returns cloud-level status; the orchestrator route (real code, wired into the light orchestrator) does the collapse. This preserves the cluster-side collapse logic in the test path.

**Consequence**: FR-003's `open` / FR-004's `answered` assertions target the MCP-tool return value (post-collapse), NOT the fake's raw status. Test bodies use `data.status === 'open'`, not `.status === 'delivered'`.

---

## Implementation patterns referenced

- `packages/orchestrator/src/__tests__/cockpit-gates-integration.integration.test.ts` — sibling harness pattern (#1024).
- `packages/orchestrator/src/__tests__/cockpit-gates-frameid.integration.test.ts` — frameId round-trip pattern (#1077).
- `packages/cluster-relay/tests/relay.test.ts` — WebSocketServer + `waitFor` polling.
- `packages/orchestrator/src/services/cloud-gate-query-client.ts:145-147` — the `httpsRequestImpl` / `httpRequestImpl` test seam design.
- `packages/orchestrator/src/__tests__/cockpit-gates/scenario-helpers.ts:132-197` — the light-orchestrator + real-relay-client wiring the new harness extends.

## Key sources

- `packages/generacy/src/cli/commands/cockpit/mcp/gates/schemas.ts` — `GateOpenInputSchema` / `GateOpenWireSchema` / `GateOutcomeWireSchema`, `deriveGateKey`, `deriveGateId`.
- `packages/generacy/src/cli/commands/cockpit/mcp/gates/query-schemas.ts` — `CockpitGateStatusInputSchema`, `CockpitGateListInputSchema`; `runId: z.string().min(1).optional()`.
- `packages/orchestrator/src/routes/cockpit-gates.ts` — `tryEmitOrRetain`, `collapseCloudStatus`, `collapseListEntryStatus`, the `'cockpit gate emitted'` log line.
- `tetrad-development/docs/cockpit-remote-gates-plan.md § Wire contracts` — frozen wire shape reference (via #1020).
- `clarifications.md` — Q1–Q5 rationale.

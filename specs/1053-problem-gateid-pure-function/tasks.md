# Tasks: Gate IDs must not collide across runs

**Input**: Design documents from `/specs/1053-problem-gateid-pure-function/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/, quickstart.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Scope

This PR ships **US1 + US2 only** (FR-001, FR-002, FR-003, FR-008, FR-009, FR-010). US3 + US4 (FR-004, FR-005, FR-006, FR-007) are gated on generacy-cloud#887 and ship in a follow-up PR (see plan §Out of Scope for This PR).

---

## Phase 1: Canonical derivation extension (`@generacy-ai/cockpit`)

- [ ] **T001** [US1] Extend `deriveGateKey` in `packages/cockpit/src/gates/schema.ts`.
  - Add optional fourth parameter `runId?: string`.
  - When `runId === undefined`: return `${issueRef}:${gateType}:${String(generation)}` (byte-for-byte back-compat, per `contracts/gate-key-derivation.md` §"When `runId === undefined`").
  - When `runId` is a non-empty string: return `${issueRef}:${gateType}:${String(generation)}:${runId}`.
  - Do NOT validate `runId` at the derivation layer (empty string composes to trailing colon — validation belongs at the MCP boundary, see T004).
  - Do NOT transform `runId` (no case-fold, no trim, no encoding).
  - Zero change to `deriveGateId` (FR-009 — hash, length, encoding all stable).

- [ ] **T002** [US1] Extend pure-derivation unit tests in `packages/cockpit/src/__tests__/gates-id.test.ts` and `packages/cockpit/src/gates/__tests__/schema.test.ts`.
  - Case 1 (back-compat): `deriveGateKey('christrudelpw/snappoll#1', 'phase-queue', 'P2')` still hashes to `075855bf0c3fef1b7f52ed3a` (regression guard against reverting the fix — matches spec §Field instance test vector).
  - Case 2 (runId appended): `deriveGateKey('christrudelpw/snappoll#1', 'phase-queue', 'P2', 'christrudelpw-snappoll-1-20260727-200458')` produces `'christrudelpw/snappoll#1:phase-queue:P2:christrudelpw-snappoll-1-20260727-200458'`.
  - Case 3 (different runIds → different gateIds): `deriveGateId(deriveGateKey(ref, type, gen, 'RA')) !== deriveGateId(deriveGateKey(ref, type, gen, 'RB'))`.
  - Case 4 (24-char shape stable): `deriveGateId(deriveGateKey(ref, type, gen, 'RA'))` matches `/^[0-9a-f]{24}$/`.

---

## Phase 2: MCP mirror + input schema surface (`@generacy-ai/generacy`)
<!-- Phase boundary: Complete Phase 1 before starting Phase 2 -->

- [ ] **T003** [US1] Mirror the extended `deriveGateKey` signature in `packages/generacy/src/cli/commands/cockpit/mcp/gates/schemas.ts` (MCP-boundary duplicate per that file's docstring).
  - Same signature as T001. Same behaviour.

- [ ] **T004** [US1] Add `runId?: z.string().min(1).optional()` to `GateOpenInputSchema` and `GateAckInputSchema` in `packages/generacy/src/cli/commands/cockpit/mcp/gates/schemas.ts`.
  - Both schemas use `.strict()` — this is the minimal change that keeps auto-loop-shaped callers accepted on both tools.
  - No `.default(...)` — the fallback logic runs when `runId === undefined`, not when Zod pre-fills it, keeping source-selection observable at the tool layer (data-model E-3).
  - Empty string rejected as `invalid-args` at the boundary.

- [ ] **T005** [US2] Verify re-exports through `packages/generacy/src/cli/commands/cockpit/mcp/schemas.ts` continue to forward `GateOpenInputSchema` / `GateAckInputSchema`. No code change expected — the type surface widens transitively.

---

## Phase 3: Tool wiring
<!-- Phase boundary: Complete Phase 2 before starting Phase 3 -->

- [ ] **T006** [US1] Modify `packages/generacy/src/cli/commands/cockpit/mcp/tools/cockpit_gate_open.ts` — fallback runId minting + runId threading.
  - Import `INSTANCE_NONCE` from `../event-bus.js`.
  - Compute `const effectiveRunId = s.runId ?? INSTANCE_NONCE;` and `const runIdSource: 'explicit' | 'fallback-instance-nonce' = s.runId !== undefined ? 'explicit' : 'fallback-instance-nonce';`.
  - Emit one `info` log line per call: `{ event: 'cockpit_gate_open.runid-source', runIdSource, gateId, gateType: s.gateType, issueRef: s.issueRef }`. Do NOT log `runId` itself (data-model E-3 privacy note).
  - Thread `effectiveRunId` into `deriveGateKey(s.issueRef, s.gateType, s.generation, effectiveRunId)`.

- [ ] **T007** [US2] Modify `packages/generacy/src/cli/commands/cockpit/mcp/tools/cockpit_gate_open.ts` — hoist `askedAt` above the retry boundary.
  - Add module-level `const askedAtCache: Map<string, string> = new Map();`.
  - Add helper `getOrMintAskedAt(gateId: string, provided?: string): string` that returns cached value if present, else stores and returns `provided ?? new Date().toISOString()`.
  - Replace the current `askedAt: new Date().toISOString()` at `cockpit_gate_open.ts:72` (per plan §Fix shape item 3) with `askedAt: getOrMintAskedAt(gateId, s.askedAt)`.
  - Key the cache by the DERIVED `gateId` (which already encodes `runId` via `gateKey`) — no cross-run leakage.
  - No eviction, no TTL, no LRU cap (data-model E-4 + plan D-2 rationale).

- [ ] **T008** [P] [US2] Modify `packages/generacy/src/cli/commands/cockpit/mcp/tools/cockpit_gate_ack.ts` — accept-and-ignore `runId` on input.
  - Schema addition already lives in T004 (`GateAckInputSchema.runId`). This task confirms the tool body ignores it — the ack path targets an existing `gateId`, no derivation happens.
  - No behaviour change to the outbound `gate-outcome` frame.

**Note**: T007 and T006 both edit `cockpit_gate_open.ts`; land them in the same edit session (not `[P]`-parallel). T008 edits a disjoint file — parallel-safe with T006/T007.

---

## Phase 4: Tests
<!-- Phase boundary: Complete Phase 3 before starting Phase 4 -->

- [ ] **T009** [US1] [US2] Create `packages/generacy/src/cli/commands/cockpit/mcp/__tests__/cockpit-gate-open-runid.test.ts` — 4 scenarios.
  - **Scenario 1 (explicit runId → gateKey suffix)**: Call `cockpit_gate_open` with `runId: 'RA'` on input. Assert the POSTed body contains `gateKey` ending in `:RA` and a `gateId` distinct from the no-runId derivation of the same triple.
  - **Scenario 2 (fallback path)**: Call `cockpit_gate_open` with no `runId`. Assert (a) the tool logs `event: 'cockpit_gate_open.runid-source'` at `info` with `runIdSource: 'fallback-instance-nonce'`, (b) the resulting `gateKey` ends in `:${INSTANCE_NONCE}`, (c) `runId` itself is NOT in the log line.
  - **Scenario 3 (askedAt hoist)**: Call `cockpit_gate_open` twice for the same input (same `runId`, same `issueRef`/`gateType`/`generation`). Assert both POSTed bodies contain the same `askedAt` value (byte-identical frames — US2 correctness independent of cloud dedup).
  - **Scenario 4 (ack passthrough)**: Call `cockpit_gate_ack` with `runId: 'RA'` on input. Assert (a) the schema accepts the field (no `invalid-args`), (b) the outbound `gate-outcome` body is unchanged from the no-runId call.

- [ ] **T010** [P] [US2] Extend `packages/generacy/src/cli/commands/cockpit/mcp/__tests__/parity-gate-ack.test.ts` for the ack schema passthrough case.
  - Assert `GateAckInputSchema.safeParse({ ...validAckInput, runId: 'RA' })` returns `success: true`.
  - Assert the omit-runId case still parses (`success: true`).
  - Assert empty-string `runId` returns `success: false` with `invalid-args`-shaped error.

- [ ] **T011** [US1] Extend `packages/orchestrator/src/__tests__/cockpit-gates-integration.integration.test.ts` (from #1024) with the FR-008 round-trip scenario.
  - Drive `phase-queue:P2` for `christrudelpw/snappoll#1` to `applied` via the fake peer with `runId="RA"` (Run A).
  - Re-emit the same natural gate with `runId="RB"` (Run B).
  - Assert the peer sees TWO distinct `gate-open` frames with different `gateId`s (SC-001).
  - Assert both are visible as `open` from the peer's inbox view (SC-005 replay).
  - Assert exactly ONE frame per within-run open — i.e. two calls in Run A with `runId="RA"` produce one frame at the peer, not two (SC-002).

**Note**: T009, T010, T011 touch disjoint files — parallel-safe with each other.

---

## Phase 5: Verification & Changeset
<!-- Phase boundary: Complete Phase 4 before starting Phase 5 -->

- [ ] **T012** [US1] [US2] Write `.changeset/1053-run-scoped-gate-key.md`.
  - `@generacy-ai/cockpit` — **minor** (new public capability: `deriveGateKey` accepts optional `runId` parameter).
  - `@generacy-ai/generacy` — **minor** (new public MCP-tool input surface: `GateOpenInputSchema.runId` and `GateAckInputSchema.runId`).
  - Single changeset file listing both bumps (per CLAUDE.md gate: "list every package whose non-test src/ changed").
  - Body summary references issue #1053 and mentions the follow-up PR (FR-004/005/007) gated on generacy-cloud#887.

- [ ] **T013** [US1] Re-pin `packages/claude-plugin-cockpit/tests/playbook-verification.test.ts` for every heading and contract rule this edit changes.
  Files edited by this issue: **NONE in this repo.** Spec + plan reference `packages/claude-plugin-cockpit/commands/auto.md` only in the sibling `agency/` repo (FR-006, explicitly out of scope for this PR per plan §Out of Scope).
  Pin sites that read the edited file(s): **N/A — the `packages/claude-plugin-cockpit/` directory does not exist in this repo.**
  Re-pinning means updating the assertion to the NEW contract.
  Do NOT weaken or delete an assertion to make the test pass — the pin is a drift audit; weakening it deletes its value.
  **Verify manually before shipping**: (a) confirm no `packages/claude-plugin-cockpit/**` files are touched in the final diff, and (b) when the FR-006 companion PR lands in the `agency/` repo, its `/tasks` run must emit its own re-pin task against that repo's `playbook-verification.test.ts` — track cross-repo coordination there, not here.

- [ ] **T014** [US1] [US2] Manual field-instance replay (SC-005). See `quickstart.md`.
  - Re-run `/cockpit:auto --gates=ui christrudelpw/snappoll#1` post-fix against an epic previously driven to `applied` on phase P2.
  - Assert the P2 gate opens fresh in the inbox and the run proceeds past it.
  - Assert cluster logs show `event: 'cockpit_gate_open.runid-source'` at `info` with a plausible `runIdSource` value.

---

## Dependencies & Execution Order

**Phase boundaries** (sequential):
- Phase 1 (canonical `@generacy-ai/cockpit` derivation) → Phase 2 (MCP mirror + input schemas) → Phase 3 (tool wiring) → Phase 4 (tests) → Phase 5 (verification + changeset).
- Rationale: T003 mirrors T001's signature; T006/T007 depend on the extended schema surface from T004; T009/T010/T011 depend on landed tool changes.

**Parallel opportunities within phases**:
- **Phase 1**: T002 depends on T001 (tests exercise the extended signature). Sequential within Phase 1.
- **Phase 2**: T003 → T004 → T005 sequential (same file cascade).
- **Phase 3**: T006 and T007 both edit `cockpit_gate_open.ts` — same-session edits, not parallel. T008 edits `cockpit_gate_ack.ts` — `[P]` parallel-safe with T006/T007.
- **Phase 4**: T009, T010, T011 edit disjoint test files — all three `[P]` parallel-safe.
- **Phase 5**: T012, T013, T014 are independent — parallel-safe. T014 is a manual reproduction; T012 is a file write; T013 is a documented no-op verification.

**Critical path**: T001 → T003 → T004 → T006 → T007 → T009 → T012.

**Estimated effort**: ~120 LOC across 4 source files + 3 test files + 1 changeset. Suggested single sprint session.

---

## Notes on Deferred Work

- **FR-004, FR-005, FR-007** (terminal-collision detection + `'terminal-collision'` `ErrorClass` + ack-path parity): follow-up PR gated on **generacy-ai/generacy-cloud#887**. Contract shape captured in `contracts/terminal-collision-error.md`. Not part of this task list.
- **FR-006** (`/cockpit:auto` skill-side handler for the error class): companion `agency/packages/claude-plugin-cockpit/commands/auto.md` PR. Not part of this task list.
- **SC-003, SC-007**: scored by the follow-up PR only. This PR does not regress them (both are currently `0%` and will remain `0%` until the follow-up ships).

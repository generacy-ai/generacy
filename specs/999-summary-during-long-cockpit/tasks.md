# Tasks: Keep the active epic bus + buffer warm across long quiet phases

**Input**: Design documents from `/specs/999-summary-during-long-cockpit/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/shared-quiet-horizon.md, quickstart.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Core Implementation

- [X] T001 [US1] Add exported constant `DEFAULT_QUIET_HORIZON_MS = 7_200_000` to `packages/generacy/src/cli/commands/cockpit/mcp/event-bus.ts` with the JSDoc from contracts/shared-quiet-horizon.md ("Shared default horizon (ms) for BOTH the in-memory buffer retention window AND the registry's idle-TTL... changes both call sites in lockstep — FR-003."). Change the `EpicEventBus` constructor default at line 132 from `?? 600_000` to `?? DEFAULT_QUIET_HORIZON_MS`. No other change; `retentionCount` default at line 131 stays at 10_000 (FR-005). (FR-001, FR-002, FR-003, C-001, C-002)

- [X] T002 [US1] Wire the shared constant into `packages/generacy/src/cli/commands/cockpit/mcp/event-bus-registry.ts`: add `import { DEFAULT_QUIET_HORIZON_MS } from './event-bus.js';`, change line 43 from `const DEFAULT_IDLE_TTL_MS = 600_000;` to `const DEFAULT_IDLE_TTL_MS = DEFAULT_QUIET_HORIZON_MS;` (keep the named local — the `parsePositiveIntEnv(..., options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS, 'COCKPIT_MCP_BUS_IDLE_TTL_MS', ...)` call site is unchanged), and update the module header JSDoc at lines 16-18 to reflect `default 7_200_000` (was `600_000`) and reference the shared constant. Depends on T001 (import target must exist). (FR-001, FR-003, FR-004, C-002, C-003)

## Phase 2: Regression Tests

- [X] T003 [P] [US3] Append two cases to `packages/generacy/src/cli/commands/cockpit/mcp/__tests__/event-bus.test.ts`: (a) `expect(DEFAULT_QUIET_HORIZON_MS).toBe(7_200_000)` plus a positive-integer guard (`Number.isInteger(...)` and `> 0`) — trips on any accidental future edit to a different literal (SC-005 enforcement). (b) Constructing `new EpicEventBus({ epic: 'x' })` (no `retentionMs` option) yields a bus whose observable trim boundary equals `DEFAULT_QUIET_HORIZON_MS` — assert by observed behaviour (an entry emitted at `t=0` is present at `t = DEFAULT_QUIET_HORIZON_MS - 1` and trimmed at `t = DEFAULT_QUIET_HORIZON_MS + 1`), consistent with the "test-visible surface" note in data-model.md §Test-visible surface. Import `DEFAULT_QUIET_HORIZON_MS` from `../event-bus.js`. (FR-003, FR-008, SC-005)

- [X] T004 [P] [US3] Append two cases to `packages/generacy/src/cli/commands/cockpit/mcp/__tests__/event-bus-registry.test.ts`, following the existing fake-timer pattern at lines 63-90 (`vi.useFakeTimers()` + `vi.advanceTimersByTimeAsync()`; teardown already handled by the existing `afterEach` at lines 31-34). Case (a) SC-001/FR-008(a) — "≥10-min quiet, ≤120-min horizon → cursor still classifies `valid`": acquire a bus with injected `idleTtlMs: 60_000` (and matching bus-side `retentionMs`), issue a cursor, release to refCount 0, advance fake time past the *old* 10-min TTL but well below the injected horizon, re-acquire and drain, assert the pre-gap cursor classifies `valid` and the returned bus's `busNonce` matches the pre-gap value. Include an inline comment naming the "old 10-min TTL, new 120-min horizon" scaling relationship so a reader understands what the injected horizon stands in for (R5). Case (b) SC-003/FR-008(b) — "gap exceeds new horizon → bus IS torn down": same injected horizon, advance fake time past `idleTtlMs + 1`, re-acquire, assert the returned bus's `busNonce` is DIFFERENT from the pre-gap value (idle-TTL reclaim still fires — no leak). (FR-006, FR-008, C-005, SC-001, SC-003)

## Phase 3: Release Gate

- [X] T005 [US1] Create `.changeset/999-shared-quiet-horizon.md` — `patch` bump for `@generacy-ai/generacy`, one-line description referencing the shared horizon constant and the FR-001/FR-002 defaults raise. Must be a **newly added** file (CI gate greps `--diff-filter=A`; editing an existing changeset does not satisfy it). Label context: `workflow:speckit-bugfix`. (FR-009, CLAUDE.md changeset gate)

## Dependencies & Execution Order

**Sequential:**
- T001 → T002 (T002 imports the identifier T001 exports; running T002 first breaks the build)
- T001 → T003 (T003 imports `DEFAULT_QUIET_HORIZON_MS`)
- T002 → T004 (T004 exercises `acquireEpicBus` idle-TTL behaviour; the shared-constant wiring must be in place to keep the test asserting the production path, not a stale one)

**Parallel within Phase 2:**
- T003 [P] and T004 [P] touch different test files with no shared fixtures — safe to run concurrently once T001/T002 land.

**T005** may be authored at any point but must be committed in the same PR as T001–T004 (CI gate).

**Playbook coupling check**: `spec.md`/`plan.md`/contracts/ contain zero references to `packages/claude-plugin-cockpit/commands/*.md`. No `playbook-verification.test.ts` re-pin task required.

## Success Criteria Coverage

| SC | Covered by |
|----|-----------|
| SC-001 (zero cursor recoveries in a multi-hour manual run) | T001 + T002 (fix); manual validation via quickstart.md §Manual Verification |
| SC-002 (per-epic bus survival) | T004 case (a) |
| SC-003 (idle reclaim still fires) | T004 case (b) |
| SC-004 (memory bound on chatty epics) | Preserved by no-change to `retentionCount = 10_000` (T001 note) |
| SC-005 (constant lockstep) | T001 (single exported constant) + T002 (imports it) + T003 case (a) (value guard) |

## Next Step

`/speckit:implement` to begin execution.

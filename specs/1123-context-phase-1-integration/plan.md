# Implementation Plan: Review/remediate foundations wired end-to-end (stub executors)

**Feature**: Phase-1 integration checkpoint proving #1121 (phase machinery) + #1122 (per-workflow config) are wired together, via integration tests with stub review/remediate executors plus a shipped `remediate → review` seam contract.
**Branch**: `1123-context-phase-1-integration`
**Status**: Complete

## Summary

This issue ships **no product behavior**. It ships:

1. An **integration test harness** that drives the worker phase loop (`PhaseLoop.executeLoop`) end-to-end with **stub** review/remediate executors, proving:
   - `review` is sequenced immediately after `implement` for both `speckit-feature` and `speckit-bugfix` (FR-002).
   - `remediate` is reachable **off-sequence** via a direct loop-control return value and **always backtracks to a re-`review`** on completion (FR-003).
   - `maxRemediations` (feature 3 / bugfix 2) and the review profile are **observable inside the loop** via the `@generacy-ai/config` object the worker already holds (FR-004).
2. A **pause/resume round-trip test** (FR-005) proving `review` resumes to `review` and `remediate` resumes to `remediate` (Q3=A) with symmetric label apply/clear and no stranding, via the existing pause-context sidecar (merge-conflict precedent).
3. A **phase-union sync audit** (FR-006) that fails on drift between the `WorkflowPhase` union and every companion enumeration — including the two hand-maintained runtime `z.enum` duplicates that today are silently drift-prone.
4. A **shipped contract note** (FR-007) pinning the `remediate → review` loop-control seam so P2/P3 build against a stable, documented boundary.

The gate/stage naming that clarification **Q5=C deferred to plan** is resolved here (see [Resolved plan decisions](#resolved-plan-decisions)).

## Dependencies & landing order (Q1=B)

- **#1121** (phase machinery) merges to `develop` first. It adds `review`/`remediate` to the `WorkflowPhase` union **and** must update every companion enumeration to compile/round-trip (see [Companion-table inventory](#companion-table-inventory)). It is also the expected owner of the **off-sequence loop-control entry mechanism** (see [Integration risks](#integration-risks)).
- **#1122** (per-workflow config) merges to `develop` first. Per its Q1=A the `maxRemediations` + review-profile schema lives in `@generacy-ai/config` `OrchestratorSettings`; per its Q4=A resolved values come from a `worker/config.ts` resolver over the settings the worker already loaded.
- This branch is **rebased** on both and ships **only** tests + the contract note. It does **not** co-land the union/config additions and does **not** use test-only doubles for the union (FR-006's audit must run on the real production union). **The implement phase blocks until #1121/#1122 land on `develop`.**

## Technical Context

- **Language / runtime**: TypeScript, ESM, Node >= 22.
- **Test framework**: Vitest (existing `packages/orchestrator/src/worker/__tests__/*.test.ts`).
- **Primary package**: `@generacy-ai/orchestrator` (`packages/orchestrator`).
- **Consumed packages**: `@generacy-ai/config` (`OrchestratorSettings`), `@generacy-ai/workflow-engine` (`GitHubClient`).
- **No new runtime dependencies.**

### Grounding — current code (pre-#1121/#1122, verified on this branch)

| Concern | Location | Current shape |
|---|---|---|
| Phase union | `packages/orchestrator/src/worker/types.ts:9` | 6 phases: `specify\|clarify\|plan\|tasks\|implement\|validate` |
| Ordered sequence | `types.ts:50-52` | `PHASE_SEQUENCE` (array — **not** compile-enforced) |
| Per-workflow sequences | `types.ts:58-62` | `WORKFLOW_PHASE_SEQUENCES` (feature/bugfix = full; epic truncated) |
| Stage type | `types.ts:75` | `specification\|planning\|implementation` (no new stage — Q5=C / #1121 FR-002) |
| Phase→stage map | `types.ts:80-87` | `PHASE_TO_STAGE` — **total `Record<WorkflowPhase, StageType>`** (compile-enforced) |
| Gate mapping | `phase-resolver.ts:9-17` | `GATE_MAPPING` keyed by **gate label** (not a total Record over phase) |
| Workflow gate overrides | `phase-resolver.ts:27-33` | `WORKFLOW_GATE_MAPPING` (epic-only) |
| Phase loop | `phase-loop.ts:204-…` | index-based `for (i = startIndex; i < sequence.length; i++)`; retries via `i--; continue;` |
| Loop result discriminator | `phase-loop.ts:111-139` | `PhaseLoopStatus = completed\|gate-hit\|phase-failed\|failed-terminal` (**no `next` / off-sequence outcome yet**) |
| Pause-context sidecar | `pause-context.ts` | `writePauseContext`/`readPauseContext`/`clearPauseContext`; **own hardcoded `WorkflowPhaseSchema` z.enum at `:28-35`** |
| Worker gate/config | `config.ts` | `GateDefinitionSchema` **hardcodes a phase `z.enum` (6 phases)**; `WorkerConfigSchema.gates` per workflow |
| Existing tests | `__tests__/types.test.ts` | Tests `getPhaseSequence`/`WORKFLOW_PHASE_SEQUENCES` only — **no exhaustive union↔companion audit** |
| Test harness pattern | `__tests__/phase-loop.test.ts:42-116` | `createMockDeps()` / `createMockContext()` / `createConfig()` inject `PhaseLoopDeps` |

### Companion-table inventory

The `WorkflowPhase` union has **five** companions that must enumerate every phase. Only the first is compile-enforced; the rest silently drift — exactly the class FR-006 closes:

1. `PHASE_TO_STAGE` (`types.ts:80`) — total `Record<WorkflowPhase, StageType>` — **compile-enforced**.
2. `PHASE_SEQUENCE` / `WORKFLOW_PHASE_SEQUENCES` (`types.ts:50,58`) — arrays — **not enforced**.
3. `pause-context.ts` `WorkflowPhaseSchema` (`:28-35`) — runtime `z.enum` — **not enforced**. Load-bearing for FR-005: if it omits `review`/`remediate`, `readPauseContext` returns `null` → fail-loud → stranding.
4. `config.ts` `GateDefinitionSchema` phase `z.enum` — runtime — **not enforced**.
5. `GATE_MAPPING` (`phase-resolver.ts:9`) — keyed by **gate label**, so it is *not* a total Record over `WorkflowPhase` and is **exempt** from the exhaustive audit (a phase may legitimately have no gate — e.g. autonomous `review`).

#1121 owns updating 1–4 when it expands the union. #1123's FR-006 audit asserts 2–4 stay in sync (1 is already caught by `tsc`).

## Resolved plan decisions

Clarification **Q5=C** deferred stage/gate naming to this plan. Resolutions:

- **PD-1 — Stage assignment.** `review → implementation`, `remediate → implementation`. Forced by #1121 FR-002 and by `PHASE_TO_STAGE` being a total Record (won't compile otherwise). No new `StageType`.
- **PD-2 — `review` is autonomous: no gate label.** The design's only human gates are remediation-limit and final approval, neither of which is `review`. So **no `waiting-for:review` gate** and **no `GATE_MAPPING` entry** for `review`. Pause/resume of `review` rides the **phase-agnostic pause-context sidecar** (merge-conflict precedent) — it carries the exact phase in-band, so resume resolves to `review` with no gate table involved.
- **PD-3 — `remediate` pause/resume rides the same sidecar → resumes to `remediate`** (Q3=A). No `GATE_MAPPING` entry is wired here. The design's forward-looking human gate name is **`waiting-for:remediation-limit`** (documented in the contract as the intended P3 label) but its **enforcement is out of scope** (P3). #1123 neither wires nor tests the remediation-limit gate.
- **PD-4 — FR-005 tests assert behavior, not names.** Per Q5=C, tests assert *that* the sidecar round-trips `review→review` / `remediate→remediate` and that `waiting-for:*` / `phase:*` / `agent:*` labels apply and clear symmetrically — not any specific label string. This keeps #1123 from hardcoding design-wrong or upstream-owned label names.
- **PD-5 — Loop-control seam is documented as `{ next: <phase> }`.** The FR-007 contract pins: `remediate` is entered **only** via a loop-control return value `{ next: 'remediate' }` (never by linear advance, never directly by a review verdict, never by a gate); on completion `remediate` returns `{ next: 'review' }` (always backtrack). This single discriminated outcome is the seam-of-record for all three future entry points (review verdict, validate failure, PR feedback).

## Deliverables (files)

All under `packages/orchestrator/src/worker/__tests__/` unless noted. **Test-only** except the contract doc — so the changeset gate's test-only exemption applies (see [Changeset](#changeset)).

| File | Purpose | FR |
|---|---|---|
| `phase-loop.review-remediate.integration.test.ts` (NEW) | Drives the loop with stub review/remediate executors; asserts implement→review sequencing, off-sequence remediate→review backtrack, per-workflow config observability. | FR-001/002/003/004 |
| `pause-resume.review-remediate.test.ts` (NEW) | Pause-context round-trip for `review`/`remediate` + symmetric label apply/clear. | FR-005 |
| `types.test.ts` (EXTEND) | Add exhaustive union↔companion audit (sequences + both runtime z.enums); mutation-sensitive. | FR-006 |
| `specs/1123-context-phase-1-integration/contracts/remediate-review-seam.md` (NEW) | The durable `remediate → review` loop-control contract. | FR-007 |

Optionally, a **load-bearing code comment** may be added at the loop-control site in `phase-loop.ts` cross-linking the contract doc — but the `contracts/` doc is the primary shipped artifact (unambiguously within Q1=B "only tests + the contract note").

## Test design

### FR-001/002/003 — loop traversal harness

- Reuse the `createMockDeps()` / `createMockContext()` / `createConfig()` pattern from `phase-loop.test.ts:42-116`.
- Inject **stub** review/remediate executors through the existing `PhaseLoopDeps` seam (the same seam `cliSpawner.spawnPhase` uses). The stub returns a **controllable** loop-control outcome so the harness can steer: first `review` pass → `{ next: 'remediate' }`; `remediate` → `{ next: 'review' }`; second `review` pass → advance.
- Assert, per workflow (`speckit-feature`, `speckit-bugfix`):
  - `review` runs immediately after `implement` (SC-002).
  - `remediate` runs off-sequence and control returns to a `review` pass, **not** the next linear phase (SC-002).
  - No real review/remediation behavior, no PR posting, no severity gating (FR-008).

### FR-004 — per-workflow config observability

- Populate `OrchestratorSettings` (from `@generacy-ai/config`, resolved via the `worker/config.ts` resolver #1122 Q4 adds) with feature=3 / bugfix=2 `maxRemediations` + a distinct review profile per workflow.
- Assert the values are **readable inside the loop** via the held config object (not a new `WorkerConfig` field, not an injected loop dep — Q4=B) and differ per workflow (SC-003).

### FR-005 — pause/resume round-trip

- Drive `writePauseContext(workdir, workflowId, { phase, … })` then `readPauseContext(...)` for `phase: 'review'` and `phase: 'remediate'`; assert readback resolves to the same phase (Q3=A). This directly exercises companion #3 — the test **fails** if `pause-context.ts`'s z.enum omits the phase.
- Assert `labelManager` applies then clears the pause/`phase:*`/`agent:*` labels symmetrically — 0 residual labels (SC-004). Name-agnostic per PD-4.

### FR-006 — phase-union sync audit (mutation-sensitive)

Extend `types.test.ts` with assertions that fail on drift:
- Every `WorkflowPhase` appears in `PHASE_SEQUENCE`, and every `PHASE_SEQUENCE` member is a `WorkflowPhase`.
- Every `WorkflowPhase` is a key in `PHASE_TO_STAGE` (belt-and-suspenders alongside `tsc`).
- `pause-context.ts` `WorkflowPhaseSchema.options` set-equals the `WorkflowPhase` union.
- `config.ts` `GateDefinitionSchema` phase `z.enum` options set-equals the `WorkflowPhase` union.
- **Mutation check (SC-005)**: dropping `review`/`remediate` (or any phase) from any one companion turns the audit red. Verified by hand during review.

Deriving the union at runtime: since a TS type has no runtime members, seed the audit from a single source-of-truth array (e.g. `PHASE_SEQUENCE` for feature, which post-#1121 contains `review`; `remediate` is off-sequence so include an explicit `ALL_PHASES` constant #1121 should export, or assert against the `PHASE_TO_STAGE` keyset which is total). The audit asserts all four other companions equal that keyset.

## Constitution Check

No `.specify/memory/constitution.md` exists in this repo — no constitution gate to satisfy. General project gates that **do** apply:

- **Changeset gate** (`.github/workflows/changeset-bot.yml`): satisfied by the test-only exemption (see below).
- **CI green** on the PR (SC-001).

## Changeset

The only non-test file in the diff is the `contracts/*.md` doc, which lives under `specs/`, not `packages/*/src/`. Every `packages/*/src/` change is a `*.test.ts` file → the changeset gate's **test-only exemption** applies. **No `.changeset/*.md` is required.** (If a load-bearing comment is added to `phase-loop.ts`, that is a non-test `packages/*/src/` change and a `patch` changeset for `@generacy-ai/orchestrator` becomes required — prefer keeping the contract in `specs/` to stay changeset-free.)

## Integration risks

1. **Off-sequence loop-control mechanism must exist (from #1121).** `remediate` is not in the linear sequence, and the current loop advances by index only (`phase-loop.ts:275`). Something must let a step's outcome steer the loop off-sequence (`{ next: 'remediate' }`) and back (`{ next: 'review' }`). This is "phase machinery" and is the expected responsibility of **#1121**. **If #1121 delivers only the union + companion tables and not this mechanism, #1123 cannot ship "only tests"** and this becomes a blocker — surface immediately and coordinate scope with #1121 before implement. The contract doc (FR-007) pins the intended shape regardless.
2. **Runtime companion z.enums (#3, #4) must be updated by #1121.** They do not update automatically when the union type expands. FR-005 depends on companion #3. FR-006's audit is designed to make any such gap a **red test** — but if the gap exists after #1121 lands, #1123's own FR-005 test will fail until a fast-follow fixes #1121. File against #1121, do not patch here (Q1=B).
3. **#1122 resolver shape.** FR-004 reads via the `worker/config.ts` resolver #1122 Q4 defines. Confirm the resolver's function name/signature at implement time and read through it (not a re-derived path).

## Next step

`/speckit:tasks` to generate the dependency-ordered task list. The implement phase must **block** until #1121 and #1122 are merged to `develop` and this branch is rebased on them (Q1=B).

# Implementation Plan: `cockpit resume <issue-ref>` — re-arm a failed phase

**Feature**: New `generacy cockpit resume` subcommand that re-arms a failed phase in place so the label-monitor poll enqueues the issue and the worker's start-phase resolver picks the failed phase as `startPhase`. Enables auto-mode Requeue and makes failed-issue recovery a one-liner instead of by-hand label surgery.
**Branch**: `891-found-during-cockpit-v1`
**Status**: Complete

## Summary

`generacy cockpit resume <issue-ref>` is a new sibling to `cockpit advance` in `packages/generacy/src/cli/commands/cockpit/`. It performs engine-owned label surgery: on an issue carrying `failed:<phase>` (with or without `agent:error`), it defensively clears `agent:error`, `failed:<phase>`, and any stray `phase:<phase>`, then applies the `waiting-for:<preceding-gate>` + `completed:<preceding-gate>` + `agent:paused` triple that matches a naturally-paused-then-completed gate. The label-monitor's next poll then emits a resume event, the queue picks it up, and the worker's `PhaseResolver.resolveFromContinue` walks the preserved `completed:<earlier-phase>` chain to select the failed phase as `startPhase` — the exact behavior naturally-paused clusters have today.

The `<preceding-gate>` is derived (not hardcoded) by inverting `GATE_MAPPING` from `packages/orchestrator/src/worker/phase-resolver.ts` — the same map the resolver reads. For a given `failed:<phase>`, the verb finds gates whose `resumeFrom === <phase>` and prefers cross-phase entries over self-loops so a workflow-config change is automatically reflected. Phases with no candidate gate (`failed:specify`, `failed:plan`) fall to a refusal path that points the operator at `process:*` re-queue.

The verb is idempotent on non-failed issues (single-line explanation, exit 0) and refuses with evidence on ambiguous states (multiple `failed:*` labels, unknown `<phase>`, no preceding gate, conflicting `waiting-for:<other-gate>`) — no partial mutation, non-zero exit. The change is a pure-additive CLI surface plus a README doc block; no changes to the label monitor, the worker resolver, the phase loop, or the label protocol.

## Technical Context

- **Language / runtime**: TypeScript, Node.js >=22, ESM. Package `@generacy-ai/generacy` (`packages/generacy`).
- **CLI framework**: `commander` — same pattern as `advance.ts`.
- **Shared cockpit primitives**: `@generacy-ai/cockpit` (`CommandRunner`, `GhWrapper`, `GhCliWrapper`, `loadCockpitConfig`).
- **Gate-mapping source**: `packages/orchestrator/src/worker/phase-resolver.ts` — `GATE_MAPPING` and `WORKFLOW_GATE_MAPPING` are the authoritative phase→gate map. Cross-package import mirrors what other cockpit verbs already do (e.g., `gate-vocabulary.ts` imports `WORKFLOW_LABELS` from `@generacy-ai/workflow-engine`).
- **Phase sequence source**: `packages/orchestrator/src/worker/types.ts` — `PHASE_SEQUENCE` and `getPhaseSequence(workflowName)`.
- **Test runner**: Vitest (`packages/generacy/vitest.config.ts`).
- **New dependencies**: none. All primitives already available.
- **Files touched** (small, self-contained):
  - `packages/generacy/src/cli/commands/cockpit/resume.ts` — **NEW**. `resumeCommand()` + `runResume()`, shape mirrors `advance.ts`.
  - `packages/generacy/src/cli/commands/cockpit/gate-vocabulary.ts` — **MODIFIED**. Extend with `resolvePrecedingGate(phase, workflowName?)` and export inverted mapping. Rationale: `advance.ts` and `resume.ts` are the only cockpit consumers of gate-name semantics; extending this file preserves the "single source of truth for gate vocabulary" invariant already asserted by `SC-005` in `advance.test.ts`.
  - `packages/generacy/src/cli/commands/cockpit/index.ts` — **MODIFIED**. Register `resumeCommand()`; update file-header comment.
  - `packages/generacy/README.md` — **MODIFIED**. New `### cockpit resume` subsection under the CLI Commands / cockpit block, documenting ref forms, exit codes, labels added/removed, idempotency + refusal semantics.
  - `packages/generacy/src/cli/commands/cockpit/__tests__/resume.test.ts` — **NEW**. Full path-exhaustive suite (happy path per phase suffix, no-op path, four refusal branches, ref-grammar wiring, up-to-six-mutation ordering).
  - `packages/generacy/src/cli/commands/cockpit/__tests__/resume.regression.test.ts` — **NEW**. FR-009 end-to-end: labels the monitor sees + phase the resolver picks.
  - `packages/generacy/src/cli/commands/cockpit/__tests__/gate-vocabulary.test.ts` — **MODIFIED**. Extend with `resolvePrecedingGate` truth-table tests (one row per `failed:<phase>`).

## Constitution Check

No `.specify/memory/constitution.md` exists in the repo — no project-level constitutional constraints to verify. The change respects the standing generacy conventions:

- Additive-only CLI surface (new subcommand, no removed fields, no wire-format change).
- Cross-package coupling only through already-exported symbols (`GATE_MAPPING`, `WORKFLOW_GATE_MAPPING`, `PHASE_SEQUENCE`) — no new orchestrator internals leak into the CLI.
- Tests colocated under `packages/generacy/src/cli/commands/cockpit/__tests__/`.
- README as the documented contract surface for cockpit CLI verbs (per `auto.md`'s "package README (contract source)" convention).
- No new ESLint `no-restricted-imports` bypass — the resolver-grammar guard from #850 applies transitively to the new file.

## Project Structure

```
packages/generacy/
├── README.md                                          # MODIFIED — new "### cockpit resume" subsection
├── src/
│   └── cli/commands/cockpit/
│       ├── advance.ts                                 # UNCHANGED — shape reference
│       ├── resume.ts                                  # NEW — resumeCommand() + runResume()
│       ├── gate-vocabulary.ts                         # MODIFIED — export resolvePrecedingGate()
│       ├── index.ts                                   # MODIFIED — register resumeCommand()
│       ├── resolver.ts                                # UNCHANGED — resolveIssueContext (per #822/#850)
│       ├── exit.ts                                    # UNCHANGED — CockpitExit reuse
│       └── __tests__/
│           ├── resume.test.ts                         # NEW — path-exhaustive unit suite
│           ├── resume.regression.test.ts              # NEW — FR-009 end-to-end handoff
│           └── gate-vocabulary.test.ts                # MODIFIED — resolvePrecedingGate truth table

packages/orchestrator/                                 # UNCHANGED
└── src/worker/
    ├── phase-resolver.ts                              # source of GATE_MAPPING / WORKFLOW_GATE_MAPPING (imported, unchanged)
    └── label-manager.ts                               # unchanged — resume verb does not touch this code path
```

## Implementation Sequence

1. **Gate-inversion helper first** — extend `gate-vocabulary.ts` with `resolvePrecedingGate(phase: WorkflowPhase, workflowName?: string): PrecedingGate | { kind: 'no-preceding-gate' }`. Import `GATE_MAPPING` and `WORKFLOW_GATE_MAPPING` from `@generacy-ai/orchestrator/worker/phase-resolver` (add to package exports if not already exported). Return type carries `{ gateName, waitingLabel, completedLabel, sourcePhase }` on success.
   - Selection algorithm (deterministic):
     1. Build effective mapping = `GATE_MAPPING` overlaid with `WORKFLOW_GATE_MAPPING[workflowName]` (mirroring `PhaseResolver.getEffectiveGateMapping`).
     2. Filter to entries where `resumeFrom === phase`.
     3. If empty → `no-preceding-gate`.
     4. Prefer entries where `entry.phase !== phase` (cross-phase over self-loop).
     5. Among preferred entries, sort by `PHASE_SEQUENCE.indexOf(entry.phase)` — nearest predecessor wins.
     6. If only self-loops exist, return the first one in stable insertion order.
   - Add unit tests for every `failed:<phase>` → gate mapping: `validate→implementation-review`, `implement→tasks-review`, `tasks→plan-review`, `plan→no-preceding-gate`, `clarify→clarification` (self-loop chosen since `spec-review` also exists — document the tie-break), `specify→no-preceding-gate`.

2. **`resume.ts` command surface** — mirror `advance.ts` layout:
   - Commander subcommand with single `[issue]` argument. No `--force`, no `--gate` flag (gate is derived).
   - Optional `--workflow <name>` flag: when omitted, read `workflow:<name>` label from the issue; fall back to `speckit-feature`. Rationale: the effective gate mapping is workflow-scoped, and reading the issue's own workflow label matches the label-monitor's behavior (`resolveWorkflowFromLabels`).
   - Deps injection identical to `advance.ts` (`runner`, `gh`, `loadConfig`, `env`, `now`, `stdout`, `stderr`) so unit tests can stub every side-effect.
   - Routes issue-ref through `resolveIssueContext` (FR-005). NO direct `parseIssueRef` call — the ESLint `no-restricted-imports` rule from #850 applies to `packages/generacy/src/cli/commands/cockpit/**/*.ts` automatically.
   - `CockpitExit` used for all controlled exits. Exit codes match `advance.ts`:
     - `0` — happy path OR no-op (FR-003).
     - `2` — argument parsing failures (missing issue, malformed ref).
     - `3` — refusal (FR-004): ambiguous state or non-re-armable.
     - `1` — remote/transport failure (`gh` call error mid-sequence).

3. **`runResume` core logic** — sequential, fail-closed:
   - Resolve the issue context via `resolveIssueContext`.
   - Fetch labels via `gh.fetchIssueLabels(nwo, number)`.
   - Classify:
     - **No `failed:*` label** → FR-003 no-op. Print `issue <nwo>#<n> is not in a failed state (no failed:<phase> label); nothing to re-arm` and return.
     - **Multiple `failed:*` labels** → FR-004 refusal (evidence: names the conflicting labels).
     - **`failed:<phase>` where `<phase>` is not a known `WorkflowPhase`** → FR-004 refusal.
     - **`failed:<phase>` where `<phase>` has no preceding gate** (via `resolvePrecedingGate`) → FR-004 refusal (evidence: names `<phase>` and points at `process:*` re-queue).
     - **`waiting-for:<other-gate>` already present** (where `<other-gate>` ≠ the derived `<preceding-gate>`) → FR-004 refusal (evidence: names the conflicting waiting label).
     - **Happy path**: proceed to mutation.
   - Mutation ordering (per spec Assumptions §7 — additions first, then defensive removals — so mid-sequence failure leaves the issue "over-labeled" not "under-labeled"):
     1. `gh.addLabels(nwo, n, [waitingLabel, completedLabel, 'agent:paused'])` — single API call.
     2. `gh.removeLabels(nwo, n, [failedLabel, ...conditionalRemovals])` where conditional set is `agent:error`, `phase:<phase>` (only if present in the fetched label set) — one API call, or a per-label call chain matching whatever `GhWrapper` supports today.
   - Single log line per spec FR-010: `resumed <nwo>#<n>: re-armed phase=<phase> via preceding-gate=<preceding-gate>; added=[<add1>,<add2>,<add3>] removed=[<rem1>,...]`. Defensive removes that were no-ops (target label absent) are NOT reported.
   - Actor resolution (`resolveCockpitIdentity` from `shared/identity.ts`) is intentionally NOT required — no comment is posted. `advance.ts` posts a manual-advance comment as a ledger; `resume` doesn't need one, because the log line + the six labels + the next monitor poll already provide the audit trail.

4. **Register in `index.ts`** — add `import { resumeCommand } from './resume.js';` and `command.addCommand(resumeCommand());`. Update the file-header comment listing the verbs to include `resume` (per FR-006).

5. **README doc block** — add `### cockpit resume` under CLI Commands. Fields per FR-007:
   - Purpose (one sentence: re-arm a failed phase in place).
   - Accepted ref forms (bare number, `owner/repo#N`, full URL) — link to `resolveIssueContext` for details.
   - Exit codes (`0`, `1`, `2`, `3`) with meanings.
   - Labels added (`waiting-for:<preceding-gate>`, `completed:<preceding-gate>`, `agent:paused`).
   - Labels removed (`failed:<phase>`, `agent:error`, `phase:<phase>` — all defensive).
   - Idempotency semantics (non-failed → single-line no-op, exit 0).
   - Refusal semantics (four branches, non-zero exit with evidence, no partial mutation).
   - Example: `generacy cockpit resume generacy-ai/generacy#42` after a `failed:validate`.

6. **Unit tests** (`resume.test.ts`) — mirror `advance.test.ts` layout:
   - **FR-008 (a)** happy path per phase suffix. One test per `failed:<phase>` with a valid preceding gate — `validate`, `implement`, `tasks`, `clarify`. Assert the exact `addLabel` / `removeLabel` call sequence, the log line, and exit code 0.
   - **FR-008 (b)** no-op path: labels don't contain any `failed:*` → zero mutating `gh` calls, exit 0, single-line stdout.
   - **FR-008 (c)** each of the four FR-004 refusal branches:
     - Multiple `failed:*` labels present.
     - `failed:<unknown-phase>`.
     - `failed:specify` and `failed:plan` (no preceding gate; evidence line names `process:*`).
     - `failed:<phase>` with `waiting-for:<other-gate>` present.
     - Assert exit code 3, evidence line on stderr (`CockpitExit.message`), and zero mutating `gh` calls.
   - **FR-008 (d)** issue-ref grammar wiring — mirror `advance.test.ts` "bare-number ref resolution (#850)" block:
     - Bare-number: infers repo from git origin, calls `fetchIssueLabels(owner/repo, N)`.
     - Unresolvable origin: `CockpitExit(2)` with the exact copy asserted by advance.test.ts.
     - `owner/repo#N` regression: no runner call for `git remote get-url origin`.
   - **FR-002 ordering** invariant: additions before removals — inspect the `gh.addLabels` / `gh.removeLabels` call order in the mock and assert `addLabels` fires first.
   - **Q3 defensive removal** invariant: `phase:<phase>` and `agent:error` are removed only if present. Two tests: one with both present, one with both absent (log line reports the shorter mutation list).

7. **Regression test** (`resume.regression.test.ts`) — FR-009 end-to-end handoff:
   - Fixture: a `failed:validate` speckit-feature issue with realistic prior state: `{failed:validate, agent:error, phase:validate, completed:specify, completed:clarify, completed:plan, completed:tasks, completed:implement, workflow:speckit-feature}`.
   - Run `runResume` against a stubbed `gh` that records every mutation.
   - After `runResume` returns, apply the recorded mutations to the fixture label set to produce the post-resume label set.
   - **Monitor assertion**: instantiate `parseLabelEvent` (or its private-equivalent detection predicate) from `label-monitor-service.ts` against the post-resume label set and the newly-added `completed:implementation-review`. Assert that a `LabelEvent` of `type: 'resume'` is produced.
   - **Resolver assertion**: instantiate `PhaseResolver` and call `resolveStartPhase(postResumeLabels, 'continue', 'speckit-feature')`. Assert return value is `'validate'`.
   - Prior-phase `completed:*` chain preservation: assert `completed:specify`, `completed:clarify`, `completed:plan`, `completed:tasks`, `completed:implement` all appear in the post-resume label set (per Q5 / spec Acceptance §3).

8. **`gate-vocabulary.test.ts` extension** — one describe block: `resolvePrecedingGate truth table`. One `it` per phase: `validate → implementation-review`, `implement → tasks-review`, `tasks → plan-review`, `plan → no-preceding-gate`, `clarify → clarification` (documented tie-break), `specify → no-preceding-gate`. Cross-check for `speckit-epic` workflow — assert `tasks-review` mapping still resolves per the workflow-specific overlay.

## Cross-Package Import Note

`GATE_MAPPING` and `WORKFLOW_GATE_MAPPING` currently live at `packages/orchestrator/src/worker/phase-resolver.ts` and are NOT in the orchestrator package's public exports (`packages/orchestrator/src/index.ts` — TBD verification during implementation). If they are not exported, add them to the orchestrator package's public surface:

```ts
// packages/orchestrator/src/index.ts (or the closest public entry)
export {
  GATE_MAPPING,
  WORKFLOW_GATE_MAPPING,
  type PhaseResolverGateEntry,  // if not already named
} from './worker/phase-resolver.js';
```

Alternative (if cross-package coupling to the orchestrator internals is unwanted): duplicate the map into `packages/workflow-engine` (already the home of `WORKFLOW_LABELS`) as a shared source, and have both `phase-resolver.ts` and `gate-vocabulary.ts` consume from there. Planning-phase decision: prefer the direct export from orchestrator (single source of truth, no drift risk) unless the implementation phase surfaces a circular-import concern.

## What This Plan Does NOT Do

Per spec Out of Scope, and re-affirmed here so the tasks phase doesn't drift:

- **No auto-mode gate change**: The auto.md D.7/D.8 wording flip lands where the auto-mode gate does (sibling change). This plan ships the `resume` primitive only. FR-009 proves the primitive end-to-end so the auto-mode wiring is a small connect-and-verify.
- **No re-validate-on-base-advance flow**: Filed separately in the issue body.
- **No changes to the label protocol** (`waiting-for:*` / `completed:*` / `agent:paused` semantics unchanged).
- **No changes to `label-monitor-service.ts`** or `phase-resolver.ts` — the verb writes labels that satisfy the *existing* detector and resolver. The regression test (FR-009) verifies this by construction.
- **No `--force` flag** (parity with `advance.ts`).
- **No GitHub API "transaction" wrapper** for the up-to-six-label mutation — additions first, then removals, per spec Assumptions §7.
- **No batch / multi-issue mode** (`resume <ref1> <ref2>`). Single-issue only.

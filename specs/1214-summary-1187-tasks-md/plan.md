# Implementation Plan: Manual-task awareness in the #1187 tasks.md safety net

**Feature**: The #1187 tasks.md safety net treats every unchecked task as automatable work and re-enters implement; manual-verification tasks (browser checks, deploy checklists) stay unchecked by design, so the second pass makes no progress and the no-progress guard fails complete-and-green stories with `failed:implement` + `failed:implement-repeated`. This adds manual-task classification and a `waiting-for:manual-validation` pause path.
**Branch**: `1214-summary-1187-tasks-md`
**Status**: Complete

## Summary

Three composable changes, all inside `packages/orchestrator/src/worker/`:

1. **Classification** (FR-005/006/007, Q2=B, Q3=A): `countTasks` in `tasks-md-fallback.ts` learns to classify each unchecked task as *manual* or *automatable* via a two-tier rule — the literal `[manual]` bracketed token anywhere in the task line (both grammars), else case-insensitive keyword (`manual`, `manually`, `hand-test`) in the **first 4 words** of the task text after the checkbox/ID. The marker never affects checked/unchecked counting and never interacts with the strict `HEADING_DONE` `[DONE]`-after-ID rule. `TasksMdEvaluation` gains a `manual-only` variant (all unchecked tasks classify manual) and the `incomplete` variant gains `automatable`/`manual` counts.

2. **Safety-net pause path** (FR-001..004, FR-007/008, Q1=A, Q4=A, Q5=A): in the `phase-loop.ts` safety-net block (`:914-952`), a label pre-check runs first — when `waiting-for:manual-validation` is on the issue, partial synthesis is suppressed unconditionally (divergence logged if classification disagrees); label-read failure falls back to classification (fail-open to classification, never blind re-entry). When the label is present OR the evaluation is `manual-only`, the engine runs the pause sequence: WIP commit/push via `prManager.commitPushAndEnsurePr` honoring `pushRefused` (#1051 abort) → propagate `prUrl` → `onPhaseComplete('implement')` (grants `completed:implement`, per the #1133 completed-at-pause precedent) → `onGateHit('implement', 'waiting-for:manual-validation')` → return `gateHit: true`. Mixed remainders (automatable > 0, no label) synthesize `tasks_remaining` from the **automatable** count only and re-enter as today.

3. **No-progress guard pause** (FR-009/010): when the guard fires (`tasksRemaining >= lastTasksRemaining`) it re-evaluates the remainder (label + tasks.md classification); a human-gated remainder pauses via the same sequence instead of `failed:implement` escalation. Automatable-remainder behavior is byte-identical to today.

Zero new label vocabulary (FR-012/SC-008): `waiting-for:manual-validation`, `completed:manual-validation`, and the `GATE_MAPPING['manual-validation'] = { phase: 'validate', resumeFrom: 'validate' }` entry all exist. Assumption 4 confirmed at plan time: no `DEFAULT_RESUME_RETAIN_SUFFIXES` change — the gate resumes at `validate` (past the gate check), so the standard resume strip is correct, and `completed:implement` is a phase completion the strip never touches.

## Technical Context

- **Language/runtime**: TypeScript, Node >= 22, ESM. Vitest for tests.
- **Package**: `@generacy-ai/orchestrator` only. No new dependencies.
- **Key existing seams**:
  - `PhaseLoopDeps.evaluateTasksMd?: (context: WorkerContext) => TasksMdEvaluation` (`phase-loop.ts:199`) — injectable evaluator, default wired in `claude-cli-worker.ts` (#1187).
  - Safety-net block at `phase-loop.ts:914-952`, gated `phase === 'implement' && result.success && result.implementResult === undefined`.
  - #1211 dependency-block branch (`phase-loop.ts:954-1064`) — the structural template for WIP-commit-then-gate (Q5=A mirrors it exactly).
  - #1133 on-ci-green gate (`phase-loop.ts:1923-1952`) — the completed-at-pause precedent (Q1=A); its comment at `:1930-1932` claims "the one gate where `completed:<phase>` is granted at pause" and MUST be updated (manual-validation becomes the second).
  - No-progress guard at `phase-loop.ts:1071` in the increment block.
  - `LabelManager.onPhaseComplete` / `onGateHit` — ordering safe against the #958 assumption at `label-manager.ts:287-292` because `onPhaseComplete` already removed `phase:implement`, making `onGateHit`'s removeLabels a no-op (identical to the ci-green path).
- **Label read**: `context.github` issue-label read wrapped in try/catch; failure → classification fallback (Q4=A). Divergence (label present + automatable unchecked > 0) logged with the structured shape used at `phase-loop.ts:928-946`.
- **No feature flag**: correctness fix; inert for stories without manual tasks or the label (US4/SC-006). No new persisted state — labels + tasks.md are the only inputs (FR-013).

## Project Structure

```
packages/orchestrator/src/worker/
├── tasks-md-fallback.ts                 # MOD: classification + manual-only variant (FR-005..007)
├── phase-loop.ts                        # MOD: label pre-check, pause sequence, guard pause,
│                                        #      #1133 comment update (FR-001..004, 008..011)
└── __tests__/ (or co-located *.test.ts per existing layout)
    ├── tasks-md-fallback.test.ts        # MOD: classification matrix, #2723/#2714 fixtures (SC-009)
    └── phase-loop.manual-validation.test.ts  # NEW: pause paths, label precedence, guard behavior
.changeset/1214-manual-task-safety-net.md    # implement time: @generacy-ai/orchestrator patch
```

## Constitution Check

No `.specify/memory/constitution.md` in the repo — check skipped.

## Design Details

### D-1: Classification lives in `countTasks` (pure), variants in the evaluator

`countTasks(content)` return widens to `{ unchecked, checked, total, manual }` where `manual` counts unchecked tasks classified manual (checked manual tasks are just checked — classification only matters for the remainder). `evaluateTasksMd` derives `automatable = unchecked - manual` and classifies:

- `unchecked === 0` → `complete` (unchanged, includes zero-task-lines).
- `unchecked > 0 && automatable === 0` → **`manual-only`** (new).
- `automatable > 0` → `incomplete` with `{ unchecked, automatable, manual, checked, total }`.
- I/O / resolution failure → `unreadable` (unchanged).

### D-2: Two-tier detection (Q2=B, Q3=A)

- **Tier 1 — marker**: `/\[manual\]/i` anywhere in the task line. Checkbox: anywhere after `- [ ]`. Heading: anywhere after the task ID. Must not affect counting; a heading line can carry both `[DONE]` and `[manual]` (a checked manual task is simply checked).
- **Tier 2 — keywords**: only when no marker. Case-insensitive whole-word `\bmanual\b|\bmanually\b|\bhand-test\b` within the **first 4 words** of the task text (text after the checkbox capture / heading task-ID + optional `[DONE]`). Rejects mid-sentence noun uses ("update the user manual"). Mirrors the strict-positional discipline of `HEADING_DONE`.

### D-3: One pause path, two triggers

Both the label-present case (FR-001/002) and the `manual-only` case (FR-007) funnel through a single pause sequence in the safety-net block, mirroring #1211 structurally and #1133 for labels:

```
wip = prManager.commitPushAndEnsurePr('implement', { message: 'wip(speckit): pause for manual validation …' })
if (wip.pushRefused) return { results, completed: false, lastPhase: 'implement', gateHit: false }
if (wip.prUrl) context.prUrl = wip.prUrl
await labelManager.onPhaseComplete('implement')          // grants completed:implement (Q1=A)
await labelManager.onGateHit('implement', 'waiting-for:manual-validation')
return { results, completed: false, lastPhase: 'implement', gateHit: true }
```

Resume: operator applies `completed:manual-validation` → label monitor enqueues `continue` → `GATE_MAPPING['manual-validation'].resumeFrom = 'validate'` resolves cleanly because `completed:implement` exists (the entire point of Q1=A).

### D-4: Label precedence + fail-open (Q4=A)

Label read happens before the evaluator runs. Present → pause path unconditionally; if the (still-run, for logging) evaluation reports `automatable > 0`, emit a structured divergence warn so operators can spot agent mislabeling. Read failure → warn + proceed to classification as if label absent. Never fail-closed, never blind re-entry.

### D-5: Guard pause (FR-009/010)

In the guard branch at `phase-loop.ts:1071`, before `escalateAndAlert`: re-run the label check + evaluator. If label present or `manual-only` → pause path (D-3) instead of failure. Otherwise the existing failure path is untouched — `result.success = false`, evidence, error stage comment, escalation. This covers the sentinel-present case (agent emitted `SPECKIT_IMPLEMENT_PARTIAL` over a manual remainder) that the safety-net block never sees.

### D-6: Non-changes

- Sentinel grammar, `ImplementPartialResult`, increment re-loop mechanics: unchanged.
- `complete` / `unreadable` handling: byte-identical (US4, SC-005 fail-open preserved).
- `GATE_MAPPING`, label vocabulary, cockpit, label-monitor: zero changes.
- Non-manual counting: byte-identical (US2 acceptance — the classification is additive).

## Test Plan

- `tasks-md-fallback.test.ts` (MOD): marker-anywhere matrix (both grammars, trailing `[manual]`, `[DONE]`+`[manual]` co-presence), keyword first-4-words positives ("Manually verify …", "Hand-test the …") and negatives ("update the user manual", "add manuals directory"), counting invariance, `manual-only` vs mixed vs `complete` classification, **#2723 T028/T029 fixture** (keyword tier, SC-009) and **#2714 fixture** (marker tier).
- `phase-loop.manual-validation.test.ts` (NEW): label-present suppression + pause (SC-001), `manual-only` pause with label-order assertion (`completed:implement` before gate labels, SC-002), pushRefused abort, mixed remainder synthesizes automatable-only count (SC-003), guard pauses on human-gated remainder / unchanged otherwise (SC-004), label-read failure falls back to classification, divergence log shape, sentinel-present path untouched (SC-007).

## Changeset

At implement time: `.changeset/1214-manual-task-safety-net.md` — `@generacy-ai/orchestrator` **patch** (`workflow:speckit-bugfix`; internal worker fix, no new public exports, no new label vocabulary). The plan-phase commit touches only `specs/` + `CLAUDE.md` — no changeset now.

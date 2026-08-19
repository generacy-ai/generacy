# Research: Add `review` and `remediate` to the workflow phase machinery

**Issue**: generacy-ai/generacy#1121 | **Epic**: generacy-ai/generacy#1120

This document records the technology decisions behind the plan, each with rationale and the alternatives rejected. Decisions are keyed `D-N` and referenced from `plan.md`.

## Context recap

`WorkflowPhase` is a hand-maintained literal union in `packages/orchestrator/src/worker/types.ts`, re-duplicated as Zod enums, literal unions, and strict-object keys across ~10 sites in five packages. Adding a phase is a cross-cutting vocabulary edit. The clarifications (Q1–Q5) pin the behavior contract: `review` feature-flagged OFF (Q1=A), the existing gate stays on `implement` (Q2=A), full phase-progress label families for both phases (Q3=A), `remediate` reachable only in tests (Q4=A), and a committed audit test (Q5=A).

## D-1 — `PHASE_SEQUENCE` itself gains `review` (not a per-workflow override)

**Decision**: Insert `review` directly into the shared `PHASE_SEQUENCE` array (`['specify','clarify','plan','tasks','implement','review','validate']`) rather than adding it only to a `speckit-feature`/`speckit-bugfix` override while leaving `PHASE_SEQUENCE` untouched.

**Rationale**:
- `WORKFLOW_PHASE_SEQUENCES['speckit-feature']` and `['speckit-bugfix']` reference `PHASE_SEQUENCE` by identity; editing the shared array is the minimal change that satisfies FR-003 for both.
- `speckit-epic` already uses its own explicit `['specify','clarify','plan','tasks']` literal, so it is structurally immune to the `PHASE_SEQUENCE` edit (FR-003 "epic unchanged" holds by construction).
- The `label-protocol-audit` runtime probe iterates `PHASE_SEQUENCE` and calls `onPhaseStart`/`onPhaseComplete` for each member. Q3=A's stated assumption is that `phase:review`/`completed:review` become live vocabulary — which is only true if `review` is actually in the iterated sequence. Putting `review` in `PHASE_SEQUENCE` makes the audit's assumption and the label registration self-consistent.

**Alternatives rejected**:
- *Per-workflow override array*: would leave `PHASE_SEQUENCE` without `review`, so the audit probe would never register `phase:review`, contradicting Q3=A and forcing a second special-case in the audit.
- *A `review`-bearing constant separate from `PHASE_SEQUENCE`*: adds a parallel source of truth — exactly the duplication this issue is trying to contain.

## D-2 — `review` sits between `implement` and `validate`

**Decision**: Order is `... implement → review → validate`.

**Rationale**: The spec says "inserted after `implement`" (FR-003) and the epic framing is review-of-implementation. `validate` remains the terminal phase. Placing `review` before `validate` keeps `validate` last, preserving the meaning of the post-validate approval gate migration deferred to a later epic issue (Q2).

**Alternatives rejected**:
- *After `validate`*: contradicts "immediately after `implement`" and would reorder the terminal phase.

## D-3 — The two launcher `PhaseIntent['phase']` unions are left unchanged

**Decision**: Do **not** widen `packages/orchestrator/src/launcher/types.ts` (`PhaseIntent.phase`, :32) or `packages/generacy-plugin-claude-code/src/launch/types.ts` (:27), even though the spec's Context section enumerates them among the duplication sites.

**Rationale**:
- Both unions already exclude `validate` — they enumerate *provider-launchable CLI phases*, not the full `WorkflowPhase` vocabulary. They are an intentional subset, not a drifting duplicate.
- `PHASE_TO_COMMAND` in `generacy-plugin-claude-code/src/launch/constants.ts:7` is typed `Record<PhaseIntent['phase'], string>`. Widening `PhaseIntent['phase']` would force fabricated `/speckit:review` and `/speckit:remediate` command strings that no code path can legitimately invoke this issue (real executors are out of scope).
- Neither stub executor constructs a `PhaseIntent` — the stub path returns a synthetic success result without going through the launcher. So the runtime value set flowing through `PhaseIntent` is unchanged; leaving the type as-is is *correct*, not a shortcut.

**How the audit stays honest**: The new `phase-vocabulary-audit.test.ts` encodes these two unions (plus the timeout-override and overridable-phase lists) as **intentional subsets** with a documented reason, so a future reader who adds a real phase can see why they were excluded and decide deliberately.

**Alternatives rejected**:
- *Widen the unions + add fake command strings*: ships dead, misleading `/speckit:review` command literals; violates "stub wiring only" and invites a later caller to spawn a non-existent slash command.

## D-4 — Feature flag via `WorkerConfig.reviewPhaseEnabled` (default false) + env override

**Decision**: Gate `review` execution behind a single `WorkerConfig.reviewPhaseEnabled: z.boolean().default(false)` plus a `WORKER_REVIEW_PHASE_ENABLED` env read in `config/loader.ts`. The phase-loop skips `review` (before any side effect) when the flag is false.

**Rationale**:
- Q1=A requires byte-identical observable behavior in a live run: no `phase:review`/`completed:review` label, no stage comment, no journal entry. A single skip guard placed *before* `labelManager.onPhaseStart(phase)` achieves this with one branch.
- One config surface is easy to reason about and to flip on in the later epic issue that lands the real executor.

**Alternatives rejected**:
- *Execute-as-no-op success stub (Q1 option B)*: still emits `phase:review`/`completed:review` labels + stage/journal entries — an observable diff that violates SC-004/FR-009.
- *Execute the stub but suppress side effects at each callsite (Q1 option C)*: a fragile every-callsite carve-out; each new side-effect site becomes a place to forget the suppression.

## D-5 — Off-sequence `remediate` seam via injectable predicate (default undefined)

**Decision**: Add an optional `PhaseLoopDeps.remediateTrigger?(context): boolean` (default `undefined`). After `review` completes successfully, if the predicate is present and returns true, run `onPhaseStart('remediate') → runStubPhase('remediate') → onPhaseComplete('remediate')`, push the result, then `i--; continue;` to re-enter `review`. Production wires no trigger, so the seam is dead; the unit test injects a fire-once-then-false predicate.

**Rationale**:
- Q4=A requires `remediate` to be reachable only via the unit test, with no production trigger. A default-undefined predicate is dead in production by construction.
- The `i--` backtrack + resume is an existing precedent in `phase-loop.ts` (:702), so the seam reuses proven loop mechanics rather than adding a new persistence/resume layer (spec Assumption).
- A fire-once-then-false test predicate proves all three US2 acceptance points: entry off-sequence, return-to-`review`, and termination (no infinite loop).

**Alternatives rejected**:
- *Always-off production trigger behind the same flag (Q4 option B)*: with the Q1 flag OFF, any wired trigger is dead anyway — it adds surface for zero behavior.
- *A dedicated resume/persistence mechanism*: unnecessary; the existing `i--`/`startPhase` precedent already admits off-sequence re-entry.

## D-6 — Stub executor returns a synthetic success result

**Decision**: `runStubPhase(phase)` returns `{ phase, success: true, exitCode: 0, durationMs: 0, output: [] }` and is dispatched by a branch placed **before** the `if (phase === 'validate')` branch in the execute-phase `try`. The CLI-path cast is tightened to `Exclude<typeof phase, 'validate' | 'review' | 'remediate'>` so the compiler proves the CLI spawn never receives the new phases.

**Rationale**:
- FR-008 requires stub wiring that compiles and leaves existing behavior unchanged. Returning success keeps the loop advancing exactly as a real successful phase would.
- Tightening the `Exclude<...>` cast turns "the CLI never sees review/remediate" from a runtime assumption into a compile-time guarantee.

**Alternatives rejected**:
- *Route stubs through the CLI spawn with a fake command*: same fake-slash-command problem as D-3; the CLI path would attempt to launch a provider.

## D-7 — Exhaustiveness audit as a committed automated test

**Decision**: Add `packages/orchestrator/src/__tests__/phase-vocabulary-audit.test.ts` following the established `label-protocol-audit.test.ts` / `phase-tracker-audit.test.ts` pattern: enumerate the duplication sites, assert each contains `review` and `remediate` (and that the intentional-subset sites are documented), and fail on drift.

**Rationale**:
- Q5=A requires a committed durable regression guard, not a one-time grep-in-PR.
- TypeScript `Record<WorkflowPhase, …>` exhaustiveness only catches the map sites (e.g. `PHASE_TO_STAGE`); it cannot catch the hand-maintained Zod-enum / literal-union sites. A runtime audit closes that gap.
- The codebase already blesses this pattern, so it slots in with no new infrastructure.

**Alternatives rejected**:
- *Compile-time exhaustiveness + documented grep (Q5 option B)*: the grep is not durable — the next phase addition can silently miss a site and CI stays green.

## Sources / references

- Spec: `specs/1121-context-worker-phase-machine/spec.md` (FR-001..FR-011, SC-001..SC-004).
- Clarifications: `specs/1121-context-worker-phase-machine/clarifications.md` (Q1..Q5, all answer A).
- Audit precedent: `packages/orchestrator/src/__tests__/label-protocol-audit.test.ts`, `packages/orchestrator/src/__tests__/phase-tracker-audit.test.ts`.
- Canonical vocabulary: `packages/orchestrator/src/worker/types.ts`.
- Changeset rule: `CLAUDE.md` — "new label vocabulary in `workflow-engine` → minor".

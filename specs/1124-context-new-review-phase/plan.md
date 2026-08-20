# Implementation Plan: Review phase executor — structured findings artifact + engine-internal verdict

**Feature**: Replace the inert `review`-phase stub with a real agent phase executor that runs an engine-driven code review of the PR diff, persists a structured findings artifact, and computes an engine-internal verdict that drives the next-phase decision.
**Branch**: `1124-context-new-review-phase`
**Status**: Complete

## Summary

Issue #1124 turns the `review` phase (landed inert by #1121 as `runStubPhase('review')`) into a working executor. On entry the engine:

1. Resolves the workflow's `review` config (`profile`, `blockingSeverity`, `failThenPass`) via `resolveWorkflowOverrides` — this is the **first consumer** of that resolved surface.
2. Reads any prior-round artifact to compute the next `round` number.
3. Builds a **charter prompt in-process** selected by `review.profile` (`standard | verification`) — no `/speckit:review` slash command, no `PHASE_TO_COMMAND` entry (Q4→B).
4. Spawns the CLI via a **new `review` launch intent** carrying the prepared prompt (mirrors `merge-conflict`), reusing `agentLauncher.launch()` directly like `pr-feedback-handler` — **not** `cli-spawner.spawnPhase`, which excludes `review`/`remediate` by type.
5. Reads the agent-written sidecar, Zod-validates it, **recomputes the verdict** (any agent-claimed verdict is ignored), increments `round`, records `lastReviewedCommitSha`, and rewrites the artifact atomically (temp+rename), mirroring `pause-context.ts`.

The engine — never GitHub review state — owns the verdict. `verdict: clean` continues toward `validate`; `verdict: changes-required` routes into the existing off-sequence `remediate` seam via the `remediateTrigger(context)` hook (Q2→B), which reads the persisted sidecar and returns its boolean. The review↔remediate cycle is bounded by `maxRemediations` (FR-011): on exhaustion the workflow pauses with `waiting-for:remediation-limit` + `agent:paused` rather than spinning forever against the still-stubbed `remediate` executor.

The whole feature is inert unless `reviewPhaseEnabled=true` — with the flag off, `review` is absent from the effective sequence and behavior is byte-identical to today (#1121, FR-010/SC-005).

## Technical Context

- **Language / runtime**: TypeScript (ESM), Node ≥22, pnpm monorepo.
- **Primary package**: `@generacy-ai/orchestrator` (`packages/orchestrator`).
- **Secondary packages**: `@generacy-ai/generacy-plugin-claude-code` (new launch intent handling), `@generacy-ai/workflow-engine` (new `waiting-for:remediation-limit` label vocabulary).
- **Validation**: `zod` (already a dependency of every touched package).
- **Filesystem sidecar**: `node:fs` atomic temp+rename, mirroring `packages/orchestrator/src/worker/pause-context.ts`.
- **Testing**: `vitest` (unit + orchestrator harness), matching existing `packages/orchestrator/src/worker/__tests__/` conventions.

### Load-bearing prerequisites (already merged)

- **#1121** — `review` in `PHASE_SEQUENCE` (after `implement`, before `validate`), `remediate` off-sequence, `runStubPhase()`, and the `PhaseLoopDeps.remediateTrigger?(context)` seam.
- **Review config** — `ResolvedWorkflowConfig.review { profile, blockingSeverity, failThenPass }`, `DEFAULT_REVIEW = { profile: 'standard', blockingSeverity: 'critical', failThenPass: false }`, resolved by `resolveWorkflowOverrides(config, settings, workflowName)`. Currently **zero consumers** — #1124 is the first.

### Confirmed seams (from codebase reconnaissance)

- `phase-loop.ts:107` — `remediateTrigger?: (context: WorkerContext) => boolean` is **synchronous**. The trigger must read the sidecar synchronously (`fs.readFileSync` + Zod) — hence a dedicated `readReviewArtifactSync`. The executor's own write path stays async.
- `phase-loop.ts:473-477` — the `if (phase === 'review' || phase === 'remediate')` stub branch is the swap target. `remediate` remains a stub (Out of Scope); only `review` gains a real executor via an injected `deps.reviewExecutor`.
- `phase-loop.ts:551` — CLI-path cast `Exclude<typeof phase, 'validate' | 'review' | 'remediate'>` proves the CLI-spawn path never sees `review`; the review executor spawns on its own path.
- `phase-loop.ts:1020-1124` — the gate block runs **before** the remediate seam at `:1157`. FR-011 exhaustion is therefore implemented as a **new gate condition** (`on-remediation-limit`) on the `review` phase: when the round count reaches `maxRemediations`, the gate fires and pauses (with `waiting-for:remediation-limit`) before the seam can trigger another remediate.
- `merge-conflict` intent (`launcher/types.ts`) + `buildMergeConflictLaunch` (`claude-code-launch-plugin.ts:214-240`) are the byte-for-byte template for the new `review` intent + `buildReviewLaunch`.
- `pr-feedback-handler.ts:700-985` — direct `agentLauncher.launch()` + manual `OutputCapture` + SIGTERM→SIGKILL timeout is the template for `ReviewExecutor.execute()`.
- `claude-cli-worker.ts:496` — worker already loads `orchSettings`; it resolves the review config once and threads `settings` + `reviewExecutor` + `remediateTrigger` into `PhaseLoopDeps`.
- `label-definitions.ts` — `waiting-for:implementation-review` (color `FBCA04`) exists; `waiting-for:remediation-limit` is added alongside.

## Project Structure

### New files

```
packages/orchestrator/src/worker/
  review-artifact.ts     # FR-006 Zod schema; write/read/readSync/clear; computeVerdict (FR-007); getReviewArtifactPath
  review-charter.ts      # buildReviewCharter({ profile, sidecarRelPath, blockingSeverity, round }) — FR-002/003/004/005
  review-executor.ts     # ReviewExecutor.execute(context, deps): PhaseResult — spawn + read + validate + recompute + persist

packages/orchestrator/src/worker/__tests__/
  review-artifact.test.ts      # SC-001 round-trip + null-on-malformed; SC-002 severity gating matrix
  review-charter.test.ts       # profile selection; forbids tests/builds; empty-diff flag; sidecar-path instruction
  review-executor.test.ts      # SC-003 no validate/build spawn; SC-004 verdict→next-phase; recompute-ignores-agent-verdict
  phase-loop.review.test.ts    # US2 clean→validate, changes-required→remediate→re-review; FR-011 exhaustion pause

.changeset/
  1124-review-phase-executor.md
```

### Modified files

```
packages/orchestrator/src/launcher/types.ts
  + ReviewIntent { kind: 'review'; issueNumber; prompt; provider?; model?; effort? }
  + add to LaunchIntent union

packages/generacy-plugin-claude-code/src/launch/types.ts
  + ReviewIntent (mirror)

packages/generacy-plugin-claude-code/src/launch/claude-code-launch-plugin.ts
  + 'review' in supportedKinds
  + case 'review' → buildReviewLaunch(intent)
  + buildReviewLaunch (mirror of buildMergeConflictLaunch)

packages/orchestrator/src/worker/phase-loop.ts
  ~ line 473: review branch → deps.reviewExecutor?.execute(...) ?? runStubPhase('review'); remediate stays stub
  + gate eval for new 'on-remediation-limit' condition (before the seam)
  + PhaseLoopDeps.reviewExecutor?: ReviewExecutor
  + PhaseLoopDeps.settings?: OrchestratorSettings (or resolved review config)

packages/orchestrator/src/worker/config.ts
  + GateDefinitionSchema.condition enum: 'on-remediation-limit'
  + default review gate for speckit-feature / speckit-bugfix (phase 'review', gateLabel 'remediation-limit', condition 'on-remediation-limit')

packages/orchestrator/src/worker/claude-cli-worker.ts
  + construct ReviewExecutor(agentLauncher, settings, logger)
  + inject reviewExecutor + settings + remediateTrigger (reads sidecar via readReviewArtifactSync) into PhaseLoopDeps

packages/workflow-engine/src/actions/github/label-definitions.ts
  + waiting-for:remediation-limit (color FBCA04, matching the review-gate family)

packages/orchestrator/src/worker/phase-resolver.ts   (if required for resume)
  ~ GATE_MAPPING: remediation-limit → review (so /cockpit:resume re-enters review)
```

## Constitution Check

No `.specify/memory/constitution.md` exists in this repository, so the constitution gate is **skipped** (no violations to record). The design nonetheless honors the project's standing conventions:

- **Changeset gate (CLAUDE.md)**: non-test `packages/*/src/` changes ship a newly-added `.changeset/1124-review-phase-executor.md`. New `waiting-for:` label vocabulary in `workflow-engine` → `minor` bump for that package (per the CLAUDE.md rule). New `review` intent kind is new public capability on the claude-code plugin → `minor`. Orchestrator changes are internal plumbing (no new public exports) → `patch`.
- **Sidecar discipline**: the artifact reuses `pause-context.ts`'s exact atomic-write + sanitize + null-on-invalid contract — no new persistence primitive invented.
- **No GitHub review state**: verdict is engine-only; `APPROVE`/`REQUEST_CHANGES`/`COMMENT` are never read or written (the cluster account 422s on its own PR). This is enforced by test SC-003's assertion that no GitHub review API is called.
- **Feature-flag safety**: `reviewPhaseEnabled=false` keeps the phase out of the effective sequence — byte-identical to pre-#1124 (#1121's byte-identity assertion, SC-005).
- **Scope discipline**: `remediate` executor stays a stub; bugfix charter content is out of scope; only the verdict→seam signal is wired.

## Phasing

1. **Artifact + verdict core** (`review-artifact.ts`) — schema, sidecar I/O (async + sync reader), `computeVerdict`. Unit-tested first (SC-001/SC-002), zero coupling to spawn machinery.
2. **Charter** (`review-charter.ts`) — pure string builder by profile. Unit-tested (FR-002/003/004/005).
3. **Launch intent** — `launcher/types.ts` + plugin `types.ts` + `claude-code-launch-plugin.ts`. Compiles, no behavior yet.
4. **Executor** (`review-executor.ts`) — wire spawn + read + recompute + persist. Harness-tested (SC-003/SC-004).
5. **Phase-loop wiring** — swap the review branch, add the `on-remediation-limit` gate condition, thread deps. Integration-tested (US2 + FR-011).
6. **Labels + resume + changeset** — `waiting-for:remediation-limit`, GATE_MAPPING, changeset file.

## Next Step

Run `/speckit:tasks` to generate the ordered task list from this plan.

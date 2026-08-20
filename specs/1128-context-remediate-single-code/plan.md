# Implementation Plan: Remediate phase executor — remediation counter + remediation-limit gate

**Feature**: Replace the inert `remediate`-phase stub with a real agent executor (single code-change loop for review findings), bounded by an explicit resettable remediation counter that raises a resumable `waiting-for:remediation-limit` gate at the cap.
**Branch**: `1128-context-remediate-single-code`
**Status**: Complete

## Summary

#1121 landed the `remediate` phase as an off-sequence stub (`runStubPhase('remediate')`) reached via the `PhaseLoopDeps.remediateTrigger` seam after a successful `review`. #1124 landed the real `review` executor + the Zod-validated findings sidecar (`review-artifact.ts`). This issue swaps the remediate stub for a real executor and closes the loop bound:

1. **`RemediateExecutor`** (new) — mirrors `ReviewExecutor`: reads open blocking findings from the review sidecar, builds an in-process remediation charter, spawns the CLI via a new `remediate` launch intent, and increments a persisted `remediationCount`. It **never** resolves review threads or marks the PR ready (that's the re-`review` round's job).
2. **Commit/push in the seam** — the off-sequence seam, which today commits nothing, now runs `prManager.commitPushAndEnsurePr('remediate')` after the executor so code changes land on the branch (partial-work-safe on timeout).
3. **Explicit remediation counter** — a **distinct** sidecar field `remediationCount` (not `round`, which stays monotonic for #1126 delta-scoping). One execution = +1, including timed-out executions.
4. **Cap gate re-key** — the existing `on-remediation-limit` gate is re-keyed from `artifact.round` to `artifact.remediationCount`, keeping the `verdict === 'changes-required'` conjunct so a clean review on the cap round proceeds to `validate`.
5. **Gate-body enrichment** — when the cap gate fires, post an issue comment listing remaining open findings (file/line/title) so an operator can triage.
6. **Resume resets the counter** — at the gate-satisfaction check, `completed:remediation-limit` resets `remediationCount` to 0 in the sidecar and clears the completed label so the gate re-arms; `GATE_MAPPING['remediation-limit']` stays `{ phase: review, resumeFrom: review }`.

No terminal `blocked:*` label is ever applied — the legacy fixer's `blocked:stuck-feedback-loop` stranding failure mode is deliberately avoided.

## Technical Context

- **Language / runtime**: TypeScript, Node >=22, ESM. Vitest for tests.
- **Packages touched**:
  - `@generacy-ai/orchestrator` — `remediate-executor.ts` (new), `remediate-charter.ts` (new), `review-artifact.ts` (schema + counter helpers), `phase-loop.ts` (seam + gate re-key + reset + body), `claude-cli-worker.ts` (wiring).
  - `@generacy-ai/generacy-plugin-claude-code` — `RemediateIntent` type + `buildRemediateLaunch` + `supportedKinds`.
  - `@generacy-ai/workflow-engine` — `label-definitions.ts` (`completed:remediation-limit`).
- **Prerequisites (all merged to `develop`)**: #1121 (phase machinery + seam), #1124 (review executor + sidecar + `on-remediation-limit` gate + `waiting-for:remediation-limit` label + `maxRemediations`), #1125/#1126 (PR posting + re-review convergence).
- **Reused surfaces (not re-implemented)**: `resolveWorkflowOverrides` → `{ maxRemediations, review: { blockingSeverity, profile } }`; `resolveAgentForPhase`/`resolvePhaseTimeoutMs`; `buildLaunchCredentials`; `OutputCapture`; `agentLauncher.launch()`; `prManager.commitPushAndEnsurePr` (+ `pushRefused` abort contract from #1051); `GATE_MAPPING['remediation-limit']` (unchanged); `readReviewArtifact`/`writeReviewArtifact`/`computeVerdict`; `context.github.addIssueComment`.

## Key Design Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| D-1 | `remediationCount` is a **distinct** sidecar field, `.default(0)` for back-compat | Q1=A. `round` must stay monotonic for #1126 delta-scoped re-review; only the resettable budget resets on resume. `.default(0)` lets pre-existing #1124 artifacts (no field) parse. |
| D-2 | The **executor** increments `remediationCount`; the **seam** commits/pushes | FR-005 persists the counter in the sidecar (executor owns sidecar writes, mirroring `ReviewExecutor`). FR-003's commit is the seam's job (the phase-commit plumbing lives in the loop, keyed by `WorkflowPhase`). |
| D-3 | Increment happens **before** the commit, wrapped so a timeout still persists +1 | Q4=A: a timed-out execution is a real partial-work-committing attempt and must consume budget, else a perpetually-timing-out loop never escalates. The executor increments on both the success and the timeout/spawn-failure return paths. |
| D-4 | New `RemediateIntent` (kind: `'remediate'`), not reuse of `ReviewIntent` | Mirrors #1124's dedicated `review` intent; `buildRemediateLaunch` is byte-identical to `buildReviewLaunch` (bounded one-turn agent with an engine-built charter). Distinct kind keeps launch tracing honest. |
| D-5 | Gate re-key: `remediationCount >= maxRemediations && verdict === 'changes-required'` | Q5=A. Verdict conjunct is load-bearing now that remediate can actually clear findings — a clean review on the cap round must flow to `validate`, not page a human. |
| D-6 | Counter reset + completed-label clear at the **gate-satisfaction check** (phase-loop.ts:1163) | Q3=A. Reset in the sidecar the moment `completed:remediation-limit` is detected, clear the label so the gate re-arms; `resumeFrom: review` re-establishes findings state and the seam drives remediate with a fresh budget. |
| D-7 | Gate body via `context.github.addIssueComment` listing `status:'open'` findings | FR-008. Simplest grounded surface for triage; no new comment infrastructure. |
| D-8 | Flag-OFF byte-identity preserved | FR-013/SC-007: with `reviewPhaseEnabled=false`, `review`/`remediate` are absent from the effective sequence, the seam never fires, and the executor never constructs. |

## Project Structure

```
packages/orchestrator/src/worker/
  remediate-executor.ts          # NEW — RemediateExecutor (mirrors review-executor.ts)
  remediate-charter.ts           # NEW — buildRemediateCharter() (pure prompt builder)
  review-artifact.ts             # MOD — + remediationCount field, bumpRemediationCount(), resetRemediationCount()
  phase-loop.ts                  # MOD — seam executor + commit; gate re-key; reset-on-completed; gate body
  claude-cli-worker.ts           # MOD — construct + inject remediateExecutor into PhaseLoopDeps
  __tests__/
    remediate-executor.test.ts               # NEW — SC-001, increment-on-timeout, no-resolve/no-ready
    remediate-charter.test.ts                # NEW — prompt shape (findings-only; validate-evidence extensible)
    review-artifact.remediation-count.test.ts# NEW — bump/reset/back-compat default
    phase-loop.remediate.test.ts             # NEW — SC-002/003/004/005 gate + reset + convergence
    phase-loop.remediate-timeout.integration.test.ts # NEW — SC-006 partial-work survives timeout

packages/generacy-plugin-claude-code/src/launch/
  types.ts                       # MOD — + RemediateIntent, add to ClaudeCodeIntent union
  claude-code-launch-plugin.ts   # MOD — + 'remediate' supportedKind + buildRemediateLaunch
  index.ts                       # MOD — export RemediateIntent

packages/workflow-engine/src/actions/github/
  label-definitions.ts           # MOD — + completed:remediation-limit

.changeset/
  1128-remediate-executor.md     # NEW — orchestrator patch + plugin minor + workflow-engine minor
```

## Constitution Check

No `.specify/memory/constitution.md` in the repo → constitution check skipped.

## Risks & Mitigations

- **Sidecar committed to the branch**: the review/remediate sidecar lives under `.generacy/`. This is pre-existing #1124 behavior; the counter change adds a field, not a new file. No mitigation needed beyond confirming `.generacy/` handling is unchanged.
- **Reset-label race**: reset clears `completed:remediation-limit`; if the label monitor re-reads before the clear, the resume could double-fire. Mitigation: reset+clear happen synchronously inside the single gate-satisfaction branch before `continue`, mirroring existing satisfied-gate handling.
- **Counter drift vs. round**: `remediationCount` and `round` advance on independent cadences by construction (D-1). Tests assert `round` monotonicity is untouched across a reset.

## Next Step

Run `/speckit:tasks` to generate the dependency-ordered task list.

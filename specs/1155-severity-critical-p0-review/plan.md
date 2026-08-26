# Implementation Plan: Review executor must fail (not falsely pass) on CLI failure, timeout, or missing findings

**Feature**: Treat a review CLI failure / timeout / crash / missing-fresh-sidecar as a phase failure (or no-verdict), never a phantom `clean`.
**Branch**: `1155-severity-critical-p0-review`
**Status**: Complete

## Summary

The review-phase executor (`packages/orchestrator/src/worker/review-executor.ts`) currently reports a **phantom-clean verdict** whenever the review agent dies before writing findings: it returns `success: true, exitCode: 0` unconditionally (`:259-265`) and `readCandidateFindings()` returns `[]` for a missing/invalid sidecar (`review-artifact.ts:235-270`), which `computeVerdict([])` turns into `clean`. An unreviewed change then advances to `validate` and is marked ready.

This fix closes the gap with two surgical production changes plus regression tests:

1. **FR-001 — propagate the real exit code / timeout** into `PhaseResult` (mirror `remediate-executor.ts:225-231`), replacing the hardcoded `success: true, exitCode: 0`.
2. **FR-002/FR-003/FR-004 — "proof of review" contract on a separate candidate path.** The agent writes `review-candidate-<id>.json`; the engine reads *that* file (not the authoritative artifact), so a missing candidate on any round is unambiguously "nothing written this round". `readCandidateFindings` returns `ReviewFinding[] | null` — `null` = no/invalid candidate (no proof of review → never `clean`), `[]` = a valid candidate with zero findings (legitimate `clean`). On a failed / no-verdict round the engine **persists nothing** (Q3-A), leaving any prior-round artifact — and its `round` + `remediationCount` — exactly as-is (Q4-A, FR-004).

Downstream (`phase-loop.ts`) needs **no production change**: the generic phase-failure path already halts on `!result.success`, and the review side-effects (mark-ready, thread resolution, off-sequence remediate) are already gated on `phase === 'review' && result.success`. Failing the phase / withholding a fresh `clean` is sufficient to stop the phantom-clean cascade (spec Assumptions).

## Technical Context

- **Language / runtime**: TypeScript, Node ≥ 22, ESM.
- **Package**: `@generacy-ai/orchestrator` (`packages/orchestrator`).
- **Test framework**: Vitest (existing `__tests__/review-executor.test.ts`, `__tests__/review-artifact.test.ts`).
- **Validation**: Zod (existing `ReviewArtifactSchema`, `CandidateArtifactSchema`).
- **Filesystem contract**: atomic temp+rename writes, null/`[]`-on-invalid reads, `[^a-zA-Z0-9_-] → _` id sanitization (mirrors `pause-context.ts`).
- **Feature flag**: `reviewPhaseEnabled` (default OFF) — unchanged; this fix does not touch the flag or its default.
- **Reference pattern for FR-001**: `remediate-executor.ts:225-231` (`success: exitCode === 0`).

## Project Structure

Files touched (all under `packages/orchestrator/src/worker/`):

```
review-artifact.ts                 (MODIFY)
  + getReviewCandidateRelPath(workflowId)
  + getReviewCandidatePath(checkoutPath, workflowId)
  + clearReviewCandidate(checkoutPath, workflowId)
  ~ readCandidateFindings(...)  ->  reads CANDIDATE path; returns ReviewFinding[] | null
review-executor.ts                 (MODIFY)
  ~ sidecarRelPath = getReviewCandidateRelPath(workflowId)   (charter write target)
  + pre-spawn clearReviewCandidate(...)                      (guarantee "this round")
  ~ post-exit gate: exitCode !== 0 || findings === null
      -> persist nothing, return { success: false, exitCode: exitCode ?? -1 }
    else
      -> computeVerdict, writeReviewArtifact (round advances, carry remediationCount),
         clearReviewCandidate, return { success: true, exitCode: 0 }
__tests__/review-artifact.test.ts   (MODIFY / ADD)
__tests__/review-executor.test.ts   (MODIFY / ADD)

.changeset/1155-review-executor-phantom-clean.md   (ADD — @generacy-ai/orchestrator patch)
```

No new files under `src/`. No changes to `phase-loop.ts`, `remediate-executor.ts`, the charter prompt text, the strict `ReviewArtifactSchema` shape, or the CI merge gate.

## Constitution Check

No `.specify/memory/constitution.md` exists in the repo → constitution check skipped.

## Key Design Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| D-1 | Separate candidate path `review-candidate-<id>.json`, distinct from `review-findings-<id>.json`. | Q2-A. Structurally distinguishes "written this round" from a prior-round engine artifact; isolates the crash window so FR-004 is satisfied for free. |
| D-2 | `readCandidateFindings` returns `ReviewFinding[] \| null` (was `[]`). | The `[]`-collapses-to-`clean` conflation is the root cause. `null` = no proof of review; `[]` = a genuine clean review. |
| D-3 | Pre-spawn `clearReviewCandidate(...)`. | Guarantees any candidate read after the spawn was written *this* round; a stale candidate from a prior round can never be re-ingested. |
| D-4 | Exit-code gate (FR-001) AND fresh-candidate gate (FR-002) are independent. | Q1-A. Exit 0 with no fresh candidate is still a no-verdict (persist nothing); non-zero exit is a phase failure regardless of candidate. |
| D-5 | Persist nothing on failure / no-verdict; do not advance `round`. | Q3-A / Q4-A. Prior artifact (incl. `round`, `remediationCount`) is preserved; repeated failures cannot burn the #1128 remediate cap. |
| D-6 | No `phase-loop.ts` change. | Generic failure path already halts; side-effects already gated on `result.success`. Retry/escalation policy is out of scope. |
| D-7 | Changeset = single `@generacy-ai/orchestrator` **patch**. | Defect fix; new helper functions are internal (not re-exported from the package public `index.ts`). |

## Requirement → change traceability

- **FR-001** → `review-executor.ts` post-exit `return` uses `success: exitCode === 0`, `exitCode: exitCode ?? -1`; timeout SIGTERM/SIGKILL yields non-zero/`null` exit → `success: false`.
- **FR-002** → gate `exitCode !== 0 || findings === null` persists nothing; else `computeVerdict` on a fresh candidate.
- **FR-003** → `getReviewCandidateRelPath` write target + `readCandidateFindings` reads the candidate path; engine writes authoritative artifact, then `clearReviewCandidate`.
- **FR-004** → separate candidate path means a mid-write crash never corrupts the engine artifact → `remediationCount` intact.
- **FR-005** → satisfied by construction in `phase-loop.ts` (side-effects gated on `result.success`; failed review halts).
- **FR-006** → regression tests: missing-sidecar, timeout, non-zero-exit, round ≥ 2 no-op, crash-window.
- **FR-007** → happy path (valid candidate, exit 0) unchanged: byte-identical artifact + `success: true`.

## Next step

`/speckit:tasks` to generate the task list.

---

*Generated by speckit*

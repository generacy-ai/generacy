# Research: Review executor phantom-clean fix (#1155)

All line refs at `develop` 155b3464 unless noted. Code re-verified on branch `1155-severity-critical-p0-review`.

## Decision 1 — How to signal a failed review round

**Chosen**: Return `success: exitCode === 0`, `exitCode: exitCode ?? -1` from `ReviewExecutor.execute()`, mirroring `remediate-executor.ts:225-231`.

**Context**: `execute()` already captures the child exit code at `review-executor.ts:207` (`exitCode = await child.exitPromise`) but discards it, returning the hardcoded `{ success: true, exitCode: 0 }` at `:259-265`. The spawn-failure early return (`:155-170`) and the wait-error early return (`:208-222`) already return `success: false, exitCode: -1` — only the normal-exit path is wrong.

**Alternatives considered**:
- *Keep `success: true`, encode failure only in the verdict.* Rejected — FR-001 explicitly requires `success` to reflect the exit code, and downstream consumers branch on `result.success` (`phase-loop.ts`). A false `success: true` re-opens the cascade.
- *Throw on non-zero exit.* Rejected — the executor contract is to return a `PhaseResult`; throwing would bypass the generic failure handler's evidence/escalation path.

## Decision 2 — Distinguishing a fresh candidate from a stale engine artifact

**Chosen**: Separate candidate file path `review-candidate-<sanitized-id>.json` (Q2-A). The agent writes the candidate; the engine reads it, writes the authoritative `review-findings-<id>.json`, then clears the candidate.

**Context**: Today `readCandidateFindings` reads `getReviewArtifactPath` (`review-artifact.ts:240`) — the *same* path the engine writes. On round ≥ 2 a no-op agent leaves the prior round's engine-stamped findings, which are re-ingested as this round's candidate (spec §"Round ≥ 2"). A separate path makes "no candidate this round" unambiguous.

**Alternatives considered**:
- *Written-this-round nonce/marker in the shared file.* Rejected (Q2-A rationale) — fragile; the agent must stamp a token the engine generates, and a crash mid-write leaves an ambiguous file.
- *mtime vs. spawn time.* Rejected — clock/filesystem-granularity fragility; a re-used checkout can carry a newer-looking stale file.

**Consequence**: FR-004 (crash window) is satisfied for free — a mid-write crash corrupts only the candidate, never the engine artifact, so `remediationCount`/`round` survive.

## Decision 3 — `readCandidateFindings` return type

**Chosen**: `Promise<ReviewFinding[] | null>`. `null` = missing / unreadable / schema-invalid candidate (no proof of review). `[]` = a valid candidate whose `findings` array is empty (a legitimate clean review).

**Context**: The root cause is that the current `[]`-on-everything return collapses "agent died, wrote nothing" and "agent reviewed, found nothing" into the same value, and `computeVerdict([]) === 'clean'`. Splitting the two lets the executor gate on `findings === null` for the failure/no-verdict path while still honoring a genuine empty-findings clean review (FR-007).

**Alternatives considered**:
- *Sentinel object `{ found: boolean, findings }`.* Rejected — heavier than a nullable array and no callers need the extra shape.
- *Throw when the candidate is absent.* Rejected — breaks the established never-throws contract of the artifact module.

## Decision 4 — Guaranteeing "written this round"

**Chosen**: `clearReviewCandidate(...)` immediately before spawning the CLI.

**Context**: Even with a separate path, a candidate left by a *previous* review round (e.g. a crash between candidate write and the engine's clear) could be mistaken for this round's output. A pre-spawn clear makes any post-spawn candidate provably this-round.

**Alternatives considered**:
- *Rely on the post-success clear only.* Rejected — the post-success clear never runs on a failed round, so a stale candidate could linger into the next round.

## Decision 5 — Persistence on the failure / no-verdict path

**Chosen**: Persist nothing (Q3-A). Leave any prior-round engine artifact exactly as-is; do not advance `round` (Q4-A).

**Context**: `round` and `remediationCount` are both derived from the persisted artifact (`review-executor.ts:108-109, :249`). Writing a fresh artifact on failure would either fabricate a `clean` (forbidden) or advance `round`/reset `remediationCount`, burning the #1128 cap. Writing nothing preserves both. First-round failure ⇒ no artifact exists ⇒ nothing to advance.

**Alternatives considered**:
- *Persist a distinct `failed` marker artifact.* Rejected (Q3-A) — needs an out-of-scope schema change to `ReviewArtifactSchema`.

## Decision 6 — Downstream (phase-loop) changes

**Chosen**: None.

**Context**: Verified in `phase-loop.ts`:
- The generic phase-failure handler (`~:1069-1085`) fires on `!result.success` — builds evidence, sets the stage error comment, `escalateAndAlert`, returns `{ completed: false, gateHit: false }`. A failed review therefore halts the loop; it cannot advance to `validate`.
- The review side-effects block (`~:1591-1607`) is gated on `phase === 'review' && result.success` — `markReadyForReview` and thread resolution never run when `success: false`, satisfying FR-005 by construction.
- The off-sequence remediate seam (`~:1612`) is also gated on `result.success`.

The spec Assumptions confirm downstream consumers already branch on `result.success` / `artifact.verdict`, so failing the phase / withholding a fresh `clean` is sufficient. Retry/re-dispatch/escalation policy for a failed review is explicitly Out of Scope.

## Decision 7 — Changeset bump level

**Chosen**: Single `.changeset/1155-*.md`, `@generacy-ai/orchestrator` **patch**.

**Context**: This is a defect fix (`workflow:speckit-bugfix` → `patch` per CLAUDE.md). The new functions (`getReviewCandidateRelPath`, `getReviewCandidatePath`, `clearReviewCandidate`) are internal worker surface — not re-exported from the package's public `index.ts` — so they are internal surface, still `patch`. Only `packages/orchestrator/src/` non-test files change, so exactly one changeset is required and one package is listed.

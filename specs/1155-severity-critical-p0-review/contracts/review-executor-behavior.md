# Contract: ReviewExecutor.execute() behavior (#1155)

Module: `packages/orchestrator/src/worker/review-executor.ts`. Method: `execute(context): Promise<PhaseResult>`.

## Preserved paths (UNCHANGED)

- **#1131 empty resolution window** (`:90-105`): `reviewScope` present + empty diff ⇒ synthetic `{ success: true, exitCode: 0, output: [] }`, no spawn, no artifact. Untouched.
- **Spawn failure** (`:155-170`): returns `{ success: false, exitCode: -1 }`. Untouched.
- **Wait error** (`:208-222`): returns `{ success: false, exitCode: -1 }`. Untouched.

## Changed sequence (normal spawn path)

1. **Charter write target** — `sidecarRelPath = getReviewCandidateRelPath(workflowId)` (was `getReviewArtifactRelPath`). The agent is pointed at the candidate path via the charter value (not a prompt-text change).
2. **Pre-spawn** — `await clearReviewCandidate(checkoutPath, workflowId)` so any candidate seen after the spawn is provably written this round.
3. Spawn CLI; manage SIGTERM→grace→SIGKILL timeout; capture `exitCode = await child.exitPromise`.
4. **Read candidate** — `const findings = await readCandidateFindings(checkoutPath, workflowId, round)` — now `ReviewFinding[] | null`.
5. **Gate**:
   - `if (exitCode !== 0 || findings === null)` ⇒ **persist nothing**; return
     `{ phase: 'review', success: false, exitCode: exitCode ?? -1, durationMs, output }`.
     (Prior-round artifact — incl. `round`, `remediationCount` — left exactly as-is; `round` does not advance.)
   - `else` (exit 0 AND fresh candidate, possibly empty):
     - `verdict = computeVerdict(findings, blockingSeverity)`
     - `lastReviewedCommitSha = await context.github.getCurrentCommitSha()`
     - `await writeReviewArtifact(checkoutPath, workflowId, { findings, verdict, round, lastReviewedCommitSha, remediationCount: priorRound?.remediationCount ?? 0 })`  (`round` advances)
     - `await clearReviewCandidate(checkoutPath, workflowId)`
     - return `{ phase: 'review', success: true, exitCode: 0, durationMs, output }`.

## Invariants

| ID | Invariant |
|----|-----------|
| INV-1 | A non-zero / timeout exit ⇒ `success: false` and no artifact write (FR-001, Q3-A). |
| INV-2 | Exit 0 with no fresh candidate ⇒ `success: false`, no artifact write, no `clean` (FR-002, closes exit-0 gap). |
| INV-3 | A failed / no-verdict round never advances `round` and never resets `remediationCount` (Q4-A, FR-004). |
| INV-4 | Happy path (exit 0, valid candidate) produces a byte-identical artifact + `success: true` vs. pre-fix for the same inputs (FR-007, SC-004). |
| INV-5 | The engine artifact path is never the agent's write target — the agent only ever writes the candidate path (FR-003). |

## Downstream (phase-loop.ts) — NO CHANGE

- `!result.success` ⇒ generic failure handler halts the loop (`{ completed: false, gateHit: false }`); never advances to `validate`.
- Review side-effects (`markReadyForReview`, thread resolution) gated on `phase === 'review' && result.success` ⇒ skipped on failure (FR-005).
- Off-sequence remediate seam gated on `result.success` ⇒ skipped on failure.

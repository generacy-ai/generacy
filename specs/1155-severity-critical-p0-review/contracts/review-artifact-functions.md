# Contract: review-artifact.ts function surface (#1155)

Module: `packages/orchestrator/src/worker/review-artifact.ts`. Internal worker surface — not re-exported from the package public `index.ts`.

## New: `getReviewCandidateRelPath(workflowId): string`

- Returns `.generacy/review-candidate-<sanitizeWorkflowId(workflowId)>.json`.
- Pure. Mirrors `getReviewArtifactRelPath` but with prefix `review-candidate-`.
- Used as the charter `sidecarRelPath` (the agent's write target).

## New: `getReviewCandidatePath(checkoutPath, workflowId): string`

- Returns `path.join(checkoutPath, getReviewCandidateRelPath(workflowId))`.
- Pure. Mirrors `getReviewArtifactPath`.

## New: `clearReviewCandidate(checkoutPath, workflowId): Promise<void>`

- `fs.unlink(getReviewCandidatePath(...))`.
- Idempotent — swallows `ENOENT`, rethrows any other error. Mirrors `clearReviewArtifact`.

## Changed: `readCandidateFindings(checkoutPath, workflowId, round): Promise<ReviewFinding[] | null>`

- **Path**: reads `getReviewCandidatePath(...)` (was `getReviewArtifactPath`).
- **Return**:
  - `null` — file missing / unreadable / invalid JSON / schema-invalid (no proof of review).
  - `ReviewFinding[]` (possibly empty) — valid `CandidateArtifactSchema` parse.
- **Stamping** (unchanged): per-finding `round ?? <round arg>`, `status ?? 'open'`; agent-claimed top-level `verdict`/`round` ignored (FR-007).
- **Never throws.**

## Unchanged (referenced by the executor)

- `computeVerdict(findings, blockingSeverity)` — pure; `changes-required` iff ≥1 open finding at/above `blockingSeverity`.
- `writeReviewArtifact` — atomic temp+rename; engine-only; called only on a successful round.
- `readReviewArtifact` / `readReviewArtifactSync` — null-on-invalid.
- `ReviewArtifactSchema` — shape unchanged (Out of Scope).

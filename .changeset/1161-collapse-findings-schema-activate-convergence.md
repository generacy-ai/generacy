---
"@generacy-ai/orchestrator": patch
---

Collapse the parallel review findings-artifact schemas, unify the verdict/severity logic, and activate the convergence engine inside the live review executor (#1161).

Three separate findings-artifact shapes, two `computeVerdict` implementations, and three `SEVERITY_RANK` tables had accreted across the review/remediate path. This consolidates them onto a single canonical `ReviewFinding`/`ReviewArtifact` schema, one `computeVerdict`, and one `SEVERITY_RANK` in `worker/review-artifact.ts`. Findings now carry a deterministic `id` (`sha256(file + "\0" + title)` sliced to 24 hex chars); a `backfillFindingIds` pass runs before Zod validation so pre-#1161 sidecars still parse. The finding `round` constraint is tightened from non-negative to positive to match its semantics (rounds start at 1).

The #1126 delta-scoped convergence merge (round-N→N+1 carry-forward + verdict recompute) now runs end-to-end **inside** the live review executor; the old `runReviewConvergence` phase-loop pre-pass is deleted, so the round lives only in the sidecar (single round source). The per-workflow default `blockingSeverity` is reconciled to `major` for `speckit-feature` and `critical` for every other workflow, in both code and `docs/reference/review-artifacts.md`, and a `settings = null` resolution path is fixed.

Internal consolidation and bug fix — no new public exports, no new label vocabulary. The whole path stays behind `reviewPhaseEnabled` / `WORKER_REVIEW_PHASE_ENABLED`, so a flag-off cluster is byte-identical.

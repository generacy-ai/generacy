---
"@generacy-ai/orchestrator": patch
---

Keep engine bookkeeping sidecars out of PR branches (#1162).

The phase-completion commit path staged the whole working tree with an unscoped
`git add -A` (`stageAll()`), committing engine bookkeeping sidecars
(`.generacy/review-findings-*`, `review-candidate-*`, `pause-context-*`) into
product PR diffs. Because the findings sidecar carries raw validate stderr
tails, the next review round then reviewed the engine's own bookkeeping as if it
were product code. Three orchestrator-internal, additive fixes:

- **FR-001/FR-002**: `PrManager.commitAndPush` now stages a targeted, filtered
  set — `[...status.unstaged, ...status.untracked]` minus any path matching
  `isEngineSidecar` — and commits only when something product-relevant remains.
  A sidecar-only phase produces no commit (no empty commits). Deletions reported
  in `status.unstaged` are still staged so removals commit. `.generacy/config.yaml`
  and `.generacy/epics/*` remain product files and continue to commit.
- **FR-004**: the shared `ENGINE_SIDECAR_PREFIXES` predicate (`isEngineSidecar`)
  is folded into `product-diff.ts`'s `EXCLUDED_PATH_PREFIXES`, so any *already
  committed* sidecar on a pre-fix branch is excluded from the review-round diff —
  the raw stderr tail never reaches the reviewed files.
- **FR-003**: `remediationCount` is mirrored to Redis via `PhaseTracker`
  (`remediation-count:<owner>:<repo>:<issue>:<branch>`, 7-day TTL) alongside the
  disk sidecar, reconciled on gate re-entry (`max(disk, redis)`, never lowers a
  spent budget) and cleared on `completed:remediation-limit` resume. This keeps
  the cap durable across a worker restart / re-clone now that the sidecar is no
  longer committed. Best-effort no-op when Redis is down (falls back to the disk
  value). `review-artifact.ts` gains `seedRemediationCount`.

No new labels, no new public exports, no workflow-YAML changes. Pre-shipped repos
with committed sidecars are cleaned up via the one-time manual
`specs/1162-severity-major-p1-engine/scripts/cleanup-committed-sidecars.sh`.

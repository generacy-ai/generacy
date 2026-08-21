---
"@generacy-ai/orchestrator": patch
"@generacy-ai/workflow-engine": minor
---

Keep engine bookkeeping sidecars out of PR branches (#1162).

The phase-completion commit path staged the whole working tree with an unscoped
`git add -A` (`stageAll()`), committing engine bookkeeping sidecars
(`.generacy/review-findings-*`, `review-candidate-*`, `pause-context-*`) into
product PR diffs. Because the findings sidecar carries raw validate stderr
tails, the next review round then reviewed the engine's own bookkeeping as if it
were product code. The orchestrator-internal fixes:

- **FR-001/FR-002**: `PrManager.commitAndPush` now stages a targeted, filtered
  set — `[...status.staged, ...status.unstaged, ...status.untracked]` minus any
  path matching `isEngineSidecar` — and commits only when something
  product-relevant remains. Including `status.staged` means an index-only product
  change (already `git add`ed, no further working-tree diff) is no longer
  stranded. The commit is made with an explicit pathspec of that filtered set
  (`git commit -m <msg> -- <paths>`), so a sidecar some other actor pre-staged
  into the index can never be folded in by a whole-index commit — the "never
  committed" guarantee holds even against a dirty index. A sidecar-only phase
  produces no commit (no empty commits). Deletions reported in `status.unstaged`
  are still staged so removals commit. `.generacy/config.yaml` and
  `.generacy/epics/*` remain product files and continue to commit.
- **FR-004**: the shared `ENGINE_SIDECAR_PREFIXES` predicate (`isEngineSidecar`)
  is folded into `product-diff.ts`'s `EXCLUDED_PATH_PREFIXES`, so any *already
  committed* sidecar on a pre-fix branch is excluded from the review-round diff —
  the raw stderr tail never reaches the reviewed files. The list is the single
  source of truth for sidecar exclusion and now enumerates every
  `.generacy/<name>-<id>.json` bookkeeping file written into the checkout:
  `review-findings-`, `review-candidate-`, `pause-context-`, `external-feedback-`
  (carries raw external human/PR feedback text), and `workflow-state-`.
- **`@generacy-ai/workflow-engine`**: `GitHubClient.commit()` gains an optional
  `pathspec?: string[]` argument (`git commit -m <msg> -- <paths>`); when omitted
  the whole index is committed (unchanged legacy behavior). This is the primitive
  the scoped phase-completion commit above relies on.
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

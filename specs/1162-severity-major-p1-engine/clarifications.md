# Clarifications

## Session 2026-08-21

### Q1: remediationCount persistence mechanism
**Context**: FR-003 requires `remediationCount` to survive worker restart and checkout re-clone once sidecars stop being committed. The bug's "deliberate side effect" is that committing the sidecar is currently the only thing making the counter survive a re-clone. A Redis-backed `PhaseTracker` (`getValueRaw`/`setValueRaw`/`clearRaw`) is already wired into `phase-loop.ts` and used for `phase-start-ref` keys; it degrades to null/no-op when Redis is unavailable. The choice determines the whole fix architecture.
**Question**: Where should `remediationCount` (and any other resumability state a committed sidecar carries) be persisted so it survives worker restart / re-clone?
**Options**:
- A: Redis via the existing `PhaseTracker`, keyed by workflow id (same store the phase loop already uses; survives re-clone and fresh-container restart; best-effort/no-op when Redis is down)
- B: An out-of-tree file keyed by workflow id (e.g. under `/var/lib/generacy/`), outside the checkout so `git add -A` never sees it (survives re-clone in the same container, not a fresh container)
- C: Keep the sidecar in-tree but write only the durable counter to a minimal tracked file, excluding just the findings/pause payloads from the diff

**Answer**: *Pending*

### Q2: Staging-exclusion mechanism
**Context**: FR-001 root cause is the unscoped `git add -A` in `stageAll()` (`gh-cli.ts:1380`) called from `pr-manager.ts` `commitAndPush`. A `stageFiles(files: string[])` method already exists as an alternative. This decides how the engine bookkeeping is kept out of the commit.
**Question**: How should the phase-completion commit path stop staging the engine sidecars?
**Options**:
- A: Replace `stageAll()` on the commit path with a targeted stage that adds product paths and never the sidecar patterns (compute changed paths, filter out engine sidecars)
- B: Add the specific sidecar patterns to `.gitignore` so `git add -A` skips them (keeps `stageAll()` unchanged)
- C: Write the sidecars outside the repo tree entirely, so `git add -A` never encounters them (couples with Q1-B)

**Answer**: *Pending*

### Q3: Exclusion scope within `.generacy/`
**Context**: `.generacy/config.yaml` and `.generacy/epics/*.yaml` are legitimately tracked product files in these repos (verified via `git ls-files`). A blanket ignore/exclusion of the whole `.generacy/` directory would stop tracking genuine config. The exclusion must therefore be scoped.
**Question**: Should the exclusion target only the specific engine-sidecar filename patterns (`review-findings-*.json`, `review-candidate-*.json`, `pause-context-*.json`), leaving `.generacy/config.yaml` and `.generacy/epics/*` fully tracked?
**Options**:
- A: Yes — exclude only the three specific sidecar patterns; never blanket-ignore `.generacy/`
- B: No — a different scope is intended (specify)

**Answer**: *Pending*

### Q4: Disposition for already-shipped committed sidecars
**Context**: FR-005 (NEEDS CLARIFICATION) — clusters that already ran the buggy engine may have `.generacy/` sidecars committed on open PR branches and/or default branches. The disposition must be recorded.
**Question**: What is the disposition for repos that already have committed `.generacy/` sidecars?
**Options**:
- A: No-op with documented rationale (this fix only prevents new commits; existing ones are left in place)
- B: Active automated cleanup as part of the fix (e.g. `git rm` the sidecars on affected branches)
- C: Document + provide a one-time manual cleanup step/script, but no automated action in the engine

**Answer**: *Pending*

### Q5: Product-diff review exclusion (defense in depth)
**Context**: FR-004 requires the exclusion to be effective for the review-round diff, not only the final PR. The product-diff guard uses `EXCLUDED_PATH_PREFIXES` (currently only `specs/`) and `EXCLUDED_EXACT_PATHS`. If a stale committed sidecar already exists in a branch, stopping new commits alone would not hide it from the next review round.
**Question**: Should the sidecar patterns also be added to the product-diff exclusion set (`EXCLUDED_PATH_PREFIXES` / `EXCLUDED_EXACT_PATHS`) so the review-round diff ignores them regardless of commit history?
**Options**:
- A: Yes — add the sidecar patterns to the product-diff exclusion set as well as stopping the commit (belt-and-suspenders; also protects against pre-existing committed sidecars)
- B: No — stopping the commit is sufficient; do not modify the product-diff exclusion set

**Answer**: *Pending*

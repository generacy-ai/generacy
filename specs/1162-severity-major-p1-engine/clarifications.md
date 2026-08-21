# Clarifications

## Session 2026-08-21

### Q1: remediationCount persistence mechanism
**Context**: FR-003 requires `remediationCount` to survive worker restart and checkout re-clone once sidecars stop being committed. The bug's "deliberate side effect" is that committing the sidecar is currently the only thing making the counter survive a re-clone. A Redis-backed `PhaseTracker` (`getValueRaw`/`setValueRaw`/`clearRaw`) is already wired into `phase-loop.ts` and used for `phase-start-ref` keys; it degrades to null/no-op when Redis is unavailable. The choice determines the whole fix architecture.
**Question**: Where should `remediationCount` (and any other resumability state a committed sidecar carries) be persisted so it survives worker restart / re-clone?
**Options**:
- A: Redis via the existing `PhaseTracker`, keyed by workflow id (same store the phase loop already uses; survives re-clone and fresh-container restart; best-effort/no-op when Redis is down)
- B: An out-of-tree file keyed by workflow id (e.g. under `/var/lib/generacy/`), outside the checkout so `git add -A` never sees it (survives re-clone in the same container, not a fresh container)
- C: Keep the sidecar in-tree but write only the durable counter to a minimal tracked file, excluding just the findings/pause payloads from the diff

**Answer**: A — Redis via the existing `PhaseTracker`, keyed by workflow id. The codebase already persists a review findings artifact this way (`runReviewConvergence` stores via `deps.phaseTracker.setValueRaw` keyed by `review-findings:owner:repo:issue:branch` with TTL and no-op degradation, `phase-loop.ts:1890-1945`); the on-disk sidecar (B) and in-tree counter file (C) cannot guarantee FR-003 re-clone survival.

### Q2: Staging-exclusion mechanism
**Context**: FR-001 root cause is the unscoped `git add -A` in `stageAll()` (`gh-cli.ts:1380`) called from `pr-manager.ts` `commitAndPush`. A `stageFiles(files: string[])` method already exists as an alternative. This decides how the engine bookkeeping is kept out of the commit.
**Question**: How should the phase-completion commit path stop staging the engine sidecars?
**Options**:
- A: Replace `stageAll()` on the commit path with a targeted stage that adds product paths and never the sidecar patterns (compute changed paths, filter out engine sidecars)
- B: Add the specific sidecar patterns to `.gitignore` so `git add -A` skips them (keeps `stageAll()` unchanged)
- C: Write the sidecars outside the repo tree entirely, so `git add -A` never encounters them (couples with Q1-B)

**Answer**: A — Replace `stageAll()` on the commit path with a targeted stage that adds product paths only (filter out engine sidecar patterns). Root cause is the unscoped `git add -A` via `this.github.stageAll()` in `commitAndPush` (`pr-manager.ts:129`; `gh-cli.ts:1380`), and a `stageFiles(files)` alternative already exists; `.gitignore` (B) is broader/riskier and (C) couples to the rejected Q1-B.

### Q3: Exclusion scope within `.generacy/`
**Context**: `.generacy/config.yaml` and `.generacy/epics/*.yaml` are legitimately tracked product files in these repos (verified via `git ls-files`). A blanket ignore/exclusion of the whole `.generacy/` directory would stop tracking genuine config. The exclusion must therefore be scoped.
**Question**: Should the exclusion target only the specific engine-sidecar filename patterns (`review-findings-*.json`, `review-candidate-*.json`, `pause-context-*.json`), leaving `.generacy/config.yaml` and `.generacy/epics/*` fully tracked?
**Options**:
- A: Yes — exclude only the three specific sidecar patterns; never blanket-ignore `.generacy/`
- B: No — a different scope is intended (specify)

**Answer**: A — Exclude only the three specific sidecar patterns (`review-findings-*.json`, `review-candidate-*.json`, `pause-context-*.json`); never blanket-ignore `.generacy/`. `git ls-files` confirms `.generacy/config.yaml` and `.generacy/epics/*` are legitimately tracked, so a blanket ignore would break intentional tracking.

### Q4: Disposition for already-shipped committed sidecars
**Context**: FR-005 (NEEDS CLARIFICATION) — clusters that already ran the buggy engine may have `.generacy/` sidecars committed on open PR branches and/or default branches. The disposition must be recorded.
**Question**: What is the disposition for repos that already have committed `.generacy/` sidecars?
**Options**:
- A: No-op with documented rationale (this fix only prevents new commits; existing ones are left in place)
- B: Active automated cleanup as part of the fix (e.g. `git rm` the sidecars on affected branches)
- C: Document + provide a one-time manual cleanup step/script, but no automated action in the engine

**Answer**: C — Document + provide a one-time manual cleanup step/script, but no automated engine action. An engine auto-`git rm` across shipped branches (B) is intrusive history mutation and scope creep; a pure no-op (A) leaves cruft. The documented manual step is the safe middle, and Q5's product-diff exclusion already neutralizes pre-existing committed sidecars at runtime.

### Q5: Product-diff review exclusion (defense in depth)
**Context**: FR-004 requires the exclusion to be effective for the review-round diff, not only the final PR. The product-diff guard uses `EXCLUDED_PATH_PREFIXES` (currently only `specs/`) and `EXCLUDED_EXACT_PATHS`. If a stale committed sidecar already exists in a branch, stopping new commits alone would not hide it from the next review round.
**Question**: Should the sidecar patterns also be added to the product-diff exclusion set (`EXCLUDED_PATH_PREFIXES` / `EXCLUDED_EXACT_PATHS`) so the review-round diff ignores them regardless of commit history?
**Options**:
- A: Yes — add the sidecar patterns to the product-diff exclusion set as well as stopping the commit (belt-and-suspenders; also protects against pre-existing committed sidecars)
- B: No — stopping the commit is sufficient; do not modify the product-diff exclusion set

**Answer**: A — Add the sidecar patterns to the product-diff exclusion set (`EXCLUDED_PATH_PREFIXES`) as well as stopping the commit (belt-and-suspenders; also protects against pre-existing committed sidecars). FR-004 requires exclusion effective for the review-round diff, not just the final PR, and the guard matches via `startsWith` prefixes (`product-diff.ts:12,47-53`); stopping the commit alone (B) does nothing for already-committed sidecars.

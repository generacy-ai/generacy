# Clarifications for #691: Cross-repo change detection, commit, push, and draft PR fan-out

## Batch 1 — 2026-05-22

### Q1: phase:after hook availability
**Context**: The spec lists Issue D (`phase:after` hook mechanism) as a hard dependency (line 111). Investigation shows this hook mechanism does not exist in the workflow engine — there are `phase:complete` events but no handler registration/invocation system for post-phase callbacks.
**Question**: Should this issue also implement the `phase:after` hook mechanism inline, or is it blocked until Issue D lands separately? If inline, should it be a generic hook system (register arbitrary callbacks) or a minimal one-off wiring?
**Options**:
- A: Blocked — wait for Issue D to land the hook mechanism first
- B: Implement a generic `phase:after` hook registration system as part of this issue
- C: Implement a minimal one-off wiring (e.g., listen to `phase:complete` event and call the fan-out handler directly in the executor)

**Answer**: A (blocked on #690). Develop the handler's internal logic in parallel — change detection, idempotent branch/PR reconciliation, `linkedPRs` updates — but integrate the registration against the real `phaseAfterHandlers` API once #690 (PR #698) merges. Inline duplication (B) wastes work and the two will diverge; one-off wiring through `phase:complete` (C) becomes tech debt the moment D lands and adds a second mechanism that has to be removed. Parallel development is fine; the merge order is #690 → #691.

### Q2: Unpushed commit detection
**Context**: FR-002 says to detect changes if "the current branch has unpushed commits" (line 17). The existing `getStatus()` in `GitHubClient` returns `{ branch, has_changes, staged, unstaged, untracked }` — it covers working tree dirtiness but has no field for unpushed commits.
**Question**: How should unpushed commits be detected? Should `getStatus()` be extended with an `unpushed` field, or should the handler use a separate git command (e.g., `git log origin/<branch>..HEAD`)?
**Options**:
- A: Extend `getStatus()` / `GitStatus` interface to include an `unpushedCount` or `hasUnpushed` field
- B: Use a separate git command in the handler without modifying `GitStatus`

**Answer**: A (extend `GitStatus` with `hasUnpushed` / `unpushedCount`). `getStatus()` is the right home for git-state-of-the-working-tree info; pushing this concern into the handler duplicates logic that should live in the `GitHubClient`. Other callers (review-changes, commit-and-push) will likely benefit too. Extending the interface is small and pays off broadly.

### Q3: Which phases trigger the handler
**Context**: The spec says "Register a handler that runs after each phase" (line 15). But running fan-out after every phase (clarify, plan, tasks) seems wasteful — only the implement phase typically produces code changes in sibling repos.
**Question**: Should the handler run after every phase, or only after specific phases (e.g., only `implement`)? If all phases, should it short-circuit early when `siblingWorkdirs` is empty?
**Options**:
- A: Run after every phase (short-circuit if no dirty siblings detected)
- B: Run only after the `implement` phase
- C: Run after a configurable set of phases

**Answer**: A (every phase, short-circuit when no dirty siblings). Cost is one `getStatus()` per sibling per phase — negligible. Restricting to implement only (B) creates a false-negative class if any non-implement phase ever produces sibling edits. Configurable (C) is over-engineered. Run-everywhere + cheap short-circuit is robust against future agent behavior changes.

### Q4: Primary context sourcing
**Context**: The handler needs several pieces of context to construct sibling PRs: (1) the primary branch name (for sibling branch naming), (2) the primary PR title (for sibling PR title), (3) the issue number (for the `Closes generacy-ai/<repo>#<N>` reference), and (4) the primary repo name (for the `Closes` org/repo path). The spec doesn't specify where these come from within the handler's execution context.
**Question**: Where should each of these be sourced? Specifically: Is the branch name from `getStatus().branch` on the primary workdir? Is the issue number parsed from the branch name (e.g., `691-feature` → 691)? Is the primary repo name from the workspace config or git remote URL? Is the primary PR title from the workflow state or a GitHub API call?

**Answer**: Sourcing rules: (1) Branch name → `getStatus().branch` on the primary workdir. (2) Issue number → from the phase-loop context's tracked issue (`item.number` or equivalent), not parsed from branch name. (3) Primary repo name → from workspace config, identified via the same path-match logic as #687. Fall back to parsing primary's git remote URL only if workspace config doesn't identify a primary. (4) PR title → fetch the primary PR via `gh pr view --json title` at fan-out time. Reflects any manual edits a reviewer made.

### Q5: Partial fan-out failure semantics
**Context**: The failure behavior section (lines 28-29) says push/PR-create failures should "fail loud" and detection failures on one sibling should "log and skip." But consider: sibling A's push succeeds, then sibling B's push fails and the phase errors out. On retry, sibling A is now in a partially-pushed state.
**Question**: When one sibling's push/PR-create fails after other siblings have already succeeded, should the successfully-pushed siblings be left as-is (accepted partial state), or should the handler attempt to roll back? And on retry, the idempotent branch-checkout for already-pushed siblings should handle this — is that the intended recovery mechanism?
**Options**:
- A: Leave successful siblings as-is; idempotent retry handles recovery naturally
- B: Attempt rollback of successful siblings before failing
- C: Process all siblings, collect errors, then fail with a summary (no rollback)

**Answer**: A (leave successful siblings as-is; idempotent retry recovers). The Phase 2 design already commits to idempotent branch-checkout + PR-exists checks. On retry, already-pushed siblings are detected and no-op'd, the previously-failing sibling gets re-attempted, and the `linkedPRs` de-dup helper from #689 handles state. Rollback (B) adds complexity for a case idempotency already covers.

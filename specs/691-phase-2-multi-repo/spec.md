# Feature Specification: **Phase 2 of [multi-repo workflow support](https://github

**Branch**: `691-phase-2-multi-repo` | **Date**: 2026-05-22 | **Status**: Draft

## Summary

**Phase 2 of [multi-repo workflow support](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/multi-repo-workflows-plan.md).** This is the user-visible change — sibling-repo edits get committed, pushed, and turned into linked draft PRs.

## Summary

The agent can already edit sibling repos when told they exist (Issue B). What's missing is the post-execution pickup: detect those edits, commit them with a matching branch name, push, and open a draft PR in the sibling repo that auto-closes the primary issue via GitHub's cross-repo `Closes <org>/<repo>#<n>` syntax.

This issue develops the handler's internal logic in parallel with Issue D (#690), but integrates registration against the real `phaseAfterHandlers` API once #690 (PR #698) merges. Merge order: #690 → #691.

## Scope

Register a `phase:after` handler that runs after every phase (short-circuits when no dirty siblings detected). For every sibling in `ActionContext.siblingWorkdirs`:

1. **Detect changes.** Use `getStatus()` against the sibling workdir. `GitStatus` interface extended with `hasUnpushed`/`unpushedCount` field. Consider it changed if either (a) working tree is dirty, or (b) `hasUnpushed` is true. Skip if clean.
2. **Branch.** Check whether a branch matching the primary's branch name already exists in the sibling. If yes → check it out (idempotency for retries). If no → create it from the sibling's default branch.
3. **Commit.** Stage all changes and commit with the same message as the primary's last commit.
4. **Push.** Push the branch to the sibling's origin.
5. **PR.** Check whether a draft PR exists on that branch:
   - **Exists** → leave it (just append to `linkedPRs` if missing).
   - **Doesn't exist** → create a draft PR with title matching the primary PR's title and body containing `Closes generacy-ai/<primary-repo>#<issue-number>` (cross-repo close reference).
6. **Persist.** Append `{ repo, number, branch, url }` to `WorkflowState.linkedPRs` using the idempotent-append helper from Issue C.

### Failure behavior

- Push fails or PR-create fails → **fail loud**. The `phase:after` handler throws, the phase fails, the workflow surfaces an error. Do not silently log.
- Detection fails on one sibling (e.g. path doesn't exist) → log and skip that sibling; continue with the rest.

### Cross-repo `Closes` syntax

GitHub auto-closes the referenced issue when the PR merges, as long as both repos are in the same org. We assume the `generacy-ai` org throughout — if `workspace.repos` ever spans orgs, we'll cross that bridge later.

## Out of scope

- Branch-name collision handling beyond \"if the branch exists, check it out and reuse it.\" If the existing branch has unrelated commits, fail loud — humans resolve.
- Coordinated merge ordering across PRs (humans decide).
- Cleanup of orphan sibling branches/PRs when a workflow aborts (separate hardening issue).
- Updating an existing sibling PR's title/body when the primary PR's title/body changes (could be a follow-on; first cut creates once and leaves alone).

## Acceptance

- Integration test (or scripted manual run): a workflow that touches files in two repos produces:
  - one primary PR with `Closes #<issue>`
  - one sibling PR with `Closes generacy-ai/<primary-repo>#<issue>`
  - `WorkflowState.linkedPRs` populated with both
- Idempotency test: re-running the implement phase after the first fan-out reuses the existing sibling branch + PR; no duplicate PRs created.
- Failure test: a sibling with a push failure causes the phase to fail (not silently succeed).

## Dependencies

Hard deps: Issues A (context), C (state schema), D (hook). Soft dep on B (agent awareness) — without it, the agent rarely makes sibling edits, so this handler usually no-ops.

## Blocks

Phase 3 Issue F (review-phase coordination needs `linkedPRs` populated).

## Primary Context Sourcing

The handler sources context as follows:
- **Branch name** → `getStatus().branch` on the primary workdir
- **Issue number** → from the phase-loop context's tracked issue (`item.number`), not parsed from branch name
- **Primary repo name** → from workspace config via path-match logic (#687). Fall back to parsing primary's git remote URL only if workspace config doesn't identify a primary
- **PR title** → fetch the primary PR via `gh pr view --json title` at fan-out time (reflects manual title edits)

## Partial Failure & Idempotency

When one sibling's push/PR-create fails after other siblings have already succeeded:
- Leave successful siblings as-is (accepted partial state)
- Idempotent retry handles recovery: already-pushed siblings are detected and no-op'd, the previously-failing sibling gets re-attempted
- `linkedPRs` de-dup helper from #689 handles state consistency

## User Stories

### US1: Multi-repo change fan-out

**As a** developer working across multiple repos,
**I want** sibling-repo edits to be automatically committed, pushed, and turned into linked draft PRs,
**So that** cross-repo changes from a single workflow are tracked and closeable together.

**Acceptance Criteria**:
- [ ] Sibling changes detected via extended `getStatus()` (dirty tree or unpushed commits)
- [ ] Sibling branch created matching primary branch name (or reused if exists)
- [ ] Draft PR created with `Closes generacy-ai/<primary-repo>#<issue>` in body
- [ ] `WorkflowState.linkedPRs` populated with `{ repo, number, branch, url }`
- [ ] Idempotent: re-running produces no duplicate branches or PRs

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Extend `GitStatus` with `hasUnpushed`/`unpushedCount` field | P1 | Benefits other callers (review-changes, commit-and-push) |
| FR-002 | Detect sibling changes (dirty tree or unpushed commits) | P1 | Short-circuit if clean |
| FR-003 | Create/checkout matching branch in sibling repo | P1 | Idempotent: reuse existing branch |
| FR-004 | Stage, commit, and push sibling changes | P1 | Commit message matches primary's last commit |
| FR-005 | Create draft PR with cross-repo `Closes` reference | P1 | Skip if PR already exists on branch |
| FR-006 | Persist to `WorkflowState.linkedPRs` via idempotent-append | P1 | De-dup helper from #689 |
| FR-007 | Register as `phase:after` handler via #690 API | P1 | Blocked on #690 merge; develop logic in parallel |
| FR-008 | Run after every phase with short-circuit | P2 | One `getStatus()` per sibling per phase — negligible cost |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Sibling PR creation | 100% of dirty siblings get draft PRs | Integration test with 2-repo workflow |
| SC-002 | Idempotency | Zero duplicate PRs on retry | Re-run implement phase, verify no duplicates |
| SC-003 | Failure propagation | Push/PR failures surface as phase errors | Simulate push failure, verify phase fails |

## Assumptions

- All repos are in the `generacy-ai` GitHub org (required for cross-repo `Closes` syntax)
- Issue D (#690) `phaseAfterHandlers` API lands before this PR merges
- `siblingWorkdirs` is populated by Phase 1 (#687) in `ActionContext`
- `linkedPRs` schema and idempotent-append helper available from Issue C (#689)

## Out of Scope

- Branch-name collision handling beyond "reuse existing branch" (fail loud on unrelated commits)
- Coordinated merge ordering across PRs
- Cleanup of orphan sibling branches/PRs on workflow abort
- Updating existing sibling PR title/body when primary changes

---

*Generated by speckit*

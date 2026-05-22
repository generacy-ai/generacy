# Feature Specification: Cross-repo change detection, commit, push, and draft PR fan-out

**Branch**: `691-phase-2-multi-repo` | **Date**: 2026-05-22 | **Status**: Draft

## Summary

Phase 2 of [multi-repo workflow support](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/multi-repo-workflows-plan.md). This is the user-visible change — sibling-repo edits get committed, pushed, and turned into linked draft PRs.

The agent can already edit sibling repos when told they exist (Phase 1, #687 widened `ActionContext` with `siblingWorkdirs`). What's missing is the post-execution pickup: detect those edits, commit them with a matching branch name, push, and open a draft PR in the sibling repo that auto-closes the primary issue via GitHub's cross-repo `Closes <org>/<repo>#<n>` syntax.

This issue registers a `phase:after` handler that does that work, idempotently, for every sibling discovered by Phase 1.

## Scope

Register a handler that runs after each phase. For every sibling in `ActionContext.siblingWorkdirs`:

1. **Detect changes.** Use `getStatus()` against the sibling workdir. Consider it changed if either (a) working tree is dirty, or (b) the current branch has unpushed commits. Skip if clean.
2. **Branch.** Check whether a branch matching the primary's branch name already exists in the sibling. If yes -> check it out (idempotency for retries). If no -> create it from the sibling's default branch.
3. **Commit.** Stage all changes and commit with the same message as the primary's last commit.
4. **Push.** Push the branch to the sibling's origin.
5. **PR.** Check whether a draft PR exists on that branch:
   - **Exists** -> leave it (just append to `linkedPRs` if missing).
   - **Doesn't exist** -> create a draft PR with title matching the primary PR's title and body containing `Closes generacy-ai/<primary-repo>#<issue-number>` (cross-repo close reference).
6. **Persist.** Append `{ repo, number, branch, url }` to `WorkflowState.linkedPRs` using the idempotent-append helper.

### Failure behavior

- Push fails or PR-create fails -> **fail loud**. The `phase:after` handler throws, the phase fails, the workflow surfaces an error. Do not silently log.
- Detection fails on one sibling (e.g. path doesn't exist) -> log and skip that sibling; continue with the rest.

### Cross-repo `Closes` syntax

GitHub auto-closes the referenced issue when the PR merges, as long as both repos are in the same org. We assume the `generacy-ai` org throughout.

## User Stories

### US1: Automated sibling PR creation

**As a** developer working across multiple repos in a workspace,
**I want** the agent to automatically commit, push, and open draft PRs in sibling repos when it makes cross-repo edits,
**So that** I don't have to manually track and propagate changes across repositories.

**Acceptance Criteria**:
- [ ] After a phase completes, any dirty sibling repos have their changes committed and pushed
- [ ] A draft PR is created in each sibling repo with a cross-repo `Closes` reference
- [ ] The sibling PR branch name matches the primary repo's branch name

### US2: Idempotent re-runs

**As a** developer re-running a workflow phase (e.g. after a failure or iteration),
**I want** the fan-out handler to reuse existing sibling branches and PRs,
**So that** I don't end up with duplicate branches or PRs cluttering the sibling repos.

**Acceptance Criteria**:
- [ ] Re-running a phase reuses the existing sibling branch (checks it out rather than creating a new one)
- [ ] Re-running does not create duplicate PRs; existing draft PRs are left as-is
- [ ] `WorkflowState.linkedPRs` is updated idempotently (no duplicate entries)

### US3: Fail-loud on push/PR errors

**As a** developer,
**I want** push or PR-creation failures to surface immediately as phase errors,
**So that** I'm aware of issues and can fix them before continuing.

**Acceptance Criteria**:
- [ ] A push failure causes the phase to fail with a clear error message
- [ ] A PR-creation failure causes the phase to fail with a clear error message
- [ ] A sibling path that doesn't exist is logged and skipped without failing the entire phase

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Register a `phase:after` handler that iterates `ActionContext.siblingWorkdirs` | P1 | Entry point for all fan-out logic |
| FR-002 | Detect dirty working tree or unpushed commits via `getStatus()` on each sibling | P1 | Skip clean siblings |
| FR-003 | Create or checkout a branch in the sibling matching the primary's branch name | P1 | Create from default branch if new |
| FR-004 | Stage all changes and commit with the primary's last commit message | P1 | `git add -A && git commit` |
| FR-005 | Push the sibling branch to origin | P1 | Fail loud on push error |
| FR-006 | Create a draft PR in the sibling repo if none exists for that branch | P1 | Title mirrors primary PR; body has `Closes` cross-ref |
| FR-007 | Append `{ repo, number, branch, url }` to `WorkflowState.linkedPRs` idempotently | P1 | Dedup by repo+branch |
| FR-008 | Log and skip siblings with inaccessible paths; continue processing remaining siblings | P2 | Partial failure tolerance |
| FR-009 | Use `GhCliGitHubClient` with `tokenProvider` for authenticated git/gh operations | P1 | Consistent with #620 pattern |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Multi-repo workflow produces linked PRs | Primary + N sibling draft PRs created | Integration test with 2-repo workspace |
| SC-002 | Idempotency on re-run | No duplicate branches or PRs | Re-run implement phase, verify same PR numbers |
| SC-003 | Failure propagation | Push/PR-create errors surface as phase failures | Simulate push failure, verify phase error |
| SC-004 | Cross-repo close references | Sibling PR body contains valid `Closes org/repo#N` | Inspect created PR body |

## Assumptions

- All repos in `workspace.repos` belong to the same GitHub org (`generacy-ai`)
- The `phase:after` hook mechanism (Issue D) is available in the workflow engine
- `WorkflowState.linkedPRs` schema (Issue C) is defined and supports idempotent append
- `siblingWorkdirs` (Phase 1, #687) is populated in `ActionContext` by the time the handler runs
- GitHub App or PAT token has sufficient permissions to push branches and create PRs in sibling repos

## Out of Scope

- Branch-name collision handling beyond "if the branch exists, check it out and reuse it"
- Coordinated merge ordering across PRs (humans decide)
- Cleanup of orphan sibling branches/PRs when a workflow aborts
- Updating an existing sibling PR's title/body when the primary PR's title/body changes
- Cross-org repo support (all repos assumed to be in `generacy-ai`)

## Dependencies

- **Hard**: Phase 1 #687 (`siblingWorkdirs` in `ActionContext`), Issue C (state schema `linkedPRs`), Issue D (`phase:after` hook)
- **Soft**: Issue B (agent awareness of sibling repos) — without it, agent rarely makes sibling edits, so handler usually no-ops

## Blocks

Phase 3 Issue F (review-phase coordination needs `linkedPRs` populated).

---

*Generated by speckit*

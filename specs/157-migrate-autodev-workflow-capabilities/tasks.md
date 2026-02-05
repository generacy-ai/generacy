# Tasks: Migrate autodev workflow capabilities to Generacy actions

**Input**: Design documents from `/specs/157-migrate-autodev-workflow-capabilities/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1 = workflow author, US2 = orchestrator)

---

## Phase 1: Foundation (Registry & Client Abstraction)

- [x] T001 [US1] Create GitHub types file at `packages/workflow-engine/src/types/github.ts` with Issue, PullRequest, Label, Comment, LabelStatus, EpicContext interfaces from data-model.md
- [x] T002 [US1] Refactor `packages/workflow-engine/src/types/action.ts` to support namespace-based action identifiers (e.g., `github.preflight`)
- [x] T003 [P] [US1] Create GitHubClient interface at `packages/workflow-engine/src/actions/github/client/interface.ts` with issue, PR, label, and git operations
- [x] T004 [US1] Implement GhCliGitHubClient at `packages/workflow-engine/src/actions/github/client/gh-cli.ts` using `gh` CLI commands
- [x] T005 [US1] Create client barrel export at `packages/workflow-engine/src/actions/github/client/index.ts`
- [x] T006 [US1] Modify `packages/workflow-engine/src/actions/index.ts` to support namespace registration via `registerNamespace()` and `get()` methods

---

## Phase 2: Core GitHub Actions

- [x] T007 [US1] Implement `github.preflight` action at `packages/workflow-engine/src/actions/github/preflight.ts` - validate environment, parse issue URL, detect branch, analyze labels
- [x] T008 [P] [US1] Write tests for `github.preflight` at `packages/workflow-engine/tests/actions/github/preflight.test.ts`
- [x] T009 [US1] Implement `github.get_context` action at `packages/workflow-engine/src/actions/github/get-context.ts` - retrieve spec, plan, tasks artifacts
- [x] T010 [P] [US1] Write tests for `github.get_context` at `packages/workflow-engine/tests/actions/github/get-context.test.ts`
- [x] T011 [US1] Implement `github.review_changes` action at `packages/workflow-engine/src/actions/github/review-changes.ts` - review uncommitted changes
- [x] T012 [P] [US1] Write tests for `github.review_changes` at `packages/workflow-engine/tests/actions/github/review-changes.test.ts`
- [x] T013 [US1] Implement `github.commit_and_push` action at `packages/workflow-engine/src/actions/github/commit-and-push.ts` - commit with issue reference, push
- [x] T014 [P] [US1] Write tests for `github.commit_and_push` at `packages/workflow-engine/tests/actions/github/commit-and-push.test.ts`
- [x] T015 [US1] Implement `github.merge_from_base` action at `packages/workflow-engine/src/actions/github/merge-from-base.ts` - merge base branch with conflict detection
- [x] T016 [P] [US1] Write tests for `github.merge_from_base` at `packages/workflow-engine/tests/actions/github/merge-from-base.test.ts`
- [x] T017 [US1] Create GitHub namespace registration at `packages/workflow-engine/src/actions/github/index.ts` exporting all github.* actions

---

## Phase 3: PR Management Actions

- [x] T018 [US1] Implement `github.create_draft_pr` action at `packages/workflow-engine/src/actions/github/create-draft-pr.ts` - create draft PR linked to issue
- [x] T019 [P] [US1] Write tests for `github.create_draft_pr` at `packages/workflow-engine/tests/actions/github/create-draft-pr.test.ts`
- [x] T020 [US1] Implement `github.mark_pr_ready` action at `packages/workflow-engine/src/actions/github/mark-pr-ready.ts` - convert draft to ready
- [x] T021 [P] [US1] Write tests for `github.mark_pr_ready` at `packages/workflow-engine/tests/actions/github/mark-pr-ready.test.ts`
- [x] T022 [US1] Implement `github.update_pr` action at `packages/workflow-engine/src/actions/github/update-pr.ts` - update PR description with phase status
- [x] T023 [P] [US1] Write tests for `github.update_pr` at `packages/workflow-engine/tests/actions/github/update-pr.test.ts`
- [x] T024 [US1] Implement `github.read_pr_feedback` action at `packages/workflow-engine/src/actions/github/read-pr-feedback.ts` - get unresolved comments
- [x] T025 [P] [US1] Write tests for `github.read_pr_feedback` at `packages/workflow-engine/tests/actions/github/read-pr-feedback.test.ts`
- [x] T026 [US1] Implement `github.respond_pr_feedback` action at `packages/workflow-engine/src/actions/github/respond-pr-feedback.ts` - post responses
- [x] T027 [P] [US1] Write tests for `github.respond_pr_feedback` at `packages/workflow-engine/tests/actions/github/respond-pr-feedback.test.ts`
- [x] T028 [US1] Implement `github.add_comment` action at `packages/workflow-engine/src/actions/github/add-comment.ts` - add issue comment
- [x] T029 [P] [US1] Write tests for `github.add_comment` at `packages/workflow-engine/tests/actions/github/add-comment.test.ts`
- [x] T030 [US1] Update `packages/workflow-engine/src/actions/github/index.ts` with PR management actions

---

## Phase 4: Workflow Management Actions

- [x] T031 [US2] Create workflow types at `packages/workflow-engine/src/types/github.ts` with CorePhase, ReviewGate, StageProgress, WorkflowStage interfaces (merged with github.ts)
- [x] T032 [US2] Implement `workflow.update_phase` action at `packages/workflow-engine/src/actions/workflow/update-phase.ts` - manage phase labels
- [x] T033 [P] [US2] Write tests for `workflow.update_phase` at `packages/workflow-engine/tests/actions/workflow/update-phase.test.ts`
- [x] T034 [US2] Implement `workflow.check_gate` action at `packages/workflow-engine/src/actions/workflow/check-gate.ts` - check review gate status
- [x] T035 [P] [US2] Write tests for `workflow.check_gate` at `packages/workflow-engine/tests/actions/workflow/check-gate.test.ts`
- [x] T036 [US2] Implement `workflow.update_stage` action at `packages/workflow-engine/src/actions/workflow/update-stage.ts` - update stage comment with HTML templates
- [x] T037 [P] [US2] Write tests for `workflow.update_stage` at `packages/workflow-engine/tests/actions/workflow/update-stage.test.ts`
- [x] T038 [US2] Create workflow namespace registration at `packages/workflow-engine/src/actions/workflow/index.ts` exporting all workflow.* actions

---

## Phase 5: Epic Management Actions

- [x] T039 [US2] Implement `epic.post_tasks_summary` action at `packages/workflow-engine/src/actions/epic/post-tasks-summary.ts` - post task summary for review
- [x] T040 [P] [US2] Write tests for `epic.post_tasks_summary` at `packages/workflow-engine/tests/actions/epic/post-tasks-summary.test.ts`
- [x] T041 [US2] Implement `epic.check_completion` action at `packages/workflow-engine/src/actions/epic/check-completion.ts` - check child issue status
- [x] T042 [P] [US2] Write tests for `epic.check_completion` at `packages/workflow-engine/tests/actions/epic/check-completion.test.ts`
- [x] T043 [US2] Implement `epic.update_status` action at `packages/workflow-engine/src/actions/epic/update-status.ts` - update progress comment
- [x] T044 [P] [US2] Write tests for `epic.update_status` at `packages/workflow-engine/tests/actions/epic/update-status.test.ts`
- [x] T045 [US2] Implement `epic.create_pr` action at `packages/workflow-engine/src/actions/epic/create-pr.ts` - create rollup PR
- [x] T046 [P] [US2] Write tests for `epic.create_pr` at `packages/workflow-engine/tests/actions/epic/create-pr.test.ts`
- [x] T047 [US2] Implement `epic.close` action at `packages/workflow-engine/src/actions/epic/close.ts` - close epic after merge
- [x] T048 [P] [US2] Write tests for `epic.close` at `packages/workflow-engine/tests/actions/epic/close.test.ts`
- [x] T049 [US2] Implement `epic.dispatch_children` action at `packages/workflow-engine/src/actions/epic/dispatch-children.ts` - send to orchestrator queue
- [x] T050 [P] [US2] Write tests for `epic.dispatch_children` at `packages/workflow-engine/tests/actions/epic/dispatch-children.test.ts`
- [x] T051 [US2] Create epic namespace registration at `packages/workflow-engine/src/actions/epic/index.ts` exporting all epic.* actions

---

## Phase 6: Infrastructure & Integration

- [x] T052 [US1] Implement `github.sync_labels` action at `packages/workflow-engine/src/actions/github/sync-labels.ts` - create/update GitHub labels
- [x] T053 [P] [US1] Write tests for `github.sync_labels` at `packages/workflow-engine/tests/actions/github/sync-labels.test.ts`
- [x] T054 [US1] Update `packages/workflow-engine/src/actions/index.ts` to register github, workflow, and epic namespaces
- [x] T055 [US1] Create integration tests at `packages/workflow-engine/tests/integration/github-workflow.test.ts` testing full workflow scenarios
- [x] T056 [US1] Update `packages/workflow-engine/package.json` to add optional `@octokit/rest` peer dependency for future GitHub App support

---

## Dependencies & Execution Order

### Phase Dependencies
1. **Phase 1** (Foundation) must complete before other phases - establishes types, client abstraction, and registry
2. **Phase 2** (Core GitHub) depends on Phase 1 - needs GitHubClient and types
3. **Phase 3** (PR Management) depends on Phase 1 - needs GitHubClient
4. **Phase 4** (Workflow) depends on Phase 1 - needs namespace registry
5. **Phase 5** (Epic) depends on Phase 1 and Phase 4 - needs workflow types for phase management
6. **Phase 6** (Infrastructure) depends on Phases 1-5 - integrates all namespaces

### Parallel Opportunities
- **Within each phase**: Test tasks marked [P] can run in parallel with their implementation tasks
- **T003** (GitHubClient interface) can be done while T002 (action types refactor) is in progress
- **T007-T016**, **T018-T030**, **T032-T037**, **T039-T050**: Each action+test pair, the test can be written in parallel once the action interface is defined

### Task Counts by Phase
| Phase | Tasks | Parallel Eligible |
|-------|-------|-------------------|
| Phase 1: Foundation | 6 | 1 |
| Phase 2: Core GitHub | 11 | 5 |
| Phase 3: PR Management | 13 | 6 |
| Phase 4: Workflow | 8 | 3 |
| Phase 5: Epic | 13 | 6 |
| Phase 6: Infrastructure | 5 | 1 |
| **Total** | **56** | **22** |

---

*Generated by speckit*

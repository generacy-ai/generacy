# Feature Specification: Epic Processing with Child Issue Creation and Tracking

**Branch**: `201-description-implement-epic` | **Date**: 2026-02-21 | **Status**: Draft | **Parent Epic**: generacy#195

## Summary

Implement end-to-end epic processing support in the orchestrator so that issues labeled `type:epic` follow the standard specify/clarify/plan/tasks phase sequence, then automatically create child GitHub issues from the generated tasks, pause with `waiting-for:children-complete`, track child completion via polling, and auto-complete (rollup PR + close) when all children finish. This bridges the existing `speckit-epic` workflow definition and `epic.*` workflow-engine actions into the orchestrator's label-driven processing pipeline.

## User Stories

### US1: Epic Issue Processing Through Phases

**As a** project maintainer,
**I want** to add a `process:speckit-epic` label to an epic issue and have the orchestrator automatically run it through specification, clarification, planning, and task generation phases,
**So that** large features are systematically broken down without manual intervention.

**Acceptance Criteria**:
- [ ] Adding `process:speckit-epic` label triggers the orchestrator to pick up the issue
- [ ] `workflow:speckit-epic` identity label is added at start
- [ ] Epic processes through specify → clarify → plan → tasks phases (not implement/validate)
- [ ] Standard review gates apply: `waiting-for:clarification` after clarify (configurable)
- [ ] Phase labels (`phase:specify`, `completed:specify`, etc.) transition correctly
- [ ] Stage comments are posted/updated on the epic issue showing progress
- [ ] A draft PR is created on the epic's feature branch with spec/plan/tasks artifacts

### US2: Child Issue Creation from Tasks

**As a** project maintainer,
**I want** the orchestrator to automatically create child GitHub issues from the tasks generated during the epic's tasks phase,
**So that** each unit of work becomes a trackable, independently-assignable issue.

**Acceptance Criteria**:
- [ ] After `completed:tasks`, the agent runs `/speckit:taskstoissues` to create child issues
- [ ] Each child issue body contains `epic-parent: <epic-number>` for parent linkage
- [ ] Each child issue is labeled with `epic-child` and the appropriate `process:*` trigger label
- [ ] Each child issue is assigned to the agent account (`generacy-bot` or configured)
- [ ] The tasks-to-issues step includes a review gate (`waiting-for:tasks-review`) before creation
- [ ] A summary of created children is posted to the epic issue via `epic.post_tasks_summary`

### US3: Epic Pauses While Children Process

**As a** project maintainer,
**I want** the epic to enter a `waiting-for:children-complete` state after dispatching child issues,
**So that** the epic correctly reflects that it is blocked on downstream work.

**Acceptance Criteria**:
- [ ] After child issues are created and dispatched, the epic gets `waiting-for:children-complete` and `agent:paused` labels
- [ ] The `agent:in-progress` label is removed while waiting
- [ ] The epic issue does not consume a worker slot while paused
- [ ] The epic's stage comment reflects the "waiting for children" state

### US4: Child Completion Tracking

**As a** project maintainer,
**I want** the orchestrator to periodically check child issue status and update the epic's progress,
**So that** I can see at a glance how much of the epic is done.

**Acceptance Criteria**:
- [ ] A polling mechanism checks child completion status on a configurable interval (default: 5 minutes)
- [ ] `epic.check_completion` determines child status via `"epic-parent: N" in:body` search
- [ ] A child is considered complete when its issue is closed and its PR is merged
- [ ] `epic.update_status` creates/updates a progress comment on the epic with a progress bar, stats table, and child issue list
- [ ] Progress comment uses `<!-- epic-status -->` marker for idempotent updates

### US5: Epic Auto-Completion

**As a** project maintainer,
**I want** the epic to automatically complete when all child issues are done,
**So that** the rollup PR is created and the epic closes without manual intervention.

**Acceptance Criteria**:
- [ ] When `epic.check_completion` reports 100% and `ready_for_pr: true`, the monitor triggers completion
- [ ] `waiting-for:children-complete` and `agent:paused` labels are removed
- [ ] `epic.create_pr` creates a rollup PR from the epic branch to the base branch (develop/main)
- [ ] The rollup PR title follows `[Epic] <issue title>` format and body references `Closes #<epic>`
- [ ] `needs:epic-approval` label is added to the rollup PR
- [ ] After PR merge, `epic.close` posts a completion comment and closes the epic issue

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Add `process:speckit-epic` and `workflow:speckit-epic` to `WORKFLOW_LABELS` | P1 | Currently missing from label definitions |
| FR-002 | Register `speckit-epic` workflow in `WorkerConfig.gates` with epic-appropriate gates | P1 | Gates: `waiting-for:clarification` after clarify, `waiting-for:tasks-review` after tasks |
| FR-003 | Define epic-specific phase sequence: specify → clarify → plan → tasks (no implement/validate) | P1 | Epic stops after task generation; children handle implementation |
| FR-004 | After tasks phase, execute `/speckit:taskstoissues` to create child issues | P1 | Integrates with existing `tasks-to-issues.yaml` workflow or direct `spec_kit.tasks_to_issues` action |
| FR-005 | Run `epic.dispatch_children` to assign children to agent and add `agent:dispatched` labels | P1 | Uses existing action in workflow-engine |
| FR-006 | Add `process:speckit-feature` (or appropriate trigger) label to each child issue | P1 | Triggers orchestrator processing of each child independently |
| FR-007 | Apply `waiting-for:children-complete` + `agent:paused` labels to epic after dispatch | P1 | Pauses epic processing and frees worker slot |
| FR-008 | Implement `EpicCompletionMonitor` in `LabelMonitorService` or as a sibling service | P1 | Polls for child completion on configurable interval |
| FR-009 | `EpicCompletionMonitor` calls `epic.check_completion` to detect 100% done | P1 | Child detection via `"epic-parent: N" in:body` GitHub search |
| FR-010 | `EpicCompletionMonitor` calls `epic.update_status` to update progress comment on epic | P2 | Runs on each poll cycle, not just on completion |
| FR-011 | On all-children-complete, remove `waiting-for:children-complete`, enqueue epic for completion phase | P1 | Analogous to gate resume: `command: 'continue'` or new `command: 'epic-complete'` |
| FR-012 | Epic completion phase runs `epic.create_pr` to create rollup PR | P1 | Only when `ready_for_pr: true` |
| FR-013 | Add `needs:epic-approval` label to rollup PR | P2 | Human must approve before merge |
| FR-014 | After rollup PR merge, run `epic.close` to close the epic issue | P2 | Can be triggered by PR merge webhook or scheduled check |
| FR-015 | Store epic-to-children mapping in Redis for faster lookups | P3 | Key: `epic:{owner}:{repo}:{issue}:children`, value: JSON array of issue numbers |
| FR-016 | Add `completed:children-complete` to `WORKFLOW_LABELS` for resume detection | P1 | Enables `LabelMonitorService` to detect epic resume via standard gate pattern |
| FR-017 | Add `GATE_MAPPING` entry for `children-complete` gate | P1 | Maps to `resumeFrom` phase for epic completion flow |
| FR-018 | Support partial child failure with manual override | P3 | If a child is stuck in `agent:error`, allow manual `completed:children-complete` to force epic completion |

## Technical Design

### Epic Phase Sequence

Epics use a truncated phase sequence that stops after task generation:

```
specify → clarify → plan → tasks → [child creation] → [pause] → [completion]
```

The `implement` and `validate` phases are skipped because children handle their own implementation. This requires either:
- **Option A**: A separate `EPIC_PHASE_SEQUENCE` constant that the phase loop uses when `workflowName === 'speckit-epic'`
- **Option B**: A post-tasks hook in the phase loop that runs child creation and exits early for epic workflows

### Post-Tasks Hook

After the tasks phase completes for an epic workflow, the worker must:

1. Run `/speckit:taskstoissues` (via Claude CLI or direct action invocation)
2. Parse created issue numbers from the output
3. Call `epic.dispatch_children` with the issue numbers
4. Call `epic.post_tasks_summary` to update the epic issue
5. Apply `waiting-for:children-complete` + `agent:paused` labels
6. Exit the phase loop (worker completes cleanly)

### Epic Completion Monitor

A new polling loop (within `LabelMonitorService` or as `EpicCompletionMonitorService`) that:

1. Finds all open issues with `waiting-for:children-complete` label
2. For each, calls `epic.check_completion` to get child status
3. Calls `epic.update_status` to refresh the progress comment
4. If `ready_for_pr: true`, adds `completed:children-complete` label to trigger resume
5. The standard `LabelMonitorService` resume detection picks up the label and enqueues with `command: 'continue'`

### Label Flow

```
[process:speckit-epic] added by human
  → [agent:in-progress, workflow:speckit-epic] added
  → [phase:specify] ... [completed:specify]
  → [phase:clarify] ... [waiting-for:clarification, agent:paused]  (gate)
  → [completed:clarification] added by human → resume
  → [phase:plan] ... [completed:plan]
  → [phase:tasks] ... [completed:tasks]
  → Child issues created with [process:speckit-feature, epic-child]
  → [waiting-for:children-complete, agent:paused] added
  → Monitor polls... updates progress comment
  → All children done → [completed:children-complete] added by monitor
  → Resume detected → enqueue with command: 'continue'
  → Epic completion phase: create rollup PR, add [needs:epic-approval]
  → PR merged → [epic.close] → issue closed
```

### Redis Keys (Optional Optimization)

```
epic:{owner}:{repo}:{issue}:children  → Set of child issue numbers
epic:{owner}:{repo}:{issue}:status    → Last known completion percentage
```

These provide faster lookups than GitHub search, but the system falls back to `"epic-parent: N" in:body` search if Redis is unavailable.

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Epic phase completion rate | 95%+ of epics reach child creation | Count epics with `completed:tasks` vs total `process:speckit-epic` events |
| SC-002 | Child issue creation accuracy | 100% of tasks produce child issues | Compare tasks.md task count to created issue count |
| SC-003 | Progress tracking latency | < 10 minutes from child completion to epic status update | Timestamp of child `completed:validate` vs epic progress comment update |
| SC-004 | Auto-completion reliability | 100% of fully-done epics trigger rollup PR | Count epics with all children merged that have rollup PRs |
| SC-005 | Worker slot efficiency | 0 worker slots consumed during `waiting-for:children-complete` | Monitor active workers vs paused epics |

## Assumptions

- The existing `epic.*` workflow-engine actions (`dispatch_children`, `check_completion`, `update_status`, `create_pr`, `close`) are functionally correct and can be invoked from the orchestrator worker
- Child issues are linked to epics via the `epic-parent: <number>` text in the issue body (no database-level parent-child relationship required)
- The `tasks-to-issues.yaml` workflow or `spec_kit.tasks_to_issues` action correctly creates issues from `tasks.md` with proper metadata
- The GitHub API search `"epic-parent: N" in:body` reliably finds child issues (GitHub search indexing delay is acceptable)
- A single orchestrator instance handles both epic and feature workflows (no separate epic-specific service)
- The `generacy-bot` (or configured agent account) has permission to create issues, add labels, and create PRs in the target repository
- Child issues use the `speckit-feature` or `speckit-bugfix` workflow and process through the full 6-phase sequence independently
- The rollup PR merge is performed by a human reviewer (not auto-merged)

## Out of Scope

- **Cross-repository epics**: Child issues must be in the same repository as the epic
- **Nested epics**: An epic's child cannot itself be an epic (no recursive epic processing)
- **Dependency ordering between children**: Children are dispatched in parallel; inter-child dependencies are not orchestrated
- **Automatic rollup PR merge**: The rollup PR requires human approval via `needs:epic-approval`
- **Epic branch merge conflict resolution**: If child PRs create conflicts on the epic branch, manual intervention is required
- **Custom child workflow selection**: All children use the same `process:speckit-feature` trigger (no per-child workflow routing)
- **Partial epic completion**: Epic cannot be marked complete if any children are still open (no "good enough" threshold)
- **JIRA/Shortcut integration**: Only GitHub Issues is supported as the backlog provider for child issue creation
- **Epic re-opening**: Once an epic is closed, re-opening and resuming is not supported

---

*Generated by speckit*

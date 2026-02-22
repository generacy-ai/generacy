# Clarification Questions

## Status: Resolved

## Questions

### Q1: Epic Phase Sequence Integration
**Context**: The current `PHASE_SEQUENCE` and `PHASE_TO_COMMAND` in `packages/orchestrator/src/worker/types.ts` are a single hardcoded array used everywhere (PhaseLoop, PhaseResolver, StageCommentManager). The spec proposes either a separate `EPIC_PHASE_SEQUENCE` constant (Option A) or a post-tasks hook with early exit (Option B). This is the most fundamental architectural decision—it determines how deeply the epic flow is embedded into the worker.
**Question**: How should the epic's truncated phase sequence (specify → clarify → plan → tasks, no implement/validate) be implemented?
**Options**:
- A) Separate phase sequence constant: Define `EPIC_PHASE_SEQUENCE` and pass the appropriate sequence into `PhaseLoop.executeLoop()` based on `workflowName`. Requires refactoring `PhaseLoop` to accept a phase sequence parameter instead of using the global `PHASE_SEQUENCE` constant.
- B) Post-tasks hook with early exit: Keep the single `PHASE_SEQUENCE` but add a hook after the tasks phase in `PhaseLoop` that checks for epic workflow and exits the loop early to run child creation logic. Minimal refactoring but mixes epic-specific logic into the generic loop.
- C) Workflow-driven phase registry: Create a `WORKFLOW_PHASE_SEQUENCES` map (`Record<string, WorkflowPhase[]>`) so any workflow can define its own phase list. The worker looks up the sequence by `workflowName`. Most extensible but larger refactor.
**Answer**: **Option C — Workflow-driven phase registry.** The architecture already supports multiple workflow types (`process:speckit-feature`, `process:speckit-bugfix`, `process:{workflow-name}`). A `WORKFLOW_PHASE_SEQUENCES` map is the natural extension. The refactor is modest — `PhaseLoop.executeLoop()` already receives a `context` with `item.workflowName`, so it just needs to accept a phase sequence parameter instead of importing the global `PHASE_SEQUENCE`. This also benefits `speckit-bugfix` which may want a shorter sequence in the future.

---

### Q2: Child Issue Creation Mechanism
**Context**: The spec references `/speckit:taskstoissues` as a Claude CLI slash command, but also mentions `spec_kit.tasks_to_issues` as a direct action. The orchestrator currently invokes phases via Claude CLI (`cli-spawner.ts`), but child creation is a deterministic operation (parse tasks.md, create GitHub issues) that doesn't require AI. The `spec_kit.tasks_to_issues` action does not yet exist in the workflow-engine's speckit operations.
**Question**: How should child issue creation from tasks.md be implemented?
**Options**:
- A) Claude CLI invocation: Run `/speckit:taskstoissues` via the CLI spawner like other phases. Consistent with existing phase execution pattern but uses an AI turn for a deterministic operation, adding latency and cost.
- B) Direct workflow-engine action: Implement `spec_kit.tasks_to_issues` as a new workflow-engine action and call it directly from the worker (bypassing CLI). More efficient but requires a new invocation path in the worker that isn't Claude CLI.
- C) Hybrid—new worker step type: Add a "direct action" step type to the phase loop alongside CLI phases and shell commands (validate). The post-tasks step calls `spec_kit.tasks_to_issues` + `epic.dispatch_children` + `epic.post_tasks_summary` as direct actions.
**Answer**: **Option B — Direct workflow-engine action.** Child creation is deterministic (parse tasks.md → create GitHub issues). Burning an AI turn for this wastes tokens and adds latency. Implement `spec_kit.tasks_to_issues` as a workflow-engine action and call it directly from the worker after the tasks phase completes. The worker already has a precedent for non-CLI execution — `runValidatePhase()` in `cli-spawner.ts` runs a shell command directly. This is the same pattern: a deterministic post-phase step that doesn't need Claude.

---

### Q3: Epic Completion Monitor Architecture
**Context**: The spec says the `EpicCompletionMonitor` can live "within `LabelMonitorService` or as a sibling service." These have different implications. `LabelMonitorService` uses label-based polling (REST API calls per label per repo). An epic monitor needs to poll differently—it searches for issues with `waiting-for:children-complete` then calls `epic.check_completion` for each. The current `LabelMonitorService` already handles process and resume detection on a 10-second adaptive interval.
**Question**: Where should the EpicCompletionMonitor live architecturally?
**Options**:
- A) Inside LabelMonitorService: Add epic polling as an additional check within the existing `pollRepo()` method. Simpler deployment but conflates two different polling concerns (label detection vs child completion checking) and different optimal intervals (10s vs 5min).
- B) Separate EpicCompletionMonitorService: A standalone service with its own polling loop, interval configuration, and lifecycle. Cleaner separation of concerns, independently configurable interval, but adds another service to manage in the orchestrator startup.
- C) Event-driven via child webhooks: Instead of polling, listen for `completed:validate` or issue close events on child issues and check if the parent epic's children are all done. No polling overhead but requires webhook infrastructure to route child events to parent epic logic.
**Answer**: **Option B — Separate EpicCompletionMonitorService.** The polling concerns are fundamentally different: `LabelMonitorService` checks for label changes on a 10-second adaptive interval, while epic completion checks need a 5-minute interval searching for `waiting-for:children-complete` issues. Conflating them would either over-poll for epics or under-poll for labels. A separate service follows the existing pattern — the orchestrator already manages multiple services (`LabelMonitorService`, `WorkerDispatcher`) with independent lifecycles. The new service is small and self-contained.

---

### Q4: Tasks Review Gate Timing
**Context**: The spec includes `waiting-for:tasks-review` as a gate after the tasks phase (FR-002, US2 AC5), meaning a human must approve the generated tasks before child issues are created. However, the current `GATE_MAPPING` maps `tasks-review` to `resumeFrom: 'implement'`, which would skip child creation entirely and jump to implement. For epics, the resume-from after tasks-review should be child creation, not implement.
**Question**: How should the tasks-review gate interact with the epic child creation flow?
**Options**:
- A) Epic-specific gate mapping: Add a separate `GATE_MAPPING` entry for epics where `tasks-review` maps to `resumeFrom: 'child-creation'` (a new pseudo-phase). Requires the phase resolver to be workflow-aware.
- B) Post-gate hook: Keep the existing `tasks-review` gate mapping but add a hook that runs after resume and before the `resumeFrom` phase begins. The hook checks if this is an epic workflow and runs child creation.
- C) Two-step gate: Split into `waiting-for:tasks-review` (human reviews tasks.md) followed by automatic child creation, then `waiting-for:tasks-to-issues-review` (human reviews created child issues before dispatch). More control but adds an extra gate.
**Answer**: **Option A — Epic-specific gate mapping.** With workflow-driven phase sequences (Q1), making `GATE_MAPPING` workflow-aware is the consistent choice. Create a `WORKFLOW_GATE_MAPPING` map keyed by workflow name. For epics, `tasks-review` maps to `resumeFrom: 'child-creation'` (a post-tasks step). The `PhaseResolver` already receives labels and command — adding `workflowName` to its resolution input is a minor change that keeps all routing logic in one place.

---

### Q5: Child Issue Trigger Label
**Context**: FR-006 says each child issue gets `process:speckit-feature` (or appropriate trigger) label, and the "Out of Scope" section says all children use the same trigger. However, an epic's tasks might include bugfixes or other work types. Also, adding `process:speckit-feature` immediately triggers the orchestrator to pick up each child, potentially overwhelming the worker pool if an epic creates 10+ children at once.
**Question**: How should child issues be labeled and when should processing be triggered?
**Options**:
- A) Immediate trigger with same label: Add `process:speckit-feature` to all children at creation time. Simple but may overwhelm the queue. The queue's FIFO ordering and worker pool concurrency limits naturally throttle processing.
- B) Staged dispatch: Create children with `epic-child` only, then add `process:speckit-feature` to children one at a time as worker slots become available. Prevents queue flooding but requires dispatch orchestration logic.
- C) Batch dispatch with concurrency config: Add trigger labels to all children at once, but add an epic-level `max-concurrent-children` configuration that the worker dispatcher respects, limiting how many children from the same epic can be in-progress simultaneously.
**Answer**: **Option A — Immediate trigger with same label.** The queue is a Redis sorted set with FIFO ordering, and `WorkerDispatcher` enforces `maxConcurrentWorkers`. This is natural throttling. Adding staged dispatch or concurrency config adds orchestration complexity for a problem the queue already solves. If an epic creates 10 children, they simply queue up and process as workers become available.

---

### Q6: Epic Completion Phase—What Runs After Children Complete
**Context**: When `completed:children-complete` is detected, the standard resume flow enqueues the epic with `command: 'continue'`. The `PhaseResolver.resolveFromContinue()` uses `GATE_MAPPING` to find `resumeFrom`. But "epic completion" (create rollup PR, close issue) is not a standard workflow phase—it's a set of workflow-engine actions (`epic.create_pr`, `epic.close`). The current worker only knows how to run CLI phases and shell validate commands.
**Question**: How should the epic completion phase (rollup PR creation + issue close) be executed?
**Options**:
- A) New "epic-complete" phase in PhaseLoop: Add `'epic-complete'` as a WorkflowPhase with a dedicated handler in the phase loop that calls `epic.create_pr` directly (not via CLI). Extends the phase type union but keeps all execution in the worker.
- B) Specialized command handler: Add `command: 'epic-complete'` alongside `process`/`continue`/`address-pr-feedback` in the worker dispatcher. Routes to a dedicated `EpicCompletionHandler` (similar to `PrFeedbackHandler`). Clean separation but adds a new command type.
- C) CLI-driven completion: Create a `/speckit:epic-complete` slash command that Claude CLI executes, which internally calls `epic.create_pr` and `epic.close`. Consistent with other phases being CLI-driven, but uses AI for deterministic operations.
**Answer**: **Option B — Specialized command handler.** This mirrors the `PrFeedbackHandler` pattern exactly. In `claude-cli-worker.ts`, `address-pr-feedback` is routed to a dedicated handler before the phase loop. Adding `epic-complete` as a fourth command type with a dedicated `EpicCompletionHandler` is clean, consistent, and keeps epic-specific logic out of the generic phase loop. The handler calls `epic.create_pr` and `epic.close` directly (deterministic operations, no CLI needed).

---

### Q7: Rollup PR Merge Detection
**Context**: FR-014 says after the rollup PR is merged, `epic.close` should run to close the epic issue. The spec suggests this "can be triggered by PR merge webhook or scheduled check" but doesn't specify which. The current orchestrator uses webhooks for label events, not PR merge events. PR merge detection is a different webhook event type (`pull_request` with `action: closed` and `merged: true`).
**Question**: How should rollup PR merge be detected to trigger epic closure?
**Options**:
- A) Webhook-driven: Add a `pull_request` webhook handler that checks for `needs:epic-approval` label and merged status, then calls `epic.close`. Immediate but requires new webhook infrastructure.
- B) Polling in EpicCompletionMonitor: After the rollup PR is created, the monitor polls for PR merge status alongside child completion checks. Reuses existing polling infrastructure but adds another polling concern.
- C) Manual trigger: Require a human to add a `completed:epic-approval` label after merging the rollup PR, which triggers the standard resume flow to run `epic.close`. Consistent with the gate pattern but adds manual step.
- D) GitHub Actions workflow: Use a GitHub Actions workflow triggered on PR merge that calls `epic.close` via the workflow-engine CLI or API. Decoupled from orchestrator but adds external dependency.
**Answer**: **Option C — Manual trigger via `completed:epic-approval` label.** This is consistent with the existing gate pattern throughout the system. Every other human decision point uses `waiting-for:X` / `completed:X` labels. Merging a rollup PR is already a deliberate manual action — adding a label is trivial overhead. Options A and D add infrastructure the system doesn't need yet.

---

### Q8: Error Handling for Child Issue Creation Failures
**Context**: The spec doesn't address what happens if child issue creation partially fails (e.g., 3 of 5 tasks successfully create issues, then a GitHub API error occurs on the 4th). The epic would be in an inconsistent state—some children created, some not—and retrying might create duplicates.
**Question**: How should partial failures during child issue creation be handled?
**Options**:
- A) All-or-nothing with rollback: If any child creation fails, delete/close the already-created children and mark the epic as `agent:error`. Human must re-trigger after fixing the issue.
- B) Idempotent retry: Track created children (via `epic-parent` body text) and on retry, skip tasks that already have corresponding issues. Allow the epic to be re-processed to fill in missing children.
- C) Partial success with notification: Create as many children as possible, post a warning comment on the epic listing which tasks failed, and proceed with `waiting-for:children-complete` for the children that were created. Missing tasks require manual issue creation.
**Answer**: **Option B — Idempotent retry.** The design already includes `epic-parent: #{issueNumber}` references in child issue bodies. On retry, the action can search for existing children with that marker and skip already-created ones. This is the most resilient approach — it handles transient GitHub API failures gracefully without risking duplicates or requiring rollback.

---

### Q9: Redis Dependency for Epic State
**Context**: FR-015 describes optional Redis keys for caching epic-to-children mappings and status. The spec says the system "falls back to GitHub search if Redis is unavailable." However, the orchestrator may or may not have Redis available in all deployment environments. Using Redis adds infrastructure dependency; not using it means every poll cycle does a GitHub search API call, which has indexing delays (sometimes 30-60 seconds for new issues).
**Question**: Should the initial implementation include Redis caching for epic state?
**Options**:
- A) GitHub search only (no Redis): Use `"epic-parent: N" in:body` search exclusively. Simpler, no additional infrastructure, but subject to GitHub search indexing delays and rate limits. Acceptable for the 5-minute poll interval.
- B) Redis required: Use Redis for all epic state (children list, completion status). Faster and more reliable but requires Redis infrastructure in all environments.
- C) Redis optional with graceful fallback: Implement Redis caching with automatic fallback to GitHub search. Code both paths. More complex but most resilient.
**Answer**: **Option A — GitHub search only (no Redis).** The polling interval is 5 minutes (per Q3), making GitHub's 30-60 second indexing delay negligible. GitHub is the source of truth for issue state, so searching it directly avoids cache invalidation concerns. The `epic-parent: #{N}` body text search is reliable and self-documenting. If performance becomes an issue later, Redis caching can be added as an optimization without architectural changes.

---

### Q10: Stage Comment Format for Epic-Specific States
**Context**: The existing `StageCommentManager` renders three stages: specification, planning, implementation. Epics have additional states not covered by this structure: "Creating child issues", "Waiting for children", and "Epic completion (rollup PR)". The current `StageType` union is `'specification' | 'planning' | 'implementation'` and `STAGE_MARKERS` has corresponding HTML markers.
**Question**: How should epic-specific progress states be displayed in issue comments?
**Options**:
- A) Extend StageType: Add new stage types (`'child-creation' | 'children-progress' | 'epic-completion'`) to the existing system. Requires updating `StageType`, `STAGE_MARKERS`, and `PHASE_TO_STAGE` for epic-specific phases.
- B) Separate epic status comment: Use the existing `epic.update_status` action's `<!-- epic-status -->` comment for all epic-specific state, independent of the standard stage comments. Two different comment systems on the same issue but no changes to the stage comment system.
- C) Unified comment with epic sections: Extend the stage comment to include optional epic-specific sections at the bottom (child progress table, rollup PR status). Single comment but more complex rendering logic.
**Answer**: **Option B — Separate epic status comment.** The existing `StageCommentManager` with its 3 stages (specification, planning, implementation) works well for standard workflows and shouldn't be complicated with epic-specific states. Use the `<!-- epic-status -->` marker for a separate comment that tracks child creation progress, child completion table, and rollup PR status. Two comments on the same issue is fine — they serve different purposes and evolve independently.

---

### Q11: Concurrency—Epic Processing During Child Processing
**Context**: The spec says epics should not consume a worker slot while waiting (US3 AC3, SC-005). However, when children are being processed, each child consumes a worker slot. If an epic creates 8 children and the worker pool has 4 slots, the remaining 4 children wait in queue. If other non-epic issues are also in the queue, the epic's children compete for slots. There's no priority mechanism mentioned.
**Question**: Should epic children have priority over other queued work?
**Options**:
- A) No priority—FIFO only: Children compete equally with other issues in the queue. Simple, fair, but an epic's completion could be delayed by unrelated work.
- B) Epic-child priority boost: Items with `epic-child` label get a slight priority boost in the queue (e.g., priority timestamp shifted earlier). Epic work completes faster but could starve non-epic issues.
- C) Configurable per-epic concurrency: Allow epics to reserve a configurable number of worker slots for their children (e.g., `max-concurrent-children: 2`). Balances epic progress with other work but adds scheduling complexity.
**Answer**: **Option A — No priority, FIFO only.** FIFO is fair, predictable, and simple. An epic's children queue alongside other work and process as slots free up. If a team wants faster epic completion, they can increase `maxConcurrentWorkers`. Priority mechanisms can always be added later if needed.

---

### Q12: `spec_kit.tasks_to_issues` Action—Task Parsing Format
**Context**: The spec assumes a `tasks-to-issues` action that parses `tasks.md` and creates GitHub issues, but doesn't specify the expected format of `tasks.md` or how it maps to issue fields (title, body, labels, assignees). The existing `speckit.tasks` phase generates a tasks file, but its output format isn't constrained. If the format isn't specified, the parsing logic could be fragile or require AI interpretation.
**Question**: What is the expected structure of `tasks.md` for deterministic parsing into child issues?
**Options**:
- A) Structured markdown with frontmatter: Each task section has YAML frontmatter (title, type, labels, estimate) followed by a markdown body. Deterministic parsing, but requires the `speckit.tasks` phase to output this specific format.
- B) Simple markdown headings: Each `## Task: <title>` section becomes an issue. Body is everything until the next heading. Minimal structure, easy to author, but limited metadata.
- C) JSON/YAML sidecar file: `tasks.md` is human-readable, but `tasks.json` (or structured block within tasks.md) is the machine-readable source for issue creation. Best of both worlds but two files to maintain.
**Answer**: **Option A — Structured markdown with frontmatter.** Deterministic parsing requires a well-defined format. YAML frontmatter per task section gives machine-readable metadata (title, type, labels) with human-readable markdown bodies. The `speckit.tasks` phase prompt can be configured to output this format. Example:

```markdown
## Task 1
---
title: Implement user authentication
type: feature
labels: [auth, security]
---
Description of the task...
```

Option B is too loose for reliable parsing. Option C adds file management complexity.

---

### Q13: Epic Branch Strategy
**Context**: The spec mentions a "rollup PR from the epic branch to the base branch" (FR-012) and that child PRs target the epic branch. However, the current orchestrator creates feature branches like `{issueNumber}-{short-name}` from the default branch. The spec doesn't clarify whether child issues should branch from the epic branch (creating a branch hierarchy: main → epic-branch → child-branches) or from the default branch with PRs targeting the epic branch.
**Question**: What branching strategy should epic child issues use?
**Options**:
- A) Children branch from epic branch: Child feature branches are created from the epic branch. Child PRs target the epic branch. Rollup PR merges epic branch to develop/main. Clean hierarchy but requires the orchestrator to pass the base branch to child workers.
- B) Children branch from default branch, PR to epic branch: Child branches are created from develop/main (current behavior) but their PRs target the epic branch instead. Simpler branching but may cause merge conflicts on the epic branch.
- C) Children branch from default branch, PR to default branch: Children behave like normal features (PR to develop/main). The rollup PR is a no-op or just closes the epic. Simplest but loses the benefit of atomic epic merging.
**Answer**: **Option A — Children branch from epic branch.** This gives atomic epic merging: all child work collects on the epic branch, and a single rollup PR merges it to develop/main. The orchestrator change is minor — pass `baseBranch` to child workers (defaulting to the epic branch name instead of develop/main). Option B risks merge conflicts. Option C loses the atomic merging benefit that makes epics valuable.

---

### Q14: Handling Stale or Abandoned Child Issues
**Context**: FR-018 mentions "partial child failure with manual override" at P3 priority, and the out-of-scope section says partial completion is not supported. However, the spec doesn't address what happens if a child issue gets stuck in `agent:error` indefinitely, or if a child is manually closed without its PR being merged. The completion monitor would never see 100% completion in these cases, leaving the epic permanently in `waiting-for:children-complete`.
**Question**: For the initial implementation, how should stuck/abandoned children be handled?
**Options**:
- A) Manual override only: If a child is stuck, a human must either fix it or manually add `completed:children-complete` to force epic completion. Simple but requires human awareness.
- B) Timeout with notification: After a configurable timeout (e.g., 7 days) with no progress on any child, post a warning comment on the epic and notify via a `needs:attention` label. Still requires manual resolution but surfaces the problem.
- C) Skip errored children: If a child has `agent:error` for more than N hours and its corresponding task is not critical, allow the epic to complete without it. The rollup PR notes which children were skipped. Risky—may miss important work.
**Answer**: **Option A — Manual override only.** The spec explicitly puts partial completion out of scope. For the initial implementation, if a child gets stuck, a human adds `completed:children-complete` to force epic completion. This is consistent with the existing pattern where all error recovery is human-initiated. Timeout notifications can be a fast follow-up enhancement.

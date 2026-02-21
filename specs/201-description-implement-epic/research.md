# Research: Epic Processing Architecture Decisions

## Context

This document records the technical research and rationale behind key architectural decisions for epic processing support. All 14 clarification questions were resolved prior to planning — this document summarizes the codebase analysis that informed those decisions.

## 1. Phase Sequence Extensibility

### Existing Architecture

The orchestrator uses a single global `PHASE_SEQUENCE` array defined in `worker/types.ts:12-14`:

```typescript
export const PHASE_SEQUENCE: WorkflowPhase[] = [
  'specify', 'clarify', 'plan', 'tasks', 'implement', 'validate',
];
```

This array is consumed by:
- `PhaseLoop.executeLoop()` — iterates from `startIndex` to end (`phase-loop.ts:84`)
- `PhaseLoop.buildPhaseProgress()` — maps all phases for stage comments (`phase-loop.ts:246`)
- `PhaseResolver.resolveFromProcess()` — iterates to find next uncompleted phase (`phase-resolver.ts:75`)
- `StageCommentManager` — maps phases to stages via `PHASE_TO_STAGE`

### Analysis: Refactor Impact

Introducing a per-workflow phase sequence requires changes to these consumers:
1. **PhaseLoop**: Add optional `phaseSequence` parameter — 1 line signature change + `s/PHASE_SEQUENCE/sequence/g`
2. **PhaseResolver**: Add `workflowName` parameter — 3 methods affected
3. **StageCommentManager**: No change needed — it receives phase arrays from PhaseLoop
4. **GateChecker**: No change needed — it looks up gates by `workflowName`

**Risk**: Low. The refactor adds an optional parameter with a default fallback. Existing call sites continue working unchanged until explicitly updated.

### Decision: Workflow-driven registry with backward compatibility

Keep `PHASE_SEQUENCE` as the default. Add `WORKFLOW_PHASE_SEQUENCES` map and `getPhaseSequence()` helper. Migrate call sites incrementally.

---

## 2. Child Issue Creation: CLI vs Direct Action

### Existing Patterns

The worker has two execution patterns:

1. **CLI phases** — Claude CLI invoked via `CliSpawner.spawnPhase()` for AI-dependent work:
   - `specify`, `clarify`, `plan`, `tasks`, `implement` phases
   - Returns `PhaseResult` with `sessionId` for resume

2. **Direct execution** — Shell command or direct function call for deterministic work:
   - `validate` phase runs `sh -c 'pnpm test && pnpm build'` via `CliSpawner.runValidatePhase()`
   - `PrFeedbackHandler` runs mixed AI + deterministic steps directly

### Analysis: Token Cost

Creating 5 child issues via Claude CLI would burn ~2000 input tokens + ~500 output tokens per issue. At typical Claude pricing, this is ~$0.04 per epic for a purely deterministic operation. More critically, it adds 30-60 seconds of latency per issue.

### Decision: Direct action

The `speckit.tasks_to_issues` action runs as a direct function call from the worker, following the `runValidatePhase()` precedent. It uses the workflow-engine's `BaseAction` pattern and the `GitHubClient` for issue creation.

---

## 3. Epic Completion Monitoring: Architecture Analysis

### Existing Monitor Services

| Service | Poll Interval | What it polls | Labels detected |
|---------|--------------|---------------|-----------------|
| `LabelMonitorService` | 10s adaptive | Issue labels per repo | `process:*`, `completed:*` |
| `PrFeedbackMonitorService` | 60s adaptive | Open PRs per repo | Unresolved review threads |

### Epic Monitoring Requirements

| Requirement | Value |
|------------|-------|
| What to poll | Issues with `waiting-for:children-complete` label |
| What to check | Child issue completion via GitHub search |
| Optimal interval | 5 minutes (children take hours, not seconds) |
| Action on completion | Add `completed:children-complete` label |

### Analysis: Co-location vs Separation

**Co-location with LabelMonitorService**:
- Pro: Single service to manage
- Con: Conflates 10s label polling with 5min completion checking
- Con: `pollRepo()` method becomes complex with conditional logic
- Con: Rate limit sharing — epic checks do multiple GitHub API calls per epic

**Separate service**:
- Pro: Independent polling interval (5min vs 10s)
- Pro: Clean separation of concerns
- Pro: Rate limit isolation
- Con: Another service lifecycle to manage in `server.ts`

### Decision: Separate `EpicCompletionMonitorService`

The polling intervals differ by 30x (10s vs 300s). The operations are fundamentally different — label detection is a single `listIssuesWithLabel()` call per label, while epic completion checking requires a search query + per-child PR status checks. Separation follows the existing pattern of independent services.

---

## 4. Existing Epic Infrastructure in Workflow Engine

### Already Implemented (workflow-engine `src/actions/epic/`)

| Action | Status | Used by |
|--------|--------|---------|
| `epic.post_tasks_summary` | Complete | Reads tasks.md, posts summary to epic |
| `epic.check_completion` | Complete | Searches children via `"epic-parent: #N" in:body` |
| `epic.update_status` | Complete | Updates `<!-- epic-status -->` comment |
| `epic.create_pr` | Complete | Creates rollup PR from epic branch |
| `epic.close` | Complete | Closes epic issue with completion comment |
| `epic.dispatch_children` | Complete | Assigns children to agent, adds `agent:dispatched` |

### What's Missing

| Component | Package | Description |
|-----------|---------|-------------|
| `speckit.tasks_to_issues` | workflow-engine | Parse tasks.md → create child GitHub issues |
| `EpicPostTasks` | orchestrator | Orchestrates post-tasks steps in worker |
| `EpicCompletionHandler` | orchestrator | Handles `epic-complete` command |
| `EpicCompletionMonitorService` | orchestrator | Polls for epic child completion |
| Workflow phase registry | orchestrator | Per-workflow phase sequences |
| Workflow gate mapping | orchestrator | Per-workflow gate overrides |

### Key Insight

Most of the epic workflow-engine actions already exist. The primary work is in the **orchestrator** — wiring up the workflow, adding the monitor service, and extending the worker to handle epic-specific command routing and post-tasks execution.

---

## 5. Branch Strategy: Impact on Existing Code

### Current Branch Creation Flow

1. `ClaudeCliWorker.handle()` clones default branch (`phase-loop.ts:144-151`)
2. During specify phase, Claude creates files and commits
3. `PrManager.commitPushAndEnsurePr()` creates feature branch `{N}-{name}` and draft PR
4. On resume, `resolveFeatureBranch()` finds the branch by issue number prefix

### Epic Branch Impact

For **epic issues**: No change — the epic itself gets a branch like `201-implement-epic` from the default branch. Its PR targets develop/main.

For **child issues**: The worker needs to:
1. Read `epic-branch: {name}` from the child issue body
2. Clone the epic branch instead of the default branch
3. Create child feature branch from the epic branch
4. Create child PR targeting the epic branch (not develop/main)

### Changes Required

- `ClaudeCliWorker.handle()`: Parse issue body for `epic-branch` marker
- `RepoCheckout.ensureCheckout()`: No change (already accepts any branch name)
- `PrManager`: Add optional `baseBranch` parameter for PR target

### Risk: Epic Branch Not Yet Created

If a child issue is created and picked up before the epic branch exists (e.g., if the epic's specify phase hasn't committed yet), the checkout will fail. Mitigation: child issues are only created after the epic's tasks phase completes, at which point the epic branch has already been created and pushed during prior phases.

---

## 6. Idempotent Child Creation

### Problem

If `speckit.tasks_to_issues` partially fails (e.g., 3 of 5 tasks create issues, then GitHub API error), retrying should not create duplicates.

### Solution: Body Marker Search

Each child issue body contains `epic-parent: #N` and `task: TXXX`. Before creating a child:

```
gh issue list -R owner/repo --search '"epic-parent: #195" "task: T001" in:body' --json number --limit 1
```

If a matching issue exists → skip. If not → create.

### GitHub Search Limitations

- Search indexing delay: 30-60 seconds for new issues
- Not a problem for retry scenarios (retry happens after error, not immediately)
- Exact string matching via quotes ensures no false positives

### Alternative Considered: Redis Tracking

Store created children in Redis. Rejected because:
- Adds infrastructure dependency (Q9 decision: GitHub search only)
- Redis can lose data on restart
- GitHub is the source of truth

---

## 7. Command Routing: Adding `epic-complete`

### Existing Command Routing Pattern

In `ClaudeCliWorker.handle()` (`claude-cli-worker.ts:108-311`):

```typescript
if (item.command === 'address-pr-feedback') {
  // Route to PrFeedbackHandler
  return;
}
// ... process/continue fall through to phase loop
```

### Adding `epic-complete`

The same pattern applies:

```typescript
if (item.command === 'epic-complete') {
  // Route to EpicCompletionHandler
  return;
}
```

The `EpicCompletionHandler` determines what to do based on labels:
- Has `completed:children-complete` → create rollup PR, add `waiting-for:epic-approval`
- Has `completed:epic-approval` → call `epic.close`

This is cleaner than overloading `continue` because epic completion is not a phase loop continuation — it's a distinct set of deterministic actions.

### LabelMonitorService Integration

The `LabelMonitorService` currently enqueues `continue` for all `completed:*` labels. For epic-specific completion labels (`children-complete`, `epic-approval`), it needs to enqueue `epic-complete` instead. Detection:

```typescript
const isEpicCompletion = ['children-complete', 'epic-approval'].includes(gateName);
const command = isEpicCompletion ? 'epic-complete' : 'continue';
```

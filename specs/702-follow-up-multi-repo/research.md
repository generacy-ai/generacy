# Research: Wire siblingFanoutHandler and complete agent prompt

## Integration Point Analysis

### Handler Registration Pattern

The `phaseAfterHandlers` array is constructed at `claude-cli-worker.ts:483-493`. Handlers are invoked sequentially in `phase-loop.ts:400-402`:

```typescript
for (const handler of deps.phaseAfterHandlers ?? []) {
  await handler({ ...context, phase, commitResult: { prUrl, hasChanges } });
}
```

Key semantics:
- **Sequential execution** — each handler awaits before the next runs
- **Fail-fast** — first handler that throws stops remaining handlers and blocks the phase
- **Full context** — handlers receive `PhaseAfterContext` (WorkerContext spread + phase + commitResult)
- **Post-commit timing** — runs after `commitPushAndEnsurePr()` but before gate check

### Existing Handler (linkedPRs reader)

At `claude-cli-worker.ts:483-493`, the current sole handler reloads `linkedPRs` from workflow state files. It calls `loadLinkedPRsFromState()` (defined at line 37-62) which reads `.generacy/workflow-state-*.json` files from the checkout directory and returns the first non-empty `linkedPRs` array.

This handler is the **consumer** — it needs `siblingFanoutHandler` (the **producer**) to run first and persist linkedPRs to the workflow state file.

### siblingFanoutHandler Implementation

Located at `packages/workflow-engine/src/handlers/sibling-fanout.ts:176-254`:
- Detects siblings with uncommitted changes via `getStatus()`
- Gets primary repo branch name and PR title
- For each changed sibling: creates branch, commits, pushes, opens draft PR
- Persists `linkedPRs` to workflow state after processing each sibling
- Returns `SiblingFanoutResult { processed: SiblingOutcome[], skipped: string[] }`

Already exported from `@generacy-ai/workflow-engine` via `handlers/index.ts`.

### Context Variable Availability

All `SiblingFanoutContext` fields map to variables already in scope at the handler registration site:

| Field | Available as | Confirmed at |
|---|---|---|
| `primaryWorkdir` | `checkoutPath` | Line ~351 |
| `siblingWorkdirs` | `siblingWorkdirs` | Line ~335-349 |
| `issueNumber` | `item.issueNumber` | Line ~351 (WorkerContext) |
| `primaryRepoName` | `item.repo` | Line ~351 (WorkerContext) |
| `org` | `item.owner` | Line ~351 (WorkerContext) |
| `workflowStore` | Construct from `checkoutPath` | Pattern at line ~210 |
| `workflowState` | Load from store | Pattern at line ~210 |
| `logger` | `logger` | Line ~351 (WorkerContext) |
| `tokenProvider` | `tokenProvider` | Line ~351 (wizard-creds provider from #620) |

### WorkflowStore Construction

Standard pattern used throughout the codebase: `new FilesystemWorkflowStore(checkoutPath)`. The store provides `loadState()` and `saveState()` for workflow state persistence. The `workflowId` (needed for `loadState`) is computed at line ~210 of `claude-cli-worker.ts`.

### Prompt Block Architecture

`buildSiblingPromptBlock()` in `sibling-prompt.ts:5-15` is a pure function that takes `workdirs: Record<string, string>` and returns a formatted string (or `undefined` if empty). Called in `phase-loop.ts:189-192` and prepended to the issue URL in the agent prompt.

Current output format:
```
**Sibling repos available in this workspace.** You may edit files in any of these as part of this task:
- `agency` — `/workspaces/agency`
- `cluster-base` — `/workspaces/cluster-base`
```

The auto-PR sentence should be appended after the repo list with a blank line separator.

## Technology Decisions

| Decision | Rationale | Alternatives Considered |
|---|---|---|
| Register as PhaseAfterHandler (not custom hook) | Existing generic hook mechanism; no new abstraction needed | Custom event emitter — over-engineered for single use case |
| Construct SiblingFanoutContext in closure | All fields in scope; avoids new adapter type | Pass PhaseAfterContext directly — would require sibling-fanout to depend on orchestrator types |
| Inline auto-PR sentence in prompt block | Single source of truth; no indirection | Config-driven prompt — unnecessary for static copy |
| Array ordering for handler sequence | Explicit, visible, testable | Priority numbers — over-abstracted for 2 handlers |

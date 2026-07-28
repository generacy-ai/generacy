# Data Model

This spec introduces no persisted state (FR-007). The data model below defines only the in-memory contracts between the new / modified modules.

## Entities

### `PushGuardDecision`

Result of the pre-push / post-`switchBranch` gate. Consumed by `pr-feedback-handler.ts` and `pr-manager.ts` (via `phase-loop.ts`) to decide whether to proceed with a push.

```ts
export type PushGuardDecision =
  | { kind: 'allow' }
  | {
      kind: 'refuse';
      reason: 'pr-merged' | 'pr-closed' | 'branch-missing';
      prNumber: number | null;   // null when reason is 'branch-missing' with no known PR
      branch: string;
      owner: string;
      repo: string;
      issueNumber: number;
    };
```

**Validation**:

- `kind === 'allow'` carries no payload — allow is unconditional.
- `kind === 'refuse'` MUST populate every field; `prNumber` is `null` (never `undefined`) when unknown so downstream log serialization is unambiguous.
- `reason` is a closed union — no free-form strings. This drives SC-002's stable assertion.

**Producer**: `push-guard.ts::evaluatePushGuard()`.
**Consumers**: `pr-feedback-handler.ts` (before its push at `:670`), `pr-manager.ts::commitAndPush()` (before its push at `:114`), `phase-loop.ts` (after `switchBranch`, before phase-execute).

### `PushGuardInput`

Input carried into the guard.

```ts
export interface PushGuardInput {
  owner: string;
  repo: string;
  issueNumber: number;
  branch: string;
  github: GitHubClient;
  git: {
    remoteBranchExists(branch: string): Promise<boolean>;
  };
}
```

**Validation**:

- All string fields non-empty.
- `github` MUST expose `findPRForBranchAnyState` (new — see below) and `getIssue` (existing).
- `git.remoteBranchExists` is a minimal seam. Default implementation delegates to `execFileAsync('git', ['ls-remote', '--heads', 'origin', branch])` and returns `stdout.trim() !== ''`. Test seam only — not a new persistent object.

### `ClosedIssueDropOutcome`

Structured field set for the FR-005 `info` log line and a small return type on `LabelMonitorService.processLabelEvent()` extension.

```ts
export interface ClosedIssueDropOutcome {
  dropped: 'issue-closed';
  issueNumber: number;
  eventType: 'process' | 'resume';
  phase: string;   // parsedName for process, gate-suffix for resume
}
```

**Validation**:

- `dropped` is a literal (single-value union in TypeScript) so future drop reasons can be added as a discriminated union without breaking existing assertions.
- `phase` is a plain string (not `WorkflowPhase`) because resume events carry gate names (`spec-review`, `plan-review`, etc.) that aren't phases.

### `GitHubClient` (extension only)

Adds one new method. Existing surface unchanged.

```ts
export interface GitHubClient {
  // ... existing methods ...

  /**
   * Query the head-branch PR list across all states (open + closed + merged).
   * Returns the first match or null. Companion to findPRForBranch (which
   * defaults to open-only). Callers that need to detect merged/closed PRs
   * MUST use this method — findPRForBranch will silently return null on a
   * merged PR because `gh pr list` defaults to `--state open`.
   *
   * The returned PullRequest's `state` field will be one of 'open' | 'closed' | 'merged'.
   */
  findPRForBranchAnyState(
    owner: string,
    repo: string,
    branch: string,
  ): Promise<PullRequest | null>;
}
```

**Validation**: existing `PullRequest.state` type already carries `'open' | 'closed' | 'merged'` — no type changes needed.

## Relationships

```
LabelMonitorService.processLabelEvent
  ├── (existing) fetchedIssue via github.getIssue           ← FR-005 read: fetchedIssue.state
  └── if closed → emit info log { ClosedIssueDropOutcome } → return false (drop)

Phase loop / PR-feedback-handler
  ├── switchBranch(...)
  ├── evaluatePushGuard({ owner, repo, issueNumber, branch, github, git })
  │     ├── github.findPRForBranchAnyState(owner, repo, branch)  → PullRequest | null
  │     ├── git.remoteBranchExists(branch)                       → boolean
  │     └── returns PushGuardDecision
  ├── if refuse:
  │     ├── logger.warn({ event: 'push-refused', ...decision fields })
  │     ├── github.getIssue(owner, repo, issueNumber).state check
  │     │     ├── 'closed' → labelManager.removeLabels(['agent:in-progress'])
  │     │     └── 'open'   → labelManager.removeLabels(['agent:in-progress'])
  │     │                    labelManager.addLabels(['agent:error'])
  │     └── return / exit without push
  └── if allow → proceed with commitAndPushChanges / commitPushAndEnsurePr
```

## Invariants

| # | Invariant | Enforced by |
|---|-----------|-------------|
| I-1 | No new persisted state (Redis, disk, GitHub markers). | Spec FR-007; code review. |
| I-2 | `findPRForBranch` retains its open-only default; no fifth argument. | Code review; existing tests. |
| I-3 | `--prune` appears exactly twice in `repo-checkout.ts` (both fetch-multi sites). `fetchBase` is single-ref and MUST NOT be pruned. | SC-005 static grep + integration test. |
| I-4 | The refusal log line is emitted at exactly one call site per refusal. Structured field set is fixed by `PushGuardDecision`. | SC-002 unit test (asserts log spy call count == 1 and field-shape match). |
| I-5 | Closed-issue drop emits zero mutations (no `enqueue`, no label change, no push, no PR mutation). | SC-004 test (spy assertions on `queueManager.enqueue`, `labelManager.addLabels`, `labelManager.removeLabels`, `github.push`, `github.createPullRequest` all called 0 times). |
| I-6 | `agent:error` MAY be added on refusal but ONLY when `issue.state === 'open'` at refusal time. `failed:<phase>` MUST NOT be added under any refusal condition. | FR-003b; SC-002 test matrix. |

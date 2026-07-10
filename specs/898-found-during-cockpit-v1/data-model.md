# Data Model: #898

Types added or extended by this plan. All types live in TypeScript source under `packages/orchestrator/`, `packages/workflow-engine/`, or `packages/generacy-plugin-claude-code/`.

## Extended types

### `QueueItem.command` (existing union — extended)

**File**: `packages/orchestrator/src/types/monitor.ts:22`

```ts
command: 'process' | 'continue' | 'address-pr-feedback' | 'resolve-merge-conflicts';
```

**Change**: adds `'resolve-merge-conflicts'` as the fourth discriminant. Every downstream `switch`/`if` chain on `item.command` must add a branch (worker dispatch, admin routes, cockpit classifier).

**Validation**: no new constraint. Metadata for this command is described below.

## New types

### `ResolveMergeConflictsMetadata`

**File**: `packages/orchestrator/src/types/monitor.ts` (new export next to `PrFeedbackMetadata`)

```ts
export interface ResolveMergeConflictsMetadata {
  /**
   * Conflicted paths captured by the monitor when the pause was detected.
   * Advisory only — the handler re-computes conflicted paths from the fresh
   * merge attempt (they can shift if base advanced between pause and handler).
   */
  conflictedPathsAtPause?: string[];
  /**
   * PR number linked to this issue, if the monitor was able to resolve it.
   * Advisory — the handler re-resolves via PrLinker if this is missing.
   */
  prNumber?: number;
}
```

**Validation**: both fields optional. Missing fields do not fail the handler; the handler has independent means to re-derive them.

### `MergeConflictIntent`

**File**: `packages/generacy-plugin-claude-code/src/launch/types.ts` (new export next to `PrFeedbackIntent` at line 26)

```ts
export interface MergeConflictIntent {
  kind: 'merge-conflict';
  /** For logging/tracing */
  issueNumber: number;
  /** Full prompt (built by MergeConflictHandler) */
  prompt: string;
}
```

**Union update**: `ClaudeCodeIntent` (line 80 of the same file) gains `| MergeConflictIntent`. `ClaudeCodeLaunchPlugin` dispatcher gains a matching branch.

**Validation**: `prompt` non-empty (Zod refinement at construction if we ever export a schema; otherwise the constructor site is the sole builder and is type-checked).

### `MergeConflictRemedy` (pause-comment payload)

**File**: `packages/orchestrator/src/worker/merge-conflict-remedy.ts` (new)

```ts
export interface MergeConflictRemedy {
  /**
   * Verbatim three-step remedy per FR-011. Ordered.
   * The stage-comment renderer prints each as a numbered list item.
   */
  steps: [
    'Check out `<branch>`, merge `origin/<base>`, resolve conflicts, commit, push.',
    'Run `generacy cockpit advance <issue-ref> --gate merge-conflicts`.',
    'Phase re-runs; pre-merge now succeeds; phase proceeds.',
  ];
  /**
   * Callout warning per FR-011 last line.
   * The renderer prints this as a bold callout under the numbered list.
   */
  warning: 'Advancing without resolving first will re-pause with the same conflict.';
}

export const MERGE_CONFLICT_REMEDY: MergeConflictRemedy;
```

**Note**: literal string types make the constant test-provable. The renderer can substitute `<branch>` / `<base>` / `<issue-ref>` at render time — the constant is the template.

### `MergeConflict` block on `errorEvidence` (existing — extended)

**File**: `packages/orchestrator/src/worker/phase-loop.ts` and `stage-comment-manager.ts`

**Current shape** (already in phase-loop.ts:935-940):

```ts
errorEvidence: {
  mergeConflict: {
    baseRef: string;
    conflictedPaths: string[];
  };
}
```

**Extended shape** (Ship 1):

```ts
errorEvidence: {
  mergeConflict: {
    baseRef: string;
    conflictedPaths: string[];
    manualRemedy: {
      steps: string[];             // 3 strings, template-substituted
      warning: string;              // callout copy
    };
  };
}
```

**Validation**: `manualRemedy.steps` must have length 3; `warning` must be non-empty. The renderer refuses to emit an empty remedy block (dev-mode assertion).

### `BlockedStuckMergeConflictsEvidence` (evidence payload for FR-009)

**File**: `packages/orchestrator/src/worker/merge-conflict-handler.ts`

```ts
export interface BlockedStuckMergeConflictsEvidence {
  /** Paths that still had conflict markers after the agent-CLI attempt. */
  unresolvedPaths: string[];
  /** Paths the agent successfully resolved (staged, no markers). Empty if agent produced no diff. */
  partiallyResolvedPaths: string[];
  /** Base ref that was being merged. */
  baseRef: string;
  /** Short SHA of the branch tip at attempt time. */
  branchTipSha: string;
  /** ISO timestamp of the attempt. */
  attemptedAt: string;
}
```

**Validation**: `unresolvedPaths` must be non-empty (this evidence is only emitted on the blocked path, and blocked means some conflict remained).

**Rendering**: injected into the stage comment under the existing `errorEvidence` render path (same slot as PR-feedback's `#847` failure evidence).

## Existing types reused verbatim

- `QueueItem` (`packages/orchestrator/src/types/monitor.ts:12`) — the `command` extension is the only mutation.
- `QueueManager` (`monitor.ts:202`) — `enqueueIfAbsent(item)` (line 232) is the atomic dedupe primitive.
- `BaseMergeResult` (`packages/orchestrator/src/worker/base-merge.ts:15`) — reused by the handler to typecheck the initial `git merge` attempt.
- `PullRequest` from `@generacy-ai/workflow-engine` — returned by `listOpenPullRequests` (`gh-cli.ts:680`).
- `GitHubClient` — reused unchanged.

## Label additions

`packages/workflow-engine/src/actions/github/label-definitions.ts`:

- **Modified**: `waiting-for:merge-conflicts` description (line 43) — expand to name the manual remedy in one sentence.
- **New**: `blocked:stuck-merge-conflicts` — inserted next to the existing `blocked:*` entries (after line 111). Color `D73A4A`, description mirrors `blocked:stuck-feedback-loop` (`:101`) and `blocked:stuck-validate-fix` (`:107`).

Both label mutations are picked up by `sync-labels` action on next label-sync run — no separate migration needed.

## State transitions

Merge-conflicts pause lifecycle after this feature:

```
[phase starts]
  → pre-phase base-merge (#864) → conflict detected
  → phase-loop applies { waiting-for:merge-conflicts, agent:paused }
    + stage comment now includes { conflictedPaths, manualRemedy }        ← Ship 1
[monitor poll]
  → MergeConflictMonitorService detects { waiting-for:merge-conflicts, agent:paused }
  → skip if any blocked:* on issue                                        ← Q2 / FR-010
  → enqueueIfAbsent → true → resolve-merge-conflicts queue item          ← FR-001 / Q2
[worker claims item]
  → MergeConflictHandler.handle()
    → checkout branch (with 3× retry on git errors)                       ← FR-002 / Q4→D
    → fetch + merge origin/<base> (with 3× retry)                         ← FR-002 / Q4→D
    → if no-op merge (already up to date): clear labels, done            ← handler guard
    → enumerate open PRs targeting <base>, cache file lists               ← FR-005 / Q3
    → tag conflicted paths sibling-owned vs. not
    → agent CLI invocation EXACTLY ONCE                                   ← FR-003 / FR-004
    → success predicate: no MERGE_HEAD + no conflict markers             ← research §6
    → push origin <branch> (with 3× retry on network)                    ← FR-006 / Q4→D
[on success]
  → apply completed:merge-conflicts
  → remove waiting-for:merge-conflicts, agent:paused                    ← FR-007
  → queue completes; in-flight self-clears
[on failure]
  → apply blocked:stuck-merge-conflicts
  → leave waiting-for:merge-conflicts + agent:paused                    ← FR-008
  → emit BlockedStuckMergeConflictsEvidence in stage comment            ← FR-009
  → queue completes; monitor skips re-enqueue until block removed       ← FR-010
```

## Relationships summary

- `MergeConflictMonitorService` **produces** `QueueItem { command: 'resolve-merge-conflicts', metadata: ResolveMergeConflictsMetadata }`.
- `ClaudeCliWorker` dispatch **routes** those items to `MergeConflictHandler`.
- `MergeConflictHandler` **produces** `MergeConflictIntent` for the launcher and consumes `LabelManager` for label mutations.
- `phase-loop.ts` **produces** the extended `errorEvidence.mergeConflict.manualRemedy` payload.
- `StageCommentManager` (external — modification described in `contracts/pause-comment-schema.md`) **renders** the extended payload.

# Data Model: #864

New / modified TypeScript types. All modules colocated in `packages/orchestrator/src/worker/` unless noted.

## `BaseMergeResult` (NEW)

Result of `performBaseMerge`. Discriminated union on `ok`.

```ts
export type BaseMergeResult =
  | {
      ok: true;
      /** The `origin/<base>` ref that was merged. */
      baseRef: string;
      /** SHA of the resulting merge commit. Only present when opts.commit === true. */
      mergeSha?: string;
    }
  | {
      ok: false;
      baseRef: string;
      /** Paths reported by `git diff --name-only --diff-filter=U`. Absolute-safe (repo-relative). */
      conflictedPaths: string[];
    };
```

**Validation**: `baseRef` must start with `origin/`. `conflictedPaths` may be empty only if the merge failed for a reason other than conflicts (e.g. bad ref) — in that case the entry `['<unknown: merge failed without conflict list>']` is added so consumers never see an empty conflict array on `ok: false`.

## `BaseMergeOptions` (NEW)

```ts
export interface BaseMergeOptions {
  /**
   * When true: the merge is committed onto the feature branch (implement phase, per FR-013).
   * When false: `git merge --no-ff --no-commit`; state is left as an un-committed merge in the
   * workspace and MUST be discarded by the next phase's reset-at-start (FR-006, ephemeral).
   */
  commit: boolean;
}
```

## `StageCommentData.errorEvidence` (MODIFIED)

Extend the existing shape with an optional `mergeConflict` discriminant. All existing fields (`command`, `exitDescriptor`, `stderrTail`) become optional to accommodate the merge-conflict variant.

```ts
errorEvidence?:
  | {
      // Existing shape — command-exit failure (#847)
      command: string;
      exitDescriptor: string;
      stderrTail: string;
    }
  | {
      // NEW — merge-conflict failure (this feature)
      mergeConflict: {
        baseRef: string;
        conflictedPaths: string[];
      };
    };
```

**Renderer rule**: `stage-comment-manager.ts:renderStageComment` narrows on the presence of `mergeConflict`. Exactly one variant is populated per call; both being present is a programmer bug and asserted (dev-mode).

## `GateDefinition.condition` (MODIFIED)

Extend the enum union.

```ts
condition: 'always' | 'on-request' | 'on-questions' | 'on-failure' | 'on-sibling-review' | 'on-merge-conflict';
```

## `WorkerConfig.gates` defaults (MODIFIED)

Append to `speckit-feature` and `speckit-bugfix`:

```ts
{ phase: 'implement',    gateLabel: 'waiting-for:merge-conflicts', condition: 'on-merge-conflict' },
{ phase: 'validate',     gateLabel: 'waiting-for:merge-conflicts', condition: 'on-merge-conflict' },
```

(Same gate label used for both phases — consistent with `waiting-for:*` naming: the label names the required human action, not the phase that hit it. `speckit-epic` does NOT get merge-conflict gates because epic workflows stop at `tasks`.)

## `DependencyRef` (NEW — cockpit queue)

Return type of `extractPlanDependencies`. Located in `packages/generacy/src/cli/commands/cockpit/plan-dependency-extractor.ts`.

```ts
export interface DependencyRef {
  owner: string;
  repo: string;
  number: number;
  /** The originating span from the plan.md line (bounded to 120 chars). Preserved for the warning message. */
  originatingText: string;
}
```

**Validation rules**:
- `number` > 0.
- `owner` and `repo` non-empty; when the source mention is bare `#<N>`, they default to the current issue's owner/repo (the caller supplies this via a `defaultOwner`/`defaultRepo` parameter).
- Duplicates (same `owner/repo/number`) coalesced by the caller.

## `QueueRow.warnings` (MODIFIED — cockpit queue)

Extend the existing `QueueRow` in `packages/generacy/src/cli/commands/cockpit/queue.ts` with:

```ts
export interface QueueRow {
  // ... existing fields ...
  /** Present only when eligibility.kind === 'eligible' and plan.md-declared prerequisites are not merged. */
  dependencyWarnings?: {
    ref: DependencyRef;
    /** State observed at queue time. 'unresolved' = neither merged nor closed. */
    state: 'unresolved' | 'closed-unmerged';
  }[];
}
```

**Rendering rule**: `renderPreview` emits one `[WARN: depends-on <owner/repo#N> not yet merged]` line per warning, indented one level deeper than the eligible-row line. No effect on eligibility.

## `BaseMergeRunner` (NEW — DI seam for phase-loop tests)

Constructor-injected function reference so the phase-loop test suite can stub without touching the git primitives.

```ts
export interface BaseMergeRunner {
  (
    checkoutPath: string,
    branch: string,
    baseRef: string,      // e.g. 'origin/main'
    opts: BaseMergeOptions,
    logger: Logger,
  ): Promise<BaseMergeResult>;
}
```

Default implementation is `performBaseMerge` from `base-merge.ts`. Tests inject a fake that returns canned `BaseMergeResult` values.

## Relationship summary

```
phase-loop.ts (executeLoop)
  │
  ├─── resolveBaseBranch() ────── uses github + prManager (same as product-diff.resolveBaseRef)
  │
  ├─── BaseMergeRunner() ──────── base-merge.ts: git reset + fetch + merge
  │      └── returns BaseMergeResult (discriminated union)
  │
  ├─── on ok:  proceed with phase (existing code path)
  │
  └─── on !ok: build errorEvidence { mergeConflict } → labelManager.onGateHit(phase, 'waiting-for:merge-conflicts')
                                                     → return { gateHit: true }  (existing pause return)

cockpit/queue.ts (runQueue)
  │
  ├─── for phase === 'implement': fetch plan.md via `gh api` per eligible ref
  │
  ├─── extractPlanDependencies(planMd) → DependencyRef[]
  │
  ├─── check each DependencyRef via cockpitGh.fetchIssueState → mark 'unresolved' | 'closed-unmerged'
  │
  └─── attach to QueueRow.dependencyWarnings; renderPreview emits [WARN: ...] lines
```

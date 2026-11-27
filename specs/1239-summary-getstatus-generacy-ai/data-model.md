# Data Model: getStatus rename/copy parsing fix (#1239)

## Unchanged public interfaces

### `GitStatus` (`packages/workflow-engine/src/actions/github/client/interface.ts:82`)

```ts
export interface GitStatus {
  branch: string;
  has_changes: boolean;
  staged: string[];     // rename/copy entries now contribute source AND dest paths
  unstaged: string[];   // ditto when the working-tree column is R/C
  untracked: string[];  // unchanged (--untracked-files=all preserved, #1162)
  hasUnpushed: boolean;
  unpushedCount: number;
}
```

**Shape is frozen** (spec assumption): lists stay `string[]`; the fix changes only
which strings appear (real paths, never `old -> new`). No consumer-visible type change.

**Invariants**:
- No element of `staged`/`unstaged`/`untracked` contains the ` -> ` arrow artifact.
- Every element is a path relative to the repo root, byte-exact (no v1 quoting).
- A rename/copy entry contributes exactly 2 paths to the list(s) selected by its
  status column; all other entries contribute exactly 1.
- `has_changes` counts porcelain *entries*, not NUL tokens (a rename is one entry).

## Internal parse model (new, private to `gh-cli.ts`)

Porcelain v1 `-z` token stream:

```
token      := <XY> ' ' <path> | <path>            # bare <path> only after an R/C entry
entry      := header-token [ source-token ]
header     := XY status pair; dest path at offset 3
source-token present ⇔ X ∈ {R,C} ∨ Y ∈ {R,C}
```

Classification rules (per entry):

| Condition | Effect |
|-----------|--------|
| `X === '?' && Y === '?'` | `untracked.push(dest)` |
| `X ∉ {' ', '?'}` | `staged.push(dest)`; if `X ∈ {R,C}`: `staged.push(source)` |
| `Y ∉ {' ', '?'}` | `unstaged.push(dest)`; if `Y ∈ {R,C}`: `unstaged.push(source)` |

## Changed types (orchestrator)

### `CommitAndPushOutcome` (private, `pr-manager.ts:18`)

```ts
type CommitAndPushOutcome =
  | { kind: 'pushed' }
  | { kind: 'no-changes' }
  | { kind: 'refused'; refusal: Extract<PushGuardDecision, { kind: 'refuse' }> }
  | { kind: 'commit-error'; message: string };   // NEW — FR-005
```

**Production rule**: `commit-error` is produced iff a throw escapes the
`getStatus` → sidecar/agent-context filtering → `stageFiles` → `commit` span.
Throws from `revertPaths`, remote-branch queries, push guard, or `push` do NOT
produce it (outer catch → `no-changes`, Q2: A).

### `CommitResult` (`orchestrator/src/worker/types.ts:573`)

```ts
export interface CommitResult {
  prUrl?: string;
  hasChanges: boolean;
  pushRefused?: Omit<Extract<PushGuardDecision, { kind: 'refuse' }>, 'kind'>;
  /** NEW — present iff staging/commit threw inside commitAndPush (FR-005).
   *  Mutually exclusive with pushRefused; when present, hasChanges is false,
   *  no push occurred, and ensureDraftPr was NOT called. */
  commitError?: { message: string };
}
```

**Consumer contract** (mirrors `pushRefused`): every phase-loop consumer that treats
`hasChanges: false` as a legitimate no-op MUST first check `commitError` (and
`pushRefused`) and abort — no `onPhaseComplete`, no phase advancement,
`completed: false`; normal retry policy applies (Q1: A).

## Relationships / flow

```
git status --porcelain -z --untracked-files=all
        │ (NUL tokens)
        ▼
GhCliGitHubClient.getStatus() ──→ GitStatus { staged, unstaged, untracked }
        │                                   (real paths; rename ⇒ src + dest)
        ▼
PrManager.commitAndPush
  ├─ [inner try] getStatus → filter → stageFiles(toStage) → commit(msg, toStage)
  │        └─ throw ⇒ { kind: 'commit-error', message }          (FR-005)
  ├─ revertPaths / remote queries / push guard / push   [outer try ⇒ 'no-changes']
  ▼
commitPushAndEnsurePr ──→ CommitResult { commitError? | pushRefused? | prUrl, hasChanges }
        ▼
phase-loop: commitError present ⇒ abort phase (like pushRefused), retry policy applies
```

## Validation rules

- `stageFiles([])` is a no-op (existing guard) — unchanged.
- `toStage` dedupe (`new Set`) absorbs the dest path appearing in both `staged` and
  `unstaged` for `RM` entries.
- Sidecar/agent-context filters (#1162/#1218) apply per-path and therefore now also
  apply independently to a rename's source and destination — correct by construction.

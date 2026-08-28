# Data Model: Spec-stage agent-context guard

No new persisted state, wire formats, or entities. The change is confined to one interface
method, one derived predicate, and reuse of an existing constant.

## Interface changes

### `GitHubClient.revertPaths` (new — `packages/workflow-engine/src/actions/github/client/interface.ts`)

```ts
/**
 * Revert the given repo-root-relative paths in the working tree and index:
 * tracked paths are restored to HEAD content; untracked paths (including
 * staged-new paths, which are unstaged first) are deleted. Paths that are
 * already clean are no-ops. An empty array is a no-op.
 */
revertPaths(paths: string[]): Promise<void>;
```

Implemented by `GhCliGitHubClient` (`gh-cli.ts`) — the only concrete implementer — as:
`git reset -q HEAD -- <paths>` → partition via `git ls-files -- <paths>` →
`git checkout -- <tracked>` → `rm -f <untracked>`. Throws on git command failure (caller treats
as non-fatal).

## Reused constants (unchanged)

### `EXCLUDED_EXACT_PATHS` (`packages/orchestrator/src/worker/product-diff.ts:95-100`)

```ts
export const EXCLUDED_EXACT_PATHS: readonly string[] = [
  'CLAUDE.md',
  'AGENTS.md',
  'GEMINI.md',
  '.github/copilot-instructions.md',
];
```

Single source of truth for the four agent-context paths (spec Assumptions; FR-001 "do not
duplicate the list"). Matching is exact string equality against the repo-root-relative paths
reported by `getStatus()` (`git status --porcelain --untracked-files=all`).

### `PHASE_TO_STAGE` (`packages/orchestrator/src/worker/types.ts`)

Existing exhaustive `Record<WorkflowPhase, StageType>`. Derived predicate used by the guard:

```ts
const isSpecStage = PHASE_TO_STAGE[phase] !== 'implementation';
// true  → specify, clarify (specification); plan, tasks (planning)
// false → implement, review, validate, remediate (implementation)
```

## Behavioral state table (`commitAndPush`)

| Phase stage | Dirty paths | Staged & committed | Reverted | Warn | Outcome |
|---|---|---|---|---|---|
| spec-stage | product + agent-context | product only | agent-context | yes | `pushed` |
| spec-stage | agent-context only | nothing | agent-context | yes | `no-changes` (Q3) |
| spec-stage | product only | product | — | no | `pushed` (unchanged) |
| implementation | product + agent-context | both (unchanged behavior) | — | no | `pushed` |

Out of scope (Q2): files inside commits the phase agent created directly — the guard is a
staging filter and never inspects or rewrites existing commits.

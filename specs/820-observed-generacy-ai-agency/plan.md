# Implementation Plan: Fail loud when implement phase produces no product changes

**Feature**: Detect empty-implement runs at the phase-loop level so spec-only PRs never reach `validate` (and never auto-merge)
**Branch**: `820-observed-generacy-ai-agency`
**Status**: Complete

## Summary

Replace the current `hasChanges` guard at `packages/orchestrator/src/worker/phase-loop.ts:344–396` with a cumulative *product-diff* check that runs when the `implement` phase is about to transition to `validate`. The check computes `git diff --name-only <base>...HEAD` against the PR's real base ref (falling back to `origin/<default-branch>` when no PR exists yet), then filters entries against a hardcoded `EXCLUDED_PATH_PREFIXES = ['specs/']` constant. If every changed file lives under an excluded prefix, the loop routes to the existing `PHASES_REQUIRING_CHANGES` error path (`labelManager.onError`, stage-comment update, terminate). The `hasPriorImplementation` commit-message heuristics at lines 355–374 are deleted; the same cumulative diff answers the "prior implementation exists?" question truthfully.

The fix is scoped to `packages/orchestrator/src/worker/phase-loop.ts` plus one new helper module and one new `GitHubClient` method for `git diff --name-only A...B`. Workflow YAML, `WorkerConfig`, and validate behavior are untouched.

## Technical Context

- **Language**: TypeScript 5.7 (ESM, Node ≥22)
- **Package**: `@generacy-ai/orchestrator` (`packages/orchestrator/`)
- **Dependencies** (existing):
  - `@generacy-ai/workflow-engine` — `GitHubClient` interface & `GhCliGitHubClient` (adds one method).
  - `pino` — structured logging (already used by `phase-loop.ts`).
- **No new deps.** Prefix matching is `String.prototype.startsWith`; no glob/minimatch dependency introduced (per Clarification Q4).
- **No new env vars.** Excluded-prefix list is a module-level constant.

## Project Structure

```
packages/orchestrator/src/worker/
├── phase-loop.ts                        # MODIFIED: gate change (see §Implementation)
├── product-diff.ts                      # NEW: pure helper — resolves base ref, runs diff, filters prefixes
└── __tests__/
    └── product-diff.test.ts             # NEW: unit tests for the helper

packages/workflow-engine/src/actions/github/client/
├── interface.ts                         # MODIFIED: add getFilesChangedBetween(base, head)
└── gh-cli.ts                            # MODIFIED: implement via `git diff --name-only base...head`

packages/workflow-engine/src/types/github.ts   # unchanged (PullRequest.base.ref already present)
```

## Architecture

### Where the check fires

```
phase-loop.ts (implement phase, iteration N — final iteration only)
│
├─ 3c. Increment boundary        ─── partial implement → commit WIP, i--, continue (unchanged)
├─ 4.  Phase failure branch      ─── implement retry / onError (unchanged)
├─ 5.  commitPushAndEnsurePr     ─── unchanged
│
├─ 5b. PHASES_REQUIRING_CHANGES  ─── REPLACED
│      OLD:  !hasChanges  ⇒  hasPriorImplementation fallback (commit-message heuristics)
│      NEW:  productDiff.isEmpty(base, HEAD)  ⇒  onError
│
└─ 5c–8. Gate check, timestamps, next phase (unchanged)
```

Only fires when `PHASES_REQUIRING_CHANGES.has(phase)` (currently just `implement`); other phases are exempt (FR-006). It fires exactly once per implement phase completion — the increment boundary path at `phase-loop.ts:248–296` returns via `continue` before reaching this block (Clarification Q5).

### Base-ref resolution (FR-007)

```
resolveBaseRef(prManager, github):
  1. If a PR exists for this branch (findPRForBranch or cached prNumber):
       fetch getPullRequest(owner, repo, number)  ─── returns PullRequest.base.ref
       return `origin/${pullRequest.base.ref}`
  2. Else:
       return `origin/${await github.getDefaultBranch()}`
```

Triple-dot (`A...B`) semantics are enforced by the git command itself (`git diff --name-only origin/<base>...HEAD`), so rebased or long-lived branches only surface branch-local commits (Clarification Q3).

### Prefix filter (FR-002, Clarification Q4)

```ts
const EXCLUDED_PATH_PREFIXES: readonly string[] = ['specs/'];

function isProductFile(path: string): boolean {
  return !EXCLUDED_PATH_PREFIXES.some((prefix) => path.startsWith(prefix));
}
```

Literal prefix, `startsWith`. No glob engine. `specs/README.md` correctly excludes; a top-level `README.md` counts as product.

## Implementation

### 1. `packages/orchestrator/src/worker/product-diff.ts` (NEW)

Pure helpers, no I/O beyond the injected `GitHubClient`:

```ts
export const EXCLUDED_PATH_PREFIXES = ['specs/'] as const;

export function isProductFile(path: string, prefixes: readonly string[] = EXCLUDED_PATH_PREFIXES): boolean;

export async function resolveBaseRef(
  github: GitHubClient,
  prManager: PrManager,
  owner: string,
  repo: string,
): Promise<string>;  // returns `origin/<baseRef>`

export async function computeProductDiff(
  github: GitHubClient,
  baseRef: string,
): Promise<{ changedFiles: string[]; productFiles: string[] }>;
```

`computeProductDiff` calls `github.getFilesChangedBetween(baseRef, 'HEAD')`, then partitions.

### 2. `packages/workflow-engine/src/actions/github/client/interface.ts` (MODIFY)

Add:

```ts
/**
 * List files changed between two refs using merge-base (triple-dot) semantics.
 * Equivalent to `git diff --name-only <base>...<head>`.
 */
getFilesChangedBetween(base: string, head: string): Promise<string[]>;
```

### 3. `packages/workflow-engine/src/actions/github/client/gh-cli.ts` (MODIFY)

Implement via `executeCommand('git', ['diff', '--name-only', `${base}...${head}`], { cwd: this.workdir })`. Return `stdout.split('\n').filter(Boolean)`. On non-zero exit throw with `{ base, head, stderr }` — the phase-loop caller wraps and routes to `onError` (do NOT silently swallow: the fallback exists precisely to close the false-negative class).

### 4. `packages/orchestrator/src/worker/phase-loop.ts` (MODIFY)

Replace lines 351–396 with:

```ts
if (PHASES_REQUIRING_CHANGES.has(phase)) {
  const baseRef = await resolveBaseRef(context.github, prManager, context.item.owner, context.item.repo);
  const { productFiles, changedFiles } = await computeProductDiff(context.github, baseRef);

  if (productFiles.length === 0) {
    this.logger.error(
      { phase, baseRef, changedFiles, excluded: EXCLUDED_PATH_PREFIXES },
      'implement phase produced no product-code changes — all diff lives under excluded paths',
    );
    await labelManager.onError(phase);
    await stageCommentManager.updateStageComment({
      stage,
      status: 'error',
      phases: this.buildPhaseProgress(sequence, startIndex, i, phaseTimestamps, 'error'),
      startedAt: phaseTimestamps.get(sequence[startIndex]!)?.startedAt ?? new Date().toISOString(),
      prUrl: context.prUrl,
    });
    result.success = false;
    result.error = {
      message:
        `Phase "${phase}" produced no product-code changes — all changed files are under excluded prefixes ` +
        `[${EXCLUDED_PATH_PREFIXES.join(', ')}]. Implement must modify at least one non-excluded file.`,
      stderr: '',
      phase,
    };
    return { results, completed: false, lastPhase: phase, gateHit: false };
  }
}
```

Note: the outer `if (PHASES_REQUIRING_CHANGES.has(phase) && !hasChanges)` guard shrinks to `if (PHASES_REQUIRING_CHANGES.has(phase))` — the `hasChanges` shortcut is subsumed by `productFiles.length === 0`, and `hasPriorImplementation` disappears entirely (FR-004).

### 5. `PrManager` (INSPECT ONLY — no code change)

`resolveBaseRef` needs the PR number so it can call `getPullRequest(...)`. `PrManager` already caches `this.prNumber` on first `ensureDraftPr()`. Expose a read-only getter `getPrNumber(): number | undefined` (small addition to `pr-manager.ts`). The base-ref resolver uses it; when undefined (pre-PR run), the resolver falls back to `origin/<default-branch>`.

## Constitution Check

No `.specify/memory/constitution.md` present in the repository. No project-level governance principles to reconcile.

Cross-checked against CLAUDE.md invariants:

- **Fail closed / fail loud** (repeated pattern in `credhelper-daemon`, `AppConfigEnvStore`, `wizard-env-writer`): this change is a direct instance — we're moving from a false-negative-prone commit-message heuristic to a truthful cumulative-diff assertion.
- **No new deps** (matches the repo's minimalism, e.g. control-plane uses `node:http` not Express): no glob or diff library added; `git diff --name-only` + `startsWith` covers it.
- **Constant-then-config** (per Clarification Q1 rationale, mirrored in `PHASES_REQUIRING_CHANGES` itself): excluded prefixes ship as a colocated module-level constant, not a `WorkerConfig` field.
- **Scope discipline**: no changes to workflow YAML, `validate`, or the implement agent's prompt (per Out of Scope in spec.md).

## Testing Strategy

Two layers:

1. **Unit tests** (`packages/orchestrator/src/worker/__tests__/product-diff.test.ts`):
   - `isProductFile` — `specs/foo.md` excluded, `specs/README.md` excluded, `README.md` included, `packages/x/y.ts` included, empty string edge case.
   - `resolveBaseRef` — uses PR base when PR exists, falls back to default when not.
   - `computeProductDiff` — mock `GitHubClient.getFilesChangedBetween`, assert partitioning + returned counts.

2. **Integration test** (SC-001) replicating agency#376:
   - Set up a repo where `implement` commits only under `specs/`.
   - Run the phase loop; assert `PhaseLoopResult` has `completed: false`, `lastPhase: 'implement'`, `results[-1].error.message` matches "no product-code changes".
   - Regression counterpart (SC-002): the same loop with a single non-`specs/` file changed passes through to `validate`.

## Failure Modes & Mitigations

| Mode | Mitigation |
|---|---|
| `git diff` fails (missing ref, e.g. `origin/<base>` not fetched) | Throw + route to `onError`. Do not fallback to allowing the run — that would restore the very false-negative this fixes. FR-005 error message names the check so operators can distinguish from unrelated implement failures. |
| PR base ref changes mid-workflow (rare: user retargets PR) | Re-resolved per invocation. Merge-base semantics handle the case correctly. |
| Requeued run where prior increments already contributed product diff | Cumulative diff still contains those files → passes. This is exactly the `hasPriorImplementation` case, now handled by the same code path (FR-004, Q2). |
| Increment (partial-implement) commits that touch only `specs/` | Increment boundary at `phase-loop.ts:248–296` returns via `continue` *before* the new check runs, so intermediate spec-only progress is legitimate (Clarification Q5). The check only fires when implement is about to complete. |

## Rollout

- Single-package change (orchestrator + one interface extension in workflow-engine).
- No schema, config, or wire-format changes → no coordinated cluster/cloud rollout.
- No feature flag — the current behavior is a bug, not a compatible mode.

## Next Step

`/speckit:tasks` to generate the ordered task list from this plan.

---

*Generated 2026-07-06 from spec.md + clarifications.md*

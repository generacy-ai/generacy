# Data Model: #820 — product-diff detection

The feature is a runtime-only check; no persisted schema, no on-disk artifact, no wire protocol. What follows are the in-process types and invariants.

## Constants

### `EXCLUDED_PATH_PREFIXES`

Colocated with `PHASES_REQUIRING_CHANGES` in `packages/orchestrator/src/worker/phase-loop.ts` (re-exported from `product-diff.ts`).

```ts
export const EXCLUDED_PATH_PREFIXES: readonly string[] = ['specs/'];
```

**Invariants**:
- Each entry ends with `/` (directory prefix, not partial file-name match).
- Matched via `String.prototype.startsWith`; no glob or regex.
- Length ≥ 1 (an empty list would disable the exclusion, effectively reverting to `hasChanges`-with-name-list).
- Module-level `const` — not user-configurable via `WorkerConfig` or workflow YAML (Clarification Q1).

## Types

### `ProductDiffResult`

```ts
export interface ProductDiffResult {
  /** Every file returned by `git diff --name-only base...HEAD`. */
  changedFiles: string[];
  /** Subset of changedFiles whose path does NOT start with any excluded prefix. */
  productFiles: string[];
  /** The base ref actually used for comparison, e.g. `origin/develop`. */
  baseRef: string;
}
```

**Invariants**:
- `productFiles.length ≤ changedFiles.length`.
- `productFiles.length === 0` ⇒ implement produced no product diff ⇒ route to `onError`.
- `changedFiles.length === 0` ⇒ base ref may be misconfigured *or* implement truly produced nothing; in either case the outcome is `onError`.
- `baseRef` is always prefixed with `origin/` (e.g. `origin/develop`, `origin/feature/foo`).

### Extension to `GitHubClient` (`packages/workflow-engine/src/actions/github/client/interface.ts`)

```ts
/**
 * List files changed between two refs using merge-base (triple-dot) semantics.
 * Equivalent to `git diff --name-only <base>...<head>`.
 *
 * @throws Error when the git command exits non-zero (missing ref, no fetch, ...).
 */
getFilesChangedBetween(base: string, head: string): Promise<string[]>;
```

**Invariants**:
- Returns *file paths* relative to the repo root (git's own output format), never absolute paths.
- Empty result is the empty array `[]`, never `null`/`undefined`.
- No path normalization applied; caller (`isProductFile`) does its own `startsWith` matching against the raw output.

### Extension to `PrManager` (`packages/orchestrator/src/worker/pr-manager.ts`)

```ts
/** Returns the number of the PR this manager tracks, or undefined if none created yet. */
getPrNumber(): number | undefined;
```

**Invariants**:
- Undefined before `ensureDraftPr()` runs successfully once.
- After a successful `ensureDraftPr()` or `findPRForBranch()` hit, returns the cached `prNumber` for the remainder of the workflow.

## Relationships

```
phase-loop.ts
    │  reads
    ▼
EXCLUDED_PATH_PREFIXES                 (const)
    ▲
    │  imported by
product-diff.ts  ─── isProductFile(path)
    │
    │  calls
    ▼
GitHubClient.getFilesChangedBetween(base, head)   (new)
GitHubClient.getPullRequest(owner, repo, number)  (existing)
GitHubClient.getDefaultBranch()                   (existing)
PrManager.getPrNumber()                           (new)
```

## Validation Rules

The check is not user-facing input; validation is against runtime git output:

| Signal | Interpretation | Action |
|---|---|---|
| `productFiles.length ≥ 1` | Implement produced product diff. | Proceed to next phase. |
| `productFiles.length === 0` and `changedFiles.length ≥ 1` | Implement produced only spec/excluded diff. | `labelManager.onError('implement')`, stage-comment `error`, return `{ success: false }`. Error message names the check + excluded prefixes (FR-005). |
| `changedFiles.length === 0` | Cumulative diff is empty. Either implement did nothing or base ref is wrong. | Same error path. Message distinguishes ("no diff at all vs base `<baseRef>`"). |
| `git diff` throws | Ref missing / not fetched. | Error path with message referencing the base ref, so operator knows to check fetch state (per Research R7). |

## Log Fields (structured)

Every log call from the new module carries a stable set of fields for observability:

```jsonc
{
  "phase": "implement",
  "baseRef": "origin/develop",
  "changedCount": 12,
  "productCount": 0,
  "excludedPrefixes": ["specs/"]
}
```

## What This Does *Not* Introduce

- No new configuration surface (no `WorkerConfig` field, no YAML key).
- No new persistence (no on-disk cache of diff results).
- No new metrics/telemetry endpoint (existing `labelManager.onError` + stage-comment path already surfaces failure to the issue).
- No changes to `PullRequest`, `GitStatus`, or any other type in `packages/workflow-engine/src/types/github.ts`.

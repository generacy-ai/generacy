# Interface Contract: `product-diff.ts`

Runtime helper colocated with the phase loop. No wire format — this documents the module's TypeScript surface so callers, tests, and future maintainers share a spec.

## Module

`packages/orchestrator/src/worker/product-diff.ts`

## Exports

### `EXCLUDED_PATH_PREFIXES`

```ts
export const EXCLUDED_PATH_PREFIXES: readonly string[];
```

- **Value**: `['specs/']`.
- **Stability**: Module-level `const`. Not user-configurable. If future workflows need more prefixes, add here and update tests — do not add a config surface without a second consumer (Clarification Q1).

### `isProductFile(path, prefixes?)`

```ts
export function isProductFile(
  path: string,
  prefixes?: readonly string[],
): boolean;
```

- **Purpose**: Returns `true` when `path` is *not* under any excluded prefix.
- **Params**:
  - `path` — repo-relative file path as emitted by `git diff --name-only` (e.g. `packages/orchestrator/src/foo.ts`).
  - `prefixes` — defaults to `EXCLUDED_PATH_PREFIXES`. Injected for tests.
- **Semantics**: `String.prototype.startsWith` against each prefix. Case-sensitive (matches git's own case handling on POSIX; case behavior on macOS defers to git).
- **Examples**:
  - `isProductFile('specs/820/plan.md')` → `false`.
  - `isProductFile('specs/README.md')` → `false`.
  - `isProductFile('README.md')` → `true`.
  - `isProductFile('packages/orchestrator/src/worker/phase-loop.ts')` → `true`.
  - `isProductFile('')` → `true` (empty string does not match any non-empty prefix; but `getFilesChangedBetween` filters empty lines before returning, so this branch is unreachable in practice).

### `resolveBaseRef(github, prManager, owner, repo)`

```ts
export async function resolveBaseRef(
  github: GitHubClient,
  prManager: PrManager,
  owner: string,
  repo: string,
): Promise<string>;
```

- **Purpose**: Return the base ref to diff against, formatted as `origin/<ref>`.
- **Algorithm**:
  1. Call `prManager.getPrNumber()`.
  2. If defined: `github.getPullRequest(owner, repo, number)` → return `` `origin/${pr.base.ref}` ``.
  3. Else: `github.getDefaultBranch()` → return `` `origin/${defaultBranch}` ``.
- **Errors**: Propagates errors from `getPullRequest` and `getDefaultBranch`. Caller (phase loop) wraps and routes to `onError`.

### `computeProductDiff(github, baseRef)`

```ts
export async function computeProductDiff(
  github: GitHubClient,
  baseRef: string,
): Promise<ProductDiffResult>;

export interface ProductDiffResult {
  changedFiles: string[];
  productFiles: string[];
  baseRef: string;
}
```

- **Purpose**: Cumulative branch diff, partitioned by exclusion list.
- **Algorithm**:
  1. `changedFiles = await github.getFilesChangedBetween(baseRef, 'HEAD')`.
  2. `productFiles = changedFiles.filter((p) => isProductFile(p))`.
  3. Return `{ changedFiles, productFiles, baseRef }`.
- **Errors**: Propagates from `getFilesChangedBetween`. On throw, phase loop treats as detection failure and routes to `onError` with a message that identifies the failing base ref (per Research R7).

## Consumer Contract (phase-loop.ts, implement-completion branch)

The phase-loop implementation:

```ts
if (PHASES_REQUIRING_CHANGES.has(phase)) {
  let productFiles: string[];
  let baseRef: string;
  try {
    baseRef = await resolveBaseRef(context.github, prManager, context.item.owner, context.item.repo);
    ({ productFiles } = await computeProductDiff(context.github, baseRef));
  } catch (err) {
    // treat as detection failure: onError with a distinguishing message
    this.logger.error({ phase, err: String(err) }, 'product-diff computation threw');
    await labelManager.onError(phase);
    // ... stage comment, return { success: false }
  }
  if (productFiles.length === 0) {
    // ... onError, stage comment, return { success: false }
  }
}
```

## Invariants for Test Writers

- Given `changedFiles = ['specs/foo.md', 'packages/x/y.ts']`, `productFiles` must equal `['packages/x/y.ts']`.
- Given `changedFiles = ['specs/foo.md']`, `productFiles.length` must be `0` (this is the primary SC-001 case).
- Given `changedFiles = []`, `productFiles.length` must be `0` (same downstream action — error).
- `resolveBaseRef` must call `github.getPullRequest` when `prManager.getPrNumber()` returns a number, and must NOT call it when the getter returns `undefined`.
- `computeProductDiff` must NOT mutate its inputs; return values must be freshly-allocated arrays.

## Non-Contract

- The module does not export `startsWith` helpers, glob compilers, or path normalizers.
- The module does not read the filesystem or spawn processes directly — all git access is via the injected `GitHubClient`.

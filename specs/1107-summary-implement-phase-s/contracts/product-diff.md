# Contract: product-diff guard surface (#1107)

## `isProductFile(path, prefixes?, exactPaths?)`

- Returns `true` iff `path` is neither under any prefix nor exactly equal to any exact path.
- `false` when: `prefixes.some(p => path.startsWith(p))` OR `exactPaths.includes(path)`.
- Defaults: `prefixes = EXCLUDED_PATH_PREFIXES` (`['specs/']`),
  `exactPaths = EXCLUDED_EXACT_PATHS` (`['CLAUDE.md','AGENTS.md','GEMINI.md','.github/copilot-instructions.md']`).
- Cases:
  - `isProductFile('CLAUDE.md')` → `false`
  - `isProductFile('CLAUDE.md.bak')` → `true` (exact match, not prefix)
  - `isProductFile('packages/foo/CLAUDE.md')` → `true` (root-only, Q3 → A)
  - `isProductFile('.github/copilot-instructions.md')` → `false`
  - `isProductFile('specs/1107/plan.md')` → `false`
  - `isProductFile('packages/orchestrator/src/worker/phase-loop.ts')` → `true`

## `computePhaseScopedProductDiff(github, startRef) → ProductDiffResult`

- `changedFiles = await github.getFilesChangedByOwnCommits(startRef)`
- `productFiles = changedFiles.filter(p => isProductFile(p))`
- `baseRef` field carries `startRef` (diagnostics).
- Throws propagate to the guard's detection-failure path.

## GitHubClient (local git)

### `getCurrentCommitSha(): Promise<string>`
- Runs `git rev-parse HEAD` in the checkout workdir; returns trimmed stdout.

### `getFilesChangedByOwnCommits(startRef): Promise<string[]>`
- Runs `git log --first-parent --no-merges --name-only --pretty=format: <startRef>..HEAD`
  in the checkout workdir.
- Returns unique, non-empty, trimmed file paths (order not significant).
- Empty when no own (non-merge, first-parent) commits exist since `startRef`.

## Guard behavior (`phase-loop.ts` step 5b, `PHASES_REQUIRING_CHANGES`)

**Before phase execution (after pre-phase base merge, before CLI spawn):**
1. `key = phase-start-ref:<owner>:<repo>:<issue>:<phase>`
2. `existing = await phaseTracker.getValueRaw(key)`
3. `startRef = existing ?? await github.getCurrentCommitSha()`
4. if `existing == null`: `await phaseTracker.setValueRaw(key, startRef, 7d)`

**At the guard (after commit):**
1. `{ productFiles, changedFiles } = await computePhaseScopedProductDiff(github, startRef)`
   (inside the existing try/catch → detection failure preserved, SC-005)
2. if `productFiles.length === 0` → fail via existing `no-product-code-changes` surface.
3. else → **pass**, then `await phaseTracker.clear...(key)` (clear the start ref).

**FR-004 diagnostics** on the failure log + error message MUST include:
- the phase-scoped `changedFiles` list,
- the `startRef` used (and the resolved `baseRef` for context),
- `EXCLUDED_PATH_PREFIXES`,
- `EXCLUDED_EXACT_PATHS`.

## PhaseTrackerService

### `getValueRaw(key): Promise<string | null>`
- `null` when Redis unavailable or key absent; otherwise the stored string.

### `setValueRaw(key, value, ttlSeconds): Promise<void>`
- `SET key value EX ttlSeconds`; no-op + warn when Redis unavailable.

## Invariants

- `resolveBaseRef` and `computeProductDiff` signatures unchanged (FR-005).
- No `WorkerConfig`/YAML surface; constants stay module-level.
- Base-merge-introduced and earlier-phase files never satisfy the guard (Q4, SC-004).
- Window spans all pre-restart increments (Q5, SC-001).

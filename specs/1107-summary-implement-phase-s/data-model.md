# Data Model: Implement-phase product-diff guard (#1107)

No database entities. The "data" here is a small set of module constants, function
signatures, and one Redis key namespace.

## Constants (`packages/orchestrator/src/worker/product-diff.ts`)

```ts
// Retained, unchanged.
export const EXCLUDED_PATH_PREFIXES: readonly string[] = ['specs/'];

// NEW (FR-001, Q3 → A): repo-root exact paths written by spec-kit `update_agent`.
export const EXCLUDED_EXACT_PATHS: readonly string[] = [
  'CLAUDE.md',
  'AGENTS.md',
  'GEMINI.md',
  '.github/copilot-instructions.md',
];
```

## Functions (`product-diff.ts`)

```ts
// CHANGED: optional exact-path arg (additive; FR-005 keeps existing callers valid).
export function isProductFile(
  path: string,
  prefixes: readonly string[] = EXCLUDED_PATH_PREFIXES,
  exactPaths: readonly string[] = EXCLUDED_EXACT_PATHS,
): boolean;
// false when: prefixes.some(p => path.startsWith(p)) || exactPaths.includes(path)

// RETAINED, unchanged (cumulative window; still used nowhere-load-bearing / tests).
export async function computeProductDiff(
  github: GitHubClient,
  baseRef: string,
): Promise<ProductDiffResult>;

// NEW: phase-scoped window used by the guard.
export async function computePhaseScopedProductDiff(
  github: GitHubClient,
  startRef: string,
): Promise<ProductDiffResult>;
// changedFiles = github.getFilesChangedByOwnCommits(startRef)
// productFiles  = changedFiles.filter(isProductFile)
// baseRef field on the result carries `startRef` for diagnostics
```

`ProductDiffResult` interface is unchanged.

## New GitHubClient methods (`workflow-engine/.../interface.ts` + `gh-cli.ts`)

```ts
/** Local `git rev-parse HEAD` in the checkout workdir. */
getCurrentCommitSha(): Promise<string>;

/**
 * Files touched by the branch's OWN commits since `startRef`, excluding
 * merge commits and merged-in base-branch commits.
 * Local: git log --first-parent --no-merges --name-only --pretty=format: <startRef>..HEAD
 */
getFilesChangedByOwnCommits(startRef: string): Promise<string[]>;
```

## PhaseTrackerService additions (`services/phase-tracker-service.ts`)

```ts
/** Raw-key string GET (#1107). null when Redis unavailable or key absent. */
getValueRaw(key: string): Promise<string | null>;

/** Raw-key string SET with explicit TTL (#1107). No-op when Redis unavailable. */
setValueRaw(key: string, value: string, ttlSeconds: number): Promise<void>;
// existing clear-by-raw-key: reuse redis.del via a clearRaw(key) if not already present
```

## Redis key namespace

```
phase-start-ref:<owner>:<repo>:<issueNumber>:<phase>   → <commit sha>   (TTL 7 days)
```

- Written once, on first entry into a `PHASES_REQUIRING_CHANGES` phase (after base merge).
- Read on every subsequent entry (resume) to reuse the original start ref.
- Deleted when the phase passes the guard (successful completion). TTL is the backstop.

## Dependency wiring

- `PhaseLoopDeps` (`phase-loop.ts`) gains optional `phaseTracker?: PhaseTracker`.
- `claude-cli-worker.ts` passes its existing `this.phaseTracker` into `PhaseLoopDeps`.
- `server.ts` already constructs `workerPhaseTracker` and injects it into
  `ClaudeCliWorker`; no new instantiation — only the pass-through into `PhaseLoopDeps`.

## Validation rules

- `startRef` must be a 40-hex (or `git rev-parse`-trimmed) SHA; the value is treated as
  opaque and passed straight to `git log`.
- Empty `getFilesChangedByOwnCommits` result ⇒ `productFiles.length === 0` ⇒ guard fails
  via the existing `no-product-code-changes` path.
- Any throw in capture or diff ⇒ existing `product-diff-error` detection-failure path.

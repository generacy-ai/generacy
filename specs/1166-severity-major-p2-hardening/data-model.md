# Data Model: Bugfix targeted-validate and fail-then-pass hardening

No persisted state, no schema changes, no new database or Redis keys. This
feature adds in-memory types/constants and refines existing return unions. The
pure classifier's `Classification` union is unchanged.

## Constants

### `BASE_TEST_TIMEOUT_MS` (new, `fail-then-pass.ts`)

```ts
/**
 * Wall-clock cap for a single base/branch `pnpm vitest run` (FR-006). Mirrors
 * BASE_INSTALL_TIMEOUT_MS; applied per-run, independent of the install cap. Sits
 * under the cli-spawner phase cap so a hung test run aborts inside fail-then-pass
 * (as a non-blocking skip) rather than stalling the outer phase spawn.
 */
const BASE_TEST_TIMEOUT_MS = 5 * 60_000;
```

### `BASE_INSTALL_TIMEOUT_MS` (existing, unchanged)

```ts
const BASE_INSTALL_TIMEOUT_MS = 5 * 60_000;
```

## Types

### `FailThenPassResult` (existing union — unchanged shape, broadened producers)

```ts
export type FailThenPassResult =
  | { kind: 'noop' }
  | { kind: 'skip'; reason: string }   // now also produced by FR-004/005/006/009
  | { kind: 'pass' }
  | { kind: 'fail'; reason: 'base-passed' | 'branch-failed'; evidence: string };
```

The union does not change. What changes is *which conditions* map to `skip`:
- **FR-004/FR-005**: a base/branch run that fails an infra-signature check.
- **FR-006**: a base/branch run that hits `BASE_TEST_TIMEOUT_MS`.
- **FR-009**: a `git worktree add` failure.

### `TestRunOutcome` (existing — gains a timeout signal, FR-006)

```ts
interface TestRunOutcome {
  passed: boolean;
  output: string;
  /** FR-006: true iff the run was killed by BASE_TEST_TIMEOUT_MS (not an abort). */
  timedOut: boolean;
}
```

`runTests` sets `timedOut` when the rejection is a timeout kill
(`err.killed === true` / `code === 'ETIMEDOUT'`) as opposed to an
`AbortError` from the caller's phase-level `signal` (which must propagate, not be
converted into a spurious `branch-failed`).

### `TargetedValidateDecision` (existing — semantics of `changedFiles` refined)

```ts
interface TargetedValidateDecision {
  effectiveCommand: string;
  baseRef: string;
  base: string;
  changedFiles: string[];   // FR-001: now the EXISTENCE-FILTERED diff set
  classification: Classification;
}
```

`changedFiles` now holds only paths that exist in the branch checkout. This
feeds both `classifyDiff` (already-filtered input, Q3=A) and
`runFailThenPassCheck` (`changedFiles.filter(isTestFile)` sees only present
paths), so a deleted/renamed-away test path never reaches a `pnpm vitest run
<nonexistent-file>` command.

### `Classification` (existing — UNCHANGED)

```ts
type Classification =
  | { kind: 'full-fallback'; reason: string }
  | { kind: 'single-package-plain' }
  | { kind: 'docs-only-skip-tests' }
  | { kind: 'test-only'; testFiles: string[] }
  | { kind: 'targeted' };
```

`classifyDiff` stays pure. The empty (fully-filtered-out) input naturally yields
`full-fallback('empty-diff')` — this is how FR-002 is satisfied without a new
variant.

## Predicates / helpers

### `isInfraFailure(output: string): boolean` (new, `fail-then-pass.ts`)

Pure, conservative (Q2=A). Returns `true` only for a *pre-collection* failure —
vitest exited having collected/run zero tests. Returns `false` (→ genuine
outcome) whenever any test appears to have been collected and run.

| Signal in output | Classified as |
| --- | --- |
| `No test files found` | infra (`true`) |
| `Cannot find module` / `Failed to resolve import` / `Failed to load url` / `ERR_MODULE_NOT_FOUND`, with no run test lines | infra (`true`) |
| `FAIL`, per-test `×`/`✓` lines, `Tests  N failed` / `N passed` | genuine (`false`) |
| ambiguous / unrecognized | genuine (`false`) — bias to not masking |

### Zero-project probe (new, wiring layer in `phase-loop.ts`)

A helper that runs `pnpm --filter "...[origin/<base>]" --depth -1 --json` (or
`pnpm ls --filter …`) in the checkout and returns whether the selection is
non-empty. On empty selection OR any probe error → the caller falls back to the
full built-in default command. Only invoked on the `speckit-bugfix`
built-in-default path for classifications that would emit a `--filter` command.

## Substitution rule (FR-010, `computeEffectiveValidateCommand`)

For a custom (non-built-in-default) `validateCommand`:

```
effectiveCommand = validateCommand.replace(/<base>/g, base)
```

where `base = baseRef.replace(/^origin\//, '')` (bare base branch). Mirrors the
existing merge-conflict `<base>`/`<branch>` substitution in `phase-loop.ts`.

## Worktree lifecycle (FR-007/FR-008, `runFailThenPass`)

| Handle | Created | Cleaned up (in `finally`, best-effort, no abort signal) |
| --- | --- | --- |
| `tmpParent` (`mkdtemp` dir) | `await mkdtemp(join(tmpdir(), 'gen-ftp-'))` | `rm(tmpParent, { recursive: true, force: true })` |
| `worktreePath` (`<tmpParent>/wt`) | `git worktree add --detach` | `git worktree remove --force <worktreePath>` |
| orphaned registration | — | `git worktree prune` |

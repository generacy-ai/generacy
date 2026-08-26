# Contract: fail-then-pass prover hardening (`fail-then-pass.ts`)

Covers FR-004, FR-005, FR-006, FR-007, FR-008, FR-009, FR-011. Extends the
#1134 `runFailThenPass` contract; the `FailThenPassResult` union shape is
unchanged — only the set of conditions that map to `skip` broadens.

## Signature (unchanged)

```ts
function runFailThenPass(input: {
  checkoutPath: string;
  baseRef: string;            // origin/<base>
  changedTestFiles: string[]; // existence-filtered diff set ∩ test globs
  signal: AbortSignal;
}): Promise<FailThenPassResult>;
```

## Infra-failure signature → skip (FR-004, FR-005; Q1=A, Q2=A)

- New pure predicate `isInfraFailure(output): boolean`. Conservative: `true`
  ONLY for a pre-collection failure (vitest collected/ran zero tests) — e.g.
  `No test files found`, or a module/dist-resolution error before any test runs.
  Any collected-and-failed test → `false` (genuine). Ambiguous → `false`.
- After the **base** run: `!baseOutcome.passed && isInfraFailure(baseOutcome.output)`
  → `{ kind: 'skip', reason: 'infra:<signature> at base ref' }`. Never
  `base-passed`/`branch-failed`.
- After the **branch** run: `!branchOutcome.passed &&
  isInfraFailure(branchOutcome.output)` → `{ kind: 'skip', reason: 'infra:<signature> on branch' }`.
  Covers FR-005 (no root vitest → branch collects zero tests → skip, not a false
  `branch-failed`).
- A genuine base pass still → `fail: base-passed`; a genuine branch failure still
  → `fail: branch-failed`. No build step is added (Q1=A).

## Per-run wall-clock cap (FR-006; Q5=A)

- New constant `BASE_TEST_TIMEOUT_MS` (mirrors `BASE_INSTALL_TIMEOUT_MS`),
  applied as `{ timeout: BASE_TEST_TIMEOUT_MS }` on each `runTests` `execFile`.
- `TestRunOutcome` gains `timedOut: boolean`; `runTests` sets it when the
  rejection is a timeout kill (`err.killed` / `code === 'ETIMEDOUT'`), NOT when it
  is an `AbortError` from the phase `signal`.
- A timed-out base or branch run → `{ kind: 'skip', reason: 'timeout' }` (never a
  `base-passed`/`branch-failed`). A hang cannot stall validate past the
  cli-spawner cap.

## Worktree lifecycle (FR-007, FR-008)

- Capture the `mkdtemp` parent: `const tmpParent = await mkdtemp(join(tmpdir(),
  'gen-ftp-'))`; `const worktreePath = join(tmpParent, 'wt')`.
- `finally` (each step best-effort, **no abort signal**, guarded so one failure
  does not skip the next):
  1. `git worktree remove --force <worktreePath>`
  2. `git worktree prune`  (reconciles an orphaned registration — FR-008)
  3. `rm(tmpParent, { recursive: true, force: true })`  (FR-007)
- Cleanup is NOT skipped when the phase `signal` is already aborted, because the
  cleanup execs no longer pass the signal.

## `git worktree add` failure → skip (FR-009)

- Wrap `git worktree add --detach <worktreePath> <baseRef>` in try/catch. On
  failure return `{ kind: 'skip', reason: 'worktree-add-failed: <err>' }` (the
  `finally` still runs prune + parent cleanup). Never a hard phase failure.

## Observability (FR-011)

`runFailThenPassCheck` (caller in `phase-loop.ts`) emits one `event:
'fail-then-pass'` line per outcome, mirroring today's shape: `fail` → warn with
`reason`; `skip` → warn with `outcome: 'skip'` + `reason` (now covering
`infra:*`, `timeout`, `worktree-add-failed`, and the existing install-failure
reason); `noop`/`pass` → proceed (no blocking log required).

## Integration with validate (unchanged)

- `noop` / `pass` / `skip` → `runFailThenPassCheck` returns `undefined` → normal
  validate proceeds.
- `fail` → failing `PhaseResult` with `evidence` surfaced (actionable).

## Invariants

- Branch checkout and its `node_modules` are never mutated (worktree isolation).
- No `mkdtemp` parent or worktree registration leaks on any path — success,
  error, timeout, abort, or worktree-add failure.
- A base-ref infrastructure failure NEVER degenerates to "does the branch pass".

## Tests (SC-003, SC-004, SC-005)

- Dist-resolving monorepo: base run infra-fails → `skip` (logged), not
  `base-passed`/`branch-failed`.
- Repo without root vitest: → `skip`, not `branch-failed`.
- Genuine collected-and-failed base test still → `fail: base-passed` path is
  exercised (infra predicate does not mask it).
- Hung run (injected) → aborts within `BASE_TEST_TIMEOUT_MS` → `skip: timeout`.
- `mkdtemp` parent removed after run (assert parent dir gone).
- Aborted signal path: cleanup still runs; `git worktree prune` invoked.
- `git worktree add` failure → `skip`, not a thrown/hard failure.

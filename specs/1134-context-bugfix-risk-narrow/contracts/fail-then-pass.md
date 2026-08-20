# Contract: `runFailThenPass` (fail-then-pass.ts)

Opt-in regression-proof check (FR-010/FR-011). Off by default; when off the whole
path is skipped and validate is byte-identical (FR-013).

## Trigger

Only when `resolveWorkflowOverrides(...).review.failThenPass === true` AND
`workflowName === 'speckit-bugfix'`.

## Signature

```ts
function runFailThenPass(input: {
  checkoutPath: string;
  baseRef: string;            // origin/<base>
  changedTestFiles: string[]; // diff set ∩ test globs
  signal: AbortSignal;
}): Promise<FailThenPassResult>;
```

## Behavior

1. `changedTestFiles` empty → return `{ kind: 'noop' }` (non-blocking, Q3=A).
2. Create a detached worktree: `git worktree add --detach <tmp> <baseRef>`.
3. Run the changed test files in `<tmp>` (base ref). Expect **failure**.
4. Remove the worktree: `git worktree remove --force <tmp>` (always, even on error).
5. Run the same test files in `checkoutPath` (branch). Expect **pass**.
6. Decide:
   - base passed → `{ kind: 'fail', reason: 'base-passed', evidence }` (no regression
     proven — the test does not exercise the bug).
   - branch failed → `{ kind: 'fail', reason: 'branch-failed', evidence }`.
   - base failed AND branch passed → `{ kind: 'pass' }`.

## Integration with validate

- `noop` / `pass` → continue to (or count as) validate success.
- `fail` → validate phase fails with the evidence surfaced in the phase result /
  findings (actionable per FR-011).

## Invariants

- Branch checkout and its `node_modules` are never mutated (worktree isolation).
- Worktree is always cleaned up (try/finally).
- Off (default) → this module is never invoked; SC-005 byte-identity holds.

## Tests (SC-004)

- off → not invoked (assert no worktree created).
- empty test set → `noop`.
- base-fails + branch-passes → `pass`.
- base-passes → `fail` reason `base-passed`.
- branch-fails → `fail` reason `branch-failed`.
- worktree cleaned up on the error path.

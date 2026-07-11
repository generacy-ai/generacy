# Contract: at-most-one base-merge per phase execution cycle

## Applies to

`PhaseLoop.executeLoopInner` in `packages/orchestrator/src/worker/phase-loop.ts`. Internal contract; no external API surface.

## Invariant

For every iteration of `for (let i = startIndex; i < sequence.length; i++)` inside `executeLoopInner`, at most one call to any `runPre*BaseMerge` method (i.e. `runPreImplementBaseMerge` or `runPreValidateBaseMerge`) is made.

Formal statement:

> Let `M(i)` = number of `performBaseMerge` invocations issued during the execution of the for-body for iteration index `i`. Then `M(i) ∈ {0, 1}` for every `i`.

`M(i) === 0` is the "phase does not merge" case (phases other than `implement` and `validate` — e.g. `specify`, `plan`, `tasks`, `clarify` — do not currently invoke any pre-phase merge hook, and this contract does not require them to).

`M(i) === 1` is the "phase merges once, before the cycle's first spawned command" case (Q1-A).

## Retry semantics

`i--; continue;` re-enters the for-loop at the same phase. Because for-loop iterations are the unit of the invariant, a retry counts as a **new** iteration and therefore re-fires the merge exactly once (Q3-A):

> If phase `p` at index `i` is retried `k` times inside the loop before either succeeding or exiting, the total merge count for that phase during the loop invocation is exactly `k + 1`.

## Ordering constraint

When `M(i) === 1`, the single merge invocation MUST precede the first `cliSpawner.*` invocation of that iteration (install if `config.preValidateCommand` is set; otherwise the phase's primary spawn — validate command or Claude CLI).

## Enforcement mechanism

Implementation: a block-scoped `let hasBaseMergedThisCycle = false;` declared inside the for-loop body, above the base-merge call sites. Each call site is wrapped as:

```typescript
if (!hasBaseMergedThisCycle) {
  const outcome = await this.runPre<Phase>BaseMerge(...);
  if (outcome !== undefined) return outcome;
  hasBaseMergedThisCycle = true;
}
```

## Test discharge

The following test cases in `packages/orchestrator/src/worker/__tests__/phase-loop.merge.test.ts` collectively discharge this contract:

- Validate cycle, clean merge → asserts `baseMergeCount === 1`.
- Validate cycle, install artifacts survive → asserts `baseMergeCount === 1` AND a marker written by the install fake is readable by the validate fake.
- Validate cycle, retry → asserts `baseMergeCount === attemptCount`.
- Implement cycle → asserts `baseMergeCount === 1` (symmetry case per Q5-B).

Any future edit that introduces a call to `performBaseMerge` outside the guard region will fail one or more of these assertions.

## Explicit non-obligations

- No obligation to *detect* base-ref drift between the hoisted merge and the subsequent spawn (Q2-A: out of scope). Cross-cycle drift is #892's responsibility.
- No obligation to *push* the ephemeral merge produced by `runPreValidateBaseMerge`. The merge remains uncommitted; the next phase's `git reset --hard origin/<branch>` (inside `performBaseMerge`) discards it. This is unchanged from #864's behavior.
- No obligation to hoist above the implement phase's committed-merge push — implement's push already includes the merge as a distinct commit, and that path is unaffected by this fix.

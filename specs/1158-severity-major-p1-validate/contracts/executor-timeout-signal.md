# Contract: `RemediateExecutor` timeout signal

Location: `packages/orchestrator/src/worker/remediate-executor.ts`.

## Requirement

`RemediateExecutor.execute` MUST report, via `PhaseResult.timedOut`, whether the child was killed by its own timeout envelope (SIGTERM→grace→SIGKILL) rather than exiting on its own.

## Implementation shape

Track a `timedOut` flag in the `execute` scope; set it inside the existing timer callback (`:171-186`):

```ts
let timedOut = false;
const timeoutTimer = setTimeout(() => {
  timedOut = true;
  child.kill('SIGTERM');
  setTimeout(() => { if (child.pid) child.kill('SIGKILL'); }, this.config.shutdownGracePeriodMs);
}, timeoutMs);
```

Return it on both terminal paths:

- **normal-exit** (`:225-231`): `return { phase: 'remediate', success: exitCode === 0, exitCode: exitCode ?? -1, durationMs, output, timedOut };`
- **wait-error** (`:200-207`, `exitPromise` rejected — SIGKILL may land here): `return { ..., exitCode: -1, output, timedOut };`

The **spawn-failure** path (`:146-153`) leaves `timedOut` undefined (no process to time out) — that result already has `exitCode: -1` and no partial work, so the seam's `shouldPush` is false, which is correct.

## Invariants preserved (do NOT change)

- Budget bump still fires on **every** return path (`bumpBudget` at `:141`, `:195`, `:216`) — INV-1/INV-2 from #1128.
- `round` and `lastReviewedCommitSha` untouched by the executor.
- No thread-resolve / ready-mark / review-state call.

## Truth table (seam consumption)

| exitCode | timedOut | shouldPush | Meaning |
|----------|----------|------------|---------|
| 0 | (any) | yes | clean success — push |
| ≠0 | true | yes | timeout-kill with partial work — preserve (Q3=B) |
| ≠0 | false/undef | no | clean-run failure — do not ship (FR-007) |
| -1 (spawn fail) | undef | no | nothing produced |

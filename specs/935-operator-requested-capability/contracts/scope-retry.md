# Contract: `writeScopeWithRetry`

**Module**: `packages/generacy/src/cli/commands/cockpit/scope/retry.ts`

## Signature

```typescript
interface WriteScopeOptions {
  gh: GhWrapper;
  scope: IssueRef;
  mutation: ScopeMutation;
  maxAttempts?: number;    // default 5
  backoffMs?: number[];    // default [100, 250, 500, 1000, 2000]
  sleep?: (ms: number) => Promise<void>;  // test seam
}

interface WriteScopeResult {
  noop: boolean;
  attempts: number;    // 1-based, always >= 1, <= maxAttempts
  finalBody: string;
  shape: BodyShape;
}

export async function writeScopeWithRetry(
  opts: WriteScopeOptions,
): Promise<WriteScopeResult>;
```

Throws `ScopeContendedError` on retry-budget exhaustion.

## Algorithm

```
for attempt in 1..maxAttempts:
  body   := gh.getIssue(scope.repo, scope.number).body ?? ''
  result := applyScopeMutation(body, mutation)

  if result.noop:
    return { noop: true, attempts: attempt, finalBody: body, shape: result.shape }

  gh.updateIssueBody(scope.repo, scope.number, result.body)

  verifyBody := gh.getIssue(scope.repo, scope.number).body ?? ''

  if verifyBody === result.body:
    return { noop: false, attempts: attempt, finalBody: verifyBody, shape: result.shape }

  # Verify mismatch — someone else wrote between our write and readback.
  # Note: applyScopeMutation is idempotent, so retrying against verifyBody
  # converges — if their write already included our ref, next attempt is a noop.
  if attempt < maxAttempts:
    sleep(backoffMs[attempt - 1])
  continue

throw ScopeContendedError({ code: 'SCOPE_ADD_CONTENDED', attempts: maxAttempts, ref, mutation, scope })
```

## Invariants

- **I-1** — Retry never exceeds `maxAttempts` attempts. Total wall time bound: sum(backoffMs) + ~5*(gh RTT) ≈ 3.85 s + I/O overhead.
- **I-2** — Idempotency of `applyScopeMutation` (writer contract I-2/I-3) guarantees convergence: if a concurrent writer already added our ref, the next attempt returns `noop: true`.
- **I-3** — On terminal exhaustion, throws `ScopeContendedError` — never returns "silently failed".
- **I-4** — Read failure (`getIssue` throws) is not retried by this loop; it propagates out. The retry is scoped to *body-mutation contention*, not transient network failures.
- **I-5** — `sleep` is called between attempts N and N+1 with `backoffMs[N-1]` (i.e., 100ms before attempt 2, 2000ms before attempt 5). No sleep on final attempt failure.

## Test cases (retry.test.ts)

| # | Scenario | Expected |
|---|----------|----------|
| 1 | Single attempt succeeds | `attempts: 1`, no sleep called |
| 2 | Ref already present | `noop: true`, `attempts: 1`, no write called |
| 3 | 1 concurrent race, resolves on retry 2 | `attempts: 2`, sleep called with 100ms |
| 4 | 4 concurrent writers, all get through | each caller's `attempts <= 5` |
| 5 | Persistent contention (verifyBody never matches) | throws `ScopeContendedError` after 5 attempts, sleeps called 4x with [100,250,500,1000] |
| 6 | Concurrent writer added our ref between our read+write | attempt 2 sees `noop: true`, returns |
| 7 | `getIssue` throws | error propagates, no retry |
| 8 | 10 fake in-flight writers (SC-005) | eventually converge, no exception |

**SC-005 fixture**: 10 concurrent `writeScopeWithRetry({add, unique-ref})` calls against a fake GhWrapper that serialises `updateIssueBody` and interleaves per-caller reads. Assert final body contains all 10 refs and no caller threw.

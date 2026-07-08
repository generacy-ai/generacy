# Contract: `ClearResumeDedupeCallback`

**Feature**: `849-found-during-cockpit-v1`
**Covers**: FR-001, FR-003, FR-004, FR-010

## Signature

```ts
export type ClearResumeDedupeCallback = (gate: string) => Promise<void>;
```

- **Input** `gate: string` — a gate suffix in the same form the workflow-engine uses for a `waiting-for:*` label (e.g., `"implementation-review"`, `"address-pr-feedback"`, `"clarify-review"`). Must NOT include the `waiting-for:` prefix. Must NOT include the `resume:` prefix.
- **Output** `Promise<void>` — resolves on success or on internally-swallowed error. May reject; callers MUST handle rejection.
- **Optional**: absent (`undefined`) means paired-clear is skipped. This is the default at any construction site that does not wire it.

## Semantics

The callback is a *best-effort* DEL of the paired Redis dedupe key. The wiring closure (`claude-cli-worker.ts:406`) is expected to invoke:

```ts
phaseTracker.clear(owner, repo, issueNumber, `resume:${gate}`)
```

with the concrete `owner`, `repo`, `issueNumber` captured at wiring time.

### Success

- The Redis key `phase-tracker:<owner>:<repo>:<issue>:resume:<gate>` is deleted (or does not exist).
- The callback resolves.

### Failure modes

| Failure | Callback behavior | Caller behavior |
|---------|-------------------|-----------------|
| Redis `DEL` returns a network error | `PhaseTrackerService.clear()` internally catches and logs at `warn`, returns normally | Callback resolves. No caller action. |
| Redis is `null` (unavailable) | `PhaseTrackerService.clear()` returns immediately without logging | Callback resolves. No caller action. |
| Callback wrapping introduces an unexpected throw (e.g., a future harness with a rejecting adapter) | Callback rejects | Caller catches and logs at `warn` per FR-003; pause proceeds. |

Belt-and-suspenders: the current `PhaseTrackerService.clear()` never rejects, so today the callback never rejects. The caller's try/catch in `LabelManager.onGateHit` is defense-in-depth for future callback implementations.

## Preconditions

- The caller (`LabelManager.onGateHit`) MUST have already applied the `waiting-for:<gate>` label successfully on GitHub. Invoking the callback before or during the label-apply retry violates FR-009.
- The `gate` string MUST be the suffix, not the full label. Callers derive it by stripping `waiting-for:` from `gateLabel`.

## Postconditions

- The callback returns without throwing (per current implementation).
- On success, the paired Redis key is absent (either DEL succeeded or key was already absent).
- On failure, the paired Redis key state is unchanged; TTL backstop absorbs the miss within ≤24h.

## Rate limiting / retry

- **One-shot** (FR-010): the callback is invoked exactly once per `onGateHit` call. No caller-side retry, no inline mini-retry.
- The underlying `Redis.del` may implement its own connection-level retry via ioredis; that's opaque to this contract and not depended on.

## Idempotency

Idempotent. Repeated invocations with the same `gate` argument are safe:
- If the key exists: first call deletes, subsequent calls no-op.
- If the key is absent: all calls no-op.
- No side effects other than the DEL, `PhaseTrackerService.clear()`'s internal info log ("Cleared dedup key"), and the caller's info log ("Cleared paired resume dedupe on pause").

## Scoping (FR-004)

The callback MUST scope to *only* the `resume:<gate>` key for the specific gate being applied. It MUST NOT:

- Clear `process:*` keys.
- Clear `resume:*` keys for other gates.
- Clear keys for other `(owner, repo, issue)` triples.

Enforcement: the wiring closure captures the specific triple at construction time and passes `` `resume:${gate}` `` as the phase argument. Other keys are unreachable through this closure.

## Test surface (SC-003, SC-004, FR-003)

Callable via a stub `vi.fn().mockResolvedValue(undefined)` in `label-manager.test.ts`. Test cases (see [plan.md §Technical Context](../plan.md#technical-context)):

1. **Invocation** — `onGateHit('implement', 'waiting-for:implementation-review')` calls the stub with `'implementation-review'` exactly once, after `github.addLabels` succeeds.
2. **Retry-failure skip** — `github.addLabels` throws on all 3 retries; stub is NOT called.
3. **Callback-throw swallow** — stub rejects; `onGateHit` still resolves (does not re-throw); `logger.warn` called with `error` field.
4. **Log-on-success** — `logger.info` called with fields `{ phase, gateLabel, owner, repo, issueNumber }` and message `'Cleared paired resume dedupe on pause'`.
5. **Absent callback** — construct `LabelManager` without the arg; `onGateHit` resolves; no extra logs; label-apply behavior unchanged.

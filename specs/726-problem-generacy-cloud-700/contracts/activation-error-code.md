# Contract: `ActivationErrorCode` (`TIER_LIMIT_EXCEEDED`)

**Issue**: [#726](https://github.com/generacy-ai/generacy/issues/726)
**File**: `packages/activation-client/src/errors.ts`
**Type of change**: Additive — new union member on existing string-literal union.

## Signature

```ts
export type ActivationErrorCode =
  | 'CLOUD_UNREACHABLE'
  | 'DEVICE_CODE_EXPIRED'
  | 'INVALID_RESPONSE'
  | 'TIER_LIMIT_EXCEEDED';     // NEW

export class ActivationError extends Error {
  constructor(message: string, public readonly code: ActivationErrorCode);
}
```

## Usage at throw site

```ts
// packages/orchestrator/src/activation/index.ts
if (pollResult.status === 'tier-limit-exceeded') {
  throw new ActivationError(
    formatTierLimitError({
      requested: pollResult.requested,
      cap: pollResult.cap,
      tier: pollResult.tier,
    }),
    'TIER_LIMIT_EXCEEDED',
  );
}
```

## Acceptance criteria

| ID  | Behavior                                                                                                                            |
|-----|-------------------------------------------------------------------------------------------------------------------------------------|
| E-1 | `new ActivationError(msg, 'TIER_LIMIT_EXCEEDED')` constructs an instance with `code === 'TIER_LIMIT_EXCEEDED'`.                     |
| E-2 | `error instanceof ActivationError` returns `true` for the new code.                                                                 |
| E-3 | `error.code` is type-narrowed to `ActivationErrorCode` (TypeScript-only assertion via existing type tests).                         |
| E-4 | Existing callers of `ActivationError` (`'CLOUD_UNREACHABLE'`, `'DEVICE_CODE_EXPIRED'`, `'INVALID_RESPONSE'`) compile unchanged.      |
| E-5 | The existing try/catch in `packages/orchestrator/src/server.ts` catches the new code via `instanceof ActivationError` without modification. |

## Downstream consumers

| Consumer                                                              | Behavior                                                                                                        |
|-----------------------------------------------------------------------|-----------------------------------------------------------------------------------------------------------------|
| `packages/orchestrator/src/server.ts` (existing try/catch)            | Catches all `ActivationError` instances, pushes `error` status via the relay. No code-specific branching today.  |
| `packages/cluster-relay/` (relay client)                              | Forwards the error message text and status. No code-specific handling.                                          |
| Cloud-side relay event handler (future / wizard)                      | Could branch on `code === 'TIER_LIMIT_EXCEEDED'` to show a tier-upgrade CTA. Out of scope for this PR.           |

## Non-goals

- Refactoring `ActivationError` to a discriminated union (rejected per clarification Q2).
- Adding error-code-to-HTTP-status mapping (no current HTTP surface exposes activation errors directly).
- Removing or renaming any existing code.

## Test coverage

No standalone test file; covered transitively by:
- The orchestrator unit test that asserts the throw shape on `tier-limit-exceeded` poll response (SC-003).
- Existing tests for the four pre-existing codes continue to pass.

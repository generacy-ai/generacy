# Contract: `SmeeChannelResolver.provision()` response acceptance

**File**: `packages/orchestrator/src/services/smee-channel-resolver.ts`
**Method**: `provision(): Promise<string | null>` (`smee-channel-resolver.ts:132-168`)

## Request

- **Method**: `GET` (was `POST` — FR-001, clarification Q2 → A).
- **URL**: `https://smee.io/new` (constant `PROVISION_URL`, unchanged).
- **Redirect mode**: `manual` (unchanged — spec §Out of Scope excludes `follow`).
- **Signal**: `AbortSignal.timeout(HTTP_TIMEOUT_MS)` where `HTTP_TIMEOUT_MS = 5000` (unchanged, FR-006).

## Response acceptance predicate

**Success** — `provision()` returns the `Location` header value as the channel URL:

```
response.status >= 300 && response.status < 400
  && response.headers.get('location') is non-null
  && SMEE_URL_PATTERN.test(response.headers.get('location')) === true
```

**Failure** — `provision()` sets `lastError` (retried up to `MAX_ATTEMPTS`, then returns `null`) when any of:

| Condition | `lastError` value |
|---|---|
| `response.status < 300 || response.status >= 400` | `` `expected 3xx with Location, got ${response.status}` `` (FR-007) |
| Status in-range but `response.headers.get('location')` is null | `'missing Location header'` (unchanged) |
| Status in-range and Location present but fails `SMEE_URL_PATTERN.test(location)` | `` `Location does not match SMEE_URL_PATTERN` `` (unchanged) |
| Timeout / abort exception | `` `timeout after ${HTTP_TIMEOUT_MS}ms` `` (unchanged) |
| Other thrown exception | `err.message ?? String(err)` (unchanged) |

## Guarantees

- `provision()` **never throws** (spec FR-006, resolver's design invariant from #952). Every failure mode folds into `return null` after `MAX_ATTEMPTS` are exhausted.
- Retry envelope: `MAX_ATTEMPTS = 2`, `RETRY_DELAY_MS = 1000` between attempts. Unchanged.
- On final failure, `provision()` logs:
  ```
  logger.warn(
    { attempts: MAX_ATTEMPTS, lastError },
    'Failed to provision smee channel after 2 attempts — cluster is webhook-less, falling back to polling'
  )
  ```
- `SMEE_URL_PATTERN` re-validation on `Location` is the second-line gate: it catches the corner-case 3xx statuses (`304`/`305`/`306`) that carry no valid smee URL. See `data-model.md` decision table.
- The `redirect: 'manual'` mode is preserved so `SMEE_URL_PATTERN` validation runs on the raw `Location` header, not on a follow-resolved URL.

## Test fixtures (SC-002 requirements)

Regression coverage in `packages/orchestrator/src/services/__tests__/smee-channel-resolver.test.ts` must exercise:

| Fixture | Predicate outcome | Expected `provision()` result | Notes |
|---|---|---|---|
| `Response(null, { status: 307, headers: { Location: 'https://smee.io/abc123' } })` | Success | Returns `'https://smee.io/abc123'` on attempt 1 | FR-005 case 1, SC-002 case 1. Real-shaped live smee.io response. |
| `Response(null, { status: 200, headers: {} })` | Failure — status out of range | Returns `null` after 2 attempts; `lastError === 'expected 3xx with Location, got 200'` | FR-005 case 2, SC-002 case 2, SC-003. |
| `Response(null, { status: 307, headers: { Location: 'https://evil.com/x' } })` | Failure — Location fails `SMEE_URL_PATTERN` | Returns `null` after 2 attempts; `lastError === 'Location does not match SMEE_URL_PATTERN'` | FR-005 case 3, SC-002 case 3. |

Existing `302`-based tests (T3, T7, T8, T9, etc. using `make302(...)`) continue to pass unchanged — `302` is inside the new `>= 300 && < 400` range, and no existing test asserts on the request method (verified via grep). Either keep `make302` as a thin wrapper over the generalized helper, or migrate call sites to `makeRedirect(302, location)`.

## Non-goals (spec §Out of Scope)

- Switching to `redirect: 'follow'` semantics.
- Adopting an alternative webhook-forwarder service.
- Changing the retry-budget / backoff policy.
- Adding a periodic health check that re-validates the provisioned channel.
- Cluster-side telemetry alerting on the next smee.io breaking change.

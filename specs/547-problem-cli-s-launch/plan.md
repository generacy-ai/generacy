# Implementation Plan: Differentiated 4xx Error Messages in `generacy launch`

**Feature**: Replace the catch-all "Claim code is invalid or expired" message with status-code-specific, actionable error messages that surface the cloud's RFC 7807 `detail` field and redact the claim code from URLs.
**Branch**: `547-problem-cli-s-launch`
**Status**: Complete

## Summary

The CLI's `fetchLaunchConfig()` in `packages/generacy/src/cli/commands/launch/cloud-client.ts` maps every HTTP 4xx response to a single generic string. Three structurally different bugs during v1.5 staging all surfaced identically, costing hours of debugging. This plan introduces a `CloudError` class with structured fields and a status-code dispatch table so each 4xx produces an actionable, differentiated message. The cloud's RFC 7807 `detail` field is surfaced, and claim codes are redacted from all error output.

## Technical Context

- **Language**: TypeScript (ESM)
- **Runtime**: Node >= 22
- **Package**: `packages/generacy/` (CLI)
- **Dependencies**: None added (uses `node:http`/`node:https` already present)
- **Shared consumer**: `deploy/cloud-client.ts` re-exports from `launch/cloud-client.ts` — fixing the source fixes both commands

## Project Structure

```
packages/generacy/src/cli/commands/launch/
├── cloud-client.ts          # MODIFY — add status-code dispatch, claim redaction
├── cloud-error.ts           # NEW    — CloudError class
├── index.ts                 # MODIFY — redact claim in debug log, optional 429 hint
├── types.ts                 # (unchanged)
├── __tests__/
│   ├── cloud-client.test.ts # MODIFY — update 4xx tests for differentiated messages
│   └── cloud-error.test.ts  # NEW    — unit tests for CloudError + helpers
```

## Implementation Steps

### Step 1: Create `CloudError` class (`cloud-error.ts`)

New file: `packages/generacy/src/cli/commands/launch/cloud-error.ts`

```typescript
export class CloudError extends Error {
  readonly statusCode: number;
  readonly url: string;         // redacted — claim code replaced
  readonly detail?: string;     // from RFC 7807 body.detail
  readonly retryAfter?: string; // from Retry-After header (429)
  readonly problemType?: string; // from RFC 7807 body.type URI

  constructor(opts: {
    statusCode: number;
    url: string;
    message: string;
    detail?: string;
    retryAfter?: string;
    problemType?: string;
  }) { ... }
}
```

Also export two pure helpers in the same file:
- `redactClaimUrl(url: string): string` — replaces `claim=<value>` with `claim=<redacted>` in any URL string.
- `sanitizeBody(raw: string, maxLen?: number): string` — strips non-printables, collapses whitespace, truncates to `maxLen` (default 120), appends `...` on truncation.

### Step 2: Add status-code dispatch to `cloud-client.ts`

Replace the current 4xx block (lines 96-98) with:

1. Parse the response body as JSON (best-effort, no throw on failure).
2. Extract `detail` and `type` from JSON if present (RFC 7807).
3. Read `Retry-After` header from the response (requires threading the header through the promise).
4. Build a `redactedUrl` using `redactClaimUrl()`.
5. Dispatch on status code:

| Status | Message template |
|--------|-----------------|
| 400 | `The cloud rejected the claim format (<status>: <detail> from <redactedUrl>). Generate a fresh claim from your project page.` |
| 401 / 403 | `The cloud rejected this request as unauthenticated (<status> from <redactedUrl>). The claim endpoint should be public — this likely means the cloud is misconfigured. Report this with the URL above.` |
| 404 | `The claim was not found at <redactedUrl>. Did you mint the claim in a different environment? Set GENERACY_CLOUD_URL to the cloud where the claim was minted.` |
| 410 | `Claim has been consumed or expired (one-time-use, 10-min TTL). Generate a fresh claim from your project page.` |
| 429 | `Rate-limited by the cloud (Retry-After: <header>). Wait and retry.` |
| Other 4xx | `Cloud returned <status> (<detail> from <redactedUrl>). Report this if it persists.` |

When `detail` is unavailable and body is non-empty, use `sanitizeBody()` to show truncated raw body on a second line.

Throw `CloudError` instead of `Error` for all 4xx cases.

### Step 3: Thread `Retry-After` header through the HTTP promise

Modify the `raw` promise in `fetchLaunchConfig()` to also capture response headers (specifically `retry-after`). Change the resolved type from `{ status: number; body: string }` to `{ status: number; body: string; retryAfter?: string }`.

### Step 4: Redact claim code in debug log (`index.ts`)

At `launch/index.ts:94`, the debug log currently contains the raw claim code:
```typescript
logger.debug({ claimCode }, 'Using claim code');
```

Change to:
```typescript
logger.debug({ claimCode: '<redacted>' }, 'Using claim code');
```

The claim was already received from the user (they typed it or passed `--claim`), so logging it provides no diagnostic value.

### Step 5: Update existing tests (`cloud-client.test.ts`)

Update the existing 4xx test cases:
- Test each status code (400, 401, 403, 404, 410, 429, 418) throws `CloudError` with the correct `statusCode` field.
- Verify message contains the expected distinctive substring for each status.
- Verify the claim code is NOT present in the error message or `url` field.
- Add a test for JSON body with `detail` field being surfaced.
- Add a test for non-JSON body fallback (truncated raw body).

### Step 6: Add `cloud-error.test.ts`

Unit tests for:
- `CloudError` constructor and field access.
- `redactClaimUrl()` with various URL formats.
- `sanitizeBody()` truncation, non-printable stripping, whitespace collapsing.

## Key Design Decisions

1. **Dispatch on HTTP status code** (not RFC 7807 `type` URI) — simpler, degrades gracefully when cloud doesn't send problem+json. The `problemType` field is captured for future use.
2. **Custom `CloudError extends Error`** — structured fields enable programmatic handling (e.g., 429 auto-retry) while remaining backward-compatible with `instanceof Error` checks.
3. **Claim code redaction** — claims are live bootstrap secrets (~10 min TTL) that users paste into chat/issues. Redact in all error messages AND the debug log.
4. **No new dependencies** — all implementation uses existing Node.js built-ins and patterns already in the codebase.
5. **deploy/cloud-client.ts is a re-export** — fixing `launch/cloud-client.ts` automatically fixes the deploy command too.

## Files Changed (Summary)

| File | Action | Lines (est.) |
|------|--------|-------------|
| `launch/cloud-error.ts` | Create | ~60 |
| `launch/cloud-client.ts` | Modify | ~50 changed |
| `launch/index.ts` | Modify | ~2 changed |
| `launch/__tests__/cloud-error.test.ts` | Create | ~80 |
| `launch/__tests__/cloud-client.test.ts` | Modify | ~60 changed |

## Risk Assessment

- **Low risk**: Changes are localized to error handling in one function. The happy path (2xx) is untouched.
- **Backward compatible**: `CloudError extends Error`, so existing `catch (error) { error.message }` patterns still work.
- **deploy command**: Automatically inherits the fix via re-export.

## Constitution Check

No `.specify/memory/constitution.md` found — no governance constraints to verify against.

# Implementation Plan: Thread projectId into activation URL

**Feature**: When a user clicks "+ Add Cluster" inside a project, the activation URL should carry `?projectId=` so the cloud page pre-selects the project.
**Branch**: `616-context-when-user-clicks`
**Status**: Complete

## Summary

The orchestrator's activation flow prints a `verification_uri` from the cloud's device-code response as-is. This feature reads `GENERACY_PROJECT_ID` from the environment (already scaffolded into `.generacy/.env` by the CLI) and appends it as a query parameter to the activation URL. The CLI already captures the full URL from logs — no regex changes needed.

Two files need modification:
1. **Orchestrator** (`activation/index.ts`): Construct URL with `projectId` query param before printing
2. **Deploy command** (`deploy/activation.ts`): Same pattern for the deploy flow

The CLI launch flow (`compose.ts`) needs no changes — its regex already captures full URLs including query params.

## Technical Context

**Language/Version**: TypeScript, Node >= 22, ESM
**Primary Dependencies**: `zod`, `node:url` (URL API)
**Testing**: Vitest (existing test at `activation/__tests__/activate.test.ts`)
**Packages touched**: `packages/orchestrator`, `packages/generacy`

## Project Structure

### Files Modified

```text
packages/orchestrator/src/activation/index.ts        # Append projectId to verification_uri
packages/orchestrator/src/activation/__tests__/activate.test.ts  # Test URL construction
packages/generacy/src/cli/commands/deploy/activation.ts          # Same pattern for deploy
```

### Files Confirmed Unchanged

```text
packages/generacy/src/cli/commands/launch/compose.ts       # Regex already captures query params
packages/generacy/src/cli/commands/launch/browser.ts       # Passes URL as-is (correct)
packages/generacy/src/cli/commands/cluster/scaffolder.ts   # Already writes GENERACY_PROJECT_ID
packages/activation-client/src/types.ts                    # No schema changes
```

## Implementation Details

### Change 1: Orchestrator activation URL construction

**File**: `packages/orchestrator/src/activation/index.ts` (lines ~56-66)

**Current code** prints `deviceCode.verification_uri` directly:
```typescript
`  Go to: ${deviceCode.verification_uri}\n` +
```

**New code** uses the `URL` API to append query params:
```typescript
function buildActivationUrl(verificationUri: string, userCode: string): string {
  const url = new URL(verificationUri);
  url.searchParams.set('code', userCode);
  const projectId = process.env['GENERACY_PROJECT_ID'];
  if (projectId) {
    url.searchParams.set('projectId', projectId);
  }
  return url.toString();
}
```

The `code` param is also appended (alongside `projectId`) so the user doesn't need to manually enter it — the URL is self-contained. The "Enter code:" line is kept as a fallback for manual entry.

**Graceful fallback**: When `GENERACY_PROJECT_ID` is unset, only `?code=…` is appended. When both are set, URL becomes `?code=XXXX-XXXX&projectId=<uuid>`.

### Change 2: Deploy command activation URL

**File**: `packages/generacy/src/cli/commands/deploy/activation.ts` (lines ~42-47)

Same pattern: use `URL` API to build the activation URL with `code` and optional `projectId` from the deploy config (already available in the activation flow context).

### Change 3: Tests

**File**: `packages/orchestrator/src/activation/__tests__/activate.test.ts`

Add unit tests for the URL construction helper:
- `verification_uri` + `user_code` → `?code=XXXX`
- `verification_uri` + `user_code` + `GENERACY_PROJECT_ID` → `?code=XXXX&projectId=<uuid>`
- `verification_uri` with existing query params → params merged correctly
- `GENERACY_PROJECT_ID` unset → no `projectId` param

## Edge Cases

| Case | Behavior |
|------|----------|
| `GENERACY_PROJECT_ID` unset | URL gets only `?code=…` — no breaking change |
| `verification_uri` has trailing slash | `URL` API normalizes correctly |
| `verification_uri` has existing query params | `searchParams.set()` merges correctly |
| Invalid `verification_uri` | `new URL()` throws — existing error handling catches this |

## Security

`projectId` is a non-secret identifier. The cloud's activation endpoint authorizes by user-owns-project — a stale/wrong `projectId` results in 403. No new attack surface.

## Dependencies

No new packages. Uses built-in `URL` API (`node:url` / global `URL`).

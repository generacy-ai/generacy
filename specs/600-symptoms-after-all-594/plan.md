# Implementation Plan: Fix malformed EventMessage shape in internal-relay-events handler

**Feature**: Fix swapped field names in relay event IPC handler
**Branch**: `600-symptoms-after-all-594`
**Status**: Complete

## Summary

The `POST /internal/relay-events` handler in the orchestrator constructs an `EventMessage` with the wrong field names (`channel`/`event` instead of `event`/`data`), causing every relay event forwarded from control-plane to be silently dropped by the cloud. The fix swaps the field mapping to match the cloud's expected wire format and updates the existing test assertion.

## Technical Context

**Language/Version**: TypeScript 5.x, Node >=22 (ESM)
**Primary Dependencies**: Fastify (HTTP), Zod (validation), `@generacy-ai/cluster-relay` (message types)
**Testing**: Vitest
**Target Platform**: Linux (Docker container, in-cluster orchestrator)
**Project Type**: Monorepo (`packages/orchestrator`, `packages/cluster-relay`)

## Files Changed

| File | Change | Lines |
|------|--------|-------|
| `packages/orchestrator/src/routes/internal-relay-events.ts` | Fix field mapping in `client.send()` call | ~42-46 |
| `packages/orchestrator/src/routes/__tests__/internal-relay-events.test.ts` | Update assertion to match corrected wire shape | ~58-62 |

## Approach

### Step 1: Fix EventMessage field mapping (FR-001)

In `internal-relay-events.ts:42-46`, change:

```typescript
// BEFORE (buggy)
client.send({
  type: 'event',
  channel,           // cloud expects this in "event" field
  event: payload,    // cloud expects this in "data" field
} as unknown as RelayMessage);

// AFTER (fixed)
client.send({
  type: 'event',
  event: channel,
  data: payload,
  timestamp: new Date().toISOString(),
} as unknown as RelayMessage);
```

### Step 2: Cast handling (FR-002)

The `as unknown as RelayMessage` double-cast exists because the local `EventMessage` interface (`{ channel: string, event: unknown }`) doesn't match the cloud's wire format (`{ event: string, data: unknown, timestamp: string }`). Since updating the interface/schema is out of scope (tracked in #572), the `as unknown as RelayMessage` cast must remain for now. The critical fix is the field values, not the cast.

**Note**: Full type alignment (removing the cast entirely) requires updating `EventMessage` in `packages/cluster-relay/src/messages.ts` and its Zod schema — deferred to #572.

### Step 3: Update test assertion

In `internal-relay-events.test.ts:58-62`, update the `toHaveBeenCalledWith` assertion to match the corrected wire shape:

```typescript
expect(relayClient.send).toHaveBeenCalledWith({
  type: 'event',
  event: 'cluster.vscode-tunnel',
  data: { status: 'starting' },
  timestamp: expect.any(String),
});
```

## Risk Assessment

**Risk**: Extremely low. This is a field-name swap in a single function call, confirmed by reading both the handler and the cloud's expected format.

**No breaking changes**: The wire format changes to match what the cloud already expects. No other in-cluster code reads these fields — they're passed through to the WebSocket.

## Out of Scope

- Updating `EventMessage` interface/Zod schema in `cluster-relay` (#572)
- End-to-end type safety for relay wire shapes (#572)
- Adding integration tests against cloud message handler

## Verification

1. Run `pnpm --filter @generacy-ai/orchestrator test` — existing + updated tests pass
2. Manual: Click "Start Tunnel" in wizard → device code appears (SC-001)
3. Manual: Write credentials in wizard → `cluster.credentials` event reaches cloud (SC-003)
4. Code review: confirm no `as unknown as` where it's avoidable (SC-004 — cast retained with justification)

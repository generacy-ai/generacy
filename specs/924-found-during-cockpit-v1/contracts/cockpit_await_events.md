# Contract: `cockpit_await_events` (v2 — nonce-aware)

**Issue**: [#924](https://github.com/generacy-ai/generacy/issues/924)

## Input schema (unchanged)

```ts
{
  epic: string | { owner: string; repo: string; number: number };
  cursor?: string;
  maxWaitMs?: number;         // default 55_000
  coalesceWindowMs?: number;  // default 3_000
  maxBatchSize?: number;      // default 256
}
```

## Output schema (widened `resetFrom`)

```ts
type ToolResult<T> =
  | { status: 'ok'; data: T }
  | { status: 'error'; class: string; detail: string; hint?: string };

type CockpitAwaitEventsData = {
  events: CockpitStreamEvent[];
  cursor: string;
  resetFrom?: 'expired' | 'discarded';  // 'discarded' added
};
```

## Cursor classification behavior

| Input cursor state | Kind | Output shape |
|--------------------|------|--------------|
| Absent (`undefined`) | `valid` (pos 0) | `status: 'ok'`, data.cursor = fresh nonce-carrying token |
| Malformed base64 or JSON | `malformed` | `status: 'error'`, class: `invalid-cursor`, detail: cursor is malformed |
| Missing `pnonce` or `bnonce` field on decode | `discarded` (legacy) | `status: 'ok'`, data.resetFrom = `'discarded'`, sinceCursor = 0 |
| `pnonce` mismatch (different process) | `discarded` (cross-instance) | `status: 'ok'`, data.resetFrom = `'discarded'`, sinceCursor = 0 |
| `bnonce` mismatch (bus evicted + reconstituted) | `discarded` (evicted) | `status: 'ok'`, data.resetFrom = `'discarded'`, sinceCursor = 0 |
| `epic` mismatch | `wrong-epic` | `status: 'error'`, class: `invalid-cursor`, detail names both epics |
| Both nonces match, position > nextCursor - 1 | `never-issued` | `status: 'error'`, class: `invalid-cursor`, hint: start with cursor=undefined |
| Both nonces match, position below low-watermark | `expired` | `status: 'ok'`, data.resetFrom = `'expired'`, sinceCursor = 0 |
| Both nonces match, position in range | `valid` | `status: 'ok'`, sinceCursor = decoded.position |

## Invariants

- **I1**: For two sequential calls to the same epic in the same server-process within `COCKPIT_MCP_BUS_IDLE_TTL_MS`, `cursor` returned by call N is `valid` on call N+1. (FR-008, SC-001.)
- **I2**: An event emitted between two sequential calls (no waiter in flight) is delivered in the second call's `events` array. (FR-004, SC-002.)
- **I3**: The reset paths (`resetFrom: 'expired'` and `resetFrom: 'discarded'`) never return `status: 'error'`. They are silent recovery signals; the caller's playbook continues without alarm.
- **I4**: `never-issued` on the output is emitted only when both nonces match and position exceeds issued range. No lifecycle event (TTL, LRU, restart, upgrade) surfaces as `never-issued`. (FR-005, SC-004.)
- **I5**: The bus stays alive across `release` → `acquire` sequences until:
  - Idle-TTL expires (default `600_000` ms) with no waiters, OR
  - LRU soft cap (default 100) evicts as the least-recently-active, OR
  - Server process terminates.
  All three paths produce `resetFrom: 'discarded'` on any held cursor.

## Environment configuration

| Var | Default | Effect |
|-----|---------|--------|
| `COCKPIT_MCP_BUS_IDLE_TTL_MS` | `600_000` | Idle-TTL for bus registry eviction |
| `COCKPIT_MCP_BUS_MAX` | `100` | Soft cap on concurrent live buses; LRU eviction at cap |

Both must parse as a positive integer; invalid values fall back to the default. No error surface; misconfig is logged at `warn`.

## Wire compatibility

- Cursor token stays base64(JSON). Payload gains `pnonce` and `bnonce` fields (both 16-hex-char strings).
- Legacy tokens (pre-fix) omit both fields → `discarded` (legacy). One-time silent reset per active caller session on first post-deploy call.
- Callers that only inspect `resetFrom === 'expired'` still work (the field remains optional).

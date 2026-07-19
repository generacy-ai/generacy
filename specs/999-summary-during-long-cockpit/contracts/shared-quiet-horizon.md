# Contract: Shared quiet-horizon constant

**Issue**: [#999](https://github.com/generacy-ai/generacy/issues/999)
**File**: `packages/generacy/src/cli/commands/cockpit/mcp/event-bus.ts`

## Scope

Defines the observable behaviour of the new `DEFAULT_QUIET_HORIZON_MS` export and its two consumers after the #999 changes. No public API surface changes; this contract documents the module-level invariant FR-003 asserts and the FR-004 env/options override cascade.

## Public surface

```ts
// event-bus.ts

/**
 * Shared default horizon (ms) for BOTH the in-memory buffer retention window
 * (`EpicEventBus.retentionMs`) AND the registry's idle-TTL for refcount-0
 * buses (`event-bus-registry.ts` `DEFAULT_IDLE_TTL_MS`). Any change here
 * changes both call sites in lockstep — FR-003.
 */
export const DEFAULT_QUIET_HORIZON_MS: number;
```

**Concrete value**: `7_200_000` (120 minutes, in ms). Positive integer.

## Consumer bindings

### `event-bus.ts` — `EpicEventBus.constructor`

```ts
this.retentionMs = options.retentionMs ?? DEFAULT_QUIET_HORIZON_MS;
```

**Contract**:

- `new EpicEventBus({ epic })` yields a bus whose buffer trims entries older than `DEFAULT_QUIET_HORIZON_MS` at emit time.
- `new EpicEventBus({ epic, retentionMs: N })` yields a bus whose buffer trims entries older than `N` (per-instance override — unchanged).
- The bus's own env-var override (`COCKPIT_MCP_EVENT_RETENTION_MS`, existing) continues to apply upstream of the constructor default.

### `event-bus-registry.ts` — `DEFAULT_IDLE_TTL_MS`

```ts
import { DEFAULT_QUIET_HORIZON_MS } from './event-bus.js';

const DEFAULT_IDLE_TTL_MS = DEFAULT_QUIET_HORIZON_MS;
```

**Contract**:

- `acquireEpicBus({ epicRef })` (no options overrides, no env vars) arms a `setTimeout` of `DEFAULT_QUIET_HORIZON_MS` ms on `releaseKey()` at refcount 0.
- `acquireEpicBus({ epicRef, idleTtlMs: N })` arms `N` ms instead (per-call override — unchanged).
- `process.env.COCKPIT_MCP_BUS_IDLE_TTL_MS = 'M'` overrides both above (env-var precedence — unchanged; see `parsePositiveIntEnv` at `event-bus-registry.ts:49`).

## Invariants (FR-003 / SC-005)

- **INV-1**: The two consumers reference the same identifier `DEFAULT_QUIET_HORIZON_MS`. Two distinct numeric literals at `event-bus-registry.ts:43` and `event-bus.ts:132` are forbidden.
- **INV-2**: The constant is a positive integer in milliseconds.
- **INV-3**: The env-var override surface and constructor/options seams are unchanged from the pre-#999 state — no new env-var names, no new options fields.

## Precedence cascade (unchanged surface, updated defaults)

For the registry idle-TTL, in decreasing precedence:

1. `process.env.COCKPIT_MCP_BUS_IDLE_TTL_MS` (if set and positive)
2. `AcquireOptions.idleTtlMs` (if set and positive)
3. `DEFAULT_IDLE_TTL_MS` = `DEFAULT_QUIET_HORIZON_MS`

For the bus retention window, in decreasing precedence:

1. `process.env.COCKPIT_MCP_EVENT_RETENTION_MS` (if set and positive)
2. `EpicEventBusOptions.retentionMs` (if set)
3. `DEFAULT_QUIET_HORIZON_MS`

## Cursor classification (FR-007 — unchanged)

`event-bus.ts:150-174` cursor classes are unchanged:

- `valid` — normal path
- `expired` — position below low-watermark (count-driven or time-driven trim)
- `discarded` — nonce missing (legacy) or mismatched (cross-instance / evicted)
- `malformed` / `never-issued` / `wrong-epic` — unchanged

The bus's `busNonce` is minted fresh on every `new EpicEventBus(...)` — unchanged. What changes is how often the registry constructs a new bus, driven by the horizon.

## Observable behaviour changes

- **Before**: A cursor issued before a ≥10-min quiet gap classifies `discarded` (evicted) or `expired` on the next drain, because the registry has torn down the bus or the buffer has time-trimmed.
- **After**: The same cursor, drained after a gap of up to `DEFAULT_QUIET_HORIZON_MS`, classifies `valid`. The auto skill's `cursor-recovery discarded` / `expired` ledger lines drop to zero attributable to idle-TTL / buffer trim of the actively-watched epic.

## Non-changes

- The `bnonce` / `pnonce` cursor protocol — unchanged.
- The `retentionCount = 10_000` memory bound — unchanged (FR-005).
- The `maxBuses = 100` LRU cap — unchanged.
- The env-var names `COCKPIT_MCP_BUS_IDLE_TTL_MS`, `COCKPIT_MCP_EVENT_RETENTION_MS`, `COCKPIT_MCP_EVENT_RETENTION_COUNT`, `COCKPIT_MCP_BUS_MAX` — unchanged.
- The `AcquireOptions` and `EpicEventBusOptions` fields — unchanged.

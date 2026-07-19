# Data Model: Shared quiet-horizon for `EpicEventBus` + `event-bus-registry`

**Issue**: [#999](https://github.com/generacy-ai/generacy/issues/999)
**Branch**: `999-summary-during-long-cockpit`

## Overview

No persisted entities, no wire messages, no on-disk state. The "data model" is one exported constant and the two default-derivation sites that reference it. The public runtime types (`EpicEventBusOptions`, `AcquireOptions`, `CursorParseResult`, cursor token shape) are all unchanged.

## New / changed exports

### `DEFAULT_QUIET_HORIZON_MS` (NEW)

```ts
// packages/generacy/src/cli/commands/cockpit/mcp/event-bus.ts

/**
 * Shared default horizon (ms) for BOTH the in-memory buffer retention window
 * (`EpicEventBus.retentionMs`) AND the registry's idle-TTL for refcount-0
 * buses (`event-bus-registry.ts` `DEFAULT_IDLE_TTL_MS`). Any change here
 * changes both call sites in lockstep — FR-003.
 */
export const DEFAULT_QUIET_HORIZON_MS = 7_200_000; // 120 minutes
```

**Value**: `7_200_000` (ms), a positive integer.

**Consumers**:

- `event-bus.ts` — `EpicEventBus.constructor` default at line 132: `this.retentionMs = options.retentionMs ?? DEFAULT_QUIET_HORIZON_MS;`
- `event-bus-registry.ts` — `DEFAULT_IDLE_TTL_MS` at line 43: `const DEFAULT_IDLE_TTL_MS = DEFAULT_QUIET_HORIZON_MS;`

**Invariants** (enforced by module structure):

- Both consumers reference the same identifier. Two independent numeric literals at the two call sites are forbidden by design (FR-003 / SC-005).
- Positive integer (> 0). Guarded by an existing `parsePositiveIntEnv` call in the registry (env override) — the default is not user-supplied so no extra validation is needed at the constant.
- Unit is milliseconds — consistent with every other `_MS`-suffixed constant in the module.

### `DEFAULT_IDLE_TTL_MS` (MODIFIED derivation, unchanged name)

```ts
// packages/generacy/src/cli/commands/cockpit/mcp/event-bus-registry.ts

import { DEFAULT_QUIET_HORIZON_MS } from './event-bus.js';

/** Env knob `COCKPIT_MCP_BUS_IDLE_TTL_MS` — idle-TTL for refcount-0 buses. */
const DEFAULT_IDLE_TTL_MS = DEFAULT_QUIET_HORIZON_MS;
```

**Kept as a named local**: preserves readability at the `parsePositiveIntEnv(...)` call site and keeps the JSDoc-documented env-knob → constant mapping intact.

**Not re-exported** — the registry does not need to expose it (no external consumer today).

### `EpicEventBus.retentionMs` default (MODIFIED derivation, unchanged public type)

```ts
// packages/generacy/src/cli/commands/cockpit/mcp/event-bus.ts:132 (before → after)

// Before
this.retentionMs = options.retentionMs ?? 600_000;

// After
this.retentionMs = options.retentionMs ?? DEFAULT_QUIET_HORIZON_MS;
```

**Public type unchanged**: `EpicEventBusOptions.retentionMs?: number` — optional, ms. Still overridable per-instance.

## Unchanged types (referenced for context)

### `EpicEventBusOptions` (unchanged)

```ts
export interface EpicEventBusOptions {
  epic: string;
  retentionCount?: number;   // unchanged: default 10_000 (FR-005)
  retentionMs?: number;      // default derivation changes: → DEFAULT_QUIET_HORIZON_MS
  now?: () => number;
  nonce?: string;
}
```

### `AcquireOptions` (unchanged)

Public shape at `event-bus-registry.ts:90-115` is untouched. `options.idleTtlMs` continues to override the (now-larger) `DEFAULT_IDLE_TTL_MS`. `options.retentionMs` is NOT threaded through `acquireEpicBus` today — the bus's own `retentionMs` default applies, and is overridable via the `COCKPIT_MCP_EVENT_RETENTION_MS` env var (bus-side).

### `CursorParseResult` (unchanged — FR-007)

The `discarded` / `expired` / `valid` / `never-issued` / `wrong-epic` / `malformed` classification at `event-bus.ts:150-174` is unchanged. This spec changes horizons only, not the cursor protocol.

## Validation rules

- **`DEFAULT_QUIET_HORIZON_MS` MUST be a positive integer.** Compile-time check via TypeScript (`number` literal); runtime check unneeded at the constant (not user input).
- **Env-var override `COCKPIT_MCP_BUS_IDLE_TTL_MS` MUST parse to a positive integer.** Existing `parsePositiveIntEnv` at `event-bus-registry.ts:49` handles this — falls back to `DEFAULT_IDLE_TTL_MS` on `NaN` or `<= 0`, emitting a warning.
- **Env-var override `COCKPIT_MCP_EVENT_RETENTION_MS` MUST parse to a positive integer.** Existing bus-side validation (referenced in `event-bus.ts:20`) handles this.
- **`options.idleTtlMs` and `options.retentionMs` are trusted at call sites** — internal API, no runtime validation.

## Relationships

```
DEFAULT_QUIET_HORIZON_MS  (event-bus.ts, EXPORTED)
        │
        ├── EpicEventBus.retentionMs default  (event-bus.ts:132)
        │       overridable via: options.retentionMs
        │       overridable via: process.env.COCKPIT_MCP_EVENT_RETENTION_MS
        │
        └── DEFAULT_IDLE_TTL_MS  (event-bus-registry.ts:43, IMPORTED)
                overridable via: options.idleTtlMs
                overridable via: process.env.COCKPIT_MCP_BUS_IDLE_TTL_MS
```

Both branches converge on the same underlying constant. Env vars and options preserve the existing tuning surfaces.

## Test-visible surface

- `DEFAULT_QUIET_HORIZON_MS` is exported → importable from `__tests__/event-bus.test.ts` for direct assertion (`expect(DEFAULT_QUIET_HORIZON_MS).toBe(7_200_000)`).
- Bus default derivation is testable by constructing `new EpicEventBus({ epic: '...' })` (no `retentionMs` option) and asserting the resulting instance uses the shared value. `retentionMs` is private today; the assertion is by observed behaviour (`trim()` at time `DEFAULT_QUIET_HORIZON_MS + 1` drops the entry; not at time `DEFAULT_QUIET_HORIZON_MS - 1`).

# Data Model

Feature: **VS Code Desktop tunnel hangs on "Starting tunnel…"** (#966)

## Retained-event singleton

Location: `packages/orchestrator/src/routes/retained-tunnel-event.ts` (NEW)

### Types

```ts
export type RetainedStatus =
  | 'authorization_pending'
  | 'connected'
  | 'disconnected'
  | 'error';

export interface RetainedTunnelEvent {
  event: 'cluster.vscode-tunnel';
  data: unknown;         // stored as-is; source is Zod-validated at the route
  timestamp: string;     // ISO-8601, from the route request
  status: RetainedStatus;
}
```

### Module-level state

```ts
let retained: RetainedTunnelEvent | null = null;
```

Single slot per orchestrator process — matches the "single tunnel per cluster" assumption.

### Public API

```ts
export function getRetainedTunnelEvent(): RetainedTunnelEvent | null;
export function setRetainedTunnelEvent(event: RetainedTunnelEvent): void;
export function clearRetainedTunnelEvent(): void;
export function isRetentionEligible(payload: unknown): { eligible: true; status: RetainedStatus } | { eligible: false };
```

### Zod schema (retention-only)

```ts
import { z } from 'zod';

const RetainedTunnelEventDataSchema = z.object({
  status: z.enum(['authorization_pending', 'connected', 'disconnected', 'error']),
  error: z.string().optional(),  // used for FR-006 eligibility filter on error events
}).passthrough();
```

`.passthrough()` because the retained payload MUST preserve every field the cloud consumer expects (`deviceCode`, `verificationUri`, `tunnelName`, `tunnelUrl`, `details`). This schema is narrower than the full `VsCodeTunnelEvent` union — it only extracts the fields needed for the retention decision.

### Non-lifecycle error markers (FR-006 filter)

```ts
const NON_LIFECYCLE_ERROR_MARKERS = [
  'tunnel unregister timed out',
  'tunnel unregister exited with code',
  'tunnel unregister failed',
  'tunnel name collision',
] as const;
```

These are the exact `error` field values emitted by non-lifecycle sites in `vscode-tunnel-manager.ts` — lines 347, 363, 373, 436 respectively. Matching is `startsWith` because `'tunnel unregister exited with code 2'` includes a variable exit code and `'tunnel unregister failed: <err.message>'` includes a variable message. `authorization_pending`, `connected`, `disconnected` are unaffected — the filter only applies to `error`.

### Precedence rule (FR-005, encoded in `setRetainedTunnelEvent`)

Given an existing slot and an incoming event, both eligible:

| Existing status         | Incoming status         | Action                     |
|-------------------------|-------------------------|----------------------------|
| null                    | any                     | overwrite                  |
| `authorization_pending` | any                     | overwrite                  |
| `connected`             | `authorization_pending` | **keep existing**          |
| `disconnected`          | `authorization_pending` | **keep existing**          |
| `error`                 | `authorization_pending` | **keep existing**          |
| terminal                | terminal (any)          | overwrite (latest wins)    |

Terminal = `connected` | `disconnected` | `error`.

### Validation rules

- `setRetainedTunnelEvent` MUST be called only with eligible payloads. `isRetentionEligible` is the boundary check; the route handler calls it before mutating state.
- `getRetainedTunnelEvent` is idempotent (multiple reads return the same event).
- `clearRetainedTunnelEvent` after successful replay MUST be atomic w.r.t. subsequent `setRetainedTunnelEvent` calls in the same microtask (Node event loop guarantees this — no lock needed).

## VsCodeTunnelProcessManager — new fields and options

Location: `packages/control-plane/src/services/vscode-tunnel-manager.ts` (MOD)

### New constants

```ts
export const DEFAULT_DEVICE_CODE_AUTH_TIMEOUT_MS = 300_000;  // 5 minutes
```

Sibling of the existing `DEFAULT_DEVICE_CODE_TIMEOUT_MS = 30_000`. Grep-adjacent.

### `VsCodeTunnelManagerOptions` extension

```ts
export interface VsCodeTunnelManagerOptions {
  binPath: string;
  tunnelName: string;
  forceKillTimeoutMs?: number;
  deviceCodeTimeoutMs?: number;
  authTimeoutMs?: number;                // NEW — overrides DEFAULT_DEVICE_CODE_AUTH_TIMEOUT_MS in tests
}
```

### New private field

```ts
private authTimer: NodeJS.Timeout | null = null;
```

Parallel to the existing `private deviceCodeTimer: NodeJS.Timeout | null = null;`. Same lifecycle discipline (armed once at a specific transition, cleared at every exit point).

### Timer state invariants (post-change)

| Phase                     | `deviceCodeTimer`           | `authTimer`                |
|---------------------------|-----------------------------|----------------------------|
| pre-spawn                 | null                        | null                       |
| `starting`                | armed (30 s)                | null                       |
| `authorization_pending`   | cleared                     | armed (300 s)              |
| `connected`               | cleared                     | cleared                    |
| `disconnected`/`error`    | cleared (in exit handler)   | cleared (in exit handler)  |

## Relationships (module dependency graph)

```
packages/control-plane/src/services/vscode-tunnel-manager.ts
  ↓ emits (via getRelayPushEvent injected at control-plane boot)
packages/control-plane/src/relay-events.ts (existing singleton — control-plane side)
  ↓ HTTP POST /internal/relay-events (existing, via bin/control-plane.ts wiring)
packages/orchestrator/src/routes/internal-relay-events.ts (MOD)
  ├── if isConnected: forward via client.send(…) (unchanged)
  └── else if event === 'cluster.vscode-tunnel' && isRetentionEligible: setRetainedTunnelEvent(…)  ← NEW
packages/orchestrator/src/routes/retained-tunnel-event.ts (NEW)
  ↑ read + clear on reconnect
packages/orchestrator/src/services/relay-bridge.ts (MOD, handleConnected)
  → client.send(…) replay
```

No cyclic imports: `retained-tunnel-event.ts` has zero orchestrator-internal dependencies (only `zod`). Both writers (`internal-relay-events.ts`) and readers (`relay-bridge.ts`) import from it, not vice versa.

## Test-only fake wiring

- `retained-tunnel-event.ts` exports `__resetForTest()` (guarded by `NODE_ENV === 'test'`) or the tests use `clearRetainedTunnelEvent()` in `beforeEach`. Prefer the latter — no test-only export needed; `clearRetainedTunnelEvent()` is a public function used in the reconnect path anyway.
- `VsCodeTunnelProcessManager` tests inject `authTimeoutMs: 50` and use `vi.useFakeTimers()` — same pattern as the existing `deviceCodeTimeoutMs: 50` tests.

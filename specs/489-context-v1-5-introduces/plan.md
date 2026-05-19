# Implementation Plan: Cluster-relay protocol additions and path-prefix dispatcher

**Feature**: Extend relay protocol with actor/activation fields and add path-prefix dispatcher
**Branch**: `489-context-v1-5-introduces`
**Status**: Complete

## Summary

Extend the `@generacy-ai/cluster-relay` package in two areas:

1. **Protocol additions** — Add optional `actor` and `activation` fields to `ApiRequestMessage` and `HandshakeMessage` respectively. These are additive, backward-compatible changes to the Zod schemas and TypeScript types.

2. **Path-prefix dispatcher** — Replace the single-target forwarding model in `proxy.ts` with a dispatcher that routes requests based on path prefixes. Supports both HTTP URL and Unix socket targets. The existing `orchestratorUrl` serves as an implicit fallback for unmatched paths. Uses longest-prefix-match semantics.

## Technical Context

- **Language**: TypeScript (ES2022, ESM)
- **Runtime**: Node.js >=20
- **Validation**: Zod 3.23+
- **Testing**: Vitest 3.2
- **WebSocket**: ws 8.18
- **Package**: `packages/cluster-relay/`

## Project Structure

```
packages/cluster-relay/
├── src/
│   ├── messages.ts       ← Add actor, activation schemas/types
│   ├── proxy.ts          ← Replace with dispatcher + Unix socket support
│   ├── config.ts         ← Add routes + activation config fields
│   ├── relay.ts          ← Pass actor through, activation in handshake
│   ├── dispatcher.ts     ← NEW: path-prefix dispatcher logic
│   ├── cli.ts            ← Wire new config flags (if needed)
│   ├── events.ts         ← No changes
│   ├── metadata.ts       ← No changes
│   └── index.ts          ← Export new types/functions
├── tests/
│   ├── messages.test.ts  ← Add tests for new optional fields
│   ├── proxy.test.ts     ← Rewrite for dispatcher model
│   ├── dispatcher.test.ts← NEW: dispatcher unit tests
│   ├── config.test.ts    ← Add routes/activation validation tests
│   └── relay.test.ts     ← Add actor/activation integration tests
└── README.md             ← Update with dispatcher config shape
```

## Implementation Phases

### Phase 1: Protocol Schema Additions (messages.ts)

**Goal**: Add optional fields to existing message schemas without breaking existing parsing.

**Changes to `messages.ts`**:

1. Define `ActorSchema`:
   ```typescript
   const ActorSchema = z.object({
     userId: z.string(),
     sessionId: z.string().optional(),
   });
   ```

2. Define `ActivationSchema`:
   ```typescript
   const ActivationSchema = z.object({
     code: z.string(),
     clusterApiKeyId: z.string().optional(),
   });
   ```

3. Add `.optional()` `actor` field to `ApiRequestMessageSchema`.
4. Add `.optional()` `activation` field to `HandshakeMessageSchema`.
5. Export TypeScript types: `Actor`, `Activation`.

**Backward compatibility**: Both fields are `.optional()`, so existing messages without them parse identically.

### Phase 2: Config Schema Extensions (config.ts)

**Goal**: Extend `RelayConfig` with routes and activation fields.

**Changes to `config.ts`**:

1. Define `RouteEntrySchema`:
   ```typescript
   const RouteEntrySchema = z.object({
     prefix: z.string().startsWith('/'),
     target: z.string(), // HTTP URL or unix:// socket path
   });
   ```

2. Add to `RelayConfigSchema`:
   - `routes: z.array(RouteEntrySchema).optional().default([])` — prefix routes
   - `activationCode: z.string().optional()` — first-launch claim code
   - `clusterApiKeyId: z.string().optional()` — reconnect API key ID

3. Update `loadConfig()` to populate from overrides (no env vars per clarification Q4 — orchestrator passes these programmatically).

### Phase 3: Path-Prefix Dispatcher (dispatcher.ts — NEW)

**Goal**: Implement a dispatcher that resolves request paths to targets using longest-prefix-match.

**New file `dispatcher.ts`**:

1. `RouteEntry` type: `{ prefix: string; target: string }` (re-exported from config or defined here).

2. `sortRoutes(routes: RouteEntry[]): RouteEntry[]` — Sort by prefix length descending (longest first).

3. `resolveRoute(path: string, routes: RouteEntry[]): { route: RouteEntry; strippedPath: string } | null`:
   - Iterate pre-sorted routes.
   - First match where `path.startsWith(route.prefix)` wins (longest-prefix due to sort order).
   - Strip matched prefix from path (per clarification Q1).
   - Return matched route and stripped path, or null if no match.

4. `isUnixSocket(target: string): boolean` — Check for `unix://` prefix.

5. `parseUnixTarget(target: string): string` — Extract socket path from `unix:///path/to/sock`.

### Phase 4: Proxy Rewrite (proxy.ts)

**Goal**: Replace single-target forwarding with dispatcher-based routing.

**Changes to `proxy.ts`**:

1. Import dispatcher functions.

2. Refactor `handleApiRequest(request, config)`:
   - Call `resolveRoute(request.path, config.routes)` with pre-sorted routes.
   - If match found:
     - If Unix socket target: use Node.js `http.request()` with `socketPath` option.
     - If HTTP target: use `fetch()` as today, but with the matched target URL + stripped path.
   - If no match: fall through to `config.orchestratorUrl` (existing behavior — implicit fallback per clarification Q2).

3. Wire `actor` headers into forwarded requests:
   - If `request.actor` is present:
     - Set `x-generacy-actor-user-id: actor.userId`
     - Set `x-generacy-actor-session-id: actor.sessionId` (only if sessionId is present)
   - If `request.actor` is absent: omit headers entirely.

4. Extract HTTP forwarding to a helper to share between fetch-based and http.request-based paths.

### Phase 5: Relay Integration (relay.ts)

**Goal**: Wire activation into handshake and sort routes at startup.

**Changes to `relay.ts`**:

1. In constructor or `connect()`, pre-sort `config.routes` via `sortRoutes()` and store.

2. In handshake construction:
   - If `config.activationCode` is set, include `activation: { code: config.activationCode, clusterApiKeyId: config.clusterApiKeyId }`.

3. `handleApiRequest` already receives the full config — no change needed for actor forwarding (actor comes from the message, not config).

### Phase 6: Tests

**Message tests** (`messages.test.ts`):
- ApiRequestMessage with actor parses correctly.
- ApiRequestMessage without actor still parses (backward compat).
- HandshakeMessage with activation parses correctly.
- HandshakeMessage without activation still parses.
- Invalid actor/activation shapes rejected.

**Dispatcher tests** (`dispatcher.test.ts` — NEW):
- Longest-prefix-match: `/control-plane/admin/` beats `/control-plane/`.
- Prefix stripping: `/control-plane/api/setup` → `/api/setup`.
- No match returns null.
- Empty routes list returns null.
- Unix socket detection.

**Proxy tests** (`proxy.test.ts`):
- Control-plane prefix → Unix socket forwarding.
- Non-matching prefix → orchestrator HTTP fallback.
- Actor headers added when present, omitted when absent.
- Timeout and error handling preserved.
- Mixed route scenarios.

**Config tests** (`config.test.ts`):
- Routes default to empty array.
- Valid route entries pass validation.
- Invalid prefix (not starting with `/`) rejected.
- Activation fields optional.

**Relay tests** (`relay.test.ts`):
- Handshake includes activation when configured.
- Handshake omits activation when not configured.

### Phase 7: Documentation

**README.md update**:
- Document new dispatcher config shape.
- Example configuration with routes.
- Actor header propagation behavior.
- Activation field usage.

### Phase 8: Exports & Barrel

**Changes to `index.ts`**:
- Export new types: `Actor`, `Activation`, `RouteEntry`.
- Export dispatcher functions if needed by consumers.

## Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Prefix stripping | Strip matched prefix | Standard reverse-proxy convention (Q1) |
| Fallback semantics | Orchestrator is implicit fallback | Preserves backward compat (Q2) |
| Config evolution | `routes` alongside `orchestratorUrl` | No migration needed (Q3) |
| Activation source | `RelayConfig` fields, not env vars | Orchestrator owns activation data (Q4) |
| Match strategy | Longest-prefix-match | Matches nginx convention, prevents order bugs (Q5) |
| Unix socket transport | Node.js `http.request` with `socketPath` | `fetch()` doesn't support Unix sockets natively |
| New file for dispatcher | `dispatcher.ts` | Keeps proxy.ts focused on HTTP mechanics |

## Risk & Mitigation

| Risk | Impact | Mitigation |
|------|--------|------------|
| Unix socket forwarding adds complexity | Medium | Isolate in dispatcher; thorough unit tests |
| Breaking existing message parsing | High | All new fields are `.optional()`; backward-compat tests |
| Fetch vs http.request API mismatch | Low | Normalize response handling in shared helper |

## Dependencies

- No new npm packages required.
- Node.js `http` module (built-in) needed for Unix socket forwarding.
- Upstream: None. This is a leaf change.
- Downstream: v1.5 control-plane service (issue #492) will consume the `/control-plane/*` route.

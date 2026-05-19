# Implementation Plan: Control-plane 401 guard for mutator routes

**Feature**: Control-plane mutator routes should reject missing actor with 401
**Branch**: `520-context-control-plane-s`
**Status**: Complete

## Summary

Add a 401 authentication guard to all external-facing mutator routes in the control-plane package. Requests missing the `x-generacy-actor-user-id` header will be rejected with a structured `UNAUTHORIZED` error response. GET routes and internal routes remain unguarded.

## Technical Context

- **Language**: TypeScript (ESM)
- **Runtime**: Node.js >= 20
- **Package**: `packages/control-plane`
- **Pattern**: Native `node:http` server, centralized error handling via `ControlPlaneError` throw + catch in `server.ts`
- **Testing**: Vitest (based on existing `__tests__/` directory)

## Project Structure

```
packages/control-plane/src/
├── errors.ts           ← Add UNAUTHORIZED code + 401 mapping
├── context.ts          ← Add requireActor() guard
├── routes/
│   ├── credentials.ts  ← Call requireActor() in handlePutCredential
│   ├── roles.ts        ← Call requireActor() in handlePutRole
│   └── lifecycle.ts    ← Call requireActor() in handlePostLifecycle
```

## Implementation Steps

### Step 1: Extend error codes (errors.ts)

1. Add `'UNAUTHORIZED'` to the `ControlPlaneErrorCode` type union.
2. Add `UNAUTHORIZED: 401` to `HTTP_STATUS_MAP`.

No other changes — the existing `ControlPlaneError` class, `sendError()`, and server catch handler all work generically with any code in the union.

### Step 2: Add requireActor guard (context.ts)

Add a `requireActor(actor: ActorContext): void` function that throws `ControlPlaneError('UNAUTHORIZED', 'Missing actor identity')` when `actor.userId` is falsy (undefined or empty string).

Export it alongside `extractActorContext`.

### Step 3: Guard mutator routes

In each of the three PUT/POST handlers, add `requireActor(actor)` as the first statement:

- `handlePutCredential` — rename `_actor` → `actor`, call guard
- `handlePutRole` — rename `_actor` → `actor`, call guard
- `handlePostLifecycle` — rename `_actor` → `actor`, call guard

The guard throws before any mutation logic runs. The existing error-handling pipeline in `server.ts` catches `ControlPlaneError` and serializes it via `sendError()`.

### Step 4: Tests

Add/update tests to verify:
- PUT /credentials/:id without actor header → 401 + `{ error: "Missing actor identity", code: "UNAUTHORIZED" }`
- PUT /roles/:id without actor header → 401
- POST /lifecycle/:action without actor header → 401
- Same routes WITH `x-generacy-actor-user-id` header → 200 (existing behavior)
- GET routes without actor header → 200 (unchanged)
- Internal routes without actor header → 200 (unchanged)

## Constitution Check

No constitution.md found — no governance constraints to verify against.

## Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| Internal services accidentally sending requests without actor header | Internal routes use `/internal/` prefix and are explicitly excluded from the guard |
| Breaking existing tests that call PUT/POST without headers | Update test fixtures to include actor headers where needed |

## Dependencies

None — this is a self-contained change within `packages/control-plane`. No new dependencies required.

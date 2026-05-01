# Research: Control-plane 401 Guard

## Technology Decisions

### Guard Pattern: Throw from handler (chosen)

The control-plane already uses a throw-and-catch pattern:
- Route handlers throw `ControlPlaneError`
- `server.ts` catches in the `.catch()` block and calls `sendError()`

Adding a `requireActor()` helper that throws fits naturally into this pattern. No middleware layer or request pipeline changes needed.

**Alternatives considered:**
1. **Middleware function** — Would require refactoring the router dispatch to support pre-handler hooks. Unnecessary complexity for a single guard check.
2. **Check in `dispatch()` (router.ts)** — Would couple routing to auth concerns. The router is purely structural (URL matching).
3. **Check in `handleRequest()` (server.ts)** — Would require knowing which routes are mutators at the server level. Breaks encapsulation.

### Error Code Placement: Extend existing union (chosen)

Adding `'UNAUTHORIZED'` to the existing `ControlPlaneErrorCode` literal union type is the minimal change. The `HTTP_STATUS_MAP` already handles arbitrary codes generically.

**Alternatives considered:**
1. **Separate AuthError class** — Over-engineering for a single error code addition.
2. **HTTP-only guard (just set 401, no body)** — Breaks the established structured error contract.

### Guard Scope: userId only (chosen)

Per spec, only `userId` presence is enforced. `sessionId` is informational and not required for authorization. This matches the principle that the relay always injects both headers for authenticated requests, but some edge cases (service accounts) may omit session.

## Implementation Patterns

### requireActor pattern

```typescript
export function requireActor(actor: ActorContext): void {
  if (!actor.userId) {
    throw new ControlPlaneError('UNAUTHORIZED', 'Missing actor identity');
  }
}
```

This is a void assertion function — it either passes silently or throws. Callers place it as the first line in handler bodies.

### Route handler integration

```typescript
export async function handlePutCredential(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  actor: ActorContext,  // was _actor
  _params: Record<string, string>,
): Promise<void> {
  requireActor(actor);  // ← new line
  // ... existing logic
}
```

## Key References

- Error handling: `packages/control-plane/src/errors.ts`
- Actor extraction: `packages/control-plane/src/context.ts`
- Server catch block: `packages/control-plane/src/server.ts` (handleRequest + createServer callback)
- Credhelper-daemon precedent: same `{ error, code, details? }` error shape

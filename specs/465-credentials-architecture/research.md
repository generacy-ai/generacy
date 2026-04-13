# Research: AgentLauncher Credentials Interceptor

## Technology Decisions

### HTTP Client for Unix Socket

**Decision**: Node.js built-in `http` module with `socketPath` option.

**Rationale**: The credhelper daemon (#461) exposes HTTP-over-Unix-socket. Node's `http.request()` supports Unix sockets natively via `socketPath`. Zero dependencies — `undici` or `got` would add unnecessary weight for two simple HTTP calls.

**Pattern**:
```typescript
const req = http.request({
  socketPath: '/run/generacy-credhelper/control.sock',
  path: '/sessions',
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
}, callback);
```

### Alternatives Considered

| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| `undici` | Modern, fast, built into Node 18+ | Extra dependency, overkill for 2 endpoints | Rejected |
| Raw TCP/JSON | Simple protocol | Daemon uses HTTP, would require protocol change | Rejected |
| Shared client in `credhelper` package | Reusable | Adds runtime dep to types-only package | Rejected |

### Command Wrapping Strategy

**Decision**: Positional parameter passthrough (`sh -c '...' _ cmd arg1 arg2`).

**Rationale**: The three options from clarification Q1 were static file, dynamic file, and inline `-c`. Inline was chosen (no file I/O), but the specific shell technique matters:

- **String interpolation** (`sh -c ". env && exec ${cmd} ${args}"`): Requires shell escaping, fragile with special characters
- **Positional parameters** (`sh -c '. env && exec "$@"' _ cmd arg1 arg2`): Args pass through `$@` without interpretation, immune to injection

The positional parameter approach is strictly safer and avoids the need for a `shellEscape()` utility entirely.

### Interceptor Architecture

**Decision**: Inline function in `launch()`, not a middleware/plugin system.

**Alternatives**:
1. **Middleware chain** (Express-style `next()`): Over-engineering — only one interceptor exists
2. **Decorator pattern** (wrap ProcessFactory): Conflates concerns — credentials modify more than spawn args
3. **Plugin hook** (add `beforeSpawn` to AgentLaunchPlugin): Wrong layer — credentials are orthogonal to intent-specific launch building

The interceptor is called between env merge and factory.spawn() — exactly where it logically belongs.

### Async Launch

**Decision**: Convert `launch()` from sync to async.

The interceptor must call `beginSession()` over HTTP before spawning, making async unavoidable. The alternative (synchronous launch with deferred session begin) would race session setup against subprocess startup — the subprocess could start before credentials are provisioned.

All three callers are already in async contexts, minimizing impact.

## Implementation Patterns

### Error Handling Pattern

Follow the existing `CredhelperError` pattern from `credhelper-daemon/src/errors.ts`:

```typescript
class CredhelperUnavailableError extends Error {
  constructor(socketPath: string, cause?: Error) {
    super(
      `Cannot begin session — credhelper not responding at ${socketPath}\n` +
      `(is the credhelper daemon running? check worker container entrypoint)`
    );
    this.cause = cause;
  }
}
```

Key principle from clarification Q2: hard failure, not graceful degradation. If credentials were requested, they are required.

### Session Cleanup Pattern

Register cleanup on `exitPromise` (which resolves on both normal exit and error):

```typescript
handle.process.exitPromise.then(() => {
  client.endSession(sessionId).catch((err) => {
    logger.warn('Failed to end credhelper session', { sessionId, err });
  });
});
```

`endSession` failures are logged but never thrown — the subprocess is already dead, and the daemon's sweeper will clean up.

### Session ID Format

From clarification Q3: `{agentId}-{workflowId}-{timestamp}-{random4}`

```typescript
function generateSessionId(env: Record<string, string>): string {
  const agentId = env.AGENT_ID ?? env.HOSTNAME ?? 'unknown';
  const workflowId = env.WORKFLOW_ID ?? 'adhoc';
  const timestamp = Math.floor(Date.now() / 1000);
  const random = crypto.randomBytes(2).toString('hex'); // 4 hex chars
  return `${agentId}-${workflowId}-${timestamp}-${random}`;
}
```

## Key References

- Credhelper daemon API: `packages/credhelper-daemon/src/control-server.ts`
- Shared types: `packages/credhelper/src/types/launch.ts` (`LaunchRequestCredentials`)
- Shared types: `packages/credhelper/src/types/session.ts` (session request/response)
- Spawn refactor: `packages/orchestrator/src/launcher/agent-launcher.ts`
- ProcessFactory interface: `packages/orchestrator/src/worker/types.ts:257`
- Credentials architecture plan: `tetrad-development/docs/credentials-architecture-plan.md`

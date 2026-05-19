# Research: Extend ProcessFactory with uid/gid

## Technology Decision: uid/gid Pass-Through Pattern

### Approach: Conditional spread

Forward `uid`/`gid` to `child_process.spawn` only when defined, using conditional object spread:

```typescript
...(options.uid !== undefined && { uid: options.uid }),
...(options.gid !== undefined && { gid: options.gid }),
```

### Alternatives Considered

| Approach | Pros | Cons | Decision |
|----------|------|------|----------|
| Always pass uid/gid (even if undefined) | Simpler code | Adds `uid: undefined` to spawn options; changes serialized shape | Rejected — FR-005 requires they "must not appear" when undefined |
| Destructure and rebuild options object | Explicit | More verbose, harder to maintain | Rejected — conditional spread is idiomatic |
| **Conditional spread** | Precise, idiomatic, only adds keys when defined | Slightly more syntax | **Selected** |

### Node.js `child_process.spawn` uid/gid Support

- `uid` and `gid` are documented options of `child_process.spawn` (Node.js built-in)
- Type: `number | undefined`
- Platform: Unix only — silently ignored on Windows
- No special permissions required to run as the *current* uid/gid; running as a *different* uid requires root or `CAP_SETUID`

### Testing Strategy

Both factory implementations are already tested via mock injection in `cli-spawner.test.ts` and `conversation-spawner.test.ts`. The new tests will:

1. Spy on `child_process.spawn` to verify the options object
2. Assert `uid`/`gid` are present when provided
3. Assert `uid`/`gid` keys are absent (not just undefined) when omitted

The existing test mock pattern is:
```typescript
const spawnFn = vi.fn();
const factory = { spawn: spawnFn } as unknown as ProcessFactory;
```

For testing the actual implementations, we need to mock `child_process.spawn` at the module level using `vi.mock('child_process')`.

## Key References

- [Node.js child_process.spawn docs](https://nodejs.org/api/child_process.html#child_processspawncommand-args-options)
- [Spawn refactor plan](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/spawn-refactor-plan.md#phase-6--extend-processfactory-with-uidgid-no-callers-use-it-yet)
- Parent tracking: #423

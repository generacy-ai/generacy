# Data Model: Route-aware session invalidation + transition logging

## Route (consumed type)

```ts
// Owned by @generacy-ai/generacy-plugin-claude-code (#1198). Consumed, never redefined.
type Route = ReturnType<typeof resolveRoute>; // 'subscription' | 'gateway'
```

- Opaque canonical string union (Q1→A). Compare with strict `===`; log verbatim.
- If #1198 exports a named type, bind to it at implement time instead of
  `ReturnType<...>`.
- `'subscription'` is the default/no-op route: a run with no gateway configuration
  resolves every phase to it.

## Phase-loop tracker state (phase-loop.ts, executeLoopInner locals)

| Tracker | Type | Existing/new | Update point |
|---|---|---|---|
| `currentSessionId` | `string \| undefined` | existing | post-spawn; cleared on provider OR route change |
| `currentProvider` | `string \| undefined` | existing | post-spawn (`:826`) |
| `currentModel` | `string \| undefined` | existing | post-spawn (`:827`) |
| `currentRoute` | `Route \| undefined` | **new** | post-spawn, alongside the two above |

Invariants:
- All trackers update **after** a successful spawn attempt begins (same point as
  today), so spawn failures don't strand state.
- `undefined` means "no CLI phase has run yet"; `undefined → X` initializes with no
  side effects (Q3→A).

## `agent.route.transition` log event (FR-003)

Emitted at `logger.info` level when `currentRoute !== undefined && currentRoute !== nextRoute`:

```ts
{
  phase: WorkflowPhase,          // the CLI phase about to spawn
  prevRoute: Route,              // never undefined (Q3→A)
  nextRoute: Route,
  prevModel: string | undefined, // tracker value before post-spawn update
  nextModel: string | undefined, // resolved model for this phase
}
// message: 'agent.route.transition'
```

Emission rules:
- Fires on ANY route change, including cross-provider hops — co-fires with the
  existing provider-switch line (Q2→A).
- On a same-provider route flip, `agent.model.transition` ALSO fires (a route flip is
  inherently a model change); neither line suppresses the other (FR-004).
- Route strings logged verbatim, no mapping (Q1→A).

## `CliSpawnOptions` extension (FR-006)

```ts
// packages/orchestrator/src/worker/types.ts
interface CliSpawnOptions {
  // ...existing fields (prompt, cwd, env, timeoutMs, signal, resumeSessionId,
  //    siblingWorkdirs, provider, model?, effort?, previousModel?)...
  route?: string;   // resolved route for the phase; optional for compatibility
}
```

- phase-loop passes `route: nextRoute` in the `spawnPhase` options.
- `CliSpawner.spawnPhase`'s existing spawn log (`cli-spawner.ts:53-63`) adds
  `route: options.route` to its payload. No new log event.
- Typed `string` (not the union) at this boundary: the spawner logs it verbatim and
  never branches on it — keeps `types.ts` free of a plugin type import.

## Direct-caller log payloads (FR-007)

Each caller adds `route: resolveRoute(model)` to its launch log:

| Caller | Log line | Payload delta |
|---|---|---|
| `pr-feedback-handler.ts:895` | 'Spawning Claude CLI for PR feedback' | `+ route` |
| `review-executor.ts:241` | 'Spawning Claude CLI for review phase' | `+ route` |
| `remediate-executor.ts:108` | 'Spawning Claude CLI for remediate phase' | `+ route` |
| `merge-conflict-handler.ts` (`spawnAgentForConflict`) | **new** 'MergeConflictHandler: spawning agent CLI for conflict resolution' | `{ cwd, provider, model, effort, route }` |

No session behavior changes at these sites — they already start fresh sessions.

## State transitions (session invalidation decision table)

| prevProvider → nextProvider | prevRoute → nextRoute | Session | Lines emitted |
|---|---|---|---|
| same | same | kept (resume) | model line iff model changed |
| same | changed | **dropped** | `agent.route.transition` + `agent.model.transition` |
| changed | same | **dropped** | provider-switch line |
| changed | changed | **dropped once** | provider-switch + `agent.route.transition` |
| `undefined` (first phase) | `undefined → X` | n/a (no session yet) | none |

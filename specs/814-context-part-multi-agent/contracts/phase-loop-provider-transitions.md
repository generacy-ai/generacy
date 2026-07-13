# Contract: Phase-Loop Provider/Model Transitions

**Location**: `packages/orchestrator/src/worker/phase-loop.ts`, inside `executeLoop`'s per-phase iteration.

## State

The loop's closure tracks three values across phases (all initialized to `undefined`):

- `currentSessionId: string | undefined` — Claude CLI session ID from the most recent phase.
- `currentProvider: string | undefined` — provider that produced `currentSessionId`. Cleared when the session is dropped.
- `currentModel: string | undefined` — model that produced `currentSessionId`. Used to compute `previousModel` on the next spawn.

## Per-phase transition sequence

Before each CLI phase spawn (after gate check, before the spawner call):

1. `const { provider: nextProvider, model: nextModel } = resolveAgentForPhase(config, item.workflowName, cliPhase)`.
2. **Session drop on provider switch** — if `currentProvider !== undefined && currentProvider !== nextProvider`:
   - Set `currentSessionId = undefined` (FR-011).
   - Set `currentProvider = undefined` and `currentModel = undefined` (fresh session — no previous model to log against).
3. **Compute `previousModel`** for the log line:
   - `const previousModel = currentProvider !== undefined && currentModel !== undefined ? currentModel : undefined`.
   - (i.e., only present when the session is being preserved across the transition and a prior model was known.)
4. **Emit `agent.model.transition` log line** (Q2→C) — if `currentProvider !== undefined && currentProvider === nextProvider && currentModel !== undefined && nextModel !== undefined && currentModel !== nextModel`:
   - `logger.info({ provider: nextProvider, prevModel: currentModel, nextModel }, 'agent.model.transition')`.
5. Spawn: `cliSpawner.spawnPhase(cliPhase, { ..., provider: nextProvider, model: nextModel, previousModel, resumeSessionId: currentSessionId }, outputCapture)`.
6. After spawn, update tracking state:
   - `currentProvider = nextProvider`.
   - `currentModel = nextModel`.
   - `currentSessionId` update path unchanged: if `result.sessionId` present, `currentSessionId = result.sessionId`.

## Decision table

| Prev provider | Next provider | Prev model | Next model | Session action | Log line |
|---|---|---|---|---|---|
| undefined (first phase) | X | — | Y | keep (no prior) | — |
| X | X | Y | Y | preserve | — |
| X | X | Y | Z | preserve | `agent.model.transition prev=Y next=Z` |
| X | X | undefined | Z | preserve | — (no prior model to compare) |
| X | Y | any | any | **drop** (`currentSessionId = undefined`) | — |

## Fake-plugin test scaffold (multi-provider switch)

Register a minimal `AgentLaunchPlugin` under provider `'test-agent'` (kind `'phase'`) that returns a canned success. Then run a two-phase fixture where:
- `agents.workflows.<w>.phases.specify = { provider: 'claude-code' }`.
- `agents.workflows.<w>.phases.clarify = { provider: 'test-agent' }`.

Assert:
- `spawnPhase('specify', ...)` receives `provider: 'claude-code'`, `resumeSessionId: undefined`.
- Between phases, the test observes `currentSessionId` reset to `undefined` before the `clarify` spawn.
- `spawnPhase('clarify', ...)` receives `provider: 'test-agent'`, `resumeSessionId: undefined`.

For same-provider model transition:
- `agents.workflows.<w>.phases.specify = { provider: 'claude-code', model: 'M1' }`.
- `agents.workflows.<w>.phases.clarify = { provider: 'claude-code', model: 'M2' }`.
- Spy-log asserts `agent.model.transition prev=M1 next=M2` fires exactly once, and `spawnPhase('clarify', ...)` receives `resumeSessionId: <preserved>`.

## Not modeled here

- `sessionId` persistence to `.generacy/workflow-state-*.json` — session is loop-scoped.
- Cross-worker/cross-invocation state — the loop runs in one worker; `currentProvider`/`currentModel` are recreated on each `executeLoop` invocation. Resumed workflows (continue command) do not persist provider identity across process boundaries; `currentProvider` starts `undefined` on resume and the first phase's resolver decides afresh. This preserves the "no session drop unless explicitly configured different" invariant across resumes.

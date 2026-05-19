# Implementation Plan: Consolidate root-level claude-code-invoker

**Feature**: Route ClaudeCodeInvoker through AgentLauncher + ClaudeCodeLaunchPlugin
**Branch**: `436-goal-phase-5-spawn`
**Status**: Complete

## Summary

Rewrite `ClaudeCodeInvoker` as a thin adapter that delegates to `AgentLauncher` instead of calling `child_process.spawn` directly. A new `invoke` intent kind is added to `ClaudeCodeLaunchPlugin` to produce the `--print --dangerously-skip-permissions <command>` argv. The adapter retains `parseToolCalls()`, stdout/stderr collection, and timeout handling — the plugin stays unaware of `---TOOL_CALLS---` markers. `isAvailable()` routes through the launcher via `generic-subprocess` intent. The `AgentInvoker` interface is unchanged.

## Technical Context

**Language/Version**: TypeScript 5.4+ / Node.js 20+
**Primary Dependencies**: `@generacy-ai/orchestrator` (AgentLauncher, ProcessFactory, ChildProcessHandle), `@generacy-ai/generacy-plugin-claude-code` (ClaudeCodeLaunchPlugin, InvokeIntent)
**Storage**: N/A
**Testing**: vitest 4.x
**Target Platform**: Node.js server
**Project Type**: Monorepo (pnpm workspaces)

## Constitution Check

No constitution file found — no gates to check.

## Project Structure

### Documentation (this feature)

```text
specs/436-goal-phase-5-spawn/
├── plan.md              # This file
├── research.md          # Technology decisions
├── data-model.md        # Type changes and interfaces
├── quickstart.md        # Testing guide
├── contracts/           # Interface contracts
│   └── invoke-intent.ts # InvokeIntent type contract
├── spec.md              # Feature specification (read-only)
└── clarifications.md    # Q&A from clarify phase
```

### Source Code (repository root)

```text
packages/generacy-plugin-claude-code/src/launch/
├── types.ts                        # MODIFY: add InvokeIntent to ClaudeCodeIntent union
├── claude-code-launch-plugin.ts    # MODIFY: handle 'invoke' kind in buildLaunch()
└── __tests__/
    └── claude-code-launch-plugin.test.ts  # MODIFY: add invoke intent tests

packages/orchestrator/src/launcher/
├── types.ts                        # READ-ONLY: LaunchIntent auto-inherits InvokeIntent via ClaudeCodeIntent
└── launcher-setup.ts               # READ-ONLY: createAgentLauncher already registers ClaudeCodeLaunchPlugin

src/agents/
├── claude-code-invoker.ts          # REWRITE: adapter over AgentLauncher (remove child_process import)
├── types.ts                        # READ-ONLY: AgentInvoker interface unchanged
└── errors.ts                       # READ-ONLY

src/worker/
└── main.ts                         # MODIFY: import createAgentLauncher, pass to ClaudeCodeInvoker

tests/agents/
└── claude-code-invoker.test.ts     # REWRITE: adapter-level tests (InvocationConfig → LaunchRequest)

tests/worker/handlers/
└── agent-handler.test.ts           # MODIFY: exercise new AgentLauncher path

package.json                        # MODIFY: add @generacy-ai/orchestrator workspace dependency
```

**Structure Decision**: Existing monorepo layout. Changes span three packages: `generacy-plugin-claude-code` (new intent kind), `orchestrator` (read-only — inherits via type import), and root `generacy` (adapter rewrite + worker wiring).

## Implementation Phases

### Phase 0: Plugin — Add `invoke` intent kind

**Goal**: Extend `ClaudeCodeLaunchPlugin` to handle the `invoke` intent, producing the `--print --dangerously-skip-permissions <command>` argv.

1. **`packages/generacy-plugin-claude-code/src/launch/types.ts`** — Add `InvokeIntent` interface and extend `ClaudeCodeIntent` union:
   ```typescript
   export interface InvokeIntent {
     kind: 'invoke';
     command: string;
     streaming?: boolean;
   }
   export type ClaudeCodeIntent = PhaseIntent | PrFeedbackIntent | ConversationTurnIntent | InvokeIntent;
   ```

2. **`packages/generacy-plugin-claude-code/src/launch/claude-code-launch-plugin.ts`** — Add `'invoke'` to `supportedKinds` and implement `buildInvokeLaunch()`:
   - Switch case: `case 'invoke': return this.buildInvokeLaunch(intent);`
   - `buildInvokeLaunch()` returns `{ command: 'claude', args: ['--print', '--dangerously-skip-permissions', intent.command], stdioProfile: 'default' }`

3. **Plugin tests** — Add tests verifying:
   - `invoke` intent produces correct argv: `['--print', '--dangerously-skip-permissions', '<command>']`
   - `stdioProfile` is `'default'`
   - `createOutputParser()` returns no-op parser for `invoke` intent

### Phase 1: Root package — Add orchestrator dependency

**Goal**: Enable the root package to import `createAgentLauncher` and process factory types.

4. **`package.json`** — Add `"@generacy-ai/orchestrator": "workspace:*"` to dependencies.

5. **Run `pnpm install`** to link the workspace dependency.

### Phase 2: Adapter rewrite — ClaudeCodeInvoker

**Goal**: Rewrite `ClaudeCodeInvoker` to delegate all spawning through `AgentLauncher`.

6. **`src/agents/claude-code-invoker.ts`** — Full rewrite:

   a. **Remove** `import { spawn } from 'child_process'`. Replace with import of `AgentLauncher` type from `@generacy-ai/orchestrator`.

   b. **Constructor**: Accept `AgentLauncher` as required parameter:
      ```typescript
      constructor(private readonly agentLauncher: AgentLauncher) {}
      ```

   c. **`isAvailable()`**: Route through launcher with `generic-subprocess` intent:
      ```typescript
      const handle = this.agentLauncher.launch({
        intent: { kind: 'generic-subprocess', command: 'claude', args: ['--version'] },
        cwd: process.cwd(),
      });
      const code = await handle.process.exitPromise;
      return code === 0;
      ```
      Wrap in try/catch, return `false` on any error.

   d. **`invoke(config)`**: Build `LaunchRequest` with `invoke` intent:
      - Build env: `{ ...process.env, ...config.context.environment, ...(config.context.mode ? { CLAUDE_MODE: config.context.mode } : {}) }`
      - Launch: `this.agentLauncher.launch({ intent: { kind: 'invoke', command: config.command }, cwd: config.context.workingDirectory, env })`
      - Collect stdout/stderr from `handle.process.stdout`/`handle.process.stderr` data events
      - Set up timeout with `setTimeout` + `handle.process.kill('SIGTERM')` (per clarification Q5 answer B)
      - Await `handle.process.exitPromise`
      - Call `parseToolCalls()` and `combineOutput()` on collected output
      - Build and return `InvocationResult`

   e. **Keep**: `parseToolCalls()`, `combineOutput()`, `buildEnvironment()` (adapted for env override on LaunchRequest), all error code mapping logic.

   f. **Remove**: `buildArgs()` (replaced by plugin's `buildInvokeLaunch()`).

### Phase 3: Worker integration — main.ts

**Goal**: Wire `createAgentLauncher()` in the root worker and pass to `ClaudeCodeInvoker`.

7. **`src/worker/main.ts`** — Update imports and initialization:

   a. **Add imports**:
      ```typescript
      import { createAgentLauncher } from '@generacy-ai/orchestrator';
      import { defaultProcessFactory, conversationProcessFactory } from '@generacy-ai/orchestrator';
      ```

   b. **Replace** lines 140-144 with:
      ```typescript
      const agentLauncher = createAgentLauncher({
        default: defaultProcessFactory,
        interactive: conversationProcessFactory,
      });
      const registry = new AgentRegistry();
      const claudeCode = new ClaudeCodeInvoker(agentLauncher);
      registry.register(claudeCode);
      registry.setDefault(claudeCode.name);
      ```

   c. **Keep** `AgentRegistry` usage — `WorkerProcessor` and `AgentHandler` still dispatch via registry → invoker pattern.

### Phase 4: Tests

**Goal**: Rewrite tests to verify adapter translation and plugin coverage.

8. **`tests/agents/claude-code-invoker.test.ts`** — Rewrite as adapter tests:
   - Mock `AgentLauncher.launch()` to return a mock `LaunchHandle`
   - Test `invoke()` builds correct `LaunchRequest` with `invoke` intent
   - Test environment merge (process.env + context.environment + CLAUDE_MODE)
   - Test timeout handling (setTimeout + kill on handle.process)
   - Test `parseToolCalls()` still works via adapter
   - Test `isAvailable()` launches `generic-subprocess` intent
   - Test error propagation from launch failures

9. **`tests/worker/handlers/agent-handler.test.ts`** — Update to exercise new path:
   - Mock `AgentLauncher` in integration tests
   - Verify end-to-end: job payload → registry → invoker.invoke() → LaunchRequest

10. **Plugin tests** (covered in Phase 0 step 3):
    - Spawn-argv assertions that were previously in `claude-code-invoker.test.ts` move here
    - `['--print', '--dangerously-skip-permissions', command]` verification at the plugin level

## Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| Extend `ClaudeCodeLaunchPlugin` (not new plugin) | `invoke` kind is Claude-specific; same plugin owns all Claude CLI intents per pattern from #425 |
| `invoke` intent carries raw command string | No parsing — `InvocationConfig.command` maps directly to `intent.command` (clarification Q1) |
| Adapter owns stream collection + timeout | Minimal change from current behavior; plugin stays clean (clarification Q5) |
| `parseToolCalls()` stays in adapter | `InvocationResult.toolCalls` is part of `AgentInvoker` contract (clarification Q3) |
| `isAvailable()` via `generic-subprocess` intent | No `child_process` import remains in `src/agents/` (clarification Q4) |
| `setTimeout` + `kill('SIGTERM')` for timeout | Same semantics as current code, no `AbortSignal` introduction (clarification Q5) |
| `AgentRegistry` kept in main.ts | `WorkerProcessor` dispatches via registry; removing it is out of scope |

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| Env merge divergence | Plugin returns no env for `invoke` intent → 3-layer merge collapses to `{ ...process.env, ...callerEnv }`, matching current behavior |
| `parseToolCalls()` regression | Adapter tests assert identical parsing from same test fixtures |
| `isAvailable()` hangs via launcher | Try/catch with `false` return; `generic-subprocess` intent spawns `claude --version` which exits quickly |
| Process factory not available | `createAgentLauncher()` registers both `default` and `interactive` profiles; `invoke` uses `default` |
| Breaking `AgentInvoker` consumers | Interface is read-only; adapter implements the same methods with same signatures |

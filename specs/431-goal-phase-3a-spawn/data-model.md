# Data Model: Phase 3a — Migrate spawnPhase to AgentLauncher

## Core Entities

This migration doesn't introduce new types — it wires existing types together in a new call path. The key entities and their relationships are documented here for reference.

### CliSpawner (modified)

```typescript
// packages/orchestrator/src/worker/cli-spawner.ts
class CliSpawner {
  constructor(
    agentLauncher: AgentLauncher,    // NEW — for spawnPhase()
    processFactory: ProcessFactory,   // KEPT — for runValidatePhase(), runPreValidateInstall()
    logger: Logger,
    shutdownGracePeriodMs?: number,
  )

  spawnPhase(phase: WorkflowPhase, options: CliSpawnOptions, capture: OutputCapture): Promise<PhaseResult>
  runValidatePhase(checkoutPath: string, validateCommand: string, signal: AbortSignal): Promise<PhaseResult>
  runPreValidateInstall(checkoutPath: string, installCommand: string, signal: AbortSignal): Promise<PhaseResult>
}
```

### PhaseIntent (existing, from generacy-plugin-claude-code)

```typescript
// packages/generacy-plugin-claude-code/src/launch/types.ts
interface PhaseIntent {
  kind: 'phase';
  phase: 'specify' | 'clarify' | 'plan' | 'tasks' | 'implement';  // excludes 'validate'
  prompt: string;       // issue URL (plugin composes the slash command)
  sessionId?: string;   // resume previous session
}
```

### LaunchRequest (existing, from orchestrator)

```typescript
// packages/orchestrator/src/launcher/types.ts
interface LaunchRequest {
  intent: LaunchIntent;              // PhaseIntent for this use case
  cwd: string;                       // checkoutPath
  env?: Record<string, string>;      // caller env overrides
  signal?: AbortSignal;              // NOT passed (manageProcess owns signal)
  detached?: boolean;                // NOT used for phase spawns
}
```

### LaunchHandle (existing, from orchestrator)

```typescript
// packages/orchestrator/src/launcher/types.ts
interface LaunchHandle {
  process: ChildProcessHandle;       // extracted for manageProcess()
  outputParser: OutputParser;        // IGNORED (no-op, OutputCapture used instead)
  metadata: { pluginId: string; intentKind: string; }
}
```

## Call Flow (Post-Migration)

```
PhaseLoop.executeLoop()
  └─ cliSpawner.spawnPhase(phase, options, capture)
       │
       ├─ agentLauncher.launch({ intent: PhaseIntent, cwd, env })
       │    ├─ Resolve plugin: ClaudeCodeLaunchPlugin
       │    ├─ plugin.buildPhaseLaunch(intent) → LaunchSpec { command, args, env, stdioProfile }
       │    ├─ Merge env: process.env ← plugin.env ← caller.env
       │    ├─ Select factory: 'default' → ProcessFactory
       │    └─ factory.spawn(command, args, { cwd, env }) → ChildProcessHandle
       │
       ├─ Extract handle.process → child: ChildProcessHandle
       │
       └─ manageProcess(child, phase, timeoutMs, signal, capture)
            ├─ Attach stdout → capture.processChunk()
            ├─ Attach stderr → stderrBuffer
            ├─ Set timeout → gracefulKill()
            ├─ Set abort listener → gracefulKill()
            └─ Await exitPromise → PhaseResult
```

## Relationships

```
ClaudeCliWorker
  ├─ owns AgentLauncher (constructed in constructor)
  ├─ owns ProcessFactory
  └─ creates CliSpawner(agentLauncher, processFactory, logger, gracePeriod)

CliSpawner
  ├─ uses AgentLauncher for spawnPhase()
  └─ uses ProcessFactory for runValidatePhase(), runPreValidateInstall()

AgentLauncher
  ├─ dispatches to ClaudeCodeLaunchPlugin (for 'phase' intent)
  └─ uses ProcessFactory ('default' profile) to spawn

ClaudeCodeLaunchPlugin
  └─ buildPhaseLaunch() composes: command='claude', args=['-p', '--output-format', ...], stdioProfile='default'
```

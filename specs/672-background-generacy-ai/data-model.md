# Data Model: Orchestrator Types Package

**Feature**: #672 — Extract orchestrator types
**Date**: 2026-05-20

## Core Entities

### AgentLauncher (Interface)

The public contract for launching agent processes. Currently a class in `orchestrator/src/launcher/agent-launcher.ts`.

```typescript
export interface AgentLauncher {
  /**
   * Register a plugin that handles a specific intent kind.
   */
  registerPlugin(plugin: AgentLaunchPlugin): void;

  /**
   * Resolve intent, merge env, select factory, and spawn the process.
   */
  launch(request: LaunchRequest): Promise<LaunchHandle>;
}
```

### LaunchHandle (Interface)

Returned by `AgentLauncher.launch()`. Wraps the spawned process with metadata and output parsing.

```typescript
export interface LaunchHandle {
  /** The underlying child process handle */
  process: ChildProcessHandle;
  /** Plugin-created output parser for this launch */
  outputParser: OutputParser;
  /** Plugin-provided metadata */
  metadata: {
    pluginId: string;
    intentKind: string;
    [key: string]: unknown;
  };
}
```

### OrchestratorConfig (Interface)

Simplified interface representing the orchestrator configuration shape. The full Zod-inferred type lives in the orchestrator package; this is the minimal surface the CLI needs for type annotations.

```typescript
export interface OrchestratorConfig {
  mode: 'full' | 'worker';
  server: { host: string; port: number };
  redis: { url: string; prefix?: string };
  auth: { apiKeys: string[] };
  repositories: Array<{ url: string; name: string; [key: string]: unknown }>;
  [key: string]: unknown;  // Allow additional config sections
}
```

## Supporting Types

These types are required by `LaunchHandle` and `AgentLaunchPlugin`:

### ChildProcessHandle

```typescript
export interface ChildProcessHandle {
  readonly pid: number | undefined;
  readonly exitPromise: Promise<number | null>;
  kill(signal?: string): boolean;
  readonly stdout: NodeJS.ReadableStream | null;
  readonly stderr: NodeJS.ReadableStream | null;
  readonly stdin: NodeJS.WritableStream | null;
}
```

### OutputParser

```typescript
export interface OutputParser {
  readonly name: string;
  processLine(line: string): void;
  getResult(): unknown;
}
```

### AgentLaunchPlugin

```typescript
export interface AgentLaunchPlugin {
  readonly id: string;
  readonly intentKind: string;
  resolve(request: LaunchRequest): LaunchSpec;
  createOutputParser(): OutputParser;
}
```

### LaunchRequest

```typescript
export interface LaunchRequest {
  intent: LaunchIntent;
  env?: Record<string, string>;
  cwd?: string;
  credentials?: LaunchRequestCredentials;
}
```

### LaunchSpec

```typescript
export interface LaunchSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  stdioProfile: string;
}
```

### LaunchIntent (Union)

```typescript
export type LaunchIntent = GenericSubprocessIntent | ShellIntent;

export interface GenericSubprocessIntent {
  kind: 'generic-subprocess';
  command: string;
  args: string[];
}

export interface ShellIntent {
  kind: 'shell';
  script: string;
  shell?: string;
}
```

## Type Relationships

```
AgentLauncher
  ├── registerPlugin(AgentLaunchPlugin)
  │     ├── resolve(LaunchRequest) → LaunchSpec
  │     └── createOutputParser() → OutputParser
  └── launch(LaunchRequest) → LaunchHandle
        ├── process: ChildProcessHandle
        ├── outputParser: OutputParser
        └── metadata: { pluginId, intentKind }

OrchestratorConfig (standalone, no relationships to launcher types)
```

## Package Boundary

| Type | Defined In | Used By |
|------|-----------|---------|
| `AgentLauncher` (interface) | `orchestrator-types` | CLI (`subprocess.ts`), orchestrator (implements) |
| `LaunchHandle` | `orchestrator-types` | CLI tests, orchestrator |
| `OrchestratorConfig` (interface) | `orchestrator-types` | CLI (`orchestrator.ts` — will become dynamic import) |
| `AgentLauncher` (class) | `orchestrator` | Orchestrator internals, CLI tests (devDep) |
| Full `OrchestratorConfig` (Zod) | `orchestrator` | Orchestrator internals |

## Validation Rules

The types package contains **no validation** — it's interfaces only. Validation lives in the orchestrator package via Zod schemas. The interface definitions use TypeScript's structural type system for compile-time checking only.

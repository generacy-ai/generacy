# Implementation Plan: Claude CLI Worker with Phase Loop

**Feature**: Replace placeholder handler in `WorkerDispatcher` with production `ClaudeCliWorker` that spawns Claude CLI processes and drives the speckit phase loop
**Branch**: `feature/198-cli-worker-phase-loop`
**Status**: Complete

## Summary

Implement a `ClaudeCliWorker` class that plugs into the existing `WorkerDispatcher` as a `WorkerHandler`. The worker resolves the starting phase from issue labels, loops through all remaining phases by spawning `claude --headless` for each, manages label transitions, posts stage comments, captures output for SSE streaming, handles errors with structured reporting, and stops cleanly at review gates or workflow completion.

## Technical Context

- **Language**: TypeScript (ES2022, Node16 modules)
- **Runtime**: Node.js >= 20
- **Package**: `@generacy-ai/orchestrator` (monorepo at `packages/orchestrator/`)
- **Build**: `tsc` with strict mode
- **Test**: Vitest
- **Dependencies**: ioredis, fastify, pino, zod, @octokit/rest (via `@generacy-ai/workflow-engine`)
- **Process management**: `node:child_process` spawn with stdio pipes

## Architecture

```
WorkerDispatcher
  └─ WorkerHandler (ClaudeCliWorker.handle)
       ├─ PhaseResolver        — resolves starting phase from labels
       ├─ PhaseLoop            — iterates phases until gate/completion
       │    ├─ ClaudeCliSpawner  — spawns `claude` child process
       │    ├─ LabelManager      — manages phase/completed/waiting labels
       │    ├─ StageCommentManager — posts/updates stage comments
       │    └─ GateChecker       — checks config-driven review gates
       ├─ OutputCapture        — parses CLI JSON output, emits SSE events
       ├─ RepoCheckout         — ensures per-worker isolated checkout
       └─ ErrorHandler         — structured error reporting
```

## Project Structure

```
packages/orchestrator/src/
├── worker/                          # NEW directory
│   ├── claude-cli-worker.ts         # Main worker class (WorkerHandler implementation)
│   ├── phase-resolver.ts            # Phase resolution from issue labels
│   ├── phase-loop.ts                # Phase iteration logic with gate checking
│   ├── cli-spawner.ts               # Claude CLI process spawning and management
│   ├── label-manager.ts             # GitHub label transition operations
│   ├── stage-comment-manager.ts     # Stage comment create/update with HTML markers
│   ├── gate-checker.ts              # Configuration-driven review gate checking
│   ├── output-capture.ts            # JSON output parsing and SSE event emission
│   ├── repo-checkout.ts             # Git clone/fetch/checkout per worker
│   ├── types.ts                     # Worker-specific type definitions
│   ├── config.ts                    # Worker config schema (extends DispatchConfig)
│   └── index.ts                     # Public exports
├── worker/__tests__/                # NEW test directory
│   ├── claude-cli-worker.test.ts    # Integration tests with mocked CLI
│   ├── phase-resolver.test.ts       # Phase resolution unit tests
│   ├── phase-loop.test.ts           # Loop logic unit tests
│   ├── cli-spawner.test.ts          # Spawner tests with mock process
│   ├── label-manager.test.ts        # Label operation tests
│   ├── gate-checker.test.ts         # Gate config tests
│   └── output-capture.test.ts       # Output parsing tests
└── server.ts                        # MODIFIED — replace placeholder with ClaudeCliWorker
```

## Key Design Decisions

### 1. Full Loop Per Claim (Clarification Q1: B)
The worker processes ALL remaining phases in a single queue claim. The dispatcher calls `queue.complete()` on success (permanently removing the item). Re-enqueue only happens when `LabelMonitorService` detects a `completed:*` label change for `continue` commands.

### 2. Raw Speckit Commands (Clarification Q5: B)
The worker invokes `claude --headless --output json --print all --max-turns 100 --prompt "/speckit:<phase>"`. The worker handles all label transitions, stage comments, and state management. Speckit commands only do the AI work (generate artifacts).

### 3. Configuration-Driven Gates (Clarification Q3: C)
Gate configuration is per-workflow-type. Default for `speckit-feature`: gates at `clarify` (always). Default for `speckit-bugfix`: no clarify gate. Optional review gates can be enabled per phase in config.

### 4. Per-Worker Isolated Checkout (Clarification Q4: A)
Each worker gets an isolated checkout at `{WORKSPACE_DIR}/{workerId}/{owner}/{repo}`. This avoids race conditions when multiple workers process issues on the same repo.

### 5. Configurable Validate Phase (Clarification Q2: B)
The validate phase runs a configurable test command (default: `pnpm test && pnpm build`). Auto-completes if tests pass; sets `agent:error` if they fail.

### 6. Separation of Concerns
- `ClaudeCliWorker` is the top-level orchestrator composing all sub-components
- Each sub-component (PhaseResolver, LabelManager, etc.) is independently testable
- The worker creates a fresh GitHub client per invocation using `createGitHubClient`
- Process factories are injectable for testing (mock process instead of real Claude CLI)

## Integration Points

| Component | Integration |
|-----------|-------------|
| `WorkerDispatcher` | Worker implements `WorkerHandler` type signature `(item: QueueItem) => Promise<void>` |
| `server.ts` | Replace placeholder handler with `new ClaudeCliWorker(config).handle` |
| `DispatchConfig` | Extend with worker-specific config (phase timeout, workspace dir, test command) |
| `WORKFLOW_LABELS` | Import label constants for phase/completed/waiting-for labels |
| `createGitHubClient` | Used for label operations and stage comment management |
| SSE `events.ts` | Emit `workflow:started`, `step:started`, `step:completed`, `workflow:completed/failed` events |
| `SubscriptionManager` | Route SSE events to connected dashboard clients |

## Config Schema Extension

Add to `DispatchConfig` (or create `WorkerConfig`):

```typescript
const WorkerConfigSchema = z.object({
  /** Timeout per phase in milliseconds */
  phaseTimeoutMs: z.number().int().min(60000).default(600000),
  /** Base workspace directory for checkouts */
  workspaceDir: z.string().default('/tmp/orchestrator-workspaces'),
  /** Grace period for SIGTERM before SIGKILL */
  shutdownGracePeriodMs: z.number().int().min(1000).default(5000),
  /** Test command for validate phase */
  validateCommand: z.string().default('pnpm test && pnpm build'),
  /** Max turns for Claude CLI */
  maxTurns: z.number().int().min(10).default(100),
  /** Gate configuration per workflow type */
  gates: z.record(z.string(), z.array(GateDefinitionSchema)).default({
    'speckit-feature': [
      { phase: 'clarify', gate: 'waiting-for:clarification', condition: 'always' },
    ],
    'speckit-bugfix': [],
  }),
});
```

## Phase Flow

```
process command → PhaseResolver → starting phase
                                       │
                                       ▼
                          ┌──── PhaseLoop ────────┐
                          │                       │
                          │  for each phase:       │
                          │    1. Add phase:X label │
                          │    2. Spawn Claude CLI  │
                          │    3. Capture output    │
                          │    4. Add completed:X   │
                          │    5. Check gates       │
                          │    6. Update stage comment │
                          │                        │
                          │  Until:                │
                          │    - Gate hit → exit   │
                          │    - All done → exit   │
                          │    - Error → throw     │
                          └────────────────────────┘
```

## Error Handling Strategy

| Scenario | Response |
|----------|----------|
| Claude CLI exits non-zero | Add `agent:error` label, post error comment, re-throw for dispatcher retry |
| Phase timeout (10 min) | SIGTERM → 5s grace → SIGKILL, then same as crash |
| GitHub API error | Exponential backoff (3 attempts) for label/comment operations |
| Repo checkout failure | Log error, add `agent:error`, re-throw |
| Gate detected | Add `waiting-for:*` + `agent:paused`, remove `phase:*`, return cleanly |
| Abort signal from dispatcher | SIGTERM to CLI process, clean up labels, return |

## Dependencies (external packages)

No new external dependencies needed. Uses:
- `node:child_process` (built-in) for spawning Claude CLI
- Existing `@generacy-ai/workflow-engine` for `createGitHubClient` and `WORKFLOW_LABELS`
- Existing `ioredis` connection (passed from server)
- Existing `pino` logger (passed from server)

---

*Generated by speckit*

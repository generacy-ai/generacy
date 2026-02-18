# Data Model: Claude CLI Worker with Phase Loop

## Core Types

### WorkerConfig

```typescript
interface WorkerConfig {
  /** Timeout per phase in milliseconds (default: 600000 = 10 min) */
  phaseTimeoutMs: number;
  /** Base workspace directory for per-worker checkouts */
  workspaceDir: string;
  /** Grace period for SIGTERM before SIGKILL (default: 5000) */
  shutdownGracePeriodMs: number;
  /** Test command for validate phase (default: "pnpm test && pnpm build") */
  validateCommand: string;
  /** Max turns for Claude CLI (default: 100) */
  maxTurns: number;
  /** Gate definitions per workflow type */
  gates: Record<string, GateDefinition[]>;
}
```

### GateDefinition

```typescript
interface GateDefinition {
  /** Phase that triggers gate check */
  phase: WorkflowPhase;
  /** Label to add when gate is active (e.g., "waiting-for:clarification") */
  gateLabel: string;
  /** When to activate the gate */
  condition: 'always' | 'on-questions' | 'on-failure';
}
```

### WorkflowPhase

```typescript
type WorkflowPhase = 'specify' | 'clarify' | 'plan' | 'tasks' | 'implement' | 'validate';

const PHASE_SEQUENCE: WorkflowPhase[] = [
  'specify', 'clarify', 'plan', 'tasks', 'implement', 'validate'
];

const PHASE_TO_COMMAND: Record<WorkflowPhase, string | null> = {
  specify: '/speckit:specify',
  clarify: '/speckit:clarify',
  plan: '/speckit:plan',
  tasks: '/speckit:tasks',
  implement: '/speckit:implement',
  validate: null, // Runs test command instead
};

const PHASE_TO_STAGE: Record<WorkflowPhase, StageType> = {
  specify: 'specification',
  clarify: 'specification',
  plan: 'planning',
  tasks: 'planning',
  implement: 'implementation',
  validate: 'implementation',
};
```

### PhaseResult

```typescript
interface PhaseResult {
  /** Phase that was executed */
  phase: WorkflowPhase;
  /** Whether the phase completed successfully */
  success: boolean;
  /** CLI exit code (0 = success) */
  exitCode: number;
  /** Duration in milliseconds */
  durationMs: number;
  /** Captured output chunks */
  output: OutputChunk[];
  /** Whether a gate was hit (stops the loop) */
  gateHit?: {
    gateLabel: string;
    reason: string;
  };
  /** Error details if failed */
  error?: {
    message: string;
    stderr: string;
    phase: WorkflowPhase;
  };
}
```

### WorkerContext

```typescript
interface WorkerContext {
  /** Worker ID from dispatcher (UUID) */
  workerId: string;
  /** Queue item being processed */
  item: QueueItem;
  /** Resolved starting phase */
  startPhase: WorkflowPhase;
  /** GitHub client for API operations */
  github: Octokit;
  /** Logger instance */
  logger: Logger;
  /** Abort signal for graceful shutdown */
  signal: AbortSignal;
  /** Repository checkout path */
  checkoutPath: string;
  /** Issue URL for prompts */
  issueUrl: string;
}
```

### StageComment

```typescript
type StageType = 'specification' | 'planning' | 'implementation';

interface StageCommentData {
  /** Stage type */
  stage: StageType;
  /** Current status */
  status: 'in_progress' | 'complete' | 'error';
  /** Phase progress within the stage */
  phases: {
    phase: WorkflowPhase;
    status: 'pending' | 'in_progress' | 'complete' | 'error';
    startedAt?: string;
    completedAt?: string;
  }[];
  /** When the stage started */
  startedAt: string;
  /** When the stage completed */
  completedAt?: string;
  /** PR URL if available */
  prUrl?: string;
}

const STAGE_MARKERS: Record<StageType, string> = {
  specification: '<!-- generacy-stage:specification -->',
  planning: '<!-- generacy-stage:planning -->',
  implementation: '<!-- generacy-stage:implementation -->',
};
```

### OutputChunk

```typescript
interface OutputChunk {
  /** Event type from Claude CLI JSON output */
  type: 'init' | 'tool_use' | 'tool_result' | 'text' | 'complete' | 'error';
  /** Parsed JSON data */
  data: unknown;
  /** Metadata (e.g., filePath for tool_result) */
  metadata?: Record<string, string>;
  /** Timestamp */
  timestamp: string;
}
```

### CliSpawnOptions

```typescript
interface CliSpawnOptions {
  /** The speckit command prompt */
  prompt: string;
  /** Working directory (repo checkout) */
  cwd: string;
  /** Environment variables to pass */
  env: Record<string, string>;
  /** Maximum turns */
  maxTurns: number;
  /** Timeout in milliseconds */
  timeoutMs: number;
  /** Abort signal for graceful shutdown */
  signal: AbortSignal;
}
```

## Relationships

```
QueueItem (from dispatcher)
  └─ WorkerContext (built by ClaudeCliWorker)
       ├─ PhaseResolver → WorkflowPhase (starting phase)
       ├─ PhaseLoop
       │    ├─ CliSpawner → CliSpawnOptions → PhaseResult
       │    ├─ LabelManager → GitHub API (label CRUD)
       │    ├─ StageCommentManager → StageCommentData → GitHub API (comment CRUD)
       │    └─ GateChecker → GateDefinition[] → gate hit or null
       └─ OutputCapture → OutputChunk[] → SSE events
```

## Validation Rules

- `phaseTimeoutMs` must be >= 60000 (1 minute minimum)
- `workspaceDir` must be an absolute path
- `maxTurns` must be >= 10
- `gates` keys must be valid workflow names (e.g., "speckit-feature", "speckit-bugfix")
- `GateDefinition.gateLabel` must match a label in `WORKFLOW_LABELS`
- `WorkflowPhase` values must be from the `PHASE_SEQUENCE` enum

---

*Generated by speckit*

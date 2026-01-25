# Data Model: @generacy-ai/generacy

Core entities, interfaces, and type definitions for the headless workflow execution package.

## Core Entities

### Workflow Definition

```typescript
/**
 * Complete workflow definition loaded from YAML file
 */
interface WorkflowDefinition {
  name: string;
  version: string;
  description?: string;
  inputs?: InputDefinition[];
  phases: PhaseDefinition[];
  outputs?: OutputDefinition[];
}

interface InputDefinition {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'object';
  required: boolean;
  default?: unknown;
  description?: string;
}

interface PhaseDefinition {
  id: string;
  name: string;
  steps: StepDefinition[];
  condition?: string; // Expression evaluated at runtime
}

interface StepDefinition {
  id: string;
  name: string;
  uses?: string;      // Action type: 'workspace.prepare', 'agent.invoke', etc.
  action?: string;    // Alternative to 'uses'
  with?: Record<string, unknown>; // Action parameters
  condition?: string;
  timeout?: string;   // Duration: '5m', '30s', etc.
  retry?: RetryConfig;
  outputs?: Record<string, string>; // Output variable mapping
}

interface OutputDefinition {
  name: string;
  value: string; // Interpolation expression
}
```

### Execution State

```typescript
/**
 * Runtime workflow instance with resolved values
 */
interface ExecutableWorkflow extends WorkflowDefinition {
  id: string;           // Unique execution ID
  startedAt: Date;
  inputs: Record<string, unknown>; // Resolved input values
}

/**
 * Execution result returned after workflow completes
 */
interface ExecutionResult {
  workflowId: string;
  status: ExecutionStatus;
  startedAt: Date;
  completedAt: Date;
  duration: number;     // Milliseconds
  outputs: Record<string, unknown>;
  error?: ExecutionError;
  phases: PhaseResult[];
}

type ExecutionStatus =
  | 'idle'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';

interface PhaseResult {
  phaseId: string;
  status: ExecutionStatus;
  startedAt: Date;
  completedAt?: Date;
  steps: StepResult[];
}

interface StepResult {
  stepId: string;
  status: ExecutionStatus;
  startedAt: Date;
  completedAt?: Date;
  duration: number;
  output?: unknown;
  error?: ExecutionError;
  retries: number;
}

interface ExecutionError {
  code: string;
  message: string;
  stack?: string;
  context?: Record<string, unknown>;
}
```

### Action System

```typescript
/**
 * Handler for a specific action type
 */
interface ActionHandler {
  /** Action type identifier (e.g., 'workspace.prepare') */
  type: string;

  /** Check if this handler can process the given step */
  canHandle(step: StepDefinition): boolean;

  /** Execute the action */
  execute(step: StepDefinition, context: ActionContext): Promise<ActionResult>;

  /** Validate step configuration (optional) */
  validate?(step: StepDefinition): ValidationResult;
}

/**
 * Context provided to action handlers
 */
interface ActionContext {
  workflow: ExecutableWorkflow;
  phase: PhaseDefinition;
  step: StepDefinition;
  inputs: Record<string, unknown>;
  stepOutputs: Map<string, StepOutput>;
  env: Record<string, string>;
  workdir: string;
  signal: AbortSignal;
  logger: Logger;
}

interface StepOutput {
  stepId: string;
  status: ExecutionStatus;
  output: unknown;
  exitCode?: number;
}

interface ActionResult {
  status: 'success' | 'failure' | 'skipped';
  output?: unknown;
  error?: ExecutionError;
  duration: number;
}

interface ValidationResult {
  valid: boolean;
  errors?: string[];
}
```

### Retry Configuration

```typescript
/**
 * Retry behavior for failed steps
 */
interface RetryConfig {
  maxAttempts: number;    // Default: 1 (no retry)
  backoff: BackoffStrategy;
  maxDelay?: string;      // Maximum delay cap
  retryOn?: string[];     // Error codes to retry
}

type BackoffStrategy =
  | { type: 'constant'; delay: string }
  | { type: 'linear'; initialDelay: string; increment: string }
  | { type: 'exponential'; initialDelay: string; multiplier: number; jitter?: boolean };
```

### Orchestrator Types

```typescript
/**
 * Worker registration with orchestrator
 */
interface WorkerRegistration {
  workerId: string;
  capabilities: string[];  // Action types this worker can handle
  version: string;
  startedAt: Date;
}

/**
 * Job received from orchestrator queue
 */
interface Job {
  id: string;
  workflowDefinition: WorkflowDefinition;
  inputs: Record<string, unknown>;
  priority: number;
  createdAt: Date;
  assignedAt: Date;
  metadata?: JobMetadata;
}

interface JobMetadata {
  source: string;        // 'github-issue', 'api', 'scheduled'
  sourceId?: string;     // Issue URL, etc.
  requestedBy?: string;
  tags?: string[];
}

type JobStatus =
  | 'queued'
  | 'assigned'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';

interface JobResult {
  status: 'completed' | 'failed' | 'cancelled';
  executionResult?: ExecutionResult;
  error?: ExecutionError;
}

/**
 * Heartbeat payload sent periodically to orchestrator
 */
interface Heartbeat {
  workerId: string;
  status: 'idle' | 'busy' | 'unhealthy';
  currentJob?: string;
  uptime: number;
  timestamp: Date;
}
```

### Agency Integration

```typescript
/**
 * Connection to Agency MCP server
 */
interface AgencyConnection {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;

  /** Call an MCP tool */
  callTool(name: string, args: Record<string, unknown>): Promise<ToolResult>;

  /** List available tools */
  listTools(): Promise<ToolDefinition[]>;
}

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: object; // JSON Schema
}

interface ToolResult {
  success: boolean;
  output?: unknown;
  error?: string;
}

/**
 * Subprocess mode configuration
 */
interface SubprocessConfig {
  command: string;       // 'npx', 'node', etc.
  args: string[];        // ['@generacy-ai/agency', 'serve']
  cwd?: string;
  env?: Record<string, string>;
}

/**
 * Network mode configuration
 */
interface NetworkConfig {
  url: string;           // http://localhost:3000
  apiKey?: string;
  timeout?: number;
}
```

### Logger Interface

```typescript
/**
 * Abstracted logger interface (implementation: Pino)
 */
interface Logger {
  info(message: string, ...args: unknown[]): void;
  info(obj: object, message?: string): void;

  warn(message: string, ...args: unknown[]): void;
  warn(obj: object, message?: string): void;

  error(message: string, ...args: unknown[]): void;
  error(obj: object, message?: string): void;

  debug(message: string, ...args: unknown[]): void;
  debug(obj: object, message?: string): void;

  child(bindings: object): Logger;
}

type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';
```

### CLI Configuration

```typescript
/**
 * Configuration resolved from CLI args, env vars, and config file
 */
interface CLIConfig {
  // Logging
  logLevel: LogLevel;
  logFormat: 'json' | 'pretty';

  // Orchestrator
  orchestratorUrl?: string;
  workerId?: string;
  pollInterval: number;    // Milliseconds

  // Agency
  agencyMode: 'subprocess' | 'network';
  agencyUrl?: string;
  agencyCommand?: string;

  // Health check
  healthPort?: number;

  // Execution
  workdir: string;
  timeout: number;
  dryRun: boolean;
}

/**
 * CLI command options
 */
interface RunOptions {
  input?: string[];        // key=value pairs
  workdir?: string;
  timeout?: string;
  dryRun?: boolean;
  logLevel?: LogLevel;
}

interface WorkerOptions {
  orchestrator: string;
  id?: string;
  healthPort?: number;
  pollInterval?: number;
  logLevel?: LogLevel;
}

interface AgentOptions extends WorkerOptions {
  agencyMode?: 'subprocess' | 'network';
  agencyUrl?: string;
}
```

## Relationships

```
┌─────────────────────┐     ┌─────────────────────┐
│  WorkflowDefinition │────>│    PhaseDefinition  │
│  - name             │     │    - id             │
│  - inputs[]         │     │    - steps[]        │
│  - phases[]         │     │    - condition      │
└─────────────────────┘     └──────────┬──────────┘
                                       │
                                       ▼
                            ┌─────────────────────┐
                            │   StepDefinition    │
                            │   - id              │
                            │   - uses/action     │
                            │   - with{}          │
                            │   - retry           │
                            └──────────┬──────────┘
                                       │
                                       ▼
                            ┌─────────────────────┐
                            │   ActionHandler     │
                            │   - type            │
                            │   - execute()       │
                            └─────────────────────┘
```

```
┌─────────────────────┐     ┌─────────────────────┐
│  OrchestratorClient │────>│        Job          │
│  - register()       │     │   - id              │
│  - pollForJob()     │     │   - workflow        │
│  - reportResult()   │     │   - inputs          │
└─────────────────────┘     └──────────┬──────────┘
                                       │
                                       ▼
                            ┌─────────────────────┐
                            │  WorkflowExecutor   │
                            │  - execute()        │
                            │  - cancel()         │
                            └──────────┬──────────┘
                                       │
                                       ▼
                            ┌─────────────────────┐
                            │   ExecutionResult   │
                            │   - status          │
                            │   - outputs         │
                            │   - phases[]        │
                            └─────────────────────┘
```

## Validation Rules

### Workflow Definition
- `name` must be non-empty string
- `version` should follow semver format
- `phases` must have at least one phase
- Phase `id` must be unique within workflow
- Step `id` must be unique within phase

### Step Definition
- Either `uses` or `action` must be specified
- `timeout` must be valid duration format (e.g., '5m', '30s')
- `retry.maxAttempts` must be >= 1
- `condition` must be valid expression syntax

### Input Definition
- `name` must be valid identifier (alphanumeric + underscore)
- `default` must match declared `type`
- Required inputs without defaults must be provided at runtime

### Orchestrator Communication
- `workerId` must be unique per worker instance
- Heartbeat interval should be < orchestrator timeout (typically 30s)
- Job IDs are UUIDs generated by orchestrator

---

*Generated by speckit*

# Data Model: Generacy VS Code Extension

## Core Entities

### Workflow

Represents a workflow definition file.

```typescript
interface Workflow {
  /** Unique identifier (file path relative to workspace) */
  id: string;

  /** Display name (from YAML or filename) */
  name: string;

  /** Absolute file path */
  filePath: string;

  /** Workflow content parsed from YAML */
  content: WorkflowContent;

  /** Last modified timestamp */
  lastModified: Date;

  /** Validation status */
  status: 'valid' | 'invalid' | 'unknown';

  /** Validation errors if any */
  errors?: ValidationError[];
}

interface WorkflowContent {
  /** Workflow version */
  version: string;

  /** Workflow metadata */
  metadata: {
    name: string;
    description?: string;
    author?: string;
    tags?: string[];
  };

  /** Trigger configuration */
  triggers?: TriggerConfig[];

  /** Workflow phases */
  phases: Phase[];

  /** Variables and secrets */
  variables?: Record<string, VariableDefinition>;
}

interface Phase {
  id: string;
  name: string;
  description?: string;
  steps: Step[];
  condition?: string;
}

interface Step {
  id: string;
  name: string;
  action: string;
  inputs?: Record<string, any>;
  outputs?: string[];
  timeout?: number;
  retries?: number;
}
```

### Debug Session

Represents an active debugging session.

```typescript
interface DebugSession {
  /** Session identifier */
  id: string;

  /** Workflow being debugged */
  workflow: Workflow;

  /** Current execution state */
  state: 'running' | 'paused' | 'stopped';

  /** Current execution position */
  currentPosition: ExecutionPosition;

  /** Breakpoints */
  breakpoints: Breakpoint[];

  /** Variable values at current position */
  variables: Map<string, any>;

  /** Execution history */
  history: ExecutionEvent[];
}

interface ExecutionPosition {
  phaseId: string;
  stepId: string;
  line?: number;
}

interface Breakpoint {
  id: string;
  filePath: string;
  position: ExecutionPosition;
  enabled: boolean;
  condition?: string;
}

interface ExecutionEvent {
  timestamp: Date;
  type: 'phase_start' | 'phase_end' | 'step_start' | 'step_end' | 'error';
  position: ExecutionPosition;
  data?: any;
}
```

### Organization (Cloud Mode)

```typescript
interface Organization {
  /** Organization ID */
  id: string;

  /** Display name */
  name: string;

  /** Organization slug */
  slug: string;

  /** Subscription tier */
  tier: 'starter' | 'team' | 'enterprise';

  /** Member count */
  memberCount: number;

  /** Current usage */
  usage: OrgUsage;

  /** Integrations */
  integrations: Integration[];
}

interface OrgUsage {
  /** Current period */
  period: { start: Date; end: Date };

  /** Agent hours used */
  agentHours: number;

  /** Agent hours limit */
  agentHoursLimit: number;

  /** Concurrent agents currently running */
  concurrentAgents: number;

  /** Concurrent agent limit */
  concurrentLimit: number;
}

interface OrgMember {
  id: string;
  email: string;
  name: string;
  avatar?: string;
  role: 'owner' | 'admin' | 'member';
  joinedAt: Date;
}
```

### Queue Item (Cloud Mode)

```typescript
interface QueueItem {
  /** Queue item ID */
  id: string;

  /** Workflow being executed */
  workflowId: string;
  workflowName: string;

  /** Execution status */
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

  /** Priority (1-5, 1 being highest) */
  priority: number;

  /** Assignee (agent or user) */
  assignee?: {
    type: 'agent' | 'user';
    id: string;
    name: string;
  };

  /** Repository context */
  repository?: {
    owner: string;
    name: string;
    branch: string;
  };

  /** Timestamps */
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;

  /** Current step */
  currentStep?: string;

  /** Progress percentage */
  progress?: number;

  /** Error if failed */
  error?: {
    message: string;
    step?: string;
    details?: string;
  };
}
```

### Integration (Cloud Mode)

```typescript
interface Integration {
  /** Integration type */
  type: 'github' | 'jira' | 'slack' | 'webhook';

  /** Integration ID */
  id: string;

  /** Display name */
  name: string;

  /** Connection status */
  status: 'connected' | 'disconnected' | 'error';

  /** Last sync timestamp */
  lastSync?: Date;

  /** Configuration */
  config: IntegrationConfig;

  /** Error details if status is error */
  error?: string;
}

type IntegrationConfig =
  | GitHubIntegrationConfig
  | JiraIntegrationConfig
  | SlackIntegrationConfig
  | WebhookIntegrationConfig;

interface GitHubIntegrationConfig {
  type: 'github';
  appInstallationId: string;
  repositories: string[];
  permissions: string[];
}

interface WebhookIntegrationConfig {
  type: 'webhook';
  url: string;
  events: string[];
  secret?: string;
}
```

### Published Workflow (Cloud Mode)

```typescript
interface PublishedWorkflow {
  /** Cloud workflow ID */
  id: string;

  /** Original workflow path */
  localPath: string;

  /** Current published version */
  currentVersion: string;

  /** Version history */
  versions: WorkflowVersion[];

  /** Sync status */
  syncStatus: 'synced' | 'local_changes' | 'cloud_changes' | 'conflict';

  /** Last published timestamp */
  lastPublished: Date;
}

interface WorkflowVersion {
  version: string;
  publishedAt: Date;
  publishedBy: string;
  changelog?: string;
  content: WorkflowContent;
}
```

## Validation Rules

### Workflow Validation

```typescript
const WorkflowSchema = z.object({
  version: z.string().regex(/^\d+\.\d+$/),
  metadata: z.object({
    name: z.string().min(1).max(100),
    description: z.string().max(500).optional(),
    author: z.string().optional(),
    tags: z.array(z.string()).optional(),
  }),
  triggers: z.array(TriggerSchema).optional(),
  phases: z.array(PhaseSchema).min(1),
  variables: z.record(VariableSchema).optional(),
});

const PhaseSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_-]*$/i),
  name: z.string().min(1),
  description: z.string().optional(),
  steps: z.array(StepSchema).min(1),
  condition: z.string().optional(),
});

const StepSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_-]*$/i),
  name: z.string().min(1),
  action: z.string().min(1),
  inputs: z.record(z.any()).optional(),
  outputs: z.array(z.string()).optional(),
  timeout: z.number().positive().optional(),
  retries: z.number().int().min(0).max(10).optional(),
});
```

### Validation Error Structure

```typescript
interface ValidationError {
  /** Error code for programmatic handling */
  code: string;

  /** Human-readable message */
  message: string;

  /** Location in the file */
  location: {
    line: number;
    column: number;
    path: string;  // JSON path e.g., "phases[0].steps[1].action"
  };

  /** Severity */
  severity: 'error' | 'warning' | 'info';

  /** Suggested fix if available */
  fix?: {
    description: string;
    replacement: string;
  };
}
```

## Entity Relationships

```
┌─────────────────────────────────────────────────────────────────────┐
│                           LOCAL MODE                                 │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│   Workflow ─────────────────────────┐                               │
│      │                              │                               │
│      ▼                              ▼                               │
│   Phase ────────────► Step      DebugSession                        │
│      │                  │           │                               │
│      │                  │           ▼                               │
│      └──────────────────┴───► Breakpoint                            │
│                                     │                               │
│                                     ▼                               │
│                              ExecutionEvent                         │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                           CLOUD MODE                                 │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│   Organization ◄───────────────────┐                                │
│      │                             │                                │
│      ├──────────► OrgMember        │                                │
│      │                             │                                │
│      ├──────────► Integration      │                                │
│      │                             │                                │
│      └──────────► QueueItem ───────┤                                │
│                      │             │                                │
│                      ▼             │                                │
│              PublishedWorkflow ────┘                                │
│                      │                                              │
│                      ▼                                              │
│              WorkflowVersion                                        │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                        SYNC RELATIONSHIP                             │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│   Workflow (local) ◄─────sync─────► PublishedWorkflow (cloud)       │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

## State Transitions

### Workflow Lifecycle

```
[Not Exists] ──create──► [Draft] ──validate──► [Valid]
                            │                     │
                            ◄─────edit────────────┘
                            │
                            ──validate──► [Invalid] ──fix──► [Draft]
```

### Queue Item Lifecycle

```
[Created] ──enqueue──► [Pending] ──start──► [Running] ──complete──► [Completed]
                          │                    │
                          │                    ├──fail──► [Failed]
                          │                    │
                          └──cancel────────────┴──cancel──► [Cancelled]
```

### Debug Session Lifecycle

```
[Not Started] ──launch──► [Running] ──breakpoint──► [Paused]
                             │                         │
                             │                    ──continue──►
                             │                         │
                             ◄─────────────────────────┘
                             │
                             ──stop──► [Stopped]
```

---

*Generated by speckit*

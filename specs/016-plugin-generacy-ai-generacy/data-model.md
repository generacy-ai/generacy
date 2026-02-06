# Data Model: GitHub Actions Plugin

## Core Entities

### Configuration

```typescript
/**
 * Plugin configuration
 */
interface GitHubActionsConfig {
  /** Repository owner (user or organization) */
  owner: string;

  /** Repository name */
  repo: string;

  /** GitHub Personal Access Token */
  token: string;

  /** Named workflows for common operations */
  workflows?: {
    ci?: string;      // e.g., "ci.yml"
    deploy?: string;  // e.g., "deploy.yml"
    test?: string;    // e.g., "test.yml"
  };

  /** Polling configuration */
  polling?: {
    interval?: number;      // ms, default: 10000
    maxAttempts?: number;   // default: 60
  };
}
```

### Workflow Run

```typescript
/**
 * Represents a GitHub Actions workflow run
 */
interface WorkflowRun {
  /** Unique run ID */
  id: number;

  /** Workflow name */
  name: string;

  /** Workflow filename */
  path: string;

  /** Git reference (branch/tag) */
  head_branch: string;

  /** Commit SHA */
  head_sha: string;

  /** Current status */
  status: WorkflowStatus;

  /** Final conclusion (when completed) */
  conclusion: WorkflowConclusion | null;

  /** Workflow URL */
  html_url: string;

  /** Timestamps */
  created_at: string;
  updated_at: string;
  run_started_at: string | null;

  /** Actor who triggered the run */
  actor: User;

  /** Triggering event */
  event: string;

  /** Run attempt number */
  run_attempt: number;
}

type WorkflowStatus = 'queued' | 'in_progress' | 'completed';

type WorkflowConclusion =
  | 'success'
  | 'failure'
  | 'neutral'
  | 'cancelled'
  | 'skipped'
  | 'timed_out'
  | 'action_required'
  | null;
```

### Job

```typescript
/**
 * Represents a job within a workflow run
 */
interface Job {
  /** Unique job ID */
  id: number;

  /** Parent run ID */
  run_id: number;

  /** Job name */
  name: string;

  /** Current status */
  status: JobStatus;

  /** Final conclusion (when completed) */
  conclusion: JobConclusion | null;

  /** Steps within the job */
  steps: Step[];

  /** Timestamps */
  started_at: string | null;
  completed_at: string | null;

  /** Runner information */
  runner_id: number | null;
  runner_name: string | null;
}

type JobStatus = 'queued' | 'in_progress' | 'completed';
type JobConclusion = 'success' | 'failure' | 'cancelled' | 'skipped' | null;

/**
 * Represents a step within a job
 */
interface Step {
  /** Step name */
  name: string;

  /** Step status */
  status: StepStatus;

  /** Step conclusion */
  conclusion: StepConclusion | null;

  /** Step number (1-indexed) */
  number: number;

  /** Timestamps */
  started_at: string | null;
  completed_at: string | null;
}

type StepStatus = 'queued' | 'in_progress' | 'completed';
type StepConclusion = 'success' | 'failure' | 'cancelled' | 'skipped' | null;
```

### Artifact

```typescript
/**
 * Represents a workflow artifact
 */
interface Artifact {
  /** Unique artifact ID */
  id: number;

  /** Artifact name */
  name: string;

  /** Size in bytes */
  size_in_bytes: number;

  /** Download URL */
  archive_download_url: string;

  /** Whether artifact has expired */
  expired: boolean;

  /** Timestamps */
  created_at: string;
  expires_at: string;
}
```

### Check Run

```typescript
/**
 * Represents a GitHub Check Run
 */
interface CheckRun {
  /** Unique check run ID */
  id: number;

  /** Check name */
  name: string;

  /** HEAD SHA */
  head_sha: string;

  /** External ID for correlation */
  external_id?: string;

  /** Status */
  status: CheckStatus;

  /** Conclusion (when completed) */
  conclusion: CheckConclusion | null;

  /** Details URL */
  details_url?: string;

  /** Output displayed in GitHub UI */
  output?: CheckOutput;

  /** Timestamps */
  started_at?: string;
  completed_at?: string;
}

type CheckStatus = 'queued' | 'in_progress' | 'completed';
type CheckConclusion =
  | 'success'
  | 'failure'
  | 'neutral'
  | 'cancelled'
  | 'skipped'
  | 'timed_out'
  | 'action_required'
  | null;

interface CheckOutput {
  title: string;
  summary: string;
  text?: string;
  annotations?: CheckAnnotation[];
}

interface CheckAnnotation {
  path: string;
  start_line: number;
  end_line: number;
  start_column?: number;
  end_column?: number;
  annotation_level: 'notice' | 'warning' | 'failure';
  message: string;
  title?: string;
  raw_details?: string;
}
```

### User

```typescript
/**
 * GitHub user information
 */
interface User {
  /** User ID */
  id: number;

  /** Username */
  login: string;

  /** Avatar URL */
  avatar_url: string;

  /** User type */
  type: 'User' | 'Bot';
}
```

## Event Types

```typescript
/**
 * Events emitted via EventBus facet
 */
interface WorkflowCompletedEvent {
  type: 'workflow.completed';
  runId: number;
  workflow: string;
  conclusion: WorkflowConclusion;
  duration: number;  // ms
  url: string;
}

interface WorkflowFailedEvent {
  type: 'workflow.failed';
  runId: number;
  workflow: string;
  error: string;
  failedJobs: string[];
  url: string;
}

interface CheckRunCompletedEvent {
  type: 'check_run.completed';
  checkRunId: number;
  name: string;
  conclusion: CheckConclusion;
  headSha: string;
}

type PluginEvent =
  | WorkflowCompletedEvent
  | WorkflowFailedEvent
  | CheckRunCompletedEvent;
```

## Input Parameter Types

```typescript
/**
 * Parameters for triggering a workflow
 */
interface TriggerWorkflowParams {
  /** Workflow filename or ID */
  workflow: string;

  /** Git ref (branch/tag), defaults to default branch */
  ref?: string;

  /** Workflow inputs */
  inputs?: Record<string, string>;
}

/**
 * Parameters for creating a check run
 */
interface CreateCheckRunParams {
  /** Check name */
  name: string;

  /** HEAD SHA to attach check to */
  head_sha: string;

  /** External ID for correlation */
  external_id?: string;

  /** Details URL */
  details_url?: string;

  /** Initial status */
  status?: CheckStatus;

  /** Initial output */
  output?: CheckOutput;
}

/**
 * Parameters for updating a check run
 */
interface UpdateCheckRunParams {
  /** Updated status */
  status?: CheckStatus;

  /** Conclusion (required when status is 'completed') */
  conclusion?: CheckConclusion;

  /** Updated output */
  output?: CheckOutput;

  /** Completion timestamp */
  completed_at?: string;
}
```

## Validation Rules

1. **Configuration**:
   - `owner` and `repo` must be non-empty strings
   - `token` must be a valid GitHub PAT
   - `polling.interval` must be >= 1000ms
   - `polling.maxAttempts` must be >= 1

2. **Workflow Trigger**:
   - `workflow` must be a valid filename or numeric ID
   - `inputs` keys must match workflow input definitions

3. **Check Run**:
   - `head_sha` must be a valid 40-character SHA
   - `conclusion` is required when `status` is `'completed'`

## Relationships

```
GitHubActionsConfig
    │
    └── GitHubActionsPlugin
            │
            ├── WorkflowOperations
            │       └── WorkflowRun (1:many)
            │               └── Job (1:many)
            │                       └── Step (1:many)
            │
            ├── ArtifactOperations
            │       └── Artifact (from WorkflowRun)
            │
            ├── CheckRunOperations
            │       └── CheckRun (1:many per commit)
            │
            └── StatusPoller
                    └── emits PluginEvent → EventBus
```

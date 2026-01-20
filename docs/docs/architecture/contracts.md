---
sidebar_position: 2
---

# Contracts and Schemas

This document describes the data contracts and schemas used throughout the Generacy ecosystem.

## Overview

Generacy uses typed contracts to ensure consistent communication between components. All contracts are defined in the `@generacy-ai/contracts` package.

## Core Entities

### Job

Represents a unit of work in the system.

```typescript
interface Job {
  id: string;
  type: string;
  status: JobStatus;
  data: Record<string, unknown>;
  priority: JobPriority;
  attempts: number;
  maxAttempts: number;
  createdAt: Date;
  updatedAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  failedAt?: Date;
  result?: unknown;
  error?: string;
  workerId?: string;
}

type JobStatus = 'pending' | 'active' | 'completed' | 'failed' | 'delayed';
type JobPriority = 'low' | 'normal' | 'high' | 'critical';
```

### Workflow

Defines a multi-step process.

```typescript
interface Workflow {
  id: string;
  name: string;
  version: string;
  description?: string;
  triggers: WorkflowTrigger[];
  stages: WorkflowStage[];
  env?: Record<string, string>;
  timeout?: string;
}

interface WorkflowTrigger {
  type: 'webhook' | 'schedule' | 'command' | 'event';
  config: Record<string, unknown>;
}

interface WorkflowStage {
  id: string;
  name: string;
  steps: WorkflowStep[];
  parallel?: boolean;
}

interface WorkflowStep {
  id: string;
  type: 'action' | 'gate' | 'condition';
  config: Record<string, unknown>;
  requires?: string[];
  timeout?: string;
}
```

### WorkflowRun

An execution instance of a workflow.

```typescript
interface WorkflowRun {
  id: string;
  workflowId: string;
  workflowVersion: string;
  status: WorkflowRunStatus;
  currentStage?: string;
  currentStep?: string;
  inputs: Record<string, unknown>;
  outputs: Record<string, unknown>;
  context: WorkflowContext;
  startedAt: Date;
  completedAt?: Date;
  error?: string;
}

type WorkflowRunStatus =
  | 'pending'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';

interface WorkflowContext {
  triggeredBy: string;
  source: string;
  env: Record<string, string>;
  steps: Record<string, StepResult>;
}
```

### ReviewGate

A human review checkpoint.

```typescript
interface ReviewGate {
  id: string;
  workflowRunId: string;
  stepId: string;
  title: string;
  description?: string;
  status: GateStatus;
  reviewers: string[];
  requiredApprovals: number;
  approvals: Approval[];
  rejections: Rejection[];
  createdAt: Date;
  timeout?: Date;
  resolvedAt?: Date;
  resolvedBy?: string;
}

type GateStatus = 'pending' | 'approved' | 'rejected' | 'timeout' | 'skipped';

interface Approval {
  reviewer: string;
  approvedAt: Date;
  comment?: string;
}

interface Rejection {
  reviewer: string;
  rejectedAt: Date;
  reason: string;
}
```

## Tool Contracts

### Tool Definition

```typescript
interface ToolDefinition {
  name: string;
  description: string;
  version?: string;
  schema: JSONSchema;
  examples?: ToolExample[];
  timeout?: string;
  dangerous?: boolean;
}

interface ToolExample {
  description: string;
  params: Record<string, unknown>;
  result?: unknown;
}
```

### Tool Result

```typescript
interface ToolResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  metadata?: {
    duration: number;
    cached?: boolean;
  };
}
```

## Event Contracts

### Webhook Events

```typescript
interface WebhookEvent {
  id: string;
  type: string;
  source: string;
  timestamp: Date;
  data: Record<string, unknown>;
  signature?: string;
}

// GitHub events
interface GitHubIssueEvent extends WebhookEvent {
  type: 'github.issues';
  data: {
    action: 'opened' | 'edited' | 'closed' | 'assigned';
    issue: GitHubIssue;
    repository: GitHubRepository;
    sender: GitHubUser;
  };
}

interface GitHubPullRequestEvent extends WebhookEvent {
  type: 'github.pull_request';
  data: {
    action: 'opened' | 'closed' | 'merged' | 'review_requested';
    pull_request: GitHubPullRequest;
    repository: GitHubRepository;
    sender: GitHubUser;
  };
}
```

### Internal Events

```typescript
interface InternalEvent {
  id: string;
  type: string;
  timestamp: Date;
  source: string;
  correlationId?: string;
  data: Record<string, unknown>;
}

// Job events
interface JobEvent extends InternalEvent {
  type: 'job.created' | 'job.started' | 'job.completed' | 'job.failed';
  data: {
    jobId: string;
    jobType: string;
    result?: unknown;
    error?: string;
  };
}

// Gate events
interface GateEvent extends InternalEvent {
  type: 'gate.created' | 'gate.approved' | 'gate.rejected' | 'gate.timeout';
  data: {
    gateId: string;
    workflowRunId: string;
    reviewer?: string;
    comment?: string;
    reason?: string;
  };
}
```

## Configuration Contracts

### Agency Configuration

```typescript
interface AgencyConfig {
  version: string;
  project?: ProjectConfig;
  tools?: ToolsConfig;
  context?: ContextConfig;
  plugins?: string[];
  pluginConfig?: Record<string, unknown>;
  performance?: PerformanceConfig;
}
```

### Humancy Configuration

```typescript
interface HumancyConfig {
  version: string;
  defaults?: HumancyDefaults;
  workflows?: string;
  integrations?: IntegrationsConfig;
  notifications?: NotificationsConfig;
  reviewers?: ReviewersConfig;
}
```

### Generacy Configuration

```typescript
interface GeneracyConfig {
  version: string;
  mode: 'local' | 'cloud' | 'hybrid';
  environment: string;
  orchestrator?: OrchestratorConfig;
  queue?: QueueConfig;
  workers?: WorkersConfig;
  storage?: StorageConfig;
  integrations?: IntegrationsConfig;
  logging?: LoggingConfig;
}
```

## API Contracts

### Request/Response

```typescript
// Standard API response
interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: ApiError;
  meta?: {
    requestId: string;
    timestamp: Date;
  };
}

interface ApiError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

// Paginated response
interface PaginatedResponse<T> extends ApiResponse<T[]> {
  pagination: {
    total: number;
    page: number;
    pageSize: number;
    hasMore: boolean;
  };
}
```

### Common Request Types

```typescript
interface CreateJobRequest {
  type: string;
  data: Record<string, unknown>;
  priority?: JobPriority;
  delay?: number;
}

interface TriggerWorkflowRequest {
  workflowId: string;
  inputs?: Record<string, unknown>;
  dryRun?: boolean;
}

interface ApproveGateRequest {
  comment?: string;
}

interface RejectGateRequest {
  reason: string;
}
```

## Validation

All contracts include runtime validation using Zod:

```typescript
import { z } from 'zod';

const JobSchema = z.object({
  id: z.string().uuid(),
  type: z.string().min(1),
  status: z.enum(['pending', 'active', 'completed', 'failed', 'delayed']),
  data: z.record(z.unknown()),
  priority: z.enum(['low', 'normal', 'high', 'critical']),
  // ...
});

// Validate at runtime
const job = JobSchema.parse(rawData);
```

## Versioning

Contracts follow semantic versioning:

- **Major**: Breaking changes
- **Minor**: New fields (backward compatible)
- **Patch**: Bug fixes

Contract versions are tracked in the `@generacy-ai/contracts` package.

## Next Steps

- [Security](/docs/architecture/security) - Security model
- [API Reference](/docs/reference/api) - API documentation

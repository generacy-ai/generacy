---
sidebar_position: 1
---

# API Reference

This section documents the Generacy API across all components.

## Overview

The Generacy API is organized into three main areas:

| Component | API Type | Description |
|-----------|----------|-------------|
| **Agency** | MCP Tools | Local agent enhancement tools |
| **Humancy** | MCP Tools + Commands | Human oversight commands |
| **Generacy** | REST API + MCP | Orchestration and job management |

## Agency MCP Tools

Agency provides tools via the Model Context Protocol (MCP):

### project-info

Get project metadata and structure.

```typescript
interface ProjectInfoResult {
  name: string;
  version: string;
  type: 'node' | 'python' | 'go' | 'rust';
  dependencies: Record<string, string>;
  structure: DirectoryTree;
}
```

**Usage:**
```
Agent: What is the project structure?
[Agency calls project-info tool]
```

### file-search

Search files by name or content pattern.

```typescript
interface FileSearchParams {
  query: string;
  type?: 'name' | 'content' | 'both';
  include?: string[];
  exclude?: string[];
  maxResults?: number;
}

interface FileSearchResult {
  matches: Array<{
    path: string;
    type: 'name' | 'content';
    line?: number;
    snippet?: string;
  }>;
}
```

### code-analysis

Analyze code patterns and quality.

```typescript
interface CodeAnalysisParams {
  path?: string;
  analysis: Array<'dependencies' | 'patterns' | 'metrics' | 'issues'>;
}

interface CodeAnalysisResult {
  dependencies?: DependencyGraph;
  patterns?: PatternMatch[];
  metrics?: CodeMetrics;
  issues?: CodeIssue[];
}
```

### git-context

Get git repository context.

```typescript
interface GitContextResult {
  branch: string;
  status: GitStatus;
  recentCommits: Commit[];
  remotes: Remote[];
}
```

## Humancy MCP Tools

Humancy extends Agency with human oversight tools:

### review-gate

Create a review gate in the current workflow.

```typescript
interface ReviewGateParams {
  title: string;
  description?: string;
  reviewers?: string[];
  requiredApprovals?: number;
  timeout?: string;
}

interface ReviewGateResult {
  gateId: string;
  status: 'pending' | 'approved' | 'rejected';
  approvals: Approval[];
}
```

### workflow-status

Get current workflow status.

```typescript
interface WorkflowStatusResult {
  workflowId: string;
  name: string;
  status: 'running' | 'paused' | 'completed' | 'failed';
  currentStep: string;
  gates: GateStatus[];
}
```

## Generacy REST API

Generacy provides a REST API for orchestration:

### Base URL

```
Local: http://localhost:3000/api/v1
Cloud: https://api.generacy.ai/v1
```

### Authentication

```http
Authorization: Bearer <token>
```

### Endpoints

#### Jobs

```http
# List jobs
GET /jobs
GET /jobs?status=pending&limit=10

# Get job
GET /jobs/:id

# Create job
POST /jobs
Content-Type: application/json
{
  "type": "process-issue",
  "data": {
    "issueUrl": "https://github.com/org/repo/issues/123"
  },
  "priority": "high"
}

# Cancel job
DELETE /jobs/:id
```

#### Workflows

```http
# List workflows
GET /workflows

# Get workflow
GET /workflows/:id

# Trigger workflow
POST /workflows/:id/trigger
Content-Type: application/json
{
  "inputs": {
    "branch": "main"
  }
}

# Cancel workflow
POST /workflows/:id/cancel
```

#### Gates

```http
# List pending gates
GET /gates?status=pending

# Get gate
GET /gates/:id

# Approve gate
POST /gates/:id/approve
Content-Type: application/json
{
  "comment": "LGTM"
}

# Reject gate
POST /gates/:id/reject
Content-Type: application/json
{
  "reason": "Needs security review"
}
```

### Webhooks

Generacy sends webhooks for various events:

```http
POST <your-webhook-url>
Content-Type: application/json
X-Generacy-Signature: sha256=<signature>

{
  "event": "workflow.completed",
  "timestamp": "2024-01-15T10:30:00Z",
  "data": {
    "workflowId": "wf_123",
    "name": "Deploy",
    "status": "completed"
  }
}
```

## TypeScript SDK

Install the SDK:

```bash
npm install @generacy-ai/sdk
```

Usage:

```typescript
import { GeneracyClient } from '@generacy-ai/sdk';

const client = new GeneracyClient({
  baseUrl: 'http://localhost:3000',
  token: process.env.GENERACY_TOKEN,
});

// Create a job
const job = await client.jobs.create({
  type: 'process-issue',
  data: { issueUrl: 'https://github.com/org/repo/issues/123' },
});

// Wait for completion
const result = await client.jobs.wait(job.id);

// Approve a gate
await client.gates.approve('gate_123', { comment: 'Approved' });
```

## Rate Limits

| Endpoint | Limit | Window |
|----------|-------|--------|
| `/api/*` | 1000 | 1 minute |
| `/webhooks/*` | 100 | 1 minute |

## Error Responses

```json
{
  "error": {
    "code": "INVALID_REQUEST",
    "message": "Missing required field: issueUrl",
    "details": {
      "field": "issueUrl",
      "required": true
    }
  }
}
```

| Code | Status | Description |
|------|--------|-------------|
| `INVALID_REQUEST` | 400 | Invalid request parameters |
| `UNAUTHORIZED` | 401 | Invalid or missing token |
| `FORBIDDEN` | 403 | Insufficient permissions |
| `NOT_FOUND` | 404 | Resource not found |
| `RATE_LIMITED` | 429 | Too many requests |
| `INTERNAL_ERROR` | 500 | Server error |

## Next Steps

- [Configuration Reference](/docs/reference/config/generacy)
- [CLI Commands](/docs/reference/cli/commands)

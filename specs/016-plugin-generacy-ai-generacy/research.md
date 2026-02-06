# Research: GitHub Actions Plugin

## Technology Decisions

### 1. GitHub API Client: @octokit/rest

**Decision**: Use `@octokit/rest` for GitHub API interactions.

**Rationale**:
- Already used by the `github-issues` plugin in this codebase
- Official GitHub SDK with complete TypeScript support
- Handles authentication, retries, and rate limiting
- Well-documented and maintained

**Alternatives Considered**:
- **Raw fetch**: Lower level, more control, but requires manual error handling
- **graphql-request**: GitHub's GraphQL API is powerful but REST is simpler for actions
- **got/axios**: Generic HTTP clients, but lack GitHub-specific conveniences

### 2. Polling vs Webhooks

**Decision**: Polling-based status monitoring.

**Rationale** (from clarification Q1):
- Plugin layer should remain infrastructure-free
- Webhooks require server endpoints (orchestrator responsibility)
- Polling is simpler and works in any environment
- EventBus facet can receive webhook events from orchestrator if needed later

**Implementation**:
```typescript
class StatusPoller {
  private intervalId?: NodeJS.Timeout;

  async poll(runId: number, config: PollingConfig): Promise<WorkflowRun> {
    for (let attempt = 0; attempt < config.maxAttempts; attempt++) {
      const run = await this.client.getWorkflowRun(runId);

      if (isTerminalStatus(run.status)) {
        return run;
      }

      config.onUpdate?.(run);
      await this.delay(config.interval);
    }
    throw new Error('Max polling attempts exceeded');
  }
}
```

### 3. Event Emission Pattern

**Decision**: Emit events via injected EventBus facet.

**Rationale** (from clarification Q4):
- Aligns with Latency's two-way uncoupling philosophy
- Consumers decide how to react to events
- Plugin doesn't need to know about specific error recovery strategies

**Event Types**:
```typescript
type WorkflowEvents = {
  'workflow.completed': { runId: number; conclusion: string; workflow: string };
  'workflow.failed': { runId: number; error: string; workflow: string };
  'check_run.completed': { checkRunId: number; conclusion: string };
};
```

### 4. Authentication Strategy

**Decision**: Token-only authentication (PAT).

**Rationale** (from clarification Q2):
- Matches the pattern in `github-issues` plugin
- Simple to configure and use
- GitHub App auth can be added to Latency base plugin later

### 5. Log Fetching: Batch vs Streaming

**Decision**: Batch log fetching via `getJobLogs()`.

**Rationale** (from clarification Q3):
- Interface signature `Promise<string>` implies batch
- Simpler implementation
- Streaming can be added as separate method later if needed

## Implementation Patterns

### Pattern 1: Operations Layer

Following `github-issues` plugin pattern:
```typescript
// Separate operation classes for each domain
export const createWorkflowOperations = (client: GitHubClient) => ({
  trigger: async (workflow: string, inputs?: Record<string, string>) => {...},
  triggerDispatch: async (workflow: string, ref: string, inputs?: Record<string, string>) => {...},
});

export const createRunOperations = (client: GitHubClient) => ({
  get: async (runId: number) => {...},
  list: async (workflow: string) => {...},
  cancel: async (runId: number) => {...},
  rerun: async (runId: number) => {...},
});
```

### Pattern 2: Facet Injection

Plugin manifest declares facet requirements:
```typescript
const manifest = {
  name: '@generacy-ai/generacy-plugin-github-actions',
  extends: 'latency-plugin-github-actions',
  provides: ['GitHubActions'],
  requires: [
    { facet: 'EventBus' },
    { facet: 'IssueTracker', optional: true }
  ]
};
```

### Pattern 3: Configuration Schema

Using Zod for runtime validation:
```typescript
export const GitHubActionsConfigSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  token: z.string().min(1),
  workflows: z.object({
    ci: z.string().optional(),
    deploy: z.string().optional(),
    test: z.string().optional(),
  }).optional(),
  polling: z.object({
    interval: z.number().min(1000).default(10000),
    maxAttempts: z.number().min(1).default(60),
  }).optional(),
});
```

## GitHub Actions API Reference

### Key Endpoints Used

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches` | POST | Trigger workflow |
| `/repos/{owner}/{repo}/actions/runs/{run_id}` | GET | Get run status |
| `/repos/{owner}/{repo}/actions/runs` | GET | List runs |
| `/repos/{owner}/{repo}/actions/runs/{run_id}/cancel` | POST | Cancel run |
| `/repos/{owner}/{repo}/actions/runs/{run_id}/rerun` | POST | Rerun workflow |
| `/repos/{owner}/{repo}/actions/runs/{run_id}/jobs` | GET | List jobs |
| `/repos/{owner}/{repo}/actions/jobs/{job_id}/logs` | GET | Get job logs |
| `/repos/{owner}/{repo}/actions/runs/{run_id}/artifacts` | GET | List artifacts |
| `/repos/{owner}/{repo}/actions/artifacts/{artifact_id}/zip` | GET | Download artifact |
| `/repos/{owner}/{repo}/check-runs` | POST | Create check run |
| `/repos/{owner}/{repo}/check-runs/{check_run_id}` | PATCH | Update check run |

### Workflow Run Status Values

```typescript
type WorkflowStatus = 'queued' | 'in_progress' | 'completed';
type WorkflowConclusion =
  | 'success'
  | 'failure'
  | 'neutral'
  | 'cancelled'
  | 'skipped'
  | 'timed_out'
  | 'action_required';
```

### Rate Limits

- Primary: 5000 requests/hour (authenticated)
- Search: 30 requests/minute
- Recommendation: 10s minimum polling interval

## Key Sources

1. [GitHub Actions REST API](https://docs.github.com/en/rest/actions)
2. [Octokit REST.js Documentation](https://octokit.github.io/rest.js/)
3. [GitHub Check Runs API](https://docs.github.com/en/rest/checks/runs)
4. Existing codebase: `packages/github-issues/`

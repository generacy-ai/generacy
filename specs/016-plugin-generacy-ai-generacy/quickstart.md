# Quickstart: GitHub Actions Plugin

## Installation

```bash
pnpm add @generacy-ai/generacy-plugin-github-actions
```

## Basic Usage

### 1. Create Plugin Instance

```typescript
import { createPlugin } from '@generacy-ai/generacy-plugin-github-actions';

const plugin = createPlugin({
  owner: 'your-org',
  repo: 'your-repo',
  token: process.env.GITHUB_TOKEN,
  workflows: {
    ci: 'ci.yml',
    deploy: 'deploy.yml',
  },
});
```

### 2. Trigger a Workflow

```typescript
// Trigger CI workflow
const run = await plugin.triggerWorkflow('ci.yml');
console.log(`Started run #${run.id}`);

// Trigger with inputs
const deployRun = await plugin.triggerWorkflowDispatch('deploy.yml', 'main', {
  environment: 'staging',
  version: '1.2.3',
});
```

### 3. Monitor Workflow Status

```typescript
// Get current status
const run = await plugin.getWorkflowRun(runId);
console.log(`Status: ${run.status}, Conclusion: ${run.conclusion}`);

// Poll until completion
const completedRun = await plugin.waitForCompletion(runId, {
  interval: 10000,   // 10 seconds
  maxAttempts: 60,   // 10 minutes max
  onUpdate: (run) => console.log(`Status: ${run.status}`),
});
```

### 4. Get Job Logs

```typescript
// List jobs for a run
const jobs = await plugin.getJobs(runId);

// Get logs for a specific job
const logs = await plugin.getJobLogs(jobs[0].id);
console.log(logs);
```

### 5. Download Artifacts

```typescript
// List artifacts
const artifacts = await plugin.listArtifacts(runId);

// Download specific artifact
const buffer = await plugin.downloadArtifact(artifacts[0].id);
fs.writeFileSync('artifact.zip', buffer);
```

### 6. Create Check Runs

```typescript
// Create a check run
const checkRun = await plugin.createCheckRun({
  name: 'My Custom Check',
  head_sha: 'abc123def456...',
  status: 'in_progress',
});

// Update check run with results
await plugin.updateCheckRun(checkRun.id, {
  status: 'completed',
  conclusion: 'success',
  output: {
    title: 'Check Passed',
    summary: 'All tests passed successfully',
  },
});
```

## With EventBus Integration

```typescript
import { createPlugin } from '@generacy-ai/generacy-plugin-github-actions';

// Plugin with EventBus facet
const plugin = createPlugin({
  owner: 'your-org',
  repo: 'your-repo',
  token: process.env.GITHUB_TOKEN,
  eventBus: myEventBusFacet,  // Injected facet
});

// Events are automatically emitted on workflow completion
// Listen via your EventBus implementation:
eventBus.on('workflow.completed', (event) => {
  console.log(`Workflow ${event.workflow} completed: ${event.conclusion}`);
});

eventBus.on('workflow.failed', (event) => {
  console.error(`Workflow ${event.workflow} failed: ${event.error}`);
});
```

## Configuration Reference

```typescript
interface GitHubActionsConfig {
  // Required
  owner: string;              // Repository owner
  repo: string;               // Repository name
  token: string;              // GitHub PAT

  // Optional
  workflows?: {
    ci?: string;              // CI workflow filename
    deploy?: string;          // Deploy workflow filename
    test?: string;            // Test workflow filename
  };

  polling?: {
    interval?: number;        // Poll interval in ms (default: 10000)
    maxAttempts?: number;     // Max poll attempts (default: 60)
  };

  // Facet injection (optional)
  eventBus?: EventBusFacet;   // For event emission
  issueTracker?: IssueTrackerFacet;  // For status linking
}
```

## Available Commands

| Method | Description |
|--------|-------------|
| `triggerWorkflow(workflow, inputs?)` | Trigger a workflow run |
| `triggerWorkflowDispatch(workflow, ref, inputs?)` | Trigger workflow on specific ref |
| `getWorkflowRun(runId)` | Get workflow run by ID |
| `listWorkflowRuns(workflow)` | List runs for a workflow |
| `cancelWorkflowRun(runId)` | Cancel a running workflow |
| `rerunWorkflowRun(runId)` | Re-run a workflow |
| `getJobs(runId)` | List jobs in a run |
| `getJobLogs(jobId)` | Get logs for a job |
| `listArtifacts(runId)` | List artifacts for a run |
| `downloadArtifact(artifactId)` | Download an artifact |
| `createCheckRun(params)` | Create a check run |
| `updateCheckRun(checkRunId, params)` | Update a check run |
| `waitForCompletion(runId, config?)` | Poll until run completes |

## Error Handling

```typescript
import {
  GitHubActionsError,
  GitHubRateLimitError,
  GitHubNotFoundError,
} from '@generacy-ai/generacy-plugin-github-actions';

try {
  await plugin.triggerWorkflow('ci.yml');
} catch (error) {
  if (error instanceof GitHubRateLimitError) {
    console.log(`Rate limited. Reset at: ${error.resetAt}`);
  } else if (error instanceof GitHubNotFoundError) {
    console.log('Workflow not found');
  } else if (error instanceof GitHubActionsError) {
    console.log(`GitHub Actions error: ${error.message}`);
  }
}
```

## Troubleshooting

### "Bad credentials" error
- Verify your PAT is valid and not expired
- Ensure PAT has `repo` and `workflow` scopes

### "Workflow not found" error
- Check workflow filename is correct (e.g., `ci.yml` not `ci.yaml`)
- Verify workflow exists in `.github/workflows/` directory

### Rate limiting
- Default poll interval is 10s to avoid rate limits
- Increase `polling.interval` for less critical workflows
- Consider using conditional requests with ETags (future enhancement)

### Timeout waiting for completion
- Increase `polling.maxAttempts` for long-running workflows
- Check if workflow is stuck and may need manual cancellation

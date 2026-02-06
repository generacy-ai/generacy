# Quickstart: @generacy-ai/generacy-plugin-copilot

## Installation

```bash
pnpm add @generacy-ai/generacy-plugin-copilot
```

## Prerequisites

1. **GitHub Token**: A personal access token or GitHub App token with:
   - `repo` scope (for issue/PR access)
   - `read:org` scope (if using organization repos)

2. **Node.js**: Version 20.0.0 or higher

## Basic Usage

### Initialize the Plugin

```typescript
import { CopilotPlugin } from '@generacy-ai/generacy-plugin-copilot';

const plugin = new CopilotPlugin({
  githubToken: process.env.GITHUB_TOKEN,
});
```

### Create a Workspace

```typescript
// Create workspace tracking for an issue
const workspace = await plugin.createWorkspace({
  issueUrl: 'https://github.com/owner/repo/issues/123',
  options: {
    reviewRequired: true,
    autoMerge: false,
  },
});

console.log(`Workspace created: ${workspace.id}`);
console.log(`Status: ${workspace.status}`);
```

### Poll for Status

```typescript
// Manual status polling
const status = await plugin.pollWorkspaceStatus(workspace.id);
console.log(`Current status: ${status}`);

// Or stream status updates
for await (const event of plugin.streamStatus(workspace.id)) {
  console.log(`Status changed: ${event.previousStatus} → ${event.status}`);

  if (event.status === 'review_ready') {
    console.log(`PR available at: ${event.details?.pullRequestUrl}`);
    break;
  }
}
```

### Retrieve Results

```typescript
// Get file changes when workspace is complete
const changes = await plugin.getChanges(workspace.id);
for (const change of changes) {
  console.log(`${change.type}: ${change.path} (+${change.additions}/-${change.deletions})`);
}

// Get pull request details
const pr = await plugin.getPullRequest(workspace.id);
if (pr) {
  console.log(`PR #${pr.number}: ${pr.title}`);
  console.log(`State: ${pr.state}, Mergeable: ${pr.mergeable}`);
}
```

### Cleanup

```typescript
// Dispose when done
await plugin.dispose();
```

## Configuration Options

```typescript
const plugin = new CopilotPlugin({
  // Required
  githubToken: process.env.GITHUB_TOKEN,

  // Optional: GitHub Enterprise URL
  apiBaseUrl: 'https://github.mycompany.com/api/v3',

  // Optional: Custom logger
  logger: myPinoInstance,

  // Optional: Polling configuration
  polling: {
    initialIntervalMs: 5000,   // Start polling every 5 seconds
    maxIntervalMs: 60000,      // Max out at 1 minute
    backoffMultiplier: 1.5,    // Increase by 50% each time
    maxRetries: 100,           // Give up after 100 attempts
  },

  // Optional: Default workspace options
  workspaceDefaults: {
    autoMerge: false,
    reviewRequired: true,
    timeoutMs: 3600000,  // 1 hour timeout
  },
});
```

## Available Commands

### CopilotPlugin Methods

| Method | Description |
|--------|-------------|
| `createWorkspace(params)` | Start tracking a workspace for an issue |
| `getWorkspace(id)` | Get workspace by ID |
| `pollWorkspaceStatus(id)` | Poll current workspace status |
| `streamStatus(id)` | Stream status updates (async iterable) |
| `getChanges(id)` | Get file changes from workspace |
| `getPullRequest(id)` | Get associated pull request |
| `dispose()` | Cleanup and release resources |

### Workspace Statuses

| Status | Description |
|--------|-------------|
| `pending` | Tracking started, awaiting manual workspace trigger |
| `planning` | Copilot is analyzing the issue |
| `implementing` | Copilot is generating code |
| `review_ready` | PR created, ready for review |
| `merged` | PR has been merged |
| `failed` | Workspace failed or was cancelled |
| `not_available` | Copilot API not available |

## Integration with Generacy Workflows

```typescript
import { CopilotPlugin } from '@generacy-ai/generacy-plugin-copilot';
import { createWorkflow } from '@generacy-ai/workflow-engine';

const copilot = new CopilotPlugin({ githubToken });

const workflow = createWorkflow({
  name: 'copilot-issue-handler',
  steps: [
    {
      name: 'create-workspace',
      action: async (ctx) => {
        const workspace = await copilot.createWorkspace({
          issueUrl: ctx.inputs.issueUrl,
        });
        return { workspaceId: workspace.id };
      },
    },
    {
      name: 'wait-for-completion',
      action: async (ctx) => {
        for await (const event of copilot.streamStatus(ctx.outputs.workspaceId)) {
          if (['review_ready', 'merged', 'failed'].includes(event.status)) {
            return { status: event.status };
          }
        }
      },
    },
    {
      name: 'get-results',
      action: async (ctx) => {
        const pr = await copilot.getPullRequest(ctx.outputs.workspaceId);
        return { pullRequest: pr };
      },
    },
  ],
});
```

## Troubleshooting

### "Workspace not found" Error

- Ensure the workspace ID is valid
- Check if the workspace was disposed

### "GitHub API Error"

- Verify your token has required scopes
- Check rate limit status: `gh api /rate_limit`

### Status Stuck on "pending"

- The plugin cannot automatically trigger Copilot Workspace
- Manually open the issue in Copilot Workspace at github.com
- The plugin will detect the PR when created

### Polling Timeout

- Increase `polling.maxRetries` or `polling.timeoutMs`
- Complex issues may take longer for Copilot to process

## Current Limitations

1. **No Automatic Workspace Creation**: GitHub Copilot Workspace does not have a public API, so workspaces must be created manually through the GitHub UI.

2. **Status Inference**: Status is inferred from PR state rather than direct Copilot API feedback.

3. **GitHub Only**: Only works with github.com and GitHub Enterprise Server (not other Git platforms).

## Next Steps

- See [data-model.md](./data-model.md) for complete type definitions
- See [research.md](./research.md) for API status and alternatives
- Check [plan.md](./plan.md) for implementation roadmap

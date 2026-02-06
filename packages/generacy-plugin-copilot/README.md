# @generacy-ai/generacy-plugin-copilot

GitHub Copilot Workspace agent platform plugin for Generacy.

## Overview

This plugin provides tracking and monitoring of GitHub Copilot Workspace sessions. Due to the current lack of a public Copilot Workspace API, this plugin operates in a tracking/monitoring mode, inferring workspace status from GitHub Issues and Pull Requests.

## Installation

```bash
pnpm add @generacy-ai/generacy-plugin-copilot
```

## Usage

```typescript
import { CopilotPlugin } from '@generacy-ai/generacy-plugin-copilot';

// Initialize the plugin
const copilot = new CopilotPlugin({
  githubToken: process.env.GITHUB_TOKEN!,
  polling: {
    initialIntervalMs: 5000,
    maxIntervalMs: 60000,
    backoffMultiplier: 1.5,
  },
});

// Create a workspace to track an issue
const workspace = await copilot.createWorkspace({
  issueUrl: 'https://github.com/owner/repo/issues/123',
  options: {
    autoMerge: false,
    reviewRequired: true,
  },
});

console.log(`Tracking workspace: ${workspace.id}`);

// Poll for status updates
const status = await copilot.pollWorkspaceStatus(workspace.id);
console.log(`Current status: ${status}`);

// Or stream status changes
for await (const event of copilot.streamStatus(workspace.id)) {
  console.log(`Status changed: ${event.previousStatus} -> ${event.status}`);

  if (event.details?.pullRequestUrl) {
    console.log(`PR created: ${event.details.pullRequestUrl}`);
  }
}

// Get file changes when workspace reaches review_ready or merged status
if (status === 'review_ready' || status === 'merged') {
  const changes = await copilot.getChanges(workspace.id);
  for (const change of changes) {
    console.log(`${change.type}: ${change.path} (+${change.additions}/-${change.deletions})`);
  }

  const pr = await copilot.getPullRequest(workspace.id);
  if (pr) {
    console.log(`PR #${pr.number}: ${pr.title}`);
  }
}

// Cleanup when done
await copilot.dispose();
```

## API

### CopilotPlugin

The main plugin class.

#### Constructor Options

```typescript
interface CopilotPluginOptions {
  // Required: GitHub personal access token or GitHub App token
  githubToken: string;

  // Optional: GitHub API base URL (for GitHub Enterprise)
  apiBaseUrl?: string;

  // Optional: Pino logger instance
  logger?: Logger;

  // Optional: Polling configuration
  polling?: {
    initialIntervalMs?: number;  // Default: 5000
    maxIntervalMs?: number;      // Default: 60000
    backoffMultiplier?: number;  // Default: 1.5
    maxRetries?: number;         // Default: 100
    timeoutMs?: number;          // Default: 3600000 (1 hour)
  };

  // Optional: Default workspace options
  workspaceDefaults?: {
    autoMerge?: boolean;
    reviewRequired?: boolean;
    timeoutMs?: number;
    prLabels?: string[];
  };
}
```

#### Methods

- `createWorkspace(params)` - Create a workspace for tracking
- `getWorkspace(workspaceId)` - Get workspace by ID
- `pollWorkspaceStatus(workspaceId)` - Poll current status
- `getChanges(workspaceId)` - Get file changes (review_ready/merged only)
- `getPullRequest(workspaceId)` - Get associated PR
- `streamStatus(workspaceId)` - Async generator for status events
- `dispose()` - Cleanup resources

### WorkspaceStatus

```typescript
type WorkspaceStatus =
  | 'pending'        // Tracking initiated, awaiting manual workspace trigger
  | 'planning'       // Copilot is analyzing the issue
  | 'implementing'   // Copilot is generating code
  | 'review_ready'   // PR created, ready for review
  | 'merged'         // PR has been merged
  | 'failed'         // Workspace failed or was cancelled
  | 'not_available'; // Copilot API not available
```

## Limitations

- **No Direct API**: This plugin infers status from GitHub API since Copilot Workspace has no public API
- **Manual Trigger**: Users must manually trigger Copilot Workspace; this plugin tracks progress afterward
- **GitHub Only**: Works with GitHub.com and GitHub Enterprise

## License

MIT

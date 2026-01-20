---
sidebar_position: 4
---

# Generacy Plugins

Generacy plugins add integrations, job processors, and orchestration capabilities.

## Overview

Generacy plugins provide:

- **Integrations** - Connect to external services
- **Job Processors** - Custom job handling
- **Webhooks** - Handle external events
- **Schedulers** - Custom scheduling logic

## Quick Start

### 1. Create the Plugin

```bash
mkdir generacy-plugin-example
cd generacy-plugin-example
npm init -y
npm install @generacy-ai/generacy --save-peer
npm install typescript --save-dev
```

### 2. Define the Manifest

```json title="manifest.json"
{
  "name": "example-generacy-plugin",
  "version": "1.0.0",
  "type": "generacy",
  "description": "Example Generacy plugin",
  "integrations": [
    {
      "name": "linear",
      "description": "Linear issue tracker integration"
    }
  ],
  "jobProcessors": [
    {
      "name": "sync-linear-issues",
      "description": "Sync issues from Linear"
    }
  ],
  "webhooks": [
    {
      "name": "linear-webhook",
      "path": "/webhooks/linear",
      "description": "Handle Linear webhooks"
    }
  ]
}
```

### 3. Implement the Plugin

```typescript title="src/index.ts"
import {
  GeneracyPlugin,
  Integration,
  JobProcessor,
  WebhookHandler,
  Job,
} from '@generacy-ai/generacy';

export default class ExamplePlugin implements GeneracyPlugin {
  name = 'example-generacy-plugin';
  version = '1.0.0';

  private linearClient: LinearClient;

  constructor(config: { linearApiKey: string }) {
    this.linearClient = new LinearClient({ apiKey: config.linearApiKey });
  }

  integrations: Integration[] = [
    {
      name: 'linear',
      connect: this.connectLinear.bind(this),
      disconnect: this.disconnectLinear.bind(this),
      getStatus: this.getLinearStatus.bind(this),
    },
  ];

  jobProcessors: JobProcessor[] = [
    {
      name: 'sync-linear-issues',
      process: this.syncLinearIssues.bind(this),
    },
  ];

  webhooks: WebhookHandler[] = [
    {
      name: 'linear-webhook',
      path: '/webhooks/linear',
      handler: this.handleLinearWebhook.bind(this),
    },
  ];

  async initialize(): Promise<void> {
    await this.linearClient.initialize();
  }

  async connectLinear(): Promise<void> {
    await this.linearClient.authenticate();
  }

  async disconnectLinear(): Promise<void> {
    await this.linearClient.disconnect();
  }

  async getLinearStatus(): Promise<IntegrationStatus> {
    const connected = await this.linearClient.isConnected();
    return {
      connected,
      lastSync: this.lastSyncTime,
    };
  }

  async syncLinearIssues(job: Job): Promise<void> {
    const { projectId, since } = job.data;

    const issues = await this.linearClient.getIssues({
      projectId,
      updatedSince: since,
    });

    for (const issue of issues) {
      await this.processIssue(issue);
    }

    this.lastSyncTime = new Date();
  }

  async handleLinearWebhook(request: WebhookRequest): Promise<void> {
    const { action, data } = request.body;

    switch (action) {
      case 'issue.created':
        await this.handleIssueCreated(data);
        break;
      case 'issue.updated':
        await this.handleIssueUpdated(data);
        break;
      default:
        // Ignore unknown actions
    }
  }

  private async processIssue(issue: LinearIssue): Promise<void> {
    // Convert and store issue
  }

  private async handleIssueCreated(data: any): Promise<void> {
    // Handle new issue
  }

  private async handleIssueUpdated(data: any): Promise<void> {
    // Handle updated issue
  }
}
```

## Integration Development

### Integration Interface

```typescript
interface Integration {
  name: string;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  getStatus: () => Promise<IntegrationStatus>;
  healthCheck?: () => Promise<boolean>;
}
```

### OAuth Integration

```typescript
integrations: Integration[] = [
  {
    name: 'google-calendar',
    connect: async () => {
      // OAuth flow
      const authUrl = oauth2Client.generateAuthUrl({
        scope: ['https://www.googleapis.com/auth/calendar.readonly'],
      });
      // Redirect user to authUrl
    },
    handleCallback: async (code: string) => {
      const { tokens } = await oauth2Client.getToken(code);
      oauth2Client.setCredentials(tokens);
      await this.storeTokens(tokens);
    },
    disconnect: async () => {
      await oauth2Client.revokeCredentials();
    },
    getStatus: async () => ({
      connected: !!oauth2Client.credentials,
      scopes: oauth2Client.credentials?.scope,
    }),
  },
];
```

## Job Processors

### Basic Job Processor

```typescript
jobProcessors: JobProcessor[] = [
  {
    name: 'process-issue',
    process: async (job) => {
      const { issueUrl } = job.data;

      // Process the issue
      const result = await processIssue(issueUrl);

      // Job completes successfully
      return { result };
    },
  },
];
```

### Long-Running Job

```typescript
{
  name: 'long-running-job',
  process: async (job, context) => {
    const items = await getItems(job.data);

    for (let i = 0; i < items.length; i++) {
      await processItem(items[i]);

      // Report progress
      await context.progress((i + 1) / items.length * 100);

      // Check for cancellation
      if (context.isCancelled()) {
        return { cancelled: true };
      }
    }

    return { processed: items.length };
  },
}
```

### Job with Retries

```typescript
{
  name: 'flaky-job',
  options: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 1000,
    },
  },
  process: async (job) => {
    try {
      return await unreliableOperation();
    } catch (error) {
      if (isRetryable(error)) {
        throw error; // Will be retried
      }
      // Non-retryable error
      return { error: error.message };
    }
  },
}
```

## Webhook Handlers

### Verified Webhooks

```typescript
webhooks: WebhookHandler[] = [
  {
    name: 'github-webhook',
    path: '/webhooks/github',
    verifySignature: (request, secret) => {
      const signature = request.headers['x-hub-signature-256'];
      const computed = crypto
        .createHmac('sha256', secret)
        .update(JSON.stringify(request.body))
        .digest('hex');
      return signature === `sha256=${computed}`;
    },
    handler: async (request) => {
      const event = request.headers['x-github-event'];
      const payload = request.body;

      switch (event) {
        case 'issues':
          await this.handleIssueEvent(payload);
          break;
        case 'pull_request':
          await this.handlePREvent(payload);
          break;
      }
    },
  },
];
```

### Webhook to Job

```typescript
{
  name: 'trigger-workflow',
  path: '/webhooks/trigger',
  handler: async (request, context) => {
    const { workflow, inputs } = request.body;

    // Queue a job to handle the request
    await context.queueJob('run-workflow', {
      workflow,
      inputs,
      triggeredBy: 'webhook',
    });

    return { queued: true };
  },
}
```

## Scheduled Jobs

### Cron-Based Scheduling

```typescript
schedulers: Scheduler[] = [
  {
    name: 'daily-sync',
    cron: '0 0 * * *', // Every day at midnight
    job: 'sync-linear-issues',
    data: {
      fullSync: true,
    },
  },
  {
    name: 'hourly-check',
    cron: '0 * * * *', // Every hour
    job: 'check-pending-gates',
  },
];
```

## Testing

### Integration Tests

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import ExamplePlugin from './index';

describe('ExamplePlugin', () => {
  let plugin: ExamplePlugin;

  beforeAll(async () => {
    plugin = new ExamplePlugin({ linearApiKey: 'test-key' });
    await plugin.initialize();
  });

  afterAll(async () => {
    await plugin.shutdown();
  });

  describe('Linear integration', () => {
    it('should sync issues', async () => {
      const job = { data: { projectId: 'proj-1', since: new Date() } };
      await plugin.syncLinearIssues(job);
      // Verify issues synced
    });
  });

  describe('Webhook handling', () => {
    it('should handle issue created', async () => {
      const request = {
        body: {
          action: 'issue.created',
          data: { id: 'issue-1', title: 'Test' },
        },
      };
      await plugin.handleLinearWebhook(request);
      // Verify issue handled
    });
  });
});
```

## Next Steps

- [Manifest Reference](/docs/plugins/manifest-reference) - Complete manifest docs
- [API Reference](/docs/reference/api) - Generacy API documentation

# Data Model: InMemoryQueueAdapter

## New Entity: InMemoryQueueAdapter

Implements the `QueueManager` interface for Redis-free local development.

### Internal State

```typescript
class InMemoryQueueAdapter implements QueueManager {
  // Pending items sorted by score (lower = higher priority)
  private pending: Array<{
    item: SerializedQueueItem;
    score: number;
  }>;

  // Items claimed by workers: workerId → Map<itemKey, SerializedQueueItem>
  private claimed: Map<string, Map<string, SerializedQueueItem>>;

  // Dead-lettered items (exceeded maxRetries)
  private deadLetter: Array<{
    item: SerializedQueueItem;
    score: number;
  }>;

  // Configuration
  private readonly maxRetries: number; // default: 3
}
```

### SerializedQueueItem (existing type, from monitor.ts)

```typescript
interface SerializedQueueItem extends QueueItem {
  attemptCount: number;
  itemKey: string; // "{owner}/{repo}#{issueNumber}"
}
```

### QueueItem (existing type, from monitor.ts)

```typescript
interface QueueItem {
  owner: string;
  repo: string;
  issueNumber: number;
  workflowName: string;
  command: 'process' | 'continue' | 'address-pr-feedback';
  priority: number;
  enqueuedAt: string;
  metadata?: Record<string, unknown>;
}
```

## Config Schema Addition: SmeeConfig

```typescript
// Added to OrchestratorConfigSchema
const SmeeConfigSchema = z.object({
  /** Smee.io channel URL for webhook forwarding */
  channelUrl: z.string().url().optional(),
  /** Poll interval when smee is active (polling is fallback only) */
  fallbackPollIntervalMs: z.number().int().min(30000).default(300000),
});
```

## Config Schema Addition: CreateServerOptions Extension

```typescript
interface CreateServerOptions {
  config?: OrchestratorConfig;
  fastifyOptions?: FastifyServerOptions;
  skipRoutes?: boolean;
  apiKeyStore?: InMemoryApiKeyStore; // NEW: external API key registration
}
```

## Metadata Extension: Issue Description

The `QueueItem.metadata` field will carry issue description after enrichment:

```typescript
// After enrichment in LabelMonitorService.processLabelEvent()
item.metadata = {
  ...item.metadata,
  description: issueBody || issueTitle, // fetched from GitHub API
};
```

# @generacy-ai/generacy-plugin-cloud-build

Google Cloud Build integration plugin for Generacy. Enables triggering builds, monitoring status, streaming logs, accessing artifacts, and managing triggers through a typed TypeScript interface.

## Installation

```bash
pnpm add @generacy-ai/generacy-plugin-cloud-build
```

## Quick Start

```typescript
import { CloudBuildPlugin } from '@generacy-ai/generacy-plugin-cloud-build';

// Create plugin instance
const plugin = new CloudBuildPlugin({
  projectId: 'my-gcp-project',
});

// Trigger a build
const build = await plugin.triggerBuild('my-trigger-id');
console.log(`Build started: ${build.id}`);

// Monitor build status
const status = await plugin.getBuild(build.id);
console.log(`Build status: ${status.status}`);

// Stream logs
for await (const log of plugin.streamLogs(build.id)) {
  console.log(`[${log.severity}] ${log.message}`);
}
```

## Configuration

```typescript
interface CloudBuildConfig {
  projectId: string;              // Required: GCP project ID
  location?: string;              // Default: 'global'
  serviceAccountKey?: string;     // Optional: JSON service account key
  defaultTrigger?: string;        // Optional: default trigger ID
  artifactBucket?: string;        // Optional: GCS bucket for artifacts
  retry?: {
    maxAttempts?: number;         // Default: 3
    initialDelayMs?: number;      // Default: 1000
    maxDelayMs?: number;          // Default: 30000
  };
  logPollingIntervalMs?: number;  // Default: 2000
}
```

### Authentication

The plugin supports two authentication methods:

1. **Service Account Key** (highest priority): Pass the JSON key as a string
2. **Application Default Credentials (ADC)**: Uses ambient credentials

```typescript
// Using service account key
const plugin = new CloudBuildPlugin({
  projectId: 'my-project',
  serviceAccountKey: process.env.GCP_SERVICE_ACCOUNT_KEY,
});

// Using ADC (no explicit credentials)
const plugin = new CloudBuildPlugin({
  projectId: 'my-project',
});
```

## API Reference

### Build Operations

#### `triggerBuild(triggerId: string, source?: BuildSource): Promise<Build>`

Trigger a build from an existing trigger.

```typescript
const build = await plugin.triggerBuild('my-trigger', {
  repoSource: {
    repoName: 'my-repo',
    branchName: 'main',
  },
});
```

#### `runBuild(config: BuildConfig): Promise<Build>`

Run a build from inline configuration.

```typescript
const build = await plugin.runBuild({
  steps: [
    { name: 'node:20', args: ['install'] },
    { name: 'node:20', args: ['test'] },
  ],
  timeout: '3600s',
});
```

#### `getBuild(buildId: string): Promise<Build>`

Get a single build by ID.

#### `listBuilds(filter?: BuildFilter): Promise<PaginatedResult<Build>>`

List builds with optional filtering.

```typescript
const { items, nextPageToken } = await plugin.listBuilds({
  status: ['SUCCESS', 'FAILURE'],
  triggerId: 'my-trigger',
  pageSize: 20,
});
```

#### `cancelBuild(buildId: string): Promise<void>`

Cancel a running build.

#### `retryBuild(buildId: string): Promise<Build>`

Retry a failed build.

### Log Streaming

#### `streamLogs(buildId: string, options?: LogStreamOptions): AsyncIterable<LogEntry>`

Stream logs from a build as an AsyncIterable.

```typescript
for await (const log of plugin.streamLogs(buildId)) {
  if (log.severity === 'ERROR') {
    console.error(log.message);
  }
}
```

Options:
- `pollingIntervalMs`: Override default polling interval
- `startOffset`: Start from a specific log offset

### Artifact Operations

#### `listArtifacts(buildId: string): Promise<Artifact[]>`

List artifacts for a build.

#### `getArtifact(buildId: string, path: string): Promise<Buffer>`

Download an artifact as a Buffer. Throws if > 100MB.

#### `getArtifactStream(buildId: string, path: string): Promise<ReadableStream>`

Download an artifact as a ReadableStream. Use for large files.

### Trigger Management

#### `listTriggers(): Promise<BuildTrigger[]>`

List all build triggers.

#### `createTrigger(config: TriggerConfig): Promise<BuildTrigger>`

Create a new build trigger.

```typescript
const trigger = await plugin.createTrigger({
  name: 'my-trigger',
  github: {
    owner: 'my-org',
    name: 'my-repo',
    push: { branch: 'main' },
  },
  filename: 'cloudbuild.yaml',
});
```

#### `updateTrigger(triggerId: string, config: Partial<TriggerConfig>): Promise<BuildTrigger>`

Update an existing trigger.

#### `deleteTrigger(triggerId: string): Promise<void>`

Delete a trigger.

## Error Handling

The plugin throws typed errors for different failure scenarios:

```typescript
import {
  CloudBuildError,
  AuthError,
  NotFoundError,
  RateLimitError,
  ValidationError,
  isTransientError,
} from '@generacy-ai/generacy-plugin-cloud-build';

try {
  await plugin.getBuild('nonexistent');
} catch (error) {
  if (error instanceof NotFoundError) {
    console.log('Build not found');
  } else if (isTransientError(error)) {
    console.log('Transient error, retry later');
  }
}
```

### Error Types

| Error | Code | Retryable | Description |
|-------|------|-----------|-------------|
| `AuthError` | AUTH_FAILED | No | Authentication failed |
| `NotFoundError` | NOT_FOUND | No | Resource not found |
| `RateLimitError` | RESOURCE_EXHAUSTED | Yes | Rate limited |
| `TimeoutError` | DEADLINE_EXCEEDED | Yes | Operation timed out |
| `ValidationError` | INVALID_ARGUMENT | No | Invalid input |
| `ServiceUnavailableError` | UNAVAILABLE | Yes | Service unavailable |

## License

MIT

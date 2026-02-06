# Quickstart: @generacy-ai/generacy-plugin-cloud-build

## Installation

```bash
pnpm add @generacy-ai/generacy-plugin-cloud-build
```

## Configuration

### Using Application Default Credentials (ADC)

```typescript
import { CloudBuildPlugin } from '@generacy-ai/generacy-plugin-cloud-build';

const plugin = new CloudBuildPlugin({
  projectId: 'my-gcp-project',
});
```

### Using Service Account Key

```typescript
import { CloudBuildPlugin } from '@generacy-ai/generacy-plugin-cloud-build';
import { readFileSync } from 'fs';

const plugin = new CloudBuildPlugin({
  projectId: 'my-gcp-project',
  serviceAccountKey: readFileSync('./service-account.json', 'utf-8'),
});
```

### Full Configuration

```typescript
const plugin = new CloudBuildPlugin({
  projectId: 'my-gcp-project',
  location: 'us-central1',  // default: 'global'
  serviceAccountKey: process.env.GCP_SERVICE_ACCOUNT_KEY,
  defaultTrigger: 'my-default-trigger',
  artifactBucket: 'my-artifacts-bucket',
  retry: {
    maxAttempts: 3,
    initialDelayMs: 1000,
    maxDelayMs: 30000,
  },
  logPollingIntervalMs: 2000,
});
```

## Usage Examples

### Trigger a Build

```typescript
// Trigger by ID
const build = await plugin.triggerBuild('my-trigger-id');
console.log(`Build ${build.id} started with status: ${build.status}`);

// Trigger with source override
const build = await plugin.triggerBuild('my-trigger-id', {
  repoSource: {
    branchName: 'feature/my-branch',
  },
});
```

### Run a Build Directly

```typescript
const build = await plugin.runBuild({
  steps: [
    {
      name: 'node:20',
      entrypoint: 'npm',
      args: ['install'],
    },
    {
      name: 'node:20',
      entrypoint: 'npm',
      args: ['test'],
    },
  ],
  source: {
    repoSource: {
      repoName: 'my-repo',
      branchName: 'main',
    },
  },
  timeout: '1800s',
});
```

### Monitor Build Status

```typescript
// Get single build
const build = await plugin.getBuild('build-id');
console.log(`Status: ${build.status}, Duration: ${build.duration}s`);

// List builds with filter
const { items, nextPageToken } = await plugin.listBuilds({
  status: 'WORKING',
  triggerId: 'my-trigger',
  pageSize: 10,
});
```

### Stream Build Logs

```typescript
for await (const entry of plugin.streamLogs(build.id)) {
  console.log(`[${entry.timestamp.toISOString()}] ${entry.message}`);
}
```

### Work with Artifacts

```typescript
// List artifacts
const artifacts = await plugin.listArtifacts(build.id);
for (const artifact of artifacts) {
  console.log(`${artifact.path} (${artifact.size} bytes)`);
}

// Download artifact (small files)
const content = await plugin.getArtifact(build.id, 'dist/bundle.js');

// Stream artifact (large files)
const stream = await plugin.getArtifactStream(build.id, 'dist/large-file.zip');
const writer = createWriteStream('./local-file.zip');
await pipeline(stream, writer);
```

### Manage Triggers

```typescript
// List triggers
const triggers = await plugin.listTriggers();

// Create trigger
const trigger = await plugin.createTrigger({
  name: 'deploy-production',
  description: 'Deploy to production on main branch push',
  github: {
    owner: 'my-org',
    name: 'my-repo',
    push: { branch: '^main$' },
  },
  filename: 'cloudbuild.yaml',
});

// Update trigger
await plugin.updateTrigger(trigger.id, {
  disabled: true,
});

// Delete trigger
await plugin.deleteTrigger(trigger.id);
```

## Available Commands

| Method | Description |
|--------|-------------|
| `triggerBuild(triggerId, source?)` | Trigger a build using a trigger |
| `runBuild(config)` | Run a build with inline configuration |
| `getBuild(buildId)` | Get build details by ID |
| `listBuilds(filter?)` | List builds with optional filters |
| `cancelBuild(buildId)` | Cancel a running build |
| `retryBuild(buildId)` | Retry a failed build |
| `streamLogs(buildId)` | Stream build logs |
| `listArtifacts(buildId)` | List build artifacts |
| `getArtifact(buildId, path)` | Download artifact as Buffer |
| `getArtifactStream(buildId, path)` | Stream artifact for large files |
| `listTriggers()` | List all triggers |
| `createTrigger(config)` | Create a new trigger |
| `updateTrigger(triggerId, config)` | Update an existing trigger |
| `deleteTrigger(triggerId)` | Delete a trigger |

## Troubleshooting

### Authentication Errors

**Error**: `Could not load the default credentials`

**Solution**: Set up ADC or provide a service account key:
```bash
gcloud auth application-default login
```

Or set the environment variable:
```bash
export GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
```

### Permission Denied

**Error**: `Permission denied on resource project my-project`

**Solution**: Ensure the service account has the required roles:
- `roles/cloudbuild.builds.editor` - For triggering and managing builds
- `roles/storage.objectViewer` - For accessing artifacts

### Build Not Found

**Error**: `Build not found: build-id`

**Solution**: Verify the build ID and that it exists in the specified project/location:
```typescript
const plugin = new CloudBuildPlugin({
  projectId: 'correct-project-id',
  location: 'correct-region',  // e.g., 'us-central1' or 'global'
});
```

### Rate Limiting

**Error**: `Rate limit exceeded`

**Solution**: The plugin automatically retries with exponential backoff. For high-volume use cases, increase the retry configuration:
```typescript
const plugin = new CloudBuildPlugin({
  projectId: 'my-project',
  retry: {
    maxAttempts: 5,
    initialDelayMs: 2000,
    maxDelayMs: 60000,
  },
});
```

### Large Artifact Memory Issues

**Error**: `JavaScript heap out of memory`

**Solution**: Use streaming for large artifacts:
```typescript
// Instead of:
const content = await plugin.getArtifact(buildId, path);  // Loads into memory

// Use:
const stream = await plugin.getArtifactStream(buildId, path);  // Streams to disk
```

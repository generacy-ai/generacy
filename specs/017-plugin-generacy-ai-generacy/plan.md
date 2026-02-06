# Implementation Plan: @generacy-ai/generacy-plugin-cloud-build

**Feature**: Google Cloud Build integration plugin for CI/CD
**Branch**: `017-plugin-generacy-ai-generacy`
**Status**: Complete

## Summary

Implement a TypeScript plugin for Google Cloud Build integration, following the established Generacy plugin architecture. The plugin enables triggering builds, monitoring status, streaming logs, accessing artifacts, and managing triggers through a typed interface.

## Technical Context

- **Language**: TypeScript 5.x (strict mode)
- **Runtime**: Node.js >= 20.0.0
- **Module System**: ESM
- **Build Tool**: tsc
- **Test Framework**: vitest
- **Validation**: Zod schemas
- **Logging**: pino

### Key Dependencies

| Dependency | Version | Purpose |
|------------|---------|---------|
| @google-cloud/cloudbuild | ^4.x | Cloud Build API client |
| @google-cloud/storage | ^7.x | Artifact access via GCS |
| zod | ^3.23.0 | Input validation |
| pino | ^9.0.0 | Structured logging |

## Project Structure

```
packages/generacy-plugin-cloud-build/
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── src/
│   ├── index.ts                    # Public exports
│   ├── plugin.ts                   # Main CloudBuildPlugin class
│   ├── client.ts                   # Cloud Build API wrapper
│   ├── config/
│   │   ├── schema.ts               # Zod config schema
│   │   └── types.ts                # Config types
│   ├── operations/
│   │   ├── builds.ts               # Build triggering & monitoring
│   │   ├── logs.ts                 # Log streaming
│   │   ├── artifacts.ts            # Artifact access
│   │   └── triggers.ts             # Trigger management
│   ├── auth/
│   │   ├── auth-provider.ts        # Authentication strategy
│   │   └── types.ts                # Auth types
│   ├── streaming/
│   │   ├── log-stream.ts           # AsyncIterable log streaming
│   │   └── types.ts                # Stream types
│   ├── types/
│   │   ├── builds.ts               # Build types
│   │   ├── triggers.ts             # Trigger types
│   │   ├── artifacts.ts            # Artifact types
│   │   └── logs.ts                 # Log entry types
│   ├── errors.ts                   # Custom error classes
│   └── utils/
│       ├── validation.ts           # Input validators
│       └── retry.ts                # Retry logic with backoff
└── tests/
    ├── unit/
    │   ├── builds.test.ts
    │   ├── logs.test.ts
    │   ├── artifacts.test.ts
    │   └── triggers.test.ts
    └── integration/
        └── plugin.test.ts
```

## Design Decisions

### Authentication Strategy

Priority order based on common GCP patterns:
1. Explicit `serviceAccountKey` in config (highest priority)
2. Application Default Credentials (ADC) as fallback
3. Fail with clear error if neither available

This follows GCP SDK conventions where explicit credentials override ambient authentication.

### Error Handling

Automatic retry with exponential backoff for transient errors:
- Network timeouts
- Rate limits (429 responses)
- Service unavailable (503)

Non-retryable errors (permissions, not found) surface immediately.
Default: 3 retry attempts with configurable backoff.

### Log Streaming

Real-time streaming with automatic completion:
- AsyncIterable interface for consumer control
- Stream ends automatically when build completes
- Polling interval configurable (default 2s)
- No excessive buffering - backpressure applies naturally via async iteration

### Artifact Handling

Dual-mode artifact access:
- `getArtifact()` returns Buffer for files up to 100MB
- `getArtifactStream()` returns ReadableStream for large files
- Size check performed before download

### Build Filters

Standard filter set covering common use cases:
- Status filter (QUEUED, WORKING, SUCCESS, FAILURE, etc.)
- Trigger ID filter
- Time range (start/end timestamps)
- Pagination (pageSize, pageToken)

## API Design

### Main Plugin Interface

```typescript
interface CloudBuildPlugin {
  // Build operations
  triggerBuild(triggerId: string, source?: BuildSource): Promise<Build>;
  runBuild(config: BuildConfig): Promise<Build>;
  getBuild(buildId: string): Promise<Build>;
  listBuilds(filter?: BuildFilter): Promise<PaginatedResult<Build>>;
  cancelBuild(buildId: string): Promise<void>;
  retryBuild(buildId: string): Promise<Build>;

  // Logs
  streamLogs(buildId: string): AsyncIterable<LogEntry>;

  // Artifacts
  listArtifacts(buildId: string): Promise<Artifact[]>;
  getArtifact(buildId: string, path: string): Promise<Buffer>;
  getArtifactStream(buildId: string, path: string): Promise<ReadableStream>;

  // Triggers
  listTriggers(): Promise<BuildTrigger[]>;
  createTrigger(config: TriggerConfig): Promise<BuildTrigger>;
  updateTrigger(triggerId: string, config: Partial<TriggerConfig>): Promise<BuildTrigger>;
  deleteTrigger(triggerId: string): Promise<void>;
}
```

### Configuration Schema

```typescript
const CloudBuildConfigSchema = z.object({
  projectId: z.string().min(1),
  location: z.string().default('global'),
  serviceAccountKey: z.string().optional(),
  defaultTrigger: z.string().optional(),
  artifactBucket: z.string().optional(),
  retry: z.object({
    maxAttempts: z.number().int().min(0).max(10).default(3),
    initialDelayMs: z.number().int().min(100).default(1000),
    maxDelayMs: z.number().int().min(1000).default(30000),
  }).optional(),
  logPollingIntervalMs: z.number().int().min(500).default(2000),
});
```

## Implementation Phases

### Phase 1: Foundation
- Package setup and configuration
- Authentication provider
- Base client wrapper
- Error classes

### Phase 2: Core Operations
- Build triggering (triggerBuild, runBuild)
- Build monitoring (getBuild, listBuilds)
- Build lifecycle (cancelBuild, retryBuild)

### Phase 3: Streaming & Artifacts
- Log streaming with AsyncIterable
- Artifact listing
- Artifact download (Buffer and Stream modes)

### Phase 4: Trigger Management
- List triggers
- Create/update/delete triggers
- Trigger configuration validation

### Phase 5: Integration & Testing
- Unit tests for all operations
- Integration tests with emulator or live API
- Documentation and examples

## Constitution Check

N/A - No constitution.md found in `.specify/memory/`.

## Integration Points

### Orchestrator
The plugin will be registered with the orchestrator for:
- Build status polling and event emission
- Webhook handling for build completion notifications

### Workflow Engine
Workflow steps can invoke the plugin for:
- CI/CD automation
- Deployment pipelines
- Build-triggered workflows

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| Large artifact memory pressure | Streaming API for artifacts > 100MB |
| API rate limits | Exponential backoff with jitter |
| Long-running builds | Async polling with configurable intervals |
| Auth credential exposure | Zod redaction in logging, secure config handling |

## Next Steps

Run `/speckit:tasks` to generate the detailed task breakdown.

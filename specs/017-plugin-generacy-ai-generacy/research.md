# Research: @generacy-ai/generacy-plugin-cloud-build

## Technology Decisions

### Google Cloud Build Client Library

**Decision**: Use `@google-cloud/cloudbuild` v4.x

**Rationale**:
- Official Google Cloud client library with full TypeScript support
- Covers all Cloud Build API operations
- Built-in authentication handling (ADC, service accounts)
- Automatic retry for transient failures
- Well-maintained with regular updates

**Alternatives Considered**:
| Alternative | Pros | Cons |
|-------------|------|------|
| Direct REST API | Full control, no dependencies | Manual auth, pagination, error handling |
| gcloud CLI wrapper | Simple, familiar | Process overhead, parsing complexity |
| Third-party clients | Potentially simpler API | Maintenance risk, incomplete coverage |

### Artifact Storage Access

**Decision**: Use `@google-cloud/storage` for artifact downloads

**Rationale**:
- Cloud Build artifacts are stored in GCS
- Native streaming support for large files
- Consistent authentication with Cloud Build client
- Resumable downloads for reliability

### Streaming Pattern

**Decision**: AsyncIterable with polling

**Rationale**:
- Cloud Build logs API requires polling (no native streaming)
- AsyncIterable provides natural backpressure
- Allows consumers to control iteration pace
- Clean integration with `for await...of` syntax

**Implementation Pattern**:
```typescript
async function* streamLogs(buildId: string): AsyncIterable<LogEntry> {
  let offset = 0;
  let buildComplete = false;

  while (!buildComplete) {
    const { entries, nextOffset, isComplete } = await fetchLogChunk(buildId, offset);
    for (const entry of entries) {
      yield entry;
    }
    offset = nextOffset;
    buildComplete = isComplete;

    if (!buildComplete) {
      await delay(pollingInterval);
    }
  }
}
```

### Error Classification

**Decision**: Categorize errors for retry decisions

**Categories**:
| Type | Retry | Examples |
|------|-------|----------|
| Transient | Yes | 429, 503, ECONNRESET, ETIMEDOUT |
| Client | No | 400, 404, 403 |
| Auth | No | 401, invalid credentials |
| Server | Maybe | 500 (with backoff) |

### Retry Strategy

**Decision**: Exponential backoff with jitter

**Parameters**:
- Initial delay: 1000ms
- Max delay: 30000ms
- Max attempts: 3
- Jitter: ±20%

**Formula**:
```typescript
delay = min(maxDelay, initialDelay * 2^attempt) * (0.8 + random() * 0.4)
```

## Implementation Patterns

### Plugin Initialization

Following Generacy plugin patterns from existing implementations:

```typescript
export class CloudBuildPlugin {
  private client: CloudBuildClient;
  private storage: Storage;
  private config: CloudBuildConfig;
  private logger: Logger;

  constructor(config: CloudBuildConfigInput) {
    this.config = CloudBuildConfigSchema.parse(config);
    this.logger = pino({ name: 'generacy-plugin-cloud-build' });
    this.client = this.initClient();
    this.storage = this.initStorage();
  }

  private initClient(): CloudBuildClient {
    const options: ClientOptions = {
      projectId: this.config.projectId,
    };

    if (this.config.serviceAccountKey) {
      options.credentials = JSON.parse(this.config.serviceAccountKey);
    }
    // Otherwise ADC is used automatically

    return new CloudBuildClient(options);
  }
}
```

### Operation Modules

Each operation module follows consistent patterns:

```typescript
// operations/builds.ts
export class BuildOperations {
  constructor(
    private client: CloudBuildClient,
    private config: CloudBuildConfig,
    private logger: Logger,
  ) {}

  async triggerBuild(triggerId: string, source?: BuildSource): Promise<Build> {
    const request = TriggerBuildRequestSchema.parse({ triggerId, source });

    this.logger.debug({ triggerId }, 'Triggering build');

    const [operation] = await this.client.runBuildTrigger({
      projectId: this.config.projectId,
      triggerId: request.triggerId,
      source: request.source,
    });

    const [build] = await operation.promise();
    return this.mapBuild(build);
  }
}
```

### Type Mapping

Map Google Cloud types to plugin-specific types for stability:

```typescript
private mapBuild(raw: protos.google.devtools.cloudbuild.v1.IBuild): Build {
  return {
    id: raw.id!,
    status: this.mapStatus(raw.status!),
    startTime: raw.startTime ? new Date(raw.startTime.seconds! * 1000) : undefined,
    finishTime: raw.finishTime ? new Date(raw.finishTime.seconds! * 1000) : undefined,
    duration: raw.timing?.['BUILD']?.endTime
      ? (Number(raw.timing['BUILD'].endTime.seconds) - Number(raw.timing['BUILD'].startTime?.seconds || 0))
      : undefined,
    source: this.mapSource(raw.source),
    steps: raw.steps?.map(s => this.mapStep(s)) || [],
    results: this.mapResults(raw.results),
    logUrl: raw.logUrl || undefined,
  };
}
```

## Key Sources

1. [Cloud Build Client Library](https://cloud.google.com/nodejs/docs/reference/cloudbuild/latest)
2. [Cloud Build API Reference](https://cloud.google.com/build/docs/api/reference/rest)
3. [Cloud Storage Client Library](https://cloud.google.com/nodejs/docs/reference/storage/latest)
4. [Existing Generacy Plugins](../../../packages/) - GitHub Issues, Claude Code patterns

## Open Questions Resolved

Based on common GCP patterns and existing codebase conventions:

| Question | Resolution | Rationale |
|----------|------------|-----------|
| Auth priority | serviceAccountKey > ADC | Explicit config takes precedence |
| Error handling | Retry with backoff | Standard for cloud APIs |
| Log streaming | AsyncIterable with polling | Natural backpressure |
| Artifact size | 100MB limit with streaming fallback | Memory safety |
| Build filters | Standard set | Covers common use cases |

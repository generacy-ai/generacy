# Data Model: @generacy-ai/generacy-plugin-cloud-build

## Core Entities

### Build

Represents a Cloud Build execution.

```typescript
interface Build {
  id: string;
  projectId: string;
  status: BuildStatus;
  statusDetail?: string;
  source?: BuildSource;
  steps: BuildStep[];
  results?: BuildResults;
  createTime: Date;
  startTime?: Date;
  finishTime?: Date;
  duration?: number;  // seconds
  timeout?: string;   // duration string e.g. "3600s"
  logUrl?: string;
  logsBucket?: string;
  buildTriggerId?: string;
  options?: BuildOptions;
  substitutions?: Record<string, string>;
  tags?: string[];
  artifacts?: BuildArtifacts;
  serviceAccount?: string;
}

type BuildStatus =
  | 'STATUS_UNKNOWN'
  | 'PENDING'
  | 'QUEUED'
  | 'WORKING'
  | 'SUCCESS'
  | 'FAILURE'
  | 'INTERNAL_ERROR'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'EXPIRED';
```

### BuildSource

Source code location for builds.

```typescript
interface BuildSource {
  storageSource?: StorageSource;
  repoSource?: RepoSource;
  gitSource?: GitSource;
}

interface StorageSource {
  bucket: string;
  object: string;
  generation?: string;
}

interface RepoSource {
  projectId?: string;
  repoName: string;
  branchName?: string;
  tagName?: string;
  commitSha?: string;
  dir?: string;
}

interface GitSource {
  url: string;
  revision?: string;
  dir?: string;
}
```

### BuildStep

Individual step within a build.

```typescript
interface BuildStep {
  id?: string;
  name: string;           // Container image
  entrypoint?: string;
  args?: string[];
  dir?: string;
  env?: string[];
  secretEnv?: string[];
  waitFor?: string[];
  timeout?: string;
  status: BuildStepStatus;
  timing?: TimeSpan;
  pullTiming?: TimeSpan;
  volumes?: Volume[];
  script?: string;
}

type BuildStepStatus =
  | 'STATUS_UNKNOWN'
  | 'PENDING'
  | 'QUEUED'
  | 'WORKING'
  | 'SUCCESS'
  | 'FAILURE'
  | 'INTERNAL_ERROR'
  | 'TIMEOUT'
  | 'CANCELLED';

interface TimeSpan {
  startTime: Date;
  endTime: Date;
}

interface Volume {
  name: string;
  path: string;
}
```

### BuildResults

Results of a completed build.

```typescript
interface BuildResults {
  images?: BuiltImage[];
  buildStepImages?: string[];
  artifactManifest?: string;
  numArtifacts?: number;
  buildStepOutputs?: Buffer[];
  artifactTiming?: TimeSpan;
}

interface BuiltImage {
  name: string;
  digest: string;
  pushTiming?: TimeSpan;
}
```

### BuildConfig

Configuration for running a build directly.

```typescript
interface BuildConfig {
  steps: BuildStepConfig[];
  source?: BuildSource;
  timeout?: string;
  machineType?: MachineType;
  diskSizeGb?: number;
  substitutions?: Record<string, string>;
  tags?: string[];
  secrets?: Secret[];
  availableSecrets?: Secrets;
  serviceAccount?: string;
  logsBucket?: string;
  options?: BuildOptions;
  artifacts?: ArtifactsConfig;
}

interface BuildStepConfig {
  name: string;
  entrypoint?: string;
  args?: string[];
  dir?: string;
  env?: string[];
  secretEnv?: string[];
  waitFor?: string[];
  timeout?: string;
  volumes?: Volume[];
  script?: string;
}

type MachineType =
  | 'UNSPECIFIED'
  | 'N1_HIGHCPU_8'
  | 'N1_HIGHCPU_32'
  | 'E2_HIGHCPU_8'
  | 'E2_HIGHCPU_32'
  | 'E2_MEDIUM';
```

### BuildTrigger

Build trigger configuration.

```typescript
interface BuildTrigger {
  id: string;
  name: string;
  description?: string;
  disabled: boolean;
  createTime: Date;
  tags?: string[];
  triggerTemplate?: RepoSource;
  github?: GitHubConfig;
  pubsubConfig?: PubsubConfig;
  webhookConfig?: WebhookConfig;
  autodetect?: boolean;
  build?: BuildConfig;
  filename?: string;  // cloudbuild.yaml path
  filter?: string;
  sourceToBuild?: GitRepoSource;
  serviceAccount?: string;
  includeBuildLogs?: 'INCLUDE_BUILD_LOGS_UNSPECIFIED' | 'INCLUDE_BUILD_LOGS_WITH_STATUS';
}

interface GitHubConfig {
  owner: string;
  name: string;
  pullRequest?: PullRequestFilter;
  push?: PushFilter;
  installationId?: string;
}

interface PullRequestFilter {
  branch: string;
  commentControl?: 'COMMENTS_DISABLED' | 'COMMENTS_ENABLED' | 'COMMENTS_ENABLED_FOR_EXTERNAL_CONTRIBUTORS_ONLY';
  invertRegex?: boolean;
}

interface PushFilter {
  branch?: string;
  tag?: string;
  invertRegex?: boolean;
}
```

### TriggerConfig

Configuration for creating/updating triggers.

```typescript
interface TriggerConfig {
  name: string;
  description?: string;
  disabled?: boolean;
  tags?: string[];
  triggerTemplate?: RepoSource;
  github?: GitHubConfig;
  includedFiles?: string[];
  ignoredFiles?: string[];
  substitutions?: Record<string, string>;
  build?: BuildConfig;
  filename?: string;
  filter?: string;
  serviceAccount?: string;
}
```

### LogEntry

Log entry from build output.

```typescript
interface LogEntry {
  timestamp: Date;
  severity: LogSeverity;
  message: string;
  stepId?: string;
  textPayload?: string;
  jsonPayload?: Record<string, unknown>;
  insertId?: string;
}

type LogSeverity =
  | 'DEFAULT'
  | 'DEBUG'
  | 'INFO'
  | 'NOTICE'
  | 'WARNING'
  | 'ERROR'
  | 'CRITICAL'
  | 'ALERT'
  | 'EMERGENCY';
```

### Artifact

Build artifact information.

```typescript
interface Artifact {
  path: string;
  bucket: string;
  size: number;
  contentType?: string;
  generation?: string;
  md5Hash?: string;
  crc32c?: string;
  updated: Date;
}

interface ArtifactsConfig {
  images?: string[];
  objects?: {
    location: string;
    paths: string[];
  };
  mavenArtifacts?: MavenArtifact[];
  pythonPackages?: PythonPackage[];
  npmPackages?: NpmPackage[];
}
```

### BuildFilter

Filter parameters for listing builds.

```typescript
interface BuildFilter {
  status?: BuildStatus | BuildStatus[];
  triggerId?: string;
  startTime?: {
    after?: Date;
    before?: Date;
  };
  tags?: string[];
  pageSize?: number;
  pageToken?: string;
}

interface PaginatedResult<T> {
  items: T[];
  nextPageToken?: string;
  totalSize?: number;
}
```

## Configuration

### CloudBuildConfig

Plugin configuration.

```typescript
interface CloudBuildConfig {
  projectId: string;
  location: string;  // default: 'global'
  serviceAccountKey?: string;
  defaultTrigger?: string;
  artifactBucket?: string;
  retry: RetryConfig;
  logPollingIntervalMs: number;
}

interface RetryConfig {
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
}
```

## Validation Rules

### Build Validation

- `timeout` must be valid duration string (e.g., "3600s")
- `substitutions` keys must match `^_[A-Z0-9_]+$`
- At least one step required for direct builds
- Step names must be valid container image references

### Trigger Validation

- `name` must match `^[a-z][a-z0-9-]*$`
- Either `build` or `filename` required
- GitHub config requires valid owner/name
- Branch/tag patterns must be valid regex

### Filter Validation

- `pageSize` must be 1-1000
- Date range must have `after` <= `before` if both specified
- `triggerId` must be valid UUID format

## Entity Relationships

```
CloudBuildPlugin
    ├── manages → Build (1:many)
    │              ├── contains → BuildStep (1:many)
    │              ├── has → BuildSource (1:1 optional)
    │              ├── has → BuildResults (1:1 optional)
    │              └── produces → Artifact (1:many)
    │
    ├── manages → BuildTrigger (1:many)
    │              └── references → BuildConfig (1:1)
    │
    └── streams → LogEntry (async iteration)
```

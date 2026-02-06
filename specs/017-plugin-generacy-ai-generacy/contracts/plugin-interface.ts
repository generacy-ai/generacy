/**
 * @generacy-ai/generacy-plugin-cloud-build
 * Plugin Interface Contract
 */

// ============================================================================
// Configuration
// ============================================================================

export interface CloudBuildConfig {
  projectId: string;
  location?: string;  // default: 'global'
  serviceAccountKey?: string;
  defaultTrigger?: string;
  artifactBucket?: string;
  retry?: RetryConfig;
  logPollingIntervalMs?: number;
}

export interface RetryConfig {
  maxAttempts?: number;  // default: 3
  initialDelayMs?: number;  // default: 1000
  maxDelayMs?: number;  // default: 30000
}

// ============================================================================
// Build Types
// ============================================================================

export type BuildStatus =
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

export interface Build {
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
  duration?: number;
  timeout?: string;
  logUrl?: string;
  logsBucket?: string;
  buildTriggerId?: string;
  substitutions?: Record<string, string>;
  tags?: string[];
  serviceAccount?: string;
}

export interface BuildSource {
  storageSource?: StorageSource;
  repoSource?: RepoSource;
  gitSource?: GitSource;
}

export interface StorageSource {
  bucket: string;
  object: string;
  generation?: string;
}

export interface RepoSource {
  projectId?: string;
  repoName: string;
  branchName?: string;
  tagName?: string;
  commitSha?: string;
  dir?: string;
}

export interface GitSource {
  url: string;
  revision?: string;
  dir?: string;
}

export type BuildStepStatus =
  | 'STATUS_UNKNOWN'
  | 'PENDING'
  | 'QUEUED'
  | 'WORKING'
  | 'SUCCESS'
  | 'FAILURE'
  | 'INTERNAL_ERROR'
  | 'TIMEOUT'
  | 'CANCELLED';

export interface BuildStep {
  id?: string;
  name: string;
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
  script?: string;
}

export interface TimeSpan {
  startTime: Date;
  endTime: Date;
}

export interface BuildResults {
  images?: BuiltImage[];
  buildStepImages?: string[];
  artifactManifest?: string;
  numArtifacts?: number;
  buildStepOutputs?: Buffer[];
  artifactTiming?: TimeSpan;
}

export interface BuiltImage {
  name: string;
  digest: string;
  pushTiming?: TimeSpan;
}

// ============================================================================
// Build Configuration
// ============================================================================

export interface BuildConfig {
  steps: BuildStepConfig[];
  source?: BuildSource;
  timeout?: string;
  machineType?: MachineType;
  diskSizeGb?: number;
  substitutions?: Record<string, string>;
  tags?: string[];
  serviceAccount?: string;
  logsBucket?: string;
  artifacts?: ArtifactsConfig;
}

export interface BuildStepConfig {
  name: string;
  entrypoint?: string;
  args?: string[];
  dir?: string;
  env?: string[];
  secretEnv?: string[];
  waitFor?: string[];
  timeout?: string;
  script?: string;
}

export type MachineType =
  | 'UNSPECIFIED'
  | 'N1_HIGHCPU_8'
  | 'N1_HIGHCPU_32'
  | 'E2_HIGHCPU_8'
  | 'E2_HIGHCPU_32'
  | 'E2_MEDIUM';

export interface ArtifactsConfig {
  images?: string[];
  objects?: {
    location: string;
    paths: string[];
  };
}

// ============================================================================
// Build Triggers
// ============================================================================

export interface BuildTrigger {
  id: string;
  name: string;
  description?: string;
  disabled: boolean;
  createTime: Date;
  tags?: string[];
  triggerTemplate?: RepoSource;
  github?: GitHubConfig;
  autodetect?: boolean;
  build?: BuildConfig;
  filename?: string;
  filter?: string;
  serviceAccount?: string;
}

export interface GitHubConfig {
  owner: string;
  name: string;
  pullRequest?: PullRequestFilter;
  push?: PushFilter;
  installationId?: string;
}

export interface PullRequestFilter {
  branch: string;
  commentControl?: 'COMMENTS_DISABLED' | 'COMMENTS_ENABLED' | 'COMMENTS_ENABLED_FOR_EXTERNAL_CONTRIBUTORS_ONLY';
  invertRegex?: boolean;
}

export interface PushFilter {
  branch?: string;
  tag?: string;
  invertRegex?: boolean;
}

export interface TriggerConfig {
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

// ============================================================================
// Logs
// ============================================================================

export type LogSeverity =
  | 'DEFAULT'
  | 'DEBUG'
  | 'INFO'
  | 'NOTICE'
  | 'WARNING'
  | 'ERROR'
  | 'CRITICAL'
  | 'ALERT'
  | 'EMERGENCY';

export interface LogEntry {
  timestamp: Date;
  severity: LogSeverity;
  message: string;
  stepId?: string;
  textPayload?: string;
  jsonPayload?: Record<string, unknown>;
  insertId?: string;
}

// ============================================================================
// Artifacts
// ============================================================================

export interface Artifact {
  path: string;
  bucket: string;
  size: number;
  contentType?: string;
  generation?: string;
  md5Hash?: string;
  crc32c?: string;
  updated: Date;
}

// ============================================================================
// Filters & Pagination
// ============================================================================

export interface BuildFilter {
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

export interface PaginatedResult<T> {
  items: T[];
  nextPageToken?: string;
  totalSize?: number;
}

// ============================================================================
// Plugin Interface
// ============================================================================

export interface CloudBuildPlugin {
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

// ============================================================================
// Errors
// ============================================================================

export type CloudBuildErrorCode =
  | 'AUTH_FAILED'
  | 'PERMISSION_DENIED'
  | 'NOT_FOUND'
  | 'ALREADY_EXISTS'
  | 'INVALID_ARGUMENT'
  | 'RESOURCE_EXHAUSTED'
  | 'FAILED_PRECONDITION'
  | 'UNAVAILABLE'
  | 'INTERNAL'
  | 'DEADLINE_EXCEEDED'
  | 'CANCELLED'
  | 'UNKNOWN';

export interface CloudBuildError extends Error {
  code: CloudBuildErrorCode;
  isTransient: boolean;
  details?: Record<string, unknown>;
}

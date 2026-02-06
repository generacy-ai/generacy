/**
 * Build-related types for the Cloud Build plugin.
 */

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

export type MachineType =
  | 'UNSPECIFIED'
  | 'N1_HIGHCPU_8'
  | 'N1_HIGHCPU_32'
  | 'E2_HIGHCPU_8'
  | 'E2_HIGHCPU_32'
  | 'E2_MEDIUM';

export interface TimeSpan {
  startTime: Date;
  endTime: Date;
}

export interface Volume {
  name: string;
  path: string;
}

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
  volumes?: Volume[];
  script?: string;
}

export interface BuiltImage {
  name: string;
  digest: string;
  pushTiming?: TimeSpan;
}

export interface BuildResults {
  images?: BuiltImage[];
  buildStepImages?: string[];
  artifactManifest?: string;
  numArtifacts?: number;
  buildStepOutputs?: Buffer[];
  artifactTiming?: TimeSpan;
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

export interface BuildSource {
  storageSource?: StorageSource;
  repoSource?: RepoSource;
  gitSource?: GitSource;
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
  volumes?: Volume[];
  script?: string;
}

export interface ArtifactsConfig {
  images?: string[];
  objects?: {
    location: string;
    paths: string[];
  };
}

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

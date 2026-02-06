/**
 * Trigger-related types for the Cloud Build plugin.
 */

import type { BuildConfig, RepoSource } from './builds.js';

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

export interface GitHubConfig {
  owner: string;
  name: string;
  pullRequest?: PullRequestFilter;
  push?: PushFilter;
  installationId?: string;
}

export interface PubsubConfig {
  subscription: string;
  topic?: string;
  serviceAccountEmail?: string;
  state?: 'STATE_UNSPECIFIED' | 'OK' | 'SUBSCRIPTION_DELETED' | 'TOPIC_DELETED' | 'SUBSCRIPTION_MISCONFIGURED';
}

export interface WebhookConfig {
  secret: string;
  state?: 'STATE_UNSPECIFIED' | 'OK' | 'SECRET_DELETED';
}

export interface GitRepoSource {
  uri: string;
  ref?: string;
  repoType?: 'UNKNOWN' | 'CLOUD_SOURCE_REPOSITORIES' | 'GITHUB' | 'BITBUCKET_SERVER' | 'GITLAB';
}

export interface BuildTrigger {
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
  filename?: string;
  filter?: string;
  sourceToBuild?: GitRepoSource;
  serviceAccount?: string;
  includeBuildLogs?: 'INCLUDE_BUILD_LOGS_UNSPECIFIED' | 'INCLUDE_BUILD_LOGS_WITH_STATUS';
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

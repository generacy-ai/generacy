/**
 * Trigger operations for the Cloud Build plugin.
 *
 * Handles:
 * - Listing triggers
 * - Creating triggers
 * - Updating triggers
 * - Deleting triggers
 */

import type { CloudBuildClient } from '@google-cloud/cloudbuild';
import type { google } from '@google-cloud/cloudbuild/build/protos/protos.js';
import type { Logger } from 'pino';
import type { CloudBuildConfig } from '../config/types.js';
import type { BuildTrigger, TriggerConfig, GitHubConfig, PullRequestFilter } from '../types/triggers.js';
import type { BuildConfig, RepoSource } from '../types/builds.js';
import { NotFoundError, ValidationError } from '../errors.js';
import { mapApiError } from '../client.js';
import { withRetry, shouldRetryError } from '../utils/retry.js';
import { TriggerNameSchema } from '../utils/validation.js';

type IBuildTrigger = google.devtools.cloudbuild.v1.IBuildTrigger;
type IRepoSource = google.devtools.cloudbuild.v1.IRepoSource;

export class TriggerOperations {
  constructor(
    private readonly client: CloudBuildClient,
    private readonly config: CloudBuildConfig,
    private readonly logger: Logger
  ) {}

  /**
   * List all build triggers.
   */
  async listTriggers(): Promise<BuildTrigger[]> {
    this.logger.debug('Listing triggers');

    try {
      const [triggers] = await this.withRetry(() =>
        this.client.listBuildTriggers({
          projectId: this.config.projectId,
        })
      );

      return (triggers as IBuildTrigger[]).map(trigger => this.mapTrigger(trigger));
    } catch (error) {
      throw mapApiError(error);
    }
  }

  /**
   * Create a new build trigger.
   */
  async createTrigger(triggerConfig: TriggerConfig): Promise<BuildTrigger> {
    this.logger.debug({ name: triggerConfig.name }, 'Creating trigger');

    // Validate trigger name
    const nameValidation = TriggerNameSchema.safeParse(triggerConfig.name);
    if (!nameValidation.success) {
      throw new ValidationError(
        nameValidation.error.errors[0]?.message ?? 'Invalid trigger name',
        'name'
      );
    }

    // Validate that either build or filename is provided
    if (!triggerConfig.build && !triggerConfig.filename) {
      throw new ValidationError(
        'Either build configuration or filename must be provided',
        'build|filename'
      );
    }

    try {
      const [trigger] = await this.withRetry(() =>
        this.client.createBuildTrigger({
          projectId: this.config.projectId,
          trigger: this.mapTriggerConfigToRequest(triggerConfig),
        })
      );

      return this.mapTrigger(trigger as IBuildTrigger);
    } catch (error) {
      throw mapApiError(error, { name: triggerConfig.name });
    }
  }

  /**
   * Update an existing build trigger.
   */
  async updateTrigger(triggerId: string, triggerConfig: Partial<TriggerConfig>): Promise<BuildTrigger> {
    this.logger.debug({ triggerId }, 'Updating trigger');

    // Validate trigger name if provided
    if (triggerConfig.name) {
      const nameValidation = TriggerNameSchema.safeParse(triggerConfig.name);
      if (!nameValidation.success) {
        throw new ValidationError(
          nameValidation.error.errors[0]?.message ?? 'Invalid trigger name',
          'name'
        );
      }
    }

    try {
      // First get the existing trigger
      const [existing] = await this.withRetry(() =>
        this.client.getBuildTrigger({
          projectId: this.config.projectId,
          triggerId,
        })
      );

      if (!existing) {
        throw new NotFoundError('Trigger', triggerId);
      }

      // Merge with updates
      const updatedTrigger: IBuildTrigger = {
        ...existing,
        ...this.mapTriggerConfigToRequest(triggerConfig as TriggerConfig),
        id: triggerId,
      };

      const [trigger] = await this.withRetry(() =>
        this.client.updateBuildTrigger({
          projectId: this.config.projectId,
          triggerId,
          trigger: updatedTrigger,
        })
      );

      return this.mapTrigger(trigger as IBuildTrigger);
    } catch (error) {
      if (error instanceof NotFoundError) {
        throw error;
      }
      throw mapApiError(error, { triggerId });
    }
  }

  /**
   * Delete a build trigger.
   */
  async deleteTrigger(triggerId: string): Promise<void> {
    this.logger.debug({ triggerId }, 'Deleting trigger');

    try {
      await this.withRetry(() =>
        this.client.deleteBuildTrigger({
          projectId: this.config.projectId,
          triggerId,
        })
      );
    } catch (error) {
      throw mapApiError(error, { triggerId });
    }
  }

  /**
   * Execute operation with retry logic.
   */
  private async withRetry<T>(operation: () => Promise<T>): Promise<T> {
    return withRetry(operation, {
      ...this.config.retry,
      shouldRetry: shouldRetryError,
      onRetry: (error, attempt, delayMs) => {
        this.logger.warn({ error, attempt, delayMs }, 'Retrying trigger operation');
      },
    });
  }

  /**
   * Map TriggerConfig to API request format.
   */
  private mapTriggerConfigToRequest(config: TriggerConfig): IBuildTrigger {
    return {
      name: config.name,
      description: config.description,
      disabled: config.disabled ?? false,
      tags: config.tags,
      triggerTemplate: config.triggerTemplate ? this.mapRepoSourceToRequest(config.triggerTemplate) : undefined,
      github: config.github ? this.mapGitHubConfigToRequest(config.github) : undefined,
      includedFiles: config.includedFiles,
      ignoredFiles: config.ignoredFiles,
      substitutions: config.substitutions,
      build: config.build ? this.mapBuildConfigToRequest(config.build) : undefined,
      filename: config.filename,
      filter: config.filter,
      serviceAccount: config.serviceAccount,
    };
  }

  /**
   * Map RepoSource to API request format.
   */
  private mapRepoSourceToRequest(source: RepoSource): IRepoSource {
    return {
      projectId: source.projectId,
      repoName: source.repoName,
      branchName: source.branchName,
      tagName: source.tagName,
      commitSha: source.commitSha,
      dir: source.dir,
    };
  }

  /**
   * Map GitHubConfig to API request format.
   */
  private mapGitHubConfigToRequest(config: GitHubConfig) {
    return {
      owner: config.owner,
      name: config.name,
      pullRequest: config.pullRequest ? {
        branch: config.pullRequest.branch,
        commentControl: config.pullRequest.commentControl,
        invertRegex: config.pullRequest.invertRegex,
      } : undefined,
      push: config.push ? {
        branch: config.push.branch,
        tag: config.push.tag,
        invertRegex: config.push.invertRegex,
      } : undefined,
    };
  }

  /**
   * Map BuildConfig to API request format.
   */
  private mapBuildConfigToRequest(config: BuildConfig) {
    return {
      steps: config.steps.map(step => ({
        name: step.name,
        entrypoint: step.entrypoint,
        args: step.args,
        dir: step.dir,
        env: step.env,
        secretEnv: step.secretEnv,
        waitFor: step.waitFor,
        timeout: step.timeout ? { seconds: parseInt(step.timeout) } : undefined,
        script: step.script,
      })),
      timeout: config.timeout ? { seconds: parseInt(config.timeout) } : undefined,
      substitutions: config.substitutions,
      tags: config.tags,
      serviceAccount: config.serviceAccount,
      logsBucket: config.logsBucket,
      artifacts: config.artifacts ? {
        images: config.artifacts.images,
        objects: config.artifacts.objects ? {
          location: config.artifacts.objects.location,
          paths: config.artifacts.objects.paths,
        } : undefined,
      } : undefined,
    };
  }

  /**
   * Map API trigger response to BuildTrigger type.
   */
  private mapTrigger(trigger: IBuildTrigger): BuildTrigger {
    return {
      id: trigger.id ?? '',
      name: trigger.name ?? '',
      description: trigger.description ?? undefined,
      disabled: trigger.disabled ?? false,
      createTime: this.toDate(trigger.createTime) ?? new Date(),
      tags: trigger.tags as string[] | undefined,
      triggerTemplate: trigger.triggerTemplate ? this.mapRepoSource(trigger.triggerTemplate) : undefined,
      github: trigger.github ? this.mapGitHubConfigFromProto(trigger.github) : undefined,
      autodetect: trigger.autodetect ?? undefined,
      build: trigger.build ? this.mapBuildConfig(trigger.build) : undefined,
      filename: trigger.filename ?? undefined,
      filter: trigger.filter ?? undefined,
      serviceAccount: trigger.serviceAccount ?? undefined,
    };
  }

  /**
   * Map RepoSource from API response.
   */
  private mapRepoSource(source: IRepoSource): RepoSource {
    return {
      projectId: source.projectId ?? undefined,
      repoName: source.repoName ?? '',
      branchName: source.branchName ?? undefined,
      tagName: source.tagName ?? undefined,
      commitSha: source.commitSha ?? undefined,
      dir: source.dir ?? undefined,
    };
  }

  /**
   * Map GitHubConfig from API response proto.
   */
  private mapGitHubConfigFromProto(config: google.devtools.cloudbuild.v1.IGitHubEventsConfig): GitHubConfig {
    return {
      owner: config.owner ?? '',
      name: config.name ?? '',
      pullRequest: config.pullRequest ? {
        branch: config.pullRequest.branch ?? '',
        commentControl: config.pullRequest.commentControl as PullRequestFilter['commentControl'],
        invertRegex: config.pullRequest.invertRegex ?? undefined,
      } : undefined,
      push: config.push ? {
        branch: config.push.branch ?? undefined,
        tag: config.push.tag ?? undefined,
        invertRegex: config.push.invertRegex ?? undefined,
      } : undefined,
      installationId: config.installationId?.toString(),
    };
  }

  /**
   * Map BuildConfig from API response.
   */
  private mapBuildConfig(build: { steps?: Array<{ name?: string | null; entrypoint?: string | null; args?: string[] | null; dir?: string | null; env?: string[] | null; secretEnv?: string[] | null; waitFor?: string[] | null; timeout?: { seconds?: number | Long | string | null } | null; script?: string | null }> | null; timeout?: { seconds?: number | Long | string | null } | null; substitutions?: Record<string, string> | null; tags?: string[] | null; serviceAccount?: string | null; logsBucket?: string | null; artifacts?: { images?: string[] | null; objects?: { location?: string | null; paths?: string[] | null } | null } | null }): BuildConfig {
    return {
      steps: (build.steps ?? []).map(step => ({
        name: step.name ?? '',
        entrypoint: step.entrypoint ?? undefined,
        args: step.args as string[] | undefined,
        dir: step.dir ?? undefined,
        env: step.env as string[] | undefined,
        secretEnv: step.secretEnv as string[] | undefined,
        waitFor: step.waitFor as string[] | undefined,
        timeout: step.timeout?.seconds ? `${step.timeout.seconds}s` : undefined,
        script: step.script ?? undefined,
      })),
      timeout: build.timeout?.seconds ? `${build.timeout.seconds}s` : undefined,
      substitutions: build.substitutions as Record<string, string> | undefined,
      tags: build.tags as string[] | undefined,
      serviceAccount: build.serviceAccount ?? undefined,
      logsBucket: build.logsBucket ?? undefined,
      artifacts: build.artifacts ? {
        images: build.artifacts.images as string[] | undefined,
        objects: build.artifacts.objects ? {
          location: build.artifacts.objects.location ?? '',
          paths: build.artifacts.objects.paths as string[] ?? [],
        } : undefined,
      } : undefined,
    };
  }

  /**
   * Convert protobuf timestamp to Date.
   */
  private toDate(timestamp: { seconds?: number | Long | string | null; nanos?: number | null } | null | undefined): Date | undefined {
    if (!timestamp?.seconds) return undefined;
    const seconds = typeof timestamp.seconds === 'object'
      ? Number(timestamp.seconds.toString())
      : Number(timestamp.seconds);
    return new Date(seconds * 1000 + (timestamp.nanos ?? 0) / 1000000);
  }
}

// Helper for Long type
type Long = { toString(): string };

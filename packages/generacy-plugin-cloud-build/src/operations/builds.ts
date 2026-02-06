/**
 * Build operations for the Cloud Build plugin.
 *
 * Handles:
 * - Build triggering (triggerBuild, runBuild)
 * - Build monitoring (getBuild, listBuilds)
 * - Build lifecycle (cancelBuild, retryBuild)
 */

import type { CloudBuildClient } from '@google-cloud/cloudbuild';
import type { google } from '@google-cloud/cloudbuild/build/protos/protos.js';
import type { Logger } from 'pino';
import type { CloudBuildConfig } from '../config/types.js';
import type {
  Build,
  BuildConfig,
  BuildFilter,
  BuildSource,
  BuildStatus,
  BuildStep,
  BuildStepStatus,
  BuildResults,
  PaginatedResult,
  TimeSpan,
  BuiltImage,
} from '../types/builds.js';
import { NotFoundError, ValidationError } from '../errors.js';
import { mapApiError } from '../client.js';
import { withRetry, shouldRetryError } from '../utils/retry.js';

type IBuild = google.devtools.cloudbuild.v1.IBuild;
type IBuildStep = google.devtools.cloudbuild.v1.IBuildStep;
type IResults = google.devtools.cloudbuild.v1.IResults;
type ITimeSpan = google.devtools.cloudbuild.v1.ITimeSpan;
type ISource = google.devtools.cloudbuild.v1.ISource;

export class BuildOperations {
  constructor(
    private readonly client: CloudBuildClient,
    private readonly config: CloudBuildConfig,
    private readonly logger: Logger
  ) {}

  /**
   * Trigger a build from an existing trigger.
   */
  async triggerBuild(triggerId: string, source?: BuildSource): Promise<Build> {
    this.logger.debug({ triggerId, source }, 'Triggering build');

    try {
      const [operation] = await this.withRetry(() =>
        this.client.runBuildTrigger({
          projectId: this.config.projectId,
          triggerId,
          source: source?.repoSource ? {
            projectId: source.repoSource.projectId,
            repoName: source.repoSource.repoName,
            branchName: source.repoSource.branchName,
            tagName: source.repoSource.tagName,
            commitSha: source.repoSource.commitSha,
            dir: source.repoSource.dir,
          } : undefined,
        })
      );

      const [response] = await operation.promise();
      return this.mapBuild(response as IBuild);
    } catch (error) {
      throw mapApiError(error, { triggerId });
    }
  }

  /**
   * Run a build from inline configuration.
   */
  async runBuild(buildConfig: BuildConfig): Promise<Build> {
    if (!buildConfig.steps || buildConfig.steps.length === 0) {
      throw new ValidationError('At least one build step is required', 'steps');
    }

    this.logger.debug({ stepCount: buildConfig.steps.length }, 'Running build');

    try {
      const [operation] = await this.withRetry(() =>
        this.client.createBuild({
          projectId: this.config.projectId,
          build: {
            steps: buildConfig.steps.map(step => ({
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
            source: buildConfig.source ? this.mapSourceToRequest(buildConfig.source) : undefined,
            timeout: buildConfig.timeout ? { seconds: parseInt(buildConfig.timeout) } : undefined,
            substitutions: buildConfig.substitutions,
            tags: buildConfig.tags,
            serviceAccount: buildConfig.serviceAccount,
            logsBucket: buildConfig.logsBucket,
            artifacts: buildConfig.artifacts ? {
              images: buildConfig.artifacts.images,
              objects: buildConfig.artifacts.objects ? {
                location: buildConfig.artifacts.objects.location,
                paths: buildConfig.artifacts.objects.paths,
              } : undefined,
            } : undefined,
          },
        })
      );

      const [response] = await operation.promise();
      return this.mapBuild(response as IBuild);
    } catch (error) {
      throw mapApiError(error);
    }
  }

  /**
   * Get a single build by ID.
   */
  async getBuild(buildId: string): Promise<Build> {
    this.logger.debug({ buildId }, 'Getting build');

    try {
      const [build] = await this.withRetry(() =>
        this.client.getBuild({
          projectId: this.config.projectId,
          id: buildId,
        })
      );

      if (!build) {
        throw new NotFoundError('Build', buildId);
      }

      return this.mapBuild(build as IBuild);
    } catch (error) {
      if (error instanceof NotFoundError) {
        throw error;
      }
      throw mapApiError(error, { buildId });
    }
  }

  /**
   * List builds with optional filtering.
   */
  async listBuilds(filter?: BuildFilter): Promise<PaginatedResult<Build>> {
    this.logger.debug({ filter }, 'Listing builds');

    try {
      const filterString = this.buildFilterString(filter);

      const [builds, , response] = await this.withRetry(() =>
        this.client.listBuilds({
          projectId: this.config.projectId,
          filter: filterString || undefined,
          pageSize: filter?.pageSize ?? 50,
          pageToken: filter?.pageToken,
        })
      );

      return {
        items: (builds as IBuild[]).map(build => this.mapBuild(build)),
        nextPageToken: response?.nextPageToken ?? undefined,
      };
    } catch (error) {
      throw mapApiError(error);
    }
  }

  /**
   * Cancel a running build.
   */
  async cancelBuild(buildId: string): Promise<void> {
    this.logger.debug({ buildId }, 'Cancelling build');

    try {
      await this.withRetry(() =>
        this.client.cancelBuild({
          projectId: this.config.projectId,
          id: buildId,
        })
      );
    } catch (error) {
      throw mapApiError(error, { buildId });
    }
  }

  /**
   * Retry a failed build.
   */
  async retryBuild(buildId: string): Promise<Build> {
    this.logger.debug({ buildId }, 'Retrying build');

    try {
      const [operation] = await this.withRetry(() =>
        this.client.retryBuild({
          projectId: this.config.projectId,
          id: buildId,
        })
      );

      const [response] = await operation.promise();
      return this.mapBuild(response as IBuild);
    } catch (error) {
      throw mapApiError(error, { buildId });
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
        this.logger.warn({ error, attempt, delayMs }, 'Retrying operation');
      },
    });
  }

  /**
   * Build filter string for API request.
   */
  private buildFilterString(filter?: BuildFilter): string {
    if (!filter) return '';

    const parts: string[] = [];

    if (filter.status) {
      const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
      const statusFilter = statuses.map(s => `status="${s}"`).join(' OR ');
      parts.push(`(${statusFilter})`);
    }

    if (filter.triggerId) {
      parts.push(`build_trigger_id="${filter.triggerId}"`);
    }

    if (filter.startTime?.after) {
      parts.push(`create_time>="${filter.startTime.after.toISOString()}"`);
    }

    if (filter.startTime?.before) {
      parts.push(`create_time<="${filter.startTime.before.toISOString()}"`);
    }

    if (filter.tags && filter.tags.length > 0) {
      const tagFilter = filter.tags.map(t => `tags="${t}"`).join(' OR ');
      parts.push(`(${tagFilter})`);
    }

    return parts.join(' AND ');
  }

  /**
   * Map Google Cloud Build source to API request format.
   */
  private mapSourceToRequest(source: BuildSource): ISource {
    return {
      storageSource: source.storageSource ? {
        bucket: source.storageSource.bucket,
        object: source.storageSource.object,
        generation: source.storageSource.generation,
      } : undefined,
      repoSource: source.repoSource ? {
        projectId: source.repoSource.projectId,
        repoName: source.repoSource.repoName,
        branchName: source.repoSource.branchName,
        tagName: source.repoSource.tagName,
        commitSha: source.repoSource.commitSha,
        dir: source.repoSource.dir,
      } : undefined,
      gitSource: source.gitSource ? {
        url: source.gitSource.url,
        revision: source.gitSource.revision,
        dir: source.gitSource.dir,
      } : undefined,
    };
  }

  /**
   * Map Google Cloud Build to plugin Build type.
   */
  private mapBuild(raw: IBuild): Build {
    return {
      id: raw.id ?? '',
      projectId: raw.projectId ?? this.config.projectId,
      status: this.mapStatus(raw.status),
      statusDetail: raw.statusDetail ?? undefined,
      source: raw.source ? this.mapSource(raw.source) : undefined,
      steps: (raw.steps ?? []).map(step => this.mapStep(step)),
      results: raw.results ? this.mapResults(raw.results) : undefined,
      createTime: this.toDate(raw.createTime) ?? new Date(),
      startTime: this.toDate(raw.startTime),
      finishTime: this.toDate(raw.finishTime),
      duration: this.calculateDuration(raw),
      timeout: raw.timeout?.seconds ? `${raw.timeout.seconds}s` : undefined,
      logUrl: raw.logUrl ?? undefined,
      logsBucket: raw.logsBucket ?? undefined,
      buildTriggerId: raw.buildTriggerId ?? undefined,
      substitutions: raw.substitutions as Record<string, string> | undefined,
      tags: raw.tags as string[] | undefined,
      serviceAccount: raw.serviceAccount ?? undefined,
    };
  }

  /**
   * Map build status enum.
   */
  private mapStatus(status: number | string | null | undefined): BuildStatus {
    if (status === null || status === undefined) return 'STATUS_UNKNOWN';

    const statusMap: Record<number | string, BuildStatus> = {
      0: 'STATUS_UNKNOWN',
      1: 'PENDING',
      2: 'QUEUED',
      3: 'WORKING',
      4: 'SUCCESS',
      5: 'FAILURE',
      6: 'INTERNAL_ERROR',
      7: 'TIMEOUT',
      8: 'CANCELLED',
      9: 'EXPIRED',
      'STATUS_UNKNOWN': 'STATUS_UNKNOWN',
      'PENDING': 'PENDING',
      'QUEUED': 'QUEUED',
      'WORKING': 'WORKING',
      'SUCCESS': 'SUCCESS',
      'FAILURE': 'FAILURE',
      'INTERNAL_ERROR': 'INTERNAL_ERROR',
      'TIMEOUT': 'TIMEOUT',
      'CANCELLED': 'CANCELLED',
      'EXPIRED': 'EXPIRED',
    };

    return statusMap[status] ?? 'STATUS_UNKNOWN';
  }

  /**
   * Map build step.
   */
  private mapStep(step: IBuildStep): BuildStep {
    return {
      id: step.id ?? undefined,
      name: step.name ?? '',
      entrypoint: step.entrypoint ?? undefined,
      args: step.args as string[] | undefined,
      dir: step.dir ?? undefined,
      env: step.env as string[] | undefined,
      secretEnv: step.secretEnv as string[] | undefined,
      waitFor: step.waitFor as string[] | undefined,
      timeout: step.timeout?.seconds ? `${step.timeout.seconds}s` : undefined,
      status: this.mapStepStatus(step.status),
      timing: step.timing ? this.mapTimeSpan(step.timing) : undefined,
      pullTiming: step.pullTiming ? this.mapTimeSpan(step.pullTiming) : undefined,
      script: step.script ?? undefined,
    };
  }

  /**
   * Map build step status.
   */
  private mapStepStatus(status: number | string | null | undefined): BuildStepStatus {
    if (status === null || status === undefined) return 'STATUS_UNKNOWN';

    const statusMap: Record<number | string, BuildStepStatus> = {
      0: 'STATUS_UNKNOWN',
      1: 'PENDING',
      2: 'QUEUED',
      3: 'WORKING',
      4: 'SUCCESS',
      5: 'FAILURE',
      6: 'INTERNAL_ERROR',
      7: 'TIMEOUT',
      8: 'CANCELLED',
    };

    return statusMap[status] ?? 'STATUS_UNKNOWN';
  }

  /**
   * Map build results.
   */
  private mapResults(results: IResults): BuildResults {
    return {
      images: results.images?.map(img => ({
        name: img.name ?? '',
        digest: img.digest ?? '',
        pushTiming: img.pushTiming ? this.mapTimeSpan(img.pushTiming) : undefined,
      })) as BuiltImage[] | undefined,
      buildStepImages: results.buildStepImages as string[] | undefined,
      artifactManifest: results.artifactManifest ?? undefined,
      numArtifacts: results.numArtifacts ? Number(results.numArtifacts) : undefined,
      artifactTiming: results.artifactTiming ? this.mapTimeSpan(results.artifactTiming) : undefined,
    };
  }

  /**
   * Map source from API response.
   */
  private mapSource(source: ISource): BuildSource {
    return {
      storageSource: source.storageSource ? {
        bucket: source.storageSource.bucket ?? '',
        object: source.storageSource.object ?? '',
        generation: source.storageSource.generation?.toString(),
      } : undefined,
      repoSource: source.repoSource ? {
        projectId: source.repoSource.projectId ?? undefined,
        repoName: source.repoSource.repoName ?? '',
        branchName: source.repoSource.branchName ?? undefined,
        tagName: source.repoSource.tagName ?? undefined,
        commitSha: source.repoSource.commitSha ?? undefined,
        dir: source.repoSource.dir ?? undefined,
      } : undefined,
      gitSource: source.gitSource ? {
        url: source.gitSource.url ?? '',
        revision: source.gitSource.revision ?? undefined,
        dir: source.gitSource.dir ?? undefined,
      } : undefined,
    };
  }

  /**
   * Map time span.
   */
  private mapTimeSpan(span: ITimeSpan): TimeSpan {
    return {
      startTime: this.toDate(span.startTime) ?? new Date(),
      endTime: this.toDate(span.endTime) ?? new Date(),
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

  /**
   * Calculate build duration in seconds.
   */
  private calculateDuration(build: IBuild): number | undefined {
    const startTime = this.toDate(build.startTime);
    const finishTime = this.toDate(build.finishTime);

    if (!startTime || !finishTime) return undefined;

    return Math.round((finishTime.getTime() - startTime.getTime()) / 1000);
  }
}

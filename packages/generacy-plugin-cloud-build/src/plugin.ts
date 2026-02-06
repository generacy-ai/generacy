/**
 * Main Cloud Build Plugin class.
 *
 * Aggregates all operations into a unified plugin interface:
 * - Build operations
 * - Log streaming
 * - Artifact access
 * - Trigger management
 */

import pino, { type Logger } from 'pino';
import type {
  Build,
  BuildConfig,
  BuildFilter,
  BuildSource,
  PaginatedResult,
} from './types/builds.js';
import type { BuildTrigger, TriggerConfig } from './types/triggers.js';
import type { Artifact } from './types/artifacts.js';
import type { LogEntry } from './types/logs.js';
import type { LogStreamOptions } from './streaming/types.js';
import type { CloudBuildConfig, CloudBuildConfigInput } from './config/types.js';
import { parseConfig } from './config/schema.js';
import { createAuthProvider } from './auth/auth-provider.js';
import { BuildOperations } from './operations/builds.js';
import { LogOperations } from './operations/logs.js';
import { ArtifactOperations } from './operations/artifacts.js';
import { TriggerOperations } from './operations/triggers.js';

export interface CloudBuildPluginOptions {
  logger?: Logger;
}

export interface CloudBuildPluginInterface {
  // Build operations
  triggerBuild(triggerId: string, source?: BuildSource): Promise<Build>;
  runBuild(config: BuildConfig): Promise<Build>;
  getBuild(buildId: string): Promise<Build>;
  listBuilds(filter?: BuildFilter): Promise<PaginatedResult<Build>>;
  cancelBuild(buildId: string): Promise<void>;
  retryBuild(buildId: string): Promise<Build>;

  // Logs
  streamLogs(buildId: string, options?: LogStreamOptions): AsyncIterable<LogEntry>;

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

export class CloudBuildPlugin implements CloudBuildPluginInterface {
  private readonly config: CloudBuildConfig;
  private readonly logger: Logger;
  private readonly buildOps: BuildOperations;
  private readonly logOps: LogOperations;
  private readonly artifactOps: ArtifactOperations;
  private readonly triggerOps: TriggerOperations;

  constructor(configInput: CloudBuildConfigInput, options: CloudBuildPluginOptions = {}) {
    // Parse and validate configuration
    this.config = parseConfig(configInput);

    // Create logger with secret redaction
    this.logger = options.logger ?? this.createLogger();

    // Create auth provider
    const authProvider = createAuthProvider({
      projectId: this.config.projectId,
      serviceAccountKey: this.config.serviceAccountKey,
    });

    // Get clients from auth provider
    const cloudBuildClient = authProvider.getCloudBuildClient();
    const storageClient = authProvider.getStorageClient();

    // Initialize operation modules
    this.buildOps = new BuildOperations(cloudBuildClient, this.config, this.logger);
    this.logOps = new LogOperations(cloudBuildClient, storageClient, this.config, this.logger);
    this.artifactOps = new ArtifactOperations(cloudBuildClient, storageClient, this.config, this.logger);
    this.triggerOps = new TriggerOperations(cloudBuildClient, this.config, this.logger);

    this.logger.debug({ projectId: this.config.projectId }, 'Cloud Build plugin initialized');
  }

  // ============================================================================
  // Build Operations
  // ============================================================================

  /**
   * Trigger a build from an existing trigger.
   */
  async triggerBuild(triggerId: string, source?: BuildSource): Promise<Build> {
    return this.buildOps.triggerBuild(triggerId, source);
  }

  /**
   * Run a build from inline configuration.
   */
  async runBuild(config: BuildConfig): Promise<Build> {
    return this.buildOps.runBuild(config);
  }

  /**
   * Get a single build by ID.
   */
  async getBuild(buildId: string): Promise<Build> {
    return this.buildOps.getBuild(buildId);
  }

  /**
   * List builds with optional filtering.
   */
  async listBuilds(filter?: BuildFilter): Promise<PaginatedResult<Build>> {
    return this.buildOps.listBuilds(filter);
  }

  /**
   * Cancel a running build.
   */
  async cancelBuild(buildId: string): Promise<void> {
    return this.buildOps.cancelBuild(buildId);
  }

  /**
   * Retry a failed build.
   */
  async retryBuild(buildId: string): Promise<Build> {
    return this.buildOps.retryBuild(buildId);
  }

  // ============================================================================
  // Log Operations
  // ============================================================================

  /**
   * Stream logs from a build as an AsyncIterable.
   */
  streamLogs(buildId: string, options?: LogStreamOptions): AsyncIterable<LogEntry> {
    return this.logOps.streamLogs(buildId, options);
  }

  // ============================================================================
  // Artifact Operations
  // ============================================================================

  /**
   * List artifacts for a build.
   */
  async listArtifacts(buildId: string): Promise<Artifact[]> {
    return this.artifactOps.listArtifacts(buildId);
  }

  /**
   * Download an artifact as a Buffer.
   * Throws if artifact exceeds 100MB.
   */
  async getArtifact(buildId: string, path: string): Promise<Buffer> {
    return this.artifactOps.getArtifact(buildId, path);
  }

  /**
   * Download an artifact as a ReadableStream.
   * Use for large files that exceed the 100MB Buffer limit.
   */
  async getArtifactStream(buildId: string, path: string): Promise<ReadableStream> {
    return this.artifactOps.getArtifactStream(buildId, path);
  }

  // ============================================================================
  // Trigger Operations
  // ============================================================================

  /**
   * List all build triggers.
   */
  async listTriggers(): Promise<BuildTrigger[]> {
    return this.triggerOps.listTriggers();
  }

  /**
   * Create a new build trigger.
   */
  async createTrigger(config: TriggerConfig): Promise<BuildTrigger> {
    return this.triggerOps.createTrigger(config);
  }

  /**
   * Update an existing build trigger.
   */
  async updateTrigger(triggerId: string, config: Partial<TriggerConfig>): Promise<BuildTrigger> {
    return this.triggerOps.updateTrigger(triggerId, config);
  }

  /**
   * Delete a build trigger.
   */
  async deleteTrigger(triggerId: string): Promise<void> {
    return this.triggerOps.deleteTrigger(triggerId);
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  /**
   * Create a logger with secret redaction.
   */
  private createLogger(): Logger {
    return pino({
      name: 'generacy-plugin-cloud-build',
      level: process.env.LOG_LEVEL ?? 'info',
      redact: {
        paths: [
          'serviceAccountKey',
          'config.serviceAccountKey',
          '*.serviceAccountKey',
          'credentials',
          'private_key',
        ],
        censor: '[REDACTED]',
      },
    });
  }
}

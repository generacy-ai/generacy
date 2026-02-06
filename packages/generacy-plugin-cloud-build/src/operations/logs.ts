/**
 * Log operations for the Cloud Build plugin.
 *
 * Provides log streaming with:
 * - AsyncIterable interface for consumer control
 * - Automatic completion when build finishes
 * - Configurable polling interval
 */

import type { CloudBuildClient } from '@google-cloud/cloudbuild';
import type { Storage } from '@google-cloud/storage';
import type { Logger } from 'pino';
import type { CloudBuildConfig } from '../config/types.js';
import type { LogEntry, LogSeverity } from '../types/logs.js';
import type { LogFetcher, LogChunk, LogStreamOptions } from '../streaming/types.js';
import { createLogStream } from '../streaming/log-stream.js';
import { NotFoundError } from '../errors.js';
import { mapApiError } from '../client.js';

export class LogOperations implements LogFetcher {
  constructor(
    private readonly cloudBuildClient: CloudBuildClient,
    private readonly storage: Storage,
    private readonly config: CloudBuildConfig,
    private readonly logger: Logger
  ) {}

  /**
   * Stream logs from a build as an AsyncIterable.
   */
  streamLogs(buildId: string, options?: LogStreamOptions): AsyncIterable<LogEntry> {
    const streamOptions: LogStreamOptions = {
      pollingIntervalMs: options?.pollingIntervalMs ?? this.config.logPollingIntervalMs,
      startOffset: options?.startOffset,
    };

    return createLogStream(buildId, this, this.logger, streamOptions);
  }

  /**
   * Fetch log entries from Cloud Logging.
   * Implements LogFetcher interface.
   */
  async fetchLogs(buildId: string, offset: number): Promise<LogChunk> {
    try {
      // First, get the build to find the logs bucket
      const [build] = await this.cloudBuildClient.getBuild({
        projectId: this.config.projectId,
        id: buildId,
      });

      if (!build) {
        throw new NotFoundError('Build', buildId);
      }

      const logsBucket = build.logsBucket;

      // If we have a logs bucket, read from GCS
      if (logsBucket) {
        return await this.fetchLogsFromBucket(buildId, logsBucket, offset);
      }

      // Otherwise, return empty (logs may not be available yet)
      return {
        entries: [],
        nextOffset: offset,
        isComplete: this.isBuildComplete(build.status as number),
      };
    } catch (error) {
      if (error instanceof NotFoundError) {
        throw error;
      }
      throw mapApiError(error, { buildId });
    }
  }

  /**
   * Get the current build status.
   * Implements LogFetcher interface.
   */
  async getBuildStatus(buildId: string): Promise<string> {
    try {
      const [build] = await this.cloudBuildClient.getBuild({
        projectId: this.config.projectId,
        id: buildId,
      });

      if (!build) {
        throw new NotFoundError('Build', buildId);
      }

      return this.mapStatus(build.status);
    } catch (error) {
      if (error instanceof NotFoundError) {
        throw error;
      }
      throw mapApiError(error, { buildId });
    }
  }

  /**
   * Fetch logs from GCS bucket.
   */
  private async fetchLogsFromBucket(
    buildId: string,
    logsBucket: string,
    offset: number
  ): Promise<LogChunk> {
    try {
      // Extract bucket name from gs:// URL
      const bucketName = logsBucket.replace('gs://', '').split('/')[0];
      if (!bucketName) {
        return { entries: [], nextOffset: offset, isComplete: false };
      }

      const bucket = this.storage.bucket(bucketName);
      const logPrefix = `log-${buildId}`;

      // List log files
      const [files] = await bucket.getFiles({ prefix: logPrefix });

      const entries: LogEntry[] = [];

      for (const file of files) {
        // Skip files we've already read (based on offset)
        const [contents] = await file.download();
        const lines = contents.toString().split('\n');

        for (const line of lines) {
          if (!line.trim()) continue;

          const entry = this.parseLogLine(line);
          if (entry) {
            entries.push(entry);
          }
        }
      }

      // Sort by timestamp
      entries.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

      // Apply offset
      const offsetEntries = entries.slice(offset);

      return {
        entries: offsetEntries,
        nextOffset: offset + offsetEntries.length,
        isComplete: false, // We don't know if complete from GCS alone
      };
    } catch (error) {
      this.logger.warn({ error, buildId, logsBucket }, 'Failed to fetch logs from bucket');
      return { entries: [], nextOffset: offset, isComplete: false };
    }
  }

  /**
   * Parse a log line into a LogEntry.
   */
  private parseLogLine(line: string): LogEntry | null {
    try {
      // Try to parse as JSON first
      const json = JSON.parse(line);
      return {
        timestamp: new Date(json.timestamp || json.time || Date.now()),
        severity: this.parseSeverity(json.severity || json.level),
        message: json.message || json.textPayload || line,
        stepId: json.stepId,
        textPayload: json.textPayload,
        jsonPayload: json.jsonPayload,
        insertId: json.insertId,
      };
    } catch {
      // Plain text log
      return {
        timestamp: new Date(),
        severity: 'INFO',
        message: line,
      };
    }
  }

  /**
   * Parse severity string to LogSeverity type.
   */
  private parseSeverity(severity: string | undefined): LogSeverity {
    if (!severity) return 'DEFAULT';

    const upper = severity.toUpperCase();
    const validSeverities: LogSeverity[] = [
      'DEFAULT', 'DEBUG', 'INFO', 'NOTICE', 'WARNING', 'ERROR', 'CRITICAL', 'ALERT', 'EMERGENCY'
    ];

    if (validSeverities.includes(upper as LogSeverity)) {
      return upper as LogSeverity;
    }

    // Map common alternatives
    if (upper === 'WARN') return 'WARNING';
    if (upper === 'ERR' || upper === 'SEVERE') return 'ERROR';
    if (upper === 'FATAL') return 'CRITICAL';

    return 'DEFAULT';
  }

  /**
   * Map numeric status to string.
   */
  private mapStatus(status: number | string | null | undefined): string {
    if (status === null || status === undefined) return 'STATUS_UNKNOWN';

    const statusMap: Record<number | string, string> = {
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
    };

    return statusMap[status] ?? 'STATUS_UNKNOWN';
  }

  /**
   * Check if build status indicates completion.
   */
  private isBuildComplete(status: number): boolean {
    // Terminal statuses: SUCCESS (4), FAILURE (5), INTERNAL_ERROR (6), TIMEOUT (7), CANCELLED (8), EXPIRED (9)
    return status >= 4 && status <= 9;
  }
}

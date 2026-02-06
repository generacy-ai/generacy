/**
 * Log streaming implementation using AsyncIterable.
 *
 * Features:
 * - Real-time log streaming with polling
 * - Automatic completion when build finishes
 * - Natural backpressure via async iteration
 * - Configurable polling interval
 */

import type { Logger } from 'pino';
import type { LogEntry } from '../types/logs.js';
import type {
  LogStreamOptions,
  LogFetcher,
  LogChunk,
} from './types.js';
import { DEFAULT_POLLING_INTERVAL_MS } from './types.js';
import { sleep } from '../utils/retry.js';

const TERMINAL_BUILD_STATUSES = ['SUCCESS', 'FAILURE', 'INTERNAL_ERROR', 'TIMEOUT', 'CANCELLED', 'EXPIRED'];

export class LogStream implements AsyncIterable<LogEntry> {
  private readonly buildId: string;
  private readonly fetcher: LogFetcher;
  private readonly pollingIntervalMs: number;
  private readonly logger: Logger;
  private offset: number;
  private isComplete: boolean = false;

  constructor(
    buildId: string,
    fetcher: LogFetcher,
    logger: Logger,
    options: LogStreamOptions = {}
  ) {
    this.buildId = buildId;
    this.fetcher = fetcher;
    this.logger = logger;
    this.pollingIntervalMs = options.pollingIntervalMs ?? DEFAULT_POLLING_INTERVAL_MS;
    this.offset = options.startOffset ?? 0;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<LogEntry> {
    this.logger.debug({ buildId: this.buildId }, 'Starting log stream');

    while (!this.isComplete) {
      try {
        const chunk = await this.fetchNextChunk();

        for (const entry of chunk.entries) {
          yield entry;
        }

        this.offset = chunk.nextOffset;

        if (chunk.isComplete) {
          this.isComplete = true;
          this.logger.debug({ buildId: this.buildId }, 'Log stream complete');
          break;
        }

        // Wait before polling again
        await sleep(this.pollingIntervalMs);

        // Check if build has finished
        await this.checkBuildCompletion();
      } catch (error) {
        this.logger.error({ error, buildId: this.buildId }, 'Error fetching logs');
        throw error;
      }
    }
  }

  private async fetchNextChunk(): Promise<LogChunk> {
    return this.fetcher.fetchLogs(this.buildId, this.offset);
  }

  private async checkBuildCompletion(): Promise<void> {
    try {
      const status = await this.fetcher.getBuildStatus(this.buildId);

      if (TERMINAL_BUILD_STATUSES.includes(status)) {
        // Fetch any remaining logs before completing
        const finalChunk = await this.fetchNextChunk();

        if (finalChunk.entries.length === 0) {
          this.isComplete = true;
        }
      }
    } catch (error) {
      this.logger.warn({ error, buildId: this.buildId }, 'Failed to check build status');
      // Continue streaming, will retry on next iteration
    }
  }
}

/**
 * Create a log stream for a build.
 */
export function createLogStream(
  buildId: string,
  fetcher: LogFetcher,
  logger: Logger,
  options?: LogStreamOptions
): AsyncIterable<LogEntry> {
  return new LogStream(buildId, fetcher, logger, options);
}

/**
 * Collect all log entries from a stream.
 * Useful for testing or when you need all logs at once.
 */
export async function collectLogs(stream: AsyncIterable<LogEntry>): Promise<LogEntry[]> {
  const entries: LogEntry[] = [];

  for await (const entry of stream) {
    entries.push(entry);
  }

  return entries;
}

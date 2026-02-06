/**
 * Types for log streaming.
 */

import type { LogEntry, LogSeverity } from '../types/logs.js';

export interface LogStreamOptions {
  pollingIntervalMs?: number;
  startOffset?: number;
  maxRetries?: number;
}

export interface LogStreamState {
  offset: number;
  isComplete: boolean;
  buildStatus?: string;
}

export interface LogChunk {
  entries: LogEntry[];
  nextOffset: number;
  isComplete: boolean;
}

export interface LogFetcher {
  fetchLogs(buildId: string, offset: number): Promise<LogChunk>;
  getBuildStatus(buildId: string): Promise<string>;
}

export const DEFAULT_POLLING_INTERVAL_MS = 2000;
export const DEFAULT_MAX_RETRIES = 3;

export { LogEntry, LogSeverity };

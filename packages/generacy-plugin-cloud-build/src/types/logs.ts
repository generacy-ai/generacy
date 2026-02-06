/**
 * Log-related types for the Cloud Build plugin.
 */

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

export interface LogStreamOptions {
  pollingIntervalMs?: number;
  startOffset?: number;
}

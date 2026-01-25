/**
 * CLI logger setup using Pino.
 * Provides structured logging with pretty output for dev and JSON for prod.
 */
import pino from 'pino';
import type { Logger as WorkflowLogger } from '@generacy-ai/workflow-engine';

/**
 * Log levels supported by the CLI
 */
export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'silent';

/**
 * Logger options
 */
export interface LoggerOptions {
  level?: LogLevel;
  pretty?: boolean;
  name?: string;
}

/**
 * Create a Pino logger instance
 */
export function createLogger(options: LoggerOptions = {}): pino.Logger {
  const level = options.level ?? (process.env['LOG_LEVEL'] as LogLevel) ?? 'info';
  const pretty = options.pretty ?? process.env['NODE_ENV'] !== 'production';

  const transport = pretty
    ? {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:standard',
          ignore: 'pid,hostname',
        },
      }
    : undefined;

  return pino({
    name: options.name ?? 'generacy',
    level,
    transport,
  });
}

/**
 * Default CLI logger instance
 */
let defaultLogger: pino.Logger | null = null;

/**
 * Get or create the default logger
 */
export function getLogger(): pino.Logger {
  if (!defaultLogger) {
    defaultLogger = createLogger();
  }
  return defaultLogger;
}

/**
 * Set the default logger instance
 */
export function setLogger(logger: pino.Logger): void {
  defaultLogger = logger;
}

/**
 * Adapter to convert Pino logger to WorkflowLogger interface
 */
export class PinoWorkflowLogger implements WorkflowLogger {
  constructor(private readonly pino: pino.Logger) {}

  info(message: string, ...args: unknown[]): void {
    if (args.length > 0) {
      this.pino.info({ data: args }, message);
    } else {
      this.pino.info(message);
    }
  }

  warn(message: string, ...args: unknown[]): void {
    if (args.length > 0) {
      this.pino.warn({ data: args }, message);
    } else {
      this.pino.warn(message);
    }
  }

  error(message: string, ...args: unknown[]): void {
    if (args.length > 0) {
      this.pino.error({ data: args }, message);
    } else {
      this.pino.error(message);
    }
  }

  debug(message: string, ...args: unknown[]): void {
    if (args.length > 0) {
      this.pino.debug({ data: args }, message);
    } else {
      this.pino.debug(message);
    }
  }

  child(bindings: Record<string, unknown>): WorkflowLogger {
    return new PinoWorkflowLogger(this.pino.child(bindings));
  }
}

/**
 * Create a workflow logger from a Pino logger
 */
export function createWorkflowLogger(pino: pino.Logger): WorkflowLogger {
  return new PinoWorkflowLogger(pino);
}

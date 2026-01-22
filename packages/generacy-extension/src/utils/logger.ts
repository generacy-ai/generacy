/**
 * Extension logger with output channel integration.
 * Provides structured logging with levels, timestamps, and VS Code output channel support.
 */
import * as vscode from 'vscode';
import { OUTPUT_CHANNEL_NAME } from '../constants';

/**
 * Log levels in order of severity
 */
export enum LogLevel {
  Debug = 0,
  Info = 1,
  Warn = 2,
  Error = 3,
}

/**
 * Log entry structure
 */
export interface LogEntry {
  level: LogLevel;
  message: string;
  timestamp: Date;
  data?: Record<string, unknown>;
}

/**
 * Logger configuration options
 */
export interface LoggerOptions {
  /** Minimum level to log (default: Info in production, Debug in development) */
  minLevel?: LogLevel;
  /** Whether to include timestamps in output (default: true) */
  includeTimestamp?: boolean;
  /** Custom output channel name (default: from constants) */
  channelName?: string;
}

/**
 * Extension logger class
 */
export class Logger {
  private static instance: Logger | undefined;
  private outputChannel: vscode.OutputChannel | undefined;
  private minLevel: LogLevel;
  private includeTimestamp: boolean;
  private readonly channelName: string;

  private constructor(options: LoggerOptions = {}) {
    this.minLevel = options.minLevel ?? LogLevel.Info;
    this.includeTimestamp = options.includeTimestamp ?? true;
    this.channelName = options.channelName ?? OUTPUT_CHANNEL_NAME;
  }

  /**
   * Get the singleton instance
   */
  public static getInstance(): Logger {
    if (!Logger.instance) {
      Logger.instance = new Logger();
    }
    return Logger.instance;
  }

  /**
   * Initialize the logger with VS Code context
   */
  public initialize(context: vscode.ExtensionContext): void {
    if (!this.outputChannel) {
      this.outputChannel = vscode.window.createOutputChannel(this.channelName);
      context.subscriptions.push(this.outputChannel);
    }
  }

  /**
   * Set the minimum log level
   */
  public setLevel(level: LogLevel): void {
    this.minLevel = level;
  }

  /**
   * Get the current minimum log level
   */
  public getLevel(): LogLevel {
    return this.minLevel;
  }

  /**
   * Log a debug message
   */
  public debug(message: string, data?: Record<string, unknown>): void {
    this.log(LogLevel.Debug, message, data);
  }

  /**
   * Log an info message
   */
  public info(message: string, data?: Record<string, unknown>): void {
    this.log(LogLevel.Info, message, data);
  }

  /**
   * Log a warning message
   */
  public warn(message: string, data?: Record<string, unknown>): void {
    this.log(LogLevel.Warn, message, data);
  }

  /**
   * Log an error message
   */
  public error(message: string, error?: Error | unknown, data?: Record<string, unknown>): void {
    const errorData = {
      ...data,
      ...(error instanceof Error
        ? {
            errorName: error.name,
            errorMessage: error.message,
            errorStack: error.stack,
          }
        : error !== undefined
          ? { errorValue: String(error) }
          : {}),
    };
    this.log(LogLevel.Error, message, Object.keys(errorData).length > 0 ? errorData : undefined);
  }

  /**
   * Show the output channel
   */
  public show(preserveFocus = true): void {
    this.outputChannel?.show(preserveFocus);
  }

  /**
   * Clear the output channel
   */
  public clear(): void {
    this.outputChannel?.clear();
  }

  /**
   * Dispose of resources
   */
  public dispose(): void {
    this.outputChannel?.dispose();
    this.outputChannel = undefined;
  }

  /**
   * Reset the singleton instance (for testing)
   */
  public static resetInstance(): void {
    Logger.instance?.dispose();
    Logger.instance = undefined;
  }

  /**
   * Create a child logger with a prefix
   */
  public createChild(prefix: string): ChildLogger {
    return new ChildLogger(this, prefix);
  }

  /**
   * Internal logging method
   */
  private log(level: LogLevel, message: string, data?: Record<string, unknown>): void {
    if (level < this.minLevel) {
      return;
    }

    const entry: LogEntry = {
      level,
      message,
      timestamp: new Date(),
      data,
    };

    const formattedMessage = this.formatEntry(entry);
    this.outputChannel?.appendLine(formattedMessage);

    // Also log to console for debugging
    this.logToConsole(entry);
  }

  /**
   * Format a log entry for the output channel
   */
  private formatEntry(entry: LogEntry): string {
    const parts: string[] = [];

    if (this.includeTimestamp) {
      parts.push(`[${this.formatTimestamp(entry.timestamp)}]`);
    }

    parts.push(`[${this.getLevelLabel(entry.level)}]`);
    parts.push(entry.message);

    if (entry.data && Object.keys(entry.data).length > 0) {
      parts.push(JSON.stringify(entry.data));
    }

    return parts.join(' ');
  }

  /**
   * Format timestamp for log output
   */
  private formatTimestamp(date: Date): string {
    return date.toISOString().slice(11, 23); // HH:mm:ss.SSS
  }

  /**
   * Get a label for a log level
   */
  private getLevelLabel(level: LogLevel): string {
    switch (level) {
      case LogLevel.Debug:
        return 'DEBUG';
      case LogLevel.Info:
        return 'INFO';
      case LogLevel.Warn:
        return 'WARN';
      case LogLevel.Error:
        return 'ERROR';
      default:
        return 'UNKNOWN';
    }
  }

  /**
   * Log to console for debugging
   */
  private logToConsole(entry: LogEntry): void {
    const message = `[Generacy] ${entry.message}`;
    const args = entry.data ? [message, entry.data] : [message];

    switch (entry.level) {
      case LogLevel.Debug:
        console.debug(...args);
        break;
      case LogLevel.Info:
        console.info(...args);
        break;
      case LogLevel.Warn:
        console.warn(...args);
        break;
      case LogLevel.Error:
        console.error(...args);
        break;
    }
  }
}

/**
 * Child logger with prefix support
 */
export class ChildLogger {
  constructor(
    private readonly parent: Logger,
    private readonly prefix: string
  ) {}

  public debug(message: string, data?: Record<string, unknown>): void {
    this.parent.debug(`[${this.prefix}] ${message}`, data);
  }

  public info(message: string, data?: Record<string, unknown>): void {
    this.parent.info(`[${this.prefix}] ${message}`, data);
  }

  public warn(message: string, data?: Record<string, unknown>): void {
    this.parent.warn(`[${this.prefix}] ${message}`, data);
  }

  public error(message: string, error?: Error | unknown, data?: Record<string, unknown>): void {
    this.parent.error(`[${this.prefix}] ${message}`, error, data);
  }
}

/**
 * Get the singleton logger instance
 */
export function getLogger(): Logger {
  return Logger.getInstance();
}

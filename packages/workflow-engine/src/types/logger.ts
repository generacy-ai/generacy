/**
 * Logger interface.
 * Platform-agnostic logging abstraction.
 */

/**
 * Logger interface for action execution
 * This abstracts away VS Code OutputChannel or any other logging backend
 */
export interface Logger {
  /**
   * Log an info message
   */
  info(message: string, ...args: unknown[]): void;

  /**
   * Log a warning message
   */
  warn(message: string, ...args: unknown[]): void;

  /**
   * Log an error message
   */
  error(message: string, ...args: unknown[]): void;

  /**
   * Log a debug message
   */
  debug(message: string, ...args: unknown[]): void;

  /**
   * Create a child logger with a specific context
   */
  child?(context: Record<string, unknown>): Logger;
}

/**
 * Console-based logger implementation
 * Used as a default when no logger is provided
 */
export class ConsoleLogger implements Logger {
  private prefix: string;

  constructor(prefix = '') {
    this.prefix = prefix;
  }

  info(message: string, ...args: unknown[]): void {
    console.info(this.format(message), ...args);
  }

  warn(message: string, ...args: unknown[]): void {
    console.warn(this.format(message), ...args);
  }

  error(message: string, ...args: unknown[]): void {
    console.error(this.format(message), ...args);
  }

  debug(message: string, ...args: unknown[]): void {
    console.debug(this.format(message), ...args);
  }

  child(context: Record<string, unknown>): Logger {
    const contextStr = Object.entries(context)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ');
    return new ConsoleLogger(this.prefix ? `${this.prefix} ${contextStr}` : contextStr);
  }

  private format(message: string): string {
    const timestamp = new Date().toISOString();
    return this.prefix
      ? `[${timestamp}] [${this.prefix}] ${message}`
      : `[${timestamp}] ${message}`;
  }
}

/**
 * No-op logger implementation
 * Useful for testing or when logging should be disabled
 */
export class NoopLogger implements Logger {
  info(_message: string, ..._args: unknown[]): void {
    // No-op
  }

  warn(_message: string, ..._args: unknown[]): void {
    // No-op
  }

  error(_message: string, ..._args: unknown[]): void {
    // No-op
  }

  debug(_message: string, ..._args: unknown[]): void {
    // No-op
  }

  child(_context: Record<string, unknown>): Logger {
    return this;
  }
}

/**
 * Create a default logger
 */
export function createLogger(prefix?: string): Logger {
  return new ConsoleLogger(prefix);
}

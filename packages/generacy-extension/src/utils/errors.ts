/**
 * Error handling utilities for Generacy VS Code extension.
 * Provides user-friendly error messages and structured error handling.
 */
import * as vscode from 'vscode';
import { getLogger } from './logger';

/**
 * Error codes for categorizing errors
 */
export enum ErrorCode {
  // Configuration errors (1xxx)
  ConfigInvalid = 1001,
  ConfigMissing = 1002,

  // File system errors (2xxx)
  FileNotFound = 2001,
  FileReadError = 2002,
  FileWriteError = 2003,
  DirectoryNotFound = 2004,

  // Workflow errors (3xxx)
  WorkflowInvalid = 3001,
  WorkflowParseError = 3002,
  WorkflowValidationError = 3003,
  WorkflowExecutionError = 3004,

  // Authentication errors (4xxx)
  AuthRequired = 4001,
  AuthExpired = 4002,
  AuthFailed = 4003,

  // API errors (5xxx)
  ApiConnectionError = 5001,
  ApiRequestError = 5002,
  ApiResponseError = 5003,
  ApiRateLimited = 5004,

  // Debug errors (6xxx)
  DebugSessionError = 6001,
  DebugBreakpointError = 6002,

  // General errors (9xxx)
  Unknown = 9999,
}

/**
 * User-friendly error messages for each error code
 */
const ERROR_MESSAGES: Record<ErrorCode, string> = {
  [ErrorCode.ConfigInvalid]: 'Invalid configuration',
  [ErrorCode.ConfigMissing]: 'Required configuration is missing',
  [ErrorCode.FileNotFound]: 'File not found',
  [ErrorCode.FileReadError]: 'Unable to read file',
  [ErrorCode.FileWriteError]: 'Unable to write file',
  [ErrorCode.DirectoryNotFound]: 'Directory not found',
  [ErrorCode.WorkflowInvalid]: 'Invalid workflow file',
  [ErrorCode.WorkflowParseError]: 'Unable to parse workflow',
  [ErrorCode.WorkflowValidationError]: 'Workflow validation failed',
  [ErrorCode.WorkflowExecutionError]: 'Workflow execution failed',
  [ErrorCode.AuthRequired]: 'Authentication required',
  [ErrorCode.AuthExpired]: 'Authentication has expired',
  [ErrorCode.AuthFailed]: 'Authentication failed',
  [ErrorCode.ApiConnectionError]: 'Unable to connect to server',
  [ErrorCode.ApiRequestError]: 'Request failed',
  [ErrorCode.ApiResponseError]: 'Invalid response from server',
  [ErrorCode.ApiRateLimited]: 'Too many requests, please try again later',
  [ErrorCode.DebugSessionError]: 'Debug session error',
  [ErrorCode.DebugBreakpointError]: 'Breakpoint error',
  [ErrorCode.Unknown]: 'An unexpected error occurred',
};

/**
 * Custom error class for Generacy extension
 */
export class GeneracyError extends Error {
  public readonly code: ErrorCode;
  public readonly userMessage: string;
  public readonly details?: Record<string, unknown>;
  public readonly cause?: Error;

  constructor(
    code: ErrorCode,
    message?: string,
    options?: {
      details?: Record<string, unknown>;
      cause?: Error;
    }
  ) {
    const userMessage = message ?? ERROR_MESSAGES[code];
    super(userMessage);

    this.name = 'GeneracyError';
    this.code = code;
    this.userMessage = userMessage;
    this.details = options?.details;
    this.cause = options?.cause;

    // Maintain proper stack trace in V8 environments
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, GeneracyError);
    }
  }

  /**
   * Create an error with additional context
   */
  public static from(
    error: unknown,
    code: ErrorCode = ErrorCode.Unknown,
    message?: string
  ): GeneracyError {
    if (error instanceof GeneracyError) {
      return error;
    }

    const cause = error instanceof Error ? error : new Error(String(error));
    return new GeneracyError(code, message ?? cause.message, { cause });
  }

  /**
   * Get a detailed error message for logging
   */
  public toDetailedString(): string {
    const parts = [`[${this.code}] ${this.userMessage}`];

    if (this.details) {
      parts.push(`Details: ${JSON.stringify(this.details)}`);
    }

    if (this.cause) {
      parts.push(`Caused by: ${this.cause.message}`);
    }

    if (this.stack) {
      parts.push(`Stack: ${this.stack}`);
    }

    return parts.join('\n');
  }
}

/**
 * Error display options
 */
export interface ErrorDisplayOptions {
  /** Show the error as a modal dialog */
  modal?: boolean;
  /** Items to show as action buttons */
  actions?: Array<{
    label: string;
    action: () => void | Promise<void>;
  }>;
  /** Show "Show Output" action to open the output channel */
  showOutput?: boolean;
}

/**
 * Display an error message to the user
 */
export async function showError(
  error: Error | GeneracyError | string,
  options: ErrorDisplayOptions = {}
): Promise<void> {
  const logger = getLogger();
  const message = typeof error === 'string' ? error : error.message;

  // Log the error
  if (error instanceof Error) {
    logger.error('User-facing error', error);
  } else {
    logger.error(message);
  }

  // Build action items
  const items: string[] = [];
  const actionMap = new Map<string, () => void | Promise<void>>();

  if (options.showOutput) {
    const label = 'Show Output';
    items.push(label);
    actionMap.set(label, () => logger.show());
  }

  if (options.actions) {
    for (const action of options.actions) {
      items.push(action.label);
      actionMap.set(action.label, action.action);
    }
  }

  // Show the error message
  const selection = await vscode.window.showErrorMessage(message, { modal: options.modal }, ...items);

  // Handle action selection
  if (selection) {
    const action = actionMap.get(selection);
    if (action) {
      await action();
    }
  }
}

/**
 * Display a warning message to the user
 */
export async function showWarning(
  message: string,
  options: ErrorDisplayOptions = {}
): Promise<void> {
  const logger = getLogger();
  logger.warn(message);

  const items: string[] = [];
  const actionMap = new Map<string, () => void | Promise<void>>();

  if (options.actions) {
    for (const action of options.actions) {
      items.push(action.label);
      actionMap.set(action.label, action.action);
    }
  }

  const selection = await vscode.window.showWarningMessage(message, { modal: options.modal }, ...items);

  if (selection) {
    const action = actionMap.get(selection);
    if (action) {
      await action();
    }
  }
}

/**
 * Wrap an async function with error handling
 */
export function withErrorHandling<T extends (...args: never[]) => Promise<unknown>>(
  fn: T,
  options: ErrorDisplayOptions = {}
): T {
  return (async (...args: Parameters<T>) => {
    try {
      return await fn(...args);
    } catch (error) {
      await showError(GeneracyError.from(error), options);
      return undefined;
    }
  }) as T;
}

/**
 * Try to execute a function and return a result object
 */
export type Result<T, E = GeneracyError> = { ok: true; value: T } | { ok: false; error: E };

/**
 * Create a success result
 */
export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

/**
 * Create an error result
 */
export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

/**
 * Try to execute a function and wrap the result
 */
export async function tryAsync<T>(
  fn: () => Promise<T>,
  errorCode: ErrorCode = ErrorCode.Unknown
): Promise<Result<T, GeneracyError>> {
  try {
    const value = await fn();
    return ok(value);
  } catch (error) {
    return err(GeneracyError.from(error, errorCode));
  }
}

/**
 * Try to execute a sync function and wrap the result
 */
export function trySync<T>(
  fn: () => T,
  errorCode: ErrorCode = ErrorCode.Unknown
): Result<T, GeneracyError> {
  try {
    const value = fn();
    return ok(value);
  } catch (error) {
    return err(GeneracyError.from(error, errorCode));
  }
}

/**
 * Assert a condition and throw a GeneracyError if false
 */
export function assert(
  condition: boolean,
  code: ErrorCode,
  message?: string
): asserts condition {
  if (!condition) {
    throw new GeneracyError(code, message);
  }
}

/**
 * Assert a value is not null/undefined and return it
 */
export function assertDefined<T>(
  value: T | null | undefined,
  code: ErrorCode,
  message?: string
): T {
  if (value === null || value === undefined) {
    throw new GeneracyError(code, message ?? 'Value is undefined');
  }
  return value;
}

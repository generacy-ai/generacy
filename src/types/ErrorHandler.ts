/**
 * Error Handler Types
 *
 * Configuration for handling errors during workflow execution.
 */

import type { WorkflowStep } from './WorkflowDefinition.js';
import type { WorkflowContext } from './WorkflowContext.js';

/**
 * Error handler configuration
 */
export interface ErrorHandler {
  /** Function to determine action on error */
  onError: ErrorHandlerFunction;
}

/**
 * Error handler function signature
 */
export type ErrorHandlerFunction = (
  error: Error,
  step: WorkflowStep,
  context: WorkflowContext
) => ErrorAction;

/**
 * Actions that can be taken in response to an error
 */
export type ErrorAction =
  | RetryAction
  | AbortAction
  | EscalateAction
  | FallbackAction
  | SkipAction;

/**
 * Retry the failed step
 */
export interface RetryAction {
  type: 'retry';
  /** Delay in milliseconds before retry */
  delay?: number;
  /** Maximum number of retry attempts */
  maxAttempts?: number;
}

/**
 * Abort the workflow
 */
export interface AbortAction {
  type: 'abort';
  /** Reason for aborting */
  reason: string;
}

/**
 * Escalate to human intervention
 */
export interface EscalateAction {
  type: 'escalate';
  /** Urgency of human intervention */
  urgency: 'blocking_now' | 'blocking_soon' | 'when_available';
  /** Optional message for the human */
  message?: string;
}

/**
 * Fall back to an alternative step
 */
export interface FallbackAction {
  type: 'fallback';
  /** Step ID to fall back to */
  stepId: string;
}

/**
 * Skip the failed step and continue
 */
export interface SkipAction {
  type: 'skip';
  /** Optional reason for skipping */
  reason?: string;
}

/**
 * Type guards for error actions
 */
export function isRetryAction(action: ErrorAction): action is RetryAction {
  return action.type === 'retry';
}

export function isAbortAction(action: ErrorAction): action is AbortAction {
  return action.type === 'abort';
}

export function isEscalateAction(action: ErrorAction): action is EscalateAction {
  return action.type === 'escalate';
}

export function isFallbackAction(action: ErrorAction): action is FallbackAction {
  return action.type === 'fallback';
}

export function isSkipAction(action: ErrorAction): action is SkipAction {
  return action.type === 'skip';
}

/**
 * Default error handler that aborts on error
 */
export const defaultErrorHandler: ErrorHandler = {
  onError: (error) => ({
    type: 'abort',
    reason: error.message,
  }),
};

/**
 * Create a retry-first error handler
 */
export function createRetryErrorHandler(maxAttempts: number = 3, delay: number = 1000): ErrorHandler {
  return {
    onError: () => ({
      type: 'retry',
      maxAttempts,
      delay,
    }),
  };
}

/**
 * GitHub user information
 */
export interface User {
  /** User ID */
  id: number;
  /** Username */
  login: string;
  /** Avatar URL */
  avatar_url: string;
  /** User type */
  type: 'User' | 'Bot';
}

/**
 * Workflow run status
 */
export type WorkflowStatus = 'queued' | 'in_progress' | 'completed';

/**
 * Workflow run conclusion (final outcome)
 */
export type WorkflowConclusion =
  | 'success'
  | 'failure'
  | 'neutral'
  | 'cancelled'
  | 'skipped'
  | 'timed_out'
  | 'action_required'
  | null;

/**
 * Represents a GitHub Actions workflow run
 */
export interface WorkflowRun {
  /** Unique run ID */
  id: number;
  /** Workflow name */
  name: string;
  /** Workflow filename */
  path: string;
  /** Git reference (branch/tag) */
  head_branch: string;
  /** Commit SHA */
  head_sha: string;
  /** Current status */
  status: WorkflowStatus;
  /** Final conclusion (when completed) */
  conclusion: WorkflowConclusion;
  /** Workflow URL */
  html_url: string;
  /** Created timestamp */
  created_at: string;
  /** Updated timestamp */
  updated_at: string;
  /** Run started timestamp */
  run_started_at: string | null;
  /** Actor who triggered the run */
  actor: User;
  /** Triggering event */
  event: string;
  /** Run attempt number */
  run_attempt: number;
}

/**
 * Parameters for triggering a workflow
 */
export interface TriggerWorkflowParams {
  /** Workflow filename or ID */
  workflow: string;
  /** Git ref (branch/tag), defaults to default branch */
  ref?: string;
  /** Workflow inputs */
  inputs?: Record<string, string>;
}

/**
 * Check if a workflow run is in a terminal state
 */
export function isTerminalStatus(status: WorkflowStatus): boolean {
  return status === 'completed';
}

/**
 * Check if a workflow run was successful
 */
export function isSuccessful(run: WorkflowRun): boolean {
  return run.status === 'completed' && run.conclusion === 'success';
}

/**
 * Check if a workflow run failed
 */
export function isFailed(run: WorkflowRun): boolean {
  return run.status === 'completed' && run.conclusion === 'failure';
}

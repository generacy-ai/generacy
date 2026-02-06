/**
 * Job status
 */
export type JobStatus = 'queued' | 'in_progress' | 'completed';

/**
 * Job conclusion (final outcome)
 */
export type JobConclusion = 'success' | 'failure' | 'cancelled' | 'skipped' | null;

/**
 * Step status
 */
export type StepStatus = 'queued' | 'in_progress' | 'completed';

/**
 * Step conclusion (final outcome)
 */
export type StepConclusion = 'success' | 'failure' | 'cancelled' | 'skipped' | null;

/**
 * Represents a step within a job
 */
export interface Step {
  /** Step name */
  name: string;
  /** Step status */
  status: StepStatus;
  /** Step conclusion */
  conclusion: StepConclusion;
  /** Step number (1-indexed) */
  number: number;
  /** Started timestamp */
  started_at: string | null;
  /** Completed timestamp */
  completed_at: string | null;
}

/**
 * Represents a job within a workflow run
 */
export interface Job {
  /** Unique job ID */
  id: number;
  /** Parent run ID */
  run_id: number;
  /** Job name */
  name: string;
  /** Current status */
  status: JobStatus;
  /** Final conclusion (when completed) */
  conclusion: JobConclusion;
  /** Steps within the job */
  steps: Step[];
  /** Started timestamp */
  started_at: string | null;
  /** Completed timestamp */
  completed_at: string | null;
  /** Runner ID */
  runner_id: number | null;
  /** Runner name */
  runner_name: string | null;
}

/**
 * Check if a job is in a terminal state
 */
export function isJobComplete(job: Job): boolean {
  return job.status === 'completed';
}

/**
 * Check if a job was successful
 */
export function isJobSuccessful(job: Job): boolean {
  return job.status === 'completed' && job.conclusion === 'success';
}

/**
 * Get failed steps from a job
 */
export function getFailedSteps(job: Job): Step[] {
  return job.steps.filter((step) => step.conclusion === 'failure');
}

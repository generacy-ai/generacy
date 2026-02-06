import type { EventBus } from './types.js';
import type { WorkflowRun } from '../types/workflows.js';
import type { CheckRun } from '../types/check-runs.js';
import type { Job } from '../types/jobs.js';
import type {
  WorkflowCompletedEvent,
  WorkflowFailedEvent,
  CheckRunCompletedEvent,
} from '../types/events.js';

/**
 * Event emitter for GitHub Actions plugin events
 */
export class WorkflowEventEmitter {
  private readonly eventBus: EventBus;

  constructor(eventBus: EventBus) {
    this.eventBus = eventBus;
  }

  /**
   * Emit a workflow completed event
   */
  emitWorkflowCompleted(run: WorkflowRun): void {
    const duration = this.calculateDuration(run);

    const event: WorkflowCompletedEvent = {
      type: 'workflow.completed',
      runId: run.id,
      workflow: run.path,
      conclusion: run.conclusion,
      duration,
      url: run.html_url,
    };

    this.eventBus.emit('workflow.completed', event);
  }

  /**
   * Emit a workflow failed event
   */
  emitWorkflowFailed(run: WorkflowRun, failedJobs: Job[] = []): void {
    const event: WorkflowFailedEvent = {
      type: 'workflow.failed',
      runId: run.id,
      workflow: run.path,
      error: this.getFailureReason(run, failedJobs),
      failedJobs: failedJobs.map((job) => job.name),
      url: run.html_url,
    };

    this.eventBus.emit('workflow.failed', event);
  }

  /**
   * Emit a check run completed event
   */
  emitCheckRunCompleted(check: CheckRun): void {
    const event: CheckRunCompletedEvent = {
      type: 'check_run.completed',
      checkRunId: check.id,
      name: check.name,
      conclusion: check.conclusion,
      headSha: check.head_sha,
    };

    this.eventBus.emit('check_run.completed', event);
  }

  /**
   * Emit an event based on workflow run status
   */
  emitForWorkflowRun(run: WorkflowRun, failedJobs: Job[] = []): void {
    if (run.status !== 'completed') {
      return;
    }

    if (run.conclusion === 'success') {
      this.emitWorkflowCompleted(run);
    } else if (
      run.conclusion === 'failure' ||
      run.conclusion === 'timed_out' ||
      run.conclusion === 'cancelled'
    ) {
      this.emitWorkflowFailed(run, failedJobs);
    } else {
      // For neutral, skipped, action_required - emit completed
      this.emitWorkflowCompleted(run);
    }
  }

  /**
   * Calculate workflow duration in milliseconds
   */
  private calculateDuration(run: WorkflowRun): number {
    const startTime = run.run_started_at
      ? new Date(run.run_started_at).getTime()
      : new Date(run.created_at).getTime();
    const endTime = new Date(run.updated_at).getTime();
    return Math.max(0, endTime - startTime);
  }

  /**
   * Get a descriptive failure reason
   */
  private getFailureReason(run: WorkflowRun, failedJobs: Job[]): string {
    if (run.conclusion === 'cancelled') {
      return 'Workflow was cancelled';
    }
    if (run.conclusion === 'timed_out') {
      return 'Workflow timed out';
    }
    if (failedJobs.length > 0) {
      const jobNames = failedJobs.map((j) => j.name).join(', ');
      return `Jobs failed: ${jobNames}`;
    }
    return `Workflow failed with conclusion: ${run.conclusion}`;
  }
}

/**
 * Create a workflow event emitter
 */
export function createEventEmitter(eventBus: EventBus): WorkflowEventEmitter {
  return new WorkflowEventEmitter(eventBus);
}

/**
 * Job handler.
 * Handles job polling, execution, and result reporting.
 */
import {
  loadWorkflowFromString,
  loadWorkflow,
  prepareWorkflow,
  WorkflowExecutor,
  registerBuiltinActions,
  type ExecutionResult,
  type Logger,
} from '@generacy-ai/workflow-engine';
import type { OrchestratorClient } from './client.js';
import type { Job, JobResult } from './types.js';

/**
 * Job handler options
 */
export interface JobHandlerOptions {
  /** Orchestrator client */
  client: OrchestratorClient;

  /** Worker ID */
  workerId: string;

  /** Poll interval in milliseconds */
  pollInterval?: number;

  /** Logger instance */
  logger: Logger;

  /** Working directory for job execution */
  workdir?: string;

  /** Worker capabilities for job matching */
  capabilities?: string[];

  /** Callback when job starts */
  onJobStart?: (job: Job) => void;

  /** Callback when job completes */
  onJobComplete?: (job: Job, result: JobResult) => void;

  /** Callback for errors */
  onError?: (error: Error, job?: Job) => void;
}

/**
 * Handles job polling and execution
 */
export class JobHandler {
  private readonly client: OrchestratorClient;
  private readonly workerId: string;
  private readonly pollInterval: number;
  private readonly logger: Logger;
  private readonly workdir: string;
  private readonly capabilities: string[];
  private readonly onJobStart?: (job: Job) => void;
  private readonly onJobComplete?: (job: Job, result: JobResult) => void;
  private readonly onError?: (error: Error, job?: Job) => void;

  private pollTimer: NodeJS.Timeout | null = null;
  private currentJob: Job | null = null;
  private abortController: AbortController | null = null;
  private isRunning = false;
  private shouldStop = false;

  constructor(options: JobHandlerOptions) {
    this.client = options.client;
    this.workerId = options.workerId;
    this.pollInterval = options.pollInterval ?? 5000;
    this.logger = options.logger;
    this.workdir = options.workdir ?? process.cwd();
    this.capabilities = options.capabilities ?? [];
    this.onJobStart = options.onJobStart;
    this.onJobComplete = options.onJobComplete;
    this.onError = options.onError;

    // Register builtin actions
    registerBuiltinActions();
  }

  /**
   * Start the job polling loop
   */
  start(): void {
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;
    this.shouldStop = false;
    this.poll();
  }

  /**
   * Stop the job polling loop
   */
  stop(): void {
    this.shouldStop = true;

    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }

    this.isRunning = false;
  }

  /**
   * Cancel the current job
   */
  cancelCurrentJob(): void {
    if (this.abortController) {
      this.abortController.abort();
    }
  }

  /**
   * Get the currently executing job
   */
  getCurrentJob(): Job | null {
    return this.currentJob;
  }

  /**
   * Check if currently executing a job
   */
  isBusy(): boolean {
    return this.currentJob !== null;
  }

  /**
   * Poll for and process jobs
   */
  private async poll(): Promise<void> {
    if (this.shouldStop || this.currentJob) {
      return;
    }

    try {
      const response = await this.client.pollForJob(this.workerId, this.capabilities);

      if (response.job) {
        await this.executeJob(response.job);
      }

      // Schedule next poll
      if (!this.shouldStop && this.isRunning) {
        const delay = response.retryAfter ?? this.pollInterval;
        this.pollTimer = setTimeout(() => this.poll(), delay);
      }
    } catch (error) {
      this.onError?.(error instanceof Error ? error : new Error(String(error)));

      // Continue polling after error with backoff
      if (!this.shouldStop && this.isRunning) {
        this.pollTimer = setTimeout(() => this.poll(), this.pollInterval * 2);
      }
    }
  }

  /**
   * Execute a job
   */
  private async executeJob(job: Job): Promise<void> {
    this.currentJob = job;
    this.abortController = new AbortController();
    const startTime = Date.now();

    this.logger.info(`Starting job: ${job.id} (${job.name})`);
    this.onJobStart?.(job);

    try {
      // Update job status to running
      await this.client.updateJobStatus(job.id, 'running', {
        startedAt: new Date().toISOString(),
      });

      // Load workflow
      let definition;
      if (typeof job.workflow === 'string') {
        // Could be a path or YAML content
        if (job.workflow.includes('\n') || job.workflow.startsWith('name:')) {
          definition = await loadWorkflowFromString(job.workflow);
        } else {
          definition = await loadWorkflow(job.workflow);
        }
      } else {
        // Already a workflow object
        definition = job.workflow;
      }

      const workflow = prepareWorkflow(definition);

      // Create executor
      const executor = new WorkflowExecutor({
        logger: this.logger,
      });

      // Execute workflow
      const result = await executor.execute(
        workflow,
        {
          workdir: job.workdir ?? this.workdir,
          env: process.env as Record<string, string>,
          signal: this.abortController.signal,
        },
        job.inputs
      );

      // Build job result
      const jobResult = this.buildJobResult(job, result, startTime);

      // Report result
      await this.client.reportJobResult(jobResult);
      this.logger.info(`Job completed: ${job.id} (${jobResult.status})`);
      this.onJobComplete?.(job, jobResult);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;

      this.logger.error(`Job failed: ${job.id} - ${errorMessage}`);
      this.onError?.(error instanceof Error ? error : new Error(errorMessage), job);

      // Report failure
      const failureResult: JobResult = {
        jobId: job.id,
        status: this.abortController?.signal.aborted ? 'cancelled' : 'failed',
        error: errorMessage,
        errorStack,
        duration: Date.now() - startTime,
      };

      try {
        await this.client.reportJobResult(failureResult);
      } catch (reportError) {
        this.logger.error(`Failed to report job result: ${reportError}`);
      }

      this.onJobComplete?.(job, failureResult);
    } finally {
      this.currentJob = null;
      this.abortController = null;

      // Resume polling
      if (!this.shouldStop && this.isRunning) {
        this.pollTimer = setTimeout(() => this.poll(), this.pollInterval);
      }
    }
  }

  /**
   * Build job result from execution result
   */
  private buildJobResult(job: Job, result: ExecutionResult, startTime: number): JobResult {
    return {
      jobId: job.id,
      status: result.status === 'completed' ? 'completed' :
              result.status === 'cancelled' ? 'cancelled' : 'failed',
      outputs: result.outputs,
      error: result.error,
      duration: Date.now() - startTime,
      phases: result.phases.map(phase => ({
        name: phase.name,
        status: phase.status,
        duration: phase.duration,
      })),
      steps: result.phases.flatMap(phase =>
        phase.steps.map(step => ({
          name: step.name,
          status: step.status,
          duration: step.duration,
          error: step.error,
        }))
      ),
    };
  }
}

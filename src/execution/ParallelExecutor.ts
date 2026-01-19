/**
 * Parallel Executor
 *
 * Executor for parallel-type steps that execute branches concurrently.
 */

import type { WorkflowStep } from '../types/WorkflowDefinition.js';
import { isParallelConfig } from '../types/WorkflowDefinition.js';
import type { WorkflowContext } from '../types/WorkflowContext.js';
import type { StepExecutionResult, StepExecutor } from '../engine/WorkflowRuntime.js';
import type { StepResult } from '../types/WorkflowState.js';
import { BaseStepExecutor } from './StepExecutor.js';

/**
 * Result of executing a branch
 */
export interface BranchResult {
  /** Branch index */
  branchIndex: number;

  /** Whether the branch completed successfully */
  success: boolean;

  /** Results from each step in the branch */
  stepResults: StepResult[];

  /** Error if branch failed */
  error?: string;
}

/**
 * Branch executor function type.
 * Handles execution of a single branch (sequence of steps).
 */
export type BranchExecutor = (
  branch: WorkflowStep[],
  context: WorkflowContext,
  branchIndex: number
) => Promise<BranchResult>;

/**
 * Default branch executor that executes steps sequentially.
 */
export const defaultBranchExecutor: BranchExecutor = async (
  branch,
  _context,
  branchIndex
) => {
  const stepResults: StepResult[] = [];

  for (const step of branch) {
    const startedAt = new Date().toISOString();

    try {
      // Simulate step execution
      const completedAt = new Date().toISOString();
      stepResults.push({
        stepId: step.id,
        success: true,
        output: { simulated: true },
        startedAt,
        completedAt,
        durationMs: new Date(completedAt).getTime() - new Date(startedAt).getTime(),
      });
    } catch (error) {
      const completedAt = new Date().toISOString();
      stepResults.push({
        stepId: step.id,
        success: false,
        error: {
          code: 'STEP_FAILED',
          message: error instanceof Error ? error.message : String(error),
        },
        startedAt,
        completedAt,
        durationMs: new Date(completedAt).getTime() - new Date(startedAt).getTime(),
      });

      return {
        branchIndex,
        success: false,
        stepResults,
        error: `Step ${step.id} failed`,
      };
    }
  }

  return {
    branchIndex,
    success: true,
    stepResults,
  };
};

/**
 * Executor for parallel-type steps.
 * Executes multiple branches concurrently using Promise.all or Promise.race.
 */
export class ParallelExecutor extends BaseStepExecutor {
  private branchExecutor: BranchExecutor;

  constructor(branchExecutor: BranchExecutor = defaultBranchExecutor) {
    super();
    this.branchExecutor = branchExecutor;
  }

  async execute(step: WorkflowStep, context: WorkflowContext): Promise<StepExecutionResult> {
    if (!isParallelConfig(step.config)) {
      return this.failure('INVALID_CONFIG', 'Step config is not a ParallelConfig');
    }

    const config = step.config;

    if (!config.branches || config.branches.length === 0) {
      return this.success({ branches: [], message: 'No branches to execute' });
    }

    try {
      const branchPromises = config.branches.map((branch, index) =>
        this.branchExecutor(branch, context, index)
      );

      let results: BranchResult[];

      if (config.join === 'any') {
        // Wait for first branch to complete
        const firstResult = await Promise.race(branchPromises);
        results = [firstResult];
      } else {
        // Wait for all branches to complete
        results = await Promise.all(branchPromises);
      }

      // Check for failures
      const failures = results.filter((r) => !r.success);
      if (failures.length > 0 && config.join === 'all') {
        return this.failure(
          'BRANCH_FAILED',
          `${failures.length} of ${results.length} branches failed`,
          { failures: failures.map((f) => ({ branchIndex: f.branchIndex, error: f.error })) }
        );
      }

      // Aggregate step results
      const allStepResults: Record<string, StepResult> = {};
      for (const result of results) {
        for (const stepResult of result.stepResults) {
          allStepResults[stepResult.stepId] = stepResult;
        }
      }

      return this.success({
        branches: results.map((r) => ({
          branchIndex: r.branchIndex,
          success: r.success,
          stepsCompleted: r.stepResults.length,
        })),
        stepResults: allStepResults,
        join: config.join,
        totalBranches: config.branches.length,
        completedBranches: results.length,
      });
    } catch (error) {
      return this.failure(
        'PARALLEL_EXECUTION_ERROR',
        error instanceof Error ? error.message : String(error)
      );
    }
  }
}

/**
 * Create a parallel executor function.
 */
export function createParallelExecutor(branchExecutor?: BranchExecutor): StepExecutor {
  const executor = new ParallelExecutor(branchExecutor);
  return async (step, context) => executor.execute(step, context);
}

/**
 * Condition Evaluator
 *
 * Executor for condition-type steps that evaluate property path expressions.
 */

import type { WorkflowStep } from '../types/WorkflowDefinition.js';
import { isConditionConfig } from '../types/WorkflowDefinition.js';
import type { WorkflowContext } from '../types/WorkflowContext.js';
import type { StepExecutionResult, StepExecutor } from '../engine/WorkflowRuntime.js';
import { BaseStepExecutor } from './StepExecutor.js';
import { evaluateExpression, type EvaluationResult } from '../utils/PropertyPathParser.js';

/**
 * Executor for condition-type steps.
 * Evaluates property path expressions and determines the next step.
 */
export class ConditionEvaluator extends BaseStepExecutor {
  async execute(step: WorkflowStep, context: WorkflowContext): Promise<StepExecutionResult> {
    if (!isConditionConfig(step.config)) {
      return this.failure('INVALID_CONFIG', 'Step config is not a ConditionConfig');
    }

    const config = step.config;

    try {
      // Evaluate the condition expression
      const result = evaluateExpression(config.expression, context);

      if (result.error) {
        return this.failure('EVALUATION_ERROR', result.error);
      }

      // Determine next step based on result
      const nextStepId = result.result ? config.then : config.else;

      return this.success(
        {
          expression: config.expression,
          result: result.result,
          resolvedValue: result.resolvedValue,
          nextStep: nextStepId,
        },
        nextStepId
      );
    } catch (error) {
      return this.failure(
        'EVALUATION_ERROR',
        error instanceof Error ? error.message : String(error)
      );
    }
  }
}

/**
 * Create a condition evaluator function.
 */
export function createConditionEvaluator(): StepExecutor {
  const evaluator = new ConditionEvaluator();
  return async (step, context) => evaluator.execute(step, context);
}

/**
 * Evaluate a condition expression against a context.
 * Convenience function for external use.
 */
export function evaluateCondition(
  expression: string,
  context: WorkflowContext
): EvaluationResult {
  return evaluateExpression(expression, context);
}

/**
 * Evaluate multiple conditions with AND logic.
 */
export function evaluateAllConditions(
  expressions: string[],
  context: WorkflowContext
): { result: boolean; results: EvaluationResult[] } {
  const results = expressions.map((expr) => evaluateExpression(expr, context));
  const allTrue = results.every((r) => r.result && !r.error);
  return { result: allTrue, results };
}

/**
 * Evaluate multiple conditions with OR logic.
 */
export function evaluateAnyCondition(
  expressions: string[],
  context: WorkflowContext
): { result: boolean; results: EvaluationResult[] } {
  const results = expressions.map((expr) => evaluateExpression(expr, context));
  const anyTrue = results.some((r) => r.result && !r.error);
  return { result: anyTrue, results };
}

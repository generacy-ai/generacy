/**
 * Condition Evaluator Tests
 */

import { describe, it, expect } from 'vitest';
import {
  ConditionEvaluator,
  evaluateCondition,
  evaluateAllConditions,
  evaluateAnyCondition,
} from '../../src/execution/ConditionEvaluator.js';
import type { WorkflowStep, ConditionConfig } from '../../src/types/WorkflowDefinition.js';
import type { WorkflowContext } from '../../src/types/WorkflowContext.js';

describe('ConditionEvaluator', () => {
  const createContext = (data: Record<string, unknown> = {}): WorkflowContext => ({
    input: {},
    outputs: {},
    data,
    metadata: {},
  });

  const createConditionStep = (config: ConditionConfig): WorkflowStep => ({
    id: 'condition-step',
    type: 'condition',
    config,
  });

  describe('execute', () => {
    const evaluator = new ConditionEvaluator();

    it('evaluates true condition and returns then step', async () => {
      const step = createConditionStep({
        expression: 'data.status == approved',
        then: 'approved-step',
        else: 'rejected-step',
      });
      const context = createContext({ status: 'approved' });

      const result = await evaluator.execute(step, context);

      expect(result.success).toBe(true);
      expect(result.nextStepId).toBe('approved-step');
      expect((result.output as { result: boolean }).result).toBe(true);
    });

    it('evaluates false condition and returns else step', async () => {
      const step = createConditionStep({
        expression: 'data.status == approved',
        then: 'approved-step',
        else: 'rejected-step',
      });
      const context = createContext({ status: 'rejected' });

      const result = await evaluator.execute(step, context);

      expect(result.success).toBe(true);
      expect(result.nextStepId).toBe('rejected-step');
      expect((result.output as { result: boolean }).result).toBe(false);
    });

    it('handles numeric comparisons', async () => {
      const step = createConditionStep({
        expression: 'data.count > 10',
        then: 'high',
        else: 'low',
      });

      const highContext = createContext({ count: 15 });
      const lowContext = createContext({ count: 5 });

      const highResult = await evaluator.execute(step, highContext);
      const lowResult = await evaluator.execute(step, lowContext);

      expect(highResult.nextStepId).toBe('high');
      expect(lowResult.nextStepId).toBe('low');
    });

    it('handles nested property paths', async () => {
      const step = createConditionStep({
        expression: 'data.user.role == admin',
        then: 'admin-step',
        else: 'user-step',
      });
      const context = createContext({ user: { role: 'admin' } });

      const result = await evaluator.execute(step, context);

      expect(result.nextStepId).toBe('admin-step');
    });

    it('returns error for invalid config', async () => {
      const step: WorkflowStep = {
        id: 'invalid-step',
        type: 'condition',
        config: { command: 'test', mode: 'coding' } as unknown as ConditionConfig,
      };
      const context = createContext();

      const result = await evaluator.execute(step, context);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INVALID_CONFIG');
    });

    it('returns error for invalid expression', async () => {
      const step = createConditionStep({
        expression: 'invalid expression without operator',
        then: 'step-a',
        else: 'step-b',
      });
      const context = createContext();

      const result = await evaluator.execute(step, context);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('EVALUATION_ERROR');
    });
  });

  describe('evaluateCondition', () => {
    it('evaluates simple equality', () => {
      const context = createContext({ flag: true });
      const result = evaluateCondition('data.flag == true', context);

      expect(result.result).toBe(true);
    });

    it('evaluates string contains', () => {
      const context = createContext({ message: 'Hello, World!' });
      const result = evaluateCondition('data.message contains "World"', context);

      expect(result.result).toBe(true);
    });

    it('handles missing properties', () => {
      const context = createContext({});
      const result = evaluateCondition('data.missing == undefined', context);

      expect(result.result).toBe(true);
    });
  });

  describe('evaluateAllConditions', () => {
    it('returns true when all conditions pass', () => {
      const context = createContext({ a: 1, b: 2 });
      const { result, results } = evaluateAllConditions(
        ['data.a == 1', 'data.b == 2'],
        context
      );

      expect(result).toBe(true);
      expect(results.every((r) => r.result)).toBe(true);
    });

    it('returns false when any condition fails', () => {
      const context = createContext({ a: 1, b: 3 });
      const { result } = evaluateAllConditions(
        ['data.a == 1', 'data.b == 2'],
        context
      );

      expect(result).toBe(false);
    });
  });

  describe('evaluateAnyCondition', () => {
    it('returns true when any condition passes', () => {
      const context = createContext({ a: 1, b: 3 });
      const { result } = evaluateAnyCondition(
        ['data.a == 1', 'data.b == 2'],
        context
      );

      expect(result).toBe(true);
    });

    it('returns false when no conditions pass', () => {
      const context = createContext({ a: 2, b: 3 });
      const { result } = evaluateAnyCondition(
        ['data.a == 1', 'data.b == 2'],
        context
      );

      expect(result).toBe(false);
    });
  });
});

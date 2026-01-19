/**
 * CounterfactualAnalyzer Tests
 *
 * Tests for "what if" analysis - estimating what would have happened
 * with different choices.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  DefaultCounterfactualAnalyzer,
  type CounterfactualAnalyzer,
} from '../../src/attribution/counterfactual-analyzer.js';
import { DefaultOutcomeEvaluator } from '../../src/attribution/outcome-evaluator.js';
import type {
  ThreeLayerDecision,
  DecisionOutcome,
  CounterfactualResult,
} from '../../src/attribution/types.js';

describe('CounterfactualAnalyzer', () => {
  let analyzer: CounterfactualAnalyzer;

  beforeEach(() => {
    const outcomeEvaluator = new DefaultOutcomeEvaluator();
    analyzer = new DefaultCounterfactualAnalyzer(outcomeEvaluator);
  });

  // Helper to create a test decision
  const createDecision = (
    baselineOption: string,
    protegeOption: string,
    humanOption: string
  ): ThreeLayerDecision => ({
    id: 'decision-1',
    request: {
      id: 'request-1',
      description: 'Test decision',
      optionIds: ['option-a', 'option-b', 'option-c'],
    },
    baseline: { optionId: baselineOption, confidence: 0.8 },
    protege: { optionId: protegeOption, confidence: 0.75 },
    humanChoice: {
      optionId: humanOption,
      wasOverride: humanOption !== protegeOption,
      userId: 'user-1',
    },
    decidedAt: new Date(),
  });

  describe('analyzeBaseline', () => {
    it('should analyze what baseline would have produced', () => {
      // Human chose differently from baseline
      const decision = createDecision('option-a', 'option-b', 'option-b');
      const outcome: DecisionOutcome = {
        decisionId: 'decision-1',
        result: { status: 'success', details: 'Human choice worked' },
        recordedAt: new Date(),
        evidence: ['Option B succeeded'],
      };

      const result = analyzer.analyzeBaseline(decision, outcome);

      expect(result).toBeDefined();
      expect(result.alternativeOutcome).toBeDefined();
      expect(typeof result.wouldHaveWorked === 'boolean' || result.wouldHaveWorked === null).toBe(
        true
      );
      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
      expect(result.reasoning.length).toBeGreaterThan(0);
    });

    it('should return same outcome when baseline matches human choice', () => {
      const decision = createDecision('option-a', 'option-a', 'option-a');
      const outcome: DecisionOutcome = {
        decisionId: 'decision-1',
        result: { status: 'success', details: 'Success' },
        recordedAt: new Date(),
        evidence: ['Worked'],
      };

      const result = analyzer.analyzeBaseline(decision, outcome);

      // When baseline equals human choice, outcome is the same
      expect(result.wouldHaveWorked).toBe(true);
      expect(result.confidence).toBeGreaterThanOrEqual(0.9);
    });

    it('should estimate failure when actual choice succeeded and baseline differed', () => {
      const decision = createDecision('option-a', 'option-b', 'option-b');
      const outcome: DecisionOutcome = {
        decisionId: 'decision-1',
        result: { status: 'success', details: 'Option B worked' },
        recordedAt: new Date(),
        evidence: ['Human and protégé were right'],
      };

      const result = analyzer.analyzeBaseline(decision, outcome);

      // Baseline chose differently, so it likely would not have worked
      expect(result.wouldHaveWorked).toBe(false);
      // Lower confidence because we're speculating
      expect(result.confidence).toBeLessThan(0.8);
    });

    it('should have lower confidence than direct observation', () => {
      const decision = createDecision('option-a', 'option-b', 'option-b');
      const outcome: DecisionOutcome = {
        decisionId: 'decision-1',
        result: { status: 'success', details: 'Success' },
        recordedAt: new Date(),
        evidence: ['Worked'],
      };

      const result = analyzer.analyzeBaseline(decision, outcome);

      // Counterfactual analysis should never be as confident as observed reality
      expect(result.confidence).toBeLessThan(1.0);
    });
  });

  describe('analyzeProtege', () => {
    it('should analyze what protégé would have produced', () => {
      // Human overrode protégé recommendation
      const decision = createDecision('option-a', 'option-a', 'option-b');
      const outcome: DecisionOutcome = {
        decisionId: 'decision-1',
        result: { status: 'failure', details: 'Human override failed', severity: 'major' },
        recordedAt: new Date(),
        evidence: ['Option B was wrong'],
      };

      const result = analyzer.analyzeProtege(decision, outcome);

      expect(result).toBeDefined();
      expect(result.alternativeOutcome).toBeDefined();
      expect(result.reasoning.length).toBeGreaterThan(0);
    });

    it('should return same outcome when protégé matches human choice', () => {
      const decision = createDecision('option-a', 'option-b', 'option-b');
      const outcome: DecisionOutcome = {
        decisionId: 'decision-1',
        result: { status: 'success', details: 'Success' },
        recordedAt: new Date(),
        evidence: ['Worked'],
      };

      const result = analyzer.analyzeProtege(decision, outcome);

      // Protégé equals human choice, so outcome is the same
      expect(result.wouldHaveWorked).toBe(true);
      expect(result.confidence).toBeGreaterThanOrEqual(0.9);
    });

    it('should estimate success when actual choice failed and protégé differed', () => {
      const decision = createDecision('option-a', 'option-a', 'option-b');
      const outcome: DecisionOutcome = {
        decisionId: 'decision-1',
        result: { status: 'failure', details: 'Human choice failed', severity: 'major' },
        recordedAt: new Date(),
        evidence: ['Option B was wrong'],
      };

      const result = analyzer.analyzeProtege(decision, outcome);

      // Human failed with option-b, protégé had option-a
      // We estimate protégé might have been right
      expect(result.wouldHaveWorked).toBe(true);
    });
  });

  describe('Confidence Scoring', () => {
    it('should have confidence between 0 and 1', () => {
      const decision = createDecision('option-a', 'option-b', 'option-c');
      const outcome: DecisionOutcome = {
        decisionId: 'decision-1',
        result: { status: 'success', details: 'Success' },
        recordedAt: new Date(),
        evidence: ['Worked'],
      };

      const baselineResult = analyzer.analyzeBaseline(decision, outcome);
      const protegeResult = analyzer.analyzeProtege(decision, outcome);

      expect(baselineResult.confidence).toBeGreaterThanOrEqual(0);
      expect(baselineResult.confidence).toBeLessThanOrEqual(1);
      expect(protegeResult.confidence).toBeGreaterThanOrEqual(0);
      expect(protegeResult.confidence).toBeLessThanOrEqual(1);
    });

    it('should reduce confidence for partial outcomes', () => {
      const decision = createDecision('option-a', 'option-b', 'option-c');
      const successOutcome: DecisionOutcome = {
        decisionId: 'decision-1',
        result: { status: 'success', details: 'Clear success' },
        recordedAt: new Date(),
        evidence: ['Worked'],
      };
      const partialOutcome: DecisionOutcome = {
        decisionId: 'decision-1',
        result: { status: 'partial', successRate: 0.6, details: 'Partial' },
        recordedAt: new Date(),
        evidence: ['Some worked'],
      };

      const successResult = analyzer.analyzeBaseline(decision, successOutcome);
      const partialResult = analyzer.analyzeBaseline(decision, partialOutcome);

      // Partial outcomes lead to less confident counterfactuals
      expect(partialResult.confidence).toBeLessThanOrEqual(successResult.confidence);
    });

    it('should return zero confidence for unknown outcomes', () => {
      const decision = createDecision('option-a', 'option-b', 'option-c');
      const unknownOutcome: DecisionOutcome = {
        decisionId: 'decision-1',
        result: { status: 'unknown', reason: 'Cannot determine' },
        recordedAt: new Date(),
        evidence: [],
      };

      const baselineResult = analyzer.analyzeBaseline(decision, unknownOutcome);
      const protegeResult = analyzer.analyzeProtege(decision, unknownOutcome);

      expect(baselineResult.confidence).toBe(0);
      expect(baselineResult.wouldHaveWorked).toBeNull();
      expect(protegeResult.confidence).toBe(0);
      expect(protegeResult.wouldHaveWorked).toBeNull();
    });
  });

  describe('Reasoning Generation', () => {
    it('should provide reasoning for baseline analysis', () => {
      const decision = createDecision('option-a', 'option-b', 'option-b');
      const outcome: DecisionOutcome = {
        decisionId: 'decision-1',
        result: { status: 'success', details: 'Success' },
        recordedAt: new Date(),
        evidence: ['Worked'],
      };

      const result = analyzer.analyzeBaseline(decision, outcome);

      expect(result.reasoning).toBeDefined();
      expect(result.reasoning.length).toBeGreaterThan(0);
    });

    it('should provide reasoning for protégé analysis', () => {
      const decision = createDecision('option-a', 'option-a', 'option-b');
      const outcome: DecisionOutcome = {
        decisionId: 'decision-1',
        result: { status: 'failure', details: 'Failed', severity: 'major' },
        recordedAt: new Date(),
        evidence: ['Did not work'],
      };

      const result = analyzer.analyzeProtege(decision, outcome);

      expect(result.reasoning).toBeDefined();
      expect(result.reasoning.length).toBeGreaterThan(0);
    });

    it('should include alternative outcome description', () => {
      const decision = createDecision('option-a', 'option-b', 'option-c');
      const outcome: DecisionOutcome = {
        decisionId: 'decision-1',
        result: { status: 'success', details: 'Human choice succeeded' },
        recordedAt: new Date(),
        evidence: ['Option C was correct'],
      };

      const baselineResult = analyzer.analyzeBaseline(decision, outcome);
      const protegeResult = analyzer.analyzeProtege(decision, outcome);

      expect(baselineResult.alternativeOutcome.length).toBeGreaterThan(0);
      expect(protegeResult.alternativeOutcome.length).toBeGreaterThan(0);
    });
  });
});

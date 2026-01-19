/**
 * OutcomeEvaluator Tests
 *
 * Tests for evaluating decision outcomes and counterfactual analysis.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  DefaultOutcomeEvaluator,
  type OutcomeEvaluator,
} from '../../src/attribution/outcome-evaluator.js';
import type {
  ThreeLayerDecision,
  DecisionOutcome,
  OutcomeAssessment,
} from '../../src/attribution/types.js';

describe('OutcomeEvaluator', () => {
  let evaluator: OutcomeEvaluator;

  beforeEach(() => {
    evaluator = new DefaultOutcomeEvaluator();
  });

  // Helper to create a test decision
  const createTestDecision = (
    humanOptionId: string,
    baselineOptionId: string = 'option-a',
    protegeOptionId: string = 'option-a'
  ): ThreeLayerDecision => ({
    id: 'decision-1',
    request: {
      id: 'request-1',
      description: 'Test decision',
      optionIds: ['option-a', 'option-b', 'option-c'],
    },
    baseline: { optionId: baselineOptionId, confidence: 0.8 },
    protege: { optionId: protegeOptionId, confidence: 0.75 },
    humanChoice: {
      optionId: humanOptionId,
      wasOverride: humanOptionId !== protegeOptionId,
      userId: 'user-1',
    },
    decidedAt: new Date(),
  });

  describe('evaluateOutcome - Success Outcomes', () => {
    it('should evaluate a successful outcome as worked', () => {
      const decision = createTestDecision('option-a');
      const outcome: DecisionOutcome = {
        decisionId: 'decision-1',
        result: { status: 'success', details: 'The decision worked perfectly' },
        recordedAt: new Date(),
        evidence: ['Metric improved by 20%', 'No issues reported'],
      };

      const assessment = evaluator.evaluateOutcome(decision, outcome);

      expect(assessment.worked).toBe(true);
      expect(assessment.confidence).toBeGreaterThanOrEqual(0.8);
      expect(assessment.method).toBe('direct_observation');
      expect(assessment.evidence.length).toBeGreaterThan(0);
    });

    it('should have high confidence for success with strong evidence', () => {
      const decision = createTestDecision('option-b');
      const outcome: DecisionOutcome = {
        decisionId: 'decision-1',
        result: { status: 'success', details: 'Complete success' },
        recordedAt: new Date(),
        evidence: [
          'All tests passed',
          'Performance improved',
          'User satisfaction increased',
          'No errors in production',
        ],
      };

      const assessment = evaluator.evaluateOutcome(decision, outcome);

      expect(assessment.worked).toBe(true);
      expect(assessment.confidence).toBeGreaterThanOrEqual(0.9);
    });
  });

  describe('evaluateOutcome - Failure Outcomes', () => {
    it('should evaluate a failure outcome as not worked', () => {
      const decision = createTestDecision('option-a');
      const outcome: DecisionOutcome = {
        decisionId: 'decision-1',
        result: { status: 'failure', details: 'The decision failed', severity: 'major' },
        recordedAt: new Date(),
        evidence: ['System crashed', 'Data loss occurred'],
      };

      const assessment = evaluator.evaluateOutcome(decision, outcome);

      expect(assessment.worked).toBe(false);
      expect(assessment.confidence).toBeGreaterThanOrEqual(0.8);
      expect(assessment.method).toBe('direct_observation');
    });

    it('should differentiate failure severities', () => {
      const decision = createTestDecision('option-a');

      const minorFailure: DecisionOutcome = {
        decisionId: 'decision-1',
        result: { status: 'failure', details: 'Minor issue', severity: 'minor' },
        recordedAt: new Date(),
        evidence: ['Small bug found'],
      };

      const criticalFailure: DecisionOutcome = {
        decisionId: 'decision-1',
        result: { status: 'failure', details: 'Critical failure', severity: 'critical' },
        recordedAt: new Date(),
        evidence: ['Complete system failure'],
      };

      const minorAssessment = evaluator.evaluateOutcome(decision, minorFailure);
      const criticalAssessment = evaluator.evaluateOutcome(decision, criticalFailure);

      expect(minorAssessment.worked).toBe(false);
      expect(criticalAssessment.worked).toBe(false);
      // Both are failures, confidence should be high for clear failure
      expect(criticalAssessment.confidence).toBeGreaterThanOrEqual(minorAssessment.confidence);
    });
  });

  describe('evaluateOutcome - Partial Outcomes', () => {
    it('should evaluate partial success with high success rate as worked', () => {
      const decision = createTestDecision('option-a');
      const outcome: DecisionOutcome = {
        decisionId: 'decision-1',
        result: { status: 'partial', successRate: 0.8, details: 'Mostly successful' },
        recordedAt: new Date(),
        evidence: ['8 out of 10 criteria met'],
      };

      const assessment = evaluator.evaluateOutcome(decision, outcome);

      expect(assessment.worked).toBe(true);
      // Confidence should be moderate for partial success
      expect(assessment.confidence).toBeLessThan(0.9);
      expect(assessment.confidence).toBeGreaterThan(0.5);
    });

    it('should evaluate partial success with low success rate as not worked', () => {
      const decision = createTestDecision('option-a');
      const outcome: DecisionOutcome = {
        decisionId: 'decision-1',
        result: { status: 'partial', successRate: 0.3, details: 'Mostly failed' },
        recordedAt: new Date(),
        evidence: ['Only 3 out of 10 criteria met'],
      };

      const assessment = evaluator.evaluateOutcome(decision, outcome);

      expect(assessment.worked).toBe(false);
    });

    it('should handle borderline partial outcomes', () => {
      const decision = createTestDecision('option-a');
      const outcome: DecisionOutcome = {
        decisionId: 'decision-1',
        result: { status: 'partial', successRate: 0.5, details: 'Mixed results' },
        recordedAt: new Date(),
        evidence: ['Half of criteria met'],
      };

      const assessment = evaluator.evaluateOutcome(decision, outcome);

      // Borderline case - confidence should be lower
      expect(assessment.confidence).toBeLessThan(0.7);
    });
  });

  describe('evaluateOutcome - Unknown Outcomes', () => {
    it('should return null worked for unknown outcomes', () => {
      const decision = createTestDecision('option-a');
      const outcome: DecisionOutcome = {
        decisionId: 'decision-1',
        result: { status: 'unknown', reason: 'Insufficient data to determine outcome' },
        recordedAt: new Date(),
        evidence: [],
      };

      const assessment = evaluator.evaluateOutcome(decision, outcome);

      expect(assessment.worked).toBeNull();
      expect(assessment.confidence).toBe(0);
    });

    it('should include the unknown reason in evidence', () => {
      const decision = createTestDecision('option-a');
      const unknownReason = 'Outcome measurement system offline';
      const outcome: DecisionOutcome = {
        decisionId: 'decision-1',
        result: { status: 'unknown', reason: unknownReason },
        recordedAt: new Date(),
        evidence: [],
      };

      const assessment = evaluator.evaluateOutcome(decision, outcome);

      expect(assessment.evidence).toContain(unknownReason);
    });
  });

  describe('evaluateCounterfactual', () => {
    it('should evaluate what would have happened with baseline choice', () => {
      const decision = createTestDecision('option-b', 'option-a', 'option-a');
      const outcome: DecisionOutcome = {
        decisionId: 'decision-1',
        result: { status: 'failure', details: 'Human choice failed', severity: 'major' },
        recordedAt: new Date(),
        evidence: ['Option B was wrong'],
      };

      const counterfactual = evaluator.evaluateCounterfactual(
        decision,
        'option-b', // actual choice
        'option-a', // alternative (baseline)
        outcome
      );

      expect(counterfactual).toBeDefined();
      expect(counterfactual.alternativeOutcome).toBeDefined();
      expect(typeof counterfactual.wouldHaveWorked).toBe('boolean');
      expect(counterfactual.confidence).toBeGreaterThanOrEqual(0);
      expect(counterfactual.confidence).toBeLessThanOrEqual(1);
      expect(counterfactual.reasoning).toBeDefined();
    });

    it('should evaluate counterfactual for protégé alternative', () => {
      const decision = createTestDecision('option-c', 'option-a', 'option-b');
      const outcome: DecisionOutcome = {
        decisionId: 'decision-1',
        result: { status: 'success', details: 'Human choice succeeded' },
        recordedAt: new Date(),
        evidence: ['Option C worked'],
      };

      const counterfactual = evaluator.evaluateCounterfactual(
        decision,
        'option-c', // actual choice
        'option-b', // alternative (protégé)
        outcome
      );

      expect(counterfactual).toBeDefined();
      expect(counterfactual.reasoning.length).toBeGreaterThan(0);
    });

    it('should have lower confidence for counterfactual than direct observation', () => {
      const decision = createTestDecision('option-a');
      const outcome: DecisionOutcome = {
        decisionId: 'decision-1',
        result: { status: 'success', details: 'Success' },
        recordedAt: new Date(),
        evidence: ['Worked'],
      };

      const directAssessment = evaluator.evaluateOutcome(decision, outcome);
      const counterfactual = evaluator.evaluateCounterfactual(
        decision,
        'option-a',
        'option-b',
        outcome
      );

      // Counterfactual inherently has more uncertainty
      expect(counterfactual.confidence).toBeLessThanOrEqual(directAssessment.confidence);
    });

    it('should handle counterfactual when alternative equals actual choice', () => {
      const decision = createTestDecision('option-a');
      const outcome: DecisionOutcome = {
        decisionId: 'decision-1',
        result: { status: 'success', details: 'Success' },
        recordedAt: new Date(),
        evidence: ['Worked'],
      };

      // Asking about counterfactual of the same option
      const counterfactual = evaluator.evaluateCounterfactual(
        decision,
        'option-a',
        'option-a', // Same as actual
        outcome
      );

      // Should have high confidence since we know the actual outcome
      expect(counterfactual.wouldHaveWorked).toBe(true);
      expect(counterfactual.confidence).toBeGreaterThanOrEqual(0.9);
    });
  });
});

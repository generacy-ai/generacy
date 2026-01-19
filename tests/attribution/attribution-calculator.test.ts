/**
 * AttributionCalculator Tests
 *
 * Tests for the core attribution calculation logic.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  DefaultAttributionCalculator,
  type AttributionCalculator,
} from '../../src/attribution/attribution-calculator.js';
import { DefaultOutcomeEvaluator } from '../../src/attribution/outcome-evaluator.js';
import { DefaultCounterfactualAnalyzer } from '../../src/attribution/counterfactual-analyzer.js';
import type {
  ThreeLayerDecision,
  DecisionOutcome,
  Attribution,
  AttributionCategory,
  ValueSource,
} from '../../src/attribution/types.js';

describe('AttributionCalculator', () => {
  let calculator: AttributionCalculator;

  beforeEach(() => {
    const outcomeEvaluator = new DefaultOutcomeEvaluator();
    const counterfactualAnalyzer = new DefaultCounterfactualAnalyzer(outcomeEvaluator);
    calculator = new DefaultAttributionCalculator(outcomeEvaluator, counterfactualAnalyzer);
  });

  // Helper to create a test decision with all three layers
  const createDecision = (
    baselineOption: string,
    protegeOption: string,
    humanOption: string
  ): ThreeLayerDecision => ({
    id: `decision-${Date.now()}`,
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

  // Helper to create a success outcome
  const createSuccessOutcome = (decisionId: string): DecisionOutcome => ({
    decisionId,
    result: { status: 'success', details: 'Success' },
    recordedAt: new Date(),
    evidence: ['Outcome was successful'],
  });

  // Helper to create a failure outcome
  const createFailureOutcome = (decisionId: string): DecisionOutcome => ({
    decisionId,
    result: { status: 'failure', details: 'Failed', severity: 'major' },
    recordedAt: new Date(),
    evidence: ['Outcome failed'],
  });

  describe('Attribution Scenarios - All Correct', () => {
    it('should attribute all_aligned when B = P = H and all correct', () => {
      // All layers chose the same option and it was correct
      const decision = createDecision('option-a', 'option-a', 'option-a');
      const outcome = createSuccessOutcome(decision.id);

      const attribution = calculator.calculateAttribution(decision, outcome);

      expect(attribution.whoWasRight).toBe('all_aligned');
      expect(attribution.valueSource).toBe('system');
      expect(attribution.baselineCorrect).toBe(true);
      expect(attribution.protegeCorrect).toBe(true);
      expect(attribution.humanCorrect).toBe(true);
    });

    it('should have high confidence when all aligned and successful', () => {
      const decision = createDecision('option-a', 'option-a', 'option-a');
      const outcome = createSuccessOutcome(decision.id);

      const attribution = calculator.calculateAttribution(decision, outcome);

      expect(attribution.confidence).toBeGreaterThanOrEqual(0.8);
    });
  });

  describe('Attribution Scenarios - Human Unique Value', () => {
    it('should attribute human_unique when B = P ≠ H and human correct', () => {
      // Baseline and protégé agreed, but human chose differently and was right
      const decision = createDecision('option-a', 'option-a', 'option-b');
      const outcome = createSuccessOutcome(decision.id);

      const attribution = calculator.calculateAttribution(decision, outcome);

      expect(attribution.whoWasRight).toBe('human_unique');
      expect(attribution.valueSource).toBe('human_judgment');
      expect(attribution.humanCorrect).toBe(true);
      // Baseline and protégé would have been wrong
      expect(attribution.baselineCorrect).toBe(false);
      expect(attribution.protegeCorrect).toBe(false);
    });
  });

  describe('Attribution Scenarios - Protégé Wisdom', () => {
    it('should attribute protege_wisdom when B ≠ P = H and both correct', () => {
      // Baseline different from protégé, but protégé and human agreed and were right
      const decision = createDecision('option-a', 'option-b', 'option-b');
      const outcome = createSuccessOutcome(decision.id);

      const attribution = calculator.calculateAttribution(decision, outcome);

      expect(attribution.whoWasRight).toBe('protege_wisdom');
      expect(attribution.valueSource).toBe('protege_wisdom');
      expect(attribution.protegeCorrect).toBe(true);
      expect(attribution.humanCorrect).toBe(true);
      expect(attribution.baselineCorrect).toBe(false);
    });
  });

  describe('Attribution Scenarios - Collaboration', () => {
    it('should attribute collaboration when B ≠ P ≠ H and human correct', () => {
      // All three layers chose different options, human was right
      const decision = createDecision('option-a', 'option-b', 'option-c');
      const outcome = createSuccessOutcome(decision.id);

      const attribution = calculator.calculateAttribution(decision, outcome);

      expect(attribution.whoWasRight).toBe('collaboration');
      expect(attribution.valueSource).toBe('collaboration');
      expect(attribution.humanCorrect).toBe(true);
      expect(attribution.baselineCorrect).toBe(false);
      expect(attribution.protegeCorrect).toBe(false);
    });
  });

  describe('Attribution Scenarios - Incorrect Choices', () => {
    it('should attribute baseline_only when B correct but P and H wrong', () => {
      // Baseline was right, but protégé and human overrode incorrectly
      const decision = createDecision('option-a', 'option-b', 'option-b');
      const outcome = createFailureOutcome(decision.id);

      const attribution = calculator.calculateAttribution(decision, outcome);

      expect(attribution.whoWasRight).toBe('baseline_only');
      expect(attribution.valueSource).toBe('system');
      expect(attribution.baselineCorrect).toBe(true);
      expect(attribution.protegeCorrect).toBe(false);
      expect(attribution.humanCorrect).toBe(false);
    });

    it('should attribute protege_wrong when B correct but P diverged incorrectly', () => {
      // Baseline correct, protégé chose wrong, human followed protégé
      const decision = createDecision('option-a', 'option-b', 'option-b');
      const outcome = createFailureOutcome(decision.id);

      const attribution = calculator.calculateAttribution(decision, outcome);

      // When baseline would have been right but protégé diverged
      expect(attribution.protegeCorrect).toBe(false);
      expect(attribution.baselineCorrect).toBe(true);
    });

    it('should attribute human_wrong when P correct but H overrode incorrectly', () => {
      // Protégé was right, but human overrode with wrong choice
      const decision = createDecision('option-a', 'option-a', 'option-b');
      const outcome = createFailureOutcome(decision.id);

      const attribution = calculator.calculateAttribution(decision, outcome);

      expect(attribution.whoWasRight).toBe('human_wrong');
      expect(attribution.valueSource).toBe('system');
      expect(attribution.protegeCorrect).toBe(true);
      expect(attribution.humanCorrect).toBe(false);
    });

    it('should attribute all_wrong when everyone was wrong', () => {
      // All layers chose wrong options
      const decision = createDecision('option-a', 'option-a', 'option-a');
      const outcome = createFailureOutcome(decision.id);

      const attribution = calculator.calculateAttribution(decision, outcome);

      expect(attribution.whoWasRight).toBe('all_wrong');
      expect(attribution.valueSource).toBe('none');
      expect(attribution.baselineCorrect).toBe(false);
      expect(attribution.protegeCorrect).toBe(false);
      expect(attribution.humanCorrect).toBe(false);
    });
  });

  describe('Unknown/Null Outcome Handling', () => {
    it('should return unknown attribution for unknown outcomes', () => {
      const decision = createDecision('option-a', 'option-a', 'option-a');
      const outcome: DecisionOutcome = {
        decisionId: decision.id,
        result: { status: 'unknown', reason: 'Cannot determine outcome' },
        recordedAt: new Date(),
        evidence: [],
      };

      const attribution = calculator.calculateAttribution(decision, outcome);

      expect(attribution.whoWasRight).toBe('unknown');
      expect(attribution.valueSource).toBe('none');
      expect(attribution.baselineCorrect).toBeNull();
      expect(attribution.protegeCorrect).toBeNull();
      expect(attribution.humanCorrect).toBeNull();
    });

    it('should have zero confidence for unknown outcomes', () => {
      const decision = createDecision('option-a', 'option-a', 'option-a');
      const outcome: DecisionOutcome = {
        decisionId: decision.id,
        result: { status: 'unknown', reason: 'No data' },
        recordedAt: new Date(),
        evidence: [],
      };

      const attribution = calculator.calculateAttribution(decision, outcome);

      expect(attribution.confidence).toBe(0);
    });
  });

  describe('Confidence Calculation', () => {
    it('should have higher confidence for clear success outcomes', () => {
      const decision = createDecision('option-a', 'option-a', 'option-a');
      const successOutcome = createSuccessOutcome(decision.id);
      const partialOutcome: DecisionOutcome = {
        decisionId: decision.id,
        result: { status: 'partial', successRate: 0.6, details: 'Partial success' },
        recordedAt: new Date(),
        evidence: ['Some criteria met'],
      };

      const successAttribution = calculator.calculateAttribution(decision, successOutcome);
      const partialAttribution = calculator.calculateAttribution(decision, partialOutcome);

      expect(successAttribution.confidence).toBeGreaterThan(partialAttribution.confidence);
    });

    it('should include counterfactual analysis when available', () => {
      const decision = createDecision('option-a', 'option-a', 'option-b');
      const outcome = createSuccessOutcome(decision.id);

      const attribution = calculator.calculateAttribution(decision, outcome);

      expect(attribution.counterfactual).toBeDefined();
      expect(attribution.counterfactual?.baselineAlternative).toBeDefined();
    });
  });

  describe('Attribution Timestamps', () => {
    it('should record calculation timestamp', () => {
      const decision = createDecision('option-a', 'option-a', 'option-a');
      const outcome = createSuccessOutcome(decision.id);

      const beforeCalc = new Date();
      const attribution = calculator.calculateAttribution(decision, outcome);
      const afterCalc = new Date();

      expect(attribution.calculatedAt.getTime()).toBeGreaterThanOrEqual(beforeCalc.getTime());
      expect(attribution.calculatedAt.getTime()).toBeLessThanOrEqual(afterCalc.getTime());
    });

    it('should link attribution to decision ID', () => {
      const decision = createDecision('option-a', 'option-a', 'option-a');
      decision.id = 'specific-decision-id';
      const outcome = createSuccessOutcome(decision.id);

      const attribution = calculator.calculateAttribution(decision, outcome);

      expect(attribution.decisionId).toBe('specific-decision-id');
    });
  });
});

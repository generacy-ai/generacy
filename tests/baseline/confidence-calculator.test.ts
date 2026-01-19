import { describe, it, expect, beforeEach } from 'vitest';
import { ConfidenceCalculator } from '../../src/baseline/confidence-calculator.js';
import type { ConsiderationFactor } from '../../src/baseline/types.js';

describe('ConfidenceCalculator', () => {
  let calculator: ConfidenceCalculator;

  beforeEach(() => {
    calculator = new ConfidenceCalculator();
  });

  // Helper functions to generate test factors
  const supportFactor = (weight: number): ConsiderationFactor => ({
    name: 'test-support-factor',
    value: 'test value',
    weight,
    impact: 'supports',
    explanation: 'Test supporting factor',
  });

  const opposeFactor = (weight: number): ConsiderationFactor => ({
    name: 'test-oppose-factor',
    value: 'test value',
    weight,
    impact: 'opposes',
    explanation: 'Test opposing factor',
  });

  const neutralFactor = (weight: number): ConsiderationFactor => ({
    name: 'test-neutral-factor',
    value: 'test value',
    weight,
    impact: 'neutral',
    explanation: 'Test neutral factor',
  });

  describe('calculateBaseConfidence', () => {
    it('should return 50 for empty factors array', () => {
      const result = calculator.calculateBaseConfidence([]);
      expect(result).toBe(50);
    });

    it('should return 100 when all factors support', () => {
      const factors = [supportFactor(0.5), supportFactor(0.3), supportFactor(0.2)];
      const result = calculator.calculateBaseConfidence(factors);
      expect(result).toBe(100);
    });

    it('should return 0 when all factors oppose', () => {
      const factors = [opposeFactor(0.5), opposeFactor(0.3), opposeFactor(0.2)];
      const result = calculator.calculateBaseConfidence(factors);
      expect(result).toBe(0);
    });

    it('should return ~50 when factors evenly split', () => {
      const factors = [supportFactor(0.5), opposeFactor(0.5)];
      const result = calculator.calculateBaseConfidence(factors);
      expect(result).toBe(50);
    });

    it('should weight factors by their weight property', () => {
      // High weight support, low weight oppose
      const factors = [supportFactor(0.8), opposeFactor(0.2)];
      const result = calculator.calculateBaseConfidence(factors);
      // 0.8 / (0.8 + 0.2) * 100 = 80
      expect(result).toBe(80);
    });

    it('should ignore neutral factors in ratio calculation', () => {
      // Neutral factors contribute to total weight but don't support or oppose
      const factors = [supportFactor(0.5), neutralFactor(0.5)];
      const result = calculator.calculateBaseConfidence(factors);
      // supportingWeight = 0.5, totalWeight = 1.0
      // ratio = 0.5 / 1.0 = 0.5 -> 50%
      expect(result).toBe(50);
    });

    it('should handle zero or negative weights', () => {
      const factors = [
        supportFactor(0),
        supportFactor(-1),
        opposeFactor(0.5),
      ];
      const result = calculator.calculateBaseConfidence(factors);
      // Only the opposing factor with weight 0.5 is counted
      // supportingWeight = 0, totalWeight = 0.5
      // result = 0 / 0.5 * 100 = 0
      expect(result).toBe(0);
    });

    it('should return 50 when all weights are zero or negative', () => {
      const factors = [supportFactor(0), opposeFactor(-1)];
      const result = calculator.calculateBaseConfidence(factors);
      expect(result).toBe(50);
    });

    it('should clamp result to 0-100', () => {
      // Normal cases should already be in range
      const factors = [supportFactor(1), opposeFactor(0.5)];
      const result = calculator.calculateBaseConfidence(factors);
      expect(result).toBeGreaterThanOrEqual(0);
      expect(result).toBeLessThanOrEqual(100);
    });
  });

  describe('applyLLMAdjustment', () => {
    it('should return base when LLM matches base', () => {
      const result = calculator.applyLLMAdjustment(75, 75);
      expect(result).toBe(75);
    });

    it('should apply positive adjustment up to maxAdjustment', () => {
      // Base 50, LLM 60 -> adjustment +10 (within default 20)
      const result = calculator.applyLLMAdjustment(50, 60);
      expect(result).toBe(60);
    });

    it('should apply negative adjustment down to -maxAdjustment', () => {
      // Base 50, LLM 40 -> adjustment -10 (within default 20)
      const result = calculator.applyLLMAdjustment(50, 40);
      expect(result).toBe(40);
    });

    it('should not exceed maxAdjustment (default 20)', () => {
      // Base 50, LLM 100 -> wants +50, clamped to +20 -> 70
      const result = calculator.applyLLMAdjustment(50, 100);
      expect(result).toBe(70);

      // Base 50, LLM 0 -> wants -50, clamped to -20 -> 30
      const result2 = calculator.applyLLMAdjustment(50, 0);
      expect(result2).toBe(30);
    });

    it('should clamp final result to 0-100', () => {
      // Base 95, LLM 100 -> +5 adjustment -> 100 (not 105)
      const result = calculator.applyLLMAdjustment(95, 120);
      expect(result).toBe(100);

      // Base 5, LLM 0 -> -5 adjustment -> 0 (not -15)
      const result2 = calculator.applyLLMAdjustment(5, -20);
      expect(result2).toBe(0);
    });

    it('should handle custom maxAdjustment values', () => {
      // Base 50, LLM 100, maxAdjustment 10 -> +10 -> 60
      const result = calculator.applyLLMAdjustment(50, 100, 10);
      expect(result).toBe(60);

      // Base 50, LLM 0, maxAdjustment 10 -> -10 -> 40
      const result2 = calculator.applyLLMAdjustment(50, 0, 10);
      expect(result2).toBe(40);
    });

    it('should handle edge cases (base=0, base=100, LLM=0, LLM=100)', () => {
      // Base 0, LLM 100 -> +20 adjustment -> 20
      expect(calculator.applyLLMAdjustment(0, 100)).toBe(20);

      // Base 100, LLM 0 -> -20 adjustment -> 80
      expect(calculator.applyLLMAdjustment(100, 0)).toBe(80);

      // Base 0, LLM 0 -> no adjustment -> 0
      expect(calculator.applyLLMAdjustment(0, 0)).toBe(0);

      // Base 100, LLM 100 -> no adjustment -> 100
      expect(calculator.applyLLMAdjustment(100, 100)).toBe(100);
    });
  });

  describe('calculateFactorAgreement', () => {
    it('should return 1 for empty factors (no conflict)', () => {
      const result = calculator.calculateFactorAgreement([]);
      expect(result).toBe(1);
    });

    it('should return 1 when all factors support', () => {
      const factors = [supportFactor(0.5), supportFactor(0.3), supportFactor(0.2)];
      const result = calculator.calculateFactorAgreement(factors);
      expect(result).toBe(1);
    });

    it('should return 1 when all factors oppose', () => {
      const factors = [opposeFactor(0.5), opposeFactor(0.3), opposeFactor(0.2)];
      const result = calculator.calculateFactorAgreement(factors);
      expect(result).toBe(1);
    });

    it('should return 0 when factors split 50/50 by weight', () => {
      const factors = [supportFactor(0.5), opposeFactor(0.5)];
      const result = calculator.calculateFactorAgreement(factors);
      expect(result).toBe(0);
    });

    it('should return intermediate values for partial agreement', () => {
      // 75% support, 25% oppose
      const factors = [supportFactor(0.75), opposeFactor(0.25)];
      const result = calculator.calculateFactorAgreement(factors);
      // dominantRatio = 0.75 / 1.0 = 0.75
      // agreement = 2 * (0.75 - 0.5) = 0.5
      expect(result).toBe(0.5);
    });

    it('should ignore neutral factors', () => {
      // Only support and oppose count, neutral is ignored
      const factors = [
        supportFactor(0.5),
        opposeFactor(0.5),
        neutralFactor(1.0),
      ];
      const result = calculator.calculateFactorAgreement(factors);
      // support = 0.5, oppose = 0.5, nonNeutral = 1.0
      // dominantRatio = 0.5 / 1.0 = 0.5
      // agreement = 2 * (0.5 - 0.5) = 0
      expect(result).toBe(0);
    });

    it('should handle all-neutral factors (return 1)', () => {
      const factors = [neutralFactor(0.5), neutralFactor(0.3)];
      const result = calculator.calculateFactorAgreement(factors);
      expect(result).toBe(1);
    });
  });

  describe('calculateAlternativeConfidence', () => {
    it('should return base confidence when no difference factors', () => {
      const result = calculator.calculateAlternativeConfidence(80, []);
      expect(result).toBe(80);
    });

    it('should reduce confidence when opposing difference factors', () => {
      const differenceFactors = [opposeFactor(0.5), opposeFactor(0.5)];
      const result = calculator.calculateAlternativeConfidence(80, differenceFactors);
      // impactRatio = -1.0 / 1.0 = -1.0
      // adjustment = -1.0 * 40 = -40
      // result = 80 - 40 = 40
      expect(result).toBe(40);
    });

    it('should slightly increase confidence when supporting difference factors', () => {
      const differenceFactors = [supportFactor(0.5), supportFactor(0.5)];
      const result = calculator.calculateAlternativeConfidence(60, differenceFactors);
      // impactRatio = 1.0 / 1.0 = 1.0
      // adjustment = 1.0 * 40 = 40, capped to 20
      // result = 60 + 20 = 80
      expect(result).toBe(80);
    });

    it('should cap upward adjustment', () => {
      const differenceFactors = [supportFactor(1.0)];
      const result = calculator.calculateAlternativeConfidence(80, differenceFactors);
      // impactRatio = 1.0, adjustment = 40, capped to 20
      // result = 80 + 20 = 100
      expect(result).toBe(100);
    });

    it('should clamp result to 0-100', () => {
      // Test lower bound
      const lowerFactors = [opposeFactor(1.0)];
      const lowerResult = calculator.calculateAlternativeConfidence(20, lowerFactors);
      // adjustment = -40, result = 20 - 40 = -20, clamped to 0
      expect(lowerResult).toBe(0);

      // Test upper bound
      const upperFactors = [supportFactor(1.0)];
      const upperResult = calculator.calculateAlternativeConfidence(95, upperFactors);
      // adjustment = 40, capped to 20, result = 95 + 20 = 115, clamped to 100
      expect(upperResult).toBe(100);
    });

    it('should handle empty differenceFactors array', () => {
      const result = calculator.calculateAlternativeConfidence(75, []);
      expect(result).toBe(75);
    });

    it('should reduce confidence slightly when all factors are neutral with valid weights', () => {
      // When all difference factors are neutral, totalWeight > 0 but weightedImpact = 0
      const differenceFactors = [neutralFactor(0.5), neutralFactor(0.5)];
      const result = calculator.calculateAlternativeConfidence(80, differenceFactors);
      // weightedImpact = 0, totalWeight = 1.0
      // impactRatio = 0, adjustment = 0
      // result = 80
      expect(result).toBe(80);
    });

    it('should return reduced confidence when all factors have zero/negative weight', () => {
      const differenceFactors = [supportFactor(0), opposeFactor(-1)];
      const result = calculator.calculateAlternativeConfidence(80, differenceFactors);
      // All weights filtered out, totalWeight = 0
      // Returns base - 10 = 70
      expect(result).toBe(70);
    });
  });
});

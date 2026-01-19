import { describe, it, expect } from 'vitest';
import { calculateConfidence, isLowConfidence } from '../../../src/recommendation/utils/confidence-calculator.js';
import type { AppliedPrinciple } from '../../../src/recommendation/types/index.js';

// Mock data for comprehensive testing
const mockAppliedPrinciples: AppliedPrinciple[] = [
  {
    id: 'principle-1',
    name: 'Principle of Reciprocity',
    weight: 0.8,
    relevanceScore: 0.9,
    domain: 'social-dynamics',
  },
  {
    id: 'principle-2',
    name: 'Principle of Consistency',
    weight: 0.7,
    relevanceScore: 0.85,
    domain: 'behavioral-change',
  },
  {
    id: 'principle-3',
    name: 'Principle of Social Proof',
    weight: 0.75,
    relevanceScore: 0.7,
    domain: 'social-dynamics',
  },
];

const mockLowRelevancePrinciples: AppliedPrinciple[] = [
  {
    id: 'principle-4',
    name: 'Principle of Scarcity',
    weight: 0.6,
    relevanceScore: 0.3,
    domain: 'economic-principles',
  },
  {
    id: 'principle-5',
    name: 'Principle of Authority',
    weight: 0.65,
    relevanceScore: 0.25,
    domain: 'influence',
  },
];

const mockSinglePrinciple: AppliedPrinciple[] = [
  {
    id: 'principle-6',
    name: 'Principle of Liking',
    weight: 0.8,
    relevanceScore: 0.95,
    domain: 'interpersonal',
  },
];

describe('confidence-calculator', () => {
  describe('calculateConfidence', () => {
    it('should calculate confidence based on principle weights and coverage', () => {
      const confidence = calculateConfidence(mockAppliedPrinciples, {
        expectedPrinciplesForDomain: 3,
        contextModifier: 1.0,
      });

      // Formula: Σ(weight × relevance) / max_possible_weight × coverage × context
      // = (0.8*0.9 + 0.7*0.85 + 0.75*0.7) / (0.8+0.7+0.75) × (3/3) × 1.0
      // = (0.72 + 0.595 + 0.525) / 2.25 × 1.0 × 1.0
      // = 1.84 / 2.25 × 1.0
      // ≈ 0.818
      expect(confidence).toBeGreaterThan(0.8);
      expect(confidence).toBeLessThanOrEqual(1.0);
      expect(typeof confidence).toBe('number');
    });

    it('should return higher confidence for more matching principles', () => {
      const fullCoveragePrinciples = mockAppliedPrinciples;
      const partialCoveragePrinciples = mockAppliedPrinciples.slice(0, 2);

      const fullConfidence = calculateConfidence(fullCoveragePrinciples, {
        expectedPrinciplesForDomain: 3,
        contextModifier: 1.0,
      });

      const partialConfidence = calculateConfidence(partialCoveragePrinciples, {
        expectedPrinciplesForDomain: 3,
        contextModifier: 1.0,
      });

      // Full coverage should have higher confidence due to coverage factor
      // coverage_factor: 3/3 = 1.0 vs 2/3 ≈ 0.667
      expect(fullConfidence).toBeGreaterThan(partialConfidence);
    });

    it('should reduce confidence when context modifier is below 1.0', () => {
      const baseConfidence = calculateConfidence(mockAppliedPrinciples, {
        expectedPrinciplesForDomain: 3,
        contextModifier: 1.0,
      });

      const reducedConfidence = calculateConfidence(mockAppliedPrinciples, {
        expectedPrinciplesForDomain: 3,
        contextModifier: 0.7, // Energy low or conflicts present
      });

      // Confidence should be reduced by approximately 30%
      expect(reducedConfidence).toBeLessThan(baseConfidence);
      expect(reducedConfidence / baseConfidence).toBeCloseTo(0.7, 1);
    });

    it('should handle empty principles array', () => {
      const confidence = calculateConfidence([], {
        expectedPrinciplesForDomain: 3,
        contextModifier: 1.0,
      });

      // Empty principles should result in 0 confidence
      expect(confidence).toBe(0);
    });

    it('should cap confidence at 1.0', () => {
      // Create a scenario where formula might exceed 1.0
      const perfectPrinciples: AppliedPrinciple[] = [
        {
          id: 'principle-7',
          name: 'Perfect Principle',
          weight: 0.5,
          relevanceScore: 1.0, // Perfect relevance
          domain: 'test',
        },
      ];

      const confidence = calculateConfidence(perfectPrinciples, {
        expectedPrinciplesForDomain: 1,
        contextModifier: 1.0,
      });

      expect(confidence).toBeLessThanOrEqual(1.0);
      expect(confidence).toBeGreaterThanOrEqual(0);
    });

    it('should not return negative confidence', () => {
      const confidence = calculateConfidence(mockAppliedPrinciples, {
        expectedPrinciplesForDomain: 10, // Very low coverage
        contextModifier: 0.1, // Very low context
      });

      expect(confidence).toBeGreaterThanOrEqual(0);
    });

    it('should calculate correctly with single principle', () => {
      const confidence = calculateConfidence(mockSinglePrinciple, {
        expectedPrinciplesForDomain: 1,
        contextModifier: 1.0,
      });

      // Formula: (0.8 * 0.95) / 0.8 × (1/1) × 1.0 = 0.95
      expect(confidence).toBeCloseTo(0.95, 1);
    });

    it('should handle low relevance scores appropriately', () => {
      const confidence = calculateConfidence(mockLowRelevancePrinciples, {
        expectedPrinciplesForDomain: 2,
        contextModifier: 1.0,
      });

      // Low relevance scores should result in lower confidence
      // (0.6*0.3 + 0.65*0.25) / (0.6+0.65) × (2/2) × 1.0
      // = (0.18 + 0.1625) / 1.25 × 1.0
      // = 0.3425 / 1.25 ≈ 0.274
      expect(confidence).toBeLessThan(0.5);
    });

    it('should reflect coverage factor reduction correctly', () => {
      const principles = mockAppliedPrinciples; // 3 principles

      const highCoverageConfidence = calculateConfidence(principles, {
        expectedPrinciplesForDomain: 3, // 100% coverage
        contextModifier: 1.0,
      });

      const lowCoverageConfidence = calculateConfidence(principles, {
        expectedPrinciplesForDomain: 5, // 60% coverage
        contextModifier: 1.0,
      });

      // Lower coverage factor should reduce confidence
      // coverage_factor: 3/3 = 1.0 vs 3/5 = 0.6
      expect(lowCoverageConfidence).toBeLessThan(highCoverageConfidence);
      const coverageRatio = lowCoverageConfidence / highCoverageConfidence;
      expect(coverageRatio).toBeCloseTo(0.6, 1);
    });
  });

  describe('isLowConfidence', () => {
    it('should return true for confidence below 0.5', () => {
      expect(isLowConfidence(0.3)).toBe(true);
      expect(isLowConfidence(0.49)).toBe(true);
      expect(isLowConfidence(0.0)).toBe(true);
    });

    it('should return false for confidence at or above 0.5', () => {
      expect(isLowConfidence(0.5)).toBe(false);
      expect(isLowConfidence(0.51)).toBe(false);
      expect(isLowConfidence(0.8)).toBe(false);
      expect(isLowConfidence(1.0)).toBe(false);
    });

    it('should handle edge case of exactly 0.5', () => {
      expect(isLowConfidence(0.5)).toBe(false);
    });

    it('should correctly identify low confidence scenarios', () => {
      const lowConfidenceValue = calculateConfidence(mockLowRelevancePrinciples, {
        expectedPrinciplesForDomain: 2,
        contextModifier: 1.0,
      });

      // Low relevance should produce low confidence
      expect(isLowConfidence(lowConfidenceValue)).toBe(true);
    });
  });

  describe('integration scenarios', () => {
    it('should calculate realistic confidence for typical recommendation with full context', () => {
      // Scenario: Well-matched principles, good coverage, normal context
      const principles = mockAppliedPrinciples;
      const confidence = calculateConfidence(principles, {
        expectedPrinciplesForDomain: 3,
        contextModifier: 1.0,
      });

      expect(confidence).toBeGreaterThan(0.75);
      expect(confidence).toBeLessThanOrEqual(1.0);
      expect(isLowConfidence(confidence)).toBe(false);
    });

    it('should calculate realistic confidence for weak recommendation', () => {
      // Scenario: Poorly-matched principles, incomplete coverage, low energy
      const principles = mockLowRelevancePrinciples;
      const confidence = calculateConfidence(principles, {
        expectedPrinciplesForDomain: 5,
        contextModifier: 0.6,
      });

      expect(confidence).toBeLessThan(0.5);
      expect(isLowConfidence(confidence)).toBe(true);
    });

    it('should flag low confidence but still return valid recommendation', () => {
      // AC8: Low confidence (<0.5) should be flagged but still return recommendation
      const weakPrinciples = mockLowRelevancePrinciples;
      const confidence = calculateConfidence(weakPrinciples, {
        expectedPrinciplesForDomain: 4,
        contextModifier: 0.5,
      });

      // Confidence should be low but still a number
      expect(isLowConfidence(confidence)).toBe(true);
      expect(typeof confidence).toBe('number');
      expect(confidence).toBeGreaterThanOrEqual(0);
      expect(confidence).toBeLessThanOrEqual(1.0);
    });

    it('should calculate confidence for optimistic scenario with high energy', () => {
      // Scenario: Well-matched principles, full coverage, high energy/no conflicts
      const principles = mockAppliedPrinciples;
      const confidence = calculateConfidence(principles, {
        expectedPrinciplesForDomain: 3,
        contextModifier: 1.2, // Bonus for high energy
      });

      // Should cap at 1.0 due to maximum bound
      expect(confidence).toBeLessThanOrEqual(1.0);
      expect(confidence).toBeGreaterThan(0.8);
    });

    it('should calculate confidence for partial domain match', () => {
      // Scenario: Some principles match, partial coverage, normal context
      const principles = mockAppliedPrinciples.slice(0, 2); // 2 out of 3
      const confidence = calculateConfidence(principles, {
        expectedPrinciplesForDomain: 3,
        contextModifier: 1.0,
      });

      // Should be decent but lower than full coverage
      // With 2/3 coverage factor (~0.67), confidence will be reduced
      expect(confidence).toBeGreaterThan(0.5);
      expect(confidence).toBeLessThan(0.9);
    });

    it('should handle conflicting context appropriately', () => {
      // Scenario: Good principles but conflicts detected (low context modifier)
      const principles = mockAppliedPrinciples;
      const confidenceNoConflicts = calculateConfidence(principles, {
        expectedPrinciplesForDomain: 3,
        contextModifier: 1.0,
      });

      const confidenceWithConflicts = calculateConfidence(principles, {
        expectedPrinciplesForDomain: 3,
        contextModifier: 0.5, // 50% due to conflicts
      });

      // Conflicts should reduce confidence
      expect(confidenceWithConflicts).toBeLessThan(confidenceNoConflicts);
      expect(confidenceWithConflicts / confidenceNoConflicts).toBeCloseTo(0.5, 1);
    });

    it('should demonstrate formula correctness with known values', () => {
      // Create a scenario with predictable output
      const knownPrinciples: AppliedPrinciple[] = [
        {
          id: 'test-1',
          name: 'Test Principle 1',
          weight: 1.0,
          relevanceScore: 0.5,
          domain: 'test',
        },
      ];

      const confidence = calculateConfidence(knownPrinciples, {
        expectedPrinciplesForDomain: 1,
        contextModifier: 1.0,
      });

      // Formula: (1.0 * 0.5) / 1.0 × (1/1) × 1.0 = 0.5
      expect(confidence).toBeCloseTo(0.5, 1);
      expect(isLowConfidence(confidence)).toBe(false); // At threshold
    });
  });
});

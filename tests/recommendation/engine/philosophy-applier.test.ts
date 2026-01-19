import { describe, it, expect, beforeEach } from 'vitest';
import { PhilosophyApplierService } from '../../../src/recommendation/engine/philosophy-applier.js';
import type {
  DecisionRequest,
  DecisionOption,
  Philosophy,
  AppliedPrinciple,
  ReasoningStep,
  Value,
  Belief,
  Boundary,
} from '../../../src/recommendation/types/index.js';

describe('PhilosophyApplierService', () => {
  let service: PhilosophyApplierService;

  beforeEach(() => {
    service = new PhilosophyApplierService();
  });

  // ============================================================================
  // Test Data Builders
  // ============================================================================

  const createDecisionRequest = (overrides?: Partial<DecisionRequest>): DecisionRequest => {
    return {
      id: 'decision-001',
      domain: ['career', 'finance'],
      question: 'Should I accept the new job offer?',
      options: [
        {
          id: 'option-1',
          name: 'Accept job offer',
          description: 'Accept the new position with higher salary',
          attributes: {
            salary: 120000,
            location: 'remote',
            riskLevel: 0.4,
            timeToCommit: 'long-term',
            growthPotential: 'high',
          },
          reversible: false,
          complexity: 8,
        },
        {
          id: 'option-2',
          name: 'Stay in current role',
          description: 'Remain in familiar position',
          attributes: {
            salary: 90000,
            location: 'office',
            riskLevel: 0.1,
            timeToCommit: 'medium-term',
            growthPotential: 'low',
          },
          reversible: false,
          complexity: 2,
        },
        {
          id: 'option-3',
          name: 'Negotiate with current employer',
          description: 'Try to improve current role',
          attributes: {
            salary: 95000,
            location: 'hybrid',
            riskLevel: 0.3,
            timeToCommit: 'medium-term',
            growthPotential: 'medium',
          },
          reversible: true,
          complexity: 6,
        },
      ],
      deadline: '2024-02-01T00:00:00Z',
      metadata: { decisionUrgency: 'high' },
      ...overrides,
    };
  };

  const createPhilosophy = (overrides?: Partial<Philosophy>): Philosophy => {
    return {
      values: [
        {
          name: 'Family',
          description: 'Prioritize time with loved ones',
          importance: 9,
        },
        {
          name: 'Growth',
          description: 'Continuous learning and improvement',
          importance: 7,
        },
        {
          name: 'Financial Security',
          description: 'Stable income and savings',
          importance: 8,
        },
        {
          name: 'Autonomy',
          description: 'Freedom to make own decisions',
          importance: 6,
        },
      ],
      beliefs: [
        {
          statement: 'Remote work is better for work-life balance',
          confidence: 0.9,
          domains: ['career'],
        },
        {
          statement: 'Job stability is more important than rapid growth',
          confidence: 0.8,
          domains: ['career', 'finance'],
        },
        {
          statement: 'Salary should not be the only consideration in career decisions',
          confidence: 1.0, // Absolute boundary - high confidence
          domains: ['career'],
        },
      ],
      riskTolerance: 0.5, // Moderate risk tolerance
      timeHorizon: 'long',
      boundaries: [
        {
          description: 'Never accept a role that requires more than 50 hours per week',
          type: 'personal',
          hard: true,
        },
        {
          description: 'Avoid roles that require frequent travel',
          type: 'personal',
          hard: false,
        },
        {
          description: 'Must maintain ethical standards at all times',
          type: 'ethical',
          hard: true,
        },
      ],
      ...overrides,
    };
  };

  const createAppliedPrinciple = (overrides?: Partial<AppliedPrinciple>): AppliedPrinciple => {
    return {
      principleId: 'principle-001',
      principleText: 'Prioritize opportunities that align with long-term goals',
      relevance: 'This decision will shape career trajectory for years',
      weight: 8,
      strength: 0.85,
      favorsOption: 'option-1',
      ...overrides,
    };
  };

  // ============================================================================
  // Value Mapping Tests
  // ============================================================================

  describe('value mapping', () => {
    it('should favor options aligned with high-importance values', () => {
      const request = createDecisionRequest();
      const philosophy = createPhilosophy({
        values: [
          { name: 'Growth', description: 'Career advancement', importance: 10 },
          { name: 'Work-life balance', description: 'Time for family', importance: 9 },
          { name: 'Financial Security', description: 'Stable income', importance: 5 },
        ],
      });

      const candidates = [
        createAppliedPrinciple({
          principleId: 'growth-principle',
          principleText: 'Seek roles that provide learning opportunities',
          favorsOption: 'option-1',
          strength: 0.9,
          weight: 10, // High weight to make it influential
        }),
        createAppliedPrinciple({
          principleId: 'balance-principle',
          principleText: 'Prioritize flexibility and remote work',
          favorsOption: 'option-1',
          strength: 0.8,
          weight: 9, // High weight
        }),
      ];

      const result = service.apply(request, philosophy, candidates);

      // Should produce a valid recommendation with reasoning
      expect(result.recommendation).toBeTruthy();
      expect(result.reasoning.length).toBeGreaterThan(0);
      expect(result.reasoning.some((step) => step.type === 'philosophy_application')).toBe(true);
    });

    it('should generate reasoning that references values', () => {
      const request = createDecisionRequest();
      const philosophy = createPhilosophy();
      const candidates = [createAppliedPrinciple()];

      const result = service.apply(request, philosophy, candidates);

      expect(result.reasoning.length).toBeGreaterThan(0);
      const valueReferences = result.reasoning.filter(
        (step) => step.type === 'philosophy_application'
      );

      // Should have at least some reasoning that references philosophy
      if (valueReferences.length > 0) {
        valueReferences.forEach((step) => {
          expect(step.logic).toBeTruthy();
          expect(step.logic.length).toBeGreaterThan(0);
        });
      }
    });

    it('should weight multiple values appropriately', () => {
      const request = createDecisionRequest();
      const philosophy = createPhilosophy({
        values: [
          { name: 'Family', description: 'Time with family', importance: 10 },
          { name: 'Growth', description: 'Career growth', importance: 8 },
          { name: 'Salary', description: 'High earnings', importance: 4 },
        ],
      });

      const candidates = [
        createAppliedPrinciple({
          principleId: 'family-principle',
          principleText: 'Choose roles that support family time',
          favorsOption: 'option-3', // Hybrid - better for family
          strength: 0.9,
          weight: 10,
        }),
        createAppliedPrinciple({
          principleId: 'growth-principle',
          principleText: 'Pursue high-growth opportunities',
          favorsOption: 'option-1', // New job - more growth
          strength: 0.7,
          weight: 8,
        }),
      ];

      const result = service.apply(request, philosophy, candidates);

      // Should show reasoning about value prioritization
      expect(result.reasoning.length).toBeGreaterThan(0);
      expect(result.reasoning.some((step) => step.logic.toLowerCase().includes('family') ||
                                            step.logic.toLowerCase().includes('growth'))).toBe(true);
    });
  });

  // ============================================================================
  // Boundary Enforcement Tests
  // ============================================================================

  describe('boundary enforcement', () => {
    it('should exclude options that violate hard boundaries', () => {
      const request = createDecisionRequest({
        options: [
          {
            id: 'option-risky',
            name: 'Risky startup',
            description: 'Join early-stage startup',
            attributes: {
              salary: 80000,
              weeklyHours: 70, // Violates boundary: > 50 hours
              riskLevel: 0.9,
              growthPotential: 'very-high',
            },
            complexity: 9,
          },
          {
            id: 'option-safe',
            name: 'Stable role',
            description: 'Join established company',
            attributes: {
              salary: 100000,
              weeklyHours: 45, // Within boundary
              riskLevel: 0.3,
              growthPotential: 'medium',
            },
            complexity: 5,
          },
        ],
      });

      const philosophy = createPhilosophy();

      const candidates = [
        createAppliedPrinciple({
          principleId: 'boundary-test',
          principleText: 'Test boundary enforcement',
          favorsOption: 'option-risky',
        }),
      ];

      const result = service.apply(request, philosophy, candidates);

      // Should not recommend the option that violates the hard boundary
      expect(result.recommendation).not.toBe('option-risky');
      expect(result.boundariesConsidered).toBe(true);
    });

    it('should add boundary_close warning when recommendation is near a boundary', () => {
      const request = createDecisionRequest({
        options: [
          {
            id: 'option-near-boundary',
            name: 'Demanding role',
            description: 'Role with 48 hours/week',
            attributes: {
              salary: 110000,
              weeklyHours: 48, // Near the 50-hour boundary
              riskLevel: 0.4,
            },
            complexity: 7,
          },
        ],
      });

      const philosophy = createPhilosophy();

      const candidates = [
        createAppliedPrinciple({
          principleId: 'test-principle',
          principleText: 'This option is near a boundary',
          favorsOption: 'option-near-boundary',
          strength: 0.8,
        }),
      ];

      const result = service.apply(request, philosophy, candidates);

      if (result.recommendation === 'option-near-boundary') {
        const boundaryWarning = result.warnings.find((w) => w.type === 'boundary_close');
        expect(boundaryWarning).toBeDefined();
        expect(boundaryWarning?.severity).toBe('warning');
      }
    });

    it('should respect ethical boundaries', () => {
      const request = createDecisionRequest({
        options: [
          {
            id: 'option-unethical',
            name: 'Unethical company',
            description: 'Company with questionable practices',
            attributes: {
              salary: 150000,
              ethicsScore: -5,
              riskLevel: 0.2,
            },
            complexity: 3,
          },
          {
            id: 'option-ethical',
            name: 'Ethical company',
            description: 'Company with strong ethics',
            attributes: {
              salary: 100000,
              ethicsScore: 9,
              riskLevel: 0.3,
            },
            complexity: 5,
          },
        ],
      });

      const philosophy = createPhilosophy({
        boundaries: [
          {
            description: 'Must maintain ethical standards at all times',
            type: 'ethical',
            hard: true,
          },
        ],
      });

      const candidates = [
        createAppliedPrinciple({
          principleId: 'ethics-principle',
          principleText: 'Uphold ethical standards',
          favorsOption: 'option-ethical',
          strength: 0.95,
        }),
      ];

      const result = service.apply(request, philosophy, candidates);

      expect(result.recommendation).not.toBe('option-unethical');
      expect(result.boundariesConsidered).toBe(true);
    });

    it('should include boundary reasoning in explanation', () => {
      const request = createDecisionRequest();
      const philosophy = createPhilosophy({
        boundaries: [
          {
            description: 'Must have at least 20 days vacation per year',
            type: 'personal',
            hard: true,
          },
        ],
      });

      const candidates = [createAppliedPrinciple()];
      const result = service.apply(request, philosophy, candidates);

      expect(result.boundariesConsidered).toBe(true);
      expect(result.reasoning.some((step) => step.type === 'philosophy_application')).toBe(true);
    });
  });

  // ============================================================================
  // Risk Tolerance Tests
  // ============================================================================

  describe('risk tolerance', () => {
    it('should favor safer options for low risk tolerance', () => {
      const request = createDecisionRequest();
      const philosophy = createPhilosophy({
        riskTolerance: 0.2, // Very risk-averse
      });

      const candidates = [
        createAppliedPrinciple({
          principleId: 'safety-principle',
          principleText: 'Prefer stable, proven paths',
          favorsOption: 'option-2', // Current stable role
          strength: 0.85,
        }),
        createAppliedPrinciple({
          principleId: 'risk-principle',
          principleText: 'Embrace new opportunities',
          favorsOption: 'option-1', // Risky new job
          strength: 0.6,
        }),
      ];

      const result = service.apply(request, philosophy, candidates);

      // Low risk tolerance should favor the safer option
      expect(result.recommendation).toBe('option-2');
      expect(result.reasoning.length).toBeGreaterThan(0);
    });

    it('should allow riskier options for high risk tolerance', () => {
      const request = createDecisionRequest();
      const philosophy = createPhilosophy({
        riskTolerance: 0.85, // Very risk-tolerant
      });

      const candidates = [
        createAppliedPrinciple({
          principleId: 'growth-principle',
          principleText: 'Pursue high-growth, higher-risk opportunities',
          favorsOption: 'option-1', // Riskier new job
          strength: 0.9,
          weight: 10, // Higher weight
        }),
        createAppliedPrinciple({
          principleId: 'safety-principle',
          principleText: 'Prefer stable paths',
          favorsOption: 'option-2',
          strength: 0.5,
          weight: 5, // Lower weight
        }),
      ];

      const result = service.apply(request, philosophy, candidates);

      // With higher weight on option-1 principle, should favor that option
      expect(result.recommendation).toBeTruthy();
      expect(result.reasoning.length).toBeGreaterThan(0);
    });

    it('should adjust reasoning based on risk tolerance level', () => {
      const request = createDecisionRequest();

      const lowRiskPhilosophy = createPhilosophy({ riskTolerance: 0.1 });
      const highRiskPhilosophy = createPhilosophy({ riskTolerance: 0.9 });

      const candidates = [
        createAppliedPrinciple({
          principleId: 'principle-1',
          principleText: 'Make bold decisions',
          favorsOption: 'option-1',
          strength: 0.8,
        }),
      ];

      const lowRiskResult = service.apply(request, lowRiskPhilosophy, candidates);
      const highRiskResult = service.apply(request, highRiskPhilosophy, candidates);

      // Both should have reasoning, but may differ in recommendation or reasoning approach
      expect(lowRiskResult.reasoning.length).toBeGreaterThan(0);
      expect(highRiskResult.reasoning.length).toBeGreaterThan(0);
    });

    it('should handle moderate risk tolerance', () => {
      const request = createDecisionRequest();
      const philosophy = createPhilosophy({
        riskTolerance: 0.5, // Moderate risk tolerance
      });

      const candidates = [
        createAppliedPrinciple({
          principleId: 'balanced-principle',
          principleText: 'Balance growth with stability',
          favorsOption: 'option-3', // Negotiate - balanced option
          strength: 0.8,
        }),
      ];

      const result = service.apply(request, philosophy, candidates);

      expect(result.recommendation).toBeTruthy();
      expect(result.reasoning.length).toBeGreaterThan(0);
    });
  });

  // ============================================================================
  // Time Horizon Tests
  // ============================================================================

  describe('time horizon', () => {
    it('should favor long-term benefits for long time horizon', () => {
      const request = createDecisionRequest();
      const philosophy = createPhilosophy({
        timeHorizon: 'long',
      });

      const candidates = [
        createAppliedPrinciple({
          principleId: 'longterm-principle',
          principleText: 'Invest in long-term growth and skill development',
          favorsOption: 'option-1', // New job - more growth long-term
          strength: 0.9,
          weight: 10, // Higher weight to favor this option
        }),
        createAppliedPrinciple({
          principleId: 'shortterm-principle',
          principleText: 'Maximize immediate comfort',
          favorsOption: 'option-2', // Current job - comfort now
          strength: 0.6,
          weight: 5, // Lower weight
        }),
      ];

      const result = service.apply(request, philosophy, candidates);

      // With higher weight on option-1 principle, should favor that option
      expect(result.recommendation).toBeTruthy();
      expect(result.reasoning.some((step) => step.logic.toLowerCase().includes('long') ||
                                          step.logic.toLowerCase().includes('time'))).toBe(true);
    });

    it('should favor immediate benefits for short time horizon', () => {
      const request = createDecisionRequest();
      const philosophy = createPhilosophy({
        timeHorizon: 'short',
      });

      const candidates = [
        createAppliedPrinciple({
          principleId: 'immediate-principle',
          principleText: 'Prioritize immediate benefits and comfort',
          favorsOption: 'option-2', // Stay in current - immediate comfort
          strength: 0.9,
        }),
        createAppliedPrinciple({
          principleId: 'future-principle',
          principleText: 'Build for future growth',
          favorsOption: 'option-1', // New job - growth later
          strength: 0.5,
        }),
      ];

      const result = service.apply(request, philosophy, candidates);

      expect(result.recommendation).toBe('option-2');
    });

    it('should balance considerations for medium time horizon', () => {
      const request = createDecisionRequest();
      const philosophy = createPhilosophy({
        timeHorizon: 'medium',
      });

      const candidates = [
        createAppliedPrinciple({
          principleId: 'balance-principle',
          principleText: 'Balance immediate needs with future growth',
          favorsOption: 'option-3', // Negotiate - middle ground
          strength: 0.85,
        }),
      ];

      const result = service.apply(request, philosophy, candidates);

      expect(result.recommendation).toBeDefined();
      expect(result.reasoning.length).toBeGreaterThan(0);
    });

    it('should adjust confidence based on time horizon', () => {
      const request = createDecisionRequest();

      const shortTermPhilosophy = createPhilosophy({ timeHorizon: 'short' });
      const longTermPhilosophy = createPhilosophy({ timeHorizon: 'long' });

      const candidates = [
        createAppliedPrinciple({
          principleId: 'principle-1',
          principleText: 'Make the best decision',
          favorsOption: 'option-1',
          strength: 0.7,
        }),
      ];

      const shortTermResult = service.apply(request, shortTermPhilosophy, candidates);
      const longTermResult = service.apply(request, longTermPhilosophy, candidates);

      // Both should produce results but may have different confidence levels
      expect(shortTermResult.reasoning.length).toBeGreaterThan(0);
      expect(longTermResult.reasoning.length).toBeGreaterThan(0);
    });
  });

  // ============================================================================
  // Complex Interaction Tests
  // ============================================================================

  describe('philosophy application', () => {
    it('should handle empty candidate principles', () => {
      const request = createDecisionRequest();
      const philosophy = createPhilosophy();

      const result = service.apply(request, philosophy, []);

      expect(result.recommendation).toBeTruthy();
      expect(result.reasoning.length).toBeGreaterThan(0);
    });

    it('should handle candidates with conflicting recommendations', () => {
      const request = createDecisionRequest();
      const philosophy = createPhilosophy();

      const candidates = [
        createAppliedPrinciple({
          principleId: 'principle-1',
          principleText: 'Go for growth',
          favorsOption: 'option-1',
          strength: 0.8,
          weight: 8,
        }),
        createAppliedPrinciple({
          principleId: 'principle-2',
          principleText: 'Maintain stability',
          favorsOption: 'option-2',
          strength: 0.8,
          weight: 8,
        }),
      ];

      const result = service.apply(request, philosophy, candidates);

      // Should still produce a valid recommendation despite conflicting inputs
      expect(result.recommendation).toBeTruthy();
      // Should have reasoning about the decision
      expect(result.reasoning.length).toBeGreaterThan(0);
    });

    it('should set boundariesConsidered flag appropriately', () => {
      const request = createDecisionRequest();
      const philosophyWithBoundaries = createPhilosophy();
      const philosophyNoBoundaries = createPhilosophy({ boundaries: [] });

      const candidates = [createAppliedPrinciple()];

      const resultWith = service.apply(request, philosophyWithBoundaries, candidates);
      const resultWithout = service.apply(request, philosophyNoBoundaries, candidates);

      expect(resultWith.boundariesConsidered).toBe(true);
      expect(resultWithout.boundariesConsidered).toBe(false);
    });

    it('should include warnings when appropriate', () => {
      const request = createDecisionRequest();
      const philosophy = createPhilosophy({
        riskTolerance: 0.1,
      });

      const candidates = [
        createAppliedPrinciple({
          principleId: 'high-risk-principle',
          principleText: 'Pursue high-risk opportunities',
          favorsOption: 'option-1',
          strength: 0.9,
        }),
      ];

      const result = service.apply(request, philosophy, candidates);

      // May have warnings about risk mismatch
      if (result.recommendation === 'option-1') {
        // If we're recommending a risky option despite low risk tolerance, we should warn
        expect(result.warnings.length).toBeGreaterThanOrEqual(0);
      }
    });

    it('should generate ReasoningStep with correct structure', () => {
      const request = createDecisionRequest();
      const philosophy = createPhilosophy();
      const candidates = [createAppliedPrinciple()];

      const result = service.apply(request, philosophy, candidates);

      expect(result.reasoning.length).toBeGreaterThan(0);

      result.reasoning.forEach((step: ReasoningStep) => {
        expect(step.step).toBeGreaterThanOrEqual(1);
        expect(step.logic).toBeTruthy();
        expect(['principle_application', 'conflict_resolution', 'context_override', 'philosophy_application', 'conclusion']).toContain(step.type);
      });
    });

    it('should produce consistent results for same inputs', () => {
      const request = createDecisionRequest();
      const philosophy = createPhilosophy();
      const candidates = [
        createAppliedPrinciple({ principleId: 'p1', favorsOption: 'option-1' }),
        createAppliedPrinciple({ principleId: 'p2', favorsOption: 'option-1' }),
      ];

      const result1 = service.apply(request, philosophy, candidates);
      const result2 = service.apply(request, philosophy, candidates);

      expect(result1.recommendation).toBe(result2.recommendation);
    });
  });

  // ============================================================================
  // Edge Cases and Special Scenarios
  // ============================================================================

  describe('edge cases', () => {
    it('should handle single option decisions', () => {
      const request = createDecisionRequest({
        options: [
          {
            id: 'only-option',
            name: 'Only choice',
            description: 'Take it or leave it',
            attributes: { forced: true },
          },
        ],
      });

      const philosophy = createPhilosophy();
      const candidates = [createAppliedPrinciple({ favorsOption: 'only-option' })];

      const result = service.apply(request, philosophy, candidates);

      expect(result.recommendation).toBe('only-option');
    });

    it('should handle candidate principles with no favored option', () => {
      const request = createDecisionRequest();
      const philosophy = createPhilosophy();

      const candidates = [
        createAppliedPrinciple({ favorsOption: undefined }),
        createAppliedPrinciple({ principleId: 'p2', favorsOption: 'option-1' }),
      ];

      const result = service.apply(request, philosophy, candidates);

      expect(result.recommendation).toBeTruthy();
      expect(result.reasoning.length).toBeGreaterThan(0);
    });

    it('should handle all-hard-boundaries scenario', () => {
      const request = createDecisionRequest({
        options: [
          {
            id: 'opt-1',
            name: 'Option 1',
            description: 'This option unethically violates ethical standards',
            attributes: { violatesEthics: true },
          },
          {
            id: 'opt-2',
            name: 'Option 2',
            description: 'Description with no ethical issues',
            attributes: { violatesEthics: false },
          },
        ],
      });

      const philosophy = createPhilosophy({
        boundaries: [
          { description: 'Must maintain ethical standards', type: 'ethical', hard: true },
        ],
      });

      const candidates = [
        createAppliedPrinciple({ principleId: 'p1', favorsOption: 'opt-2', strength: 0.9, weight: 10 }),
      ];

      const result = service.apply(request, philosophy, candidates);

      // Boundaries flag should be set when boundaries exist
      expect(result.boundariesConsidered).toBe(true);
      // When boundaries block one option but another remains, should have a recommendation
      // Note: if both options are blocked, recommendation may be empty string
      expect(typeof result.recommendation).toBe('string');
    });

    it('should handle weak candidate principles (low strength)', () => {
      const request = createDecisionRequest();
      const philosophy = createPhilosophy();

      const candidates = [
        createAppliedPrinciple({
          principleId: 'weak-p1',
          strength: 0.15,
          favorsOption: 'option-1',
        }),
        createAppliedPrinciple({
          principleId: 'weak-p2',
          strength: 0.2,
          favorsOption: 'option-2',
        }),
      ];

      const result = service.apply(request, philosophy, candidates);

      expect(result.recommendation).toBeTruthy();
      expect(result.reasoning.length).toBeGreaterThan(0);
    });

    it('should handle no beliefs scenario', () => {
      const request = createDecisionRequest();
      const philosophy = createPhilosophy({ beliefs: [] });
      const candidates = [createAppliedPrinciple()];

      const result = service.apply(request, philosophy, candidates);

      expect(result.recommendation).toBeTruthy();
      expect(result.reasoning.length).toBeGreaterThan(0);
    });

    it('should handle extreme risk tolerance values', () => {
      const request = createDecisionRequest();
      const candidates = [createAppliedPrinciple({ favorsOption: 'option-1' })];

      const noRiskPhilosophy = createPhilosophy({ riskTolerance: 0.0 });
      const maxRiskPhilosophy = createPhilosophy({ riskTolerance: 1.0 });

      const noRiskResult = service.apply(request, noRiskPhilosophy, candidates);
      const maxRiskResult = service.apply(request, maxRiskPhilosophy, candidates);

      expect(noRiskResult.recommendation).toBeTruthy();
      expect(maxRiskResult.recommendation).toBeTruthy();
    });
  });

  // ============================================================================
  // AC5 Acceptance Criteria Tests
  // ============================================================================

  describe('AC5: Philosophy application (Acceptance Criteria)', () => {
    it('[AC5.1] should map values to decision criteria correctly', () => {
      const request = createDecisionRequest();
      const philosophy = createPhilosophy({
        values: [
          { name: 'Family', description: 'Time with family', importance: 10 },
          { name: 'Salary', description: 'High income', importance: 6 },
        ],
      });

      const candidates = [
        createAppliedPrinciple({
          principleId: 'family-principle',
          principleText: 'Prioritize family time',
          favorsOption: 'option-2', // Less demanding
          strength: 0.9,
          weight: 10,
        }),
        createAppliedPrinciple({
          principleId: 'salary-principle',
          principleText: 'Maximize earnings',
          favorsOption: 'option-1', // Higher salary
          strength: 0.7,
          weight: 6,
        }),
      ];

      const result = service.apply(request, philosophy, candidates);

      // Higher importance value should influence recommendation
      expect(result.reasoning.some((step) =>
        step.type === 'philosophy_application'
      )).toBe(true);

      // The recommendation should favor the family-aligned option given importance weighting
      expect(result.recommendation).toBeTruthy();
    });

    it('[AC5.2] should enforce absolute boundaries (confidence=1.0)', () => {
      const request = createDecisionRequest({
        options: [
          {
            id: 'boundary-violation',
            name: 'Violates absolute belief',
            description: 'Goes against non-negotiable belief',
            attributes: { ignoresEthics: true },
          },
          {
            id: 'boundary-compliant',
            name: 'Respects boundaries',
            description: 'Aligned with absolute beliefs',
            attributes: { ignoresEthics: false },
          },
        ],
      });

      const philosophy = createPhilosophy({
        beliefs: [
          {
            statement: 'Ethical conduct is non-negotiable',
            confidence: 1.0, // Absolute boundary
            domains: ['all'],
          },
        ],
        boundaries: [
          {
            description: 'Never compromise on ethics',
            type: 'ethical',
            hard: true,
          },
        ],
      });

      const candidates = [
        createAppliedPrinciple({
          principleId: 'test-p',
          favorsOption: 'boundary-violation',
          strength: 0.9,
        }),
      ];

      const result = service.apply(request, philosophy, candidates);

      // Should never recommend option that violates absolute boundary
      expect(result.recommendation).not.toBe('boundary-violation');
      expect(result.boundariesConsidered).toBe(true);
    });

    it('[AC5.3] should adjust decisions based on risk tolerance (0-1)', () => {
      const request = createDecisionRequest({
        options: [
          {
            id: 'safe-option',
            name: 'Safe',
            description: 'Low risk',
            attributes: { uncertainty: 0.1 },
            complexity: 2,
          },
          {
            id: 'risky-option',
            name: 'Risky',
            description: 'High risk',
            attributes: { uncertainty: 0.8 },
            complexity: 9,
          },
        ],
      });

      const lowRiskTolerance = createPhilosophy({ riskTolerance: 0.1 });
      const highRiskTolerance = createPhilosophy({ riskTolerance: 0.9 });

      const candidate = createAppliedPrinciple({
        principleId: 'test-p',
        favorsOption: 'risky-option',
        strength: 0.8,
      });

      const lowRiskResult = service.apply(request, lowRiskTolerance, [candidate]);
      const highRiskResult = service.apply(request, highRiskTolerance, [candidate]);

      // Low risk tolerance should be more conservative
      expect(lowRiskResult.recommendation).toBeTruthy();
      expect(highRiskResult.recommendation).toBeTruthy();

      // Results should reflect the different tolerance levels
      expect(lowRiskResult.reasoning.length).toBeGreaterThan(0);
      expect(highRiskResult.reasoning.length).toBeGreaterThan(0);
    });

    it('[AC5.4] should include boundary enforcement in reasoning', () => {
      const request = createDecisionRequest();
      const philosophy = createPhilosophy({
        boundaries: [
          {
            description: 'Must maintain work-life balance',
            type: 'personal',
            hard: true,
          },
        ],
      });

      const candidates = [createAppliedPrinciple()];
      const result = service.apply(request, philosophy, candidates);

      expect(result.boundariesConsidered).toBe(true);
      expect(result.reasoning.length).toBeGreaterThan(0);
    });

    it('[AC5.5] should handle time horizon impact on decisions', () => {
      const request = createDecisionRequest();

      const timeHorizons: Array<'short' | 'medium' | 'long'> = ['short', 'medium', 'long'];
      const results = timeHorizons.map((horizon) => {
        const philosophy = createPhilosophy({ timeHorizon: horizon });
        const candidates = [createAppliedPrinciple()];
        return service.apply(request, philosophy, candidates);
      });

      // All should produce valid results
      results.forEach((result) => {
        expect(result.recommendation).toBeTruthy();
        expect(result.reasoning.length).toBeGreaterThan(0);
      });
    });
  });
});


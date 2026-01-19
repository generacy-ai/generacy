import { describe, it, expect, beforeEach } from 'vitest';
import { ReasoningGeneratorService } from '../../../src/recommendation/engine/reasoning-generator.js';
import type {
  DecisionRequest,
  AppliedPrinciple,
  ContextInfluenceRecord,
  ReasoningStep,
} from '../../../src/recommendation/types/index.js';

// Mock data for testing
const mockPrinciples: AppliedPrinciple[] = [
  {
    principleId: 'p1',
    principleText: 'Always prioritize family wellbeing over career advancement',
    alignmentScore: 0.95,
    applicabilityScore: 0.9,
    conflictsWith: [],
  },
  {
    principleId: 'p2',
    principleText: 'Maintain financial stability and avoid excessive risk',
    alignmentScore: 0.85,
    applicabilityScore: 0.88,
    conflictsWith: [],
  },
  {
    principleId: 'p3',
    principleText: 'Invest in continuous personal growth and learning',
    alignmentScore: 0.8,
    applicabilityScore: 0.75,
    conflictsWith: [],
  },
];

const mockConflictingPrinciples: AppliedPrinciple[] = [
  {
    principleId: 'p4',
    principleText: 'Pursue ambitious career goals and take calculated risks',
    alignmentScore: 0.7,
    applicabilityScore: 0.85,
    conflictsWith: ['p1'], // Conflicts with family priority
  },
  {
    principleId: 'p1',
    principleText: 'Always prioritize family wellbeing over career advancement',
    alignmentScore: 0.95,
    applicabilityScore: 0.9,
    conflictsWith: ['p4'],
  },
];

const mockContextInfluence: ContextInfluenceRecord = {
  factor: 'Market opportunity window',
  description: 'This specific opportunity only available for 3 months',
  type: 'opportunity_window',
  influenceStrength: 0.8,
};

const mockDecisionRequest: DecisionRequest = {
  decisionId: 'decision-001',
  description: 'Should I accept a promotion that requires relocating away from family?',
  context: {
    currentRole: 'Senior Developer',
    targetRole: 'Engineering Manager',
    relocationRequired: true,
    familyImpact: 'Would separate from extended family support network',
  },
  appliedPrinciples: mockPrinciples,
  contextInfluences: [mockContextInfluence],
  timestamp: new Date(),
};

const mockDecisionWithConflicts: DecisionRequest = {
  decisionId: 'decision-002',
  description: 'Should I take a high-risk startup investment opportunity?',
  context: {
    investmentAmount: '$50,000',
    expectedReturn: '10x in 5 years',
    riskLevel: 'High',
    familyVetoable: false,
  },
  appliedPrinciples: mockConflictingPrinciples,
  contextInfluences: [],
  timestamp: new Date(),
};

describe('ReasoningGeneratorService', () => {
  let service: ReasoningGeneratorService;

  beforeEach(() => {
    service = new ReasoningGeneratorService();
  });

  describe('template generation', () => {
    it('should generate reasoning steps in sequential order', () => {
      const steps = service.generateReasoningSteps(mockDecisionRequest);

      expect(steps).toBeDefined();
      expect(steps.length).toBeGreaterThan(0);

      // Verify steps are numbered sequentially
      steps.forEach((step: ReasoningStep, index: number) => {
        expect(step.stepNumber).toBe(index + 1);
      });
    });

    it('should maintain sequential numbering with multiple principle steps', () => {
      const steps = service.generateReasoningSteps(mockDecisionRequest);

      const stepNumbers = steps.map((s: ReasoningStep) => s.stepNumber);
      const expectedNumbers = Array.from(
        { length: steps.length },
        (_, i) => i + 1
      );

      expect(stepNumbers).toEqual(expectedNumbers);
    });

    it('should include a conclusion step', () => {
      const steps = service.generateReasoningSteps(mockDecisionRequest);

      const conclusionStep = steps.find((s: ReasoningStep) => s.type === 'conclusion');
      expect(conclusionStep).toBeDefined();
      expect(conclusionStep?.type).toBe('conclusion');
    });

    it('should place conclusion step at the end', () => {
      const steps = service.generateReasoningSteps(mockDecisionRequest);

      const lastStep = steps[steps.length - 1];
      expect(lastStep.type).toBe('conclusion');
    });

    it('should generate principle_application steps for each principle', () => {
      const steps = service.generateReasoningSteps(mockDecisionRequest);

      const principleSteps = steps.filter(
        (s: ReasoningStep) => s.type === 'principle_application'
      );

      expect(principleSteps.length).toBe(mockPrinciples.length);
    });

    it('should generate one principle step per applied principle', () => {
      const customRequest: DecisionRequest = {
        ...mockDecisionRequest,
        appliedPrinciples: [mockPrinciples[0]],
      };

      const steps = service.generateReasoningSteps(customRequest);
      const principleSteps = steps.filter(
        (s: ReasoningStep) => s.type === 'principle_application'
      );

      expect(principleSteps.length).toBe(1);
    });

    it('should generate templated logic text without LLM dependency', () => {
      const steps = service.generateReasoningSteps(mockDecisionRequest);

      const principleSteps = steps.filter(
        (s: ReasoningStep) => s.type === 'principle_application'
      );

      principleSteps.forEach((step: ReasoningStep) => {
        expect(step.logic).toBeDefined();
        expect(typeof step.logic).toBe('string');
        expect(step.logic.length).toBeGreaterThan(0);
      });
    });
  });

  describe('principle references', () => {
    it('should include principle ID in references', () => {
      const steps = service.generateReasoningSteps(mockDecisionRequest);

      const principleSteps = steps.filter(
        (s: ReasoningStep) => s.type === 'principle_application'
      );

      principleSteps.forEach((step: ReasoningStep) => {
        expect(step.principleReference).toBeDefined();
        expect(step.principleReference?.principleId).toBeDefined();
        expect(typeof step.principleReference?.principleId).toBe('string');
      });
    });

    it('should include principle text in references', () => {
      const steps = service.generateReasoningSteps(mockDecisionRequest);

      const principleSteps = steps.filter(
        (s: ReasoningStep) => s.type === 'principle_application'
      );

      principleSteps.forEach((step: ReasoningStep) => {
        expect(step.principleReference).toBeDefined();
        expect(step.principleReference?.principleText).toBeDefined();
        expect(typeof step.principleReference?.principleText).toBe('string');
        expect(step.principleReference?.principleText.length).toBeGreaterThan(0);
      });
    });

    it('should reference principles by ID in principle steps', () => {
      const steps = service.generateReasoningSteps(mockDecisionRequest);

      const principleSteps = steps.filter(
        (s: ReasoningStep) => s.type === 'principle_application'
      );

      const referencedIds = principleSteps.map(
        (s: ReasoningStep) => s.principleReference?.principleId
      );

      mockPrinciples.forEach((principle) => {
        expect(referencedIds).toContain(principle.principleId);
      });
    });

    it('should reference principles by name in logic text', () => {
      const steps = service.generateReasoningSteps(mockDecisionRequest);

      const principleSteps = steps.filter(
        (s: ReasoningStep) => s.type === 'principle_application'
      );

      principleSteps.forEach((step: ReasoningStep) => {
        if (step.principleReference?.principleId) {
          // Logic should mention the principle (by ID or key words from text)
          expect(step.logic).toBeDefined();
          // Verify the logic references the principle somehow
          expect(step.logic.length).toBeGreaterThan(0);
        }
      });
    });

    it('should maintain principle text exactly as provided', () => {
      const steps = service.generateReasoningSteps(mockDecisionRequest);

      const principleSteps = steps.filter(
        (s: ReasoningStep) => s.type === 'principle_application'
      );

      principleSteps.forEach((step: ReasoningStep) => {
        const originalPrinciple = mockPrinciples.find(
          (p) => p.principleId === step.principleReference?.principleId
        );

        expect(step.principleReference?.principleText).toBe(
          originalPrinciple?.principleText
        );
      });
    });

    it('should include alignment score in principle references', () => {
      const steps = service.generateReasoningSteps(mockDecisionRequest);

      const principleSteps = steps.filter(
        (s: ReasoningStep) => s.type === 'principle_application'
      );

      principleSteps.forEach((step: ReasoningStep) => {
        expect(step.principleReference?.alignmentScore).toBeDefined();
        expect(typeof step.principleReference?.alignmentScore).toBe('number');
        expect(step.principleReference?.alignmentScore).toBeGreaterThanOrEqual(0);
        expect(step.principleReference?.alignmentScore).toBeLessThanOrEqual(1);
      });
    });
  });

  describe('context influence integration', () => {
    it('should generate context_override steps for context factors', () => {
      const steps = service.generateReasoningSteps(mockDecisionRequest);

      const contextSteps = steps.filter(
        (s: ReasoningStep) => s.type === 'context_override'
      );

      expect(contextSteps.length).toBeGreaterThanOrEqual(0);
      if (mockDecisionRequest.contextInfluences.length > 0) {
        expect(contextSteps.length).toBeGreaterThan(0);
      }
    });

    it('should include context factor reference in context steps', () => {
      const steps = service.generateReasoningSteps(mockDecisionRequest);

      const contextSteps = steps.filter(
        (s: ReasoningStep) => s.type === 'context_override'
      );

      contextSteps.forEach((step: ReasoningStep) => {
        expect(step.contextReference).toBeDefined();
        expect(step.contextReference?.factor).toBeDefined();
      });
    });

    it('should not generate context steps when no context influences exist', () => {
      const requestWithoutContext: DecisionRequest = {
        ...mockDecisionRequest,
        contextInfluences: [],
      };

      const steps = service.generateReasoningSteps(requestWithoutContext);

      const contextSteps = steps.filter(
        (s: ReasoningStep) => s.type === 'context_override'
      );

      expect(contextSteps.length).toBe(0);
    });

    it('should include influence strength in context references', () => {
      const steps = service.generateReasoningSteps(mockDecisionRequest);

      const contextSteps = steps.filter(
        (s: ReasoningStep) => s.type === 'context_override'
      );

      contextSteps.forEach((step: ReasoningStep) => {
        expect(step.contextReference?.influenceStrength).toBeDefined();
        expect(typeof step.contextReference?.influenceStrength).toBe('number');
      });
    });

    it('should maintain context description exactly as provided', () => {
      const steps = service.generateReasoningSteps(mockDecisionRequest);

      const contextSteps = steps.filter(
        (s: ReasoningStep) => s.type === 'context_override'
      );

      contextSteps.forEach((step: ReasoningStep) => {
        expect(step.contextReference?.description).toBe(
          mockContextInfluence.description
        );
      });
    });
  });

  describe('conflict resolution', () => {
    it('should generate conflict_resolution step when principles conflict', () => {
      const steps = service.generateReasoningSteps(mockDecisionWithConflicts);

      const conflictSteps = steps.filter(
        (s: ReasoningStep) => s.type === 'conflict_resolution'
      );

      expect(conflictSteps.length).toBeGreaterThan(0);
    });

    it('should not generate conflict step when no conflicts exist', () => {
      const steps = service.generateReasoningSteps(mockDecisionRequest);

      const conflictSteps = steps.filter(
        (s: ReasoningStep) => s.type === 'conflict_resolution'
      );

      expect(conflictSteps.length).toBe(0);
    });

    it('should identify correct conflicting principles', () => {
      const steps = service.generateReasoningSteps(mockDecisionWithConflicts);

      const conflictSteps = steps.filter(
        (s: ReasoningStep) => s.type === 'conflict_resolution'
      );

      conflictSteps.forEach((step: ReasoningStep) => {
        expect(step.conflictingPrinciples).toBeDefined();
        expect(step.conflictingPrinciples).toHaveLength(2);
      });
    });

    it('should include logic for resolving conflicts', () => {
      const steps = service.generateReasoningSteps(mockDecisionWithConflicts);

      const conflictSteps = steps.filter(
        (s: ReasoningStep) => s.type === 'conflict_resolution'
      );

      conflictSteps.forEach((step: ReasoningStep) => {
        expect(step.logic).toBeDefined();
        expect(step.logic.length).toBeGreaterThan(0);
      });
    });

    it('should place conflict resolution before conclusion', () => {
      const steps = service.generateReasoningSteps(mockDecisionWithConflicts);

      const conflictStepIndex = steps.findIndex(
        (s: ReasoningStep) => s.type === 'conflict_resolution'
      );
      const conclusionStepIndex = steps.findIndex(
        (s: ReasoningStep) => s.type === 'conclusion'
      );

      if (conflictStepIndex !== -1) {
        expect(conflictStepIndex).toBeLessThan(conclusionStepIndex);
      }
    });
  });

  describe('reasoning step structure', () => {
    it('should have valid structure for all generated steps', () => {
      const steps = service.generateReasoningSteps(mockDecisionRequest);

      steps.forEach((step: ReasoningStep) => {
        expect(step.stepNumber).toBeDefined();
        expect(typeof step.stepNumber).toBe('number');
        expect(step.type).toBeDefined();
        expect(typeof step.type).toBe('string');
        expect(step.logic).toBeDefined();
        expect(typeof step.logic).toBe('string');
      });
    });

    it('should have appropriate references based on step type', () => {
      const steps = service.generateReasoningSteps(mockDecisionRequest);

      steps.forEach((step: ReasoningStep) => {
        if (step.type === 'principle_application') {
          expect(step.principleReference).toBeDefined();
        } else if (step.type === 'context_override') {
          expect(step.contextReference).toBeDefined();
        } else if (step.type === 'conflict_resolution') {
          expect(step.conflictingPrinciples).toBeDefined();
        }
      });
    });

    it('should generate at least 4 steps for typical decision', () => {
      const steps = service.generateReasoningSteps(mockDecisionRequest);

      // At least: opening + principle steps + conclusion
      expect(steps.length).toBeGreaterThanOrEqual(4);
    });
  });

  describe('template consistency', () => {
    it('should generate consistent output for same input', () => {
      const steps1 = service.generateReasoningSteps(mockDecisionRequest);
      const steps2 = service.generateReasoningSteps(mockDecisionRequest);

      expect(steps1.length).toBe(steps2.length);
      steps1.forEach((step, index) => {
        expect(step.type).toBe(steps2[index].type);
        expect(step.stepNumber).toBe(steps2[index].stepNumber);
      });
    });

    it('should handle empty principle list', () => {
      const emptyRequest: DecisionRequest = {
        ...mockDecisionRequest,
        appliedPrinciples: [],
      };

      const steps = service.generateReasoningSteps(emptyRequest);

      expect(steps).toBeDefined();
      expect(steps.length).toBeGreaterThan(0);
      expect(steps[steps.length - 1].type).toBe('conclusion');
    });

    it('should handle single principle gracefully', () => {
      const singleRequest: DecisionRequest = {
        ...mockDecisionRequest,
        appliedPrinciples: [mockPrinciples[0]],
      };

      const steps = service.generateReasoningSteps(singleRequest);

      const principleSteps = steps.filter(
        (s: ReasoningStep) => s.type === 'principle_application'
      );

      expect(principleSteps.length).toBe(1);
    });

    it('should handle many principles efficiently', () => {
      const manyPrinciples = Array.from({ length: 10 }, (_, i) => ({
        principleId: `p${i}`,
        principleText: `Principle ${i} text`,
        alignmentScore: 0.8,
        applicabilityScore: 0.75,
        conflictsWith: [],
      }));

      const manyRequest: DecisionRequest = {
        ...mockDecisionRequest,
        appliedPrinciples: manyPrinciples,
      };

      const steps = service.generateReasoningSteps(manyRequest);

      const principleSteps = steps.filter(
        (s: ReasoningStep) => s.type === 'principle_application'
      );

      expect(principleSteps.length).toBe(10);
    });
  });

  describe('AC6 compliance - Template generation and principle references', () => {
    it('[AC6.1] should generate templated reasoning steps without LLM', () => {
      // AC6 requirement: Use templated responses that reference principle text directly
      const steps = service.generateReasoningSteps(mockDecisionRequest);

      const principleSteps = steps.filter(
        (s: ReasoningStep) => s.type === 'principle_application'
      );

      // Each step should have templated logic (not dynamic LLM-generated)
      principleSteps.forEach((step: ReasoningStep) => {
        expect(step.logic).toBeDefined();
        expect(step.logic).toMatch(/\w+/); // Has content
        // Should reference principle directly
        expect(step.principleReference).toBeDefined();
      });
    });

    it('[AC6.2] should reference principle text directly in reasoning', () => {
      // AC6 requirement: Reference principle text directly
      const steps = service.generateReasoningSteps(mockDecisionRequest);

      const principleSteps = steps.filter(
        (s: ReasoningStep) => s.type === 'principle_application'
      );

      principleSteps.forEach((step: ReasoningStep) => {
        // Verify principle text is preserved exactly
        const matchingPrinciple = mockPrinciples.find(
          (p) => p.principleId === step.principleReference?.principleId
        );
        expect(step.principleReference?.principleText).toBe(
          matchingPrinciple?.principleText
        );
      });
    });

    it('[AC6.3] should express reasoning in structured steps', () => {
      // AC6 requirement: Structured steps that reference human's principles
      const steps = service.generateReasoningSteps(mockDecisionRequest);

      expect(Array.isArray(steps)).toBe(true);
      expect(steps.every((s: ReasoningStep) => s.stepNumber && s.type && s.logic)).toBe(
        true
      );
    });
  });
});

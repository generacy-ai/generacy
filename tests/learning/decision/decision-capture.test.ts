/**
 * Tests for DecisionCapture
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { DecisionCapture } from '../../../src/learning/decision/decision-capture.js';
import { InMemoryDecisionRepository } from '../../../src/learning/decision/decision-repository.js';
import type { DecisionCaptureInput } from '../../../src/learning/decision/decision-capture.js';
import type { CoachingData } from '../../../src/learning/types.js';

describe('DecisionCapture', () => {
  let repository: InMemoryDecisionRepository;
  let capture: DecisionCapture;

  // Factory for creating test input
  function createTestInput(overrides: Partial<DecisionCaptureInput> = {}): DecisionCaptureInput {
    return {
      id: 'decision-1',
      userId: 'user-1',
      request: {
        id: 'request-1',
        description: 'Test decision',
        options: [
          { id: 'opt-1', name: 'Option 1', description: 'First option' },
          { id: 'opt-2', name: 'Option 2', description: 'Second option' },
        ],
        context: { name: 'Test Project' },
        requestedAt: new Date(),
      },
      baseline: {
        optionId: 'opt-1',
        confidence: 80,
        reasoning: ['Test reasoning'],
        factors: [],
        alternativeOptionAnalysis: [],
        generatedAt: new Date(),
        configSnapshot: {
          factors: {
            projectContext: true,
            domainBestPractices: true,
            teamSize: true,
            existingStack: true,
          },
          confidenceThreshold: 50,
          requireReasoning: true,
        },
      },
      protege: {
        optionId: 'opt-1',
        confidence: 0.85,
        reasoning: [],
        appliedPrinciples: [
          {
            principleId: 'principle-1',
            principleText: 'Test principle',
            relevance: 'Relevant to test',
            weight: 7,
            strength: 0.8,
            favorsOption: 'opt-1',
          },
        ],
        contextInfluence: [],
        differsFromBaseline: false,
        meta: {
          processingTimeMs: 100,
          principlesEvaluated: 5,
          principlesMatched: 1,
          hadConflicts: false,
          engineVersion: '1.0.0',
        },
      },
      finalChoice: 'opt-1',
      ...overrides,
    };
  }

  beforeEach(() => {
    repository = new InMemoryDecisionRepository();
    capture = new DecisionCapture(repository);
  });

  describe('capture', () => {
    it('should capture a decision and store it', async () => {
      const input = createTestInput();

      const result = await capture.capture(input);

      expect(result.decision.id).toBe('decision-1');
      expect(result.decision.userId).toBe('user-1');
      expect(result.decision.finalChoice).toBe('opt-1');

      // Verify it was stored
      const stored = await repository.getById('decision-1');
      expect(stored).not.toBeNull();
    });

    it('should set wasOverride=false when following recommendation', async () => {
      const input = createTestInput({ finalChoice: 'opt-1' }); // Same as protege

      const result = await capture.capture(input);

      expect(result.decision.wasOverride).toBe(false);
      expect(result.decision.coaching).toBeUndefined();
    });

    it('should set wasOverride=true when overriding recommendation', async () => {
      const coaching: CoachingData = {
        overrideReason: 'reasoning_incorrect',
        explanation: 'The principle was applied incorrectly',
        incorrectPrinciples: ['principle-1'],
        shouldRemember: true,
      };
      const input = createTestInput({
        finalChoice: 'opt-2', // Different from protege
        coaching,
      });

      const result = await capture.capture(input);

      expect(result.decision.wasOverride).toBe(true);
      expect(result.decision.coaching).toEqual(coaching);
    });

    it('should generate principle_reinforced events when following recommendation', async () => {
      const input = createTestInput({ finalChoice: 'opt-1' });

      const result = await capture.capture(input);

      expect(result.learningEvents).toHaveLength(1);
      expect(result.learningEvents[0].type).toBe('principle_reinforced');
      expect(result.learningEvents[0].payload.type).toBe('principle_reinforced');
      if (result.learningEvents[0].payload.type === 'principle_reinforced') {
        expect(result.learningEvents[0].payload.principleId).toBe('principle-1');
        expect(result.learningEvents[0].payload.strength).toBe(0.8);
      }
    });

    it('should generate principle_contradicted events when overriding', async () => {
      const coaching: CoachingData = {
        overrideReason: 'missing_context',
        explanation: 'The system did not know about X',
        missingContext: 'Context X',
        shouldRemember: true,
      };
      const input = createTestInput({
        finalChoice: 'opt-2',
        coaching,
      });

      const result = await capture.capture(input);

      expect(result.learningEvents).toHaveLength(1);
      expect(result.learningEvents[0].type).toBe('principle_contradicted');
      if (result.learningEvents[0].payload.type === 'principle_contradicted') {
        expect(result.learningEvents[0].payload.principleId).toBe('principle-1');
        expect(result.learningEvents[0].payload.overrideReason).toBe('missing_context');
        expect(result.learningEvents[0].payload.explanation).toBe('The system did not know about X');
      }
    });

    it('should handle multiple principles', async () => {
      const input = createTestInput();
      input.protege.appliedPrinciples = [
        {
          principleId: 'principle-1',
          principleText: 'First principle',
          relevance: 'Relevant',
          weight: 7,
          strength: 0.8,
        },
        {
          principleId: 'principle-2',
          principleText: 'Second principle',
          relevance: 'Also relevant',
          weight: 5,
          strength: 0.6,
        },
      ];

      const result = await capture.capture(input);

      expect(result.learningEvents).toHaveLength(2);
      const principleIds = result.learningEvents.map(e => {
        if (e.payload.type === 'principle_reinforced') {
          return e.payload.principleId;
        }
        return null;
      });
      expect(principleIds).toContain('principle-1');
      expect(principleIds).toContain('principle-2');
    });

    it('should handle decision with no applied principles', async () => {
      const input = createTestInput();
      input.protege.appliedPrinciples = [];

      const result = await capture.capture(input);

      expect(result.learningEvents).toHaveLength(0);
    });
  });

  describe('linkUpdate', () => {
    it('should link an update to a decision', async () => {
      const input = createTestInput();
      await capture.capture(input);

      await capture.linkUpdate('decision-1', 'update-1');

      const decision = await repository.getById('decision-1');
      expect(decision?.generatedUpdates).toContain('update-1');
    });

    it('should not duplicate update links', async () => {
      const input = createTestInput();
      await capture.capture(input);

      await capture.linkUpdate('decision-1', 'update-1');
      await capture.linkUpdate('decision-1', 'update-1');

      const decision = await repository.getById('decision-1');
      expect(decision?.generatedUpdates.filter(u => u === 'update-1')).toHaveLength(1);
    });

    it('should throw for non-existent decision', async () => {
      await expect(capture.linkUpdate('non-existent', 'update-1'))
        .rejects.toThrow('Decision not found');
    });
  });

  describe('getEvidenceForPrinciple', () => {
    it('should return decisions where principle was reinforced', async () => {
      const input1 = createTestInput({ id: 'd1', finalChoice: 'opt-1' });
      const input2 = createTestInput({ id: 'd2', finalChoice: 'opt-1' });

      await capture.capture(input1);
      await capture.capture(input2);

      const evidence = await capture.getEvidenceForPrinciple('user-1', 'principle-1');
      expect(evidence).toHaveLength(2);
    });

    it('should return decisions where principle was contradicted', async () => {
      const input = createTestInput({
        id: 'd1',
        finalChoice: 'opt-2',
        coaching: {
          overrideReason: 'reasoning_incorrect',
          explanation: 'Wrong',
          shouldRemember: true,
        },
      });

      await capture.capture(input);

      const evidence = await capture.getEvidenceForPrinciple('user-1', 'principle-1');
      expect(evidence).toHaveLength(1);
    });

    it('should return empty array for principle with no evidence', async () => {
      const input = createTestInput();
      await capture.capture(input);

      const evidence = await capture.getEvidenceForPrinciple('user-1', 'unknown-principle');
      expect(evidence).toEqual([]);
    });
  });

  describe('getDecisionsForUpdate', () => {
    it('should return decisions linked to an update', async () => {
      const input1 = createTestInput({ id: 'd1' });
      const input2 = createTestInput({ id: 'd2' });

      await capture.capture(input1);
      await capture.capture(input2);
      await capture.linkUpdate('d1', 'update-1');

      const decisions = await capture.getDecisionsForUpdate('user-1', 'update-1');
      expect(decisions).toHaveLength(1);
      expect(decisions[0].id).toBe('d1');
    });

    it('should return empty array for update with no linked decisions', async () => {
      const input = createTestInput();
      await capture.capture(input);

      const decisions = await capture.getDecisionsForUpdate('user-1', 'unknown-update');
      expect(decisions).toEqual([]);
    });
  });
});

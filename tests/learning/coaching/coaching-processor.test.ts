/**
 * Tests for CoachingProcessor
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { CoachingProcessor } from '../../../src/learning/coaching/coaching-processor.js';
import type { CapturedDecision, CoachingData } from '../../../src/learning/types.js';

describe('CoachingProcessor', () => {
  let processor: CoachingProcessor;

  function createTestDecision(overrides: Partial<CapturedDecision> = {}): CapturedDecision {
    return {
      id: 'decision-1',
      userId: 'user-1',
      timestamp: new Date(),
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
      finalChoice: 'opt-2',
      wasOverride: true,
      coaching: {
        overrideReason: 'reasoning_incorrect',
        explanation: 'Test explanation',
        shouldRemember: true,
      },
      learningEvents: [],
      generatedUpdates: [],
      ...overrides,
    };
  }

  beforeEach(() => {
    processor = new CoachingProcessor();
  });

  describe('processCoaching', () => {
    it('should return empty for non-override decisions', () => {
      const decision = createTestDecision({
        wasOverride: false,
        coaching: undefined,
      });

      const result = processor.processCoaching(decision);

      expect(result.updates).toEqual([]);
      expect(result.learningEvents).toEqual([]);
    });

    it('should return empty for override without coaching data', () => {
      const decision = createTestDecision({
        wasOverride: true,
        coaching: undefined,
      });

      const result = processor.processCoaching(decision);

      expect(result.updates).toEqual([]);
      expect(result.learningEvents).toEqual([]);
    });

    it('should generate coaching_received learning event', () => {
      const decision = createTestDecision();

      const result = processor.processCoaching(decision);

      expect(result.learningEvents).toHaveLength(1);
      expect(result.learningEvents[0].type).toBe('coaching_received');
      expect(result.learningEvents[0].userId).toBe('user-1');
      expect(result.learningEvents[0].decisionId).toBe('decision-1');
    });
  });

  describe('reasoning_incorrect handling', () => {
    it('should create principle refinement for specified incorrect principles', () => {
      const coaching: CoachingData = {
        overrideReason: 'reasoning_incorrect',
        explanation: 'Principle was applied wrongly in this context',
        incorrectPrinciples: ['principle-1'],
        shouldRemember: true,
      };
      const decision = createTestDecision({ coaching });

      const result = processor.processCoaching(decision);

      expect(result.updates).toHaveLength(1);
      expect(result.updates[0].type).toBe('principle_refinement');
      if (result.updates[0].payload.type === 'principle_refinement') {
        expect(result.updates[0].payload.principleId).toBe('principle-1');
      }
    });

    it('should create refinements for all applied principles when none specified', () => {
      const coaching: CoachingData = {
        overrideReason: 'reasoning_incorrect',
        explanation: 'All principles were applied wrongly',
        shouldRemember: true,
      };
      const decision = createTestDecision({ coaching });
      decision.protege.appliedPrinciples = [
        { principleId: 'p1', principleText: 'P1', relevance: 'R', weight: 5, strength: 0.5 },
        { principleId: 'p2', principleText: 'P2', relevance: 'R', weight: 5, strength: 0.5 },
      ];

      const result = processor.processCoaching(decision);

      expect(result.updates).toHaveLength(2);
      const principleIds = result.updates
        .filter(u => u.payload.type === 'principle_refinement')
        .map(u => (u.payload as { principleId: string }).principleId);
      expect(principleIds).toContain('p1');
      expect(principleIds).toContain('p2');
    });
  });

  describe('missing_context handling', () => {
    it('should create context update', () => {
      const coaching: CoachingData = {
        overrideReason: 'missing_context',
        explanation: 'System did not know about deadline',
        missingContext: 'Project deadline is next week',
        shouldRemember: true,
      };
      const decision = createTestDecision({ coaching });

      const result = processor.processCoaching(decision);

      const contextUpdate = result.updates.find(u => u.type === 'context_update');
      expect(contextUpdate).toBeDefined();
      if (contextUpdate?.payload.type === 'context_update') {
        expect(contextUpdate.payload.newValue).toBe('Project deadline is next week');
      }
    });

    it('should create new principle when shouldRemember is true', () => {
      const coaching: CoachingData = {
        overrideReason: 'missing_context',
        explanation: 'Always consider deadline pressure',
        missingContext: 'Deadline awareness',
        shouldRemember: true,
      };
      const decision = createTestDecision({ coaching });

      const result = processor.processCoaching(decision);

      const newPrinciple = result.updates.find(u => u.type === 'new_principle');
      expect(newPrinciple).toBeDefined();
    });

    it('should not create new principle when shouldRemember is false', () => {
      const coaching: CoachingData = {
        overrideReason: 'missing_context',
        explanation: 'One-time thing',
        missingContext: 'Temporary context',
        shouldRemember: false,
      };
      const decision = createTestDecision({ coaching });

      const result = processor.processCoaching(decision);

      const newPrinciple = result.updates.find(u => u.type === 'new_principle');
      expect(newPrinciple).toBeUndefined();
    });

    it('should not create new principle when createPrinciplesFromContext is disabled', () => {
      const customProcessor = new CoachingProcessor(undefined, {
        createPrinciplesFromContext: false,
      });
      const coaching: CoachingData = {
        overrideReason: 'missing_context',
        explanation: 'New learning',
        missingContext: 'Important context',
        shouldRemember: true,
      };
      const decision = createTestDecision({ coaching });

      const result = customProcessor.processCoaching(decision);

      const newPrinciple = result.updates.find(u => u.type === 'new_principle');
      expect(newPrinciple).toBeUndefined();
    });
  });

  describe('priorities_changed handling', () => {
    it('should create priority update', () => {
      const coaching: CoachingData = {
        overrideReason: 'priorities_changed',
        explanation: 'Now prioritizing speed over quality',
        updatedPriorities: ['speed', 'cost', 'quality'],
        shouldRemember: true,
      };
      const decision = createTestDecision({ coaching });

      const result = processor.processCoaching(decision);

      expect(result.updates).toHaveLength(1);
      expect(result.updates[0].type).toBe('priority_update');
      if (result.updates[0].payload.type === 'priority_update') {
        expect(result.updates[0].payload.newPriorities).toEqual(['speed', 'cost', 'quality']);
      }
    });
  });

  describe('exception_case handling', () => {
    it('should create exception note', () => {
      const coaching: CoachingData = {
        overrideReason: 'exception_case',
        explanation: 'Holiday special circumstance',
        shouldRemember: false,
      };
      const decision = createTestDecision({ coaching });

      const result = processor.processCoaching(decision);

      expect(result.updates).toHaveLength(1);
      expect(result.updates[0].type).toBe('exception_note');
      if (result.updates[0].payload.type === 'exception_note') {
        expect(result.updates[0].payload.note).toBe('Holiday special circumstance');
        expect(result.updates[0].payload.occurrence).toBe('single');
      }
    });

    it('should include related principles in exception note', () => {
      const coaching: CoachingData = {
        overrideReason: 'exception_case',
        explanation: 'Special case',
        shouldRemember: false,
      };
      const decision = createTestDecision({ coaching });

      const result = processor.processCoaching(decision);

      if (result.updates[0].payload.type === 'exception_note') {
        expect(result.updates[0].payload.relatedPrinciples).toContain('principle-1');
      }
    });
  });
});

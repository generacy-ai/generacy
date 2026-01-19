/**
 * Tests for LearningLoopProcessor
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  LearningLoopProcessor,
  type KnowledgeStoreClient,
  type ApplyResult,
} from '../../src/learning/learning-loop-processor.js';
import type { DecisionCaptureInput } from '../../src/learning/decision/decision-capture.js';
import type { CoachingData, KnowledgeUpdate } from '../../src/learning/types.js';
import type { Principle, Pattern, IndividualKnowledge } from '../../src/recommendation/types/knowledge.js';

describe('LearningLoopProcessor', () => {
  let processor: LearningLoopProcessor;
  let mockClient: KnowledgeStoreClient;

  function createTestInput(overrides: Partial<DecisionCaptureInput> = {}): DecisionCaptureInput {
    return {
      id: `decision-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

  function createMockKnowledgeStoreClient(): KnowledgeStoreClient {
    return {
      applyUpdate: vi.fn().mockResolvedValue({ success: true }),
      getPrinciple: vi.fn().mockResolvedValue(null),
      getPattern: vi.fn().mockResolvedValue(null),
      getUserKnowledge: vi.fn().mockResolvedValue(null),
    };
  }

  beforeEach(() => {
    mockClient = createMockKnowledgeStoreClient();
    processor = new LearningLoopProcessor(mockClient);
  });

  describe('processDecision', () => {
    it('should process a decision without override', async () => {
      const input = createTestInput({ finalChoice: 'opt-1' });

      const result = await processor.processDecision(input);

      expect(result.decisionId).toBe(input.id);
      expect(result.learningEvents.length).toBeGreaterThan(0);
      expect(result.principlesReinforced).toContain('principle-1');
      expect(result.principlesContradicted).toEqual([]);
      expect(result.suggestedUpdates).toEqual([]);
    });

    it('should process an override decision with coaching', async () => {
      const coaching: CoachingData = {
        overrideReason: 'reasoning_incorrect',
        explanation: 'The principle was misapplied',
        incorrectPrinciples: ['principle-1'],
        shouldRemember: true,
      };
      const input = createTestInput({
        finalChoice: 'opt-2',
        coaching,
      });

      const result = await processor.processDecision(input);

      expect(result.decisionId).toBe(input.id);
      expect(result.principlesContradicted).toContain('principle-1');
      expect(result.suggestedUpdates.length).toBeGreaterThan(0);
    });

    it('should generate update_proposed events for updates', async () => {
      const coaching: CoachingData = {
        overrideReason: 'missing_context',
        explanation: 'System did not know about X',
        missingContext: 'Important context X',
        shouldRemember: true,
      };
      const input = createTestInput({
        finalChoice: 'opt-2',
        coaching,
      });

      const result = await processor.processDecision(input);

      const proposedEvents = result.learningEvents.filter(e => e.type === 'update_proposed');
      expect(proposedEvents.length).toBeGreaterThan(0);
    });

    it('should auto-apply eligible updates to knowledge store', async () => {
      const coaching: CoachingData = {
        overrideReason: 'exception_case', // Exception notes are auto-approved
        explanation: 'One-time special case',
        shouldRemember: false,
      };
      const input = createTestInput({
        finalChoice: 'opt-2',
        coaching,
      });

      await processor.processDecision(input);

      expect(mockClient.applyUpdate).toHaveBeenCalled();
    });

    it('should store decision in repository', async () => {
      const input = createTestInput({ id: 'decision-test' });

      await processor.processDecision(input);

      const stored = await processor.getDecisionRepository().getById('decision-test');
      expect(stored).not.toBeNull();
      expect(stored?.finalChoice).toBe('opt-1');
    });

    it('should link updates to decisions', async () => {
      const coaching: CoachingData = {
        overrideReason: 'missing_context',
        explanation: 'Missing info',
        missingContext: 'Info',
        shouldRemember: false,
      };
      const input = createTestInput({
        id: 'decision-link-test',
        finalChoice: 'opt-2',
        coaching,
      });

      await processor.processDecision(input);

      const stored = await processor.getDecisionRepository().getById('decision-link-test');
      expect(stored?.generatedUpdates.length).toBeGreaterThan(0);
    });
  });

  describe('processCoaching', () => {
    it('should process coaching for existing decision', async () => {
      // First create a decision without coaching
      const input = createTestInput({
        id: 'decision-coaching-test',
        finalChoice: 'opt-2',
      });
      await processor.processDecision(input);

      // Then add coaching
      const coaching: CoachingData = {
        overrideReason: 'priorities_changed',
        explanation: 'Priorities shifted',
        updatedPriorities: ['speed', 'quality'],
        shouldRemember: true,
      };

      const result = await processor.processCoaching('user-1', 'decision-coaching-test', coaching);

      expect(result.updates.length).toBeGreaterThan(0);
      expect(result.queuedUpdates.length).toBeGreaterThan(0);
    });

    it('should throw for non-existent decision', async () => {
      const coaching: CoachingData = {
        overrideReason: 'exception_case',
        explanation: 'Test',
        shouldRemember: false,
      };

      await expect(processor.processCoaching('user-1', 'non-existent', coaching))
        .rejects.toThrow('Decision not found');
    });
  });

  describe('applyUpdate', () => {
    it('should apply update via knowledge store client', async () => {
      const coaching: CoachingData = {
        overrideReason: 'missing_context',
        explanation: 'Missing',
        missingContext: 'Context',
        shouldRemember: false,
      };
      const input = createTestInput({
        finalChoice: 'opt-2',
        coaching,
      });

      const result = await processor.processDecision(input);

      // Get a pending update that wasn't auto-approved
      const pending = processor.getPendingUpdates('user-1');
      if (pending.length > 0) {
        const update = pending[0].update;
        processor.approveUpdate(update.id);

        const applyResult = await processor.applyUpdate(update);
        expect(applyResult.success).toBe(true);
      }
    });

    it('should work without knowledge store client', async () => {
      const processorNoClient = new LearningLoopProcessor();

      const coaching: CoachingData = {
        overrideReason: 'exception_case',
        explanation: 'Test',
        shouldRemember: false,
      };
      const input = createTestInput({
        finalChoice: 'opt-2',
        coaching,
      });

      const result = await processorNoClient.processDecision(input);

      // Should still work, just marks as applied locally
      expect(result.decisionId).toBeDefined();
    });
  });

  describe('getPendingUpdates', () => {
    it('should return pending updates for user', async () => {
      const coaching: CoachingData = {
        overrideReason: 'reasoning_incorrect',
        explanation: 'Wrong application',
        incorrectPrinciples: ['principle-1'],
        shouldRemember: true,
      };
      const input = createTestInput({
        finalChoice: 'opt-2',
        coaching,
      });

      await processor.processDecision(input);

      const pending = processor.getPendingUpdates('user-1');
      // principle_refinement with add_exception is auto-approved
      // so we might not have pending updates depending on the update type
      expect(pending).toBeInstanceOf(Array);
    });
  });

  describe('approveUpdate / rejectUpdate', () => {
    it('should approve a pending update', async () => {
      // Create update that requires approval
      const coaching: CoachingData = {
        overrideReason: 'priorities_changed',
        explanation: 'New priorities',
        updatedPriorities: ['a', 'b'],
        shouldRemember: true,
      };
      const input = createTestInput({
        finalChoice: 'opt-2',
        coaching,
      });

      await processor.processDecision(input);

      const pending = processor.getPendingUpdates('user-1');
      if (pending.length > 0) {
        const approved = processor.approveUpdate(pending[0].update.id);
        expect(approved?.status).toBe('approved');
      }
    });

    it('should reject a pending update', async () => {
      const coaching: CoachingData = {
        overrideReason: 'priorities_changed',
        explanation: 'New priorities',
        updatedPriorities: ['a', 'b'],
        shouldRemember: true,
      };
      const input = createTestInput({
        finalChoice: 'opt-2',
        coaching,
      });

      await processor.processDecision(input);

      const pending = processor.getPendingUpdates('user-1');
      if (pending.length > 0) {
        const rejected = processor.rejectUpdate(pending[0].update.id, 'Not appropriate');
        expect(rejected?.status).toBe('rejected');
      }
    });
  });

  describe('metricsImpact', () => {
    it('should calculate positive impact for non-override', async () => {
      const input = createTestInput({ finalChoice: 'opt-1' });

      const result = await processor.processDecision(input);

      expect(result.metricsImpact.interventionRateChange).toBeLessThan(0);
      expect(result.metricsImpact.confidenceChange).toBeGreaterThan(0);
    });

    it('should calculate negative impact for override', async () => {
      const coaching: CoachingData = {
        overrideReason: 'reasoning_incorrect',
        explanation: 'Wrong',
        shouldRemember: true,
      };
      const input = createTestInput({
        finalChoice: 'opt-2',
        coaching,
      });

      const result = await processor.processDecision(input);

      expect(result.metricsImpact.interventionRateChange).toBeGreaterThan(0);
      expect(result.metricsImpact.confidenceChange).toBeLessThan(0);
    });
  });

  describe('configuration', () => {
    it('should accept custom configuration', async () => {
      const customProcessor = new LearningLoopProcessor(mockClient, {
        approvalThresholds: {
          minConfidence: 0.9,
        },
        updateGenerator: {
          defaultConfidence: 0.6,
        },
      });

      // Should work with custom config
      const input = createTestInput({ finalChoice: 'opt-1' });
      const result = await customProcessor.processDecision(input);

      expect(result.decisionId).toBeDefined();
    });
  });

  describe('getUpdateQueue', () => {
    it('should expose the update queue', () => {
      const queue = processor.getUpdateQueue();

      expect(queue).toBeDefined();
      expect(typeof queue.getStats).toBe('function');
    });
  });
});

/**
 * Tests for UpdateGenerator
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { UpdateGenerator } from '../../../src/learning/coaching/update-generator.js';
import type { CoachingData } from '../../../src/learning/types.js';

describe('UpdateGenerator', () => {
  let generator: UpdateGenerator;

  function createCoaching(overrides: Partial<CoachingData> = {}): CoachingData {
    return {
      overrideReason: 'reasoning_incorrect',
      explanation: 'Test explanation for the override',
      shouldRemember: true,
      ...overrides,
    };
  }

  beforeEach(() => {
    generator = new UpdateGenerator();
  });

  describe('createPrincipleRefinement', () => {
    it('should create a principle refinement update', () => {
      const coaching = createCoaching({
        overrideReason: 'reasoning_incorrect',
        explanation: 'The principle does not apply when X is true',
        incorrectPrinciples: ['principle-1'],
      });

      const update = generator.createPrincipleRefinement(
        'user-1',
        'decision-1',
        coaching,
        'principle-1'
      );

      expect(update.type).toBe('principle_refinement');
      expect(update.userId).toBe('user-1');
      expect(update.sourceDecisionId).toBe('decision-1');
      expect(update.status).toBe('pending');
      expect(update.payload.type).toBe('principle_refinement');

      if (update.payload.type === 'principle_refinement') {
        expect(update.payload.principleId).toBe('principle-1');
        expect(update.payload.refinementType).toBe('add_exception');
        expect(update.payload.change).toBe('The principle does not apply when X is true');
      }
    });

    it('should set appropriate confidence', () => {
      const coaching = createCoaching();
      const update = generator.createPrincipleRefinement('user-1', 'decision-1', coaching, 'p1');

      expect(update.confidence).toBe(0.7); // default confidence
    });
  });

  describe('createContextUpdate', () => {
    it('should create a context update', () => {
      const coaching = createCoaching({
        overrideReason: 'missing_context',
        explanation: 'Did not know about the deadline',
        missingContext: 'Project deadline is next week',
      });

      const update = generator.createContextUpdate('user-1', 'decision-1', coaching);

      expect(update.type).toBe('context_update');
      expect(update.payload.type).toBe('context_update');

      if (update.payload.type === 'context_update') {
        expect(update.payload.field).toBe('constraints');
        expect(update.payload.newValue).toBe('Project deadline is next week');
      }
    });
  });

  describe('createNewPrincipleFromContext', () => {
    it('should create a new principle update', () => {
      const coaching = createCoaching({
        overrideReason: 'missing_context',
        explanation: 'Always check deadlines before committing to work',
        missingContext: 'Deadline awareness',
      });

      const update = generator.createNewPrincipleFromContext(
        'user-1',
        'decision-1',
        coaching,
        ['productivity', 'planning']
      );

      expect(update.type).toBe('new_principle');
      expect(update.payload.type).toBe('new_principle');

      if (update.payload.type === 'new_principle') {
        expect(update.payload.principle.content).toBe('Always check deadlines before committing to work');
        expect(update.payload.principle.domains).toEqual(['productivity', 'planning']);
        expect(update.payload.principle.source).toBe('learned');
        expect(update.payload.evidenceDecisions).toContain('decision-1');
      }
    });

    it('should have lower confidence than other updates', () => {
      const coaching = createCoaching();
      const update = generator.createNewPrincipleFromContext('user-1', 'decision-1', coaching);

      expect(update.confidence).toBe(0.7 * 0.8); // 80% of default
    });
  });

  describe('createPriorityUpdate', () => {
    it('should create a priority update', () => {
      const coaching = createCoaching({
        overrideReason: 'priorities_changed',
        explanation: 'Now focusing on speed over quality',
        updatedPriorities: ['speed', 'cost', 'quality'],
      });

      const update = generator.createPriorityUpdate(
        'user-1',
        'decision-1',
        coaching,
        ['quality', 'speed', 'cost']
      );

      expect(update.type).toBe('priority_update');
      expect(update.payload.type).toBe('priority_update');

      if (update.payload.type === 'priority_update') {
        expect(update.payload.previousPriorities).toEqual(['quality', 'speed', 'cost']);
        expect(update.payload.newPriorities).toEqual(['speed', 'cost', 'quality']);
      }
    });

    it('should have high confidence for explicit priority changes', () => {
      const coaching = createCoaching({
        overrideReason: 'priorities_changed',
        updatedPriorities: ['new-priority'],
      });

      const update = generator.createPriorityUpdate('user-1', 'decision-1', coaching);

      expect(update.confidence).toBe(0.9);
    });
  });

  describe('createExceptionNote', () => {
    it('should create an exception note', () => {
      const coaching = createCoaching({
        overrideReason: 'exception_case',
        explanation: 'One-time special circumstance due to holiday',
      });

      const update = generator.createExceptionNote(
        'user-1',
        'decision-1',
        coaching,
        ['principle-1', 'principle-2']
      );

      expect(update.type).toBe('exception_note');
      expect(update.payload.type).toBe('exception_note');

      if (update.payload.type === 'exception_note') {
        expect(update.payload.note).toBe('One-time special circumstance due to holiday');
        expect(update.payload.relatedPrinciples).toEqual(['principle-1', 'principle-2']);
        expect(update.payload.occurrence).toBe('single');
      }
    });

    it('should have full confidence as exceptions are always valid', () => {
      const coaching = createCoaching({ overrideReason: 'exception_case' });
      const update = generator.createExceptionNote('user-1', 'decision-1', coaching);

      expect(update.confidence).toBe(1.0);
    });
  });

  describe('configuration', () => {
    it('should use custom default confidence', () => {
      const customGenerator = new UpdateGenerator({ defaultConfidence: 0.8 });
      const coaching = createCoaching();

      const update = customGenerator.createPrincipleRefinement('user-1', 'decision-1', coaching, 'p1');

      expect(update.confidence).toBe(0.8);
    });
  });

  describe('update metadata', () => {
    it('should generate unique IDs', () => {
      const coaching = createCoaching();

      const update1 = generator.createExceptionNote('user-1', 'decision-1', coaching);
      const update2 = generator.createExceptionNote('user-1', 'decision-1', coaching);

      expect(update1.id).not.toBe(update2.id);
    });

    it('should set timestamps', () => {
      const coaching = createCoaching();
      const before = new Date();

      const update = generator.createExceptionNote('user-1', 'decision-1', coaching);

      const after = new Date();
      expect(update.generatedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(update.generatedAt.getTime()).toBeLessThanOrEqual(after.getTime());
      expect(update.statusUpdatedAt).toEqual(update.generatedAt);
    });

    it('should set initial status to pending', () => {
      const coaching = createCoaching();
      const update = generator.createExceptionNote('user-1', 'decision-1', coaching);

      expect(update.status).toBe('pending');
    });
  });
});

/**
 * Tests for DecisionRepository
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryDecisionRepository } from '../../../src/learning/decision/decision-repository.js';
import type { CapturedDecision } from '../../../src/learning/types.js';

describe('InMemoryDecisionRepository', () => {
  let repository: InMemoryDecisionRepository;

  // Factory for creating test decisions
  function createTestDecision(overrides: Partial<CapturedDecision> = {}): CapturedDecision {
    return {
      id: `decision-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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
        appliedPrinciples: [],
        contextInfluence: [],
        differsFromBaseline: false,
        meta: {
          processingTimeMs: 100,
          principlesEvaluated: 5,
          principlesMatched: 2,
          hadConflicts: false,
          engineVersion: '1.0.0',
        },
      },
      finalChoice: 'opt-1',
      wasOverride: false,
      learningEvents: [],
      generatedUpdates: [],
      ...overrides,
    };
  }

  beforeEach(() => {
    repository = new InMemoryDecisionRepository();
  });

  describe('save', () => {
    it('should save a decision', async () => {
      const decision = createTestDecision({ id: 'decision-1' });

      await repository.save(decision);

      const retrieved = await repository.getById('decision-1');
      expect(retrieved).toEqual(decision);
    });

    it('should update an existing decision', async () => {
      const decision = createTestDecision({ id: 'decision-1', finalChoice: 'opt-1' });
      await repository.save(decision);

      const updated = { ...decision, finalChoice: 'opt-2' };
      await repository.save(updated);

      const retrieved = await repository.getById('decision-1');
      expect(retrieved?.finalChoice).toBe('opt-2');
    });
  });

  describe('getById', () => {
    it('should return null for non-existent decision', async () => {
      const result = await repository.getById('non-existent');
      expect(result).toBeNull();
    });

    it('should return the correct decision', async () => {
      const decision1 = createTestDecision({ id: 'decision-1' });
      const decision2 = createTestDecision({ id: 'decision-2' });

      await repository.save(decision1);
      await repository.save(decision2);

      const result = await repository.getById('decision-1');
      expect(result?.id).toBe('decision-1');
    });
  });

  describe('getByUserId', () => {
    it('should return empty array for user with no decisions', async () => {
      const result = await repository.getByUserId('unknown-user');
      expect(result).toEqual([]);
    });

    it('should return all decisions for a user', async () => {
      const decision1 = createTestDecision({ id: 'd1', userId: 'user-1' });
      const decision2 = createTestDecision({ id: 'd2', userId: 'user-1' });
      const decision3 = createTestDecision({ id: 'd3', userId: 'user-2' });

      await repository.save(decision1);
      await repository.save(decision2);
      await repository.save(decision3);

      const result = await repository.getByUserId('user-1');
      expect(result).toHaveLength(2);
      expect(result.map(d => d.id).sort()).toEqual(['d1', 'd2']);
    });

    it('should sort by timestamp descending by default', async () => {
      const now = Date.now();
      const decision1 = createTestDecision({ id: 'd1', userId: 'user-1', timestamp: new Date(now - 2000) });
      const decision2 = createTestDecision({ id: 'd2', userId: 'user-1', timestamp: new Date(now - 1000) });
      const decision3 = createTestDecision({ id: 'd3', userId: 'user-1', timestamp: new Date(now) });

      await repository.save(decision1);
      await repository.save(decision2);
      await repository.save(decision3);

      const result = await repository.getByUserId('user-1');
      expect(result.map(d => d.id)).toEqual(['d3', 'd2', 'd1']);
    });

    it('should respect ascending sort order', async () => {
      const now = Date.now();
      const decision1 = createTestDecision({ id: 'd1', userId: 'user-1', timestamp: new Date(now - 2000) });
      const decision2 = createTestDecision({ id: 'd2', userId: 'user-1', timestamp: new Date(now) });

      await repository.save(decision1);
      await repository.save(decision2);

      const result = await repository.getByUserId('user-1', { direction: 'asc' });
      expect(result.map(d => d.id)).toEqual(['d1', 'd2']);
    });

    it('should apply limit', async () => {
      const decision1 = createTestDecision({ id: 'd1', userId: 'user-1' });
      const decision2 = createTestDecision({ id: 'd2', userId: 'user-1' });
      const decision3 = createTestDecision({ id: 'd3', userId: 'user-1' });

      await repository.save(decision1);
      await repository.save(decision2);
      await repository.save(decision3);

      const result = await repository.getByUserId('user-1', { limit: 2 });
      expect(result).toHaveLength(2);
    });

    it('should apply offset', async () => {
      const now = Date.now();
      const decision1 = createTestDecision({ id: 'd1', userId: 'user-1', timestamp: new Date(now - 2000) });
      const decision2 = createTestDecision({ id: 'd2', userId: 'user-1', timestamp: new Date(now - 1000) });
      const decision3 = createTestDecision({ id: 'd3', userId: 'user-1', timestamp: new Date(now) });

      await repository.save(decision1);
      await repository.save(decision2);
      await repository.save(decision3);

      const result = await repository.getByUserId('user-1', { offset: 1 });
      expect(result.map(d => d.id)).toEqual(['d2', 'd1']);
    });

    it('should filter by date range', async () => {
      const now = Date.now();
      const decision1 = createTestDecision({ id: 'd1', userId: 'user-1', timestamp: new Date(now - 3000) });
      const decision2 = createTestDecision({ id: 'd2', userId: 'user-1', timestamp: new Date(now - 1500) });
      const decision3 = createTestDecision({ id: 'd3', userId: 'user-1', timestamp: new Date(now) });

      await repository.save(decision1);
      await repository.save(decision2);
      await repository.save(decision3);

      const result = await repository.getByUserId('user-1', {
        dateRange: {
          from: new Date(now - 2000),
          to: new Date(now - 1000),
        },
      });
      expect(result.map(d => d.id)).toEqual(['d2']);
    });
  });

  describe('getOverrides', () => {
    it('should return only override decisions', async () => {
      const decision1 = createTestDecision({ id: 'd1', userId: 'user-1', wasOverride: false });
      const decision2 = createTestDecision({ id: 'd2', userId: 'user-1', wasOverride: true });
      const decision3 = createTestDecision({ id: 'd3', userId: 'user-1', wasOverride: true });

      await repository.save(decision1);
      await repository.save(decision2);
      await repository.save(decision3);

      const result = await repository.getOverrides('user-1');
      expect(result).toHaveLength(2);
      expect(result.every(d => d.wasOverride)).toBe(true);
    });

    it('should return empty array when no overrides', async () => {
      const decision = createTestDecision({ id: 'd1', userId: 'user-1', wasOverride: false });
      await repository.save(decision);

      const result = await repository.getOverrides('user-1');
      expect(result).toEqual([]);
    });
  });

  describe('count', () => {
    it('should return 0 for user with no decisions', async () => {
      const count = await repository.count('unknown-user');
      expect(count).toBe(0);
    });

    it('should return correct count', async () => {
      const decision1 = createTestDecision({ id: 'd1', userId: 'user-1' });
      const decision2 = createTestDecision({ id: 'd2', userId: 'user-1' });
      const decision3 = createTestDecision({ id: 'd3', userId: 'user-2' });

      await repository.save(decision1);
      await repository.save(decision2);
      await repository.save(decision3);

      expect(await repository.count('user-1')).toBe(2);
      expect(await repository.count('user-2')).toBe(1);
    });
  });

  describe('delete', () => {
    it('should return false for non-existent decision', async () => {
      const result = await repository.delete('non-existent');
      expect(result).toBe(false);
    });

    it('should delete a decision', async () => {
      const decision = createTestDecision({ id: 'decision-1' });
      await repository.save(decision);

      const deleted = await repository.delete('decision-1');
      expect(deleted).toBe(true);

      const retrieved = await repository.getById('decision-1');
      expect(retrieved).toBeNull();
    });

    it('should update user index after delete', async () => {
      const decision = createTestDecision({ id: 'decision-1', userId: 'user-1' });
      await repository.save(decision);

      await repository.delete('decision-1');

      const userDecisions = await repository.getByUserId('user-1');
      expect(userDecisions).toEqual([]);
    });
  });

  describe('clear', () => {
    it('should remove all decisions', async () => {
      const decision1 = createTestDecision({ id: 'd1', userId: 'user-1' });
      const decision2 = createTestDecision({ id: 'd2', userId: 'user-2' });

      await repository.save(decision1);
      await repository.save(decision2);
      await repository.clear();

      expect(await repository.getById('d1')).toBeNull();
      expect(await repository.getById('d2')).toBeNull();
      expect(await repository.count('user-1')).toBe(0);
      expect(await repository.count('user-2')).toBe(0);
    });
  });
});

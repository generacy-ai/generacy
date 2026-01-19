/**
 * Tests for ApprovalClassifier
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ApprovalClassifier } from '../../../src/learning/updates/approval-classifier.js';
import type { KnowledgeUpdate, UpdatePayload } from '../../../src/learning/types.js';

describe('ApprovalClassifier', () => {
  let classifier: ApprovalClassifier;

  function createUpdate(
    type: KnowledgeUpdate['type'],
    payload: UpdatePayload,
    confidence = 0.8
  ): KnowledgeUpdate {
    return {
      id: 'update-1',
      userId: 'user-1',
      type,
      generatedAt: new Date(),
      sourceDecisionId: 'decision-1',
      confidence,
      reasoning: 'Test reasoning',
      payload,
      status: 'pending',
      statusUpdatedAt: new Date(),
    };
  }

  beforeEach(() => {
    classifier = new ApprovalClassifier();
  });

  describe('always manual types', () => {
    it('should require manual approval for new_principle', () => {
      const update = createUpdate('new_principle', {
        type: 'new_principle',
        principle: {
          name: 'Test',
          content: 'Test content',
          domains: [],
          suggestedWeight: 5,
          source: 'learned',
        },
        evidenceDecisions: ['d1'],
      });

      const result = classifier.classify(update);

      expect(result.autoApprove).toBe(false);
      expect(result.impactLevel).toBe('high');
      expect(result.reason).toContain('new_principle');
    });
  });

  describe('confidence threshold', () => {
    it('should require manual approval when confidence is below threshold', () => {
      const update = createUpdate(
        'exception_note',
        {
          type: 'exception_note',
          note: 'Test',
          relatedPrinciples: [],
          occurrence: 'single',
        },
        0.5 // Below default threshold of 0.7
      );

      const result = classifier.classify(update);

      expect(result.autoApprove).toBe(false);
      expect(result.reason).toContain('Confidence');
    });

    it('should respect custom confidence threshold', () => {
      const customClassifier = new ApprovalClassifier({ minConfidence: 0.9 });
      const update = createUpdate(
        'exception_note',
        {
          type: 'exception_note',
          note: 'Test',
          relatedPrinciples: [],
          occurrence: 'single',
        },
        0.85
      );

      const result = customClassifier.classify(update);

      expect(result.autoApprove).toBe(false);
    });
  });

  describe('principle_reinforcement', () => {
    it('should auto-approve small weight changes', () => {
      const update = createUpdate('principle_reinforcement', {
        type: 'principle_reinforcement',
        principleId: 'p1',
        currentWeight: 5,
        newWeight: 5.3,
        delta: 0.3,
      });

      const result = classifier.classify(update);

      expect(result.autoApprove).toBe(true);
      expect(result.impactLevel).toBe('low');
    });

    it('should require approval for large weight changes', () => {
      const update = createUpdate('principle_reinforcement', {
        type: 'principle_reinforcement',
        principleId: 'p1',
        currentWeight: 5,
        newWeight: 6,
        delta: 1.0,
      });

      const result = classifier.classify(update);

      expect(result.autoApprove).toBe(false);
      expect(result.impactLevel).toBe('medium');
    });
  });

  describe('principle_weakening', () => {
    it('should auto-approve very small weakening', () => {
      const update = createUpdate('principle_weakening', {
        type: 'principle_weakening',
        principleId: 'p1',
        currentWeight: 5,
        newWeight: 4.8,
        delta: -0.2,
        contradictionCount: 1,
      });

      const result = classifier.classify(update);

      expect(result.autoApprove).toBe(true);
    });

    it('should auto-approve with multiple contradictions', () => {
      const update = createUpdate('principle_weakening', {
        type: 'principle_weakening',
        principleId: 'p1',
        currentWeight: 5,
        newWeight: 4,
        delta: -1.0,
        contradictionCount: 5,
      });

      const result = classifier.classify(update);

      expect(result.autoApprove).toBe(true);
      expect(result.reason).toContain('contradictions');
    });

    it('should require approval for significant weakening with few contradictions', () => {
      const update = createUpdate('principle_weakening', {
        type: 'principle_weakening',
        principleId: 'p1',
        currentWeight: 5,
        newWeight: 4,
        delta: -1.0,
        contradictionCount: 1,
      });

      const result = classifier.classify(update);

      expect(result.autoApprove).toBe(false);
    });
  });

  describe('principle_refinement', () => {
    it('should auto-approve adding exceptions', () => {
      const update = createUpdate('principle_refinement', {
        type: 'principle_refinement',
        principleId: 'p1',
        refinementType: 'add_exception',
        change: 'Except when X',
      });

      const result = classifier.classify(update);

      expect(result.autoApprove).toBe(true);
      expect(result.impactLevel).toBe('low');
    });

    it('should require approval for narrowing applicability', () => {
      const update = createUpdate('principle_refinement', {
        type: 'principle_refinement',
        principleId: 'p1',
        refinementType: 'narrow_applicability',
        change: 'Only applies in domain X',
      });

      const result = classifier.classify(update);

      expect(result.autoApprove).toBe(false);
      expect(result.impactLevel).toBe('medium');
    });

    it('should require approval for broadening applicability', () => {
      const update = createUpdate('principle_refinement', {
        type: 'principle_refinement',
        principleId: 'p1',
        refinementType: 'broaden_applicability',
        change: 'Now applies to Y as well',
      });

      const result = classifier.classify(update);

      expect(result.autoApprove).toBe(false);
    });
  });

  describe('context_update', () => {
    it('should auto-approve context updates', () => {
      const update = createUpdate('context_update', {
        type: 'context_update',
        field: 'constraints',
        previousValue: null,
        newValue: 'New constraint',
      });

      const result = classifier.classify(update);

      expect(result.autoApprove).toBe(true);
      expect(result.impactLevel).toBe('low');
    });
  });

  describe('priority_update', () => {
    it('should require approval for priority updates', () => {
      const update = createUpdate('priority_update', {
        type: 'priority_update',
        previousPriorities: ['a', 'b'],
        newPriorities: ['b', 'a'],
      });

      const result = classifier.classify(update);

      expect(result.autoApprove).toBe(false);
      expect(result.impactLevel).toBe('medium');
    });
  });

  describe('exception_note', () => {
    it('should auto-approve exception notes', () => {
      const update = createUpdate('exception_note', {
        type: 'exception_note',
        note: 'One-time thing',
        relatedPrinciples: ['p1'],
        occurrence: 'single',
      });

      const result = classifier.classify(update);

      expect(result.autoApprove).toBe(true);
      expect(result.impactLevel).toBe('low');
    });
  });

  describe('configuration', () => {
    it('should allow customizing always manual types', () => {
      const customClassifier = new ApprovalClassifier({
        alwaysManual: ['new_principle', 'priority_update'],
      });

      const update = createUpdate('priority_update', {
        type: 'priority_update',
        previousPriorities: [],
        newPriorities: ['a'],
      });

      const result = customClassifier.classify(update);

      expect(result.autoApprove).toBe(false);
      expect(result.impactLevel).toBe('high');
    });

    it('should expose thresholds via getter', () => {
      const thresholds = classifier.getThresholds();

      expect(thresholds.weightChangeDelta).toBe(0.5);
      expect(thresholds.minConfidence).toBe(0.7);
      expect(thresholds.alwaysManual).toContain('new_principle');
    });
  });
});

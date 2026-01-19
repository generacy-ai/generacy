/**
 * Tests for UpdateQueue
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { UpdateQueue } from '../../../src/learning/updates/update-queue.js';
import { ApprovalClassifier } from '../../../src/learning/updates/approval-classifier.js';
import type { KnowledgeUpdate } from '../../../src/learning/types.js';

describe('UpdateQueue', () => {
  let queue: UpdateQueue;
  let classifier: ApprovalClassifier;

  function createUpdate(overrides: Partial<KnowledgeUpdate> = {}): KnowledgeUpdate {
    return {
      id: `update-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      userId: 'user-1',
      type: 'exception_note',
      generatedAt: new Date(),
      sourceDecisionId: 'decision-1',
      confidence: 0.8,
      reasoning: 'Test reasoning',
      payload: {
        type: 'exception_note',
        note: 'Test note',
        relatedPrinciples: [],
        occurrence: 'single',
      },
      status: 'pending',
      statusUpdatedAt: new Date(),
      ...overrides,
    };
  }

  beforeEach(() => {
    classifier = new ApprovalClassifier();
    queue = new UpdateQueue(classifier);
  });

  describe('enqueue', () => {
    it('should enqueue an update', () => {
      const update = createUpdate({ id: 'update-1' });

      const queued = queue.enqueue(update);

      expect(queued.update.id).toBe('update-1');
      expect(queued.classification).toBeDefined();
      expect(queued.queuedAt).toBeInstanceOf(Date);
    });

    it('should auto-approve eligible updates', () => {
      const update = createUpdate({
        type: 'exception_note',
        confidence: 0.8,
        payload: {
          type: 'exception_note',
          note: 'Test',
          relatedPrinciples: [],
          occurrence: 'single',
        },
      });

      const queued = queue.enqueue(update);

      expect(queued.update.status).toBe('approved');
      expect(queued.classification.autoApprove).toBe(true);
    });

    it('should keep pending status for manual-approval updates', () => {
      const update = createUpdate({
        type: 'new_principle',
        payload: {
          type: 'new_principle',
          principle: {
            name: 'Test',
            content: 'Test',
            domains: [],
            suggestedWeight: 5,
            source: 'learned',
          },
          evidenceDecisions: [],
        },
      });

      const queued = queue.enqueue(update);

      expect(queued.update.status).toBe('pending');
      expect(queued.classification.autoApprove).toBe(false);
    });
  });

  describe('getPendingForApproval', () => {
    it('should return only pending updates for user', () => {
      const update1 = createUpdate({ id: 'u1', userId: 'user-1', type: 'new_principle', payload: {
        type: 'new_principle',
        principle: { name: 'T', content: 'T', domains: [], suggestedWeight: 5, source: 'learned' },
        evidenceDecisions: [],
      }});
      const update2 = createUpdate({ id: 'u2', userId: 'user-1' }); // auto-approved
      const update3 = createUpdate({ id: 'u3', userId: 'user-2', type: 'new_principle', payload: {
        type: 'new_principle',
        principle: { name: 'T', content: 'T', domains: [], suggestedWeight: 5, source: 'learned' },
        evidenceDecisions: [],
      }});

      queue.enqueue(update1);
      queue.enqueue(update2);
      queue.enqueue(update3);

      const pending = queue.getPendingForApproval('user-1');

      expect(pending).toHaveLength(1);
      expect(pending[0].update.id).toBe('u1');
    });
  });

  describe('getAutoApproved', () => {
    it('should return only auto-approved updates', () => {
      const update1 = createUpdate({ id: 'u1' }); // auto-approved
      const update2 = createUpdate({ id: 'u2', type: 'new_principle', payload: {
        type: 'new_principle',
        principle: { name: 'T', content: 'T', domains: [], suggestedWeight: 5, source: 'learned' },
        evidenceDecisions: [],
      }}); // manual

      queue.enqueue(update1);
      queue.enqueue(update2);

      const autoApproved = queue.getAutoApproved('user-1');

      expect(autoApproved).toHaveLength(1);
      expect(autoApproved[0].update.id).toBe('u1');
    });
  });

  describe('getApproved', () => {
    it('should return both auto and manually approved updates', () => {
      const update1 = createUpdate({ id: 'u1' }); // auto-approved
      const update2 = createUpdate({ id: 'u2', type: 'new_principle', payload: {
        type: 'new_principle',
        principle: { name: 'T', content: 'T', domains: [], suggestedWeight: 5, source: 'learned' },
        evidenceDecisions: [],
      }}); // needs manual

      queue.enqueue(update1);
      queue.enqueue(update2);
      queue.approve('u2');

      const approved = queue.getApproved('user-1');

      expect(approved).toHaveLength(2);
    });
  });

  describe('approve', () => {
    it('should approve a pending update', () => {
      const update = createUpdate({ id: 'u1', type: 'new_principle', payload: {
        type: 'new_principle',
        principle: { name: 'T', content: 'T', domains: [], suggestedWeight: 5, source: 'learned' },
        evidenceDecisions: [],
      }});
      queue.enqueue(update);

      const result = queue.approve('u1');

      expect(result.success).toBe(true);
      expect(result.update?.status).toBe('approved');
    });

    it('should fail for non-existent update', () => {
      const result = queue.approve('non-existent');

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('should fail for already approved update', () => {
      const update = createUpdate({ id: 'u1' }); // auto-approved
      queue.enqueue(update);

      const result = queue.approve('u1');

      expect(result.success).toBe(false);
      expect(result.error).toContain('not pending');
    });
  });

  describe('reject', () => {
    it('should reject a pending update', () => {
      const update = createUpdate({ id: 'u1', type: 'new_principle', payload: {
        type: 'new_principle',
        principle: { name: 'T', content: 'T', domains: [], suggestedWeight: 5, source: 'learned' },
        evidenceDecisions: [],
      }});
      queue.enqueue(update);

      const result = queue.reject('u1', 'Not appropriate');

      expect(result.success).toBe(true);
      expect(result.update?.status).toBe('rejected');
      expect(result.update?.reasoning).toContain('Not appropriate');
    });

    it('should move rejected update to history', () => {
      const update = createUpdate({ id: 'u1', type: 'new_principle', payload: {
        type: 'new_principle',
        principle: { name: 'T', content: 'T', domains: [], suggestedWeight: 5, source: 'learned' },
        evidenceDecisions: [],
      }});
      queue.enqueue(update);
      queue.reject('u1', 'Reason');

      const pending = queue.getPendingForApproval('user-1');
      const history = queue.getHistory('user-1');

      expect(pending).toHaveLength(0);
      expect(history).toHaveLength(1);
      expect(history[0].update.status).toBe('rejected');
    });
  });

  describe('markApplied', () => {
    it('should mark approved update as applied', () => {
      const update = createUpdate({ id: 'u1' }); // auto-approved
      queue.enqueue(update);

      const result = queue.markApplied('u1');

      expect(result.success).toBe(true);
      expect(result.update?.status).toBe('applied');
    });

    it('should move applied update to history', () => {
      const update = createUpdate({ id: 'u1' });
      queue.enqueue(update);
      queue.markApplied('u1');

      const approved = queue.getApproved('user-1');
      const history = queue.getHistory('user-1', ['applied']);

      expect(approved).toHaveLength(0);
      expect(history).toHaveLength(1);
    });

    it('should fail for pending update', () => {
      const update = createUpdate({ id: 'u1', type: 'new_principle', payload: {
        type: 'new_principle',
        principle: { name: 'T', content: 'T', domains: [], suggestedWeight: 5, source: 'learned' },
        evidenceDecisions: [],
      }});
      queue.enqueue(update);

      const result = queue.markApplied('u1');

      expect(result.success).toBe(false);
      expect(result.error).toContain('must be approved');
    });
  });

  describe('getById', () => {
    it('should find update in pending', () => {
      const update = createUpdate({ id: 'u1' });
      queue.enqueue(update);

      const found = queue.getById('u1');

      expect(found).not.toBeNull();
      expect(found?.update.id).toBe('u1');
    });

    it('should find update in history', () => {
      const update = createUpdate({ id: 'u1' });
      queue.enqueue(update);
      queue.markApplied('u1');

      const found = queue.getById('u1');

      expect(found).not.toBeNull();
      expect(found?.update.status).toBe('applied');
    });

    it('should return null for non-existent update', () => {
      const found = queue.getById('non-existent');

      expect(found).toBeNull();
    });
  });

  describe('getHistory', () => {
    it('should filter by status', () => {
      const update1 = createUpdate({ id: 'u1' });
      const update2 = createUpdate({ id: 'u2', type: 'new_principle', payload: {
        type: 'new_principle',
        principle: { name: 'T', content: 'T', domains: [], suggestedWeight: 5, source: 'learned' },
        evidenceDecisions: [],
      }});

      queue.enqueue(update1);
      queue.enqueue(update2);
      queue.markApplied('u1');
      queue.reject('u2', 'Reason');

      const appliedOnly = queue.getHistory('user-1', ['applied']);
      const rejectedOnly = queue.getHistory('user-1', ['rejected']);

      expect(appliedOnly).toHaveLength(1);
      expect(rejectedOnly).toHaveLength(1);
    });
  });

  describe('getStats', () => {
    it('should return correct statistics', () => {
      const update1 = createUpdate({ id: 'u1' }); // auto-approved
      const update2 = createUpdate({ id: 'u2', type: 'new_principle', payload: {
        type: 'new_principle',
        principle: { name: 'T', content: 'T', domains: [], suggestedWeight: 5, source: 'learned' },
        evidenceDecisions: [],
      }}); // pending
      const update3 = createUpdate({ id: 'u3' }); // will be applied
      const update4 = createUpdate({ id: 'u4', type: 'new_principle', payload: {
        type: 'new_principle',
        principle: { name: 'T', content: 'T', domains: [], suggestedWeight: 5, source: 'learned' },
        evidenceDecisions: [],
      }}); // will be rejected

      queue.enqueue(update1);
      queue.enqueue(update2);
      queue.enqueue(update3);
      queue.enqueue(update4);
      queue.markApplied('u3');
      queue.reject('u4', 'Reason');

      const stats = queue.getStats('user-1');

      expect(stats.pending).toBe(1);
      expect(stats.approved).toBe(1);
      expect(stats.autoApproved).toBe(1);
      expect(stats.applied).toBe(1);
      expect(stats.rejected).toBe(1);
    });
  });

  describe('clear', () => {
    it('should clear all data', () => {
      const update = createUpdate({ id: 'u1' });
      queue.enqueue(update);
      queue.markApplied('u1');

      queue.clear();

      expect(queue.getById('u1')).toBeNull();
      expect(queue.getStats('user-1').applied).toBe(0);
    });
  });
});

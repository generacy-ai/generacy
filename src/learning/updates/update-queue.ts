/**
 * Update Queue
 *
 * Queues knowledge updates for approval and tracks their status.
 * Emits approved updates to the knowledge store.
 */

import type { KnowledgeUpdate, UpdateStatus } from '../types.js';
import type { ApprovalClassifier, ClassificationResult } from './approval-classifier.js';

/**
 * A queued update with classification information
 */
export interface QueuedUpdate {
  /** The knowledge update */
  update: KnowledgeUpdate;

  /** Classification result */
  classification: ClassificationResult;

  /** When the update was queued */
  queuedAt: Date;
}

/**
 * Result of approving or rejecting an update
 */
export interface UpdateActionResult {
  success: boolean;
  update?: KnowledgeUpdate;
  error?: string;
}

/**
 * Service for managing the update approval queue.
 */
export class UpdateQueue {
  private readonly pending: Map<string, QueuedUpdate> = new Map();
  private readonly history: Map<string, QueuedUpdate> = new Map();

  constructor(private readonly classifier: ApprovalClassifier) {}

  /**
   * Enqueue an update for processing.
   * Auto-approved updates are marked approved immediately.
   */
  enqueue(update: KnowledgeUpdate): QueuedUpdate {
    const classification = this.classifier.classify(update);

    const queuedUpdate: QueuedUpdate = {
      update: { ...update },
      classification,
      queuedAt: new Date(),
    };

    // If auto-approve, mark as approved
    if (classification.autoApprove) {
      queuedUpdate.update.status = 'approved';
      queuedUpdate.update.statusUpdatedAt = new Date();
    }

    this.pending.set(update.id, queuedUpdate);
    return queuedUpdate;
  }

  /**
   * Get all pending updates that require manual approval.
   */
  getPendingForApproval(userId: string): QueuedUpdate[] {
    return Array.from(this.pending.values())
      .filter(qu => qu.update.userId === userId && qu.update.status === 'pending')
      .sort((a, b) => a.queuedAt.getTime() - b.queuedAt.getTime());
  }

  /**
   * Get all auto-approved updates ready for application.
   */
  getAutoApproved(userId: string): QueuedUpdate[] {
    return Array.from(this.pending.values())
      .filter(qu =>
        qu.update.userId === userId &&
        qu.update.status === 'approved' &&
        qu.classification.autoApprove
      )
      .sort((a, b) => a.queuedAt.getTime() - b.queuedAt.getTime());
  }

  /**
   * Get all approved updates (auto and manual) ready for application.
   */
  getApproved(userId: string): QueuedUpdate[] {
    return Array.from(this.pending.values())
      .filter(qu => qu.update.userId === userId && qu.update.status === 'approved')
      .sort((a, b) => a.queuedAt.getTime() - b.queuedAt.getTime());
  }

  /**
   * Manually approve a pending update.
   */
  approve(updateId: string): UpdateActionResult {
    const queued = this.pending.get(updateId);
    if (!queued) {
      return { success: false, error: `Update not found: ${updateId}` };
    }

    if (queued.update.status !== 'pending') {
      return { success: false, error: `Update is not pending: ${queued.update.status}` };
    }

    queued.update.status = 'approved';
    queued.update.statusUpdatedAt = new Date();

    return { success: true, update: queued.update };
  }

  /**
   * Reject a pending update.
   */
  reject(updateId: string, reason: string): UpdateActionResult {
    const queued = this.pending.get(updateId);
    if (!queued) {
      return { success: false, error: `Update not found: ${updateId}` };
    }

    if (queued.update.status !== 'pending') {
      return { success: false, error: `Update is not pending: ${queued.update.status}` };
    }

    queued.update.status = 'rejected';
    queued.update.statusUpdatedAt = new Date();
    queued.update.reasoning = `${queued.update.reasoning}\n\nRejected: ${reason}`;

    // Move to history
    this.history.set(updateId, queued);
    this.pending.delete(updateId);

    return { success: true, update: queued.update };
  }

  /**
   * Mark an update as applied to the knowledge store.
   */
  markApplied(updateId: string): UpdateActionResult {
    const queued = this.pending.get(updateId);
    if (!queued) {
      return { success: false, error: `Update not found: ${updateId}` };
    }

    if (queued.update.status !== 'approved') {
      return { success: false, error: `Update must be approved before applied: ${queued.update.status}` };
    }

    queued.update.status = 'applied';
    queued.update.statusUpdatedAt = new Date();

    // Move to history
    this.history.set(updateId, queued);
    this.pending.delete(updateId);

    return { success: true, update: queued.update };
  }

  /**
   * Get update by ID (from pending or history).
   */
  getById(updateId: string): QueuedUpdate | null {
    return this.pending.get(updateId) ?? this.history.get(updateId) ?? null;
  }

  /**
   * Get update history for a user.
   */
  getHistory(userId: string, statusFilter?: UpdateStatus[]): QueuedUpdate[] {
    return Array.from(this.history.values())
      .filter(qu => {
        if (qu.update.userId !== userId) return false;
        if (statusFilter && !statusFilter.includes(qu.update.status)) return false;
        return true;
      })
      .sort((a, b) => b.update.statusUpdatedAt.getTime() - a.update.statusUpdatedAt.getTime());
  }

  /**
   * Get summary statistics for a user's queue.
   */
  getStats(userId: string): QueueStats {
    let pending = 0;
    let approved = 0;
    let autoApproved = 0;

    for (const queued of this.pending.values()) {
      if (queued.update.userId !== userId) continue;

      if (queued.update.status === 'pending') {
        pending++;
      } else if (queued.update.status === 'approved') {
        approved++;
        if (queued.classification.autoApprove) {
          autoApproved++;
        }
      }
    }

    let rejected = 0;
    let applied = 0;

    for (const queued of this.history.values()) {
      if (queued.update.userId !== userId) continue;

      if (queued.update.status === 'rejected') rejected++;
      if (queued.update.status === 'applied') applied++;
    }

    return { pending, approved, autoApproved, rejected, applied };
  }

  /**
   * Clear all pending updates (for testing).
   */
  clear(): void {
    this.pending.clear();
    this.history.clear();
  }
}

/**
 * Queue statistics
 */
export interface QueueStats {
  /** Updates awaiting manual approval */
  pending: number;

  /** Approved updates ready to apply */
  approved: number;

  /** Auto-approved updates (subset of approved) */
  autoApproved: number;

  /** Rejected updates */
  rejected: number;

  /** Applied updates */
  applied: number;
}

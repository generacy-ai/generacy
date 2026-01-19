/**
 * Approval Classifier
 *
 * Classifies knowledge updates as auto-approve or manual-approve
 * based on impact and configurable thresholds.
 */

import type { KnowledgeUpdate, KnowledgeUpdateType } from '../types.js';

/**
 * Configuration for approval classification thresholds
 */
export interface ApprovalThresholds {
  /** Maximum weight change delta for auto-approval (default: 0.5) */
  weightChangeDelta: number;

  /** Minimum confidence for auto-approval (default: 0.7) */
  minConfidence: number;

  /** Update types that always require manual approval */
  alwaysManual: KnowledgeUpdateType[];
}

const DEFAULT_THRESHOLDS: ApprovalThresholds = {
  weightChangeDelta: 0.5,
  minConfidence: 0.7,
  alwaysManual: ['new_principle'],
};

/**
 * Classification result
 */
export interface ClassificationResult {
  /** Whether the update should be auto-approved */
  autoApprove: boolean;

  /** Reason for the classification */
  reason: string;

  /** Impact level of the update */
  impactLevel: 'low' | 'medium' | 'high';
}

/**
 * Service for classifying updates as auto-approve or manual-approve.
 */
export class ApprovalClassifier {
  private readonly thresholds: ApprovalThresholds;

  constructor(thresholds: Partial<ApprovalThresholds> = {}) {
    this.thresholds = {
      ...DEFAULT_THRESHOLDS,
      ...thresholds,
      alwaysManual: thresholds.alwaysManual ?? DEFAULT_THRESHOLDS.alwaysManual,
    };
  }

  /**
   * Classify an update to determine if it should be auto-approved.
   */
  classify(update: KnowledgeUpdate): ClassificationResult {
    // Check if type always requires manual approval
    if (this.thresholds.alwaysManual.includes(update.type)) {
      return {
        autoApprove: false,
        reason: `Update type '${update.type}' always requires manual approval`,
        impactLevel: 'high',
      };
    }

    // Check confidence threshold
    if (update.confidence < this.thresholds.minConfidence) {
      return {
        autoApprove: false,
        reason: `Confidence ${update.confidence.toFixed(2)} below threshold ${this.thresholds.minConfidence}`,
        impactLevel: 'medium',
      };
    }

    // Check specific update type rules
    const typeResult = this.classifyByType(update);
    if (typeResult !== null) {
      return typeResult;
    }

    // Default to auto-approve for high confidence updates
    return {
      autoApprove: true,
      reason: 'Update meets all auto-approval criteria',
      impactLevel: 'low',
    };
  }

  /**
   * Classify based on update type-specific rules.
   */
  private classifyByType(update: KnowledgeUpdate): ClassificationResult | null {
    switch (update.type) {
      case 'principle_reinforcement':
        return this.classifyPrincipleReinforcement(update);

      case 'principle_weakening':
        return this.classifyPrincipleWeakening(update);

      case 'principle_refinement':
        return this.classifyPrincipleRefinement(update);

      case 'context_update':
        return this.classifyContextUpdate(update);

      case 'priority_update':
        return this.classifyPriorityUpdate(update);

      case 'exception_note':
        // Exception notes are always auto-approved (they don't change principles)
        return {
          autoApprove: true,
          reason: 'Exception notes do not modify principles',
          impactLevel: 'low',
        };

      default:
        return null;
    }
  }

  /**
   * Classify principle reinforcement updates.
   */
  private classifyPrincipleReinforcement(update: KnowledgeUpdate): ClassificationResult | null {
    if (update.payload.type !== 'principle_reinforcement') {
      return null;
    }

    const delta = Math.abs(update.payload.delta);

    if (delta < this.thresholds.weightChangeDelta) {
      return {
        autoApprove: true,
        reason: `Weight change delta ${delta.toFixed(2)} below threshold ${this.thresholds.weightChangeDelta}`,
        impactLevel: 'low',
      };
    }

    return {
      autoApprove: false,
      reason: `Weight change delta ${delta.toFixed(2)} exceeds threshold ${this.thresholds.weightChangeDelta}`,
      impactLevel: 'medium',
    };
  }

  /**
   * Classify principle weakening updates.
   */
  private classifyPrincipleWeakening(update: KnowledgeUpdate): ClassificationResult | null {
    if (update.payload.type !== 'principle_weakening') {
      return null;
    }

    const delta = Math.abs(update.payload.delta);

    // Weakening is more impactful, so be more conservative
    if (delta < this.thresholds.weightChangeDelta * 0.5) {
      return {
        autoApprove: true,
        reason: `Weakening delta ${delta.toFixed(2)} is small`,
        impactLevel: 'low',
      };
    }

    // Check contradiction count - multiple contradictions increase confidence
    if (update.payload.contradictionCount >= 3) {
      return {
        autoApprove: true,
        reason: `Multiple contradictions (${update.payload.contradictionCount}) support weakening`,
        impactLevel: 'medium',
      };
    }

    return {
      autoApprove: false,
      reason: `Principle weakening requires approval for delta ${delta.toFixed(2)}`,
      impactLevel: 'medium',
    };
  }

  /**
   * Classify principle refinement updates.
   */
  private classifyPrincipleRefinement(update: KnowledgeUpdate): ClassificationResult | null {
    if (update.payload.type !== 'principle_refinement') {
      return null;
    }

    // Adding exceptions is less impactful than other refinements
    if (update.payload.refinementType === 'add_exception') {
      return {
        autoApprove: true,
        reason: 'Adding exception is low impact',
        impactLevel: 'low',
      };
    }

    // Narrowing or broadening applicability requires more scrutiny
    return {
      autoApprove: false,
      reason: `Refinement type '${update.payload.refinementType}' requires manual approval`,
      impactLevel: 'medium',
    };
  }

  /**
   * Classify context updates.
   */
  private classifyContextUpdate(update: KnowledgeUpdate): ClassificationResult | null {
    if (update.payload.type !== 'context_update') {
      return null;
    }

    // Context updates are generally low impact - they inform future decisions
    // but don't change principles
    return {
      autoApprove: true,
      reason: 'Context updates inform but do not modify principles',
      impactLevel: 'low',
    };
  }

  /**
   * Classify priority updates.
   */
  private classifyPriorityUpdate(update: KnowledgeUpdate): ClassificationResult | null {
    if (update.payload.type !== 'priority_update') {
      return null;
    }

    // Priority updates come from explicit user statements - high confidence
    // But they do affect future recommendations significantly
    return {
      autoApprove: false,
      reason: 'Priority updates affect recommendation behavior',
      impactLevel: 'medium',
    };
  }

  /**
   * Get current thresholds configuration.
   */
  getThresholds(): Readonly<ApprovalThresholds> {
    return { ...this.thresholds };
  }
}

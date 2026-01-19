/**
 * Outcome Evaluator
 *
 * Evaluates whether a decision choice was correct based on the actual outcome.
 */

import type {
  ThreeLayerDecision,
  DecisionOutcome,
  OutcomeAssessment,
  CounterfactualResult,
  AssessmentMethod,
} from './types.js';

/**
 * Interface for evaluating decision outcomes
 */
export interface OutcomeEvaluator {
  /**
   * Evaluate if the chosen option worked based on the outcome
   */
  evaluateOutcome(decision: ThreeLayerDecision, outcome: DecisionOutcome): OutcomeAssessment;

  /**
   * Evaluate what would have happened with a different choice
   */
  evaluateCounterfactual(
    decision: ThreeLayerDecision,
    actualChoice: string,
    alternativeChoice: string,
    outcome: DecisionOutcome
  ): CounterfactualResult;
}

/**
 * Default implementation of OutcomeEvaluator
 */
export class DefaultOutcomeEvaluator implements OutcomeEvaluator {
  /**
   * Threshold for partial success to be considered "worked"
   */
  private readonly partialSuccessThreshold = 0.5;

  /**
   * Evaluate if the chosen option worked based on the outcome
   */
  evaluateOutcome(decision: ThreeLayerDecision, outcome: DecisionOutcome): OutcomeAssessment {
    const result = outcome.result;

    switch (result.status) {
      case 'success':
        return this.evaluateSuccess(outcome);

      case 'failure':
        return this.evaluateFailure(outcome);

      case 'partial':
        return this.evaluatePartial(outcome, result.successRate);

      case 'unknown':
        return this.evaluateUnknown(outcome, result.reason);
    }
  }

  /**
   * Evaluate counterfactual - what would have happened with alternative choice
   */
  evaluateCounterfactual(
    decision: ThreeLayerDecision,
    actualChoice: string,
    alternativeChoice: string,
    outcome: DecisionOutcome
  ): CounterfactualResult {
    // If alternative equals actual, we know the outcome
    if (alternativeChoice === actualChoice) {
      const assessment = this.evaluateOutcome(decision, outcome);
      return {
        alternativeOutcome: outcome.result.status === 'success' ? 'Same successful outcome' : 'Same outcome',
        wouldHaveWorked: assessment.worked,
        confidence: assessment.worked !== null ? 0.95 : 0,
        reasoning: 'Alternative choice equals actual choice, so outcome would be the same.',
      };
    }

    // For different choices, we need to estimate
    return this.estimateCounterfactual(decision, actualChoice, alternativeChoice, outcome);
  }

  /**
   * Evaluate a success outcome
   */
  private evaluateSuccess(outcome: DecisionOutcome): OutcomeAssessment {
    const evidenceCount = outcome.evidence.length;
    // More evidence = higher confidence
    const confidence = Math.min(0.8 + evidenceCount * 0.05, 1.0);

    return {
      worked: true,
      confidence,
      evidence: outcome.evidence,
      method: 'direct_observation',
    };
  }

  /**
   * Evaluate a failure outcome
   */
  private evaluateFailure(outcome: DecisionOutcome): OutcomeAssessment {
    const result = outcome.result;
    if (result.status !== 'failure') {
      throw new Error('Expected failure outcome');
    }

    // Higher severity = higher confidence that it failed
    const severityConfidence: Record<'minor' | 'major' | 'critical', number> = {
      minor: 0.8,
      major: 0.9,
      critical: 0.95,
    };

    return {
      worked: false,
      confidence: severityConfidence[result.severity],
      evidence: outcome.evidence,
      method: 'direct_observation',
    };
  }

  /**
   * Evaluate a partial outcome
   */
  private evaluatePartial(outcome: DecisionOutcome, successRate: number): OutcomeAssessment {
    const worked = successRate >= this.partialSuccessThreshold;

    // Confidence is lower for partial outcomes, especially near the threshold
    const distanceFromThreshold = Math.abs(successRate - this.partialSuccessThreshold);
    const confidence = 0.5 + distanceFromThreshold * 0.5;

    return {
      worked,
      confidence: Math.min(confidence, 0.85), // Cap at 0.85 for partial
      evidence: outcome.evidence,
      method: 'direct_observation',
    };
  }

  /**
   * Evaluate an unknown outcome
   */
  private evaluateUnknown(outcome: DecisionOutcome, reason: string): OutcomeAssessment {
    return {
      worked: null,
      confidence: 0,
      evidence: [reason, ...outcome.evidence],
      method: 'direct_observation',
    };
  }

  /**
   * Estimate what would have happened with an alternative choice
   */
  private estimateCounterfactual(
    decision: ThreeLayerDecision,
    actualChoice: string,
    alternativeChoice: string,
    outcome: DecisionOutcome
  ): CounterfactualResult {
    const actualAssessment = this.evaluateOutcome(decision, outcome);

    // Handle unknown outcomes
    if (actualAssessment.worked === null) {
      return {
        alternativeOutcome: 'Unknown - cannot determine counterfactual',
        wouldHaveWorked: null,
        confidence: 0,
        reasoning: 'Cannot estimate counterfactual when actual outcome is unknown.',
      };
    }

    // Basic heuristic: if actual worked, alternative likely wouldn't and vice versa
    // This is a simplified model - real implementation would use more sophisticated analysis
    const wouldHaveWorked = !actualAssessment.worked;

    // Counterfactual confidence is always lower than direct observation
    // It's speculation based on the opposite outcome
    const baseConfidence = actualAssessment.confidence * 0.6;

    const alternativeOutcome = wouldHaveWorked
      ? `Alternative choice (${alternativeChoice}) likely would have succeeded`
      : `Alternative choice (${alternativeChoice}) likely would have failed`;

    const reasoning = actualAssessment.worked
      ? `Actual choice (${actualChoice}) succeeded. Alternative would likely have different outcome based on counterfactual analysis.`
      : `Actual choice (${actualChoice}) failed. Alternative might have worked based on counterfactual analysis.`;

    return {
      alternativeOutcome,
      wouldHaveWorked,
      confidence: baseConfidence,
      reasoning,
    };
  }
}

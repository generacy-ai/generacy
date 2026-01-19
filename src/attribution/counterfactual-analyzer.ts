/**
 * Counterfactual Analyzer
 *
 * Analyzes "what if" scenarios - estimating what would have happened
 * with different choices.
 */

import type {
  ThreeLayerDecision,
  DecisionOutcome,
  CounterfactualResult,
} from './types.js';
import type { OutcomeEvaluator } from './outcome-evaluator.js';

/**
 * Interface for counterfactual analysis
 */
export interface CounterfactualAnalyzer {
  /**
   * Analyze what baseline would have produced
   */
  analyzeBaseline(decision: ThreeLayerDecision, outcome: DecisionOutcome): CounterfactualResult;

  /**
   * Analyze what protégé would have produced
   */
  analyzeProtege(decision: ThreeLayerDecision, outcome: DecisionOutcome): CounterfactualResult;
}

/**
 * Default implementation of CounterfactualAnalyzer
 */
export class DefaultCounterfactualAnalyzer implements CounterfactualAnalyzer {
  constructor(private readonly outcomeEvaluator: OutcomeEvaluator) {}

  /**
   * Analyze what baseline would have produced
   */
  analyzeBaseline(decision: ThreeLayerDecision, outcome: DecisionOutcome): CounterfactualResult {
    const humanChoice = decision.humanChoice.optionId;
    const baselineChoice = decision.baseline.optionId;

    return this.outcomeEvaluator.evaluateCounterfactual(
      decision,
      humanChoice,
      baselineChoice,
      outcome
    );
  }

  /**
   * Analyze what protégé would have produced
   */
  analyzeProtege(decision: ThreeLayerDecision, outcome: DecisionOutcome): CounterfactualResult {
    const humanChoice = decision.humanChoice.optionId;
    const protegeChoice = decision.protege.optionId;

    return this.outcomeEvaluator.evaluateCounterfactual(
      decision,
      humanChoice,
      protegeChoice,
      outcome
    );
  }
}

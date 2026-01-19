/**
 * Attribution Calculator
 *
 * The main attribution calculation engine - determines which layer
 * (baseline, protégé, or human) added value in each decision.
 */

import type {
  ThreeLayerDecision,
  DecisionOutcome,
  Attribution,
  AttributionCategory,
  ValueSource,
  CounterfactualAnalysis,
} from './types.js';
import type { OutcomeEvaluator } from './outcome-evaluator.js';
import type { CounterfactualAnalyzer } from './counterfactual-analyzer.js';

/**
 * Interface for attribution calculation
 */
export interface AttributionCalculator {
  /**
   * Calculate attribution for a decision after outcome is known
   */
  calculateAttribution(decision: ThreeLayerDecision, outcome: DecisionOutcome): Attribution;
}

/**
 * Default implementation of AttributionCalculator
 */
export class DefaultAttributionCalculator implements AttributionCalculator {
  constructor(
    private readonly outcomeEvaluator: OutcomeEvaluator,
    private readonly counterfactualAnalyzer: CounterfactualAnalyzer
  ) {}

  /**
   * Calculate attribution for a decision after outcome is known
   */
  calculateAttribution(decision: ThreeLayerDecision, outcome: DecisionOutcome): Attribution {
    // First evaluate the actual outcome
    const humanAssessment = this.outcomeEvaluator.evaluateOutcome(decision, outcome);

    // Handle unknown outcomes
    if (humanAssessment.worked === null) {
      return this.createUnknownAttribution(decision);
    }

    // Determine which layers were correct
    const layerCorrectness = this.determineLayerCorrectness(decision, humanAssessment.worked);

    // Determine the attribution category
    const category = this.determineCategory(decision, layerCorrectness);

    // Determine the value source
    const valueSource = this.determineValueSource(category);

    // Calculate confidence based on outcome confidence and layer analysis
    const confidence = this.calculateConfidence(humanAssessment.confidence, category);

    // Perform counterfactual analysis when human chose differently
    const counterfactual = this.performCounterfactualAnalysis(decision, outcome);

    return {
      decisionId: decision.id,
      baselineCorrect: layerCorrectness.baseline,
      protegeCorrect: layerCorrectness.protege,
      humanCorrect: layerCorrectness.human,
      whoWasRight: category,
      valueSource,
      confidence,
      counterfactual,
      calculatedAt: new Date(),
    };
  }

  /**
   * Create attribution for unknown outcomes
   */
  private createUnknownAttribution(decision: ThreeLayerDecision): Attribution {
    return {
      decisionId: decision.id,
      baselineCorrect: null,
      protegeCorrect: null,
      humanCorrect: null,
      whoWasRight: 'unknown',
      valueSource: 'none',
      confidence: 0,
      calculatedAt: new Date(),
    };
  }

  /**
   * Determine which layers would have been correct
   */
  private determineLayerCorrectness(
    decision: ThreeLayerDecision,
    humanWorked: boolean
  ): { baseline: boolean; protege: boolean; human: boolean } {
    const baselineOption = decision.baseline.optionId;
    const protegeOption = decision.protege.optionId;
    const humanOption = decision.humanChoice.optionId;

    // Human's choice outcome is known
    const humanCorrect = humanWorked;

    // If baseline chose the same as human, baseline would also have been correct/incorrect
    const baselineCorrect = baselineOption === humanOption ? humanWorked : !humanWorked;

    // If protégé chose the same as human, protégé would also have been correct/incorrect
    const protegeCorrect = protegeOption === humanOption ? humanWorked : !humanWorked;

    return {
      baseline: baselineCorrect,
      protege: protegeCorrect,
      human: humanCorrect,
    };
  }

  /**
   * Determine the attribution category based on who was right
   */
  private determineCategory(
    decision: ThreeLayerDecision,
    correctness: { baseline: boolean; protege: boolean; human: boolean }
  ): AttributionCategory {
    const { baseline: B, protege: P, human: H } = correctness;
    const baselineOption = decision.baseline.optionId;
    const protegeOption = decision.protege.optionId;
    const humanOption = decision.humanChoice.optionId;

    // Everyone wrong
    if (!B && !P && !H) {
      return 'all_wrong';
    }

    // Everyone aligned and correct
    if (baselineOption === protegeOption && protegeOption === humanOption && H) {
      return 'all_aligned';
    }

    // Human was wrong (protégé was right)
    if (P && !H) {
      return 'human_wrong';
    }

    // Baseline only was right
    if (B && !P && !H) {
      return 'baseline_only';
    }

    // Protégé wrong (baseline right, protégé diverged incorrectly)
    if (B && !P) {
      return 'protege_wrong';
    }

    // Human unique value: B = P ≠ H and human correct
    if (baselineOption === protegeOption && humanOption !== protegeOption && H) {
      return 'human_unique';
    }

    // Protégé wisdom: B ≠ P = H and both correct
    if (baselineOption !== protegeOption && protegeOption === humanOption && H) {
      return 'protege_wisdom';
    }

    // Collaboration: B ≠ P ≠ H and human correct
    if (baselineOption !== protegeOption && protegeOption !== humanOption && H) {
      return 'collaboration';
    }

    // Fallback - should not reach here
    return 'unknown';
  }

  /**
   * Determine the value source based on attribution category
   */
  private determineValueSource(category: AttributionCategory): ValueSource {
    switch (category) {
      case 'all_aligned':
      case 'baseline_only':
      case 'protege_wrong':
      case 'human_wrong':
        return 'system';

      case 'protege_wisdom':
        return 'protege_wisdom';

      case 'human_unique':
        return 'human_judgment';

      case 'collaboration':
        return 'collaboration';

      case 'all_wrong':
      case 'unknown':
      default:
        return 'none';
    }
  }

  /**
   * Calculate confidence in the attribution
   */
  private calculateConfidence(outcomeConfidence: number, category: AttributionCategory): number {
    // Unknown has zero confidence
    if (category === 'unknown') {
      return 0;
    }

    // Base confidence from outcome assessment
    let confidence = outcomeConfidence;

    // Clear-cut scenarios have higher confidence
    if (category === 'all_aligned' || category === 'all_wrong') {
      confidence *= 1.0;
    } else if (category === 'human_unique' || category === 'protege_wisdom') {
      // When human/protégé added unique value, slightly lower confidence
      // because we're making assumptions about alternatives
      confidence *= 0.9;
    } else {
      // Mixed scenarios have moderate confidence
      confidence *= 0.85;
    }

    return Math.min(confidence, 1.0);
  }

  /**
   * Perform counterfactual analysis if human chose differently
   */
  private performCounterfactualAnalysis(
    decision: ThreeLayerDecision,
    outcome: DecisionOutcome
  ): CounterfactualAnalysis | undefined {
    const humanOption = decision.humanChoice.optionId;
    const baselineOption = decision.baseline.optionId;
    const protegeOption = decision.protege.optionId;

    // Only perform counterfactual if there were different choices
    if (humanOption === baselineOption && humanOption === protegeOption) {
      return undefined;
    }

    const analysis: CounterfactualAnalysis = {};

    // Analyze baseline alternative if different from human
    if (baselineOption !== humanOption) {
      analysis.baselineAlternative = this.counterfactualAnalyzer.analyzeBaseline(decision, outcome);
    }

    // Analyze protégé alternative if different from human
    if (protegeOption !== humanOption) {
      analysis.protegeAlternative = this.counterfactualAnalyzer.analyzeProtege(decision, outcome);
    }

    return analysis;
  }
}

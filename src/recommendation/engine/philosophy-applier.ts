/**
 * Philosophy Applier Service
 *
 * Applies core philosophy to determine recommendations:
 * - Value mapping to decision criteria
 * - Boundary enforcement
 * - Risk tolerance adjustment
 * - Time horizon consideration
 */

import type {
  DecisionRequest,
  Philosophy,
  AppliedPrinciple,
  ReasoningStep,
  RecommendationWarning,
  PhilosophyApplierService as IPhilosophyApplierService,
  PhilosophyApplicationResult,
} from '../types/index.js';

/**
 * Service for applying philosophy to recommendation decisions
 */
export class PhilosophyApplierService implements IPhilosophyApplierService {
  /**
   * Apply philosophy to determine the recommended option
   *
   * @param request - The decision request
   * @param philosophy - The human's philosophy
   * @param candidates - Candidate principles to consider
   * @returns The recommended option and reasoning
   */
  apply(
    request: DecisionRequest,
    philosophy: Philosophy,
    candidates: AppliedPrinciple[]
  ): PhilosophyApplicationResult {
    const reasoning: ReasoningStep[] = [];
    const warnings: RecommendationWarning[] = [];
    let boundariesConsidered = false;
    let stepNumber = 1;

    // Step 1: Evaluate boundaries
    const { validOptions, boundaryReasoning, boundaryWarnings } = this.evaluateBoundaries(
      request,
      philosophy,
      stepNumber
    );
    reasoning.push(...boundaryReasoning);
    warnings.push(...boundaryWarnings);
    stepNumber += boundaryReasoning.length;
    boundariesConsidered = philosophy.boundaries.length > 0;

    // If no valid options after boundary check
    if (validOptions.length === 0) {
      reasoning.push({
        step: stepNumber,
        logic: 'All options violate hard boundaries. No valid recommendation possible.',
        type: 'conclusion',
      });

      return {
        recommendation: '',
        reasoning,
        boundariesConsidered,
        warnings: [
          ...warnings,
          {
            type: 'boundary_close',
            message: 'All available options violate established boundaries',
            severity: 'critical',
          },
        ],
      };
    }

    // Step 2: Apply value mapping
    const optionScores = this.scoreOptionsByValues(
      request,
      philosophy,
      validOptions,
      reasoning,
      stepNumber
    );
    stepNumber = Math.max(...reasoning.map((r) => r.step)) + 1;

    // Step 3: Apply principle guidance
    const principleInfluence = this.applyPrincipleGuidance(
      candidates,
      optionScores,
      reasoning,
      stepNumber
    );
    stepNumber = Math.max(...reasoning.map((r) => r.step)) + 1;

    // Step 4: Adjust for risk tolerance
    const riskAdjusted = this.applyRiskTolerance(
      request,
      philosophy,
      principleInfluence,
      reasoning,
      stepNumber
    );
    stepNumber = Math.max(...reasoning.map((r) => r.step)) + 1;

    // Step 5: Adjust for time horizon
    const timeAdjusted = this.applyTimeHorizon(
      request,
      philosophy,
      riskAdjusted,
      reasoning,
      stepNumber
    );
    stepNumber = Math.max(...reasoning.map((r) => r.step)) + 1;

    // Step 6: Select best option
    const recommendation = this.selectBestOption(timeAdjusted);

    // Add conclusion
    reasoning.push({
      step: stepNumber,
      logic: `Based on philosophy alignment, "${recommendation}" is the recommended option.`,
      type: 'conclusion',
    });

    // Check for low confidence scenarios
    const totalScore = timeAdjusted[recommendation] || 0;
    if (totalScore < 0.5) {
      warnings.push({
        type: 'low_confidence',
        message: 'Low confidence in recommendation due to limited principle alignment',
        severity: 'warning',
      });
    }

    return {
      recommendation,
      reasoning,
      boundariesConsidered,
      warnings,
    };
  }

  /**
   * Evaluate boundaries and filter valid options
   */
  private evaluateBoundaries(
    request: DecisionRequest,
    philosophy: Philosophy,
    startStep: number
  ): {
    validOptions: string[];
    boundaryReasoning: ReasoningStep[];
    boundaryWarnings: RecommendationWarning[];
  } {
    const reasoning: ReasoningStep[] = [];
    const warnings: RecommendationWarning[] = [];
    const validOptions: string[] = [];
    let stepNumber = startStep;

    // Get all option IDs
    const allOptions = request.options.map((o) => o.id);

    if (philosophy.boundaries.length === 0) {
      return {
        validOptions: allOptions,
        boundaryReasoning: [],
        boundaryWarnings: [],
      };
    }

    reasoning.push({
      step: stepNumber++,
      logic: `Evaluating ${philosophy.boundaries.length} boundary constraint(s) against available options.`,
      type: 'philosophy_application',
    });

    for (const option of request.options) {
      let violatesBoundary = false;
      const optionDesc = `${option.name} ${option.description}`.toLowerCase();
      const optionAttrs = JSON.stringify(option.attributes).toLowerCase();

      for (const boundary of philosophy.boundaries) {
        if (!boundary.hard) continue;

        // Check if option violates this boundary
        const boundaryTerms = boundary.description.toLowerCase().split(' ');
        const violates = boundaryTerms.some(
          (term) =>
            term.length > 4 &&
            (optionDesc.includes(term) || optionAttrs.includes(term))
        );

        if (violates) {
          violatesBoundary = true;
          reasoning.push({
            step: stepNumber++,
            logic: `Option "${option.name}" violates boundary: "${boundary.description}"`,
            type: 'philosophy_application',
          });
          break;
        }
      }

      if (!violatesBoundary) {
        validOptions.push(option.id);
      }
    }

    // Check for near-boundary options
    for (const optionId of validOptions) {
      const option = request.options.find((o) => o.id === optionId);
      if (!option) continue;

      for (const boundary of philosophy.boundaries) {
        if (boundary.hard) continue; // Soft boundaries

        const optionDesc = `${option.name} ${option.description}`.toLowerCase();
        const boundaryTerms = boundary.description.toLowerCase().split(' ');
        const nearBoundary = boundaryTerms.some(
          (term) => term.length > 4 && optionDesc.includes(term)
        );

        if (nearBoundary) {
          warnings.push({
            type: 'boundary_close',
            message: `Option "${option.name}" is close to boundary: "${boundary.description}"`,
            severity: 'warning',
          });
        }
      }
    }

    return { validOptions, boundaryReasoning: reasoning, boundaryWarnings: warnings };
  }

  /**
   * Score options based on value alignment
   */
  private scoreOptionsByValues(
    request: DecisionRequest,
    philosophy: Philosophy,
    validOptions: string[],
    reasoning: ReasoningStep[],
    startStep: number
  ): Record<string, number> {
    const scores: Record<string, number> = {};
    let stepNumber = startStep;

    for (const optionId of validOptions) {
      scores[optionId] = 0;
    }

    if (philosophy.values.length === 0) {
      // Equal scores if no values defined
      for (const optionId of validOptions) {
        scores[optionId] = 0.5;
      }
      return scores;
    }

    // Normalize value importances
    const totalImportance = philosophy.values.reduce((sum, v) => sum + v.importance, 0);

    for (const value of philosophy.values) {
      const normalizedWeight = value.importance / totalImportance;

      for (const optionId of validOptions) {
        const option = request.options.find((o) => o.id === optionId);
        if (!option) continue;

        // Check value alignment
        const optionText = `${option.name} ${option.description}`.toLowerCase();
        const valueTerms = value.name.toLowerCase().split(' ');
        const alignment = valueTerms.some(
          (term) => term.length > 3 && optionText.includes(term)
        )
          ? 1.0
          : 0.3;

        const currentScore = scores[optionId] ?? 0;
        scores[optionId] = currentScore + alignment * normalizedWeight;
      }
    }

    // Add reasoning about value application
    const topValue = philosophy.values.reduce((a, b) =>
      a.importance > b.importance ? a : b
    );
    reasoning.push({
      step: stepNumber,
      logic: `Applied value-based scoring with emphasis on "${topValue.name}" (importance: ${topValue.importance}).`,
      type: 'philosophy_application',
    });

    return scores;
  }

  /**
   * Apply principle guidance to option scores
   */
  private applyPrincipleGuidance(
    candidates: AppliedPrinciple[],
    scores: Record<string, number>,
    reasoning: ReasoningStep[],
    startStep: number
  ): Record<string, number> {
    let stepNumber = startStep;
    const adjusted = { ...scores };

    if (candidates.length === 0) {
      return adjusted;
    }

    // Sort by weight to apply most important first
    const sortedCandidates = [...candidates].sort((a, b) => b.weight - a.weight);

    for (const principle of sortedCandidates) {
      const favoredOption = principle.favorsOption;
      if (favoredOption && adjusted[favoredOption] !== undefined) {
        // Boost favored option based on principle strength and weight
        const boost = (principle.strength * principle.weight) / 10;
        const currentScore = adjusted[favoredOption] ?? 0;
        adjusted[favoredOption] = Math.min(1, currentScore + boost);

        reasoning.push({
          step: stepNumber++,
          principle: {
            principleId: principle.principleId,
            principleText: principle.principleText,
          },
          logic: `Applied principle "${principle.principleText.substring(0, 50)}..." favoring option "${principle.favorsOption}"`,
          type: 'principle_application',
        });
      }
    }

    return adjusted;
  }

  /**
   * Apply risk tolerance to option scores
   */
  private applyRiskTolerance(
    request: DecisionRequest,
    philosophy: Philosophy,
    scores: Record<string, number>,
    reasoning: ReasoningStep[],
    startStep: number
  ): Record<string, number> {
    const adjusted = { ...scores };
    const riskTolerance = philosophy.riskTolerance;

    for (const option of request.options) {
      if (adjusted[option.id] === undefined) continue;

      // Determine option risk level
      const riskLevel = this.assessOptionRisk(option);

      // Adjust score based on risk tolerance alignment
      const currentScore = adjusted[option.id] ?? 0;
      if (riskTolerance < 0.4) {
        // Risk averse: penalize risky options, boost safe ones
        if (riskLevel > 0.6) {
          adjusted[option.id] = currentScore * 0.7;
        } else if (riskLevel < 0.3) {
          adjusted[option.id] = currentScore * 1.2;
        }
      } else if (riskTolerance > 0.6) {
        // Risk tolerant: slight boost to risky options if they have potential
        if (riskLevel > 0.6) {
          adjusted[option.id] = currentScore * 1.1;
        }
      }
    }

    reasoning.push({
      step: startStep,
      logic: `Applied risk tolerance adjustment (${(riskTolerance * 100).toFixed(0)}% tolerance).`,
      type: 'philosophy_application',
    });

    // Normalize scores
    const maxScore = Math.max(...Object.values(adjusted));
    if (maxScore > 0) {
      for (const key of Object.keys(adjusted)) {
        const score = adjusted[key] ?? 0;
        adjusted[key] = Math.min(1, score / maxScore);
      }
    }

    return adjusted;
  }

  /**
   * Apply time horizon preference to option scores
   */
  private applyTimeHorizon(
    request: DecisionRequest,
    philosophy: Philosophy,
    scores: Record<string, number>,
    reasoning: ReasoningStep[],
    startStep: number
  ): Record<string, number> {
    const adjusted = { ...scores };
    const horizon = philosophy.timeHorizon;

    for (const option of request.options) {
      if (adjusted[option.id] === undefined) continue;

      const optionText = `${option.name} ${option.description}`.toLowerCase();
      const attrs = option.attributes || {};

      // Detect time preference of option
      const isLongTerm =
        optionText.includes('long-term') ||
        optionText.includes('future') ||
        optionText.includes('sustainable') ||
        attrs['timeframe'] === 'long';

      const isShortTerm =
        optionText.includes('immediate') ||
        optionText.includes('quick') ||
        optionText.includes('instant') ||
        attrs['timeframe'] === 'short';

      // Adjust based on preference match
      const currentScore = adjusted[option.id] ?? 0;
      if (horizon === 'long' && isLongTerm) {
        adjusted[option.id] = currentScore * 1.2;
      } else if (horizon === 'long' && isShortTerm) {
        adjusted[option.id] = currentScore * 0.8;
      } else if (horizon === 'short' && isShortTerm) {
        adjusted[option.id] = currentScore * 1.2;
      } else if (horizon === 'short' && isLongTerm) {
        adjusted[option.id] = currentScore * 0.8;
      }
    }

    reasoning.push({
      step: startStep,
      logic: `Applied time horizon preference (${horizon}-term focus).`,
      type: 'philosophy_application',
    });

    return adjusted;
  }

  /**
   * Assess the risk level of an option
   */
  private assessOptionRisk(option: {
    name: string;
    description: string;
    attributes: Record<string, unknown>;
    reversible?: boolean;
    complexity?: number;
  }): number {
    let riskScore = 0.5; // Default moderate risk

    const text = `${option.name} ${option.description}`.toLowerCase();

    // Risk indicators
    if (
      text.includes('risk') ||
      text.includes('uncertain') ||
      text.includes('volatile')
    ) {
      riskScore += 0.2;
    }
    if (text.includes('safe') || text.includes('stable') || text.includes('proven')) {
      riskScore -= 0.2;
    }

    // Reversibility
    if (option.reversible === false) {
      riskScore += 0.15;
    } else if (option.reversible === true) {
      riskScore -= 0.15;
    }

    // Complexity
    if (option.complexity !== undefined) {
      if (option.complexity > 7) {
        riskScore += 0.1;
      } else if (option.complexity < 4) {
        riskScore -= 0.1;
      }
    }

    // Check attributes for risk level
    const attrs = option.attributes;
    if (attrs['riskLevel'] !== undefined) {
      const attrRisk = Number(attrs['riskLevel']);
      if (!isNaN(attrRisk)) {
        riskScore = (riskScore + attrRisk) / 2;
      }
    }

    return Math.max(0, Math.min(1, riskScore));
  }

  /**
   * Select the best option from scores
   */
  private selectBestOption(scores: Record<string, number>): string {
    let bestOption = '';
    let bestScore = -1;

    for (const [optionId, score] of Object.entries(scores)) {
      if (score > bestScore) {
        bestScore = score;
        bestOption = optionId;
      }
    }

    return bestOption;
  }
}

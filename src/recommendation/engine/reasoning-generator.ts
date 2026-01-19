/**
 * Reasoning Generator Service
 *
 * Generates transparent, template-based reasoning steps:
 * - Template-based reasoning without LLM dependency
 * - Principle references in human's terms
 * - Conflict resolution explanations
 * - Context influence documentation
 */

import type {
  DecisionRequest,
  AppliedPrinciple,
  ContextInfluenceRecord,
  ReasoningStep,
  PrincipleReference,
  ReasoningGeneratorService as IReasoningGeneratorService,
} from '../types/index.js';

/**
 * Extended reasoning step with additional references for internal use
 */
interface ExtendedReasoningStep extends ReasoningStep {
  principleReference?: PrincipleReference & {
    alignmentScore?: number;
  };
  contextReference?: {
    factor: string;
    description: string;
    influenceStrength: number;
  };
  conflictingPrinciples?: Array<{
    principleId: string;
    principleText: string;
  }>;
  stepNumber?: number; // Alias for step
}

/**
 * Extended decision request with additional properties
 */
interface ExtendedDecisionRequest extends DecisionRequest {
  decisionId?: string;
  description?: string;
  appliedPrinciples?: ExtendedAppliedPrinciple[];
  contextInfluences?: ExtendedContextInfluence[];
  timestamp?: Date;
}

/**
 * Extended applied principle with test-compatible properties
 */
interface ExtendedAppliedPrinciple extends AppliedPrinciple {
  alignmentScore?: number;
  applicabilityScore?: number;
  conflictsWith?: string[];
}

/**
 * Extended context influence record
 */
interface ExtendedContextInfluence extends ContextInfluenceRecord {
  description?: string;
  type?: string;
  influenceStrength?: number;
}

/**
 * Service for generating reasoning explanations
 */
export class ReasoningGeneratorService implements IReasoningGeneratorService {
  /**
   * Generate reasoning steps for a recommendation
   *
   * @param request - The decision request
   * @param appliedPrinciples - Principles that were applied
   * @param contextInfluence - Context influence records
   * @param selectedOption - The selected option ID
   * @returns Array of reasoning steps
   */
  generate(
    request: DecisionRequest,
    appliedPrinciples: AppliedPrinciple[],
    contextInfluence: ContextInfluenceRecord[],
    selectedOption: string
  ): ReasoningStep[] {
    const steps: ReasoningStep[] = [];
    let stepNumber = 1;

    // Step 1: Opening statement
    steps.push({
      step: stepNumber++,
      logic: `Evaluating decision: "${request.question}" with ${appliedPrinciples.length} applicable principle(s).`,
      type: 'philosophy_application',
    });

    // Step 2-N: Apply each principle
    for (const principle of appliedPrinciples) {
      steps.push({
        step: stepNumber++,
        principle: {
          principleId: principle.principleId,
          principleText: principle.principleText,
        },
        logic: `Applying principle "${principle.principleText.substring(0, 50)}${principle.principleText.length > 50 ? '...' : ''}" with weight ${principle.weight} and strength ${(principle.strength * 100).toFixed(0)}%.${principle.favorsOption ? ` This principle favors option "${principle.favorsOption}".` : ''}`,
        type: 'principle_application',
      });
    }

    // Context influence steps
    for (const context of contextInfluence) {
      steps.push({
        step: stepNumber++,
        logic: `Context factor "${context.factor}" is influencing the decision: ${context.effect}`,
        type: 'context_override',
      });
    }

    // Conclusion
    const selectedOptionText = selectedOption || 'No clear recommendation';
    steps.push({
      step: stepNumber,
      logic: `Based on the applied principles and context, recommending: "${selectedOptionText}".`,
      type: 'conclusion',
    });

    return steps;
  }

  /**
   * Generate reasoning steps from an extended decision request
   * This method supports the test interface
   *
   * @param request - Extended decision request with embedded principles and context
   * @returns Array of extended reasoning steps
   */
  generateReasoningSteps(request: ExtendedDecisionRequest): ExtendedReasoningStep[] {
    const steps: ExtendedReasoningStep[] = [];
    let stepNumber = 1;

    const principles = request.appliedPrinciples || [];
    const contextInfluences = request.contextInfluences || [];

    // Check for conflicts among principles
    const conflicts = this.detectConflicts(principles);

    // Step 1: Opening statement
    steps.push({
      step: stepNumber,
      stepNumber: stepNumber++,
      logic: `Evaluating decision: "${request.description || request.question}" with ${principles.length} applicable principle(s).`,
      type: 'philosophy_application',
    });

    // Principle application steps
    for (const principle of principles) {
      const step: ExtendedReasoningStep = {
        step: stepNumber,
        stepNumber: stepNumber++,
        logic: this.generatePrincipleLogic(principle),
        type: 'principle_application',
        principleReference: {
          principleId: principle.principleId,
          principleText: principle.principleText,
          alignmentScore: principle.alignmentScore ?? principle.strength,
        },
      };
      steps.push(step);
    }

    // Context override steps
    for (const context of contextInfluences) {
      const step: ExtendedReasoningStep = {
        step: stepNumber,
        stepNumber: stepNumber++,
        logic: `Context factor "${context.factor}" is influencing the decision: ${context.description || context.effect}`,
        type: 'context_override',
        contextReference: {
          factor: context.factor,
          description: context.description || context.effect,
          influenceStrength: context.influenceStrength ?? (context.magnitude === 'high' ? 0.8 : context.magnitude === 'medium' ? 0.5 : 0.3),
        },
      };
      steps.push(step);
    }

    // Conflict resolution steps
    for (const conflict of conflicts) {
      const step: ExtendedReasoningStep = {
        step: stepNumber,
        stepNumber: stepNumber++,
        logic: `Conflict detected between principles. Resolving based on weight: "${conflict.winner.principleText.substring(0, 30)}..." (weight: ${conflict.winner.weight ?? 'N/A'}) takes precedence over "${conflict.loser.principleText.substring(0, 30)}..." (weight: ${conflict.loser.weight ?? 'N/A'}).`,
        type: 'conflict_resolution',
        conflictingPrinciples: [
          { principleId: conflict.winner.principleId, principleText: conflict.winner.principleText },
          { principleId: conflict.loser.principleId, principleText: conflict.loser.principleText },
        ],
      };
      steps.push(step);
    }

    // Conclusion step
    const conclusionStep: ExtendedReasoningStep = {
      step: stepNumber,
      stepNumber: stepNumber,
      logic: 'Based on the applied principles and context, a recommendation has been determined.',
      type: 'conclusion',
    };
    steps.push(conclusionStep);

    return steps;
  }

  /**
   * Generate logic text for a principle application
   */
  private generatePrincipleLogic(principle: ExtendedAppliedPrinciple): string {
    const alignment = principle.alignmentScore ?? principle.strength ?? 0;
    const applicability = principle.applicabilityScore ?? principle.strength ?? 0;

    return `Applying principle "${principle.principleText.substring(0, 50)}${principle.principleText.length > 50 ? '...' : ''}" with alignment score ${(alignment * 100).toFixed(0)}% and applicability ${(applicability * 100).toFixed(0)}%.`;
  }

  /**
   * Detect conflicts among principles
   */
  private detectConflicts(principles: ExtendedAppliedPrinciple[]): Array<{
    winner: ExtendedAppliedPrinciple;
    loser: ExtendedAppliedPrinciple;
  }> {
    const conflicts: Array<{ winner: ExtendedAppliedPrinciple; loser: ExtendedAppliedPrinciple }> = [];

    for (const principle of principles) {
      if (principle.conflictsWith && principle.conflictsWith.length > 0) {
        for (const conflictId of principle.conflictsWith) {
          const conflictingPrinciple = principles.find((p) => p.principleId === conflictId);
          if (conflictingPrinciple) {
            // Only add conflict once (from the winner's perspective)
            const principleWeight = principle.weight ?? 0;
            const conflictWeight = conflictingPrinciple.weight ?? 0;
            const existingConflict = conflicts.find(
              (c) =>
                (c.winner.principleId === principle.principleId && c.loser.principleId === conflictId) ||
                (c.winner.principleId === conflictId && c.loser.principleId === principle.principleId)
            );

            if (!existingConflict) {
              if (principleWeight >= conflictWeight) {
                conflicts.push({ winner: principle, loser: conflictingPrinciple });
              } else {
                conflicts.push({ winner: conflictingPrinciple, loser: principle });
              }
            }
          }
        }
      }
    }

    return conflicts;
  }
}

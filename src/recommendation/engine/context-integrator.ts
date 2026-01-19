/**
 * Context Integrator Service
 *
 * Integrates temporary context factors into recommendation process:
 * - Active goal checking
 * - Constraint application
 * - Energy level / decision fatigue effects
 */

import type {
  DecisionRequest,
  UserContext,
  AppliedPrinciple,
  ContextInfluenceRecord,
  RecommendationWarning,
  ContextIntegratorService as IContextIntegratorService,
  ContextIntegrationResult,
} from '../types/index.js';

/**
 * Energy level thresholds for different effects
 */
const ENERGY_THRESHOLDS = {
  HIGH: 8, // 8-10: Normal processing
  MEDIUM: 5, // 5-7: Minor bias toward familiar
  LOW: 3, // 3-4: Significant bias toward simpler, warning added
  // 1-2: Very low, strong bias toward safe/reversible, urgent warning
} as const;

/**
 * Service for integrating user context into recommendations
 */
export class ContextIntegratorService implements IContextIntegratorService {
  /**
   * Integrate context into the recommendation process
   *
   * @param request - The decision request
   * @param context - The user's current context
   * @param principles - Principles already matched
   * @returns Adjusted principles and context influence records
   */
  integrate(
    request: DecisionRequest,
    context: UserContext,
    principles: AppliedPrinciple[]
  ): ContextIntegrationResult {
    const influence: ContextInfluenceRecord[] = [];
    const warnings: RecommendationWarning[] = [];

    // Start with copies of the principles
    let adjustedPrinciples = principles.map((p) => ({ ...p }));

    // Apply goal alignment
    const goalResult = this.applyGoalAlignment(adjustedPrinciples, context, request);
    adjustedPrinciples = goalResult.principles;
    influence.push(...goalResult.influence);

    // Apply constraint effects
    const constraintResult = this.applyConstraints(adjustedPrinciples, context, request);
    adjustedPrinciples = constraintResult.principles;
    influence.push(...constraintResult.influence);
    warnings.push(...constraintResult.warnings);

    // Apply energy level effects
    const energyResult = this.applyEnergyEffects(adjustedPrinciples, context, request);
    adjustedPrinciples = energyResult.principles;
    influence.push(...energyResult.influence);
    warnings.push(...energyResult.warnings);

    return {
      adjustedPrinciples,
      influence,
      warnings,
    };
  }

  /**
   * Apply goal alignment to principle strengths
   */
  private applyGoalAlignment(
    principles: AppliedPrinciple[],
    context: UserContext,
    request: DecisionRequest
  ): { principles: AppliedPrinciple[]; influence: ContextInfluenceRecord[] } {
    const influence: ContextInfluenceRecord[] = [];

    if (!context.activeGoals || context.activeGoals.length === 0) {
      return { principles, influence };
    }

    const adjusted = principles.map((principle) => {
      let boost = 0;

      // Check if principle aligns with any active goals
      for (const goal of context.activeGoals) {
        const goalDomains = goal.domains || [];
        const principleText = principle.principleText.toLowerCase();
        const goalDescription = goal.description.toLowerCase();

        // Check for domain overlap or text similarity
        const hasOverlap =
          goalDomains.some((d) => request.domain.includes(d)) ||
          goalDescription
            .split(' ')
            .some((word) => word.length > 4 && principleText.includes(word));

        if (hasOverlap) {
          // Higher priority goals provide bigger boosts
          const priorityBoost = goal.priority === 1 ? 0.15 : goal.priority === 2 ? 0.1 : 0.05;
          boost = Math.max(boost, priorityBoost);
        }
      }

      if (boost > 0) {
        influence.push({
          factor: 'Active goal alignment',
          effect: `Boosted principle "${principle.principleId}" by ${(boost * 100).toFixed(0)}%`,
          magnitude: boost > 0.1 ? 'high' : 'medium',
        });

        return {
          ...principle,
          strength: Math.min(1, principle.strength + boost),
        };
      }

      return principle;
    });

    return { principles: adjusted, influence };
  }

  /**
   * Apply constraint effects to principles
   */
  private applyConstraints(
    principles: AppliedPrinciple[],
    context: UserContext,
    _request: DecisionRequest
  ): {
    principles: AppliedPrinciple[];
    influence: ContextInfluenceRecord[];
    warnings: RecommendationWarning[];
  } {
    const influence: ContextInfluenceRecord[] = [];
    const warnings: RecommendationWarning[] = [];

    if (!context.constraints || context.constraints.length === 0) {
      return { principles, influence, warnings };
    }

    // Record constraint awareness
    for (const constraint of context.constraints) {
      const severity = constraint.severity || 'medium';

      influence.push({
        factor: `Constraint: ${constraint.type}`,
        effect: constraint.description,
        magnitude: severity === 'critical' ? 'high' : severity === 'high' ? 'high' : 'medium',
      });

      // Add warnings for critical constraints
      if (severity === 'critical' || severity === 'high') {
        warnings.push({
          type: 'missing_context',
          message: `Important constraint: ${constraint.description}`,
          severity: severity === 'critical' ? 'critical' : 'warning',
        });
      }
    }

    return { principles, influence, warnings };
  }

  /**
   * Apply energy level effects to recommendations
   */
  private applyEnergyEffects(
    principles: AppliedPrinciple[],
    context: UserContext,
    _request: DecisionRequest
  ): {
    principles: AppliedPrinciple[];
    influence: ContextInfluenceRecord[];
    warnings: RecommendationWarning[];
  } {
    const influence: ContextInfluenceRecord[] = [];
    const warnings: RecommendationWarning[] = [];
    const energyLevel = context.energyLevel;

    // High energy (8-10): No modifications
    if (energyLevel >= ENERGY_THRESHOLDS.HIGH) {
      return { principles, influence, warnings };
    }

    // Medium energy (5-7): Minor bias toward familiar options
    if (energyLevel >= ENERGY_THRESHOLDS.MEDIUM) {
      influence.push({
        factor: 'Energy level',
        effect: 'Moderate energy - slight preference for familiar approaches',
        magnitude: 'low',
      });

      // Slightly reduce strength of novel/complex principles
      const adjusted = principles.map((p) => {
        const isComplex =
          p.principleText.toLowerCase().includes('novel') ||
          p.principleText.toLowerCase().includes('complex') ||
          p.principleText.toLowerCase().includes('innovative');

        if (isComplex) {
          return { ...p, strength: p.strength * 0.95 };
        }
        return p;
      });

      return { principles: adjusted, influence, warnings };
    }

    // Low energy (3-4): Significant bias toward simpler options
    if (energyLevel >= ENERGY_THRESHOLDS.LOW) {
      influence.push({
        factor: 'Energy level',
        effect: 'Low energy - strong preference for simpler, safer options',
        magnitude: 'medium',
      });

      warnings.push({
        type: 'energy_warning',
        message:
          'Low energy detected. Recommendation adjusted toward simpler options. Consider revisiting when well-rested.',
        severity: 'warning',
      });

      // Reduce strength of complex principles, boost simple ones
      const adjusted = principles.map((p) => {
        const text = p.principleText.toLowerCase();
        const isComplex =
          text.includes('complex') ||
          text.includes('ambitious') ||
          text.includes('risk') ||
          text.includes('challenge');

        const isSimple =
          text.includes('simple') ||
          text.includes('safe') ||
          text.includes('proven') ||
          text.includes('familiar');

        if (isComplex) {
          return { ...p, strength: p.strength * 0.8 };
        }
        if (isSimple) {
          return { ...p, strength: Math.min(1, p.strength * 1.2) };
        }
        return p;
      });

      return { principles: adjusted, influence, warnings };
    }

    // Very low energy (1-2): Strong bias toward safe/reversible
    influence.push({
      factor: 'Energy level',
      effect: 'Very low energy - strongly favoring safe, reversible options',
      magnitude: 'high',
    });

    warnings.push({
      type: 'energy_warning',
      message:
        'URGENT: Very low energy level. Only safe, reversible options recommended. Defer important decisions if possible.',
      severity: 'critical',
    });

    // Strongly adjust for safety and reversibility
    const adjusted = principles.map((p) => {
      const text = p.principleText.toLowerCase();
      const isRisky =
        text.includes('risk') ||
        text.includes('bold') ||
        text.includes('aggressive') ||
        text.includes('irreversible');

      const isSafe =
        text.includes('safe') ||
        text.includes('reversible') ||
        text.includes('cautious') ||
        text.includes('conservative');

      if (isRisky) {
        return { ...p, strength: p.strength * 0.5 };
      }
      if (isSafe) {
        return { ...p, strength: Math.min(1, p.strength * 1.5) };
      }
      return { ...p, strength: p.strength * 0.7 };
    });

    return { principles: adjusted, influence, warnings };
  }

  /**
   * Calculate context modifier for confidence calculation
   */
  getContextModifier(context: UserContext): number {
    let modifier = 1.0;

    // Energy level effect
    if (context.energyLevel < ENERGY_THRESHOLDS.HIGH) {
      if (context.energyLevel < ENERGY_THRESHOLDS.LOW) {
        modifier *= 0.7; // Very low energy reduces confidence
      } else if (context.energyLevel < ENERGY_THRESHOLDS.MEDIUM) {
        modifier *= 0.85; // Low energy reduces confidence
      } else {
        modifier *= 0.95; // Medium energy slightly reduces confidence
      }
    }

    // Decision fatigue effect
    if (context.decisionFatigue > 0.7) {
      modifier *= 0.8;
    } else if (context.decisionFatigue > 0.4) {
      modifier *= 0.9;
    }

    return modifier;
  }
}

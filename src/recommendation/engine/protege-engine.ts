/**
 * Protégé Recommendation Engine
 *
 * Main orchestrator that generates personalized recommendations by applying
 * a human's wisdom, principles, and philosophy to decision requests.
 *
 * The engine answers "What would THIS human decide?" rather than
 * "What is objectively best?"
 */

import type {
  DecisionRequest,
  BaselineRecommendation,
  ProtegeRecommendation,
  IndividualKnowledge,
  RecommendationOptions,
  DifferenceExplanation,
  ProtegeRecommendationEngine as IProtegeRecommendationEngine,
  AppliedPrinciple,
  ContextInfluenceRecord,
  ReasoningStep,
  RecommendationWarning,
} from '../types/index.js';

import { PrincipleMatcherService } from './principle-matcher.js';
import { ContextIntegratorService } from './context-integrator.js';
import { PhilosophyApplierService } from './philosophy-applier.js';
import { ReasoningGeneratorService } from './reasoning-generator.js';
import { calculateConfidence, isLowConfidence } from '../utils/confidence-calculator.js';
import { explainDifference } from '../utils/difference-explainer.js';

/**
 * Engine version for tracking
 */
const ENGINE_VERSION = '1.0.0';

/**
 * Default options for recommendation generation
 */
const DEFAULT_OPTIONS: Required<RecommendationOptions> = {
  energyLevel: 7,
  skipContext: false,
  debug: false,
  maxPrinciples: 10,
  minRelevance: 0.3,
};

/**
 * Main Protégé Recommendation Engine implementation
 */
export class ProtegeRecommendationEngine implements IProtegeRecommendationEngine {
  private readonly principleMatcher: PrincipleMatcherService;
  private readonly contextIntegrator: ContextIntegratorService;
  private readonly philosophyApplier: PhilosophyApplierService;
  private readonly reasoningGenerator: ReasoningGeneratorService;

  constructor() {
    this.principleMatcher = new PrincipleMatcherService();
    this.contextIntegrator = new ContextIntegratorService();
    this.philosophyApplier = new PhilosophyApplierService();
    this.reasoningGenerator = new ReasoningGeneratorService();
  }

  /**
   * Generate a personalized recommendation based on the human's knowledge
   *
   * @param request - The decision that needs to be made
   * @param knowledge - The human's individual knowledge store
   * @param baseline - The objective baseline recommendation
   * @param options - Optional configuration for the recommendation process
   * @returns A personalized recommendation with reasoning
   */
  async generateRecommendation(
    request: DecisionRequest,
    knowledge: IndividualKnowledge,
    baseline: BaselineRecommendation,
    options?: RecommendationOptions
  ): Promise<ProtegeRecommendation> {
    const startTime = Date.now();
    const opts = { ...DEFAULT_OPTIONS, ...options };

    // Override energy level if provided
    const context = opts.energyLevel !== DEFAULT_OPTIONS.energyLevel
      ? { ...knowledge.context, energyLevel: opts.energyLevel }
      : knowledge.context;

    // Step 1: Match principles to decision domain
    let matchedPrinciples = this.principleMatcher.matchWithExceptions(
      request,
      knowledge.principles
    );

    // Filter by minimum relevance
    matchedPrinciples = matchedPrinciples.filter(
      (p) => p.strength >= opts.minRelevance
    );

    // Limit number of principles
    if (matchedPrinciples.length > opts.maxPrinciples) {
      matchedPrinciples = matchedPrinciples.slice(0, opts.maxPrinciples);
    }

    // Step 2: Integrate context (unless skipped)
    let adjustedPrinciples: AppliedPrinciple[] = matchedPrinciples;
    let contextInfluence: ContextInfluenceRecord[] = [];
    let contextWarnings: RecommendationWarning[] = [];

    if (!opts.skipContext) {
      const contextResult = this.contextIntegrator.integrate(
        request,
        context,
        matchedPrinciples
      );
      adjustedPrinciples = contextResult.adjustedPrinciples;
      contextInfluence = contextResult.influence;
      contextWarnings = contextResult.warnings;
    }

    // Step 3: Apply philosophy to determine recommendation
    const philosophyResult = this.philosophyApplier.apply(
      request,
      knowledge.philosophy,
      adjustedPrinciples
    );

    // Step 4: Generate reasoning
    const reasoning = this.reasoningGenerator.generate(
      request,
      adjustedPrinciples,
      contextInfluence,
      philosophyResult.recommendation
    );

    // Merge reasoning from philosophy application
    const allReasoning = this.mergeReasoning(reasoning, philosophyResult.reasoning);

    // Step 5: Calculate confidence
    const contextModifier = this.contextIntegrator.getContextModifier(context);
    const confidence = calculateConfidence(adjustedPrinciples, {
      expectedPrinciplesForDomain: this.getExpectedPrincipleCount(request.domain),
      contextModifier,
    });

    // Step 6: Collect all warnings
    const allWarnings: RecommendationWarning[] = [
      ...contextWarnings,
      ...philosophyResult.warnings,
    ];

    // Add low confidence warning if needed
    if (isLowConfidence(confidence)) {
      allWarnings.push({
        type: 'low_confidence',
        message: 'Low confidence in recommendation due to limited principle coverage',
        severity: 'warning',
      });
    }

    // Step 7: Compare with baseline
    const differsFromBaseline = philosophyResult.recommendation !== baseline.optionId;

    // Build the recommendation
    const processingTimeMs = Date.now() - startTime;

    const recommendation: ProtegeRecommendation = {
      optionId: philosophyResult.recommendation,
      confidence,
      reasoning: allReasoning,
      appliedPrinciples: adjustedPrinciples,
      contextInfluence,
      differsFromBaseline,
      warnings: allWarnings.length > 0 ? allWarnings : undefined,
      meta: {
        processingTimeMs,
        principlesEvaluated: knowledge.principles.length,
        principlesMatched: matchedPrinciples.length,
        hadConflicts: this.detectConflicts(adjustedPrinciples),
        engineVersion: ENGINE_VERSION,
      },
    };

    // Add difference explanation if needed
    if (differsFromBaseline) {
      const explanation = this.explainDifference(recommendation, baseline);
      recommendation.differenceExplanation = explanation.primaryReason;
    }

    return recommendation;
  }

  /**
   * Explain the difference between the protégé and baseline recommendations
   *
   * @param protege - The personalized recommendation
   * @param baseline - The objective baseline recommendation
   * @returns A detailed explanation of the differences
   */
  explainDifference(
    protege: ProtegeRecommendation,
    baseline: BaselineRecommendation
  ): DifferenceExplanation {
    return explainDifference(protege, baseline);
  }

  /**
   * Merge reasoning steps from different sources
   */
  private mergeReasoning(
    generated: ReasoningStep[],
    philosophyReasoning: ReasoningStep[]
  ): ReasoningStep[] {
    // Filter out duplicate conclusion steps
    const genWithoutConclusion = generated.filter((s) => s.type !== 'conclusion');
    const philoWithoutConclusion = philosophyReasoning.filter((s) => s.type !== 'conclusion');

    // Find the conclusion step
    const conclusion = generated.find((s) => s.type === 'conclusion') ||
      philosophyReasoning.find((s) => s.type === 'conclusion');

    // Merge and renumber
    const merged = [...genWithoutConclusion, ...philoWithoutConclusion];

    // Renumber steps
    const renumbered = merged.map((step, index) => ({
      ...step,
      step: index + 1,
    }));

    // Add conclusion at the end
    if (conclusion) {
      renumbered.push({
        ...conclusion,
        step: renumbered.length + 1,
      });
    }

    return renumbered;
  }

  /**
   * Get expected principle count for a domain
   */
  private getExpectedPrincipleCount(domains: string[]): number {
    // Heuristic: expect ~3 principles per domain, max 10
    return Math.min(10, domains.length * 3);
  }

  /**
   * Detect if there are conflicting principles
   */
  private detectConflicts(principles: AppliedPrinciple[]): boolean {
    // Check if any principles favor different options
    const favoredOptions = new Set<string>();
    for (const principle of principles) {
      if (principle.favorsOption) {
        favoredOptions.add(principle.favorsOption);
      }
    }
    return favoredOptions.size > 1;
  }
}

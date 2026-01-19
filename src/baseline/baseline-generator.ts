/**
 * BaselineRecommendationGenerator - generates objective AI recommendations
 * without human wisdom for the three-layer decision model.
 */

import type {
  DecisionRequest,
  BaselineConfig,
  BaselineRecommendation,
  ConsiderationFactor,
  AlternativeAnalysis,
} from './types.js';
import { DEFAULT_BASELINE_CONFIG } from './types.js';
import { PromptBuilder } from './prompt-builder.js';
import { ConfidenceCalculator } from './confidence-calculator.js';
import type { AIService } from '../services/ai-service.js';

/**
 * Raw response structure expected from the AI service.
 * This is the JSON structure the AI is instructed to return.
 */
interface AIRecommendationResponse {
  optionId: string;
  confidence: number;
  reasoning: string[];
  factors: ConsiderationFactor[];
  alternativeOptionAnalysis: AlternativeAnalysis[];
}

/**
 * Error thrown when recommendation generation fails.
 */
export class RecommendationGenerationError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = 'RecommendationGenerationError';
  }
}

/**
 * Error thrown when the AI response cannot be parsed.
 */
export class AIResponseParseError extends Error {
  constructor(
    message: string,
    public readonly rawResponse: string
  ) {
    super(message);
    this.name = 'AIResponseParseError';
  }
}

/**
 * Generates baseline recommendations for decision requests.
 *
 * The baseline recommendation represents what a well-configured AI would recommend
 * without access to human wisdom, principles, or context. This serves as the
 * control group in the three-layer decision model.
 *
 * @example
 * ```typescript
 * const generator = new BaselineRecommendationGenerator(aiService);
 * const recommendation = await generator.generateBaseline(request);
 * console.log(`Recommended: ${recommendation.optionId} with ${recommendation.confidence}% confidence`);
 * ```
 */
export class BaselineRecommendationGenerator {
  private config: BaselineConfig;
  private readonly promptBuilder: PromptBuilder;
  private readonly confidenceCalculator: ConfidenceCalculator;
  private readonly aiService: AIService;

  /**
   * Creates a new BaselineRecommendationGenerator instance.
   *
   * @param aiService - The AI service to use for generating recommendations
   * @param config - Configuration for the generator. Defaults to DEFAULT_BASELINE_CONFIG.
   */
  constructor(
    aiService: AIService,
    config: BaselineConfig = DEFAULT_BASELINE_CONFIG
  ) {
    this.aiService = aiService;
    this.config = { ...config };
    this.promptBuilder = new PromptBuilder(this.config);
    this.confidenceCalculator = new ConfidenceCalculator();
  }

  /**
   * Updates the configuration used for generating recommendations.
   *
   * @param config - The new configuration to use
   */
  configure(config: BaselineConfig): void {
    this.config = { ...config };
    this.promptBuilder.setConfig(this.config);
  }

  /**
   * Gets a copy of the current configuration.
   *
   * @returns A copy of the current BaselineConfig
   */
  getConfig(): BaselineConfig {
    return { ...this.config };
  }

  /**
   * Generates a baseline recommendation for the given decision request.
   *
   * This method:
   * 1. Validates the request
   * 2. Builds prompts using the PromptBuilder
   * 3. Invokes the AI service for recommendation
   * 4. Parses and validates the AI response
   * 5. Applies hybrid confidence calculation
   * 6. Returns the structured BaselineRecommendation
   *
   * @param request - The decision request to generate a recommendation for
   * @returns A promise that resolves to the baseline recommendation
   * @throws RecommendationGenerationError if generation fails
   * @throws AIResponseParseError if the AI response cannot be parsed
   */
  async generateBaseline(request: DecisionRequest): Promise<BaselineRecommendation> {
    // Validate request
    this.validateRequest(request);

    // Build prompts
    const systemPrompt = this.promptBuilder.buildSystemPrompt();
    const userPrompt = this.promptBuilder.buildUserPrompt(request);

    // Invoke AI service
    let aiResponse: string;
    try {
      const response = await this.aiService.complete({
        systemPrompt,
        userPrompt,
        responseFormat: 'json',
        temperature: 0.3, // Lower temperature for more consistent recommendations
      });
      aiResponse = response.content;
    } catch (error) {
      throw new RecommendationGenerationError(
        'Failed to invoke AI service',
        error
      );
    }

    // Parse AI response
    const parsedResponse = this.parseAIResponse(aiResponse, request);

    // Calculate hybrid confidence
    const baseConfidence = this.confidenceCalculator.calculateBaseConfidence(
      parsedResponse.factors
    );
    const finalConfidence = this.confidenceCalculator.applyLLMAdjustment(
      baseConfidence,
      parsedResponse.confidence
    );

    // Calculate alternative confidences if not provided
    const alternativeAnalysis = this.enrichAlternativeAnalysis(
      parsedResponse.alternativeOptionAnalysis,
      finalConfidence,
      parsedResponse.factors
    );

    // Build final recommendation
    const recommendation: BaselineRecommendation = {
      optionId: parsedResponse.optionId,
      confidence: Math.round(finalConfidence),
      reasoning: parsedResponse.reasoning,
      factors: parsedResponse.factors,
      alternativeOptionAnalysis: alternativeAnalysis,
      generatedAt: new Date(),
      configSnapshot: { ...this.config },
    };

    // Check confidence threshold
    if (recommendation.confidence < this.config.confidenceThreshold) {
      // Still return the recommendation but include a note in reasoning
      if (!recommendation.reasoning.includes('Note: Confidence is below the configured threshold.')) {
        recommendation.reasoning.push('Note: Confidence is below the configured threshold.');
      }
    }

    return recommendation;
  }

  /**
   * Validates a decision request.
   *
   * @param request - The request to validate
   * @throws RecommendationGenerationError if validation fails
   */
  private validateRequest(request: DecisionRequest): void {
    if (!request.id || request.id.trim() === '') {
      throw new RecommendationGenerationError('Request ID is required');
    }

    if (!request.options || request.options.length === 0) {
      throw new RecommendationGenerationError('At least one option is required');
    }

    // Check for duplicate option IDs
    const optionIds = new Set<string>();
    for (const option of request.options) {
      if (!option.id || option.id.trim() === '') {
        throw new RecommendationGenerationError('Option ID is required');
      }
      if (optionIds.has(option.id)) {
        throw new RecommendationGenerationError(`Duplicate option ID: ${option.id}`);
      }
      optionIds.add(option.id);
    }

    if (!request.context) {
      throw new RecommendationGenerationError('Context is required');
    }

    if (!request.context.name || request.context.name.trim() === '') {
      throw new RecommendationGenerationError('Context name is required');
    }
  }

  /**
   * Parses and validates the AI response.
   *
   * @param response - The raw AI response string
   * @param request - The original request (for validation)
   * @returns The parsed recommendation response
   * @throws AIResponseParseError if parsing fails
   */
  private parseAIResponse(
    response: string,
    request: DecisionRequest
  ): AIRecommendationResponse {
    // Clean up the response - remove markdown code blocks if present
    let cleanResponse = response.trim();
    if (cleanResponse.startsWith('```json')) {
      cleanResponse = cleanResponse.slice(7);
    } else if (cleanResponse.startsWith('```')) {
      cleanResponse = cleanResponse.slice(3);
    }
    if (cleanResponse.endsWith('```')) {
      cleanResponse = cleanResponse.slice(0, -3);
    }
    cleanResponse = cleanResponse.trim();

    // Parse JSON
    let parsed: AIRecommendationResponse;
    try {
      parsed = JSON.parse(cleanResponse);
    } catch {
      throw new AIResponseParseError(
        'Failed to parse AI response as JSON',
        response
      );
    }

    // Validate required fields
    if (!parsed.optionId || typeof parsed.optionId !== 'string') {
      throw new AIResponseParseError(
        'AI response missing or invalid optionId',
        response
      );
    }

    // Validate optionId exists in request
    const validOptionIds = new Set(request.options.map(o => o.id));
    if (!validOptionIds.has(parsed.optionId)) {
      throw new AIResponseParseError(
        `AI recommended unknown option: ${parsed.optionId}`,
        response
      );
    }

    if (typeof parsed.confidence !== 'number') {
      throw new AIResponseParseError(
        'AI response missing or invalid confidence',
        response
      );
    }

    // Ensure confidence is in valid range
    parsed.confidence = Math.max(0, Math.min(100, parsed.confidence));

    // Ensure arrays exist
    if (!Array.isArray(parsed.reasoning)) {
      parsed.reasoning = [];
    }

    if (!Array.isArray(parsed.factors)) {
      parsed.factors = [];
    }

    if (!Array.isArray(parsed.alternativeOptionAnalysis)) {
      parsed.alternativeOptionAnalysis = [];
    }

    // Validate and normalize factors
    parsed.factors = parsed.factors.map(factor => this.normalizeConsiderationFactor(factor));

    // Validate alternative analyses
    parsed.alternativeOptionAnalysis = parsed.alternativeOptionAnalysis
      .filter(alt => validOptionIds.has(alt.optionId) && alt.optionId !== parsed.optionId)
      .map(alt => this.normalizeAlternativeAnalysis(alt));

    return parsed;
  }

  /**
   * Normalizes a consideration factor from AI response.
   *
   * @param factor - The raw factor from AI
   * @returns Normalized factor
   */
  private normalizeConsiderationFactor(factor: Partial<ConsiderationFactor>): ConsiderationFactor {
    return {
      name: String(factor.name || 'Unknown Factor'),
      value: String(factor.value || ''),
      weight: Math.max(0, Math.min(1, Number(factor.weight) || 0.5)),
      impact: this.normalizeImpact(factor.impact),
      explanation: factor.explanation ? String(factor.explanation) : undefined,
    };
  }

  /**
   * Normalizes an impact value to a valid enum value.
   *
   * @param impact - The raw impact value
   * @returns Normalized impact
   */
  private normalizeImpact(impact: unknown): 'supports' | 'opposes' | 'neutral' {
    const impactStr = String(impact).toLowerCase();
    if (impactStr === 'supports' || impactStr === 'support') {
      return 'supports';
    }
    if (impactStr === 'opposes' || impactStr === 'oppose' || impactStr === 'against') {
      return 'opposes';
    }
    return 'neutral';
  }

  /**
   * Normalizes an alternative analysis from AI response.
   *
   * @param alt - The raw alternative analysis from AI
   * @returns Normalized alternative analysis
   */
  private normalizeAlternativeAnalysis(alt: Partial<AlternativeAnalysis>): AlternativeAnalysis {
    return {
      optionId: String(alt.optionId || ''),
      whyNotChosen: String(alt.whyNotChosen || 'Not selected by the baseline analysis'),
      confidenceIfChosen: Math.max(0, Math.min(100, Number(alt.confidenceIfChosen) || 0)),
      keyDifferences: Array.isArray(alt.keyDifferences)
        ? alt.keyDifferences.map(d => String(d))
        : undefined,
    };
  }

  /**
   * Enriches alternative analysis with calculated confidence values.
   *
   * @param alternatives - The existing alternative analyses
   * @param baseConfidence - The confidence of the chosen option
   * @param factors - The factors from the analysis
   * @returns Enriched alternative analyses
   */
  private enrichAlternativeAnalysis(
    alternatives: AlternativeAnalysis[],
    baseConfidence: number,
    factors: ConsiderationFactor[]
  ): AlternativeAnalysis[] {
    return alternatives.map(alt => {
      // If confidence wasn't provided or is 0, calculate it
      if (!alt.confidenceIfChosen || alt.confidenceIfChosen === 0) {
        // Create difference factors based on factors that would differ for this option
        // Since we don't have option-specific factors, estimate based on the alternative
        const differenceFactors = factors.filter(f =>
          f.impact === 'supports'
        ).map(f => ({
          ...f,
          impact: 'opposes' as const, // Flip to represent disadvantage
          weight: f.weight * 0.5, // Reduce weight since it's estimated
        }));

        alt.confidenceIfChosen = Math.round(
          this.confidenceCalculator.calculateAlternativeConfidence(
            baseConfidence,
            differenceFactors
          )
        );
      }

      return alt;
    });
  }
}

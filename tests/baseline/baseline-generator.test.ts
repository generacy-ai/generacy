import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  BaselineRecommendationGenerator,
  RecommendationGenerationError,
  AIResponseParseError,
} from '../../src/baseline/baseline-generator.js';
import { MockAIService } from '../../src/services/ai-service.js';
import { DEFAULT_BASELINE_CONFIG } from '../../src/baseline/types.js';
import type { DecisionRequest, BaselineConfig } from '../../src/baseline/types.js';
import {
  simpleDecisionRequest,
  complexDecisionRequest,
  singleOptionRequest,
  minimalContextRequest,
  createDecisionRequest,
} from './fixtures/decision-requests.js';

// Mock AI response for testing
const createMockAIResponse = (overrides: Partial<{
  optionId: string;
  confidence: number;
  reasoning: string[];
  factors: Array<{
    name: string;
    value: string;
    weight: number;
    impact: 'supports' | 'opposes' | 'neutral';
    explanation?: string;
  }>;
  alternativeOptionAnalysis: Array<{
    optionId: string;
    whyNotChosen: string;
    confidenceIfChosen: number;
    keyDifferences?: string[];
  }>;
}> = {}): string => {
  return JSON.stringify({
    optionId: overrides.optionId ?? 'react',
    confidence: overrides.confidence ?? 75,
    reasoning: overrides.reasoning ?? [
      'Strong ecosystem support',
      'Team has prior experience',
      'Good fit for interactive dashboards',
    ],
    factors: overrides.factors ?? [
      {
        name: 'Team Experience',
        value: 'Moderate React experience',
        weight: 0.7,
        impact: 'supports',
        explanation: 'Team has worked with React before',
      },
      {
        name: 'Ecosystem',
        value: 'Large ecosystem with many libraries',
        weight: 0.8,
        impact: 'supports',
        explanation: 'Rich ecosystem for component libraries',
      },
      {
        name: 'Learning Curve',
        value: 'Steeper than Vue',
        weight: 0.3,
        impact: 'opposes',
        explanation: 'New team members may need more time',
      },
    ],
    alternativeOptionAnalysis: overrides.alternativeOptionAnalysis ?? [
      {
        optionId: 'vue',
        whyNotChosen: 'Smaller ecosystem and fewer team members have experience',
        confidenceIfChosen: 65,
        keyDifferences: ['Smaller community', 'Built-in state management'],
      },
    ],
  });
};

describe('BaselineRecommendationGenerator', () => {
  let mockAIService: MockAIService;
  let generator: BaselineRecommendationGenerator;

  beforeEach(() => {
    mockAIService = new MockAIService();
    mockAIService.setResponse(createMockAIResponse());
    generator = new BaselineRecommendationGenerator(mockAIService);
  });

  describe('constructor', () => {
    it('should create generator with default config', () => {
      const gen = new BaselineRecommendationGenerator(mockAIService);
      const config = gen.getConfig();
      expect(config).toEqual(DEFAULT_BASELINE_CONFIG);
    });

    it('should accept custom config', () => {
      const customConfig: BaselineConfig = {
        factors: {
          projectContext: true,
          domainBestPractices: false,
          teamSize: true,
          existingStack: false,
        },
        confidenceThreshold: 70,
        requireReasoning: false,
      };

      const gen = new BaselineRecommendationGenerator(mockAIService, customConfig);
      const config = gen.getConfig();
      expect(config).toEqual(customConfig);
    });
  });

  describe('configure', () => {
    it('should update the config', () => {
      const newConfig: BaselineConfig = {
        factors: {
          projectContext: false,
          domainBestPractices: true,
          teamSize: false,
          existingStack: true,
        },
        confidenceThreshold: 60,
        requireReasoning: true,
      };

      generator.configure(newConfig);
      const config = generator.getConfig();
      expect(config).toEqual(newConfig);
    });

    it('should not mutate the original config object', () => {
      const originalConfig: BaselineConfig = {
        factors: {
          projectContext: true,
          domainBestPractices: true,
          teamSize: true,
          existingStack: true,
        },
        confidenceThreshold: 50,
        requireReasoning: true,
      };

      generator.configure(originalConfig);
      originalConfig.confidenceThreshold = 100;

      const currentConfig = generator.getConfig();
      expect(currentConfig.confidenceThreshold).toBe(50);
    });
  });

  describe('getConfig', () => {
    it('should return a copy of the config', () => {
      const config1 = generator.getConfig();
      const config2 = generator.getConfig();

      expect(config1).toEqual(config2);
      expect(config1).not.toBe(config2); // Different objects
    });
  });

  describe('generateBaseline', () => {
    describe('request validation', () => {
      it('should throw on empty request ID', async () => {
        const request = createDecisionRequest({ id: '' });

        await expect(generator.generateBaseline(request)).rejects.toThrow(
          RecommendationGenerationError
        );
        await expect(generator.generateBaseline(request)).rejects.toThrow(
          'Request ID is required'
        );
      });

      it('should throw on empty options array', async () => {
        const request = createDecisionRequest({ options: [] });

        await expect(generator.generateBaseline(request)).rejects.toThrow(
          RecommendationGenerationError
        );
        await expect(generator.generateBaseline(request)).rejects.toThrow(
          'At least one option is required'
        );
      });

      it('should throw on duplicate option IDs', async () => {
        const request = createDecisionRequest({
          options: [
            { id: 'same', name: 'Option 1', description: 'First' },
            { id: 'same', name: 'Option 2', description: 'Second' },
          ],
        });

        await expect(generator.generateBaseline(request)).rejects.toThrow(
          RecommendationGenerationError
        );
        await expect(generator.generateBaseline(request)).rejects.toThrow(
          'Duplicate option ID'
        );
      });

      it('should throw on missing context', async () => {
        const request = {
          id: 'req-1',
          description: 'Test',
          options: [{ id: 'opt-1', name: 'Option', description: 'Desc' }],
          context: null as unknown as { name: string },
          requestedAt: new Date(),
        };

        await expect(generator.generateBaseline(request)).rejects.toThrow(
          RecommendationGenerationError
        );
        await expect(generator.generateBaseline(request)).rejects.toThrow(
          'Context is required'
        );
      });

      it('should throw on empty context name', async () => {
        const request = createDecisionRequest({
          context: { name: '' },
        });

        await expect(generator.generateBaseline(request)).rejects.toThrow(
          RecommendationGenerationError
        );
        await expect(generator.generateBaseline(request)).rejects.toThrow(
          'Context name is required'
        );
      });
    });

    describe('AI invocation', () => {
      it('should call AI service with prompts', async () => {
        const completeSpy = vi.spyOn(mockAIService, 'complete');

        await generator.generateBaseline(simpleDecisionRequest);

        expect(completeSpy).toHaveBeenCalledOnce();
        expect(completeSpy).toHaveBeenCalledWith({
          systemPrompt: expect.any(String),
          userPrompt: expect.any(String),
          responseFormat: 'json',
          temperature: 0.3,
        });
      });

      it('should throw RecommendationGenerationError on AI service failure', async () => {
        const failingService = new MockAIService();
        const failingGenerator = new BaselineRecommendationGenerator(failingService);

        vi.spyOn(failingService, 'complete').mockRejectedValue(new Error('API Error'));

        await expect(
          failingGenerator.generateBaseline(simpleDecisionRequest)
        ).rejects.toThrow(RecommendationGenerationError);
        await expect(
          failingGenerator.generateBaseline(simpleDecisionRequest)
        ).rejects.toThrow('Failed to invoke AI service');
      });
    });

    describe('response parsing', () => {
      it('should parse valid JSON response', async () => {
        const recommendation = await generator.generateBaseline(simpleDecisionRequest);

        expect(recommendation.optionId).toBe('react');
        expect(recommendation.reasoning).toHaveLength(3);
        expect(recommendation.factors).toHaveLength(3);
      });

      it('should handle response with markdown code blocks', async () => {
        mockAIService.setResponse('```json\n' + createMockAIResponse() + '\n```');

        const recommendation = await generator.generateBaseline(simpleDecisionRequest);
        expect(recommendation.optionId).toBe('react');
      });

      it('should throw AIResponseParseError on invalid JSON', async () => {
        mockAIService.setResponse('not valid json');

        await expect(generator.generateBaseline(simpleDecisionRequest)).rejects.toThrow(
          AIResponseParseError
        );
        await expect(generator.generateBaseline(simpleDecisionRequest)).rejects.toThrow(
          'Failed to parse AI response'
        );
      });

      it('should throw AIResponseParseError on missing optionId', async () => {
        mockAIService.setResponse(JSON.stringify({ confidence: 75 }));

        await expect(generator.generateBaseline(simpleDecisionRequest)).rejects.toThrow(
          AIResponseParseError
        );
      });

      it('should throw AIResponseParseError on invalid optionId', async () => {
        mockAIService.setResponse(
          createMockAIResponse({ optionId: 'nonexistent-option' })
        );

        await expect(generator.generateBaseline(simpleDecisionRequest)).rejects.toThrow(
          AIResponseParseError
        );
        await expect(generator.generateBaseline(simpleDecisionRequest)).rejects.toThrow(
          'unknown option'
        );
      });

      it('should clamp confidence to valid range', async () => {
        mockAIService.setResponse(createMockAIResponse({ confidence: 150 }));

        const recommendation = await generator.generateBaseline(simpleDecisionRequest);
        expect(recommendation.confidence).toBeLessThanOrEqual(100);
      });

      it('should handle missing optional arrays', async () => {
        mockAIService.setResponse(
          JSON.stringify({
            optionId: 'react',
            confidence: 75,
          })
        );

        const recommendation = await generator.generateBaseline(simpleDecisionRequest);
        expect(recommendation.reasoning).toEqual([]);
        expect(recommendation.factors).toEqual([]);
        expect(recommendation.alternativeOptionAnalysis).toEqual([]);
      });
    });

    describe('confidence calculation', () => {
      it('should apply hybrid confidence calculation', async () => {
        // AI returns 75, but factors analysis should influence final score
        const recommendation = await generator.generateBaseline(simpleDecisionRequest);

        // Confidence should be adjusted based on factors
        expect(recommendation.confidence).toBeGreaterThanOrEqual(0);
        expect(recommendation.confidence).toBeLessThanOrEqual(100);
        expect(typeof recommendation.confidence).toBe('number');
        expect(Number.isInteger(recommendation.confidence)).toBe(true);
      });

      it('should add note when confidence is below threshold', async () => {
        generator.configure({
          ...DEFAULT_BASELINE_CONFIG,
          confidenceThreshold: 90,
        });

        mockAIService.setResponse(createMockAIResponse({ confidence: 60 }));

        const recommendation = await generator.generateBaseline(simpleDecisionRequest);

        expect(recommendation.reasoning).toContain(
          'Note: Confidence is below the configured threshold.'
        );
      });
    });

    describe('recommendation output', () => {
      it('should include all required fields', async () => {
        const recommendation = await generator.generateBaseline(simpleDecisionRequest);

        expect(recommendation).toHaveProperty('optionId');
        expect(recommendation).toHaveProperty('confidence');
        expect(recommendation).toHaveProperty('reasoning');
        expect(recommendation).toHaveProperty('factors');
        expect(recommendation).toHaveProperty('alternativeOptionAnalysis');
        expect(recommendation).toHaveProperty('generatedAt');
        expect(recommendation).toHaveProperty('configSnapshot');
      });

      it('should include generatedAt timestamp', async () => {
        const before = new Date();
        const recommendation = await generator.generateBaseline(simpleDecisionRequest);
        const after = new Date();

        expect(recommendation.generatedAt).toBeInstanceOf(Date);
        expect(recommendation.generatedAt.getTime()).toBeGreaterThanOrEqual(
          before.getTime()
        );
        expect(recommendation.generatedAt.getTime()).toBeLessThanOrEqual(
          after.getTime()
        );
      });

      it('should include config snapshot', async () => {
        const recommendation = await generator.generateBaseline(simpleDecisionRequest);

        expect(recommendation.configSnapshot).toEqual(DEFAULT_BASELINE_CONFIG);
      });

      it('should filter alternative analysis to valid options only', async () => {
        mockAIService.setResponse(
          createMockAIResponse({
            alternativeOptionAnalysis: [
              {
                optionId: 'vue',
                whyNotChosen: 'Valid option',
                confidenceIfChosen: 60,
              },
              {
                optionId: 'invalid-option',
                whyNotChosen: 'Should be filtered',
                confidenceIfChosen: 50,
              },
              {
                optionId: 'react', // Same as chosen, should be filtered
                whyNotChosen: 'Same as chosen',
                confidenceIfChosen: 75,
              },
            ],
          })
        );

        const recommendation = await generator.generateBaseline(simpleDecisionRequest);

        expect(recommendation.alternativeOptionAnalysis).toHaveLength(1);
        expect(recommendation.alternativeOptionAnalysis[0].optionId).toBe('vue');
      });
    });

    describe('with different request types', () => {
      it('should handle simple decision request', async () => {
        const recommendation = await generator.generateBaseline(simpleDecisionRequest);
        expect(recommendation.optionId).toBeDefined();
      });

      it('should handle complex decision request', async () => {
        mockAIService.setResponse(
          createMockAIResponse({
            optionId: 'postgresql',
            alternativeOptionAnalysis: [
              { optionId: 'mongodb', whyNotChosen: 'Weaker ACID', confidenceIfChosen: 60 },
              { optionId: 'redis', whyNotChosen: 'Not primary DB', confidenceIfChosen: 40 },
              { optionId: 'dynamodb', whyNotChosen: 'Vendor lock-in', confidenceIfChosen: 55 },
            ],
          })
        );

        const recommendation = await generator.generateBaseline(complexDecisionRequest);

        expect(recommendation.optionId).toBe('postgresql');
        expect(recommendation.alternativeOptionAnalysis.length).toBe(3);
      });

      it('should handle single option request', async () => {
        mockAIService.setResponse(
          createMockAIResponse({
            optionId: 'typescript',
            confidence: 90,
            alternativeOptionAnalysis: [],
          })
        );

        const recommendation = await generator.generateBaseline(singleOptionRequest);

        expect(recommendation.optionId).toBe('typescript');
        expect(recommendation.alternativeOptionAnalysis).toHaveLength(0);
      });

      it('should handle minimal context request', async () => {
        mockAIService.setResponse(
          createMockAIResponse({
            optionId: 'winston',
            alternativeOptionAnalysis: [
              { optionId: 'pino', whyNotChosen: 'Less familiar', confidenceIfChosen: 70 },
            ],
          })
        );

        const recommendation = await generator.generateBaseline(minimalContextRequest);

        expect(recommendation.optionId).toBe('winston');
      });
    });
  });
});

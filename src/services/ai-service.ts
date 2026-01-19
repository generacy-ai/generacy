/**
 * AI Service interface and types for the recommendation generator.
 * Provides abstraction for AI completion requests.
 */

/**
 * Request parameters for AI completion.
 */
export interface AICompletionRequest {
  /** System prompt providing context and instructions to the AI */
  systemPrompt: string;
  /** User prompt containing the specific query or content */
  userPrompt: string;
  /** Maximum number of tokens in the response */
  maxTokens?: number;
  /** Temperature for response randomness (0-1) */
  temperature?: number;
  /** Expected response format */
  responseFormat?: 'text' | 'json';
}

/**
 * Token usage information from AI completion.
 */
export interface AITokenUsage {
  /** Number of tokens in the prompt */
  promptTokens: number;
  /** Number of tokens in the completion */
  completionTokens: number;
  /** Total tokens used */
  totalTokens: number;
}

/**
 * Response from AI completion request.
 */
export interface AICompletionResponse {
  /** The generated content from the AI */
  content: string;
  /** Token usage statistics */
  usage?: AITokenUsage;
  /** Model identifier used for completion */
  model?: string;
}

/**
 * Interface for AI completion services.
 * Implementations can wrap different AI providers (OpenAI, Anthropic, etc.)
 */
export interface AIService {
  /**
   * Send a completion request to the AI service.
   * @param request - The completion request parameters
   * @returns Promise resolving to the completion response
   */
  complete(request: AICompletionRequest): Promise<AICompletionResponse>;
}

/**
 * Mock implementation of AIService for testing purposes.
 * Allows configuring predetermined responses for test scenarios.
 */
export class MockAIService implements AIService {
  private responseContent: string;

  /**
   * Create a new MockAIService instance.
   * @param defaultResponse - Default response content to return. Defaults to a JSON recommendation response.
   */
  constructor(defaultResponse?: string) {
    this.responseContent = defaultResponse ?? '{"optionId": "default", "confidence": 75}';
  }

  /**
   * Set the response content that will be returned by the next complete() call.
   * @param content - The content to return in the response
   */
  setResponse(content: string): void {
    this.responseContent = content;
  }

  /**
   * Get the currently configured response content.
   * @returns The current response content
   */
  getResponse(): string {
    return this.responseContent;
  }

  /**
   * Mock implementation of AI completion.
   * Returns the configured response with simulated token usage.
   * @param request - The completion request parameters
   * @returns Promise resolving to the mock completion response
   */
  async complete(request: AICompletionRequest): Promise<AICompletionResponse> {
    const promptTokens = request.systemPrompt.length + request.userPrompt.length;
    const completionTokens = this.responseContent.length;

    return {
      content: this.responseContent,
      usage: {
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
      },
      model: 'mock-model',
    };
  }
}

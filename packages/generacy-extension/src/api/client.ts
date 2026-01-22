/**
 * HTTP API client for Generacy cloud API.
 * Provides fetch-based requests with error handling, retry logic, and auth interceptors.
 */
import { z } from 'zod';
import { getLogger } from '../utils/logger';
import { getConfig } from '../utils/config';
import { ErrorCode, GeneracyError } from '../utils/errors';
import type { ApiRequestOptions, ApiResponse, ApiErrorResponse, HttpMethod, AuthTokens } from './types';

// ============================================================================
// Constants
// ============================================================================

/** Default request timeout in milliseconds */
const DEFAULT_TIMEOUT = 30000;

/** Default number of retries */
const DEFAULT_RETRIES = 3;

/** Base delay for exponential backoff in milliseconds */
const BASE_RETRY_DELAY = 1000;

/** Maximum retry delay in milliseconds */
const MAX_RETRY_DELAY = 30000;

/** HTTP status codes that should trigger a retry */
const RETRYABLE_STATUS_CODES = [408, 429, 500, 502, 503, 504];

/** HTTP status codes that indicate authentication issues */
const AUTH_ERROR_CODES = [401, 403];

// ============================================================================
// Request Interceptors
// ============================================================================

/**
 * Request interceptor function type
 */
export type RequestInterceptor = (
  url: string,
  init: RequestInit
) => Promise<{ url: string; init: RequestInit }> | { url: string; init: RequestInit };

/**
 * Response interceptor function type
 */
export type ResponseInterceptor = (response: Response, request: { url: string; init: RequestInit }) => Promise<Response> | Response;

// ============================================================================
// API Client Class
// ============================================================================

/**
 * API client for making HTTP requests to the Generacy cloud API.
 * Features:
 * - Fetch-based HTTP requests
 * - Automatic retry with exponential backoff
 * - Request/response interceptors
 * - Token-based authentication
 * - Zod schema validation
 */
export class ApiClient {
  private static instance: ApiClient | undefined;
  private baseUrl: string;
  private authTokens: AuthTokens | undefined;
  private requestInterceptors: RequestInterceptor[] = [];
  private responseInterceptors: ResponseInterceptor[] = [];
  private tokenRefreshPromise: Promise<void> | undefined;

  private constructor() {
    this.baseUrl = getConfig().get('cloudEndpoint');
  }

  /**
   * Get the singleton instance
   */
  public static getInstance(): ApiClient {
    if (!ApiClient.instance) {
      ApiClient.instance = new ApiClient();
    }
    return ApiClient.instance;
  }

  /**
   * Reset the singleton instance (for testing)
   */
  public static resetInstance(): void {
    ApiClient.instance = undefined;
  }

  // ==========================================================================
  // Configuration
  // ==========================================================================

  /**
   * Set the base URL for API requests
   */
  public setBaseUrl(url: string): void {
    this.baseUrl = url.replace(/\/+$/, ''); // Remove trailing slashes
  }

  /**
   * Get the current base URL
   */
  public getBaseUrl(): string {
    return this.baseUrl;
  }

  /**
   * Set authentication tokens
   */
  public setAuthTokens(tokens: AuthTokens | undefined): void {
    this.authTokens = tokens;
  }

  /**
   * Get current authentication tokens
   */
  public getAuthTokens(): AuthTokens | undefined {
    return this.authTokens;
  }

  /**
   * Check if client has valid (non-expired) auth tokens
   */
  public hasValidAuth(): boolean {
    if (!this.authTokens) {
      return false;
    }
    // Check if token expires within the next 60 seconds
    const bufferSeconds = 60;
    return this.authTokens.expiresAt > Date.now() / 1000 + bufferSeconds;
  }

  // ==========================================================================
  // Interceptors
  // ==========================================================================

  /**
   * Add a request interceptor
   * Interceptors are called in order before each request
   */
  public addRequestInterceptor(interceptor: RequestInterceptor): () => void {
    this.requestInterceptors.push(interceptor);
    return () => {
      const index = this.requestInterceptors.indexOf(interceptor);
      if (index >= 0) {
        this.requestInterceptors.splice(index, 1);
      }
    };
  }

  /**
   * Add a response interceptor
   * Interceptors are called in order after each response
   */
  public addResponseInterceptor(interceptor: ResponseInterceptor): () => void {
    this.responseInterceptors.push(interceptor);
    return () => {
      const index = this.responseInterceptors.indexOf(interceptor);
      if (index >= 0) {
        this.responseInterceptors.splice(index, 1);
      }
    };
  }

  /**
   * Clear all interceptors
   */
  public clearInterceptors(): void {
    this.requestInterceptors = [];
    this.responseInterceptors = [];
  }

  // ==========================================================================
  // Token Refresh
  // ==========================================================================

  /**
   * Set a token refresh handler
   * Called when a 401 is received and refresh token is available
   */
  private tokenRefreshHandler: ((tokens: AuthTokens) => Promise<AuthTokens>) | undefined;

  /**
   * Set the token refresh handler
   */
  public setTokenRefreshHandler(handler: (tokens: AuthTokens) => Promise<AuthTokens>): void {
    this.tokenRefreshHandler = handler;
  }

  /**
   * Attempt to refresh the auth tokens
   */
  private async refreshTokens(): Promise<boolean> {
    if (!this.authTokens?.refreshToken || !this.tokenRefreshHandler) {
      return false;
    }

    // Prevent concurrent refresh attempts
    if (this.tokenRefreshPromise) {
      await this.tokenRefreshPromise;
      return this.hasValidAuth();
    }

    const logger = getLogger();

    try {
      this.tokenRefreshPromise = (async () => {
        logger.debug('Refreshing auth tokens');
        const newTokens = await this.tokenRefreshHandler!(this.authTokens!);
        this.setAuthTokens(newTokens);
        logger.debug('Auth tokens refreshed successfully');
      })();

      await this.tokenRefreshPromise;
      return true;
    } catch (error) {
      logger.error('Failed to refresh auth tokens', error);
      this.setAuthTokens(undefined);
      return false;
    } finally {
      this.tokenRefreshPromise = undefined;
    }
  }

  // ==========================================================================
  // HTTP Methods
  // ==========================================================================

  /**
   * Make a GET request
   */
  public async get<T>(path: string, options?: Omit<ApiRequestOptions, 'method' | 'body'>): Promise<ApiResponse<T>> {
    return this.request<T>(path, { ...options, method: 'GET' });
  }

  /**
   * Make a GET request with Zod schema validation
   */
  public async getValidated<T>(
    path: string,
    schema: z.ZodType<T>,
    options?: Omit<ApiRequestOptions, 'method' | 'body'>
  ): Promise<ApiResponse<T>> {
    const response = await this.get<unknown>(path, options);
    return this.validateResponse(response, schema);
  }

  /**
   * Make a POST request
   */
  public async post<T>(path: string, body?: unknown, options?: Omit<ApiRequestOptions, 'method'>): Promise<ApiResponse<T>> {
    return this.request<T>(path, { ...options, method: 'POST', body });
  }

  /**
   * Make a POST request with Zod schema validation
   */
  public async postValidated<T>(
    path: string,
    schema: z.ZodType<T>,
    body?: unknown,
    options?: Omit<ApiRequestOptions, 'method'>
  ): Promise<ApiResponse<T>> {
    const response = await this.post<unknown>(path, body, options);
    return this.validateResponse(response, schema);
  }

  /**
   * Make a PUT request
   */
  public async put<T>(path: string, body?: unknown, options?: Omit<ApiRequestOptions, 'method'>): Promise<ApiResponse<T>> {
    return this.request<T>(path, { ...options, method: 'PUT', body });
  }

  /**
   * Make a PUT request with Zod schema validation
   */
  public async putValidated<T>(
    path: string,
    schema: z.ZodType<T>,
    body?: unknown,
    options?: Omit<ApiRequestOptions, 'method'>
  ): Promise<ApiResponse<T>> {
    const response = await this.put<unknown>(path, body, options);
    return this.validateResponse(response, schema);
  }

  /**
   * Make a PATCH request
   */
  public async patch<T>(path: string, body?: unknown, options?: Omit<ApiRequestOptions, 'method'>): Promise<ApiResponse<T>> {
    return this.request<T>(path, { ...options, method: 'PATCH', body });
  }

  /**
   * Make a PATCH request with Zod schema validation
   */
  public async patchValidated<T>(
    path: string,
    schema: z.ZodType<T>,
    body?: unknown,
    options?: Omit<ApiRequestOptions, 'method'>
  ): Promise<ApiResponse<T>> {
    const response = await this.patch<unknown>(path, body, options);
    return this.validateResponse(response, schema);
  }

  /**
   * Make a DELETE request
   */
  public async delete<T>(path: string, options?: Omit<ApiRequestOptions, 'method' | 'body'>): Promise<ApiResponse<T>> {
    return this.request<T>(path, { ...options, method: 'DELETE' });
  }

  /**
   * Make a DELETE request with Zod schema validation
   */
  public async deleteValidated<T>(
    path: string,
    schema: z.ZodType<T>,
    options?: Omit<ApiRequestOptions, 'method' | 'body'>
  ): Promise<ApiResponse<T>> {
    const response = await this.delete<unknown>(path, options);
    return this.validateResponse(response, schema);
  }

  // ==========================================================================
  // Core Request Logic
  // ==========================================================================

  /**
   * Make an HTTP request with retry logic and interceptors
   */
  public async request<T>(path: string, options: ApiRequestOptions = {}): Promise<ApiResponse<T>> {
    const {
      method = 'GET',
      body,
      headers = {},
      params,
      timeout = DEFAULT_TIMEOUT,
      skipAuth = false,
      retries = DEFAULT_RETRIES,
    } = options;

    const logger = getLogger();
    const url = this.buildUrl(path, params);

    // Build initial request
    let init: RequestInit = {
      method,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    };

    // Add auth header if available and not skipped
    if (!skipAuth && this.authTokens) {
      (init.headers as Record<string, string>)['Authorization'] = `Bearer ${this.authTokens.accessToken}`;
    }

    // Run request interceptors
    let finalUrl = url;
    for (const interceptor of this.requestInterceptors) {
      const result = await interceptor(finalUrl, init);
      finalUrl = result.url;
      init = result.init;
    }

    // Execute with retry logic
    let lastError: Error | undefined;
    let attempt = 0;

    while (attempt <= retries) {
      try {
        logger.debug(`API Request: ${method} ${finalUrl}`, { attempt: attempt + 1, maxAttempts: retries + 1 });

        const response = await this.executeRequest(finalUrl, init, timeout);

        // Run response interceptors
        let finalResponse = response;
        for (const interceptor of this.responseInterceptors) {
          finalResponse = await interceptor(finalResponse, { url: finalUrl, init });
        }

        // Handle non-2xx responses
        if (!finalResponse.ok) {
          // Handle auth errors specially
          if (AUTH_ERROR_CODES.includes(finalResponse.status)) {
            // Try to refresh token on 401
            if (finalResponse.status === 401 && !skipAuth) {
              const refreshed = await this.refreshTokens();
              if (refreshed) {
                // Update auth header and retry
                (init.headers as Record<string, string>)['Authorization'] = `Bearer ${this.authTokens!.accessToken}`;
                attempt++;
                continue;
              }
            }
            throw this.createAuthError(finalResponse.status);
          }

          // Check if retryable
          if (RETRYABLE_STATUS_CODES.includes(finalResponse.status) && attempt < retries) {
            const delay = this.calculateRetryDelay(attempt, finalResponse);
            logger.debug(`Retrying request after ${delay}ms`, { status: finalResponse.status });
            await this.sleep(delay);
            attempt++;
            continue;
          }

          // Non-retryable error
          throw await this.createApiError(finalResponse);
        }

        // Parse successful response
        const data = await this.parseResponseBody<T>(finalResponse);

        return {
          data,
          status: finalResponse.status,
          headers: finalResponse.headers,
        };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // Don't retry on auth errors or validation errors
        if (error instanceof GeneracyError && [ErrorCode.AuthRequired, ErrorCode.AuthExpired, ErrorCode.ApiResponseError].includes(error.code)) {
          throw error;
        }

        // Network errors are retryable
        if (this.isNetworkError(error) && attempt < retries) {
          const delay = this.calculateRetryDelay(attempt);
          logger.debug(`Retrying request after network error (${delay}ms)`, { error: lastError.message });
          await this.sleep(delay);
          attempt++;
          continue;
        }

        throw error;
      }
    }

    // All retries exhausted
    throw lastError ?? new GeneracyError(ErrorCode.ApiRequestError, 'Request failed after all retries');
  }

  /**
   * Execute a single request with timeout
   */
  private async executeRequest(url: string, init: RequestInit, timeout: number): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(url, {
        ...init,
        signal: controller.signal,
      });
      return response;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new GeneracyError(ErrorCode.ApiRequestError, `Request timeout after ${timeout}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // ==========================================================================
  // Response Handling
  // ==========================================================================

  /**
   * Parse response body as JSON
   */
  private async parseResponseBody<T>(response: Response): Promise<T> {
    const contentType = response.headers.get('content-type');

    if (!contentType || !contentType.includes('application/json')) {
      // Handle empty responses
      if (response.status === 204) {
        return undefined as unknown as T;
      }
      const text = await response.text();
      return text as unknown as T;
    }

    try {
      return await response.json();
    } catch {
      throw new GeneracyError(ErrorCode.ApiResponseError, 'Failed to parse response as JSON');
    }
  }

  /**
   * Validate response data against a Zod schema
   */
  private validateResponse<T>(response: ApiResponse<unknown>, schema: z.ZodType<T>): ApiResponse<T> {
    const result = schema.safeParse(response.data);

    if (!result.success) {
      const logger = getLogger();
      logger.error('API response validation failed', undefined, {
        errors: result.error.errors,
        data: response.data,
      });
      throw new GeneracyError(ErrorCode.ApiResponseError, 'Invalid response format from server', {
        details: { validationErrors: result.error.errors },
      });
    }

    return {
      ...response,
      data: result.data,
    };
  }

  // ==========================================================================
  // Error Handling
  // ==========================================================================

  /**
   * Create an API error from response
   */
  private async createApiError(response: Response): Promise<GeneracyError> {
    let errorMessage = `Request failed with status ${response.status}`;
    let details: Record<string, unknown> | undefined;

    try {
      const errorBody = (await response.json()) as ApiErrorResponse;
      if (errorBody.message) {
        errorMessage = errorBody.message;
      }
      if (errorBody.code || errorBody.details) {
        details = {
          code: errorBody.code,
          ...errorBody.details,
        };
      }
    } catch {
      // Ignore JSON parse errors for error body
    }

    // Map HTTP status to error code
    const errorCode = this.mapHttpStatusToErrorCode(response.status);
    return new GeneracyError(errorCode, errorMessage, { details });
  }

  /**
   * Create an authentication error
   */
  private createAuthError(status: number): GeneracyError {
    if (status === 401) {
      return new GeneracyError(ErrorCode.AuthExpired, 'Authentication required or token expired');
    }
    return new GeneracyError(ErrorCode.AuthFailed, 'Access denied');
  }

  /**
   * Map HTTP status code to error code
   */
  private mapHttpStatusToErrorCode(status: number): ErrorCode {
    switch (status) {
      case 401:
        return ErrorCode.AuthExpired;
      case 403:
        return ErrorCode.AuthFailed;
      case 429:
        return ErrorCode.ApiRateLimited;
      case 404:
      case 400:
      case 422:
        return ErrorCode.ApiRequestError;
      default:
        return status >= 500 ? ErrorCode.ApiConnectionError : ErrorCode.ApiRequestError;
    }
  }

  /**
   * Check if error is a network error
   */
  private isNetworkError(error: unknown): boolean {
    if (!(error instanceof Error)) {
      return false;
    }
    return error.name === 'TypeError' || error.message.includes('network') || error.message.includes('fetch');
  }

  // ==========================================================================
  // Retry Logic
  // ==========================================================================

  /**
   * Calculate retry delay with exponential backoff
   */
  private calculateRetryDelay(attempt: number, response?: Response): number {
    // Check for Retry-After header
    if (response) {
      const retryAfter = response.headers.get('Retry-After');
      if (retryAfter) {
        const seconds = parseInt(retryAfter, 10);
        if (!isNaN(seconds)) {
          return Math.min(seconds * 1000, MAX_RETRY_DELAY);
        }
      }
    }

    // Exponential backoff with jitter
    const exponentialDelay = BASE_RETRY_DELAY * Math.pow(2, attempt);
    const jitter = Math.random() * 0.3 * exponentialDelay; // 0-30% jitter
    return Math.min(exponentialDelay + jitter, MAX_RETRY_DELAY);
  }

  /**
   * Sleep for a specified duration
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ==========================================================================
  // URL Building
  // ==========================================================================

  /**
   * Build full URL from path and params
   */
  private buildUrl(path: string, params?: Record<string, string | number | boolean | undefined>): string {
    // Ensure path starts with /
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    const url = new URL(`${this.baseUrl}${normalizedPath}`);

    // Add query parameters
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined) {
          url.searchParams.append(key, String(value));
        }
      }
    }

    return url.toString();
  }
}

// ============================================================================
// Singleton Export
// ============================================================================

/**
 * Get the singleton API client instance
 */
export function getApiClient(): ApiClient {
  return ApiClient.getInstance();
}

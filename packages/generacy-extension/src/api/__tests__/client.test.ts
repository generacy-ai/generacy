import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import { ApiClient, getApiClient } from '../client';
import { ErrorCode, GeneracyError } from '../../utils/errors';

// Mock fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Mock vscode module
vi.mock('vscode', () => ({
  window: {
    createOutputChannel: vi.fn(() => ({
      appendLine: vi.fn(),
      dispose: vi.fn(),
      show: vi.fn(),
      clear: vi.fn(),
    })),
    showErrorMessage: vi.fn(),
  },
  workspace: {
    getConfiguration: vi.fn(() => ({
      get: vi.fn((key: string) => {
        const defaults: Record<string, unknown> = {
          workflowDirectory: '.generacy',
          defaultTemplate: 'basic',
          cloudEndpoint: 'https://api.generacy.ai',
          'telemetry.enabled': false,
        };
        return defaults[key];
      }),
    })),
    onDidChangeConfiguration: vi.fn(() => ({ dispose: vi.fn() })),
  },
  ConfigurationTarget: {
    Global: 1,
    Workspace: 2,
  },
}));

describe('ApiClient', () => {
  let client: ApiClient;

  beforeEach(() => {
    vi.clearAllMocks();
    ApiClient.resetInstance();
    client = getApiClient();
    client.setBaseUrl('https://api.test.com');
    client.clearInterceptors();
  });

  afterEach(() => {
    ApiClient.resetInstance();
  });

  describe('singleton', () => {
    it('should return the same instance', () => {
      const client1 = getApiClient();
      const client2 = getApiClient();
      expect(client1).toBe(client2);
    });

    it('should create new instance after reset', () => {
      const client1 = getApiClient();
      ApiClient.resetInstance();
      const client2 = getApiClient();
      expect(client1).not.toBe(client2);
    });
  });

  describe('configuration', () => {
    it('should set and get base URL', () => {
      client.setBaseUrl('https://custom.api.com');
      expect(client.getBaseUrl()).toBe('https://custom.api.com');
    });

    it('should remove trailing slashes from base URL', () => {
      client.setBaseUrl('https://api.test.com///');
      expect(client.getBaseUrl()).toBe('https://api.test.com');
    });

    it('should set and get auth tokens', () => {
      const tokens = {
        accessToken: 'test-token',
        refreshToken: 'refresh-token',
        expiresAt: Date.now() / 1000 + 3600,
      };
      client.setAuthTokens(tokens);
      expect(client.getAuthTokens()).toEqual(tokens);
    });

    it('should return true for valid auth', () => {
      client.setAuthTokens({
        accessToken: 'test-token',
        expiresAt: Date.now() / 1000 + 3600, // 1 hour from now
      });
      expect(client.hasValidAuth()).toBe(true);
    });

    it('should return false for expired auth', () => {
      client.setAuthTokens({
        accessToken: 'test-token',
        expiresAt: Date.now() / 1000 - 3600, // 1 hour ago
      });
      expect(client.hasValidAuth()).toBe(false);
    });

    it('should return false when auth expires within buffer', () => {
      client.setAuthTokens({
        accessToken: 'test-token',
        expiresAt: Date.now() / 1000 + 30, // 30 seconds from now (within 60s buffer)
      });
      expect(client.hasValidAuth()).toBe(false);
    });
  });

  describe('HTTP methods', () => {
    it('should make GET request', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ data: 'test' }),
      });

      const response = await client.get('/test');

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.test.com/test',
        expect.objectContaining({
          method: 'GET',
        })
      );
      expect(response.data).toEqual({ data: 'test' });
      expect(response.status).toBe(200);
    });

    it('should make POST request with body', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 201,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ id: 1 }),
      });

      const response = await client.post('/test', { name: 'test' });

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.test.com/test',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ name: 'test' }),
        })
      );
      expect(response.data).toEqual({ id: 1 });
    });

    it('should make PUT request', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ updated: true }),
      });

      await client.put('/test/1', { name: 'updated' });

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.test.com/test/1',
        expect.objectContaining({
          method: 'PUT',
        })
      );
    });

    it('should make PATCH request', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ patched: true }),
      });

      await client.patch('/test/1', { name: 'patched' });

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.test.com/test/1',
        expect.objectContaining({
          method: 'PATCH',
        })
      );
    });

    it('should make DELETE request', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 204,
        headers: new Headers(),
        json: async () => {
          throw new Error('No content');
        },
        text: async () => '',
      });

      const response = await client.delete('/test/1');

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.test.com/test/1',
        expect.objectContaining({
          method: 'DELETE',
        })
      );
      expect(response.status).toBe(204);
    });
  });

  describe('query parameters', () => {
    it('should add query parameters to URL', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ([]),
      });

      await client.get('/test', { params: { page: 1, limit: 10, active: true } });

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.test.com/test?page=1&limit=10&active=true',
        expect.any(Object)
      );
    });

    it('should skip undefined query parameters', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ([]),
      });

      await client.get('/test', { params: { page: 1, filter: undefined } });

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.test.com/test?page=1',
        expect.any(Object)
      );
    });
  });

  describe('authentication', () => {
    it('should add Authorization header when tokens are set', async () => {
      client.setAuthTokens({
        accessToken: 'my-token',
        expiresAt: Date.now() / 1000 + 3600,
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ data: 'test' }),
      });

      await client.get('/test');

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer my-token',
          }),
        })
      );
    });

    it('should skip auth header when skipAuth is true', async () => {
      client.setAuthTokens({
        accessToken: 'my-token',
        expiresAt: Date.now() / 1000 + 3600,
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ data: 'test' }),
      });

      await client.get('/test', { skipAuth: true });

      const callArgs = mockFetch.mock.calls[0][1] as RequestInit;
      expect((callArgs.headers as Record<string, string>)['Authorization']).toBeUndefined();
    });
  });

  describe('error handling', () => {
    it('should throw on 401 response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ message: 'Unauthorized' }),
      });

      try {
        await client.get('/test');
        expect.fail('Should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(GeneracyError);
        expect((e as GeneracyError).code).toBe(ErrorCode.AuthExpired);
      }
    });

    it('should throw on 403 response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 403,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ message: 'Forbidden' }),
      });

      try {
        await client.get('/test');
        expect.fail('Should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(GeneracyError);
        expect((e as GeneracyError).code).toBe(ErrorCode.AuthFailed);
      }
    });

    it('should throw on 429 rate limit', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 429,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ message: 'Rate limited' }),
      });

      await expect(client.get('/test', { retries: 0 })).rejects.toThrow(GeneracyError);
    });

    it('should throw on 500 server error after retries', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ message: 'Server error' }),
      });

      await expect(client.get('/test', { retries: 1 })).rejects.toThrow(GeneracyError);
      // Should have retried once (2 total attempts)
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  describe('retry logic', () => {
    it('should retry on 503 response', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: false,
          status: 503,
          headers: new Headers(),
          json: async () => ({ message: 'Service unavailable' }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: async () => ({ data: 'success' }),
        });

      const response = await client.get('/test', { retries: 1 });

      expect(response.data).toEqual({ data: 'success' });
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('should respect Retry-After header', async () => {
      const startTime = Date.now();

      mockFetch
        .mockResolvedValueOnce({
          ok: false,
          status: 429,
          headers: new Headers({ 'Retry-After': '1' }), // 1 second
          json: async () => ({ message: 'Rate limited' }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: async () => ({ data: 'success' }),
        });

      await client.get('/test', { retries: 1 });

      const elapsed = Date.now() - startTime;
      expect(elapsed).toBeGreaterThanOrEqual(1000);
    });

    it('should not retry on 400 bad request', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 400,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ message: 'Bad request' }),
      });

      await expect(client.get('/test', { retries: 3 })).rejects.toThrow();
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('interceptors', () => {
    it('should run request interceptors', async () => {
      const interceptor = vi.fn().mockImplementation((url, init) => ({
        url: url + '?intercepted=true',
        init: { ...init, headers: { ...init.headers, 'X-Custom': 'value' } },
      }));

      client.addRequestInterceptor(interceptor);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ data: 'test' }),
      });

      await client.get('/test');

      expect(interceptor).toHaveBeenCalled();
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.test.com/test?intercepted=true',
        expect.objectContaining({
          headers: expect.objectContaining({
            'X-Custom': 'value',
          }),
        })
      );
    });

    it('should run response interceptors', async () => {
      const interceptor = vi.fn().mockImplementation((response) => response);

      client.addResponseInterceptor(interceptor);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ data: 'test' }),
      });

      await client.get('/test');

      expect(interceptor).toHaveBeenCalled();
    });

    it('should remove interceptor when returned function is called', async () => {
      const interceptor = vi.fn().mockImplementation((url, init) => ({ url, init }));
      const remove = client.addRequestInterceptor(interceptor);

      remove();

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ data: 'test' }),
      });

      await client.get('/test');

      expect(interceptor).not.toHaveBeenCalled();
    });
  });

  describe('schema validation', () => {
    const TestSchema = z.object({
      id: z.number(),
      name: z.string(),
    });

    it('should validate response with schema', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ id: 1, name: 'test' }),
      });

      const response = await client.getValidated('/test', TestSchema);

      expect(response.data).toEqual({ id: 1, name: 'test' });
    });

    it('should throw on invalid response format', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ id: 'not-a-number', name: 'test' }),
      });

      await expect(client.getValidated('/test', TestSchema)).rejects.toThrow(GeneracyError);
    });

    it('should support postValidated', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 201,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ id: 1, name: 'created' }),
      });

      const response = await client.postValidated('/test', TestSchema, { name: 'new' });

      expect(response.data).toEqual({ id: 1, name: 'created' });
    });
  });

  describe('timeout', () => {
    it('should abort request on timeout', async () => {
      mockFetch.mockImplementationOnce(() =>
        new Promise((_, reject) => {
          const error = new Error('The operation was aborted');
          error.name = 'AbortError';
          setTimeout(() => reject(error), 100);
        })
      );

      await expect(client.get('/test', { timeout: 50, retries: 0 })).rejects.toThrow(GeneracyError);
    });
  });

  describe('token refresh', () => {
    it('should attempt token refresh on 401', async () => {
      const refreshHandler = vi.fn().mockResolvedValue({
        accessToken: 'new-token',
        expiresAt: Date.now() / 1000 + 3600,
      });

      client.setAuthTokens({
        accessToken: 'old-token',
        refreshToken: 'refresh-token',
        expiresAt: Date.now() / 1000 + 3600,
      });
      client.setTokenRefreshHandler(refreshHandler);

      mockFetch
        .mockResolvedValueOnce({
          ok: false,
          status: 401,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: async () => ({ message: 'Token expired' }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: async () => ({ data: 'success' }),
        });

      const response = await client.get('/test', { retries: 1 });

      expect(refreshHandler).toHaveBeenCalled();
      expect(response.data).toEqual({ data: 'success' });
      expect(client.getAuthTokens()?.accessToken).toBe('new-token');
    });
  });
});

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { createAuthMiddleware, type AuthMiddlewareOptions } from '../../../src/auth/middleware.js';
import { InMemoryApiKeyStore } from '../../../src/auth/api-key.js';

/**
 * Create a mock Fastify request
 */
function createMockRequest(overrides: Partial<{
  headers: Record<string, string | undefined>;
  url: string;
  routeOptions: { url: string };
  correlationId: string;
  jwtVerify: () => Promise<unknown>;
  user: unknown;
  auth: unknown;
}> = {}): FastifyRequest {
  const req: Record<string, unknown> = {
    headers: {},
    url: '/test',
    routeOptions: { url: '/test' },
    correlationId: 'test-trace-id',
    jwtVerify: vi.fn().mockRejectedValue(new Error('No JWT configured')),
    user: null,
    auth: undefined,
    ...overrides,
  };
  return req as unknown as FastifyRequest;
}

/**
 * Create a mock Fastify reply
 */
function createMockReply(): FastifyReply & { _statusCode: number; _body: unknown } {
  const reply = {
    _statusCode: 0,
    _body: undefined as unknown,
    status(code: number) {
      reply._statusCode = code;
      return reply;
    },
    send(body: unknown) {
      reply._body = body;
      return reply;
    },
  };
  return reply as unknown as FastifyReply & { _statusCode: number; _body: unknown };
}

describe('createAuthMiddleware', () => {
  let apiKeyStore: InMemoryApiKeyStore;

  beforeEach(() => {
    apiKeyStore = new InMemoryApiKeyStore();
  });

  describe('auth disabled', () => {
    it('should set anonymous admin auth when disabled', async () => {
      const middleware = createAuthMiddleware({ apiKeyStore, enabled: false });
      const request = createMockRequest();
      const reply = createMockReply();

      await middleware(request, reply);

      expect(request.auth).toEqual({
        userId: 'anonymous',
        method: 'api-key',
        scopes: ['admin'],
      });
    });
  });

  describe('skip routes', () => {
    it('should skip auth for configured routes', async () => {
      const middleware = createAuthMiddleware({
        apiKeyStore,
        enabled: true,
        skipRoutes: ['/health'],
      });
      const request = createMockRequest({
        url: '/health',
        routeOptions: { url: '/health' },
      });
      const reply = createMockReply();

      await middleware(request, reply);

      expect(request.auth).toEqual({
        userId: 'anonymous',
        method: 'api-key',
        scopes: [],
      });
      expect(reply._statusCode).toBe(0); // no error status set
    });
  });

  describe('X-API-Key header authentication', () => {
    it('should authenticate with valid X-API-Key header', async () => {
      apiKeyStore.addKey('my-api-key', {
        name: 'test-key',
        createdAt: new Date().toISOString(),
        scopes: ['admin'],
      });

      const middleware = createAuthMiddleware({ apiKeyStore, enabled: true });
      const request = createMockRequest({
        headers: { 'x-api-key': 'my-api-key' },
      });
      const reply = createMockReply();

      await middleware(request, reply);

      expect(request.auth).toEqual({
        userId: 'apikey:test-key',
        method: 'api-key',
        scopes: ['admin'],
        apiKeyName: 'test-key',
      });
    });

    it('should set correct scopes from API key credential', async () => {
      apiKeyStore.addKey('scoped-key', {
        name: 'scoped',
        createdAt: new Date().toISOString(),
        scopes: ['workflows:read', 'queue:read'],
      });

      const middleware = createAuthMiddleware({ apiKeyStore, enabled: true });
      const request = createMockRequest({
        headers: { 'x-api-key': 'scoped-key' },
      });
      const reply = createMockReply();

      await middleware(request, reply);

      expect(request.auth.scopes).toEqual(['workflows:read', 'queue:read']);
      expect(request.auth.method).toBe('api-key');
    });

    it('should reject invalid X-API-Key with 401', async () => {
      const middleware = createAuthMiddleware({ apiKeyStore, enabled: true });
      const request = createMockRequest({
        headers: { 'x-api-key': 'wrong-key' },
      });
      const reply = createMockReply();

      await middleware(request, reply);

      expect(reply._statusCode).toBe(401);
      expect(reply._body).toMatchObject({
        title: 'Invalid API Key',
        status: 401,
      });
    });
  });

  describe('Bearer token as API key fallback', () => {
    it('should authenticate valid Bearer token against API key store', async () => {
      apiKeyStore.addKey('my-bearer-token', {
        name: 'cli-token',
        createdAt: new Date().toISOString(),
        scopes: ['admin'],
      });

      const middleware = createAuthMiddleware({ apiKeyStore, enabled: true });
      const request = createMockRequest({
        headers: { authorization: 'Bearer my-bearer-token' },
      });
      const reply = createMockReply();

      await middleware(request, reply);

      expect(request.auth).toEqual({
        userId: 'apikey:cli-token',
        method: 'api-key',
        scopes: ['admin'],
        apiKeyName: 'cli-token',
      });
    });

    it('should set correct scopes from Bearer token matched as API key', async () => {
      apiKeyStore.addKey('bearer-scoped', {
        name: 'scoped-bearer',
        createdAt: new Date().toISOString(),
        scopes: ['workflows:read', 'queue:write'],
      });

      const middleware = createAuthMiddleware({ apiKeyStore, enabled: true });
      const request = createMockRequest({
        headers: { authorization: 'Bearer bearer-scoped' },
      });
      const reply = createMockReply();

      await middleware(request, reply);

      expect(request.auth.scopes).toEqual(['workflows:read', 'queue:write']);
      expect(request.auth.method).toBe('api-key');
      expect(request.auth.apiKeyName).toBe('scoped-bearer');
    });

    it('should fall through to JWT when Bearer token not in API key store', async () => {
      // No keys in store — Bearer token won't match
      const jwtPayload = {
        sub: 'github:12345',
        name: 'Test User',
        email: 'test@example.com',
        provider: 'github',
        scopes: ['workflows:read'],
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
      };

      const jwtVerify = vi.fn().mockResolvedValue(undefined);
      const request = createMockRequest({
        headers: { authorization: 'Bearer some-jwt-token' },
        jwtVerify,
        user: jwtPayload,
      });
      const reply = createMockReply();

      const middleware = createAuthMiddleware({ apiKeyStore, enabled: true });
      await middleware(request, reply);

      expect(jwtVerify).toHaveBeenCalled();
      expect(request.auth).toEqual({
        userId: 'github:12345',
        method: 'jwt',
        scopes: ['workflows:read'],
      });
    });

    it('should return 401 when Bearer token is neither valid API key nor valid JWT', async () => {
      const jwtVerify = vi.fn().mockRejectedValue(new Error('Invalid JWT'));
      const request = createMockRequest({
        headers: { authorization: 'Bearer invalid-token' },
        jwtVerify,
      });
      const reply = createMockReply();

      const middleware = createAuthMiddleware({ apiKeyStore, enabled: true });
      await middleware(request, reply);

      expect(reply._statusCode).toBe(401);
      expect(reply._body).toMatchObject({
        title: 'Invalid Token',
        status: 401,
      });
    });

    it('should use same token for both X-API-Key and Bearer auth', async () => {
      const token = 'shared-token-value';
      apiKeyStore.addKey(token, {
        name: 'shared-key',
        createdAt: new Date().toISOString(),
        scopes: ['admin'],
      });

      const middleware = createAuthMiddleware({ apiKeyStore, enabled: true });

      // Via X-API-Key
      const request1 = createMockRequest({
        headers: { 'x-api-key': token },
      });
      const reply1 = createMockReply();
      await middleware(request1, reply1);

      // Via Bearer
      const request2 = createMockRequest({
        headers: { authorization: `Bearer ${token}` },
      });
      const reply2 = createMockReply();
      await middleware(request2, reply2);

      // Both should authenticate identically
      expect(request1.auth).toEqual(request2.auth);
      expect(request1.auth.userId).toBe('apikey:shared-key');
      expect(request1.auth.scopes).toEqual(['admin']);
    });
  });

  describe('JWT authentication', () => {
    it('should authenticate valid JWT when no API key headers present', async () => {
      const jwtPayload = {
        sub: 'github:99999',
        name: 'JWT User',
        email: 'jwt@example.com',
        provider: 'github',
        scopes: ['workflows:read', 'queue:read'],
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
      };

      const jwtVerify = vi.fn().mockResolvedValue(undefined);
      const request = createMockRequest({
        headers: { authorization: 'Bearer jwt.token.here' },
        jwtVerify,
        user: jwtPayload,
      });
      const reply = createMockReply();

      const middleware = createAuthMiddleware({ apiKeyStore, enabled: true });
      await middleware(request, reply);

      expect(request.auth).toEqual({
        userId: 'github:99999',
        method: 'jwt',
        scopes: ['workflows:read', 'queue:read'],
      });
    });
  });

  describe('unauthenticated requests', () => {
    it('should reject requests with no auth headers when auth enabled', async () => {
      const middleware = createAuthMiddleware({ apiKeyStore, enabled: true });
      const request = createMockRequest({ headers: {} });
      const reply = createMockReply();

      await middleware(request, reply);

      expect(reply._statusCode).toBe(401);
      expect(reply._body).toMatchObject({
        title: 'Authentication Required',
        status: 401,
      });
    });

    it('should reject requests with empty Authorization header', async () => {
      const middleware = createAuthMiddleware({ apiKeyStore, enabled: true });
      const request = createMockRequest({
        headers: { authorization: '' },
      });
      const reply = createMockReply();

      await middleware(request, reply);

      expect(reply._statusCode).toBe(401);
      expect(reply._body).toMatchObject({
        title: 'Authentication Required',
        status: 401,
      });
    });

    it('should reject requests with non-Bearer Authorization scheme', async () => {
      const middleware = createAuthMiddleware({ apiKeyStore, enabled: true });
      const request = createMockRequest({
        headers: { authorization: 'Basic dXNlcjpwYXNz' },
      });
      const reply = createMockReply();

      await middleware(request, reply);

      // extractBearerToken returns null for non-Bearer, so falls to "No authentication provided"
      expect(reply._statusCode).toBe(401);
      expect(reply._body).toMatchObject({
        title: 'Authentication Required',
        status: 401,
      });
    });
  });

  describe('X-API-Key takes precedence over Bearer', () => {
    it('should use X-API-Key when both headers are present', async () => {
      apiKeyStore.addKey('api-key-value', {
        name: 'api-key',
        createdAt: new Date().toISOString(),
        scopes: ['admin'],
      });
      apiKeyStore.addKey('bearer-value', {
        name: 'bearer-key',
        createdAt: new Date().toISOString(),
        scopes: ['workflows:read'],
      });

      const middleware = createAuthMiddleware({ apiKeyStore, enabled: true });
      const request = createMockRequest({
        headers: {
          'x-api-key': 'api-key-value',
          authorization: 'Bearer bearer-value',
        },
      });
      const reply = createMockReply();

      await middleware(request, reply);

      // X-API-Key should take precedence
      expect(request.auth.apiKeyName).toBe('api-key');
      expect(request.auth.scopes).toEqual(['admin']);
    });
  });
});

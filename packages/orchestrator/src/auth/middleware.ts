import type { FastifyRequest, FastifyReply } from 'fastify';
import type { AuthContext, ApiScope } from '../types/index.js';
import { ErrorTypes, createProblemDetails } from '../types/index.js';
import {
  API_KEY_HEADER,
  validateApiKey,
  createAuthContextFromApiKey,
  hasAnyScope,
  type ApiKeyStore,
} from './api-key.js';
import { extractBearerToken, verifyToken, createAuthContextFromJWT } from './jwt.js';

/**
 * Augment FastifyRequest to include auth context
 */
declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext;
  }
}

/**
 * Authentication middleware options
 */
export interface AuthMiddlewareOptions {
  /** API key store for validating API keys */
  apiKeyStore: ApiKeyStore;
  /** Whether authentication is enabled */
  enabled?: boolean;
  /** Routes to skip authentication */
  skipRoutes?: string[];
}

/**
 * Create authentication middleware
 */
export function createAuthMiddleware(options: AuthMiddlewareOptions) {
  const { apiKeyStore, enabled = true, skipRoutes = [] } = options;

  return async function authMiddleware(
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> {
    // Check if auth is disabled
    if (!enabled) {
      request.auth = {
        userId: 'anonymous',
        method: 'api-key',
        scopes: ['admin'],
      };
      return;
    }

    // Check if route should skip auth
    const routePath = request.routeOptions?.url ?? request.url;
    if (skipRoutes.some((route) => routePath.startsWith(route))) {
      request.auth = {
        userId: 'anonymous',
        method: 'api-key',
        scopes: [],
      };
      return;
    }

    // Try API key authentication first
    const apiKey = request.headers[API_KEY_HEADER];
    if (typeof apiKey === 'string' && apiKey.length > 0) {
      const result = await validateApiKey(apiKey, apiKeyStore);
      if (result.valid && result.credential) {
        request.auth = createAuthContextFromApiKey(result.credential);
        return;
      }

      // Invalid API key
      return reply.status(401).send(
        createProblemDetails(ErrorTypes.UNAUTHORIZED, 'Invalid API Key', 401, {
          detail: result.error,
          traceId: request.correlationId,
        })
      );
    }

    // Try Bearer token as API key (allows same key to work via Authorization header)
    const authHeader = request.headers.authorization;
    const bearerToken = extractBearerToken(authHeader as string | undefined);
    if (bearerToken) {
      const apiKeyResult = await validateApiKey(bearerToken, apiKeyStore);
      if (apiKeyResult.valid && apiKeyResult.credential) {
        request.auth = createAuthContextFromApiKey(apiKeyResult.credential);
        return;
      }

      // Bearer token not in API key store — fall through to JWT verification
      const payload = await verifyToken(request);
      if (payload) {
        request.auth = createAuthContextFromJWT(payload);
        return;
      }

      // Neither API key nor valid JWT
      return reply.status(401).send(
        createProblemDetails(ErrorTypes.UNAUTHORIZED, 'Invalid Token', 401, {
          detail: 'The provided token is not a valid API key or JWT',
          traceId: request.correlationId,
        })
      );
    }

    // No authentication provided
    return reply.status(401).send(
      createProblemDetails(ErrorTypes.UNAUTHORIZED, 'Authentication Required', 401, {
        detail: 'Provide an API key via X-API-Key header or a JWT via Authorization header',
        traceId: request.correlationId,
      })
    );
  };
}

/**
 * Create scope-checking hook
 */
export function requireScopes(...requiredScopes: ApiScope[]) {
  return async function scopeCheck(
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> {
    if (!request.auth) {
      return reply.status(401).send(
        createProblemDetails(ErrorTypes.UNAUTHORIZED, 'Authentication Required', 401, {
          traceId: request.correlationId,
        })
      );
    }

    if (!hasAnyScope(request.auth, requiredScopes)) {
      return reply.status(403).send(
        createProblemDetails(ErrorTypes.FORBIDDEN, 'Insufficient Permissions', 403, {
          detail: `Required scopes: ${requiredScopes.join(' or ')}`,
          traceId: request.correlationId,
        })
      );
    }
  };
}

/**
 * Create admin-only scope check
 */
export function requireAdmin() {
  return requireScopes('admin');
}

/**
 * Create read scope check for a resource
 */
export function requireRead(resource: 'workflows' | 'queue' | 'agents') {
  return requireScopes(`${resource}:read` as ApiScope, 'admin');
}

/**
 * Create write scope check for a resource
 */
export function requireWrite(resource: 'workflows' | 'queue') {
  return requireScopes(`${resource}:write` as ApiScope, 'admin');
}

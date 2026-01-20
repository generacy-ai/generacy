import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { JWTPayload, AuthContext, GitHubUser, ApiScope } from '../types/index.js';

/**
 * JWT configuration
 */
export interface JWTConfig {
  secret: string;
  expiresIn: string;
}

/**
 * Create JWT payload from GitHub user
 */
export function createJWTPayloadFromGitHubUser(
  user: GitHubUser,
  scopes: ApiScope[] = ['workflows:read', 'queue:read', 'agents:read']
): Omit<JWTPayload, 'iat' | 'exp'> {
  return {
    sub: `github:${user.id}`,
    name: user.name || user.login,
    email: user.email,
    provider: 'github',
    scopes,
  };
}

/**
 * Sign a JWT token using Fastify JWT plugin
 */
export async function signToken(
  server: FastifyInstance,
  payload: Omit<JWTPayload, 'iat' | 'exp'>
): Promise<string> {
  return server.jwt.sign(payload);
}

/**
 * Verify and decode a JWT token
 */
export async function verifyToken(
  request: FastifyRequest
): Promise<JWTPayload | null> {
  try {
    await request.jwtVerify();
    return request.user as JWTPayload;
  } catch {
    return null;
  }
}

/**
 * Create auth context from JWT payload
 */
export function createAuthContextFromJWT(payload: JWTPayload): AuthContext {
  return {
    userId: payload.sub,
    method: 'jwt',
    scopes: payload.scopes,
  };
}

/**
 * Extract bearer token from authorization header
 */
export function extractBearerToken(authHeader: string | undefined): string | null {
  if (!authHeader) {
    return null;
  }

  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0]?.toLowerCase() !== 'bearer') {
    return null;
  }

  return parts[1] ?? null;
}

/**
 * Decode JWT payload without verification (for debugging)
 */
export function decodeTokenPayload(token: string): JWTPayload | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) {
      return null;
    }

    const payload = parts[1];
    if (!payload) {
      return null;
    }

    const decoded = Buffer.from(payload, 'base64url').toString('utf-8');
    return JSON.parse(decoded) as JWTPayload;
  } catch {
    return null;
  }
}

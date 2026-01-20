import { describe, it, expect } from 'vitest';
import {
  createJWTPayloadFromGitHubUser,
  createAuthContextFromJWT,
  extractBearerToken,
  decodeTokenPayload,
} from '../../../src/auth/jwt.js';
import type { GitHubUser, JWTPayload } from '../../../src/types/index.js';

describe('jwt', () => {
  describe('createJWTPayloadFromGitHubUser', () => {
    it('should create payload from GitHub user', () => {
      const user: GitHubUser = {
        id: 12345,
        login: 'testuser',
        name: 'Test User',
        email: 'test@example.com',
        avatar_url: 'https://github.com/avatar.png',
      };

      const payload = createJWTPayloadFromGitHubUser(user);

      expect(payload.sub).toBe('github:12345');
      expect(payload.name).toBe('Test User');
      expect(payload.email).toBe('test@example.com');
      expect(payload.provider).toBe('github');
      expect(payload.scopes).toEqual(['workflows:read', 'queue:read', 'agents:read']);
    });

    it('should use login as name fallback', () => {
      const user: GitHubUser = {
        id: 12345,
        login: 'testuser',
        name: '',
        email: 'test@example.com',
        avatar_url: 'https://github.com/avatar.png',
      };

      const payload = createJWTPayloadFromGitHubUser(user);

      expect(payload.name).toBe('testuser');
    });

    it('should accept custom scopes', () => {
      const user: GitHubUser = {
        id: 12345,
        login: 'testuser',
        name: 'Test User',
        email: 'test@example.com',
        avatar_url: 'https://github.com/avatar.png',
      };

      const payload = createJWTPayloadFromGitHubUser(user, ['admin']);

      expect(payload.scopes).toEqual(['admin']);
    });
  });

  describe('createAuthContextFromJWT', () => {
    it('should create auth context from JWT payload', () => {
      const payload: JWTPayload = {
        sub: 'github:12345',
        name: 'Test User',
        email: 'test@example.com',
        provider: 'github',
        scopes: ['workflows:read', 'queue:write'],
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
      };

      const context = createAuthContextFromJWT(payload);

      expect(context.userId).toBe('github:12345');
      expect(context.method).toBe('jwt');
      expect(context.scopes).toEqual(['workflows:read', 'queue:write']);
      expect(context.apiKeyName).toBeUndefined();
    });
  });

  describe('extractBearerToken', () => {
    it('should extract token from valid header', () => {
      const token = extractBearerToken('Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test');
      expect(token).toBe('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test');
    });

    it('should be case-insensitive for Bearer prefix', () => {
      const token = extractBearerToken('bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test');
      expect(token).toBe('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test');
    });

    it('should return null for missing header', () => {
      expect(extractBearerToken(undefined)).toBeNull();
    });

    it('should return null for non-Bearer auth', () => {
      expect(extractBearerToken('Basic dGVzdDp0ZXN0')).toBeNull();
    });

    it('should return null for malformed header', () => {
      expect(extractBearerToken('Bearer')).toBeNull();
      expect(extractBearerToken('Bearertoken')).toBeNull();
      expect(extractBearerToken('Bearer token extra')).toBeNull();
    });
  });

  describe('decodeTokenPayload', () => {
    it('should decode valid JWT payload', () => {
      // Create a valid JWT structure (header.payload.signature)
      const payload = {
        sub: 'github:12345',
        name: 'Test User',
        email: 'test@example.com',
        provider: 'github',
        scopes: ['workflows:read'],
        iat: 1234567890,
        exp: 1234571490,
      };
      const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
      const token = `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.${encodedPayload}.signature`;

      const decoded = decodeTokenPayload(token);

      expect(decoded).not.toBeNull();
      expect(decoded?.sub).toBe('github:12345');
      expect(decoded?.name).toBe('Test User');
    });

    it('should return null for invalid token format', () => {
      expect(decodeTokenPayload('not-a-jwt')).toBeNull();
      expect(decodeTokenPayload('only.two')).toBeNull();
      expect(decodeTokenPayload('')).toBeNull();
    });

    it('should return null for invalid base64', () => {
      const token = 'header.!!!invalid-base64!!!.signature';
      expect(decodeTokenPayload(token)).toBeNull();
    });

    it('should return null for invalid JSON', () => {
      const invalidPayload = Buffer.from('not json').toString('base64url');
      const token = `header.${invalidPayload}.signature`;
      expect(decodeTokenPayload(token)).toBeNull();
    });
  });
});
